/**
 * The infinite canvas: pan and zoom, selection, dragging, resizing, snapping,
 * guides, edges and virtualized card rendering.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { boundsOf, intersects, newId, type CanvasDoc, type CanvasEdge, type CanvasNode, type EdgeSide, type Rect } from '../shared/canvas.ts'
import { cardKind, groupDescendants } from '../shared/classify.ts'
import { routeEdge, sideCenter, snapMove, snapToGrid, type Guide } from '../shared/geometry.ts'
import { cardTypeOf, type CardShell } from './cards.tsx'
import type { TesseraStore } from './store.ts'
import { useTessera } from './store.ts'

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
const DOT_SPACING = 24

export interface ViewState { x: number; y: number; z: number }

export interface CanvasApi {
  fitAll(): void
  fitRects(rects: readonly Rect[]): void
  centerOn(rect: Rect): void
  zoomBy(factor: number): void
  screenCenter(): { x: number; y: number }
  /** Translate a client coordinate into board coordinates. */
  toWorld(clientX: number, clientY: number): { x: number; y: number }
  getView(): ViewState
  setView(view: ViewState): void
}

const COLOR_PRESETS: Record<string, string> = {
  1: 'var(--t-color-red)', 2: 'var(--t-color-orange)', 3: 'var(--t-color-yellow)',
  4: 'var(--t-color-green)', 5: 'var(--t-color-cyan)', 6: 'var(--t-color-purple)',
}
export const resolveColor = (color: string | undefined): string | undefined =>
  color === undefined ? undefined : COLOR_PRESETS[color] ?? color

const viewKey = (path: string): string => `tessera.view:${path}`

function loadView(path: string): ViewState | undefined {
  try {
    const raw = window.localStorage.getItem(viewKey(path))
    const parsed = raw === null ? undefined : JSON.parse(raw) as ViewState
    return parsed !== undefined && [parsed.x, parsed.y, parsed.z].every(Number.isFinite) ? parsed : undefined
  } catch {
    return undefined // a blocked or damaged entry just means the board opens fitted
  }
}

function saveView(path: string, view: ViewState): void {
  try {
    window.localStorage.setItem(viewKey(path), JSON.stringify(view))
  } catch { /* the remembered view is only a convenience */ }
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type Interaction =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: 'box'; startX: number; startY: number; additive: boolean; base: ReadonlySet<string> }
  | { kind: 'pending-drag'; id: string; startX: number; startY: number; world: { x: number; y: number }; alreadySelected: boolean; additive: boolean }
  | { kind: 'drag'; ids: string[]; startWorld: { x: number; y: number }; origins: Map<string, Rect>; primary: Rect; others: Rect[] }
  | { kind: 'resize'; id: string; handle: Handle; startWorld: { x: number; y: number }; origin: Rect; aspect: number | undefined; minW: number; minH: number; autoHeight: boolean }
  | { kind: 'edge'; from: string; side: EdgeSide; moved: boolean }

interface CardFrameProps {
  node: CanvasNode
  doc: CanvasDoc
  rect: Rect
  store: TesseraStore
  selected: boolean
  soloSelected: boolean
  editing: boolean
  dimmed: boolean
  dragging: boolean
  t: (key: string) => string
  shell: CardShell
}

const CardFrame = memo(function CardFrame({ node, doc, rect, store, selected, soloSelected, editing, dimmed, dragging, t, shell }: CardFrameProps) {
  const kind = cardKind(node, doc)
  const type = cardTypeOf(kind)
  const bodyRef = useRef<HTMLDivElement>(null)
  const locked = node.tessera?.locked === true
  const color = resolveColor(node.color)
  const style = node.tessera?.colorStyle ?? 'strip'
  const collapsed = kind === 'column' && node.tessera?.collapsed === true
  // Only cards Tessera wrote follow their content. A card from a plain file keeps its stored height until edited, so opening a board never rewrites it.
  const autoHeight = type.autoHeight && node.type === 'text' && node.tessera !== undefined

  useLayoutEffect(() => {
    if (!autoHeight || dragging) return
    const element = bodyRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.offsetHeight)
      const stored = store.node(node.id)?.height
      if (height > 0 && stored !== undefined && Math.abs(height - stored) > 1) store.measure(node.id, height)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [autoHeight, dragging, store, node.id])

  const View = type.view
  const classes = ['t-card', `t-kind-${kind}`]
  if (selected) classes.push('t-selected')
  if (!autoHeight) classes.push('t-fixed')
  if (editing) classes.push('t-editing')
  if (dimmed) classes.push('t-dimmed')
  if (dragging) classes.push('t-dragging')
  if (color !== undefined) classes.push(style === 'full' ? 't-color-full' : 't-color-strip')
  const tags = Array.isArray(node.tessera?.tags) ? node.tessera.tags : []
  return (
    <div
      ref={bodyRef}
      className={classes.join(' ')}
      data-card-id={node.id}
      data-kind={kind}
      role="group"
      aria-label={`${t(type.label)}${selected ? `, ${t('a11y.selected')}` : ''}`}
      tabIndex={-1}
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.width,
        ...(autoHeight ? {} : { height: collapsed ? undefined : rect.height }),
        ...(color !== undefined ? { '--t-card-color': color } : {}),
      } as React.CSSProperties}
    >
      <div className="t-card-body">
        <View node={node} doc={doc} store={store} editing={editing} selected={selected} t={t} shell={shell} />
        {tags.length > 0 ? <div className="t-tags">{tags.map(tag => <span key={tag} className="t-tag">{tag}</span>)}</div> : null}
      </div>
      {locked ? <span className="t-lock" aria-label={t('card.locked')} title={t('card.locked')}>🔒</span> : null}
      {soloSelected && !locked && !editing ? <Handles auto={autoHeight} /> : null}
      {soloSelected && !editing ? <Anchors /> : null}
    </div>
  )
})

function Handles({ auto }: { auto: boolean }): ReactNode {
  const handles: Handle[] = auto ? ['w', 'e'] : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  return <>{handles.map(handle => <div key={handle} className={`t-handle t-handle-${handle}`} data-handle={handle} />)}</>
}

function Anchors(): ReactNode {
  const sides: EdgeSide[] = ['top', 'right', 'bottom', 'left']
  return <>{sides.map(side => <div key={side} className={`t-anchor t-anchor-${side}`} data-anchor={side} title="" />)}</>
}

interface EdgeLayerProps {
  edges: readonly CanvasEdge[]
  rects: (id: string) => Rect | undefined
  selected: string | undefined
  draft: { d: string } | undefined
  onSelect: (id: string, event: React.PointerEvent) => void
  onLabel: (id: string) => void
}

const EdgeLayer = memo(function EdgeLayer({ edges, rects, selected, draft, onSelect, onLabel }: EdgeLayerProps) {
  return (
    <svg className="t-edges" aria-hidden="true">
      {edges.map((edge) => {
        const from = rects(edge.fromNode), to = rects(edge.toNode)
        if (from === undefined || to === undefined) return null
        const route = routeEdge(edge, from, to)
        const color = resolveColor(edge.color) ?? 'var(--dsw-alias-label-tertiary)'
        const toArrow = edge.toEnd !== 'none'
        const fromArrow = edge.fromEnd === 'arrow'
        const size = 9
        const arrow = (point: { x: number; y: number }, angle: number): string => {
          const a = angle + Math.PI * 0.85, b = angle - Math.PI * 0.85
          return `M${point.x} ${point.y}L${point.x + Math.cos(a) * size} ${point.y + Math.sin(a) * size}L${point.x + Math.cos(b) * size} ${point.y + Math.sin(b) * size}Z`
        }
        return (
          <g key={edge.id} className={edge.id === selected ? 't-edge t-edge-selected' : 't-edge'} data-edge-id={edge.id}>
            <path className="t-edge-hit" d={route.d} onPointerDown={(event) => { onSelect(edge.id, event) }} onDoubleClick={(event) => { event.stopPropagation(); onLabel(edge.id) }} />
            <path className="t-edge-line" d={route.d} style={{ stroke: color, strokeDasharray: edge.tessera?.dashed === true ? '6 6' : undefined }} />
            {toArrow ? <path d={arrow(route.end, route.endAngle)} style={{ fill: color }} /> : null}
            {fromArrow ? <path d={arrow(route.start, route.startAngle)} style={{ fill: color }} /> : null}
            {typeof edge.label === 'string' && edge.label !== '' ? (
              <foreignObject x={route.mid.x - 90} y={route.mid.y - 13} width={180} height={26} style={{ overflow: 'visible', pointerEvents: 'none' }}>
                <div className="t-edge-label"><span>{edge.label}</span></div>
              </foreignObject>
            ) : null}
          </g>
        )
      })}
      {draft !== undefined ? <path className="t-edge-line t-edge-draft" d={draft.d} /> : null}
    </svg>
  )
})

export interface CanvasViewProps {
  store: TesseraStore
  t: (key: string) => string
  shell: CardShell
  apiRef: React.RefObject<CanvasApi | null>
  onContextMenu: (event: { x: number; y: number; world: { x: number; y: number }; target?: string; edge?: string }) => void
  onDropCards?: (ids: string[], world: { x: number; y: number }, event: PointerEvent) => boolean
  onViewChange?: (view: ViewState, viewport: { width: number; height: number }) => void
  dimmedIds?: ReadonlySet<string> | undefined
  hiddenIds?: ReadonlySet<string> | undefined
  placeKind?: { active: boolean; place: (world: { x: number; y: number }) => void } | undefined
  /** Rewrites a live-dragged set of rects, for column reordering previews. */
  afterMove?: (ids: readonly string[]) => void
  /** Dropped OS files or dragged-in URLs. */
  onDropData?: (data: DataTransfer, world: { x: number; y: number }) => void
}

export function CanvasView({ store, t, shell, apiRef, onContextMenu, onDropCards, onViewChange, dimmedIds, hiddenIds, placeKind, afterMove, onDropData }: CanvasViewProps): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const path = useTessera(store, state => state.path)
  const selection = useTessera(store, state => state.selection)
  const selectedEdge = useTessera(store, state => state.selectedEdge)
  const editing = useTessera(store, state => state.editing)

  const rootRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const view = useRef<ViewState>({ x: 0, y: 0, z: 1 })
  const interaction = useRef<Interaction | undefined>(undefined)
  const spaceDown = useRef(false)
  const fittedFor = useRef<string | undefined>(undefined)
  const docRef = useRef(doc)
  docRef.current = doc

  const [visible, setVisible] = useState<Rect>({ x: -2000, y: -2000, width: 6000, height: 6000 })
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Rect>>(new Map())
  const [guides, setGuides] = useState<readonly Guide[]>([])
  const [box, setBox] = useState<Rect | undefined>(undefined)
  const [edgeDraft, setEdgeDraft] = useState<{ d: string } | undefined>(undefined)
  const [panning, setPanning] = useState(false)
  const [zoomPercent, setZoomPercent] = useState(100)

  const syncVisible = useCallback(() => {
    const root = rootRef.current
    if (root === null) return
    const { x, y, z } = view.current
    const width = root.clientWidth / z, height = root.clientHeight / z
    const world = { x: -x / z, y: -y / z, width, height }
    setVisible((current) => {
      const margin = Math.max(width, height) * 0.25
      const inside = world.x >= current.x + 1 && world.y >= current.y + 1
        && world.x + width <= current.x + current.width - 1 && world.y + height <= current.y + current.height - 1
      // A much smaller view means the zoom went up, so shrink the render set too.
      if (inside && current.width < width * 3) return current
      return { x: world.x - margin, y: world.y - margin, width: width + margin * 2, height: height + margin * 2 }
    })
  }, [])

  const frame = useRef<number | undefined>(undefined)
  const applyView = useCallback(() => {
    const world = worldRef.current, root = rootRef.current
    if (world === null || root === null) return
    const { x, y, z } = view.current
    world.style.transform = `translate(${x}px, ${y}px) scale(${z})`
    const spacing = DOT_SPACING * z * (z < 0.5 ? 4 : z < 1 ? 2 : 1)
    root.style.backgroundSize = `${spacing}px ${spacing}px`
    root.style.backgroundPosition = `${x}px ${y}px`
    world.style.setProperty('--t-inverse-zoom', String(1 / z))
    if (frame.current === undefined) {
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined
        syncVisible()
        setZoomPercent(Math.round(view.current.z * 100))
        onViewChange?.(view.current, { width: root.clientWidth, height: root.clientHeight })
      })
    }
  }, [syncVisible, onViewChange])

  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current) }, [])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const root = rootRef.current
    const rect = root?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const { x, y, z } = view.current
    return { x: (clientX - rect.left - x) / z, y: (clientY - rect.top - y) / z }
  }, [])

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    const px = clientX - rect.left, py = clientY - rect.top
    const { x, y, z } = view.current
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor))
    const ratio = next / z
    view.current = { x: px - (px - x) * ratio, y: py - (py - y) * ratio, z: next }
    applyView()
  }, [applyView])

  const fitRects = useCallback((rects: readonly Rect[]) => {
    const root = rootRef.current
    const box2 = boundsOf(rects)
    if (root === null || box2 === undefined) {
      view.current = { x: (root?.clientWidth ?? 0) / 2, y: (root?.clientHeight ?? 0) / 2, z: 1 }
      applyView()
      return
    }
    const pad = 64
    const z = Math.min(1, Math.max(MIN_ZOOM, Math.min((root.clientWidth - pad * 2) / Math.max(1, box2.width), (root.clientHeight - pad * 2) / Math.max(1, box2.height))))
    view.current = {
      x: (root.clientWidth - box2.width * z) / 2 - box2.x * z,
      y: (root.clientHeight - box2.height * z) / 2 - box2.y * z,
      z,
    }
    applyView()
  }, [applyView])

  useEffect(() => {
    apiRef.current = {
      fitAll: () => { fitRects(docRef.current?.nodes ?? []) },
      fitRects,
      centerOn: (rect) => {
        const root = rootRef.current
        if (root === null) return
        const z = Math.max(view.current.z, 0.6)
        view.current = { x: root.clientWidth / 2 - (rect.x + rect.width / 2) * z, y: root.clientHeight / 2 - (rect.y + rect.height / 2) * z, z }
        applyView()
      },
      zoomBy: (factor) => {
        const rect = rootRef.current?.getBoundingClientRect()
        if (rect !== undefined) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
      },
      screenCenter: () => {
        const rect = rootRef.current?.getBoundingClientRect()
        return rect === undefined ? { x: 0, y: 0 } : toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
      },
      toWorld,
      getView: () => view.current,
      setView: (next) => { view.current = next; applyView() },
    }
    return () => { apiRef.current = null }
  }, [apiRef, applyView, fitRects, toWorld, zoomAt])

  // Restore the remembered view, or fit, the first time a board's document arrives.
  useLayoutEffect(() => {
    if (doc === undefined || path === undefined || fittedFor.current === path) return
    fittedFor.current = path
    const saved = loadView(path)
    if (saved !== undefined) { view.current = saved; applyView() } else fitRects(doc.nodes)
  }, [doc, path, applyView, fitRects])

  useEffect(() => {
    if (path === undefined) return
    const timer = setInterval(() => { saveView(path, view.current) }, 2000)
    return () => {
      clearInterval(timer)
      saveView(path, view.current)
    }
  }, [path])

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const onWheel = (event: WheelEvent): void => {
      if ((event.target as HTMLElement).closest?.('[data-scrollable]') !== null && !event.ctrlKey) return
      event.preventDefault()
      // A pinch arrives as ctrl+wheel. A mouse wheel has large whole steps and no sideways motion.
      const mouseWheel = event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50
      if (event.ctrlKey || mouseWheel) {
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))
        zoomAt(event.clientX, event.clientY, factor)
        return
      }
      view.current = { ...view.current, x: view.current.x - event.deltaX, y: view.current.y - event.deltaY }
      applyView()
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    const onResize = new ResizeObserver(() => { syncVisible() })
    onResize.observe(root)
    return () => {
      root.removeEventListener('wheel', onWheel)
      onResize.disconnect()
    }
  }, [applyView, zoomAt, syncVisible])

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null
      return element?.closest?.('input, textarea, [contenteditable="true"]') != null
    }
    const down = (event: KeyboardEvent): void => {
      if (event.code === 'Space' && !isTyping(event.target)) {
        spaceDown.current = true
        setPanning(true)
        event.preventDefault()
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        spaceDown.current = false
        if (interaction.current?.kind !== 'pan') setPanning(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const rectOf = useCallback((id: string): Rect | undefined => overrides.get(id) ?? docRef.current?.nodes.find(node => node.id === id), [overrides])

  const rectIndex = useMemo(() => new Map(doc?.nodes.map(node => [node.id, node as Rect]) ?? []), [doc])
  const rectLookup = useCallback((id: string): Rect | undefined => overrides.get(id) ?? rectIndex.get(id), [overrides, rectIndex])

  const finishEdge = useCallback((target: HTMLElement | null, from: string, fromSide: EdgeSide) => {
    const cardElement = target?.closest<HTMLElement>('[data-card-id]') ?? null
    const toId = cardElement?.dataset.cardId
    if (toId === undefined || toId === from) return
    const anchor = target?.closest<HTMLElement>('[data-anchor]')?.dataset.anchor as EdgeSide | undefined
    const id = newId()
    const edge: CanvasEdge = { id, fromNode: from, fromSide, toNode: toId, toEnd: 'arrow', ...(anchor !== undefined ? { toSide: anchor } : {}) }
    store.commit({ edges: { [id]: edge } }, { label: 'Connect' })
    store.select(new Set(), id)
  }, [store])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button === 2) return
    const target = event.target as HTMLElement
    const root = rootRef.current
    if (root === null) return
    root.focus({ preventScroll: true })
    const panGesture = spaceDown.current || event.button === 1
    if (panGesture) {
      event.preventDefault()
      interaction.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, viewX: view.current.x, viewY: view.current.y }
      setPanning(true)
      root.setPointerCapture(event.pointerId)
      return
    }
    if (placeKind?.active === true) {
      placeKind.place(toWorld(event.clientX, event.clientY))
      return
    }
    const world = toWorld(event.clientX, event.clientY)
    const anchorElement = target.closest<HTMLElement>('[data-anchor]')
    const handleElement = target.closest<HTMLElement>('[data-handle]')
    const cardElement = target.closest<HTMLElement>('[data-card-id]')
    const id = cardElement?.dataset.cardId
    if (anchorElement !== null && id !== undefined) {
      event.stopPropagation()
      interaction.current = { kind: 'edge', from: id, side: anchorElement.dataset.anchor as EdgeSide, moved: false }
      root.setPointerCapture(event.pointerId)
      return
    }
    if (handleElement !== null && id !== undefined) {
      const node = store.node(id)
      if (node === undefined) return
      const type = cardTypeOf(cardKind(node, docRef.current))
      event.stopPropagation()
      interaction.current = {
        kind: 'resize', id, handle: handleElement.dataset.handle as Handle, startWorld: world, origin: node,
        aspect: type.aspectLock === true ? node.width / Math.max(1, node.height) : undefined,
        minW: type.minWidth, minH: type.minHeight, autoHeight: type.autoHeight && node.type === 'text' && node.tessera !== undefined,
      }
      root.setPointerCapture(event.pointerId)
      return
    }
    if (id !== undefined && id !== editing) {
      if (target.closest('[data-interactive]') !== null) return
      interaction.current = {
        kind: 'pending-drag', id, startX: event.clientX, startY: event.clientY, world,
        alreadySelected: selection.has(id), additive: event.shiftKey,
      }
      if (!selection.has(id) && !event.shiftKey) store.select(new Set([id]))
      if (editing !== undefined) store.setEditing(undefined)
      return
    }
    if (id === undefined) {
      if (editing !== undefined) store.setEditing(undefined)
      interaction.current = { kind: 'box', startX: event.clientX, startY: event.clientY, additive: event.shiftKey, base: event.shiftKey ? selection : new Set() }
      if (!event.shiftKey) store.select(new Set())
      root.setPointerCapture(event.pointerId)
    }
  }

  const beginDrag = (pending: Extract<Interaction, { kind: 'pending-drag' }>): void => {
    const current = docRef.current
    if (current === undefined) return
    const base = store.state.selection.has(pending.id) ? store.state.selection : new Set([pending.id])
    const ids = new Set<string>()
    for (const id of base) {
      const node = current.nodes.find(item => item.id === id)
      if (node === undefined || node.tessera?.locked === true) continue
      ids.add(id)
      if (node.type === 'group') for (const child of groupDescendants(current, node)) if (child.tessera?.locked !== true) ids.add(child.id)
    }
    if (ids.size === 0) { interaction.current = undefined; return }
    const origins = new Map<string, Rect>()
    for (const id of ids) {
      const node = current.nodes.find(item => item.id === id) as CanvasNode
      origins.set(id, { x: node.x, y: node.y, width: node.width, height: node.height })
    }
    const primary = boundsOf([...origins.values()]) as Rect
    const others = current.nodes
      .filter(node => !ids.has(node.id) && intersects(node, visible))
      .slice(0, 400)
      .map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height }))
    interaction.current = { kind: 'drag', ids: [...ids], startWorld: pending.world, origins, primary, others }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = interaction.current
    if (state === undefined) return
    switch (state.kind) {
      case 'pan':
        view.current = { ...view.current, x: state.viewX + event.clientX - state.startX, y: state.viewY + event.clientY - state.startY }
        applyView()
        return
      case 'pending-drag':
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 3) {
          // Capturing here, not on pointerdown: capture retargets click and dblclick away from the card.
          rootRef.current?.setPointerCapture(event.pointerId)
          beginDrag(state)
        }
        return
      case 'drag': {
        const world = toWorld(event.clientX, event.clientY)
        const dx = world.x - state.startWorld.x, dy = world.y - state.startWorld.y
        const moved = { ...state.primary, x: state.primary.x + dx, y: state.primary.y + dy }
        const threshold = 6 / view.current.z
        const snapped = snapMove(moved, state.others, threshold, !event.altKey)
        const sx = snapped.x - state.primary.x, sy = snapped.y - state.primary.y
        const next = new Map<string, Rect>()
        for (const [id, rect] of state.origins) next.set(id, { ...rect, x: rect.x + sx, y: rect.y + sy })
        setOverrides(next)
        setGuides(snapped.guides)
        return
      }
      case 'resize': {
        const world = toWorld(event.clientX, event.clientY)
        const dx = world.x - state.startWorld.x, dy = world.y - state.startWorld.y
        const { origin, handle } = state
        let { x, y, width, height } = origin
        if (handle.includes('e')) width = origin.width + dx
        if (handle.includes('w')) { width = origin.width - dx; x = origin.x + dx }
        if (!state.autoHeight) {
          if (handle.includes('s')) height = origin.height + dy
          if (handle.includes('n')) { height = origin.height - dy; y = origin.y + dy }
        }
        if (!event.altKey) {
          if (handle.includes('e')) width = snapToGrid(x + width) - x
          if (handle.includes('w')) { const edge = snapToGrid(x); width += x - edge; x = edge }
          if (!state.autoHeight && handle.includes('s')) height = snapToGrid(y + height) - y
          if (!state.autoHeight && handle.includes('n')) { const edge = snapToGrid(y); height += y - edge; y = edge }
        }
        if (width < state.minW) { if (handle.includes('w')) x -= state.minW - width; width = state.minW }
        if (height < state.minH && !state.autoHeight) { if (handle.includes('n')) y -= state.minH - height; height = state.minH }
        if (state.aspect !== undefined) {
          if (handle === 'n' || handle === 's') width = height * state.aspect
          else height = width / state.aspect
          if (handle.includes('n')) y = origin.y + origin.height - height
          if (handle.includes('w')) x = origin.x + origin.width - width
        }
        setOverrides(new Map([[state.id, { x, y, width, height }]]))
        return
      }
      case 'box': {
        const a = toWorld(state.startX, state.startY), b = toWorld(event.clientX, event.clientY)
        const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
        setBox(rect)
        const hit = new Set(state.base)
        for (const node of docRef.current?.nodes ?? []) {
          if (hiddenIds?.has(node.id) === true) continue
          // A frame sits behind its cards, so it joins only when fully enclosed.
          const enclosed = node.x >= rect.x && node.y >= rect.y && node.x + node.width <= rect.x + rect.width && node.y + node.height <= rect.y + rect.height
          if (node.type === 'group' ? enclosed : intersects(node, rect)) hit.add(node.id)
        }
        store.select(hit)
        return
      }
      case 'edge': {
        state.moved = true
        const from = rectOf(state.from)
        if (from === undefined) return
        const a = sideCenter(from, state.side)
        const b = toWorld(event.clientX, event.clientY)
        setEdgeDraft({ d: `M${a.x} ${a.y}L${b.x} ${b.y}` })
        return
      }
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = interaction.current
    interaction.current = undefined
    const root = rootRef.current
    if (root?.hasPointerCapture(event.pointerId) === true) root.releasePointerCapture(event.pointerId)
    if (state === undefined) return
    switch (state.kind) {
      case 'pan':
        if (!spaceDown.current) setPanning(false)
        return
      case 'pending-drag':
        if (state.additive) {
          const next = new Set(store.state.selection)
          if (next.has(state.id)) next.delete(state.id); else next.add(state.id)
          store.select(next)
        } else store.select(new Set([state.id]))
        return
      case 'drag': {
        const current = docRef.current
        setGuides([])
        if (current === undefined) { setOverrides(new Map()); return }
        const world = toWorld(event.clientX, event.clientY)
        if (onDropCards?.(state.ids, world, event.nativeEvent) === true) { setOverrides(new Map()); return }
        const nodes: Record<string, CanvasNode> = {}
        for (const id of state.ids) {
          const rect = overrides.get(id)
          const node = current.nodes.find(item => item.id === id)
          if (rect !== undefined && node !== undefined && (rect.x !== node.x || rect.y !== node.y)) nodes[id] = { ...node, x: rect.x, y: rect.y }
        }
        if (Object.keys(nodes).length > 0) store.commit({ nodes }, { label: 'Move' })
        setOverrides(new Map())
        afterMove?.(state.ids)
        return
      }
      case 'resize': {
        const rect = overrides.get(state.id)
        const node = store.node(state.id)
        if (rect !== undefined && node !== undefined) store.commit({ nodes: { [state.id]: { ...node, ...rect } } }, { label: 'Resize' })
        setOverrides(new Map())
        return
      }
      case 'box':
        setBox(undefined)
        return
      case 'edge': {
        setEdgeDraft(undefined)
        if (state.moved) finishEdge(document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null, state.from, state.side)
      }
    }
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-interactive]') !== null) return
    const id = target.closest<HTMLElement>('[data-card-id]')?.dataset.cardId
    if (id !== undefined) {
      const node = store.node(id)
      if (node === undefined || node.tessera?.locked === true) return
      const kind = cardKind(node, docRef.current)
      if (kind === 'document') { shell.openDocument(id); return }
      if (kind === 'board' && typeof node.file === 'string') { shell.enterBoard(node.file); return }
      if (kind === 'image') { shell.openLightbox(id); return }
      if (cardTypeOf(kind).editable === true) store.setEditing(id)
      return
    }
    const world = toWorld(event.clientX, event.clientY)
    const nodeId = newId()
    const useGrid = !event.altKey
    const note: CanvasNode = {
      id: nodeId, type: 'text', text: '',
      x: useGrid ? snapToGrid(world.x - 125) : Math.round(world.x - 125),
      y: useGrid ? snapToGrid(world.y - 30) : Math.round(world.y - 30),
      width: 248, height: 64,
      tessera: { kind: 'note' },
    }
    store.commit({ nodes: { [nodeId]: note } }, { label: 'New note', coalesce: `new:${nodeId}` })
    store.select(new Set([nodeId]))
    store.setEditing(nodeId)
  }

  const onContext = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const target = event.target as HTMLElement
    const id = target.closest<HTMLElement>('[data-card-id]')?.dataset.cardId
    const edge = target.closest<SVGGElement>('[data-edge-id]')?.dataset.edgeId
    if (id !== undefined && !store.state.selection.has(id)) store.select(new Set([id]))
    onContextMenu({
      x: event.clientX, y: event.clientY, world: toWorld(event.clientX, event.clientY),
      ...(id !== undefined ? { target: id } : {}),
      ...(edge !== undefined ? { edge } : {}),
    })
  }

  const visibleNodes = useMemo(() => {
    if (doc === undefined) return []
    return doc.nodes.filter((node) => {
      if (hiddenIds?.has(node.id) === true) return false
      const rect = overrides.get(node.id) ?? node
      return intersects(rect, visible) || selection.has(node.id) || overrides.has(node.id)
    })
  }, [doc, visible, overrides, selection, hiddenIds])

  const visibleEdges = useMemo(() => {
    if (doc === undefined) return []
    return doc.edges.filter((edge) => {
      if (hiddenIds?.has(edge.fromNode) === true || hiddenIds?.has(edge.toNode) === true) return false
      const from = rectLookup(edge.fromNode), to = rectLookup(edge.toNode)
      if (from === undefined || to === undefined) return false
      const span = boundsOf([from, to]) as Rect
      return intersects({ x: span.x - 300, y: span.y - 300, width: span.width + 600, height: span.height + 600 }, visible)
    })
  }, [doc, visible, rectLookup, hiddenIds])

  const onSelectEdge = useCallback((id: string, event: React.PointerEvent) => {
    if (event.button !== 0 || spaceDown.current) return
    event.stopPropagation()
    store.select(new Set(), id)
  }, [store])

  const onEdgeLabel = useCallback((id: string) => {
    const edge = store.state.doc?.edges.find(item => item.id === id)
    if (edge === undefined) return
    void store.ask({ title: t('edge.label'), value: edge.label ?? '' }).then((label) => {
      if (label !== null) store.patchEdge(id, { label }, { label: 'Edge label' })
    })
  }, [store, t])

  return (
    <div
      ref={rootRef}
      className={`t-canvas${panning ? ' t-panning' : ''}${placeKind?.active === true ? ' t-placing' : ''}`}
      data-testid="tessera-canvas"
      tabIndex={0}
      role="application"
      aria-label={t('canvas.label')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
      onDragOver={(event) => {
        // A checklist row reorder is a drag too; only outside content is a drop on the canvas.
        if (onDropData !== undefined && (event.target as HTMLElement).closest('.t-todo') === null) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        if (onDropData === undefined || (event.target as HTMLElement).closest('.t-todo') !== null) return
        event.preventDefault()
        onDropData(event.dataTransfer, toWorld(event.clientX, event.clientY))
      }}
    >
      <div ref={worldRef} className="t-world">
        <EdgeLayer edges={visibleEdges} rects={rectLookup} selected={selectedEdge} draft={edgeDraft} onSelect={onSelectEdge} onLabel={onEdgeLabel} />
        {doc !== undefined ? visibleNodes.map((node) => {
          const live = overrides.get(node.id)
          return (
            <CardFrame
              key={node.id}
              node={node}
              doc={doc}
              rect={live ?? node}
              store={store}
              selected={selection.has(node.id)}
              soloSelected={selection.size === 1 && selection.has(node.id)}
              editing={editing === node.id}
              dimmed={dimmedIds?.has(node.id) === true}
              dragging={live !== undefined}
              t={t}
              shell={shell}
            />
          )
        }) : null}
        {guides.map(guide => (
          <div
            key={`${guide.axis}${guide.at}`}
            className="t-guide"
            style={guide.axis === 'x'
              ? { left: guide.at, top: guide.from, width: 1 / view.current.z, height: guide.to - guide.from }
              : { left: guide.from, top: guide.at, height: 1 / view.current.z, width: guide.to - guide.from }}
          />
        ))}
        {box !== undefined ? <div className="t-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderWidth: 1 / view.current.z }} /> : null}
      </div>
      <output className="t-zoom-readout" aria-live="polite">{zoomPercent}%</output>
    </div>
  )
}

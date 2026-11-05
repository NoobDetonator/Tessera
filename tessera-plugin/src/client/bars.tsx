/** Floating controls for the current selection, the selected connection, and the minimap. */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { boundsOf, type CanvasEdge, type CanvasNode, type Rect } from '../shared/canvas.ts'
import { columnMembers } from '../shared/classify.ts'
import { normalizeHex, paletteToCss, paletteToJson } from '../shared/cardtext.ts'
import { alignRects, distributeRects, type AlignMode } from '../shared/geometry.ts'
import { groupAsColumn, groupAsFrame, visualRect } from '../shared/structure.ts'
import type { CanvasApi, ViewState } from './CanvasView.tsx'
import { useTessera, type TesseraStore } from './store.ts'

type T = (key: string) => string

const PRESETS = ['1', '2', '3', '4', '5', '6'] as const

function Swatches({ current, onPick, t }: { current: string | undefined; onPick: (color: string | undefined) => void; t: T }): ReactNode {
  return (
    <>
      <button type="button" className="t-dot t-dot-none" aria-label={t('bar.noColor')} title={t('bar.noColor')} aria-pressed={current === undefined} onClick={() => { onPick(undefined) }} />
      {PRESETS.map(color => (
        <button
          key={color}
          type="button"
          className="t-dot"
          style={{ background: `var(--t-preset-${color})` }}
          aria-label={`${t('bar.color')} ${color}`}
          title={`${t('bar.color')} ${color}`}
          aria-pressed={current === color}
          onClick={() => { onPick(color) }}
        />
      ))}
      <label className="t-dot t-dot-custom" title={t('bar.customColor')}>
        <input
          type="color"
          aria-label={t('bar.customColor')}
          value={current !== undefined && current.startsWith('#') ? normalizeHex(current) ?? '#000000' : '#7c5cff'}
          onChange={(event) => { onPick(event.target.value) }}
        />
      </label>
    </>
  )
}

const without = <T extends object>(value: T, key: string): T => {
  const copy = { ...value } as Record<string, unknown>
  delete copy[key]
  return copy as T
}

const ALIGN: ReadonlyArray<{ mode: AlignMode; glyph: string; key: string }> = [
  { mode: 'left', glyph: '⇤', key: 'bar.alignLeft' },
  { mode: 'hcenter', glyph: '↔', key: 'bar.alignCenter' },
  { mode: 'right', glyph: '⇥', key: 'bar.alignRight' },
  { mode: 'top', glyph: '⤒', key: 'bar.alignTop' },
  { mode: 'vcenter', glyph: '↕', key: 'bar.alignMiddle' },
  { mode: 'bottom', glyph: '⤓', key: 'bar.alignBottom' },
]

/** Controls for the selected cards: color, tags, lock, align, distribute and grouping. */
export function SelectionBar({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const selection = useTessera(store, state => state.selection)
  const doc = useTessera(store, state => state.doc)
  const editing = useTessera(store, state => state.editing)
  const cards = useMemo(() => doc?.nodes.filter(node => selection.has(node.id)) ?? [], [doc, selection])
  if (cards.length === 0 || editing !== undefined) return null
  const editable = cards.filter(card => card.tessera?.locked !== true)
  const first = cards[0] as CanvasNode
  const allLocked = editable.length === 0

  const patchAll = (patch: (card: CanvasNode) => CanvasNode, label: string): void => {
    store.commit({ nodes: Object.fromEntries(editable.map(card => [card.id, patch(card)])) }, { label })
  }
  const place = (positions: Map<CanvasNode, { x: number; y: number }>, label: string): void => {
    store.commit({ nodes: Object.fromEntries([...positions].map(([card, spot]) => [card.id, { ...card, ...spot }])) }, { label })
  }
  const group = (as: 'column' | 'frame'): void => {
    if (doc === undefined) return
    const make = as === 'column' ? groupAsColumn : groupAsFrame
    const result = make(doc, editable.map(card => card.id), '')
    if (result === undefined) return
    store.commit(result.change, { label: t(`card.${as}`) })
    store.select(new Set([result.id]))
  }
  const tags = Array.isArray(first.tessera?.tags) ? first.tessera.tags : []

  return (
    <div className="t-bar" role="toolbar" aria-label={t('bar.selection')} data-testid="selection-bar">
      <Swatches
        current={first.color}
        t={t}
        onPick={(color) => { patchAll(card => color === undefined ? without(card, 'color') : { ...card, color }, t('bar.color')) }}
      />
      <button
        type="button"
        className="t-btn"
        aria-pressed={first.tessera?.colorStyle === 'full'}
        title={t('bar.colorFull')}
        disabled={allLocked}
        onClick={() => {
          const next = first.tessera?.colorStyle === 'full' ? 'strip' : 'full'
          patchAll(card => ({ ...card, tessera: { ...card.tessera, colorStyle: next } }), t('bar.colorFull'))
        }}
      >{t('bar.colorFull')}</button>
      <span className="t-sep" />
      <button
        type="button"
        className="t-btn"
        disabled={allLocked}
        title={t('bar.tags')}
        onClick={() => {
          void store.ask({ title: t('bar.tags'), message: t('bar.tagsHelp'), value: tags.join(', ') }).then((answer) => {
            if (answer === null) return
            const next = [...new Set(answer.split(',').map(tag => tag.trim()).filter(tag => tag !== ''))]
            patchAll(card => ({ ...card, tessera: { ...card.tessera, tags: next } }), t('bar.tags'))
          })
        }}
      >{t('bar.tags')}{tags.length > 0 ? ` (${tags.length})` : ''}</button>
      <button
        type="button"
        className="t-btn"
        aria-pressed={allLocked}
        title={`${t(allLocked ? 'menu.unlock' : 'menu.lock')} (Ctrl+L)`}
        onClick={() => {
          const lock = !allLocked
          store.commit({ nodes: Object.fromEntries(cards.map(card => [card.id, { ...card, tessera: { ...card.tessera, locked: lock } }])) }, { label: t(lock ? 'menu.lock' : 'menu.unlock') })
        }}
      >{t(allLocked ? 'menu.unlock' : 'menu.lock')}</button>
      {editable.length >= 2 ? (
        <>
          <span className="t-sep" />
          {ALIGN.map(({ mode, glyph, key }) => (
            <button key={mode} type="button" className="t-btn t-btn-icon" aria-label={t(key)} title={t(key)} onClick={() => { place(alignRects(editable, mode), t(key)) }}>{glyph}</button>
          ))}
          {editable.length >= 3 ? (
            <>
              <button type="button" className="t-btn t-btn-icon" aria-label={t('bar.distributeH')} title={t('bar.distributeH')} onClick={() => { place(distributeRects(editable, 'x'), t('bar.distributeH')) }}>⋯</button>
              <button type="button" className="t-btn t-btn-icon" aria-label={t('bar.distributeV')} title={t('bar.distributeV')} onClick={() => { place(distributeRects(editable, 'y'), t('bar.distributeV')) }}>⋮</button>
            </>
          ) : null}
        </>
      ) : null}
      {editable.length >= 1 && editable.every(card => card.type !== 'group') ? (
        <>
          <span className="t-sep" />
          <button type="button" className="t-btn" onClick={() => { group('column') }}>{t('bar.asColumn')}</button>
          <button type="button" className="t-btn" onClick={() => { group('frame') }}>{t('bar.asFrame')}</button>
        </>
      ) : null}
    </div>
  )
}

/** Style controls for the selected connection. */
export function EdgeBar({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const selectedEdge = useTessera(store, state => state.selectedEdge)
  const doc = useTessera(store, state => state.doc)
  const edge = doc?.edges.find(item => item.id === selectedEdge)
  if (edge === undefined) return null
  const patch = (next: Partial<CanvasEdge>, label: string): void => { store.patchEdge(edge.id, next, { label }) }
  const routing = edge.tessera?.routing ?? 'curved'
  return (
    <div className="t-bar" role="toolbar" aria-label={t('bar.edge')} data-testid="edge-bar">
      {(['straight', 'curved', 'orthogonal'] as const).map(mode => (
        <button key={mode} type="button" className="t-btn" aria-pressed={routing === mode} onClick={() => { patch({ tessera: { ...edge.tessera, routing: mode } }, t(`edge.${mode}`)) }}>{t(`edge.${mode}`)}</button>
      ))}
      <span className="t-sep" />
      <button type="button" className="t-btn" aria-pressed={edge.tessera?.dashed === true} onClick={() => { patch({ tessera: { ...edge.tessera, dashed: edge.tessera?.dashed !== true } }, t('edge.dashed')) }}>{t('edge.dashed')}</button>
      <button type="button" className="t-btn" aria-pressed={edge.fromEnd === 'arrow'} aria-label={t('edge.arrowStart')} title={t('edge.arrowStart')} onClick={() => { patch({ fromEnd: edge.fromEnd === 'arrow' ? 'none' : 'arrow' }, t('edge.arrowStart')) }}>←</button>
      <button type="button" className="t-btn" aria-pressed={edge.toEnd !== 'none'} aria-label={t('edge.arrowEnd')} title={t('edge.arrowEnd')} onClick={() => { patch({ toEnd: edge.toEnd === 'none' ? 'arrow' : 'none' }, t('edge.arrowEnd')) }}>→</button>
      <button
        type="button"
        className="t-btn"
        onClick={() => {
          void store.ask({ title: t('edge.label'), value: edge.label ?? '' }).then((label) => {
            if (label !== null) patch({ label }, t('edge.label'))
          })
        }}
      >{t('edge.label')}</button>
      <span className="t-sep" />
      <Swatches current={edge.color} t={t} onPick={(color) => { store.commit({ edges: { [edge.id]: color === undefined ? without(edge, 'color') : { ...edge, color } } }, { label: t('bar.color') }) }} />
      <span className="t-sep" />
      <button type="button" className="t-btn t-btn-danger" onClick={() => { store.commit({ edges: { [edge.id]: null } }, { label: t('menu.delete') }); store.select(new Set()) }}>{t('menu.delete')}</button>
    </div>
  )
}

/** Copy a column's Color cards as a palette. */
export function copyPalette(store: TesseraStore, columnId: string, format: 'css' | 'json', t: T): void {
  const { doc } = store.state
  const column = doc?.nodes.find(node => node.id === columnId)
  if (doc === undefined || column === undefined) return
  const entries = columnMembers(doc, column).flatMap((node) => {
    const hex = normalizeHex(node.text ?? '')
    return hex === undefined ? [] : [{ name: node.tessera?.title ?? hex, hex }]
  })
  if (entries.length === 0) { store.notify(t('palette.empty')); return }
  void navigator.clipboard.writeText(format === 'css' ? paletteToCss(entries) : paletteToJson(entries)).then(() => { store.notify(t('palette.copied')) })
}

const MAP_WIDTH = 188
const MAP_HEIGHT = 124

/** Overview of the whole board. Click or drag to move the view. */
export function Minimap({ store, canvas, view, t }: { store: TesseraStore; canvas: React.RefObject<CanvasApi | null>; view: { state: ViewState; width: number; height: number } | undefined; t: T }): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const element = useRef<HTMLCanvasElement>(null)
  const scale = useRef<{ s: number; ox: number; oy: number } | undefined>(undefined)

  useEffect(() => {
    const target = element.current
    const context = target?.getContext('2d')
    if (target === null || target === undefined || context === null || context === undefined || doc === undefined) return
    const ratio = window.devicePixelRatio || 1
    target.width = MAP_WIDTH * ratio
    target.height = MAP_HEIGHT * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT)
    const seen: Rect | undefined = view === undefined ? undefined
      : { x: -view.state.x / view.state.z, y: -view.state.y / view.state.z, width: view.width / view.state.z, height: view.height / view.state.z }
    const all = boundsOf([...doc.nodes.map(visualRect), ...(seen !== undefined ? [seen] : [])])
    if (all === undefined) return
    const pad = 6
    const s = Math.min((MAP_WIDTH - pad * 2) / Math.max(1, all.width), (MAP_HEIGHT - pad * 2) / Math.max(1, all.height))
    const ox = pad - all.x * s + (MAP_WIDTH - pad * 2 - all.width * s) / 2
    const oy = pad - all.y * s + (MAP_HEIGHT - pad * 2 - all.height * s) / 2
    scale.current = { s, ox, oy }
    const styles = getComputedStyle(target)
    context.fillStyle = styles.getPropertyValue('--t-map-card') || '#999'
    context.strokeStyle = styles.getPropertyValue('--t-map-card') || '#999'
    for (const node of doc.nodes) {
      const rect = visualRect(node)
      const x = rect.x * s + ox, y = rect.y * s + oy, w = Math.max(1, rect.width * s), h = Math.max(1, rect.height * s)
      if (node.type === 'group') context.strokeRect(x, y, w, h)
      else context.fillRect(x, y, w, h)
    }
    if (seen !== undefined) {
      context.strokeStyle = styles.getPropertyValue('--t-accent') || '#36f'
      context.lineWidth = 1.5
      context.strokeRect(seen.x * s + ox, seen.y * s + oy, seen.width * s, seen.height * s)
    }
  }, [doc, view])

  const moveTo = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const map = scale.current, api = canvas.current
    if (map === undefined || api === null || view === undefined) return
    const box = event.currentTarget.getBoundingClientRect()
    const worldX = (event.clientX - box.left - map.ox) / map.s
    const worldY = (event.clientY - box.top - map.oy) / map.s
    const { z } = api.getView()
    api.setView({ x: view.width / 2 - worldX * z, y: view.height / 2 - worldY * z, z })
  }

  return (
    <canvas
      ref={element}
      className="t-minimap"
      style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
      role="img"
      aria-label={t('minimap.label')}
      data-testid="minimap"
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveTo(event) }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event) }}
    />
  )
}

/** Sketch editor and presentation mode. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { newId, type CanvasNode } from '../shared/canvas.ts'
import { presentationOrder } from '../shared/export.ts'
import { snapToGrid } from '../shared/geometry.ts'
import { BRUSHES, eraseAt, parseSketch, sketchToSvg, strokeOutline, type Brush, type Stroke } from '../shared/sketch.ts'
import { api, fileUrl } from './bridge.ts'
import type { CanvasApi } from './CanvasView.tsx'
import type { Point } from './create.ts'
import { useTessera, type TesseraStore } from './store.ts'

type T = (key: string) => string

const NEW_WIDTH = 1000
const NEW_HEIGHT = 700
const OPACITY: Record<Brush, number> = { pen: 1, marker: 1, highlighter: 0.35 }

type Tool = Brush | 'eraser'

/** Draw freehand. Saving writes a new SVG asset and points the card at it, so board undo restores the old drawing. */
export function SketchEditor({ store, nodeId, at, t, onClose }: { store: TesseraStore; nodeId: string | undefined; at: Point | undefined; t: T; onClose: () => void }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: NEW_WIDTH, height: NEW_HEIGHT })
  const [strokes, setStrokes] = useState<readonly Stroke[]>([])
  const [undone, setUndone] = useState<ReadonlyArray<readonly Stroke[]>>([])
  const [past, setPast] = useState<ReadonlyArray<readonly Stroke[]>>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#1c1c1e')
  const [brushSize, setBrushSize] = useState(6)
  const [saving, setSaving] = useState(false)
  const live = useRef<Stroke | undefined>(undefined)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const original = nodeId === undefined ? undefined : store.node(nodeId)

  useEffect(() => {
    if (typeof original?.file !== 'string') return undefined
    let alive = true
    fetch(fileUrl(original.file)).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const sketch = parseSketch(await response.text(), { width: NEW_WIDTH, height: NEW_HEIGHT })
      if (alive) {
        setSize({ width: sketch.width, height: sketch.height })
        setStrokes(sketch.strokes)
      }
    }).catch((error: Error) => { store.notify(error.message) })
    return () => { alive = false }
    // Loaded once on open: reloading on later card edits would discard strokes being drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draw = useCallback(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (element === null || element === undefined || context === null || context === undefined) return
    context.clearRect(0, 0, element.width, element.height)
    for (const stroke of live.current === undefined ? strokesRef.current : [...strokesRef.current, live.current]) {
      context.globalAlpha = OPACITY[stroke.brush]
      context.fillStyle = stroke.color
      context.fill(new Path2D(strokeOutline(stroke)))
    }
    context.globalAlpha = 1
  }, [])
  useEffect(draw, [draw, strokes, size])

  const toSketch = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / box.width) * size.width, y: ((event.clientY - box.top) / box.height) * size.height }
  }

  const change = (next: readonly Stroke[]): void => {
    setPast([...past, strokes])
    setUndone([])
    setStrokes(next)
  }

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = toSketch(event)
    if (tool === 'eraser') {
      setPast([...past, strokes])
      setUndone([])
      setStrokes(eraseAt(strokes, x, y, brushSize))
      return
    }
    // A mouse reports a fixed pressure, so it draws at the midpoint.
    const pressure = event.pointerType === 'pen' ? event.pressure : 0.5
    live.current = { brush: tool, color, size: brushSize, points: [x, y, pressure] }
    draw()
  }

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    if (tool === 'eraser') {
      const { x, y } = toSketch(event)
      const next = eraseAt(strokesRef.current, x, y, brushSize)
      if (next.length !== strokesRef.current.length) setStrokes(next)
      return
    }
    const stroke = live.current
    if (stroke === undefined) return
    const native = event.nativeEvent
    // Coalesced events give the full path of a fast stroke, not just one point per frame.
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    const box = event.currentTarget.getBoundingClientRect()
    for (const sample of samples.length > 0 ? samples : [native]) {
      stroke.points.push(
        ((sample.clientX - box.left) / box.width) * size.width,
        ((sample.clientY - box.top) / box.height) * size.height,
        sample.pointerType === 'pen' ? sample.pressure : 0.5,
      )
    }
    draw()
  }

  const onUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const stroke = live.current
    live.current = undefined
    if (stroke !== undefined) change([...strokes, stroke])
  }

  const undo = (): void => {
    const previous = past.at(-1)
    if (previous === undefined) return
    setUndone([...undone, strokes])
    setPast(past.slice(0, -1))
    setStrokes(previous)
  }
  const redo = (): void => {
    const next = undone.at(-1)
    if (next === undefined) return
    setPast([...past, strokes])
    setUndone(undone.slice(0, -1))
    setStrokes(next)
  }

  const finish = async (): Promise<void> => {
    if (saving) return
    if (nodeId === undefined && strokes.length === 0) { onClose(); return }
    setSaving(true)
    try {
      const svg = sketchToSvg({ width: size.width, height: size.height, strokes: [...strokes] })
      const asset = await api.upload(new Blob([svg], { type: 'image/svg+xml' }), 'sketch.svg')
      if (nodeId !== undefined) store.patchNode(nodeId, { file: asset.path }, { label: t('card.sketch') })
      else {
        const point = at ?? { x: 0, y: 0 }
        const node: CanvasNode = { id: newId(), type: 'file', file: asset.path, x: snapToGrid(point.x), y: snapToGrid(point.y), width: 400, height: Math.round(400 * (size.height / size.width)), tessera: { kind: 'sketch' } }
        store.commit({ nodes: { [node.id]: node } }, { label: t('card.sketch') })
        store.select(new Set([node.id]))
      }
      onClose()
    } catch (error) {
      // Nothing is lost: the drawing stays on screen so the user can try again.
      setSaving(false)
      store.notify((error as Error).message)
    }
  }

  return (
    <div
      className="t-sketch-editor"
      role="dialog"
      aria-modal="true"
      aria-label={t('sketch.title')}
      data-testid="sketch-editor"
      onKeyDown={(event) => {
        event.stopPropagation()
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
        if (event.key === 'Escape') { event.preventDefault(); void finish() }
      }}
    >
      <div className="t-sketch-tools" role="toolbar" aria-label={t('sketch.title')}>
        {([...BRUSHES, 'eraser'] as const).map(item => (
          <button key={item} type="button" className="t-btn" aria-pressed={tool === item} data-sketch-tool={item} onClick={() => { setTool(item) }}>{t(`sketch.${item}`)}</button>
        ))}
        <span className="t-sep" />
        <input type="color" value={color} aria-label={t('sketch.color')} onChange={(event) => { setColor(event.target.value) }} />
        <input type="range" min="1" max="48" value={brushSize} aria-label={t('sketch.size')} onChange={(event) => { setBrushSize(Number(event.target.value)) }} />
        <span className="t-sep" />
        <button type="button" className="t-btn" disabled={past.length === 0} onClick={undo}>{t('sketch.undo')}</button>
        <button type="button" className="t-btn" disabled={undone.length === 0} onClick={redo}>{t('sketch.redo')}</button>
        <button type="button" className="t-btn" disabled={strokes.length === 0} onClick={() => { change([]) }}>{t('sketch.clear')}</button>
        <span className="t-spacer" />
        <button type="button" className="t-btn t-btn-primary" disabled={saving} onClick={() => { void finish() }}>{t('sketch.save')}</button>
      </div>
      <div className="t-sketch-area">
        <canvas
          ref={canvas}
          width={size.width}
          height={size.height}
          role="img"
          aria-label={t('sketch.canvas')}
          tabIndex={0}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
    </div>
  )
}

/** Full-screen slides, one frame at a time, on the live canvas. */
export function Presentation({ store, canvas, t, onClose, onSlide }: { store: TesseraStore; canvas: React.RefObject<CanvasApi | null>; t: T; onClose: () => void; onSlide: (frameId: string | undefined) => void }): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const frames = useMemo(() => (doc === undefined ? [] : presentationOrder(doc)), [doc])
  const [index, setIndex] = useState(0)
  const saved = useRef(canvas.current?.getView())
  const current = frames[Math.min(index, frames.length - 1)]
  const exit = useRef(onClose)
  exit.current = onClose

  useEffect(() => {
    store.select(new Set())
    store.setEditing(undefined)
    document.documentElement.requestFullscreen?.().catch(() => { /* fullscreen is optional; the slide still covers the window */ })
    const view = saved.current
    return () => {
      if (document.fullscreenElement !== null) void document.exitFullscreen?.().catch(() => { /* already gone */ })
      if (view !== undefined) canvas.current?.setView(view)
    }
  }, [canvas, store])

  useEffect(() => {
    onSlide(current?.id)
    return () => { onSlide(undefined) }
  }, [current?.id, onSlide])

  // The stage changes size as the chrome hides, so fit once it has settled.
  useEffect(() => {
    if (current === undefined) return undefined
    // A slide should fill the screen, so small frames enlarge.
    const fit = (): void => { canvas.current?.fitRects([current], 4) }
    fit()
    const frame = requestAnimationFrame(fit)
    const timer = setTimeout(fit, 150)
    window.addEventListener('resize', fit)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      window.removeEventListener('resize', fit)
    }
  }, [current, canvas])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setIndex(value => Math.min(frames.length - 1, value + 1)) }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setIndex(value => Math.max(0, value - 1)) }
      if (event.key === 'Home') { event.preventDefault(); setIndex(0) }
      if (event.key === 'End') { event.preventDefault(); setIndex(frames.length - 1) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exit.current() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [frames.length])

  return (
    <div className="t-presenter-bar" role="toolbar" aria-label={t('present.label')} data-testid="presenter-bar">
      <button type="button" className="t-btn" disabled={index === 0} onClick={() => { setIndex(index - 1) }}>{t('present.previous')}</button>
      <span className="t-presenter-count" aria-live="polite">{Math.min(index, frames.length - 1) + 1} / {frames.length}</span>
      <button type="button" className="t-btn" disabled={index >= frames.length - 1} onClick={() => { setIndex(index + 1) }}>{t('present.next')}</button>
      <button type="button" className="t-btn" onClick={onClose}>{t('present.exit')}</button>
    </div>
  )
}

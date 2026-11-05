/** Pure layout math: snapping, alignment guides, align and distribute, auto placement, edge routing. */
import { boundsOf, intersects, type CanvasEdge, type EdgeSide, type Rect } from './canvas.ts'

export const GRID = 8
export const snapToGrid = (value: number, grid = GRID): number => Math.round(value / grid) * grid

export interface Guide {
  axis: 'x' | 'y'
  /** Position of the guide line on its axis. */
  at: number
  from: number
  to: number
}

export interface SnapResult {
  x: number
  y: number
  guides: Guide[]
}

const anchorsX = (r: Rect): number[] => [r.x, r.x + r.width / 2, r.x + r.width]
const anchorsY = (r: Rect): number[] => [r.y, r.y + r.height / 2, r.y + r.height]

/**
 * Snap a moving rect to nearby alignment lines of other rects, falling back
 * to the grid per axis.
 * @param threshold - world-space distance within which an alignment line captures the rect.
 * @param useGrid - false when the user holds Alt.
 */
export function snapMove(moving: Rect, others: readonly Rect[], threshold: number, useGrid = true): SnapResult {
  if (!useGrid) return { x: moving.x, y: moving.y, guides: [] }
  let bestX: { delta: number; at: number } | undefined
  let bestY: { delta: number; at: number } | undefined
  const movingX = anchorsX(moving), movingY = anchorsY(moving)
  for (const other of others) {
    for (const target of anchorsX(other)) {
      for (const source of movingX) {
        const delta = target - source
        if (Math.abs(delta) <= threshold && (bestX === undefined || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: target }
      }
    }
    for (const target of anchorsY(other)) {
      for (const source of movingY) {
        const delta = target - source
        if (Math.abs(delta) <= threshold && (bestY === undefined || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: target }
      }
    }
  }
  const x = bestX !== undefined ? moving.x + bestX.delta : snapToGrid(moving.x)
  const y = bestY !== undefined ? moving.y + bestY.delta : snapToGrid(moving.y)
  const placed = { ...moving, x, y }
  const guides: Guide[] = []
  if (bestX !== undefined) guides.push(guideFor('x', bestX.at, placed, others))
  if (bestY !== undefined) guides.push(guideFor('y', bestY.at, placed, others))
  return { x, y, guides }
}

function guideFor(axis: 'x' | 'y', at: number, placed: Rect, others: readonly Rect[]): Guide {
  const span = (r: Rect): [number, number] => axis === 'x' ? [r.y, r.y + r.height] : [r.x, r.x + r.width]
  const anchors = axis === 'x' ? anchorsX : anchorsY
  let [from, to] = span(placed)
  for (const other of others) {
    if (!anchors(other).some(value => Math.abs(value - at) < 0.5)) continue
    const [a, b] = span(other)
    if (a < from) from = a
    if (b > to) to = b
  }
  return { axis, at, from, to }
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** New positions aligning rects to the edge or center of their shared bounds. */
export function alignRects<T extends Rect>(rects: readonly T[], mode: AlignMode): Map<T, { x: number; y: number }> {
  const out = new Map<T, { x: number; y: number }>()
  const box = boundsOf(rects)
  if (box === undefined) return out
  for (const r of rects) {
    let { x, y } = r
    if (mode === 'left') x = box.x
    if (mode === 'hcenter') x = box.x + (box.width - r.width) / 2
    if (mode === 'right') x = box.x + box.width - r.width
    if (mode === 'top') y = box.y
    if (mode === 'vcenter') y = box.y + (box.height - r.height) / 2
    if (mode === 'bottom') y = box.y + box.height - r.height
    out.set(r, { x: Math.round(x), y: Math.round(y) })
  }
  return out
}

/** New positions giving rects equal gaps along an axis. The two outer rects stay put. */
export function distributeRects<T extends Rect>(rects: readonly T[], axis: 'x' | 'y'): Map<T, { x: number; y: number }> {
  const out = new Map<T, { x: number; y: number }>()
  if (rects.length < 3) return out
  const size = (r: Rect): number => axis === 'x' ? r.width : r.height
  const pos = (r: Rect): number => axis === 'x' ? r.x : r.y
  const sorted = [...rects].sort((a, b) => pos(a) - pos(b))
  const first = sorted[0] as T, last = sorted.at(-1) as T
  const total = pos(last) + size(last) - pos(first)
  const gap = (total - sorted.reduce((sum, r) => sum + size(r), 0)) / (sorted.length - 1)
  let cursor = pos(first)
  for (const r of sorted) {
    out.set(r, axis === 'x' ? { x: Math.round(cursor), y: r.y } : { x: r.x, y: Math.round(cursor) })
    cursor += size(r) + gap
  }
  return out
}

/**
 * Find positions for new cards that overlap nothing. Fills rows below the
 * existing content, so results never move or cover what is already there.
 */
export function autoPlace(existing: readonly Rect[], sizes: ReadonlyArray<{ width: number; height: number }>, gap = 48, near?: { x: number; y: number }): Array<{ x: number; y: number }> {
  const box = boundsOf(existing)
  const left = near?.x ?? box?.x ?? 0
  const rowWidth = Math.max(box?.width ?? 0, 1200)
  let x = left
  let y = near?.y ?? (box === undefined ? 0 : box.y + box.height + gap)
  let rowHeight = 0
  const placed: Rect[] = [...existing]
  return sizes.map((size) => {
    if (x !== left && x + size.width > left + rowWidth) {
      x = left
      y += rowHeight + gap
      rowHeight = 0
    }
    let spot: Rect = { x: snapToGrid(x), y: snapToGrid(y), width: size.width, height: size.height }
    // `near` can land on existing content, so step down until the spot is free.
    while (placed.some(other => intersects(spot, other))) spot = { ...spot, y: spot.y + GRID * 4 }
    placed.push(spot)
    x = spot.x + size.width + gap
    rowHeight = Math.max(rowHeight, spot.y - y + size.height)
    return { x: spot.x, y: spot.y }
  })
}

export const sideCenter = (r: Rect, side: EdgeSide): { x: number; y: number } => {
  switch (side) {
    case 'top': return { x: r.x + r.width / 2, y: r.y }
    case 'bottom': return { x: r.x + r.width / 2, y: r.y + r.height }
    case 'left': return { x: r.x, y: r.y + r.height / 2 }
    case 'right': return { x: r.x + r.width, y: r.y + r.height / 2 }
  }
}

/** The sides that face each other, for edges that do not name one. */
export function facingSides(from: Rect, to: Rect): { fromSide: EdgeSide; toSide: EdgeSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}

const OUTWARD: Record<EdgeSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
}

export interface EdgeRoute {
  /** SVG path data. */
  d: string
  /** Middle of the route, for the label. */
  mid: { x: number; y: number }
  /** Final approach direction, for the arrowhead. */
  endAngle: number
  startAngle: number
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/** Route one edge between two rects in its style. */
export function routeEdge(edge: Pick<CanvasEdge, 'fromSide' | 'toSide' | 'tessera'>, from: Rect, to: Rect): EdgeRoute {
  const facing = facingSides(from, to)
  const fromSide = edge.fromSide ?? facing.fromSide
  const toSide = edge.toSide ?? facing.toSide
  const a = sideCenter(from, fromSide), b = sideCenter(to, toSide)
  const routing = edge.tessera?.routing ?? 'curved'
  const outA = OUTWARD[fromSide], outB = OUTWARD[toSide]
  if (routing === 'straight') {
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    return { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, endAngle: angle, startAngle: angle + Math.PI, start: a, end: b }
  }
  if (routing === 'orthogonal') {
    const stub = 24
    const p1 = { x: a.x + outA.x * stub, y: a.y + outA.y * stub }
    const p2 = { x: b.x + outB.x * stub, y: b.y + outB.y * stub }
    const horizontalFirst = outA.x !== 0
    const corner = horizontalFirst ? { x: (p1.x + p2.x) / 2, y: p1.y } : { x: p1.x, y: (p1.y + p2.y) / 2 }
    const corner2 = horizontalFirst ? { x: (p1.x + p2.x) / 2, y: p2.y } : { x: p2.x, y: (p1.y + p2.y) / 2 }
    const points = [a, p1, corner, corner2, p2, b]
    return {
      d: `M${points.map(p => `${p.x} ${p.y}`).join('L')}`,
      mid: { x: (corner.x + corner2.x) / 2, y: (corner.y + corner2.y) / 2 },
      endAngle: Math.atan2(-outB.y, -outB.x),
      startAngle: Math.atan2(-outA.y, -outA.x),
      start: a, end: b,
    }
  }
  const reach = Math.max(40, Math.min(240, Math.hypot(b.x - a.x, b.y - a.y) / 2))
  const c1 = { x: a.x + outA.x * reach, y: a.y + outA.y * reach }
  const c2 = { x: b.x + outB.x * reach, y: b.y + outB.y * reach }
  return {
    d: `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`,
    mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 },
    endAngle: Math.atan2(-outB.y, -outB.x),
    startAngle: Math.atan2(-outA.y, -outA.x),
    start: a, end: b,
  }
}

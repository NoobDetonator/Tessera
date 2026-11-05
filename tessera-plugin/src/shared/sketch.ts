/** Freehand strokes stored as plain SVG. Each path also carries its raw stroke, so a sketch stays editable. */

export const BRUSHES = ['pen', 'marker', 'highlighter'] as const
export type Brush = (typeof BRUSHES)[number]

export interface Stroke {
  brush: Brush
  color: string
  size: number
  /** Flat list of x, y, pressure triples, rounded to keep files small. */
  points: number[]
}

export interface Sketch {
  width: number
  height: number
  strokes: Stroke[]
}

const opacityOf = (brush: Brush): number => (brush === 'highlighter' ? 0.35 : 1)

/** Half-width at a point. The pen follows pressure; the marker and highlighter keep an even width. */
function halfWidth(brush: Brush, size: number, pressure: number): number {
  if (brush === 'pen') return Math.max(0.3, (size / 2) * (0.25 + pressure * 1.1))
  return size / 2
}

const round = (value: number): number => Math.round(value * 100) / 100

/**
 * The filled outline of a stroke, so width can vary along it.
 * @returns SVG path data, or an empty string for a stroke with no points.
 */
export function strokeOutline(stroke: Stroke): string {
  const { points, brush, size } = stroke
  const count = Math.floor(points.length / 3)
  if (count === 0) return ''
  const at = (i: number): [number, number, number] => [points[i * 3] as number, points[i * 3 + 1] as number, points[i * 3 + 2] as number]
  if (count === 1) {
    const [x, y, p] = at(0)
    const r = round(halfWidth(brush, size, p))
    return `M${round(x - r)} ${round(y)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`
  }
  const left: string[] = [], right: string[] = []
  for (let i = 0; i < count; i++) {
    const [x, y, p] = at(i)
    const [px, py] = at(Math.max(0, i - 1))
    const [nx, ny] = at(Math.min(count - 1, i + 1))
    const dx = nx - px, dy = ny - py
    const length = Math.hypot(dx, dy) || 1
    const w = halfWidth(brush, size, p)
    const ox = (-dy / length) * w, oy = (dx / length) * w
    left.push(`${round(x + ox)} ${round(y + oy)}`)
    right.push(`${round(x - ox)} ${round(y - oy)}`)
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`
}

const escapeAttribute = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const unescapeAttribute = (value: string): string => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

const HEX = /^#[0-9a-fA-F]{3,8}$/

/** Serialize a sketch. Colors are validated, so a stored stroke can never smuggle markup into the file. */
export function sketchToSvg(sketch: Sketch): string {
  const paths = sketch.strokes.map((stroke) => {
    const color = HEX.test(stroke.color) ? stroke.color : '#000000'
    const raw = escapeAttribute(JSON.stringify({ ...stroke, color, points: stroke.points.map(round) }))
    const opacity = opacityOf(stroke.brush)
    return `<path d="${strokeOutline(stroke)}" fill="${color}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''} data-stroke="${raw}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sketch.width} ${sketch.height}" width="${sketch.width}" height="${sketch.height}">${paths.join('')}</svg>\n`
}

function validStroke(value: unknown): Stroke | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const stroke = value as Partial<Stroke>
  if (!BRUSHES.includes(stroke.brush as Brush)) return undefined
  if (typeof stroke.color !== 'string' || !HEX.test(stroke.color)) return undefined
  if (typeof stroke.size !== 'number' || !Number.isFinite(stroke.size) || stroke.size <= 0) return undefined
  if (!Array.isArray(stroke.points) || !stroke.points.every(n => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { brush: stroke.brush as Brush, color: stroke.color, size: stroke.size, points: stroke.points }
}

/** Read a sketch back. Anything that is not a well-formed Tessera stroke is ignored, so any SVG opens safely. */
export function parseSketch(svg: string, fallback: { width: number; height: number } = { width: 800, height: 600 }): Sketch {
  const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
  const strokes: Stroke[] = []
  for (const match of svg.matchAll(/data-stroke="([^"]*)"/g)) {
    try {
      const stroke = validStroke(JSON.parse(unescapeAttribute(match[1] as string)))
      if (stroke !== undefined) strokes.push(stroke)
    } catch { /* a damaged stroke is skipped; the rest of the sketch still opens */ }
  }
  return { width: box === null ? fallback.width : Number(box[1]), height: box === null ? fallback.height : Number(box[2]), strokes }
}

/** The strokes left after erasing around a point. Whole strokes go, which keeps undo and files simple. */
export function eraseAt(strokes: readonly Stroke[], x: number, y: number, radius: number): Stroke[] {
  return strokes.filter((stroke) => {
    for (let i = 0; i + 2 < stroke.points.length; i += 3) {
      const dx = (stroke.points[i] as number) - x, dy = (stroke.points[i + 1] as number) - y
      const reach = radius + stroke.size / 2
      if (dx * dx + dy * dy <= reach * reach) return false
    }
    return true
  })
}

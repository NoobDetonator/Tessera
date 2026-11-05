/**
 * JSON Canvas 1.0 model shared by Host and Client. Objects stay plain JSON so
 * unknown fields survive every read, patch and write untouched.
 */

/** The Tessera card kinds a node can present as. */
export const CARD_KINDS = ['note', 'document', 'image', 'link', 'file', 'todo', 'color', 'sketch', 'board', 'column', 'frame'] as const
export type CardKind = (typeof CARD_KINDS)[number]

/** Namespaced Tessera metadata. Obsidian may strip it; nothing depends on it being there. */
export interface TesseraMeta {
  kind?: CardKind
  tags?: string[]
  locked?: boolean
  colorStyle?: 'full' | 'strip'
  /** Document title or image caption. */
  title?: string
  caption?: string
  /** Column: ordered member ids. Authoritative over geometry while present. */
  items?: string[]
  collapsed?: boolean
  /** Frame: presentation order, lower first. */
  slide?: number
  preview?: LinkPreview
  [key: string]: unknown
}

export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  siteName?: string
  fetchedAt?: string
}

/** One canvas node. `type` stays a string: an unknown type must round-trip. */
export interface CanvasNode {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  file?: string
  subpath?: string
  url?: string
  label?: string
  background?: string
  backgroundStyle?: string
  tessera?: TesseraMeta
  [key: string]: unknown
}

export type EdgeSide = 'top' | 'right' | 'bottom' | 'left'
export type EdgeEnd = 'none' | 'arrow'

export interface EdgeMeta {
  routing?: 'straight' | 'curved' | 'orthogonal'
  dashed?: boolean
  [key: string]: unknown
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: EdgeSide
  toSide?: EdgeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: string
  label?: string
  tessera?: EdgeMeta
  [key: string]: unknown
}

export interface CanvasDoc {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  [key: string]: unknown
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Raised when a file is not JSON at all. Missing or odd fields never raise. */
export class CanvasParseError extends Error {
  override readonly name = 'CanvasParseError'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** A short collision-resistant id in the 16-hex format Obsidian writes. */
export function newId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse canvas text leniently. Keeps every unknown field, fills missing
 * geometry and ids so a damaged file still opens, and drops nothing except
 * entries that are not objects and edges that have no endpoints at all.
 * @throws CanvasParseError when the text is not a JSON object.
 */
export function parseCanvas(text: string): CanvasDoc {
  if (text.trim() === '') return { nodes: [], edges: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new CanvasParseError(`Not valid JSON: ${(error as Error).message}`)
  }
  if (!isRecord(raw)) throw new CanvasParseError('A canvas file must contain a JSON object.')
  const seen = new Set<string>()
  const uniqueId = (value: unknown): string => {
    let id = typeof value === 'string' && value !== '' ? value : newId()
    while (seen.has(id)) id = newId()
    seen.add(id)
    return id
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter(isRecord).map((node): CanvasNode => ({
    ...node,
    id: uniqueId(node.id),
    type: typeof node.type === 'string' ? node.type : 'text',
    x: finite(node.x, 0),
    y: finite(node.y, 0),
    width: finite(node.width, 250),
    height: finite(node.height, 60),
  }))
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(isRecord)
    .filter(edge => typeof edge.fromNode === 'string' && typeof edge.toNode === 'string')
    .map(edge => ({ ...edge, id: uniqueId(edge.id) }) as CanvasEdge)
  return { ...raw, nodes, edges }
}

/** Serialize with tabs like Obsidian, coercing geometry to the integers the format requires. */
export function serializeCanvas(doc: CanvasDoc): string {
  const nodes = doc.nodes.map(node => ({
    ...node,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
  }))
  return `${JSON.stringify({ ...doc, nodes }, null, '\t')}\n`
}

const NODE_TYPES = new Set(['text', 'file', 'link', 'group'])
const SIDES = new Set(['top', 'right', 'bottom', 'left'])
const ENDS = new Set(['none', 'arrow'])
const COLOR = /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[1-6])$/

/**
 * Strict JSON Canvas 1.0 validator.
 * @returns every violation found; empty means the document is valid.
 */
export function validateCanvas(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['root: must be an object']
  if (!Array.isArray(value.nodes)) errors.push('nodes: must be an array')
  if (value.edges !== undefined && !Array.isArray(value.edges)) errors.push('edges: must be an array')
  const ids = new Set<string>()
  const checkColor = (where: string, color: unknown): void => {
    if (color !== undefined && (typeof color !== 'string' || !COLOR.test(color))) errors.push(`${where}.color: not a preset or hex color`)
  }
  const checkString = (where: string, field: string, item: Record<string, unknown>, required: boolean): void => {
    const present = item[field]
    if (present === undefined) {
      if (required) errors.push(`${where}.${field}: required`)
    } else if (typeof present !== 'string') errors.push(`${where}.${field}: must be a string`)
  }
  for (const [index, node] of (Array.isArray(value.nodes) ? value.nodes : []).entries()) {
    const where = `nodes[${index}]`
    if (!isRecord(node)) { errors.push(`${where}: must be an object`); continue }
    if (typeof node.id !== 'string' || node.id === '') errors.push(`${where}.id: required string`)
    else if (ids.has(node.id)) errors.push(`${where}.id: duplicate ${node.id}`)
    else ids.add(node.id)
    if (typeof node.type !== 'string' || !NODE_TYPES.has(node.type)) errors.push(`${where}.type: must be text, file, link or group`)
    for (const axis of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(node[axis])) errors.push(`${where}.${axis}: must be an integer`)
    }
    checkColor(where, node.color)
    if (node.type === 'text') checkString(where, 'text', node, true)
    if (node.type === 'file') { checkString(where, 'file', node, true); checkString(where, 'subpath', node, false) }
    if (node.type === 'link') checkString(where, 'url', node, true)
    if (node.type === 'group') {
      checkString(where, 'label', node, false)
      checkString(where, 'background', node, false)
      if (node.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(node.backgroundStyle as string)) {
        errors.push(`${where}.backgroundStyle: must be cover, ratio or repeat`)
      }
    }
  }
  const edgeIds = new Set<string>()
  for (const [index, edge] of (Array.isArray(value.edges) ? value.edges : []).entries()) {
    const where = `edges[${index}]`
    if (!isRecord(edge)) { errors.push(`${where}: must be an object`); continue }
    if (typeof edge.id !== 'string' || edge.id === '') errors.push(`${where}.id: required string`)
    else if (edgeIds.has(edge.id)) errors.push(`${where}.id: duplicate ${edge.id}`)
    else edgeIds.add(edge.id)
    for (const end of ['fromNode', 'toNode']) {
      if (typeof edge[end] !== 'string') errors.push(`${where}.${end}: required string`)
      else if (!ids.has(edge[end])) errors.push(`${where}.${end}: unknown node ${edge[end]}`)
    }
    for (const side of ['fromSide', 'toSide']) {
      if (edge[side] !== undefined && !SIDES.has(edge[side] as string)) errors.push(`${where}.${side}: invalid side`)
    }
    for (const end of ['fromEnd', 'toEnd']) {
      if (edge[end] !== undefined && !ENDS.has(edge[end] as string)) errors.push(`${where}.${end}: invalid end`)
    }
    checkColor(where, edge.color)
    checkString(where, 'label', edge, false)
  }
  return errors
}

/** Bounding box of a set of rects, or undefined when empty. */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.width > maxX) maxX = r.x + r.width
    if (r.y + r.height > maxY) maxY = r.y + r.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** True when the center of `inner` lies inside `outer`. Matches how a card "belongs" to a frame. */
export function centerInside(inner: Rect, outer: Rect): boolean {
  const cx = inner.x + inner.width / 2, cy = inner.y + inner.height / 2
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height
}

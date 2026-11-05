/**
 * Decides how a node presents as a card. Tessera metadata wins when it agrees
 * with the node's JSON Canvas type; otherwise the plain-file degradation rules
 * apply, so a board Obsidian saved without our metadata still opens correctly.
 */
import { CARD_KINDS, centerInside, type CanvasDoc, type CanvasNode, type CardKind } from './canvas.ts'

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
const SVG = /\.svg$/i
const CANVAS = /\.canvas$/i
const HEX_ONLY = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const CHECKBOX = /^\s*[-*+] \[[ xX]\](?:\s.*)?$/

const COMPATIBLE: Record<CardKind, readonly string[]> = {
  note: ['text'], document: ['text'], todo: ['text'], color: ['text'],
  image: ['file'], file: ['file'], sketch: ['file'], board: ['file'],
  link: ['link'], column: ['group'], frame: ['group'],
}

/** A text node holding only markdown checkboxes. */
export function isChecklistText(text: string): boolean {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.length > 0 && lines.every(line => CHECKBOX.test(line))
}

/** A text node holding only one hex color. */
export const isColorText = (text: string): boolean => HEX_ONLY.test(text.trim())

/** Direct children of a group by geometry: the smallest containing group owns a node. */
export function geometricChildren(doc: CanvasDoc, group: CanvasNode): CanvasNode[] {
  const groups = doc.nodes.filter(node => node.type === 'group')
  return doc.nodes.filter((node) => {
    if (node.id === group.id || !centerInside(node, group)) return false
    if (node.type === 'group' && node.width * node.height >= group.width * group.height) return false
    const area = group.width * group.height
    return !groups.some(other => other.id !== group.id && other.id !== node.id
      && other.width * other.height < area
      && (node.type !== 'group' || other.width * other.height > node.width * node.height)
      && centerInside(node, other))
  })
}

/** True when the nodes read as one vertical stack: no vertical overlap and a shared horizontal span. */
export function isVerticalStack(nodes: readonly CanvasNode[]): boolean {
  if (nodes.length < 2) return false
  const sorted = [...nodes].sort((a, b) => a.y - b.y)
  for (let i = 1; i < sorted.length; i++) {
    const above = sorted[i - 1] as CanvasNode, below = sorted[i] as CanvasNode
    if (below.y < above.y + above.height - 1) return false
    const overlap = Math.min(above.x + above.width, below.x + below.width) - Math.max(above.x, below.x)
    if (overlap < Math.min(above.width, below.width) * 0.5) return false
  }
  return true
}

/**
 * Resolve the card kind for one node.
 * @param doc - the board; only needed to apply the group rule, omit to treat groups as frames.
 */
export function cardKind(node: CanvasNode, doc?: CanvasDoc): CardKind {
  const declared = node.tessera?.kind
  if (typeof declared === 'string' && (CARD_KINDS as readonly string[]).includes(declared)
    && COMPATIBLE[declared]?.includes(node.type)) return declared
  switch (node.type) {
    case 'text': {
      const text = typeof node.text === 'string' ? node.text : ''
      if (isColorText(text)) return 'color'
      if (isChecklistText(text)) return 'todo'
      return 'note'
    }
    case 'file': {
      const file = typeof node.file === 'string' ? node.file : ''
      if (CANVAS.test(file)) return 'board'
      if (IMAGE.test(file) || SVG.test(file)) return 'image'
      return 'file'
    }
    case 'link':
      return 'link'
    case 'group':
      return doc !== undefined && isVerticalStack(geometricChildren(doc, node)) ? 'column' : 'frame'
    default:
      return 'note'
  }
}

/** Members of a column in display order. Declared items win; geometry fills in the rest. */
export function columnMembers(doc: CanvasDoc, column: CanvasNode): CanvasNode[] {
  const byId = new Map(doc.nodes.map(node => [node.id, node]))
  const declared = Array.isArray(column.tessera?.items) ? column.tessera.items : undefined
  if (declared !== undefined) {
    return declared.flatMap((id) => {
      const node = byId.get(id)
      return node === undefined ? [] : [node]
    })
  }
  return geometricChildren(doc, column).sort((a, b) => a.y - b.y)
}

/** Direct children of any group: column members or geometric children of a frame. */
export function groupChildren(doc: CanvasDoc, group: CanvasNode): CanvasNode[] {
  return cardKind(group, doc) === 'column' ? columnMembers(doc, group) : geometricChildren(doc, group)
}

/** All descendants of a group, breadth first. */
export function groupDescendants(doc: CanvasDoc, group: CanvasNode): CanvasNode[] {
  const out: CanvasNode[] = []
  const seen = new Set([group.id])
  const queue = [group]
  while (queue.length > 0) {
    const current = queue.shift() as CanvasNode
    for (const child of groupChildren(doc, current)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      if (child.type === 'group') queue.push(child)
    }
  }
  return out
}

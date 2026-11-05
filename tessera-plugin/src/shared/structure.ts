/** Pure operations on Columns and Frames, shared by the UI and the agent tools. */
import { boundsOf, newId, type CanvasDoc, type CanvasNode, type CardKind, type Rect } from './canvas.ts'
import { applyChange, composeChanges, type Change } from './change.ts'
import { cardKind, columnMembers } from './classify.ts'
import { snapToGrid } from './geometry.ts'

export const COLUMN_HEAD = 44
export const COLUMN_PAD = 12
export const COLUMN_GAP = 8
export const COLUMN_COLLAPSED_HEIGHT = 44
export const FRAME_PAD = 48
export const FRAME_HEAD = 32

/** A rough rendered height, used until a browser measures the real one. */
export function estimateTextHeight(text: string, width: number): number {
  const perLine = Math.max(8, Math.floor((width - 24) / 7.5))
  let lines = 0
  for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / perLine))
  return Math.min(1200, Math.max(44, lines * 22 + 22))
}

/** The rectangle a node occupies on screen: a collapsed column is only its header. */
export function visualRect(node: CanvasNode): Rect {
  return node.tessera?.collapsed === true && node.type === 'group'
    ? { x: node.x, y: node.y, width: node.width, height: COLUMN_COLLAPSED_HEIGHT }
    : node
}

/**
 * Stack a column's members and size the column to fit. Only columns Tessera
 * owns (declared `items`) are laid out, so opening a plain group never moves anything.
 * @returns the change, or undefined when everything is already in place.
 */
export function columnLayoutChange(doc: CanvasDoc, column: CanvasNode): Change | undefined {
  const declared = column.tessera?.items
  if (!Array.isArray(declared)) return undefined
  const members = columnMembers(doc, column)
  const nodes: Record<string, CanvasNode> = {}
  const innerWidth = column.width - COLUMN_PAD * 2
  let y = column.y + COLUMN_HEAD
  for (const member of members) {
    const x = column.x + COLUMN_PAD
    if (member.x !== x || member.y !== y || member.width !== innerWidth) nodes[member.id] = { ...member, x, y, width: innerWidth }
    y += member.height + COLUMN_GAP
  }
  const height = Math.max(COLUMN_HEAD + COLUMN_PAD, y - column.y + COLUMN_PAD - (members.length > 0 ? COLUMN_GAP : 0))
  const ids = members.map(member => member.id)
  if (height !== column.height || ids.length !== declared.length) {
    nodes[column.id] = { ...column, height, tessera: { ...column.tessera, items: ids } }
  }
  return Object.keys(nodes).length === 0 ? undefined : { nodes }
}

/** Order that puts a new group beneath the cards it holds, so it never covers them. */
function orderBelow(doc: CanvasDoc, groupId: string, ids: ReadonlySet<string>): string[] {
  const order = doc.nodes.map(node => node.id).filter(id => id !== groupId)
  const first = order.findIndex(id => ids.has(id))
  order.splice(first === -1 ? 0 : first, 0, groupId)
  return order
}

/**
 * Turn cards into a new Column, keeping their top-to-bottom order.
 * @returns the change and the new column's id; undefined when no card matches.
 */
export function groupAsColumn(doc: CanvasDoc, ids: readonly string[], title: string): { change: Change; id: string } | undefined {
  const wanted = new Set(ids)
  const members = doc.nodes.filter(node => wanted.has(node.id)).sort((a, b) => a.y - b.y || a.x - b.x)
  const box = boundsOf(members)
  if (box === undefined) return undefined
  const id = newId()
  const width = Math.max(...members.map(member => member.width)) + COLUMN_PAD * 2
  const column: CanvasNode = {
    id, type: 'group', x: snapToGrid(box.x), y: snapToGrid(box.y), width, height: COLUMN_HEAD,
    ...(title !== '' ? { label: title } : {}),
    tessera: { kind: 'column', items: members.map(member => member.id) },
  }
  const withColumn = applyChange(doc, { nodes: { [id]: column } })
  const placed = columnLayoutChange(withColumn, column)
  const order = orderBelow(withColumn, id, wanted)
  return { id, change: composeChanges(composeChanges({ nodes: { [id]: column } }, placed ?? {}), { order }) }
}

/**
 * Surround cards with a new Frame.
 * @returns the change and the new frame's id; undefined when no card matches.
 */
export function groupAsFrame(doc: CanvasDoc, ids: readonly string[], title: string): { change: Change; id: string } | undefined {
  const wanted = new Set(ids)
  const box = boundsOf(doc.nodes.filter(node => wanted.has(node.id)))
  if (box === undefined) return undefined
  const id = newId()
  const frame: CanvasNode = {
    id, type: 'group',
    x: snapToGrid(box.x - FRAME_PAD), y: snapToGrid(box.y - FRAME_PAD - FRAME_HEAD),
    width: snapToGrid(box.width + FRAME_PAD * 2), height: snapToGrid(box.height + FRAME_PAD * 2 + FRAME_HEAD),
    ...(title !== '' ? { label: title } : {}),
    tessera: { kind: 'frame' },
  }
  const withFrame = applyChange(doc, { nodes: { [id]: frame } })
  return { id, change: composeChanges({ nodes: { [id]: frame } }, { order: orderBelow(withFrame, id, wanted) }) }
}

/** The owning column of a card, if it is a declared member of one. */
export function owningColumn(doc: CanvasDoc, id: string): CanvasNode | undefined {
  return doc.nodes.find(node => node.type === 'group' && Array.isArray(node.tessera?.items) && node.tessera.items.includes(id))
}

/** Take cards out of whatever columns hold them and close the gaps. */
export function removeFromColumns(doc: CanvasDoc, ids: readonly string[]): Change {
  const gone = new Set(ids)
  let current = doc
  let change: Change = {}
  for (const column of doc.nodes) {
    const items = column.tessera?.items
    if (column.type !== 'group' || !Array.isArray(items) || !items.some(id => gone.has(id))) continue
    const next: CanvasNode = { ...column, tessera: { ...column.tessera, items: items.filter(id => !gone.has(id)) } }
    const step: Change = { nodes: { [column.id]: next } }
    current = applyChange(current, step)
    change = composeChanges(change, step)
    const layout = columnLayoutChange(current, next)
    if (layout !== undefined) {
      current = applyChange(current, layout)
      change = composeChanges(change, layout)
    }
  }
  return change
}

/** Insert cards into a column at an index, leaving any column they were in before. */
export function insertIntoColumn(doc: CanvasDoc, columnId: string, ids: readonly string[], index: number): Change {
  let change = removeFromColumns(doc, ids)
  const current = applyChange(doc, change)
  const column = current.nodes.find(node => node.id === columnId)
  if (column === undefined) return change
  const items = Array.isArray(column.tessera?.items) ? column.tessera.items : columnMembers(current, column).map(node => node.id)
  const without = items.filter(id => !ids.includes(id))
  const at = Math.max(0, Math.min(index, without.length))
  const next: CanvasNode = {
    ...column,
    tessera: { ...column.tessera, kind: 'column', items: [...without.slice(0, at), ...ids, ...without.slice(at)] },
  }
  const step: Change = { nodes: { [columnId]: next } }
  change = composeChanges(change, step)
  const withItems = applyChange(current, step)
  const layout = columnLayoutChange(withItems, next)
  if (layout !== undefined) change = composeChanges(change, layout)
  // Members must draw above the column.
  const order = withItems.nodes.map(node => node.id).filter(id => !ids.includes(id))
  return composeChanges(change, { order: [...order, ...ids] })
}

/** Where in a column a card dropped at height `y` belongs. */
export function columnInsertIndex(doc: CanvasDoc, column: CanvasNode, y: number, excluding: readonly string[]): number {
  const members = columnMembers(doc, column).filter(node => !excluding.includes(node.id))
  const index = members.findIndex(node => y < node.y + node.height / 2)
  return index === -1 ? members.length : index
}

/** The top-most card under a point, ignoring the given ids and anything hidden. */
export function topNodeAt(doc: CanvasDoc, point: { x: number; y: number }, exclude: ReadonlySet<string>, hidden?: ReadonlySet<string>): CanvasNode | undefined {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const node = doc.nodes[i] as CanvasNode
    if (exclude.has(node.id) || hidden?.has(node.id) === true) continue
    const rect = visualRect(node)
    if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) return node
  }
  return undefined
}

/** Ids hidden because their column is collapsed. */
export function collapsedMembers(doc: CanvasDoc): Set<string> {
  const out = new Set<string>()
  for (const node of doc.nodes) {
    if (node.type === 'group' && node.tessera?.collapsed === true) for (const member of columnMembers(doc, node)) out.add(member.id)
  }
  return out
}

/** Kinds of the whole board, computed once per document. */
export function kindsOf(doc: CanvasDoc): Map<string, CardKind> {
  return new Map(doc.nodes.map(node => [node.id, cardKind(node, doc)]))
}

/**
 * Split cards out of a board so they can move to another one.
 * @returns the cards, the edges fully inside the set, and the removal change for the source.
 */
export function extractCards(doc: CanvasDoc, ids: readonly string[]): { nodes: CanvasNode[]; edges: CanvasDoc['edges']; removal: Change } {
  const wanted = new Set(ids)
  const nodes = doc.nodes.filter(node => wanted.has(node.id))
  const edges = doc.edges.filter(edge => wanted.has(edge.fromNode) && wanted.has(edge.toNode))
  const leftover: Change = { nodes: {}, edges: {} }
  for (const id of wanted) (leftover.nodes as Record<string, null>)[id] = null
  for (const edge of doc.edges) if (wanted.has(edge.fromNode) || wanted.has(edge.toNode)) (leftover.edges as Record<string, null>)[edge.id] = null
  const fromColumns = removeFromColumns(doc, ids)
  return { nodes, edges, removal: composeChanges(fromColumns, leftover) }
}

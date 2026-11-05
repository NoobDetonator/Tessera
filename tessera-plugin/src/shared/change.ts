/**
 * The single mutation type. A Change upserts or deletes whole objects by id,
 * so applying, inverting and composing stay trivially correct and unknown
 * fields travel with their object.
 */
import type { CanvasDoc, CanvasEdge, CanvasNode } from './canvas.ts'

export interface Change {
  /** Node id to its new value, or null to delete. */
  nodes?: Record<string, CanvasNode | null>
  edges?: Record<string, CanvasEdge | null>
  /** Full node id order, lowest z first. Ids not listed keep their relative place at the end. */
  order?: string[]
}

export const isEmptyChange = (change: Change): boolean =>
  Object.keys(change.nodes ?? {}).length === 0 && Object.keys(change.edges ?? {}).length === 0 && change.order === undefined

/** Apply a change, returning a new document. Nodes new to the doc land on top. */
export function applyChange(doc: CanvasDoc, change: Change): CanvasDoc {
  let nodes = doc.nodes
  if (change.nodes !== undefined) {
    const pending = new Map(Object.entries(change.nodes))
    const next: CanvasNode[] = []
    for (const node of doc.nodes) {
      if (!pending.has(node.id)) { next.push(node); continue }
      const value = pending.get(node.id)
      pending.delete(node.id)
      if (value !== null && value !== undefined) next.push(value)
    }
    for (const value of pending.values()) if (value !== null) next.push(value)
    nodes = next
  }
  if (change.order !== undefined) {
    const rank = new Map(change.order.map((id, index) => [id, index]))
    nodes = [...nodes].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }
  let edges = doc.edges
  if (change.edges !== undefined) {
    const pending = new Map(Object.entries(change.edges))
    const next: CanvasEdge[] = []
    for (const edge of doc.edges) {
      if (!pending.has(edge.id)) { next.push(edge); continue }
      const value = pending.get(edge.id)
      pending.delete(edge.id)
      if (value !== null && value !== undefined) next.push(value)
    }
    for (const value of pending.values()) if (value !== null) next.push(value)
    edges = next
  }
  return { ...doc, nodes, edges }
}

/** The change that undoes `change` when applied to the document `change` produced from `doc`. */
export function invertChange(doc: CanvasDoc, change: Change): Change {
  const inverse: Change = {}
  if (change.nodes !== undefined) {
    const byId = new Map(doc.nodes.map(node => [node.id, node]))
    inverse.nodes = {}
    let structural = false
    for (const [id, value] of Object.entries(change.nodes)) {
      const before = byId.get(id)
      inverse.nodes[id] = before ?? null
      if (before === undefined || value === null) structural = true
    }
    if (structural) inverse.order = doc.nodes.map(node => node.id)
  }
  if (change.order !== undefined) inverse.order = doc.nodes.map(node => node.id)
  if (change.edges !== undefined) {
    const byId = new Map(doc.edges.map(edge => [edge.id, edge]))
    inverse.edges = {}
    for (const id of Object.keys(change.edges)) inverse.edges[id] = byId.get(id) ?? null
  }
  return inverse
}

/** One change equivalent to applying `first` and then `second`. */
export function composeChanges(first: Change, second: Change): Change {
  const out: Change = {}
  if (first.nodes !== undefined || second.nodes !== undefined) out.nodes = { ...first.nodes, ...second.nodes }
  if (first.edges !== undefined || second.edges !== undefined) out.edges = { ...first.edges, ...second.edges }
  const order = second.order ?? first.order
  if (order !== undefined) out.order = order
  return out
}

/** The change turning `from` into `to`. Compares by serialized value. */
export function diffDocs(from: CanvasDoc, to: CanvasDoc): Change {
  const change: Change = {}
  const nodes: Record<string, CanvasNode | null> = {}
  const before = new Map(from.nodes.map(node => [node.id, node]))
  for (const node of to.nodes) {
    const previous = before.get(node.id)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(node)) nodes[node.id] = node
    before.delete(node.id)
  }
  for (const id of before.keys()) nodes[id] = null
  if (Object.keys(nodes).length > 0) change.nodes = nodes
  const edges: Record<string, CanvasEdge | null> = {}
  const beforeEdges = new Map(from.edges.map(edge => [edge.id, edge]))
  for (const edge of to.edges) {
    const previous = beforeEdges.get(edge.id)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(edge)) edges[edge.id] = edge
    beforeEdges.delete(edge.id)
  }
  for (const id of beforeEdges.keys()) edges[id] = null
  if (Object.keys(edges).length > 0) change.edges = edges
  const fromOrder = from.nodes.map(node => node.id).join()
  const toOrder = to.nodes.map(node => node.id).join()
  if (fromOrder !== toOrder) change.order = to.nodes.map(node => node.id)
  return change
}

/** Delete nodes together with every edge attached to them. */
export function deleteNodesChange(doc: CanvasDoc, ids: Iterable<string>): Change {
  const gone = new Set(ids)
  const nodes: Record<string, null> = {}
  for (const id of gone) nodes[id] = null
  const edges: Record<string, null> = {}
  for (const edge of doc.edges) if (gone.has(edge.fromNode) || gone.has(edge.toNode)) edges[edge.id] = null
  return { nodes, edges }
}

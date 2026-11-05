/** Auto-layout: grid, tree by edges, or clusters by tag. Pure, shared by the UI and the agent tools. */
import { boundsOf, type CanvasDoc, type CanvasNode } from './canvas.ts'
import type { Change } from './change.ts'
import { groupDescendants } from './classify.ts'
import { snapToGrid } from './geometry.ts'
import { owningColumn } from './structure.ts'

export type LayoutMode = 'grid' | 'tree' | 'cluster'
export const LAYOUT_MODES: readonly LayoutMode[] = ['grid', 'tree', 'cluster']

type Spots = Map<string, { x: number; y: number }>
const GAP = 48

function gridSpots(nodes: readonly CanvasNode[], originX: number, originY: number): Spots {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  const widths: number[] = [], heights: number[] = []
  sorted.forEach((node, index) => {
    const col = index % columns, row = Math.floor(index / columns)
    widths[col] = Math.max(widths[col] ?? 0, node.width)
    heights[row] = Math.max(heights[row] ?? 0, node.height)
  })
  const spots: Spots = new Map()
  sorted.forEach((node, index) => {
    const col = index % columns, row = Math.floor(index / columns)
    const x = originX + widths.slice(0, col).reduce((sum, width) => sum + width + GAP, 0)
    const y = originY + heights.slice(0, row).reduce((sum, height) => sum + height + GAP, 0)
    spots.set(node.id, { x, y })
  })
  return spots
}

function treeSpots(doc: CanvasDoc, nodes: readonly CanvasNode[], originX: number, originY: number): Spots {
  const ids = new Set(nodes.map(node => node.id))
  const children = new Map<string, string[]>()
  const parents = new Map<string, number>()
  for (const edge of doc.edges) {
    if (!ids.has(edge.fromNode) || !ids.has(edge.toNode) || edge.fromNode === edge.toNode) continue
    children.set(edge.fromNode, [...(children.get(edge.fromNode) ?? []), edge.toNode])
    parents.set(edge.toNode, (parents.get(edge.toNode) ?? 0) + 1)
  }
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  const depth = new Map<string, number>()
  const queue = sorted.filter(node => (parents.get(node.id) ?? 0) === 0).map(node => node.id)
  for (const id of queue) depth.set(id, 0)
  // Breadth first; a cycle's members are reached once and stay at the first depth found.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string
    for (const child of children.get(id) ?? []) {
      if (depth.has(child)) continue
      depth.set(child, (depth.get(id) ?? 0) + 1)
      queue.push(child)
    }
  }
  for (const node of sorted) if (!depth.has(node.id)) depth.set(node.id, 0) // an all-cycle component has no root
  const layers = new Map<number, CanvasNode[]>()
  for (const node of sorted) {
    const layer = depth.get(node.id) as number
    layers.set(layer, [...(layers.get(layer) ?? []), node])
  }
  const spots: Spots = new Map()
  let x = originX
  for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
    const members = layers.get(layer) as CanvasNode[]
    let y = originY
    for (const node of members) {
      spots.set(node.id, { x, y })
      y += node.height + GAP
    }
    x += Math.max(...members.map(node => node.width)) + GAP * 2
  }
  return spots
}

function clusterSpots(nodes: readonly CanvasNode[], originX: number, originY: number): Spots {
  const clusters = new Map<string, CanvasNode[]>()
  for (const node of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const key = node.tessera?.tags?.[0] ?? ''
    clusters.set(key, [...(clusters.get(key) ?? []), node])
  }
  const order = [...clusters.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  const spots: Spots = new Map()
  let x = originX
  for (const key of order) {
    const members = clusters.get(key) as CanvasNode[]
    const inner = gridSpots(members, x, originY)
    for (const [id, spot] of inner) spots.set(id, spot)
    const box = boundsOf(members.map(node => ({ ...node, ...inner.get(node.id) as { x: number; y: number } })))
    x += (box?.width ?? 0) + GAP * 2
  }
  return spots
}

/**
 * The change that lays cards out. With no ids, every top-level card takes part.
 * Column members stay with their column, and a group carries what is inside it.
 */
export function layoutChange(doc: CanvasDoc, ids: readonly string[], mode: LayoutMode): Change {
  const wanted = ids.length === 0 ? undefined : new Set(ids)
  const nodes = doc.nodes.filter((node) => {
    if (wanted !== undefined && !wanted.has(node.id)) return false
    return owningColumn(doc, node.id) === undefined && node.tessera?.locked !== true
  })
  const box = boundsOf(nodes)
  if (box === undefined) return {}
  const spots = mode === 'tree' ? treeSpots(doc, nodes, box.x, box.y)
    : mode === 'cluster' ? clusterSpots(nodes, box.x, box.y)
      : gridSpots(nodes, box.x, box.y)
  const out: Record<string, CanvasNode> = {}
  const moving = new Set(nodes.map(node => node.id))
  for (const node of nodes) {
    const spot = spots.get(node.id)
    if (spot === undefined) continue
    const x = snapToGrid(spot.x), y = snapToGrid(spot.y)
    const dx = x - node.x, dy = y - node.y
    if (dx === 0 && dy === 0) continue
    out[node.id] = { ...node, x, y }
    if (node.type !== 'group') continue
    for (const child of groupDescendants(doc, node)) {
      if (!moving.has(child.id)) out[child.id] = { ...child, x: child.x + dx, y: child.y + dy }
    }
  }
  return { nodes: out }
}

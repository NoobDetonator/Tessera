/**
 * Three-way merge for a board changed on disk while Tessera holds its own
 * state. Rule: never lose a local edit. Disk changes land wherever the local
 * side left a field alone; a real conflict keeps the local value.
 */
import type { CanvasDoc } from './canvas.ts'

type Json = Record<string, unknown>
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function mergeFields(base: Json | undefined, ours: Json, theirs: Json): Json {
  const out: Json = {}
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = base?.[key], o = ours[key], t = theirs[key]
    const value = same(o, b) ? t : o
    if (value !== undefined) out[key] = value
  }
  return out
}

function mergeById<T extends { id: string }>(base: readonly T[], ours: readonly T[], theirs: readonly T[]): T[] {
  const baseById = new Map(base.map(item => [item.id, item]))
  const oursById = new Map(ours.map(item => [item.id, item]))
  const theirsById = new Map(theirs.map(item => [item.id, item]))
  const out: T[] = []
  const keep = (id: string): T | undefined => {
    const b = baseById.get(id), o = oursById.get(id), t = theirsById.get(id)
    if (o !== undefined && t !== undefined) return mergeFields(b, o, t) as T
    if (o !== undefined) return b === undefined || !same(o, b) ? o : undefined // disk deleted; keep only a local edit
    if (t !== undefined) return b === undefined || !same(t, b) ? t : undefined // local deleted; keep only a disk edit
    return undefined
  }
  // The disk's stacking order leads; local additions stay on top.
  const seen = new Set<string>()
  for (const item of [...theirs, ...ours]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const merged = keep(item.id)
    if (merged !== undefined) out.push(merged)
  }
  return out
}

/**
 * Merge `theirs` (disk) into `ours` (memory), both descended from `base`.
 * @returns a new document that always contains every local edit.
 */
export function mergeDocs(base: CanvasDoc, ours: CanvasDoc, theirs: CanvasDoc): CanvasDoc {
  const { nodes: _bn, edges: _be, ...baseRoot } = base
  const { nodes: _on, edges: _oe, ...oursRoot } = ours
  const { nodes: _tn, edges: _te, ...theirsRoot } = theirs
  return {
    ...mergeFields(baseRoot, oursRoot, theirsRoot),
    nodes: mergeById(base.nodes, ours.nodes, theirs.nodes),
    edges: mergeById(base.edges, ours.edges, theirs.edges),
  }
}

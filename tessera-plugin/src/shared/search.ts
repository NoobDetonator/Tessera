/** Text search over cards. No index: boards are small files, and a scan keeps results always current. */
import type { CanvasDoc, CanvasNode, CardKind } from './canvas.ts'
import { cardKind } from './classify.ts'

export interface SearchOptions {
  tags?: readonly string[]
  types?: readonly CardKind[]
}

export interface SearchHit {
  board: string
  id: string
  kind: CardKind
  title: string
  snippet: string
  tags: string[]
}

/** A short human name for a card. */
export function cardTitle(node: CanvasNode): string {
  if (typeof node.tessera?.title === 'string' && node.tessera.title !== '') return node.tessera.title
  if (typeof node.label === 'string' && node.label !== '') return node.label
  if (typeof node.text === 'string') {
    const first = node.text.split('\n').find(line => line.trim() !== '') ?? ''
    return first.replace(/^#+\s*/, '').replace(/^\s*[-*+] \[[ xX]\]\s*/, '').trim().slice(0, 80)
  }
  if (typeof node.tessera?.preview?.title === 'string') return node.tessera.preview.title
  if (typeof node.file === 'string') return node.file.slice(node.file.lastIndexOf('/') + 1).replace(/\.canvas$/i, '')
  if (typeof node.url === 'string') return node.url
  return ''
}

/** All the searchable text of a card. */
function haystack(node: CanvasNode): string {
  return [
    node.text, node.label, node.url, node.file, node.tessera?.title, node.tessera?.caption,
    node.tessera?.preview?.title, node.tessera?.preview?.description, ...(node.tessera?.tags ?? []),
  ].filter(part => typeof part === 'string').join('\n')
}

/**
 * Find cards on one board. Every word of the query must appear, case-insensitively.
 * An empty query matches everything, so tag and type filters work alone.
 */
export function searchBoard(board: string, doc: CanvasDoc, query: string, options: SearchOptions = {}): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
  const hits: SearchHit[] = []
  for (const node of doc.nodes) {
    const kind = cardKind(node, doc)
    if (options.types !== undefined && options.types.length > 0 && !options.types.includes(kind)) continue
    const tags = Array.isArray(node.tessera?.tags) ? node.tessera.tags : []
    if (options.tags !== undefined && options.tags.length > 0 && !options.tags.every(tag => tags.includes(tag))) continue
    const text = haystack(node)
    const lower = text.toLowerCase()
    if (!words.every(word => lower.includes(word))) continue
    const first = words[0] === undefined ? 0 : lower.indexOf(words[0])
    const start = Math.max(0, first - 40)
    const snippet = `${start > 0 ? '…' : ''}${text.slice(start, start + 140).replace(/\s+/g, ' ').trim()}${start + 140 < text.length ? '…' : ''}`
    hits.push({ board, id: node.id, kind, title: cardTitle(node), snippet, tags })
  }
  return hits
}

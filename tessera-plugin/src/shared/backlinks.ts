/** `[[wiki links]]` between cards. A link names a card by id or title; the index says who points at what. */
import type { CanvasDoc, CanvasNode } from './canvas.ts'
import { cardTitle } from './search.ts'

const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g

/** Link names in a text, skipping fenced code. */
export function extractLinks(text: string): string[] {
  const names: string[] = []
  text.split(/(```[\s\S]*?```)/g).forEach((part, index) => {
    if (index % 2 === 1) return
    for (const match of part.matchAll(WIKI_LINK)) names.push((match[1] as string).trim())
  })
  return names
}

/** The card a link name refers to: an exact id first, then a title, ignoring case. */
export function resolveLink(doc: CanvasDoc, name: string): CanvasNode | undefined {
  const wanted = name.trim().toLowerCase()
  return doc.nodes.find(node => node.id === name.trim()) ?? doc.nodes.find(node => cardTitle(node).toLowerCase() === wanted)
}

/** For each card, the cards that link to it. A card linking to itself does not count. */
export function backlinkIndex(doc: CanvasDoc): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const node of doc.nodes) {
    if (typeof node.text !== 'string' || !node.text.includes('[[')) continue
    // Two spellings can reach one card, so count targets rather than names.
    const targets = new Set(extractLinks(node.text).map(name => resolveLink(doc, name)?.id))
    for (const target of targets) {
      if (target === undefined || target === node.id) continue
      index.set(target, [...(index.get(target) ?? []), node.id])
    }
  }
  return index
}

/** The open `[[` a caret sits inside, for autocomplete. */
export function openLinkAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf('[[')
  if (start === -1) return undefined
  const query = before.slice(start + 2)
  if (query.includes(']') || query.includes('\n')) return undefined
  return { start, query }
}

/** Replace the open `[[query` with a finished link. */
export function completeLink(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const inserted = `[[${name}]]`
  // A closing `]]` the user already typed would otherwise end up doubled.
  const after = text.slice(caret).replace(/^\]\]/, '')
  return { text: `${text.slice(0, start)}${inserted}${after}`, caret: start + inserted.length }
}

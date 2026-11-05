/** Board-level routes: the board list, creating, renaming, deleting, and user preferences. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CanvasDoc } from '../shared/canvas.ts'
import { cardKind } from '../shared/classify.ts'
import type { BoardInfo, BoardList } from '../shared/protocol.ts'
import type { RouteHandler } from './http.ts'
import { normalizeBoardPath, slugify, TesseraError, type BoardStore } from './store.ts'

const PREFS_FILE = '_tessera.json'

interface Prefs { favorites?: string[]; [key: string]: unknown }

/** Read preferences, treating a missing or damaged file as empty. */
export async function readPrefs(root: string): Promise<Prefs> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, PREFS_FILE), 'utf8'))
    return typeof value === 'object' && value !== null ? value as Prefs : {}
  } catch {
    return {}
  }
}

/** The title a board shows: its file name without folder or extension. */
export const titleOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.canvas$/i, '')

/** Board paths a document's Board cards point at. */
export function childBoards(doc: CanvasDoc): string[] {
  return doc.nodes.flatMap(node => cardKind(node, doc) === 'board' && typeof node.file === 'string' ? [node.file] : [])
}

/** Summarize every board for the sidebar. A damaged file is listed with no cards rather than hidden. */
export async function listBoards(store: BoardStore, root: string): Promise<BoardList> {
  const boards: BoardInfo[] = []
  for (const path of await store.listPaths()) {
    const doc = await store.peek(path)
    boards.push({ path, title: titleOf(path), cards: doc?.nodes.length ?? 0, children: doc === undefined ? [] : childBoards(doc) })
  }
  const prefs = await readPrefs(root)
  return { boards, favorites: Array.isArray(prefs.favorites) ? prefs.favorites : [], root }
}

export function workspaceRoutes(store: BoardStore, root: string): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  routes.set('GET /boards', () => listBoards(store, root))
  routes.set('POST /board/create', async ({ json }) => {
    const body = await json()
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title : 'Untitled'
    const path = await store.freePath(title)
    await store.create(path, { nodes: [], edges: [] })
    return { path }
  })
  routes.set('POST /board/rename', async ({ json }) => {
    const body = await json()
    const from = normalizeBoardPath(body.path)
    if (typeof body.title !== 'string' || body.title.trim() === '') throw new TesseraError('bad-title', 'A title is required.')
    const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const to = normalizeBoardPath(`${folder}${slugify(body.title)}.canvas`)
    if (to === from) return { path: to }
    await store.rename(from, to)
    // Keep every parent's Board card pointing at the renamed file.
    for (const path of await store.listPaths()) {
      const doc = await store.peek(path)
      if (doc === undefined) continue
      const refs = doc.nodes.filter(node => node.file === from)
      if (refs.length === 0) continue
      await store.apply(path, { nodes: Object.fromEntries(refs.map(node => [node.id, { ...node, file: to }])) }, { origin: 'user', undoable: false })
    }
    const prefs = await readPrefs(root)
    if (prefs.favorites?.includes(from)) {
      await writePrefs(root, { ...prefs, favorites: prefs.favorites.map(path => path === from ? to : path) })
    }
    return { path: to }
  })
  routes.set('POST /board/delete', async ({ json }) => {
    await store.remove(normalizeBoardPath((await json()).path))
    return { ok: true }
  })
  routes.set('POST /prefs', async ({ json }) => {
    const body = await json()
    const prefs = await readPrefs(root)
    if (Array.isArray(body.favorites)) prefs.favorites = body.favorites.filter((item): item is string => typeof item === 'string')
    await writePrefs(root, prefs)
    return { ok: true }
  })
  return routes
}

async function writePrefs(root: string, prefs: Prefs): Promise<void> {
  await writeFile(join(root, PREFS_FILE), `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}

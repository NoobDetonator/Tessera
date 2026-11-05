/** Board-level routes: the board list, creating, renaming, deleting, and user preferences. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CanvasDoc } from '../shared/canvas.ts'
import { cardKind } from '../shared/classify.ts'
import type { BoardInfo, BoardList } from '../shared/protocol.ts'
import { searchBoard, type SearchHit } from '../shared/search.ts'
import { BUILTIN_TEMPLATES, buildTemplate, instantiate } from '../shared/templates.ts'
import { parseCanvas, serializeCanvas } from '../shared/canvas.ts'
import { mkdir, readdir } from 'node:fs/promises'
import type { RouteHandler } from './http.ts'
import { fetchPreview, type WebFetcher } from './linkpreview.ts'
import { normalizeBoardPath, normalizeRelativePath, slugify, TesseraError, type BoardStore } from './store.ts'

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

const TEMPLATE_DIR = '_templates'

/** The starting document for a template id. Saved templates get new ids each time. */
async function templateDoc(root: string, id: string): Promise<CanvasDoc> {
  if (!id.startsWith('saved:')) {
    const built = buildTemplate(id)
    if (built === undefined) throw new TesseraError('bad-template', `Unknown template: ${id}`)
    return built
  }
  const file = id.slice('saved:'.length)
  if (file !== slugify(file)) throw new TesseraError('bad-template', 'Unknown template.')
  try {
    return instantiate(parseCanvas(await readFile(join(root, TEMPLATE_DIR, file), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TesseraError('bad-template', 'That template no longer exists.', 404)
    throw error
  }
}

/** Extensions that would run code when handed to the system opener. */
const EXECUTABLE = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.lnk', '.pif', '.reg', '.hta', '.cpl', '.jar', '.sh', '.bash', '.zsh', '.command', '.app', '.appimage', '.desktop', '.deb', '.rpm', '.url', '.html', '.htm', '.svg'])

/** Hand a file inside the board folder to the system's default app. Executable types are refused. */
async function openWithSystem(store: BoardStore, relativePath: string): Promise<void> {
  const path = normalizeRelativePath(relativePath)
  if (EXECUTABLE.has(extname(path).toLowerCase())) throw new TesseraError('refused', 'This file type can run code, so Tessera will not open it.', 403)
  const file = await store.resolveInside(path)
  if (!existsSync(file)) throw new TesseraError('not-found', `No file at ${path}`, 404)
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [file]] as const
    : process.platform === 'darwin' ? ['open', [file]] as const
      : ['xdg-open', [file]] as const
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('spawn', () => { child.unref(); done() })
    child.once('error', fail)
  })
}

export function workspaceRoutes(store: BoardStore, root: string, web: () => WebFetcher | undefined): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  routes.set('GET /search', async ({ url }) => {
    const query = url.searchParams.get('q') ?? ''
    const matches: SearchHit[] = []
    for (const path of await store.listPaths()) {
      const doc = await store.peek(path)
      if (doc !== undefined) matches.push(...searchBoard(path, doc, query))
    }
    return { matches: matches.slice(0, 50), truncated: matches.length > 50 }
  })
  routes.set('GET /templates', async () => ({
    builtin: BUILTIN_TEMPLATES,
    saved: (await readdir(join(root, TEMPLATE_DIR)).catch(() => [] as string[]))
      .filter(file => file.toLowerCase().endsWith('.canvas'))
      .map(file => ({ id: `saved:${file}`, title: titleOf(file) })),
  }))
  routes.set('POST /templates/save', async ({ json }) => {
    const body = await json()
    const path = normalizeBoardPath(body.path)
    if (typeof body.name !== 'string' || body.name.trim() === '') throw new TesseraError('bad-name', 'A name is required.')
    await store.flush(path)
    const { doc } = await store.read(path)
    await mkdir(join(root, TEMPLATE_DIR), { recursive: true })
    await writeFile(join(root, TEMPLATE_DIR, `${slugify(body.name)}.canvas`), serializeCanvas(doc), 'utf8')
    return { ok: true }
  })
  routes.set('GET /link-preview', async ({ url }) => {
    const service = web()
    if (service === undefined) throw new TesseraError('unavailable', 'Web access is not available in this setup.', 503)
    const target = url.searchParams.get('url')
    if (target === null) throw new TesseraError('bad-url', 'A url is required.')
    try {
      return await fetchPreview(service, target)
    } catch (error) {
      if (error instanceof TesseraError) throw error
      throw new TesseraError('preview-failed', (error as Error).message, 502)
    }
  })
  routes.set('POST /open', async ({ json }) => {
    await openWithSystem(store, String((await json()).path ?? ''))
    return { ok: true }
  })
  routes.set('GET /boards', () => listBoards(store, root))
  routes.set('POST /board/create', async ({ json }) => {
    const body = await json()
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title : 'Untitled'
    const doc = typeof body.template === 'string' && body.template !== '' ? await templateDoc(root, body.template) : { nodes: [], edges: [] }
    const path = await store.freePath(title)
    await store.create(path, doc)
    return { path, title: titleOf(path) }
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

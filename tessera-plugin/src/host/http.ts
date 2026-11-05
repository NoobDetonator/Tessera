/**
 * The bridge's Host half. One prefix route answers JSON requests, an SSE
 * stream and file reads. Every request passes loopback Host, same-origin and
 * token checks before any handler runs.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { Change } from '../shared/change.ts'
import type { ApplyRequest, AssetResult, ServerEvent } from '../shared/protocol.ts'
import { normalizeBoardPath, normalizeRelativePath, TesseraError, type BoardStore } from './store.ts'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.canvas': 'application/json',
}

/** Types safe to render on this origin. Everything else downloads, so an HTML file can never run here. */
const INLINE = /^(image\/|audio\/|video\/|application\/pdf|text\/plain)/

const EXTENSION_FOR_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME).filter(([ext]) => !['.jpeg', '.oga', '.md', '.canvas'].includes(ext)).map(([ext, mime]) => [mime, ext]),
)

export interface ApiConfig {
  maxJsonBytes: number
  maxAssetBytes: number
}

export interface ApiContext {
  store: BoardStore
  token: string
  config: ApiConfig
  routes: Map<string, RouteHandler>
  warn: (error: unknown) => void
}

export interface RouteRequest {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  /** Lazily parsed JSON body. */
  json: () => Promise<Record<string, unknown>>
}

/** Returns the JSON response body, or undefined when the handler already answered. */
export type RouteHandler = (request: RouteRequest) => Promise<unknown>

/** Authority check: only loopback names, so a rebinding hostname cannot reach the API. */
export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (authority === undefined) return false
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(authority)
  if (match === null) return false
  const host = (match[1] as string).toLowerCase()
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith('.localhost')
}

/** Whether a listener address stays on this machine. */
export const isLoopbackBind = (host: string): boolean => host === '::1' || host === 'localhost' || /^127(\.\d{1,3}){3}$/.test(host)

function tokensMatch(given: string | null | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Decide whether a request may reach the API.
 * @returns the HTTP status to refuse with, or undefined to admit.
 */
export function admit(req: IncomingMessage, url: URL, token: string): 401 | 403 | undefined {
  if (!isLoopbackAuthority(req.headers.host)) return 403
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return 403 // an unparseable Origin such as "null" is a sandboxed or opaque caller
    }
    if (originHost !== req.headers.host) return 403
  }
  const header = req.headers['x-tessera-token']
  const presented = typeof header === 'string' ? header : url.searchParams.get('token')
  return tokensMatch(presented, token) ? undefined : 401
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new TesseraError('too-large', 'Request body is too large.', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(text)
}

/** Validate an incoming change at the wire boundary. */
export function validateChange(value: unknown): Change {
  if (typeof value !== 'object' || value === null) throw new TesseraError('bad-change', 'change must be an object')
  const change = value as Change
  const out: Change = {}
  if (change.nodes !== undefined) {
    if (typeof change.nodes !== 'object' || change.nodes === null) throw new TesseraError('bad-change', 'change.nodes must be an object')
    for (const [id, node] of Object.entries(change.nodes)) {
      if (node === null) continue
      if (typeof node !== 'object' || node.id !== id || typeof node.type !== 'string'
        || ![node.x, node.y, node.width, node.height].every(n => typeof n === 'number' && Number.isFinite(n))) {
        throw new TesseraError('bad-change', `Invalid node ${id}`)
      }
    }
    out.nodes = change.nodes
  }
  if (change.edges !== undefined) {
    if (typeof change.edges !== 'object' || change.edges === null) throw new TesseraError('bad-change', 'change.edges must be an object')
    for (const [id, edge] of Object.entries(change.edges)) {
      if (edge === null) continue
      if (typeof edge !== 'object' || edge.id !== id || typeof edge.fromNode !== 'string' || typeof edge.toNode !== 'string') {
        throw new TesseraError('bad-change', `Invalid edge ${id}`)
      }
    }
    out.edges = change.edges
  }
  if (change.order !== undefined) {
    if (!Array.isArray(change.order) || !change.order.every(id => typeof id === 'string')) throw new TesseraError('bad-change', 'change.order must be strings')
    out.order = change.order
  }
  return out
}

/** Fan-out of server events to connected SSE streams. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout
  readonly serverId = randomBytes(6).toString('hex')

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': keepalive\n\n')
    }, 25_000)
    this.heartbeat.unref?.()
  }

  get size(): number {
    return this.clients.size
  }

  connect(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.clients.add(res)
    this.write(res, { type: 'hello', serverId: this.serverId })
    req.on('close', () => { this.clients.delete(res) })
  }

  private write(res: ServerResponse, event: ServerEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  broadcast(event: ServerEvent): void {
    for (const client of this.clients) this.write(client, event)
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}

/** Serve one file from the board folder with Range support for media seeking. */
async function serveFile(request: RouteRequest, ctx: ApiContext, relativePath: string): Promise<undefined> {
  const { req, res } = request
  const path = normalizeRelativePath(relativePath)
  const file = await ctx.store.resolveInside(path)
  let info
  try {
    info = await stat(file)
  } catch {
    throw new TesseraError('not-found', `No file at ${path}`, 404)
  }
  if (!info.isFile()) throw new TesseraError('not-found', `No file at ${path}`, 404)
  const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
  const headers: Record<string, string> = {
    'content-type': mime,
    etag,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-disposition': INLINE.test(mime) ? 'inline' : 'attachment',
  }
  if (path.toLowerCase().endsWith('.svg')) headers['content-security-policy'] = "script-src 'none'; sandbox"
  // Only content-addressed assets are immutable; anything else must revalidate.
  if (!path.startsWith('_assets/')) headers['cache-control'] = 'private, no-cache'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return undefined
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0
  let end = info.size - 1
  let status = 200
  if (range !== null && info.size > 0) {
    const [, from = '', to = ''] = range
    if (from === '') start = Math.max(0, info.size - Number(to))
    else {
      start = Number(from)
      if (to !== '') end = Math.min(Number(to), end)
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return undefined
    }
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  }
  headers['content-length'] = String(info.size === 0 ? 0 : end - start + 1)
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return undefined }
  await pipeline(createReadStream(file, { start, end }), res).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  })
  return undefined
}

/** Stream an upload into the content-addressed asset folder. */
async function storeAsset(request: RouteRequest, ctx: ApiContext): Promise<AssetResult> {
  const { req, url } = request
  const rawName = url.searchParams.get('name') ?? 'file'
  const name = rawName.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200)
  const declared = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
  const ext = (extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '') || EXTENSION_FOR_MIME[declared]) ?? ''
  // A declared length lets us answer 413 cleanly; a chunked upload is cut off by the meter below.
  if (Number(req.headers['content-length'] ?? 0) > ctx.config.maxAssetBytes) throw new TesseraError('too-large', 'File is larger than the configured limit.', 413)
  const folder = await ctx.store.resolveInside('_assets')
  await mkdir(folder, { recursive: true })
  const temp = join(folder, `.upload-${randomBytes(6).toString('hex')}`)
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > ctx.config.maxAssetBytes) { done(new TesseraError('too-large', 'File is larger than the configured limit.', 413)); return }
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(req, meter, createWriteStream(temp))
    const stem = hash.digest('hex').slice(0, 32)
    const finalName = `${stem}${ext}`
    await rename(temp, join(folder, finalName))
    return { path: `_assets/${finalName}`, size, mime: MIME[ext] ?? (declared || 'application/octet-stream'), name }
  } finally {
    await rm(temp, { force: true }).catch(() => { /* the temp file was renamed or never created */ })
  }
}

/** Build the prefix-route handler. */
export function createApiHandler(ctx: ApiContext): (req: IncomingMessage, res: ServerResponse, subpath: string, url: URL) => Promise<void> {
  return async (req, res, subpath, url) => {
    const refusal = admit(req, url, ctx.token)
    if (refusal !== undefined) {
      send(res, refusal, { error: { code: refusal === 401 ? 'unauthorized' : 'forbidden', message: refusal === 401 ? 'Missing or wrong token.' : 'Request refused.' } })
      return
    }
    const request: RouteRequest = {
      req, res, url,
      json: async () => {
        const body = await readBody(req, ctx.config.maxJsonBytes)
        let parsed: unknown
        try {
          parsed = JSON.parse(body.toString('utf8') || '{}')
        } catch {
          throw new TesseraError('bad-json', 'Body is not JSON.')
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TesseraError('bad-json', 'Body must be an object.')
        return parsed as Record<string, unknown>
      },
    }
    try {
      if (subpath.startsWith('/file/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new TesseraError('method', 'GET only', 405)
        await serveFile(request, ctx, decodeURIComponent(subpath.slice('/file/'.length)))
        return
      }
      if (subpath === '/asset' && req.method === 'POST') {
        send(res, 200, await storeAsset(request, ctx))
        return
      }
      const route = ctx.routes.get(`${req.method} ${subpath}`)
      if (route === undefined) throw new TesseraError('not-found', `No route ${req.method} ${subpath}`, 404)
      const result = await route(request)
      if (result !== undefined) send(res, 200, result)
    } catch (error) {
      if (error instanceof TesseraError) {
        send(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      ctx.warn(error)
      send(res, 500, { error: { code: 'internal', message: (error as Error).message } })
    }
  }
}

/** The core board routes. */
export function boardRoutes(store: BoardStore, hub: EventHub): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  routes.set('GET /events', async ({ req, res }) => { hub.connect(req, res); return undefined })
  routes.set('GET /board', async ({ url }) => store.read(normalizeBoardPath(url.searchParams.get('path'))))
  routes.set('POST /board/apply', async ({ json }) => {
    const body = await json() as unknown as ApplyRequest
    const path = normalizeBoardPath(body.path)
    const rev = await store.apply(path, validateChange(body.change), {
      origin: 'user',
      clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      coalesce: typeof body.coalesce === 'string' ? body.coalesce : undefined,
      undoable: body.undoable !== false,
    })
    return { rev }
  })
  routes.set('POST /board/undo', async ({ json }) => {
    const path = normalizeBoardPath((await json()).path)
    return (await store.undo(path)) ?? { rev: null }
  })
  routes.set('POST /board/redo', async ({ json }) => {
    const path = normalizeBoardPath((await json()).path)
    return (await store.redo(path)) ?? { rev: null }
  })
  routes.set('POST /board/seal', async ({ json }) => {
    store.sealUndo(normalizeBoardPath((await json()).path))
    return { ok: true }
  })
  return routes
}


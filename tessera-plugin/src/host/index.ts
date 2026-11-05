/**
 * Tessera's Host half: owns the board folder and the bridge route. Tools and
 * the skill register from their own modules.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { API_PREFIX, BOOT_GLOBAL, INBOX_PATH, type BootGlobals } from '../shared/protocol.ts'
import { boardRoutes, createApiHandler, EventHub, isLoopbackBind } from './http.ts'
import type { WebFetcher } from './linkpreview.ts'
import { workspaceRoutes } from './workspace.ts'
import { AutoSnapshots, HistoryStore } from './history.ts'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from './skill.ts'
import { BoardStore, normalizeBoardPath, TesseraError } from './store.ts'
import { guardReadOnly, toolSpecs, type SandboxPolicyReader, type ToolRun } from './tools.ts'

export const name = 'tessera'
export const inject = ['tools']

export interface Config {
  /** Board folder. Relative paths resolve against the directory dsh started in. */
  root: string
  /** Delay between the last edit and the atomic write. */
  saveDebounceMs: number
  /** Largest single upload. */
  maxAssetBytes: number
  /** Largest JSON request body. */
  maxJsonBytes: number
  /** How long a delete waits for the user before counting as declined. */
  confirmTimeoutMs: number
  /** Minutes between automatic history snapshots of a board being edited. */
  autoSnapshotMinutes: number
}

export const Config: z<Config> = z.object({
  root: z.string().default('tessera'),
  saveDebounceMs: z.natural().default(500),
  maxAssetBytes: z.natural().min(1).default(1024 * 1024 * 1024),
  maxJsonBytes: z.natural().min(1).default(64 * 1024 * 1024),
  confirmTimeoutMs: z.natural().min(1000).default(120_000),
  autoSnapshotMinutes: z.number().min(0.01).default(10),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = resolve(config.root)
  const store = new BoardStore(root, config.saveDebounceMs)
  await store.start((message) => { ctx.logger.warn(message) })
  if (!await store.exists(INBOX_PATH)) await store.create(INBOX_PATH, { nodes: [], edges: [] })
  ctx.effect(() => () => store.stop(), 'tessera: board store')

  const hub = new EventHub()
  ctx.effect(() => () => { hub.close() }, 'tessera: event hub')

  store.on('change', (event) => {
    void store.read(event.path).then(({ canUndo, canRedo }) => {
      hub.broadcast({
        type: 'change',
        path: event.path, rev: event.rev, change: event.change, origin: event.origin,
        ...(event.clientId !== undefined ? { clientId: event.clientId } : {}),
        ...(event.label !== undefined ? { label: event.label } : {}),
        canUndo, canRedo,
      })
    })
  })
  store.on('saved', (event) => { hub.broadcast({ type: 'saved', ...event }) })
  store.on('save-error', (event) => {
    ctx.logger.warn(`Could not save ${event.path}: ${event.message}`)
    hub.broadcast({ type: 'save-error', ...event })
  })
  store.on('external-invalid', (event) => { hub.broadcast({ type: 'external-invalid', ...event }) })
  store.on('boards-changed', () => { hub.broadcast({ type: 'boards-changed' }) })
  store.on('board-removed', (event) => { hub.broadcast({ type: 'board-removed', ...event }) })

  const history = new HistoryStore(store, root)
  const autoSnapshots = new AutoSnapshots(config.autoSnapshotMinutes * 60_000)
  store.on('saved', ({ path }) => {
    if (!autoSnapshots.shouldSnapshot(path)) return
    history.snapshot(path, 'Auto', true).catch((error: Error) => { ctx.logger.warn(`Automatic snapshot of ${path} failed: ${error.message}`) })
  })

  // Delete confirmations: a question to whichever tab answers first.
  const waiting = new Map<string, (approved: boolean) => void>()
  const confirm = ({ path, ids, titles, signal }: { path: string; ids: string[]; titles: string[]; signal?: AbortSignal | undefined }): Promise<boolean> => {
    if (hub.size === 0) throw new TesseraError('no-ui', 'Deleting cards needs the user to confirm, but no Harness window is open. Ask the user to open the Web UI and try again.', 409)
    const id = randomBytes(8).toString('hex')
    return new Promise<boolean>((done) => {
      const finish = (approved: boolean): void => {
        waiting.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        hub.broadcast({ type: 'confirm-resolved', id })
        done(approved)
      }
      const onAbort = (): void => { finish(false) }
      const timer = setTimeout(() => { finish(false) }, config.confirmTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.set(id, finish)
      hub.broadcast({ type: 'confirm', id, path, ids, titles })
    })
  }
  ctx.effect(() => () => { for (const finish of [...waiting.values()]) finish(false) }, 'tessera: pending confirmations')

  // Every edit in one agent turn shares a key, so the whole turn undoes as one step.
  const turns = new Map<string, number>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(String(session.id), (turns.get(String(session.id)) ?? 0) + 1)
  })
  const turnKey = (run: ToolRun, path: string): string => {
    const session = String(run.agent?.id ?? 'unknown')
    return `agent:${session}:${turns.get(session) ?? 0}:${path}`
  }

  for (const spec of toolSpecs({ store, root, history, confirm, turnKey })) {
    const { mutates: _mutates, execute: _execute, ...definition } = spec
    const execute = guardReadOnly(spec, () => ctx.get('sandboxPolicy') as SandboxPolicyReader | undefined)
    ctx.effect(() => ctx.tools.register(defineTool({ ...definition, execute } as never)), `tessera: ${definition.name}`)
  }

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
      source: 'runtime',
    }), 'tessera: skill')
  })

  const token = randomBytes(32).toString('hex')
  const routes = boardRoutes(store, hub)
  let web: WebFetcher | undefined
  ctx.inject(['web'], (webCtx) => {
    web = webCtx.get('web') as unknown as WebFetcher
    webCtx.effect(() => () => { web = undefined }, 'tessera: web access')
  })
  for (const [key, handler] of workspaceRoutes(store, root, () => web)) routes.set(key, handler)
  routes.set('POST /confirm', async ({ json }) => {
    const body = await json()
    const finish = typeof body.id === 'string' ? waiting.get(body.id) : undefined
    if (finish === undefined) throw new TesseraError('stale', 'That question has already been answered.', 410)
    finish(body.approved === true)
    return { ok: true }
  })
  routes.set('GET /history', async ({ url }) => ({ snapshots: await history.list(normalizeBoardPath(url.searchParams.get('path'))) }))
  routes.set('GET /history/read', async ({ url }) => history.read(normalizeBoardPath(url.searchParams.get('path')), String(url.searchParams.get('id'))))
  routes.set('POST /history/snapshot', async ({ json }) => {
    const body = await json()
    if (typeof body.name !== 'string' || body.name.trim() === '') throw new TesseraError('bad-name', 'A name is required.')
    return history.snapshot(normalizeBoardPath(body.path), body.name.trim())
  })
  routes.set('POST /history/restore', async ({ json }) => {
    const body = await json()
    await history.restore(normalizeBoardPath(body.path), String(body.id))
    return { ok: true }
  })
  const handle = createApiHandler({
    store, token, routes,
    config: { maxAssetBytes: config.maxAssetBytes, maxJsonBytes: config.maxJsonBytes },
    warn: (error) => { ctx.logger.warn(error as Error) },
  })

  ctx.inject(['webServer'], (web) => {
    if (!isLoopbackBind(web.webServer.host)) {
      web.logger.warn(`Tessera stays off: the server is bound to ${web.webServer.host}, and its bridge only serves loopback.`)
      return
    }
    web.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: BOOT_GLOBAL, value: { token } satisfies BootGlobals })
    })
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder')
        await handle(req, res, url.pathname.slice(API_PREFIX.length) || '/', url)
      },
    }), 'tessera: bridge route')
  })
}

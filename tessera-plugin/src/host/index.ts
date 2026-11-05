/**
 * Tessera's Host half: owns the board folder and the bridge route. Tools and
 * the skill register from their own modules.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { API_PREFIX, BOOT_GLOBAL, type BootGlobals } from '../shared/protocol.ts'
import { boardRoutes, createApiHandler, EventHub, isLoopbackBind } from './http.ts'
import type { WebFetcher } from './linkpreview.ts'
import { workspaceRoutes } from './workspace.ts'
import { BoardStore } from './store.ts'

export const name = 'tessera'

export interface Config {
  /** Board folder. Relative paths resolve against the directory dsh started in. */
  root: string
  /** Delay between the last edit and the atomic write. */
  saveDebounceMs: number
  /** Largest single upload. */
  maxAssetBytes: number
  /** Largest JSON request body. */
  maxJsonBytes: number
}

export const Config: z<Config> = z.object({
  root: z.string().default('tessera'),
  saveDebounceMs: z.natural().default(500),
  maxAssetBytes: z.natural().min(1).default(1024 * 1024 * 1024),
  maxJsonBytes: z.natural().min(1).default(64 * 1024 * 1024),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = resolve(config.root)
  const store = new BoardStore(root, config.saveDebounceMs)
  await store.start((message) => { ctx.logger.warn(message) })
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

  const token = randomBytes(32).toString('hex')
  const routes = boardRoutes(store, hub)
  let web: WebFetcher | undefined
  ctx.inject(['web'], (webCtx) => {
    web = webCtx.get('web') as unknown as WebFetcher
    webCtx.effect(() => () => { web = undefined }, 'tessera: web access')
  })
  for (const [key, handler] of workspaceRoutes(store, root, () => web)) routes.set(key, handler)
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

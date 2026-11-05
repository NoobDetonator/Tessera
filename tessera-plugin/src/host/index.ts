import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tessera'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/tessera/api',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    }), 'tessera: api route')
    web.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__TESSERA__', value: { token: 'spike' } })
    })
  })
  ctx.tools.register(defineTool({
    name: 'tessera_ping',
    description: 'Spike tool.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'pong',
  }))
}

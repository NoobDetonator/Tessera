/** Tessera's Client half: registers the panel and owns the store's lifetime. */
import type { ComponentType } from 'react'
import { App, type T } from './App.tsx'
import { Dialog } from './overlays.tsx'
import { useTessera } from './store.ts'
import { en, pt, zh } from './i18n.ts'
import { TesseraStore } from './store.ts'
import './cardviews.tsx'
import css from './styles.css'

const PANEL_ID = 'tessera'
const NS = 'tessera'

export const inject = ['slots', 'locale', 'layout']

function BoardsIcon({ size }: { size?: number }): React.ReactNode {
  const edge = size ?? 16
  return (
    <svg width={edge} height={edge} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="1.75" width="5.5" height="7" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.75" y="1.75" width="5.5" height="4" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.75" y="7.25" width="5.5" height="7" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.75" y="10.25" width="5.5" height="4" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function DeleteQuestion({ store, t }: { store: TesseraStore; t: T }): React.ReactNode {
  const request = useTessera(store, state => state.confirms[0])
  if (request === undefined) return null
  const board = request.path.replace(/\.canvas$/i, '')
  const list = request.titles.map(title => `• ${title}`).join('\n')
  const more = request.ids.length > request.titles.length ? `\n… +${request.ids.length - request.titles.length}` : ''
  return (
    <Dialog
      key={request.id}
      t={t}
      request={{
        title: t('confirm.agentDelete').replace('{count}', String(request.ids.length)).replace('{board}', board),
        message: `${list}${more}`,
        input: false,
        danger: true,
        confirmLabel: t('menu.delete'),
      }}
      onClose={(value) => { void store.answerConfirm(request.id, value !== null) }}
    />
  )
}

interface SlotOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
}

/** The shell services this plugin uses. The packages declaring them are not build dependencies of this bundle. */
interface ClientContext {
  effect(callback: () => () => void, label?: string): unknown
  inject(services: readonly string[], callback: (ctx: ClientContext) => void): unknown
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: SlotOptions, component: ComponentType<never>): unknown
  }
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void }
  uiWorkspace: { startSession(workspaceId: undefined, options: { prompt: string; clearPreviousDraft: boolean }): void }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@tessera/dsh-tessera'
    style.textContent = css
    document.head.append(style)
    return () => { style.remove() }
  }, 'tessera: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, pt: { ...en, ...pt }, zh: { ...en, ...zh } }), 'tessera: dictionaries')

  const store = new TesseraStore()
  ctx.effect(() => store.start(), 'tessera: store')

  // Opens a new chat with this text in the composer, ready for the user to add to and send.
  let askAgent: ((text: string) => void) | undefined
  ctx.inject(['uiWorkspace'], (workspaceCtx) => {
    askAgent = (text) => { workspaceCtx.uiWorkspace.startSession(undefined, { prompt: text, clearPreviousDraft: true }) }
    workspaceCtx.effect(() => () => { askAgent = undefined }, 'tessera: ask the agent')
  })

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, ({ t }: { t: T }) => <App store={store} t={t} askAgent={(text) => { askAgent?.(text) }} />))

  // The agent usually runs while the chat is showing, so a delete question must appear over any panel.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tessera-confirm',
    locale: NS,
  }, ({ t }: { t: T }) => <DeleteQuestion store={store} t={t} />))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => en['panel.title'], // a product name, the same in every language
    locale: NS,
  }, ({ size }: { size?: number }) => <BoardsIcon size={size} />))
}

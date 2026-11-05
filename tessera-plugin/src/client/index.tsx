/** Tessera's Client half: registers the panel and owns the store's lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import { App, type T } from './App.tsx'
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

/* eslint-disable @typescript-eslint/no-explicit-any -- the slot and locale services are typed by packages this bundle does not import at build time */
export function apply(ctx: Context & Record<string, any>): void {
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

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, ({ t }: { t: T }) => <App store={store} t={t} />))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => ctx.locale.t?.(NS, 'panel.title') ?? en['panel.title'],
    locale: NS,
  }, ({ size }: { size?: number }) => <BoardsIcon size={size} />))
}

import { useEffect, useState } from 'react'
import { IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'

const PANEL = 'tessera'

function Panel({ t }: { t: (key: string) => string }) {
  const [text, setText] = useState('…')
  useEffect(() => { void fetch('/tessera/api/ping').then(async r => { setText(await r.text()) }) }, [])
  return <div data-tessera-root style={{ padding: 48 }}>{t('title')}: {text}</div>
}

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: any): void {
  const labels = { title: 'Tessera' }
  ctx.effect(() => ctx.locale.register('tessera', { en: labels, zh: labels }))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: 'tessera' }, Panel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 10, label: () => 'Tessera', locale: 'tessera',
  }, ({ size }: { size: number }) => <IconFolderCloseRegular size={size} />))
}

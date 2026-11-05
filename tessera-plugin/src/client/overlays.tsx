/** Modal surfaces of the panel: prompt dialog, image lightbox, full-width document editor, card toolbar. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CardKind } from '../shared/canvas.ts'
import { joinDocument, splitDocument } from '../shared/cardtext.ts'
import { fileUrl } from './bridge.ts'
import { MARKDOWN_LABELS, MarkdownText } from './cardviews.tsx'
import type { DialogRequest, TesseraStore } from './store.ts'
import { useTessera } from './store.ts'

type T = (key: string) => string

export function Dialog({ request, onClose, t }: { request: DialogRequest; onClose: (value: string | null) => void; t: T }): ReactNode {
  const [value, setValue] = useState(request.value ?? '')
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (request.input === false) panel.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()
    else input.current?.select()
  }, [request.input])
  return (
    <div className="t-modal-mask" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(null) }}>
      <form
        ref={panel}
        className="t-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose(null) }}
        onSubmit={(event) => { event.preventDefault(); onClose(request.input === false ? 'ok' : value) }}
      >
        <h2>{request.title}</h2>
        {request.message !== undefined ? <p>{request.message}</p> : null}
        {request.input !== false ? (
          <input
            ref={input}
            type={request.inputType ?? 'text'}
            value={value}
            aria-label={request.title}
            placeholder={request.placeholder}
            onChange={(event) => { setValue(event.target.value) }}
          />
        ) : null}
        <div className="t-dialog-actions">
          <button type="button" className="t-btn" onClick={() => { onClose(null) }}>{t('dialog.cancel')}</button>
          <button type="submit" className={`t-btn t-btn-primary${request.danger === true ? ' t-btn-solid-danger' : ''}`}>{request.confirmLabel ?? t('dialog.ok')}</button>
        </div>
      </form>
    </div>
  )
}

export function Lightbox({ store, id, t, onClose }: { store: TesseraStore; id: string; t: T; onClose: () => void }): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const node = doc?.nodes.find(item => item.id === id)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeButton.current?.focus() }, [])
  if (typeof node?.file !== 'string') return null
  return (
    <div
      className="t-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('card.image')}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}
    >
      <button ref={closeButton} type="button" className="t-btn t-lightbox-close" aria-label={t('dialog.close')} onClick={onClose}>✕</button>
      <img src={fileUrl(node.file)} alt={node.tessera?.caption ?? ''} />
      <input
        className="t-lightbox-caption"
        type="text"
        placeholder={t('image.caption')}
        aria-label={t('image.caption')}
        defaultValue={node.tessera?.caption ?? ''}
        disabled={node.tessera?.locked === true}
        onChange={(event) => { store.patchMeta(id, { caption: event.target.value }, { coalesce: `caption:${id}`, label: 'Edit caption' }) }}
      />
    </div>
  )
}

export function DocumentEditor({ store, id, t, onClose }: { store: TesseraStore; id: string; t: T; onClose: () => void }): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const node = doc?.nodes.find(item => item.id === id)
  const initial = splitDocument(node?.text ?? '')
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const key = useRef(`doc:${id}:${Date.now()}`)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string | undefined>(undefined)
  const titleInput = useRef<HTMLInputElement>(null)
  const locked = node?.tessera?.locked === true

  useEffect(() => { titleInput.current?.focus() }, [])

  const flush = (): void => {
    if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined }
    if (pending.current !== undefined) {
      store.patchNode(id, { text: pending.current }, { coalesce: key.current, label: 'Edit document' })
      pending.current = undefined
    }
  }
  const schedule = (nextTitle: string, nextBody: string): void => {
    pending.current = joinDocument(nextTitle, nextBody)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 300)
  }
  const close = (): void => { flush(); onClose() }
  useEffect(() => () => { flush() })

  return (
    <section
      className="t-docedit"
      role="dialog"
      aria-label={t('card.document')}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') close() }}
    >
      <header>
        <input
          ref={titleInput}
          className="t-docedit-title"
          type="text"
          value={title}
          disabled={locked}
          placeholder={t('document.untitled')}
          aria-label={t('document.title')}
          onChange={(event) => { setTitle(event.target.value); schedule(event.target.value, body) }}
        />
        <button type="button" className="t-btn" onClick={close}>{t('dialog.close')}</button>
      </header>
      <div className="t-docedit-panes">
        <textarea
          value={body}
          disabled={locked}
          spellCheck
          placeholder={t('document.placeholder')}
          aria-label={t('document.body')}
          onChange={(event) => { setBody(event.target.value); schedule(title, event.target.value) }}
        />
        <div className="t-docedit-preview"><MarkdownText text={body} labels={MARKDOWN_LABELS} omitHtml /></div>
      </div>
    </section>
  )
}

const ICON_PATHS: Partial<Record<CardKind, ReactNode>> = {
  note: <path d="M3 2.75h10v10.5H3zM5.5 6h5M5.5 8.5h5M5.5 11h3" />,
  document: <path d="M4 1.75h5.5L12.5 5v9.25H4zM9.5 1.75V5h3M6 8h4.5M6 10.5h4.5" />,
  todo: <path d="M2.5 4l1.25 1.25L6 3M2.5 10l1.25 1.25L6 9M8 4.5h5.5M8 10.5h5.5" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.7-3.7L5.3 7.8" />,
  image: <path d="M2.25 3h11.5v10H2.25zM2.5 11l3-3 2.5 2.5L10 8.5l3.5 3.5M6 6.25a.75.75 0 100-.01" />,
  file: <path d="M9 2.25l-5.5 5.5a2.5 2.5 0 003.5 3.5l6-6a1.75 1.75 0 00-2.5-2.5l-5.75 5.75" />,
  color: <path d="M8 1.75s4.25 4.3 4.25 7.5a4.25 4.25 0 01-8.5 0C3.75 6.05 8 1.75 8 1.75z" />,
  sketch: <path d="M2.5 13.5c1-3.5 2-4.5 3-3s1.5 1.5 3-1 3-5 5-6.5" />,
  board: <path d="M2 3h12v10H2zM4.25 5.25h3v2.5h-3zM9 5.25h2.75M9 7.75h2.75M4.25 10.25h7.5" />,
  column: <path d="M4.5 2h7v12h-7zM6.5 4.5h3M6.5 7.5h3M6.5 10.5h3" />,
  frame: <path d="M2 4.5h12V14H2zM2 2.25h5" />,
}

export const toolIcon = (kind: CardKind): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON_PATHS[kind]}</svg>
)

/**
 * Left toolbar. Click arms placement for the next canvas click; dragging an
 * icon onto the canvas places it where it lands; Enter places at the view's center.
 */
export function Toolbar({ kinds, armed, t, onArm, onDrop, onKeyboard }: {
  kinds: readonly CardKind[]
  armed: CardKind | undefined
  t: T
  onArm: (kind: CardKind | undefined) => void
  onDrop: (kind: CardKind, clientX: number, clientY: number) => void
  onKeyboard: (kind: CardKind) => void
}): ReactNode {
  const drag = useRef<{ kind: CardKind; startX: number; startY: number; moved: boolean; pointerId: number } | undefined>(undefined)
  return (
    <div className="t-toolbar" role="toolbar" aria-label={t('toolbar.label')} aria-orientation="vertical">
      {kinds.map(kind => (
        <button
          key={kind}
          type="button"
          className="t-btn t-tool"
          data-tool={kind}
          aria-label={t(`card.${kind}`)}
          aria-pressed={armed === kind}
          title={t(`card.${kind}`)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { kind, startX: event.clientX, startY: event.clientY, moved: false, pointerId: event.pointerId }
          }}
          onPointerMove={(event) => {
            const state = drag.current
            if (state !== undefined && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 5) state.moved = true
          }}
          onPointerUp={(event) => {
            const state = drag.current
            drag.current = undefined
            if (state === undefined) return
            if (state.moved) onDrop(state.kind, event.clientX, event.clientY)
            else onArm(armed === kind ? undefined : kind)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onKeyboard(kind) }
          }}
        >{toolIcon(kind)}</button>
      ))}
    </div>
  )
}

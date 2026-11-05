/** Keyboard-first surfaces: global search, command palette, new-board dialog, tag filter, version history. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CanvasDoc } from '../shared/canvas.ts'
import type { SearchHit } from '../shared/search.ts'
import { api } from './bridge.ts'
import { MiniBoard } from './cardviews.tsx'
import { useTessera, type TesseraStore } from './store.ts'

type T = (key: string) => string

export interface Command {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}

interface PickerProps<Item> {
  placeholder: string
  items: readonly Item[]
  keyOf: (item: Item) => string
  render: (item: Item) => ReactNode
  onQuery: (query: string) => void
  onPick: (item: Item) => void
  onClose: () => void
  empty: string
  label: string
  testId: string
}

/** A search box over a list, driven by the keyboard. */
function Picker<Item>({ placeholder, items, keyOf, render, onQuery, onPick, onClose, empty, label, testId }: PickerProps<Item>): ReactNode {
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { setActive(0) }, [items])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  return (
    <div className="t-modal-mask t-picker-mask" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="t-picker" role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${testId}-list`}
          aria-activedescendant={items[active] === undefined ? undefined : `${testId}-${active}`}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => { onQuery(event.target.value) }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') { event.preventDefault(); onClose() }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(items.length - 1, index + 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
            if (event.key === 'Enter') {
              event.preventDefault()
              const item = items[active]
              if (item !== undefined) onPick(item)
            }
          }}
        />
        <div ref={list} id={`${testId}-list`} className="t-picker-list" role="listbox" aria-label={label}>
          {items.length === 0 ? <div className="t-picker-empty">{empty}</div> : items.map((item, index) => (
            <div
              key={keyOf(item)}
              id={`${testId}-${index}`}
              className="t-picker-row"
              role="option"
              aria-selected={index === active}
              onPointerEnter={() => { setActive(index) }}
              onClick={() => { onPick(item) }}
            >{render(item)}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function CommandPalette({ commands, onClose, t }: { commands: readonly Command[]; onClose: () => void; t: T }): ReactNode {
  const [query, setQuery] = useState('')
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return commands.filter(command => command.disabled !== true && command.label.toLowerCase().includes(needle))
  }, [commands, query])
  return (
    <Picker
      testId="command-palette"
      label={t('palette.label')}
      placeholder={t('palette.placeholder')}
      empty={t('palette.none')}
      items={items}
      keyOf={command => command.id}
      onQuery={setQuery}
      onClose={onClose}
      onPick={(command) => { onClose(); command.run() }}
      render={command => (
        <>
          <span className="t-picker-title">{command.label}</span>
          {command.shortcut !== undefined ? <span className="t-menu-shortcut">{command.shortcut}</span> : null}
        </>
      )}
    />
  )
}

export function GlobalSearch({ onOpen, onClose, t }: { onOpen: (hit: SearchHit) => void; onClose: () => void; t: T }): ReactNode {
  const [hits, setHits] = useState<readonly SearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const latest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onQuery = useCallback((query: string) => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    const ticket = ++latest.current
    if (query.trim() === '') { setHits([]); setTruncated(false); return }
    timer.current = setTimeout(() => {
      api.fetch<{ matches: SearchHit[]; truncated: boolean }>('/search', { q: query }).then((result) => {
        if (ticket === latest.current) { setHits(result.matches); setTruncated(result.truncated) }
      }).catch(() => { /* a failed search shows no results, and the next keystroke tries again */ })
    }, 120)
  }, [])
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  return (
    <Picker
      testId="global-search"
      label={t('search.label')}
      placeholder={t('search.placeholder')}
      empty={t('search.none')}
      items={hits}
      keyOf={hit => `${hit.board}#${hit.id}`}
      onQuery={onQuery}
      onClose={onClose}
      onPick={(hit) => { onClose(); onOpen(hit) }}
      render={hit => (
        <div className="t-hit">
          <div className="t-hit-head">
            <span className="t-picker-title">{hit.title === '' ? t(`card.${hit.kind}`) : hit.title}</span>
            <span className="t-hit-board">{hit.board.replace(/\.canvas$/i, '')}{truncated ? ' +' : ''}</span>
          </div>
          {hit.snippet !== '' && hit.snippet !== hit.title ? <div className="t-hit-snippet">{hit.snippet}</div> : null}
        </div>
      )}
    />
  )
}

interface TemplateList {
  builtin: Array<{ id: string; title: string }>
  saved: Array<{ id: string; title: string }>
}

/** Create a board, optionally from a template. */
export function NewBoardDialog({ store, onClose, t }: { store: TesseraStore; onClose: () => void; t: T }): ReactNode {
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState('')
  const [templates, setTemplates] = useState<TemplateList>({ builtin: [], saved: [] })
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    api.fetch<TemplateList>('/templates').then(setTemplates).catch(() => { /* blank boards still work without the list */ })
  }, [])
  const titleFor = (value: string): string => [...templates.builtin, ...templates.saved].find(item => item.id === value)?.title ?? ''
  return (
    <div className="t-modal-mask" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form
        className="t-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('sidebar.new')}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}
        onSubmit={(event) => {
          event.preventDefault()
          const name = title.trim() === '' ? titleFor(template) : title.trim()
          if (name === '') return
          onClose()
          void store.createBoard(name, template === '' ? undefined : template)
        }}
      >
        <h2>{t('sidebar.new')}</h2>
        <input ref={input} type="text" value={title} aria-label={t('prompt.boardTitle')} placeholder={t('prompt.boardTitle')} onChange={(event) => { setTitle(event.target.value) }} />
        <label className="t-field">
          <span>{t('template.label')}</span>
          <select value={template} data-testid="template-select" onChange={(event) => { setTemplate(event.target.value) }}>
            <option value="">{t('template.blank')}</option>
            <optgroup label={t('template.builtin')}>
              {templates.builtin.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </optgroup>
            {templates.saved.length > 0 ? (
              <optgroup label={t('template.saved')}>
                {templates.saved.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="t-dialog-actions">
          <button type="button" className="t-btn" onClick={onClose}>{t('dialog.cancel')}</button>
          <button type="submit" className="t-btn t-btn-primary">{t('dialog.ok')}</button>
        </div>
      </form>
    </div>
  )
}

/** Tags on the open board. Selecting some dims every card without one of them. */
export function TagFilter({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const doc = useTessera(store, state => state.doc)
  const active = useTessera(store, state => state.filterTags)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of doc?.nodes ?? []) for (const tag of node.tessera?.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]))
  }, [doc])
  useEffect(() => {
    if (!open) return undefined
    const close = (event: PointerEvent): void => { if (root.current?.contains(event.target as Node) !== true) setOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => { window.removeEventListener('pointerdown', close) }
  }, [open])
  return (
    <div ref={root} className="t-popover-anchor">
      <button type="button" className="t-btn" aria-expanded={open} aria-pressed={active.length > 0} data-testid="tag-filter" onClick={() => { setOpen(!open) }}>
        {t('bar.tags')}{active.length > 0 ? ` (${active.length})` : ''}
      </button>
      {open ? (
        <div className="t-popover" role="group" aria-label={t('bar.tags')}>
          {tags.length === 0 ? <div className="t-picker-empty">{t('tags.none')}</div> : tags.map(([tag, count]) => (
            <label key={tag} className="t-popover-row">
              <input
                type="checkbox"
                checked={active.includes(tag)}
                onChange={(event) => { store.setFilterTags(event.target.checked ? [...active, tag] : active.filter(item => item !== tag)) }}
              />
              <span className="t-picker-title">{tag}</span>
              <span className="t-menu-shortcut">{count}</span>
            </label>
          ))}
          {active.length > 0 ? <button type="button" className="t-chip" onClick={() => { store.setFilterTags([]) }}>{t('tags.clear')}</button> : null}
        </div>
      ) : null}
    </div>
  )
}

interface Snapshot { id: string; name: string; at: number; auto: boolean; cards: number }

const whenLabel = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A timeline of a board's saved versions, with a preview and restore. */
export function HistoryPanel({ store, path, onClose, t }: { store: TesseraStore; path: string; onClose: () => void; t: T }): ReactNode {
  const [snapshots, setSnapshots] = useState<readonly Snapshot[] | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<CanvasDoc | undefined>(undefined)
  const refresh = useCallback(() => {
    api.fetch<{ snapshots: Snapshot[] }>('/history', { path }).then((result) => { setSnapshots(result.snapshots) }).catch((error: Error) => { store.notify(error.message) })
  }, [path, store])
  useEffect(refresh, [refresh])
  useEffect(() => {
    if (selected === undefined) { setPreview(undefined); return undefined }
    let alive = true
    api.fetch<CanvasDoc>('/history/read', { path, id: selected }).then((doc) => { if (alive) setPreview(doc) }).catch((error: Error) => { store.notify(error.message) })
    return () => { alive = false }
  }, [path, selected, store])
  return (
    <aside className="t-side" aria-label={t('history.title')} data-testid="history-panel" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <header>
        <h2>{t('history.title')}</h2>
        <button type="button" className="t-btn t-btn-icon" aria-label={t('dialog.close')} onClick={onClose}>✕</button>
      </header>
      <button
        type="button"
        className="t-btn t-btn-primary"
        onClick={() => {
          void store.ask({ title: t('history.save'), placeholder: t('history.name') }).then(async (name) => {
            if (name === null || name.trim() === '') return
            await store.settle()
            await api.request('/history/snapshot', { path, name: name.trim() })
            refresh()
          })
        }}
      >{t('history.save')}</button>
      {preview !== undefined ? (
        <div className="t-side-preview" data-testid="history-preview">
          <MiniBoard doc={preview} />
          <div className="t-side-actions">
            <span className="t-menu-shortcut">{preview.nodes.length} {t('history.cards')}</span>
            <button
              type="button"
              className="t-btn t-btn-primary"
              onClick={() => {
                if (selected === undefined) return
                void store.ask({ title: t('history.restore'), message: t('history.restoreHelp'), input: false, confirmLabel: t('history.restore') }).then(async (answer) => {
                  if (answer === null) return
                  await store.settle()
                  await api.request('/history/restore', { path, id: selected })
                  setSelected(undefined)
                  refresh()
                  store.notify(t('history.restored'))
                })
              }}
            >{t('history.restore')}</button>
          </div>
        </div>
      ) : null}
      <div className="t-side-list" role="listbox" aria-label={t('history.title')}>
        {snapshots?.length === 0 ? <div className="t-picker-empty">{t('history.none')}</div> : null}
        {snapshots?.map(snapshot => (
          <button key={snapshot.id} type="button" role="option" className="t-side-row" aria-selected={snapshot.id === selected} onClick={() => { setSelected(snapshot.id) }}>
            <span className="t-picker-title">{snapshot.auto ? t('history.auto') : snapshot.name}</span>
            <span className="t-menu-shortcut">{whenLabel(snapshot.at)}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}

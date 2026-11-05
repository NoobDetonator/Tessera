/** Views for the media and structured card kinds. Importing this module registers them. */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { contrastText, formatHsl, formatRgb, formatTodo, hexToRgb, normalizeHex, parseTodo, rgbToHsl, splitDocument, videoEmbed, type TodoItem } from '../shared/cardtext.ts'
import { boundsOf, type CanvasDoc } from '../shared/canvas.ts'
import { columnMembers } from '../shared/classify.ts'
import { visualRect } from '../shared/structure.ts'
import { api, fileUrl } from './bridge.ts'
import { copyPalette } from './bars.tsx'
import { cardTitle, registerCard, type CardViewProps } from './cards.tsx'
import { loadPreview } from './create.ts'

const MARKDOWN_LABELS = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

const stop = (event: React.SyntheticEvent): void => { event.stopPropagation() }

const ImageView = memo(function ImageView({ node, t }: CardViewProps) {
  const [broken, setBroken] = useState(false)
  const caption = node.tessera?.caption
  if (typeof node.file !== 'string' || broken) {
    return <div className="t-missing"><span>{t('card.missingFile')}</span><small>{node.file ?? ''}</small></div>
  }
  return (
    <figure className="t-image">
      <img src={fileUrl(node.file)} alt={caption ?? cardTitle(node)} draggable={false} loading="lazy" onError={() => { setBroken(true) }} />
      {typeof caption === 'string' && caption !== '' ? <figcaption>{caption}</figcaption> : null}
    </figure>
  )
})

const hostName = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const LinkView = memo(function LinkView({ node, store, t }: CardViewProps) {
  const url = typeof node.url === 'string' ? node.url : ''
  const preview = node.tessera?.preview
  const video = useMemo(() => videoEmbed(url), [url])
  const [playing, setPlaying] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const title = preview?.title ?? hostName(url)
  if (playing && video !== undefined) {
    return (
      <div className="t-link t-link-player" data-interactive="">
        <iframe
          src={video.embedUrl}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      </div>
    )
  }
  return (
    <div className="t-link">
      {preview?.image !== undefined && !imageFailed ? (
        <div className="t-link-image">
          <img src={preview.image} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" onError={() => { setImageFailed(true) }} />
          {video !== undefined ? <PlayButton label={t('link.play')} onPlay={() => { setPlaying(true) }} /> : null}
        </div>
      ) : video !== undefined ? <div className="t-link-image t-link-noimage"><PlayButton label={t('link.play')} onPlay={() => { setPlaying(true) }} /></div> : null}
      <div className="t-link-text">
        <a className="t-link-title" href={url} target="_blank" rel="noopener noreferrer" data-interactive="">{title}</a>
        {preview?.description !== undefined ? <p>{preview.description}</p> : null}
        <div className="t-link-foot">
          <span>{preview?.siteName ?? hostName(url)}</span>
          {preview === undefined ? (
            <button
              type="button"
              className="t-chip"
              data-interactive=""
              disabled={loading}
              onClick={() => {
                setLoading(true)
                void loadPreview(store, node.id, url).finally(() => { setLoading(false) })
              }}
            >{t('link.loadPreview')}</button>
          ) : null}
        </div>
      </div>
    </div>
  )
})

function PlayButton({ label, onPlay }: { label: string; onPlay: () => void }): ReactNode {
  return <button type="button" className="t-play" aria-label={label} title={label} data-interactive="" onClick={onPlay}>▶</button>
}

const EXT = (file: string): string => file.slice(file.lastIndexOf('.') + 1).toLowerCase()
const formatSize = (bytes: unknown): string | undefined => {
  if (typeof bytes !== 'number') return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

const FileView = memo(function FileView({ node, store, t }: CardViewProps) {
  if (typeof node.file !== 'string') return <div className="t-missing"><span>{t('card.missingFile')}</span></div>
  const path = node.file
  const ext = EXT(path)
  const name = node.tessera?.title ?? path.slice(path.lastIndexOf('/') + 1)
  const open = (): void => {
    api.openExternal(path).catch((error: Error) => { store.notify(error.message) })
  }
  const head = (
    <div className="t-file-head">
      <span className="t-file-badge">{ext.toUpperCase().slice(0, 4)}</span>
      <span className="t-file-name" title={String(name)}>{String(name)}</span>
      <button type="button" className="t-chip" data-interactive="" onClick={open}>{t('file.open')}</button>
    </div>
  )
  const src = fileUrl(path)
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac'].includes(ext)) {
    return <div className="t-file">{head}<audio controls preload="metadata" src={src} data-interactive="" /></div>
  }
  if (['mp4', 'webm', 'mov', 'ogv'].includes(ext)) {
    return <div className="t-file t-file-fill">{head}<video controls preload="metadata" src={src} data-interactive="" /></div>
  }
  if (ext === 'pdf') {
    return <div className="t-file t-file-fill">{head}<embed className="t-pdf" type="application/pdf" src={src} data-interactive="" data-scrollable="" /></div>
  }
  const size = formatSize(node.tessera?.size)
  return <div className="t-file">{head}{size !== undefined ? <div className="t-file-meta">{size}</div> : null}</div>
})

const TodoRow = memo(function TodoRow({ item, index, locked, t, update, remove, move, addAfter, focus, today, onDragStart, onDropAt }: {
  item: TodoItem; index: number; locked: boolean; t: CardViewProps['t']; today: string
  update: (index: number, patch: Partial<TodoItem>) => void
  remove: (index: number) => void
  move: (index: number, delta: number) => void
  addAfter: (index: number) => void
  focus: boolean
  onDragStart: (index: number) => void
  onDropAt: (index: number) => void
}) {
  const overdue = item.due !== undefined && !item.checked && item.due < today
  // The stored line drops trailing spaces, so a controlled value alone would eat every space as it is typed.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  return (
    <li
      className={`t-todo-row${item.checked ? ' t-done' : ''}`}
      onDragOver={(event) => { event.preventDefault() }}
      onDrop={(event) => { event.preventDefault(); onDropAt(index) }}
    >
      <span
        className="t-todo-grip"
        draggable={!locked}
        data-interactive=""
        aria-hidden="true"
        onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDragStart(index) }}
      >⠿</span>
      <input
        type="checkbox"
        checked={item.checked}
        disabled={locked}
        data-interactive=""
        aria-label={item.text}
        onChange={(event) => { update(index, { checked: event.target.checked }) }}
      />
      <input
        className="t-todo-text"
        type="text"
        value={draft ?? item.text}
        disabled={locked}
        placeholder={t('todo.placeholder')}
        autoFocus={focus}
        data-interactive=""
        onChange={(event) => { setDraft(event.target.value); update(index, { text: event.target.value }) }}
        onBlur={() => { setDraft(undefined) }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') { event.preventDefault(); addAfter(index) }
          if (event.key === 'Backspace' && item.text === '') { event.preventDefault(); remove(index) }
          if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); move(index, -1) }
          if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); move(index, 1) }
        }}
        onDoubleClick={stop}
      />
      <input
        className={`t-todo-due${overdue ? ' t-overdue' : ''}${item.due === undefined ? ' t-todo-nodue' : ''}`}
        type="date"
        value={item.due ?? ''}
        disabled={locked}
        data-interactive=""
        aria-label={t('todo.due')}
        title={t('todo.due')}
        onChange={(event) => {
          const value = event.target.value
          update(index, value === '' ? { due: undefined } : { due: value })
        }}
        onKeyDown={stop}
      />
    </li>
  )
})

const TodoView = memo(function TodoView({ node, store, t }: CardViewProps) {
  const items = useMemo(() => parseTodo(node.text ?? ''), [node.text])
  const locked = node.tessera?.locked === true
  const dragFrom = useRef<number | undefined>(undefined)
  const [focusIndex, setFocusIndex] = useState<number | undefined>(undefined)
  const today = new Date().toISOString().slice(0, 10)
  const editKey = useRef(`todo:${node.id}`)
  const commit = (next: readonly TodoItem[], typed = false): void => {
    store.patchNode(node.id, { text: formatTodo(next) }, typed ? { coalesce: editKey.current, label: 'Edit checklist' } : { label: 'Edit checklist' })
  }
  const update = (index: number, patch: Partial<TodoItem>): void => {
    commit(items.map((item, at) => {
      if (at !== index) return item
      const merged: TodoItem = { ...item, ...patch }
      if (patch.due === undefined && 'due' in patch) delete merged.due
      return merged
    }), patch.text !== undefined)
  }
  const remove = (index: number): void => {
    commit(items.filter((_, at) => at !== index))
    setFocusIndex(Math.max(0, index - 1))
  }
  const addAfter = (index: number): void => {
    commit([...items.slice(0, index + 1), { checked: false, text: '' }, ...items.slice(index + 1)])
    setFocusIndex(index + 1)
  }
  const reorder = (from: number, to: number): void => {
    if (to < 0 || to >= items.length || from === to) return
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved as TodoItem)
    commit(next)
    setFocusIndex(to)
  }
  const move = (index: number, delta: number): void => { reorder(index, index + delta) }
  const done = items.filter(item => item.checked).length
  return (
    <div className="t-todo">
      <div className="t-todo-progress" aria-label={t('todo.progress')}>
        <span>{done}/{items.length}</span>
        <div className="t-todo-bar"><div style={{ width: `${items.length === 0 ? 0 : (done / items.length) * 100}%` }} /></div>
      </div>
      <ul>
        {items.map((item, index) => (
          <TodoRow
            // eslint-disable-next-line react/no-array-index-key -- items have no identity in plain Markdown
            key={index}
            item={item}
            index={index}
            locked={locked}
            t={t}
            today={today}
            update={update}
            remove={remove}
            move={move}
            addAfter={addAfter}
            focus={focusIndex === index}
            onDragStart={(from) => { dragFrom.current = from }}
            onDropAt={(to) => { if (dragFrom.current !== undefined) reorder(dragFrom.current, to); dragFrom.current = undefined }}
          />
        ))}
      </ul>
      {locked ? null : <button type="button" className="t-todo-add" data-interactive="" onClick={() => { addAfter(items.length - 1) }}>＋ {t('todo.add')}</button>}
    </div>
  )
})

const ColorView = memo(function ColorView({ node, store, t }: CardViewProps) {
  const hex = normalizeHex(node.text ?? '') ?? '#000000'
  const rgb = hexToRgb(hex)
  const values = [hex, formatRgb(rgb), formatHsl(rgbToHsl(rgb))]
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const editKey = useRef(`color:${node.id}`)
  const picker = useRef<HTMLInputElement>(null)
  return (
    <div className="t-color">
      {/* The swatch is most of the card, so a click must select and drag it like any card. Double-click picks a color. */}
      <div
        className="t-swatch"
        style={{ background: hex, color: contrastText(hex) }}
        title={t('color.pick')}
        onDoubleClick={(event) => {
          event.stopPropagation()
          picker.current?.showPicker()
        }}
      >
        <input
          ref={picker}
          type="color"
          value={hex}
          disabled={node.tessera?.locked === true}
          aria-label={t('color.pick')}
          tabIndex={-1}
          onChange={(event) => { store.patchNode(node.id, { text: event.target.value }, { coalesce: editKey.current, label: 'Change color' }) }}
        />
      </div>
      <div className="t-color-values">
        {values.map(value => (
          <button
            key={value}
            type="button"
            data-interactive=""
            title={t('color.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(value)
                setTimeout(() => { setCopied(undefined) }, 1000)
              })
            }}
          >{copied === value ? t('color.copied') : value}</button>
        ))}
      </div>
    </div>
  )
})

const DocumentView = memo(function DocumentView({ node, shell, t }: CardViewProps) {
  const { title, body } = useMemo(() => splitDocument(node.text ?? ''), [node.text])
  // Plain text for the card: Markdown punctuation and table rules would only be noise at this size.
  const excerpt = body.replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, '').replace(/^#+\s+/gm, '').replace(/[*_`>#|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
  return (
    <div className="t-document">
      <div className="t-document-title">{title === '' ? t('document.untitled') : title}</div>
      {excerpt !== '' ? <div className="t-document-excerpt">{excerpt}</div> : null}
      <button type="button" className="t-chip" data-interactive="" onClick={() => { shell.openDocument(node.id) }}>{t('document.open')}</button>
    </div>
  )
})

/** A label that turns into an input while its card is in edit mode. */
function GroupLabel({ node, store, editing, placeholder }: { node: CardViewProps['node']; store: CardViewProps['store']; editing: boolean; placeholder: string }): ReactNode {
  const label = node.label ?? ''
  if (!editing) return <span className="t-group-label" title={label}>{label === '' ? placeholder : label}</span>
  return (
    <input
      className="t-group-input"
      type="text"
      defaultValue={label}
      placeholder={placeholder}
      aria-label={placeholder}
      autoFocus
      onFocus={(event) => { event.target.select() }}
      onPointerDown={stop}
      onDoubleClick={stop}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); if (event.key === 'Escape') event.currentTarget.value = label; event.currentTarget.blur() }
      }}
      onBlur={(event) => {
        const next = event.target.value.trim()
        if (next !== label) store.patchNode(node.id, { label: next }, { label: 'Rename' })
        store.setEditing(undefined)
      }}
    />
  )
}

const FrameView = memo(function FrameView({ node, store, editing, t }: CardViewProps) {
  return (
    <div className="t-frame" style={typeof node.background === 'string' ? { backgroundImage: `url("${fileUrl(node.background)}")` } : undefined}>
      <div className="t-frame-title"><GroupLabel node={node} store={store} editing={editing} placeholder={t('card.frame')} /></div>
    </div>
  )
})

const ColumnView = memo(function ColumnView({ node, store, editing, t }: CardViewProps) {
  const collapsed = node.tessera?.collapsed === true
  const items = Array.isArray(node.tessera?.items) ? node.tessera.items : undefined
  const count = items?.length ?? (store.state.doc !== undefined ? columnMembers(store.state.doc, node).length : 0)
  const hasColors = store.state.doc !== undefined && columnMembers(store.state.doc, node).some(member => normalizeHex(member.text ?? '') !== undefined)
  return (
    <div className="t-column">
      <div className="t-column-head">
        <button
          type="button"
          className="t-btn t-btn-icon"
          data-interactive=""
          aria-label={t(collapsed ? 'column.expand' : 'column.collapse')}
          aria-expanded={!collapsed}
          title={t(collapsed ? 'column.expand' : 'column.collapse')}
          onClick={() => { store.patchMeta(node.id, { collapsed: !collapsed }, { label: t(collapsed ? 'column.expand' : 'column.collapse') }) }}
        >{collapsed ? '▸' : '▾'}</button>
        <GroupLabel node={node} store={store} editing={editing} placeholder={t('card.column')} />
        <span className="t-column-count">{count}</span>
        {hasColors ? (
          <>
            <button type="button" className="t-chip" data-interactive="" title={t('palette.copy')} onClick={() => { copyPalette(store, node.id, 'css', t) }}>CSS</button>
            <button type="button" className="t-chip" data-interactive="" title={t('palette.copy')} onClick={() => { copyPalette(store, node.id, 'json', t) }}>JSON</button>
          </>
        ) : null}
      </div>
    </div>
  )
})

function MiniBoard({ doc }: { doc: CanvasDoc }): ReactNode {
  const rects = useMemo(() => doc.nodes.slice(0, 300).map(node => ({ id: node.id, group: node.type === 'group', color: node.color, ...visualRect(node) })), [doc])
  const box = boundsOf(rects)
  if (box === undefined) return <div className="t-board-empty" />
  const pad = Math.max(box.width, box.height) * 0.04
  return (
    <svg className="t-board-mini" viewBox={`${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {rects.map(rect => (
        <rect
          key={rect.id}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={Math.min(rect.width, rect.height) * 0.04}
          className={rect.group ? 't-mini-group' : 't-mini-card'}
        />
      ))}
    </svg>
  )
}

const BoardView = memo(function BoardView({ node, store, t }: CardViewProps) {
  const path = typeof node.file === 'string' ? node.file : undefined
  const [preview, setPreview] = useState<CanvasDoc | undefined>(undefined)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (path === undefined) return undefined
    let alive = true
    const load = (): void => {
      api.readBoard(path).then((state) => {
        if (alive) { setPreview(state.doc); setMissing(false) }
      }).catch(() => { if (alive) setMissing(true) })
    }
    load()
    // Live: follow the nested board's revisions, at most a few times a second.
    let timer: ReturnType<typeof setTimeout> | undefined
    const unwatch = store.watchBoard(path, () => {
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; load() }, 300)
    })
    return () => {
      alive = false
      unwatch()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [path, store])
  const title = path === undefined ? '' : path.slice(path.lastIndexOf('/') + 1).replace(/\.canvas$/i, '')
  return (
    <div className="t-board">
      <div className="t-board-preview">{missing ? <div className="t-missing"><span>{t('card.missingBoard')}</span></div> : preview !== undefined ? <MiniBoard doc={preview} /> : null}</div>
      <div className="t-board-foot">
        <span className="t-board-title" title={title}>{title}</span>
        {preview !== undefined ? <span className="t-column-count">{preview.nodes.length}</span> : null}
      </div>
    </div>
  )
})

registerCard({ kind: 'frame', label: 'card.frame', minWidth: 120, minHeight: 80, autoHeight: false, editable: true, view: FrameView })
registerCard({ kind: 'column', label: 'card.column', minWidth: 160, minHeight: 44, autoHeight: false, editable: true, widthOnly: true, view: ColumnView })
registerCard({ kind: 'board', label: 'card.board', minWidth: 160, minHeight: 120, autoHeight: false, view: BoardView })
registerCard({ kind: 'image', label: 'card.image', minWidth: 48, minHeight: 48, autoHeight: false, aspectLock: true, view: ImageView })
registerCard({ kind: 'link', label: 'card.link', minWidth: 200, minHeight: 96, autoHeight: false, view: LinkView })
registerCard({ kind: 'file', label: 'card.file', minWidth: 200, minHeight: 72, autoHeight: false, view: FileView })
registerCard({ kind: 'todo', label: 'card.todo', minWidth: 200, minHeight: 72, autoHeight: true, view: TodoView })
registerCard({ kind: 'color', label: 'card.color', minWidth: 112, minHeight: 112, autoHeight: false, view: ColorView })
registerCard({ kind: 'document', label: 'card.document', minWidth: 200, minHeight: 80, autoHeight: true, view: DocumentView })

export { MarkdownText, MARKDOWN_LABELS }

/** The Tessera panel: board sidebar, top bar, canvas and app-level shortcuts. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { newId, type CanvasEdge, type CanvasNode } from '../shared/canvas.ts'
import type { Change } from '../shared/change.ts'
import type { BoardInfo } from '../shared/protocol.ts'
import { CanvasView, type CanvasApi } from './CanvasView.tsx'
import type { CardShell } from './cards.tsx'
import { useTessera, type TesseraStore } from './store.ts'

export type T = (key: string) => string

interface MenuItem { label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
type MenuEntry = MenuItem | 'separator'

function Menu({ x, y, entries, onClose }: { x: number; y: number; entries: readonly MenuEntry[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: Event): void => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (event.type === 'pointerdown' && ref.current?.contains(event.target as Node) === true) return
      onClose()
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [onClose])
  const left = Math.min(x, window.innerWidth - 220)
  const top = Math.min(y, window.innerHeight - 24 - entries.length * 30)
  return (
    <div
      ref={ref}
      className="t-menu"
      role="menu"
      style={{ left, top: Math.max(8, top) }}
      onContextMenu={(event) => { event.preventDefault() }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items.at((index + (event.key === 'ArrowDown' ? 1 : -1)) % items.length)?.focus()
      }}
    >
      {entries.map((entry, index) => entry === 'separator'
        ? <div key={`sep${index}`} className="t-menu-sep" role="separator" />
        : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={`t-menu-item${entry.danger === true ? ' t-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => { onClose(); entry.onSelect() }}
          >
            <span>{entry.label}</span>
            {entry.shortcut !== undefined ? <span className="t-menu-shortcut">{entry.shortcut}</span> : null}
          </button>
        ))}
    </div>
  )
}

function Sidebar({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const boards = useTessera(store, state => state.boards)
  const favorites = useTessera(store, state => state.favorites)
  const path = useTessera(store, state => state.path)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; board: BoardInfo } | undefined>(undefined)

  const tree = useMemo(() => {
    const childPaths = new Set(boards.flatMap(board => board.children))
    const byPath = new Map(boards.map(board => [board.path, board]))
    const out: Array<{ board: BoardInfo; depth: number }> = []
    const walk = (board: BoardInfo, depth: number, seen: ReadonlySet<string>): void => {
      out.push({ board, depth })
      for (const child of board.children) {
        const next = byPath.get(child)
        // A board can contain itself through a cycle, so stop on any repeat along this branch.
        if (next !== undefined && !seen.has(child)) walk(next, depth + 1, new Set([...seen, child]))
      }
    }
    for (const board of boards) if (!childPaths.has(board.path)) walk(board, 0, new Set([board.path]))
    // Boards only reachable through a cycle would otherwise vanish.
    const listed = new Set(out.map(row => row.board.path))
    for (const board of boards) if (!listed.has(board.path)) out.push({ board, depth: 0 })
    return out
  }, [boards])

  const needle = query.trim().toLowerCase()
  const rows = needle === '' ? tree : boards.filter(board => board.title.toLowerCase().includes(needle)).map(board => ({ board, depth: 0 }))
  const favoriteRows = boards.filter(board => favorites.includes(board.path))

  const row = (board: BoardInfo, depth: number, key: string): ReactNode => (
    <div
      key={key}
      className="t-tree-row"
      role="treeitem"
      tabIndex={0}
      aria-selected={board.path === path}
      aria-current={board.path === path}
      style={{ '--t-depth': depth } as React.CSSProperties}
      onClick={() => { void store.open(board.path) }}
      onKeyDown={(event) => { if (event.key === 'Enter') void store.open(board.path) }}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, board }) }}
    >
      <span className="t-tree-name" title={board.title}>{board.title}</span>
      <span className="t-tree-count">{board.cards}</span>
      <button
        type="button"
        className="t-star"
        aria-label={t('sidebar.favorite')}
        aria-pressed={favorites.includes(board.path)}
        onClick={(event) => { event.stopPropagation(); void store.toggleFavorite(board.path) }}
      >★</button>
    </div>
  )

  const create = (): void => {
    const title = window.prompt(t('prompt.boardTitle'), '')
    if (title !== null && title.trim() !== '') void store.createBoard(title.trim())
  }

  return (
    <nav className="t-sidebar" aria-label={t('sidebar.boards')}>
      <div className="t-sidebar-head">
        <span>{t('panel.title')}</span>
        <button type="button" className="t-btn" aria-label={t('sidebar.new')} title={t('sidebar.new')} onClick={create}>＋</button>
      </div>
      <input className="t-search" type="search" placeholder={t('sidebar.search')} aria-label={t('sidebar.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <div className="t-tree" role="tree">
        {favoriteRows.length > 0 && needle === '' ? (
          <>
            <div className="t-tree-section">{t('sidebar.favorites')}</div>
            {favoriteRows.map(board => row(board, 0, `fav:${board.path}`))}
            <div className="t-tree-section">{t('sidebar.boards')}</div>
          </>
        ) : null}
        {rows.length === 0 ? <div className="t-tree-section">{t('sidebar.empty')}</div> : null}
        {rows.map(({ board, depth }) => row(board, depth, `${board.path}:${depth}`))}
      </div>
      {menu !== undefined ? (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => { setMenu(undefined) }}
          entries={[
            {
              label: t('menu.rename'),
              onSelect: () => {
                const title = window.prompt(t('prompt.boardTitle'), menu.board.title)
                if (title !== null && title.trim() !== '') void store.renameBoard(menu.board.path, title.trim())
              },
            },
            {
              label: t('menu.deleteBoard'),
              danger: true,
              onSelect: () => { if (window.confirm(t('confirm.deleteBoard'))) void store.deleteBoard(menu.board.path) },
            },
          ]}
        />
      ) : null}
    </nav>
  )
}

function SaveStatus({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const saveState = useTessera(store, state => state.saveState)
  const connected = useTessera(store, state => state.connected)
  if (!connected) return <span className="t-status t-status-error" role="status">{t('status.offline')}</span>
  if (saveState === 'error') return <span className="t-status t-status-error" role="status">{t('status.error')}</span>
  return <span className="t-status" role="status">{t(saveState === 'pending' ? 'status.saving' : 'status.saved')}</span>
}

interface ClipboardCards { nodes: CanvasNode[]; edges: CanvasEdge[] }

const CLIP_TYPE = 'application/x-tessera-cards'

export function App({ store, t }: { store: TesseraStore; t: T }): ReactNode {
  const available = useTessera(store, state => state.available)
  const path = useTessera(store, state => state.path)
  const doc = useTessera(store, state => state.doc)
  const loadError = useTessera(store, state => state.loadError)
  const canUndo = useTessera(store, state => state.canUndo)
  const canRedo = useTessera(store, state => state.canRedo)
  const warning = useTessera(store, state => state.warning)
  const notice = useTessera(store, state => state.notice)
  const breadcrumbs = useTessera(store, state => state.breadcrumbs)
  const boards = useTessera(store, state => state.boards)
  const canvas = useRef<CanvasApi | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | undefined>(undefined)
  const pointer = useRef({ x: 0, y: 0 })
  const memoryClip = useRef<ClipboardCards | undefined>(undefined)

  const shell = useMemo<CardShell>(() => ({
    openDocument: () => {},
    openLightbox: () => {},
    enterBoard: (target) => { void store.open(target, [...store.state.breadcrumbs, target]) },
    jumpToCard: (id) => {
      const node = store.node(id)
      if (node !== undefined) {
        canvas.current?.centerOn(node)
        store.select(new Set([id]))
      }
    },
  }), [store])

  const selectedCards = useCallback((): CanvasNode[] => {
    const { doc: current, selection } = store.state
    return current?.nodes.filter(node => selection.has(node.id)) ?? []
  }, [store])

  const clipOf = useCallback((): ClipboardCards | undefined => {
    const { doc: current } = store.state
    const nodes = selectedCards()
    if (current === undefined || nodes.length === 0) return undefined
    const ids = new Set(nodes.map(node => node.id))
    return { nodes, edges: current.edges.filter(edge => ids.has(edge.fromNode) && ids.has(edge.toNode)) }
  }, [store, selectedCards])

  const pasteCards = useCallback((clip: ClipboardCards, at?: { x: number; y: number }) => {
    const map = new Map(clip.nodes.map(node => [node.id, newId()]))
    const minX = Math.min(...clip.nodes.map(node => node.x)), minY = Math.min(...clip.nodes.map(node => node.y))
    const target = at ?? { x: minX + 32, y: minY + 32 }
    const change: Change = { nodes: {}, edges: {} }
    for (const node of clip.nodes) {
      const id = map.get(node.id) as string
      const items = node.tessera?.items
      const copy: CanvasNode = { ...node, id, x: node.x - minX + target.x, y: node.y - minY + target.y }
      if (Array.isArray(items) && copy.tessera !== undefined) copy.tessera = { ...copy.tessera, items: items.flatMap(item => map.get(item) ?? []) }
      ;(change.nodes as Record<string, CanvasNode>)[id] = copy
    }
    for (const edge of clip.edges) {
      const id = newId()
      ;(change.edges as Record<string, CanvasEdge>)[id] = { ...edge, id, fromNode: map.get(edge.fromNode) as string, toNode: map.get(edge.toNode) as string }
    }
    store.commit(change, { label: 'Paste' })
    store.select(new Set(map.values()))
  }, [store])

  const bringTo = useCallback((front: boolean) => {
    const { doc: current, selection } = store.state
    if (current === undefined || selection.size === 0) return
    const ids = current.nodes.map(node => node.id)
    const moving = ids.filter(id => selection.has(id))
    const rest = ids.filter(id => !selection.has(id))
    store.commit({ order: front ? [...rest, ...moving] : [...moving, ...rest] }, { label: 'Reorder' })
  }, [store])

  const toggleLock = useCallback(() => {
    const nodes = selectedCards()
    if (nodes.length === 0) return
    const lock = nodes.some(node => node.tessera?.locked !== true)
    store.commit({ nodes: Object.fromEntries(nodes.map(node => [node.id, { ...node, tessera: { ...node.tessera, locked: lock } }])) }, { label: lock ? 'Lock' : 'Unlock' })
  }, [store, selectedCards])

  useEffect(() => {
    const typing = (event: Event): boolean => (event.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]') != null
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event) || store.state.path === undefined) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') { event.preventDefault(); void (event.shiftKey ? store.redo() : store.undo()); return }
      if (mod && key === 'y') { event.preventDefault(); void store.redo(); return }
      if (mod && event.code === 'Digit0') { event.preventDefault(); canvas.current?.fitAll(); return }
      if (mod && key === 'a') { event.preventDefault(); store.select(new Set(store.state.doc?.nodes.map(node => node.id))); return }
      if (mod && key === 'd') {
        event.preventDefault()
        const clip = clipOf()
        if (clip !== undefined) pasteCards(clip)
        return
      }
      if (mod && key === 'l') { event.preventDefault(); toggleLock(); return }
      if (!mod && !event.altKey && key === 'z') {
        const view = canvas.current
        if (view === undefined || view === null) return
        event.preventDefault()
        view.zoomBy(event.shiftKey ? 1 / 1.25 : 1.25)
        return
      }
      if (key === 'delete' || key === 'backspace') {
        const { selection, selectedEdge } = store.state
        if (selectedEdge !== undefined) { event.preventDefault(); store.commit({ edges: { [selectedEdge]: null } }, { label: 'Delete connection' }); store.select(new Set()); return }
        if (selection.size > 0) { event.preventDefault(); store.deleteNodes(selection) }
        return
      }
      if (key === 'escape') {
        store.setEditing(undefined)
        store.select(new Set())
        return
      }
      if (key === 'enter' && store.state.selection.size === 1) {
        const id = [...store.state.selection][0] as string
        const node = store.node(id)
        if (node?.type === 'text' && node.tessera?.locked !== true) { event.preventDefault(); store.setEditing(id) }
        return
      }
      if (key.startsWith('arrow') && store.state.selection.size > 0) {
        event.preventDefault()
        const step = event.altKey ? 1 : 8
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
        const nodes = selectedCards().filter(node => node.tessera?.locked !== true)
        store.commit({ nodes: Object.fromEntries(nodes.map(node => [node.id, { ...node, x: node.x + dx, y: node.y + dy }])) }, { label: 'Move', coalesce: `nudge:${[...store.state.selection].join()}` })
      }
    }
    const onCopy = (event: ClipboardEvent): void => {
      if (typing(event) || store.state.path === undefined) return
      const clip = clipOf()
      if (clip === undefined) return
      memoryClip.current = clip
      event.clipboardData?.setData(CLIP_TYPE, JSON.stringify(clip))
      event.clipboardData?.setData('text/plain', clip.nodes.map(node => node.text ?? node.url ?? node.file ?? node.label ?? '').filter(Boolean).join('\n\n'))
      event.preventDefault()
      if (event.type === 'cut') store.deleteNodes(clip.nodes.map(node => node.id))
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (typing(event) || store.state.path === undefined) return
      const raw = event.clipboardData?.getData(CLIP_TYPE)
      if (raw !== undefined && raw !== '') {
        event.preventDefault()
        pasteCards(JSON.parse(raw) as ClipboardCards, canvas.current?.toWorld(pointer.current.x, pointer.current.y))
        return
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.trim() !== '') {
        event.preventDefault()
        const at = canvas.current?.toWorld(pointer.current.x, pointer.current.y) ?? { x: 0, y: 0 }
        const id = newId()
        store.commit({ nodes: { [id]: { id, type: 'text', text, x: Math.round(at.x), y: Math.round(at.y), width: 248, height: 64, tessera: { kind: 'note' } } } }, { label: 'Paste' })
        store.select(new Set([id]))
      }
    }
    const onMove = (event: PointerEvent): void => { pointer.current = { x: event.clientX, y: event.clientY } }
    window.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('pointermove', onMove)
    }
  }, [store, clipOf, pasteCards, selectedCards, toggleLock])

  const openMenu = useCallback((event: { x: number; y: number; world: { x: number; y: number }; target?: string; edge?: string }) => {
    const entries: MenuEntry[] = []
    if (event.edge !== undefined) {
      const edgeId = event.edge
      entries.push({ label: t('menu.delete'), danger: true, onSelect: () => { store.commit({ edges: { [edgeId]: null } }, { label: 'Delete connection' }) } })
    } else if (event.target !== undefined) {
      const locked = selectedCards().every(node => node.tessera?.locked === true)
      entries.push(
        { label: t('menu.duplicate'), shortcut: 'Ctrl+D', onSelect: () => { const clip = clipOf(); if (clip !== undefined) pasteCards(clip) } },
        { label: t(locked ? 'menu.unlock' : 'menu.lock'), shortcut: 'Ctrl+L', onSelect: toggleLock },
        'separator',
        { label: t('menu.front'), onSelect: () => { bringTo(true) } },
        { label: t('menu.back'), onSelect: () => { bringTo(false) } },
        'separator',
        { label: t('menu.delete'), shortcut: 'Del', danger: true, onSelect: () => { store.deleteNodes(store.state.selection) } },
      )
    } else {
      entries.push(
        {
          label: t('menu.newNote'),
          onSelect: () => {
            const id = newId()
            store.commit({ nodes: { [id]: { id, type: 'text', text: '', x: Math.round(event.world.x), y: Math.round(event.world.y), width: 248, height: 64, tessera: { kind: 'note' } } } }, { label: 'New note', coalesce: `new:${id}` })
            store.select(new Set([id]))
            store.setEditing(id)
          },
        },
        { label: t('menu.selectAll'), shortcut: 'Ctrl+A', onSelect: () => { store.select(new Set(store.state.doc?.nodes.map(node => node.id))) } },
        { label: t('menu.fit'), shortcut: 'Ctrl+0', onSelect: () => { canvas.current?.fitAll() } },
      )
    }
    setMenu({ x: event.x, y: event.y, entries })
  }, [store, t, clipOf, pasteCards, selectedCards, toggleLock, bringTo])

  const closeMenu = useCallback(() => { setMenu(undefined) }, [])

  if (!available) {
    return <div className="t-root"><div className="t-empty"><h2>{t('unavailable.title')}</h2><p>{t('unavailable.body')}</p></div></div>
  }

  const titleFor = (target: string): string => boards.find(board => board.path === target)?.title ?? target.replace(/\.canvas$/i, '')

  return (
    <div className="t-root" data-testid="tessera-root">
      <Sidebar store={store} t={t} />
      <main className="t-main">
        {path === undefined ? (
          <div className="t-empty">
            <h2>{t('empty.title')}</h2>
            <p>{t('empty.body')}</p>
            <button
              type="button"
              className="t-btn t-btn-primary"
              onClick={() => {
                const title = window.prompt(t('prompt.boardTitle'), '')
                if (title !== null && title.trim() !== '') void store.createBoard(title.trim())
              }}
            >{t('empty.create')}</button>
          </div>
        ) : (
          <>
            <header className="t-topbar">
              <nav className="t-crumbs" aria-label={t('sidebar.boards')}>
                {breadcrumbs.map((crumb, index) => (
                  <span key={`${crumb}${index}`} style={{ display: 'contents' }}>
                    {index > 0 ? <span className="t-crumb-sep">/</span> : null}
                    <button
                      type="button"
                      className="t-crumb"
                      aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                      onClick={() => { void store.open(crumb, breadcrumbs.slice(0, index + 1)) }}
                    >{titleFor(crumb)}</button>
                  </span>
                ))}
              </nav>
              <SaveStatus store={store} t={t} />
              <span className="t-sep" />
              <button type="button" className="t-btn" disabled={!canUndo} aria-label={t('top.undo')} title={`${t('top.undo')} (Ctrl+Z)`} onClick={() => { void store.undo() }}>↶</button>
              <button type="button" className="t-btn" disabled={!canRedo} aria-label={t('top.redo')} title={`${t('top.redo')} (Ctrl+Shift+Z)`} onClick={() => { void store.redo() }}>↷</button>
              <span className="t-sep" />
              <button type="button" className="t-btn" aria-label={t('top.zoomOut')} title={t('top.zoomOut')} onClick={() => { canvas.current?.zoomBy(1 / 1.25) }}>−</button>
              <button type="button" className="t-btn" aria-label={t('top.zoomIn')} title={t('top.zoomIn')} onClick={() => { canvas.current?.zoomBy(1.25) }}>＋</button>
              <button type="button" className="t-btn" title={`${t('top.fit')} (Ctrl+0)`} onClick={() => { canvas.current?.fitAll() }}>{t('top.fit')}</button>
            </header>
            {loadError !== undefined ? (
              <div className="t-empty"><h2>{t('load.failed')}</h2><p>{loadError}</p></div>
            ) : doc !== undefined ? (
              <CanvasView store={store} t={t} shell={shell} apiRef={canvas} onContextMenu={openMenu} />
            ) : <div className="t-empty" aria-busy="true" />}
          </>
        )}
        {warning !== undefined ? <div className="t-banner t-banner-warning" role="alert">{warning}</div> : null}
        {notice !== undefined ? <div className="t-banner" role="status">{notice}</div> : null}
      </main>
      {menu !== undefined ? <Menu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} /> : null}
    </div>
  )
}


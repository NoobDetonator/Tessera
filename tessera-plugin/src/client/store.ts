/**
 * The Client's view of Tessera. Lives outside React so agent edits arrive and
 * apply even while another main panel is showing. Local edits apply at once;
 * a per-board queue sends them in order, and the Host stays authoritative.
 */
import { useSyncExternalStore } from 'react'
import { newId, type CanvasDoc, type CanvasEdge, type CanvasNode } from '../shared/canvas.ts'
import { applyChange, deleteNodesChange, type Change } from '../shared/change.ts'
import type { BoardInfo, ServerEvent } from '../shared/protocol.ts'
import { api, bridgeAvailable, BridgeError, connectEvents } from './bridge.ts'

export interface ConfirmRequest {
  id: string
  path: string
  ids: string[]
  titles: string[]
}

export interface DialogRequest {
  title: string
  message?: string
  value?: string
  placeholder?: string
  /** False shows a confirmation with no text field. */
  input?: boolean
  inputType?: 'text' | 'url'
  confirmLabel?: string
  danger?: boolean
}

export interface TesseraState {
  available: boolean
  connected: boolean
  boards: readonly BoardInfo[]
  favorites: readonly string[]
  root: string
  path: string | undefined
  doc: CanvasDoc | undefined
  loadError: string | undefined
  canUndo: boolean
  canRedo: boolean
  selection: ReadonlySet<string>
  selectedEdge: string | undefined
  editing: string | undefined
  /** A persistent problem the user must see: a save failure or lost connection. */
  warning: string | undefined
  /** Short confirmation message, cleared automatically. */
  notice: string | undefined
  saveState: 'saved' | 'pending' | 'error'
  /** Navigation path from the root board down to the open board. */
  breadcrumbs: readonly string[]
  confirms: readonly ConfirmRequest[]
  filterTags: readonly string[]
  focusMode: boolean
  dialog: DialogRequest | undefined
}

const EMPTY: ReadonlySet<string> = new Set()

const initial = (): TesseraState => ({
  available: bridgeAvailable(),
  connected: false,
  boards: [],
  favorites: [],
  root: '',
  path: undefined,
  doc: undefined,
  loadError: undefined,
  canUndo: false,
  canRedo: false,
  selection: EMPTY,
  selectedEdge: undefined,
  editing: undefined,
  warning: undefined,
  notice: undefined,
  saveState: 'saved',
  breadcrumbs: [],
  confirms: [],
  filterTags: [],
  focusMode: false,
  dialog: undefined,
})

interface PendingApply {
  path: string
  change: Change
  label?: string | undefined
  coalesce?: string | undefined
  undoable?: boolean | undefined
}

export interface CommitOptions {
  label?: string
  /** Consecutive commits with one key are a single undo step. */
  coalesce?: string
  undoable?: boolean
}

const LAST_BOARD_KEY = 'tessera.lastBoard'

const readLocal = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null // storage can be blocked; the feature it backs is only a convenience
  }
}
const writeLocal = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch { /* see readLocal */ }
}

export class TesseraStore {
  state: TesseraState = initial()
  readonly clientId = newId()
  private readonly listeners = new Set<() => void>()
  private queue: PendingApply[] = []
  private sending = false
  private lastRev = 0
  private disconnect: (() => void) | undefined
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private measures = new Map<string, number>()
  private measureFrame: number | undefined
  private disposed = false
  private dialogDone: ((value: string | null) => void) | undefined
  private readonly boardWatchers = new Map<string, Set<() => void>>()
  /** Set by the shell when a Tessera event should pull the panel forward. */
  private wasConnected = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): TesseraState => this.state

  private set(patch: Partial<TesseraState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Start talking to the Host. Safe to call once per plugin activation. */
  start(): () => void {
    if (!this.state.available) return () => {}
    this.disconnect = connectEvents(event => { this.onEvent(event) }, (connected) => {
      if (connected && !this.wasConnected) void this.resync()
      this.wasConnected = connected
      this.set({ connected })
    })
    return () => {
      this.disposed = true
      this.disconnect?.()
      if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer)
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
      if (this.measureFrame !== undefined) cancelAnimationFrame(this.measureFrame)
    }
  }

  private async resync(): Promise<void> {
    await this.refreshBoards()
    const { path } = this.state
    if (path !== undefined) await this.reload(path)
    else {
      const last = readLocal(LAST_BOARD_KEY)
      if (last !== null && this.state.boards.some(board => board.path === last)) await this.open(last)
    }
  }

  private onEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        return
      case 'boards-changed':
        void this.refreshBoards()
        return
      case 'board-removed':
        if (event.path === this.state.path) this.set({ path: undefined, doc: undefined, selection: EMPTY, editing: undefined })
        return
      case 'saved':
        if (event.path === this.state.path && this.queue.length === 0) this.set({ saveState: 'saved', warning: undefined })
        return
      case 'save-error':
        this.set({ saveState: 'error', warning: event.message })
        return
      case 'external-invalid':
        this.notify(event.message)
        return
      case 'confirm':
        this.set({ confirms: [...this.state.confirms, { id: event.id, path: event.path, ids: event.ids, titles: event.titles }] })
        return
      case 'confirm-resolved':
        this.set({ confirms: this.state.confirms.filter(request => request.id !== event.id) })
        return
      case 'change':
        this.onChangeEvent(event)
        return
    }
  }

  /** Call back whenever another board changes, for live Board card previews. */
  watchBoard(path: string, callback: () => void): () => void {
    let set = this.boardWatchers.get(path)
    if (set === undefined) { set = new Set(); this.boardWatchers.set(path, set) }
    set.add(callback)
    return () => { set.delete(callback) }
  }

  private onChangeEvent(event: Extract<ServerEvent, { type: 'change' }>): void {
    for (const callback of this.boardWatchers.get(event.path) ?? []) callback()
    if (event.path !== this.state.path || this.state.doc === undefined) return
    const gap = event.rev !== this.lastRev + 1
    this.lastRev = event.rev
    if (gap) { void this.reload(event.path); return }
    const patch: Partial<TesseraState> = { canUndo: event.canUndo, canRedo: event.canRedo }
    if (event.clientId !== this.clientId) {
      patch.doc = applyChange(this.state.doc, event.change)
      if (event.change.nodes !== undefined && this.state.selection.size > 0) {
        const removed = Object.entries(event.change.nodes).filter(([, value]) => value === null).map(([id]) => id)
        if (removed.some(id => this.state.selection.has(id))) {
          patch.selection = new Set([...this.state.selection].filter(id => !removed.includes(id)))
        }
      }
    }
    this.set(patch)
  }

  async refreshBoards(): Promise<void> {
    try {
      const list = await api.listBoards()
      this.set({ boards: list.boards, favorites: list.favorites, root: list.root })
    } catch (error) {
      this.set({ warning: (error as Error).message })
    }
  }

  private async reload(path: string): Promise<void> {
    try {
      const state = await api.readBoard(path)
      if (this.state.path !== path) return
      let doc = state.doc
      // Edits not yet acknowledged still belong on top of the Host's document.
      for (const pending of this.queue) if (pending.path === path) doc = applyChange(doc, pending.change)
      this.lastRev = state.rev
      this.set({ doc, canUndo: state.canUndo, canRedo: state.canRedo, loadError: undefined })
    } catch (error) {
      if (this.state.path === path) this.set({ loadError: (error as Error).message })
    }
  }

  /**
   * Open a board.
   * @param trail - the new breadcrumb path; omitted keeps the board as a fresh root.
   */
  async open(path: string, trail?: readonly string[]): Promise<void> {
    if (this.state.path === path && this.state.doc !== undefined) {
      if (trail !== undefined) this.set({ breadcrumbs: trail })
      return
    }
    if (this.state.path !== undefined) await this.settle()
    this.set({ path, doc: undefined, loadError: undefined, selection: EMPTY, selectedEdge: undefined, editing: undefined, breadcrumbs: trail ?? this.trailTo(path), filterTags: [], focusMode: false })
    writeLocal(LAST_BOARD_KEY, path)
    await this.reload(path)
  }

  /** A path from a top-level board down to this one, following Board cards. */
  private trailTo(path: string): string[] {
    const parentOf = new Map<string, string>()
    for (const board of this.state.boards) for (const child of board.children) if (!parentOf.has(child) && child !== board.path) parentOf.set(child, board.path)
    const trail = [path]
    let current = parentOf.get(path)
    while (current !== undefined && !trail.includes(current)) {
      trail.unshift(current)
      current = parentOf.get(current)
    }
    return trail
  }

  /** Move cards onto another board. The Host applies it as one undo step. */
  async transfer(to: string, ids: readonly string[]): Promise<void> {
    const { path } = this.state
    if (path === undefined) return
    await this.settle()
    await api.request('/board/transfer', { from: path, to, ids })
    this.select(EMPTY)
  }

  /** Wait until queued edits have reached the Host. */
  async settle(): Promise<void> {
    while (this.sending) await new Promise(done => setTimeout(done, 16))
  }

  /** Apply locally now, then send. */
  commit(change: Change, options: CommitOptions = {}): void {
    const { path, doc } = this.state
    if (path === undefined || doc === undefined) return
    this.set({ doc: applyChange(doc, change), saveState: 'pending', canUndo: options.undoable === false ? this.state.canUndo : true, canRedo: options.undoable === false ? this.state.canRedo : false })
    this.queue.push({ path, change, label: options.label, coalesce: options.coalesce, undoable: options.undoable })
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.sending || this.disposed) return
    this.sending = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0] as PendingApply
        try {
          await api.apply({
            path: next.path, change: next.change, clientId: this.clientId,
            ...(next.label !== undefined ? { label: next.label } : {}),
            ...(next.coalesce !== undefined ? { coalesce: next.coalesce } : {}),
            ...(next.undoable !== undefined ? { undoable: next.undoable } : {}),
          })
          this.queue.shift()
          if (this.state.warning !== undefined && this.state.saveState !== 'error') this.set({ warning: undefined })
        } catch (error) {
          if (error instanceof BridgeError && error.status >= 400 && error.status < 500) {
            // The Host rejected this edit for good; retrying cannot help and would block the rest.
            this.queue.shift()
            this.set({ warning: error.message })
            void this.reload(next.path)
            continue
          }
          // Offline: keep every edit in memory, tell the user, and retry.
          this.set({ saveState: 'error', warning: (error as Error).message })
          this.retryTimer = setTimeout(() => { void this.drain() }, 2000)
          return
        }
      }
    } finally {
      this.sending = false
    }
  }

  async undo(): Promise<void> {
    const { path } = this.state
    if (path === undefined) return
    await this.settle()
    await api.undo(path)
  }

  async redo(): Promise<void> {
    const { path } = this.state
    if (path === undefined) return
    await this.settle()
    await api.redo(path)
  }

  /** Report a measured card height. Batched and kept out of undo history. */
  measure(id: string, height: number): void {
    this.measures.set(id, height)
    if (this.measureFrame !== undefined) return
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = undefined
      const { doc } = this.state
      if (doc === undefined) return
      const nodes: Record<string, CanvasNode> = {}
      const byId = new Map(doc.nodes.map(node => [node.id, node]))
      for (const [nodeId, value] of this.measures) {
        const node = byId.get(nodeId)
        if (node !== undefined && Math.abs(node.height - value) > 1) nodes[nodeId] = { ...node, height: value }
      }
      this.measures.clear()
      if (Object.keys(nodes).length > 0) this.commit({ nodes }, { undoable: false })
    })
  }

  node(id: string): CanvasNode | undefined {
    return this.state.doc?.nodes.find(node => node.id === id)
  }

  /** Merge fields into one node as an undoable edit. */
  patchNode(id: string, patch: Partial<CanvasNode>, options: CommitOptions = {}): void {
    const node = this.node(id)
    if (node !== undefined) this.commit({ nodes: { [id]: { ...node, ...patch } } }, options)
  }

  /** Merge fields into one node's Tessera metadata. */
  patchMeta(id: string, patch: Record<string, unknown>, options: CommitOptions = {}): void {
    const node = this.node(id)
    if (node !== undefined) this.commit({ nodes: { [id]: { ...node, tessera: { ...node.tessera, ...patch } } } }, options)
  }

  patchEdge(id: string, patch: Partial<CanvasEdge>, options: CommitOptions = {}): void {
    const edge = this.state.doc?.edges.find(item => item.id === id)
    if (edge !== undefined) this.commit({ edges: { [id]: { ...edge, ...patch } } }, options)
  }

  /** Delete nodes and their edges, skipping locked cards. */
  deleteNodes(ids: Iterable<string>): void {
    const { doc } = this.state
    if (doc === undefined) return
    const locked = new Set(doc.nodes.filter(node => node.tessera?.locked === true).map(node => node.id))
    const removable = [...ids].filter(id => !locked.has(id))
    if (removable.length === 0) return
    this.commit(deleteNodesChange(doc, removable), { label: 'Delete' })
    this.select(new Set([...this.state.selection].filter(id => !removable.includes(id))))
  }

  select(selection: ReadonlySet<string>, selectedEdge?: string): void {
    this.set({ selection, selectedEdge })
  }

  setEditing(editing: string | undefined): void {
    this.set({ editing })
  }

  setFilterTags(filterTags: readonly string[]): void {
    this.set({ filterTags })
  }

  setFocusMode(focusMode: boolean): void {
    this.set({ focusMode })
  }

  /** Show a short message that clears by itself. */
  notify(notice: string): void {
    this.set({ notice })
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => { this.set({ notice: undefined }) }, 4000)
  }

  /** Ask the user something in the panel's dialog. Resolves with the value, or null when dismissed. */
  ask(request: DialogRequest): Promise<string | null> {
    this.dialogDone?.(null)
    this.set({ dialog: request })
    return new Promise((done) => { this.dialogDone = done })
  }

  /** Called by the dialog when it closes. */
  answerDialog(value: string | null): void {
    const done = this.dialogDone
    this.dialogDone = undefined
    this.set({ dialog: undefined })
    done?.(value)
  }

  /** Create a board and open it. */
  async createBoard(title: string): Promise<string> {
    const { path } = await api.createBoard(title)
    await this.refreshBoards()
    await this.open(path)
    return path
  }

  async renameBoard(path: string, title: string): Promise<void> {
    const result = await api.renameBoard(path, title)
    await this.refreshBoards()
    if (this.state.path === path) {
      this.set({
        path: result.path,
        breadcrumbs: this.state.breadcrumbs.map(crumb => crumb === path ? result.path : crumb),
      })
      writeLocal(LAST_BOARD_KEY, result.path)
      await this.reload(result.path)
    }
  }

  async deleteBoard(path: string): Promise<void> {
    await api.deleteBoard(path)
    if (this.state.path === path) this.set({ path: undefined, doc: undefined, selection: EMPTY, editing: undefined, breadcrumbs: [] })
    await this.refreshBoards()
  }

  async toggleFavorite(path: string): Promise<void> {
    const { favorites } = this.state
    const next = favorites.includes(path) ? favorites.filter(item => item !== path) : [...favorites, path]
    this.set({ favorites: next })
    await api.setFavorites(next)
  }

  async answerConfirm(id: string, approved: boolean): Promise<void> {
    this.set({ confirms: this.state.confirms.filter(request => request.id !== id) })
    await api.answerConfirm(id, approved)
  }
}

/** Select from the store, re-rendering only when the selected value changes identity. */
export function useTessera<T>(store: TesseraStore, selector: (state: TesseraState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}

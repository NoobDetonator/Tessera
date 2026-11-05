/**
 * Authoritative board state on the Host. Holds each open board in memory,
 * writes it atomically after a short debounce, merges external disk edits,
 * and owns undo/redo so agent edits undo the same way as user edits, even when
 * no browser tab was open.
 */
import { EventEmitter } from 'node:events'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CanvasParseError, parseCanvas, serializeCanvas, type CanvasDoc } from '../shared/canvas.ts'
import { applyChange, composeChanges, diffDocs, invertChange, isEmptyChange, type Change } from '../shared/change.ts'
import { mergeDocs } from '../shared/merge.ts'

export type ChangeOrigin = 'user' | 'agent' | 'disk' | 'history'

export interface ApplyMeta {
  origin: ChangeOrigin
  clientId?: string | undefined
  label?: string | undefined
  /** Consecutive changes sharing this key collapse into one undo step. */
  coalesce?: string | undefined
  /** False for derived changes such as measured heights. */
  undoable?: boolean | undefined
}

export interface ChangeEvent {
  path: string
  rev: number
  change: Change
  origin: ChangeOrigin
  clientId?: string | undefined
  label?: string | undefined
}

interface UndoEntry {
  inverse: Change
  forward: Change
  label: string | undefined
  coalesce: string | undefined
}

interface OpenBoard {
  path: string
  doc: CanvasDoc
  /** The document the file on disk is known to hold. */
  base: CanvasDoc
  /** Exact text last read from or written to disk. */
  diskText: string
  rev: number
  dirty: boolean
  timer: NodeJS.Timeout | undefined
  /** Serializes writes and external merges per board. */
  queue: Promise<unknown>
  undo: UndoEntry[]
  redo: UndoEntry[]
}

export interface StoreEvents {
  change: [ChangeEvent]
  saved: [{ path: string; rev: number }]
  'save-error': [{ path: string; message: string }]
  'boards-changed': []
  'external-invalid': [{ path: string; message: string }]
  'board-removed': [{ path: string }]
}

export class TesseraError extends Error {
  override readonly name = 'TesseraError'
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Directories inside the root that never hold user boards. */
export const RESERVED_DIRS = new Set(['_assets', '_history', '_templates'])

/**
 * Normalize a client- or model-supplied board path.
 * @returns a forward-slash relative path ending in `.canvas`.
 * @throws TesseraError when the path could leave the root.
 */
export function normalizeBoardPath(input: unknown): string {
  const path = normalizeRelativePath(input)
  if (!path.toLowerCase().endsWith('.canvas')) throw new TesseraError('bad-path', `Not a board path: ${path}`)
  return path
}

/**
 * Normalize any path relative to the root.
 * @throws TesseraError when it is absolute, escapes the root, or holds control characters.
 */
export function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new TesseraError('bad-path', 'Path is required.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw new TesseraError('bad-path', 'Path has control characters.')
  const path = input.replaceAll('\\', '/').replace(/^\.\//, '')
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new TesseraError('bad-path', `Path must be relative: ${input}`)
  const segments = path.split('/')
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new TesseraError('bad-path', `Path escapes the board folder: ${input}`)
  }
  return path
}

/** Turn a title into a safe file stem, keeping letters from any script. */
export function slugify(title: string): string {
  const cleaned = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  const safe = cleaned.slice(0, 80)
  return safe === '' ? 'Untitled' : /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `${safe}-board` : safe
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, text, 'utf8')
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file)
        return
      } catch (error) {
        // Windows reports these while another process briefly holds the target open.
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        await new Promise(done => setTimeout(done, 40 * (attempt + 1)))
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => { /* the rename error is the one worth reporting */ })
    throw error
  }
}

export class BoardStore extends EventEmitter<StoreEvents> {
  private readonly boards = new Map<string, OpenBoard>()
  private readonly opening = new Map<string, Promise<OpenBoard>>()
  private watcher: FSWatcher | undefined
  private readonly watchTimers = new Map<string, NodeJS.Timeout>()
  private rootReal: string | undefined
  readonly root: string
  private readonly debounceMs: number

  constructor(root: string, debounceMs = 500) {
    super()
    this.root = root
    this.debounceMs = debounceMs
  }

  /** Create the root and start watching. Watch failure only disables live external reloads. */
  async start(onWarn: (message: string) => void = () => {}): Promise<void> {
    await mkdir(this.root, { recursive: true })
    this.rootReal = await realpath(this.root)
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (name !== null) this.onFsEvent(name.toString().replaceAll('\\', '/'))
      })
      this.watcher.on('error', error => { onWarn(`Board folder watcher stopped: ${error.message}`) })
    } catch (error) {
      onWarn(`Board folder watcher unavailable: ${(error as Error).message}`)
    }
  }

  /** Stop watching and write everything pending. */
  async stop(): Promise<void> {
    this.watcher?.close()
    this.watcher = undefined
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
    await this.flushAll()
  }

  /** Resolve a relative path to an absolute one, refusing anything a symlink carries out of the root. */
  async resolveInside(relativePath: string): Promise<string> {
    const absolute = resolve(this.root, relativePath)
    const rootReal = this.rootReal ?? await realpath(this.root)
    let probe = absolute
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const real = await realpath(probe)
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new TesseraError('bad-path', 'Path resolves outside the board folder.')
    }
    return absolute
  }

  private async open(path: string): Promise<OpenBoard> {
    const open = this.boards.get(path)
    if (open !== undefined) return open
    const pending = this.opening.get(path)
    if (pending !== undefined) return pending
    const task = (async () => {
      const file = await this.resolveInside(path)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TesseraError('not-found', `No board at ${path}`, 404)
        throw error
      }
      let doc: CanvasDoc
      try {
        doc = parseCanvas(text)
      } catch (error) {
        if (error instanceof CanvasParseError) throw new TesseraError('unreadable', `${path}: ${error.message}`, 422)
        throw error
      }
      const board: OpenBoard = {
        path, doc, base: doc, diskText: text, rev: 1, dirty: false, timer: undefined, queue: Promise.resolve(), undo: [], redo: [],
      }
      this.boards.set(path, board)
      return board
    })()
    this.opening.set(path, task)
    try {
      return await task
    } finally {
      this.opening.delete(path)
    }
  }

  /** Current document and revision. */
  async read(path: string): Promise<{ doc: CanvasDoc; rev: number; canUndo: boolean; canRedo: boolean }> {
    const board = await this.open(path)
    return { doc: board.doc, rev: board.rev, canUndo: board.undo.length > 0, canRedo: board.redo.length > 0 }
  }

  /** Whether a board exists on disk or in memory. */
  async exists(path: string): Promise<boolean> {
    if (this.boards.has(path)) return true
    return existsSync(await this.resolveInside(path))
  }

  /** Create a board file. Fails when it already exists. */
  async create(path: string, doc: CanvasDoc): Promise<void> {
    if (await this.exists(path)) throw new TesseraError('exists', `A board already exists at ${path}`, 409)
    const file = await this.resolveInside(path)
    await atomicWrite(file, serializeCanvas(doc))
    this.emit('boards-changed')
  }

  /** The first free board path for a title, in the same folder as `near`. */
  async freePath(title: string, near?: string): Promise<string> {
    const folder = near !== undefined && near.includes('/') ? near.slice(0, near.lastIndexOf('/') + 1) : ''
    const stem = slugify(title)
    for (let n = 1; ; n++) {
      const candidate = `${folder}${stem}${n === 1 ? '' : ` ${n}`}.canvas`
      if (!await this.exists(candidate)) return candidate
    }
  }

  /**
   * Apply a change and schedule the write.
   * @returns the new revision, or the current one when the change is empty.
   */
  async apply(path: string, change: Change, meta: ApplyMeta): Promise<number> {
    const board = await this.open(path)
    if (isEmptyChange(change)) return board.rev
    const inverse = invertChange(board.doc, change)
    board.doc = applyChange(board.doc, change)
    board.rev++
    if (meta.undoable !== false && meta.origin !== 'disk') {
      const top = board.undo.at(-1)
      if (meta.coalesce !== undefined && top?.coalesce === meta.coalesce) {
        top.inverse = composeChanges(inverse, top.inverse)
        top.forward = composeChanges(top.forward, change)
        top.label = meta.label ?? top.label
      } else {
        board.undo.push({ inverse, forward: change, label: meta.label, coalesce: meta.coalesce })
      }
      board.redo = []
    }
    this.emit('change', { path, rev: board.rev, change, origin: meta.origin, clientId: meta.clientId, label: meta.label })
    this.schedule(board)
    return board.rev
  }

  /** Stop further changes from joining the current undo step, so the next edit starts a new one. */
  sealUndo(path: string): void {
    const top = this.boards.get(path)?.undo.at(-1)
    if (top !== undefined) top.coalesce = undefined
  }

  /** Revert the latest undo step. */
  async undo(path: string): Promise<{ rev: number; label: string | undefined } | undefined> {
    const board = await this.open(path)
    const entry = board.undo.pop()
    if (entry === undefined) return undefined
    board.redo.push(entry)
    board.doc = applyChange(board.doc, entry.inverse)
    board.rev++
    this.emit('change', { path, rev: board.rev, change: entry.inverse, origin: 'history', label: entry.label })
    this.schedule(board)
    return { rev: board.rev, label: entry.label }
  }

  /** Reapply the latest undone step. */
  async redo(path: string): Promise<{ rev: number; label: string | undefined } | undefined> {
    const board = await this.open(path)
    const entry = board.redo.pop()
    if (entry === undefined) return undefined
    board.undo.push({ ...entry, coalesce: undefined })
    board.doc = applyChange(board.doc, entry.forward)
    board.rev++
    this.emit('change', { path, rev: board.rev, change: entry.forward, origin: 'history', label: entry.label })
    this.schedule(board)
    return { rev: board.rev, label: entry.label }
  }

  private schedule(board: OpenBoard): void {
    board.dirty = true
    if (board.timer !== undefined) clearTimeout(board.timer)
    board.timer = setTimeout(() => { void this.flush(board.path) }, this.debounceMs)
    board.timer.unref?.()
  }

  private enqueue<T>(board: OpenBoard, task: () => Promise<T>): Promise<T> {
    const next = board.queue.then(task, task)
    board.queue = next.catch(() => undefined)
    return next
  }

  /** Write a board now if it has unsaved changes. A failure keeps memory intact and reports it. */
  async flush(path: string): Promise<void> {
    const board = this.boards.get(path)
    if (board === undefined) return
    if (board.timer !== undefined) { clearTimeout(board.timer); board.timer = undefined }
    await this.enqueue(board, () => this.writeBoard(board))
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.boards.keys()].map(path => this.flush(path)))
  }

  private async writeBoard(board: OpenBoard): Promise<void> {
    if (!board.dirty) return
    try {
      const file = await this.resolveInside(board.path)
      await this.absorbDisk(board, file)
      const text = serializeCanvas(board.doc)
      const rev = board.rev
      const snapshot = board.doc
      await atomicWrite(file, text)
      board.diskText = text
      board.base = snapshot
      board.dirty = board.rev !== rev
      if (board.dirty) this.schedule(board)
      this.emit('saved', { path: board.path, rev })
    } catch (error) {
      this.emit('save-error', { path: board.path, message: (error as Error).message })
      // Keep the edit in memory and try again; a transient lock clears on its own.
      if (board.timer === undefined) {
        board.timer = setTimeout(() => { board.timer = undefined; void this.flush(board.path) }, Math.max(this.debounceMs, 2000))
        board.timer.unref?.()
      }
    }
  }

  /**
   * Fold any disk edit the watcher has not delivered yet into memory, so a
   * write can never overwrite it. An unparseable file is kept aside, not lost.
   */
  private async absorbDisk(board: OpenBoard, file: string): Promise<void> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (text === board.diskText) return
    let theirs: CanvasDoc
    try {
      theirs = parseCanvas(text)
    } catch (error) {
      if (!(error instanceof CanvasParseError)) throw error
      const aside = join(this.root, '_history', 'corrupt', `${Date.now()}-${board.path.replaceAll('/', '__')}`)
      await mkdir(dirname(aside), { recursive: true })
      await copyFile(file, aside)
      this.emit('external-invalid', { path: board.path, message: `${error.message} A copy was kept in ${relative(this.root, aside).replaceAll('\\', '/')}.` })
      board.diskText = text
      return
    }
    const merged = mergeDocs(board.base, board.doc, theirs)
    const change = diffDocs(board.doc, merged)
    board.base = theirs
    board.diskText = text
    if (!isEmptyChange(change)) {
      board.doc = merged
      board.rev++
      this.emit('change', { path: board.path, rev: board.rev, change, origin: 'disk' })
    }
  }

  private onFsEvent(name: string): void {
    if (!name.toLowerCase().endsWith('.canvas')) return
    const top = name.split('/')[0] ?? ''
    if (RESERVED_DIRS.has(top)) return
    const previous = this.watchTimers.get(name)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.watchTimers.delete(name)
      void this.onExternalChange(name)
    }, 120)
    timer.unref?.()
    this.watchTimers.set(name, timer)
  }

  private async onExternalChange(path: string): Promise<void> {
    this.emit('boards-changed')
    const board = this.boards.get(path)
    if (board === undefined) return
    await this.enqueue(board, async () => {
      const file = await this.resolveInside(path)
      if (!existsSync(file)) {
        if (board.dirty) return // the next write restores it with the unsaved edits
        this.boards.delete(path)
        this.emit('board-removed', { path })
        return
      }
      await this.absorbDisk(board, file)
    }).catch((error: Error) => { this.emit('save-error', { path, message: error.message }) })
  }

  /** Rename a board, keeping open state and undo history. */
  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new TesseraError('exists', `A board already exists at ${to}`, 409)
    await this.flush(from)
    const source = await this.resolveInside(from)
    const target = await this.resolveInside(to)
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    const board = this.boards.get(from)
    if (board !== undefined) {
      this.boards.delete(from)
      board.path = to
      this.boards.set(to, board)
    }
    this.emit('boards-changed')
  }

  /** Delete a board file. Its history folder is left in place on purpose. */
  async remove(path: string): Promise<void> {
    const board = this.boards.get(path)
    if (board?.timer !== undefined) clearTimeout(board.timer)
    this.boards.delete(path)
    await rm(await this.resolveInside(path), { force: true })
    this.emit('board-removed', { path })
    this.emit('boards-changed')
  }

  /** Every board file under the root, excluding reserved folders. */
  async listPaths(): Promise<string[]> {
    const out: string[] = []
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name)
        if (entry.isDirectory()) {
          if (folder === this.root && RESERVED_DIRS.has(entry.name)) continue
          if (entry.name.startsWith('.')) continue
          await walk(full)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.canvas')) {
          out.push(relative(this.root, full).replaceAll('\\', '/'))
        }
      }
    }
    await walk(this.root)
    return out.sort((a, b) => a.localeCompare(b))
  }

  /** Read any board's current state without keeping it open when it is not already. */
  async peek(path: string): Promise<CanvasDoc | undefined> {
    const open = this.boards.get(path)
    if (open !== undefined) return open.doc
    try {
      return parseCanvas(await readFile(await this.resolveInside(path), 'utf8'))
    } catch (error) {
      if (error instanceof CanvasParseError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Modification time, for cache keys. */
  async modified(path: string): Promise<number> {
    const info = await stat(await this.resolveInside(path))
    return info.mtimeMs
  }
}

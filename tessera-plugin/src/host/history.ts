/** Version history: named and automatic snapshots of a board, kept as plain files in `_history/`. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseCanvas, serializeCanvas, type CanvasDoc } from '../shared/canvas.ts'
import { diffDocs } from '../shared/change.ts'
import { slugify, TesseraError, type BoardStore } from './store.ts'

export interface SnapshotInfo {
  id: string
  name: string
  /** Epoch milliseconds. */
  at: number
  auto: boolean
  cards: number
}

/** Automatic snapshots kept per board. Named ones are never pruned. */
const AUTO_LIMIT = 50

const folderFor = (path: string): string => encodeURIComponent(path.replace(/\.canvas$/i, ''))

const SNAPSHOT_FILE = /^(\d{13})-(\d{3})--(auto|named)--(.*)\.canvas$/

function describe(file: string, cards: number): SnapshotInfo | undefined {
  const match = SNAPSHOT_FILE.exec(file)
  if (match === null) return undefined
  return { id: file, at: Number(match[1]), auto: match[3] === 'auto', name: decodeURIComponent(match[4] as string), cards }
}

export class HistoryStore {
  private readonly store: BoardStore
  private readonly root: string
  private counter = 0

  constructor(store: BoardStore, root: string) {
    this.store = store
    this.root = root
  }

  private folder(path: string): string {
    return join(this.root, '_history', folderFor(path))
  }

  /** Write a snapshot of the board's current state. */
  async snapshot(path: string, name: string, auto = false): Promise<SnapshotInfo> {
    const { doc } = await this.store.read(path)
    const at = Date.now()
    this.counter = (this.counter + 1) % 1000
    const file = `${at}-${String(this.counter).padStart(3, '0')}--${auto ? 'auto' : 'named'}--${encodeURIComponent(slugify(name)).slice(0, 120)}.canvas`
    const target = join(this.folder(path), file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, serializeCanvas(doc), 'utf8')
    if (auto) await this.prune(path)
    return { id: file, name: slugify(name), at, auto, cards: doc.nodes.length }
  }

  private async prune(path: string): Promise<void> {
    const entries = await readdir(this.folder(path)).catch(() => [] as string[])
    const autos = entries.filter(file => /--auto--/.test(file)).sort()
    for (const file of autos.slice(0, Math.max(0, autos.length - AUTO_LIMIT))) await rm(join(this.folder(path), file), { force: true })
  }

  /** Newest first. */
  async list(path: string): Promise<SnapshotInfo[]> {
    const entries = await readdir(this.folder(path)).catch(() => [] as string[])
    const out: SnapshotInfo[] = []
    for (const file of entries.sort().reverse()) {
      if (!SNAPSHOT_FILE.test(file)) continue
      const doc = await this.read(path, file).catch(() => undefined)
      const info = describe(file, doc?.nodes.length ?? 0)
      if (info !== undefined) out.push(info)
    }
    return out
  }

  /** Read one snapshot's document. */
  async read(path: string, id: string): Promise<CanvasDoc> {
    if (!SNAPSHOT_FILE.test(id)) throw new TesseraError('bad-snapshot', 'Unknown snapshot.')
    try {
      return parseCanvas(await readFile(join(this.folder(path), id), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TesseraError('not-found', 'Snapshot not found.', 404)
      throw error
    }
  }

  /** Restore a snapshot as one undoable change, saving the current state first so nothing is lost. */
  async restore(path: string, id: string): Promise<void> {
    const target = await this.read(path, id)
    await this.snapshot(path, 'Before restore', true)
    const { doc } = await this.store.read(path)
    await this.store.apply(path, diffDocs(doc, target), { origin: 'user', label: 'Restore version' })
  }
}

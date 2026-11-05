/** Builds new cards and places them on the open board. */
import { newId, type CanvasNode, type CardKind, type TesseraMeta } from '../shared/canvas.ts'
import { snapToGrid } from '../shared/geometry.ts'
import type { AssetResult } from '../shared/protocol.ts'
import { api } from './bridge.ts'
import type { TesseraStore } from './store.ts'

export interface Point { x: number; y: number }

const base = (kind: CardKind, type: string, at: Point, width: number, height: number, extra: Partial<CanvasNode> = {}, meta: TesseraMeta = {}): CanvasNode => ({
  id: newId(),
  type,
  x: snapToGrid(at.x),
  y: snapToGrid(at.y),
  width,
  height,
  ...extra,
  tessera: { kind, ...meta },
})

export const makeNote = (at: Point, text = ''): CanvasNode => base('note', 'text', at, 248, 64, { text })
export const makeDocument = (at: Point): CanvasNode => base('document', 'text', at, 280, 120, { text: '# Untitled\n\n' })
export const makeTodo = (at: Point): CanvasNode => base('todo', 'text', at, 280, 96, { text: '- [ ] ' })
export const makeColor = (at: Point, hex = '#7c5cff'): CanvasNode => base('color', 'text', at, 168, 168, { text: hex })
export const makeLink = (at: Point, url: string): CanvasNode => base('link', 'link', at, 320, 220, { url })

/** Natural pixel size of an image, or undefined when the browser cannot decode it here (SVG, for one). */
async function imageSize(file: Blob): Promise<{ width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return undefined
  }
}

const isImage = (file: { type: string; name: string }): boolean =>
  file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name)

function fileCard(asset: AssetResult, at: Point): CanvasNode {
  const audio = asset.mime.startsWith('audio/'), video = asset.mime.startsWith('video/'), pdf = asset.mime === 'application/pdf'
  const size = audio ? { width: 320, height: 104 } : video ? { width: 480, height: 320 } : pdf ? { width: 420, height: 560 } : { width: 280, height: 88 }
  return base('file', 'file', at, size.width, size.height, { file: asset.path }, { title: asset.name, size: asset.size })
}

/** Upload files and create one card for each, laid out left to right. Failures are reported per file. */
export async function addFiles(store: TesseraStore, files: readonly File[], at: Point): Promise<void> {
  let x = at.x
  const created: string[] = []
  for (const file of files) {
    try {
      const asset = await api.upload(file, file.name || 'pasted')
      let node: CanvasNode
      if (isImage(file)) {
        const natural = await imageSize(file)
        const scale = natural === undefined ? 1 : Math.min(1, 480 / natural.width, 480 / natural.height)
        const width = Math.max(48, Math.round((natural?.width ?? 320) * scale))
        const height = Math.max(48, Math.round((natural?.height ?? 240) * scale))
        node = base('image', 'file', { x, y: at.y }, width, height, { file: asset.path })
      } else {
        node = fileCard(asset, { x, y: at.y })
      }
      store.commit({ nodes: { [node.id]: node } }, { label: 'Add file' })
      created.push(node.id)
      x += node.width + 24
    } catch (error) {
      store.notify(`${file.name}: ${(error as Error).message}`)
    }
  }
  if (created.length > 0) store.select(new Set(created))
}

/** Create a Link card now and fill in its preview when it arrives. */
export function addLink(store: TesseraStore, url: string, at: Point): string {
  const node = makeLink(at, url)
  store.commit({ nodes: { [node.id]: node } }, { label: 'Add link' })
  store.select(new Set([node.id]))
  void loadPreview(store, node.id, url)
  return node.id
}

/** Fetch a Link card's preview. Stays out of undo, since it is derived from the URL. */
export async function loadPreview(store: TesseraStore, id: string, url: string): Promise<void> {
  try {
    const preview = await api.linkPreview(url)
    const current = store.node(id)
    if (current !== undefined && current.url === url) {
      store.commit({ nodes: { [id]: { ...current, tessera: { ...current.tessera, preview: { ...preview, fetchedAt: new Date().toISOString() } } } } }, { undoable: false })
    }
  } catch (error) {
    store.notify((error as Error).message)
  }
}

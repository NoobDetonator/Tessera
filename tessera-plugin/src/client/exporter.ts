/** Browser side of exports: inlines images, makes PNG and PDF, and saves files. */
import type { CanvasDoc } from '../shared/canvas.ts'
import { cardKind } from '../shared/classify.ts'
import { boardToMarkdown, boardToSvg } from '../shared/export.ts'
import { api, fileUrl } from './bridge.ts'
import type { TesseraStore } from './store.ts'

type T = (key: string) => string

/** Largest canvas edge most browsers can still encode reliably. */
const MAX_CANVAS_EDGE = 8192

function save(data: Blob, name: string): void {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.canvas$/i, '')

const toDataUrl = (blob: Blob): Promise<string> => new Promise((done, fail) => {
  const reader = new FileReader()
  reader.onload = () => { done(reader.result as string) }
  reader.onerror = () => { fail(reader.error ?? new Error('Could not read an image.')) }
  reader.readAsDataURL(blob)
})

/** Embed the board's images, so an exported picture stands alone. A missing file is drawn as a plain card. */
async function inlineImages(doc: CanvasDoc): Promise<Map<string, string>> {
  const images = new Map<string, string>()
  for (const node of doc.nodes) {
    const kind = cardKind(node, doc)
    if ((kind !== 'image' && kind !== 'sketch') || typeof node.file !== 'string' || images.has(node.file)) continue
    try {
      const response = await fetch(fileUrl(node.file))
      if (response.ok) images.set(node.file, await toDataUrl(await response.blob()))
    } catch { /* the card still appears, just without its picture */ }
  }
  return images
}

async function pictureOf(store: TesseraStore, t: T): Promise<{ svg: string; width: number; height: number; name: string }> {
  const { doc, path, selection } = store.state
  if (doc === undefined || path === undefined) throw new Error(t('export.empty'))
  const picture = boardToSvg(doc, { ids: selection, images: await inlineImages(doc) })
  if (picture === undefined) throw new Error(t('export.empty'))
  return { ...picture, name: baseName(path) }
}

function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const scale = Math.min(2, MAX_CANVAS_EDGE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  return new Promise<Blob>((done, fail) => {
    const image = new Image()
    image.onload = () => {
      const context = canvas.getContext('2d')
      if (context === null) { fail(new Error('This browser cannot draw the picture.')); return }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => { if (blob === null) fail(new Error('The picture is too large to export as PNG. Try SVG.')); else done(blob) }, 'image/png')
    }
    image.onerror = () => { fail(new Error('The picture could not be drawn. Try SVG.')) }
    image.src = url
  }).finally(() => { URL.revokeObjectURL(url) })
}

/** Save the board, or just the selected cards, as a PNG or SVG. */
export async function exportImage(store: TesseraStore, format: 'png' | 'svg', t: T): Promise<void> {
  const { svg, width, height, name } = await pictureOf(store, t)
  if (format === 'svg') { save(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`); return }
  save(await svgToPng(svg, width, height), `${name}.png`)
}

/** Save a Markdown outline in reading order, with nested boards as nested headings. */
export async function exportOutline(store: TesseraStore, t: T): Promise<void> {
  const { doc, path } = store.state
  if (doc === undefined || path === undefined) throw new Error(t('export.empty'))
  const load = async (target: string): Promise<CanvasDoc | undefined> => {
    try {
      return (await api.readBoard(target)).doc
    } catch {
      return undefined // the outline says the board is missing and carries on
    }
  }
  const markdown = await boardToMarkdown(baseName(path), doc, load, 1, new Set([path]))
  save(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${baseName(path)}.md`)
}

/** Print the board through the browser, which also offers Save as PDF. */
export async function exportPdf(store: TesseraStore, t: T): Promise<void> {
  const { svg } = await pictureOf(store, t)
  const holder = document.createElement('div')
  holder.className = 't-print'
  // The SVG is built from escaped text by boardToSvg, so this inserts no outside markup.
  holder.innerHTML = svg
  document.body.append(holder)
  const clean = (): void => {
    holder.remove()
    window.removeEventListener('afterprint', clean)
  }
  window.addEventListener('afterprint', clean)
  window.print()
}

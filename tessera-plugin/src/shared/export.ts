/** Exports: a self-contained SVG picture of a board, a Markdown outline in reading order, and slide order. */
import { boundsOf, type CanvasDoc, type CanvasNode, type Rect } from './canvas.ts'
import { cardKind, columnMembers, geometricChildren, groupDescendants } from './classify.ts'
import { normalizeHex } from './cardtext.ts'
import { routeEdge } from './geometry.ts'
import { cardTitle } from './search.ts'
import { visualRect } from './structure.ts'

const PRESETS: Record<string, string> = { 1: '#e5484d', 2: '#f76b15', 3: '#e2a336', 4: '#30a46c', 5: '#12a5b5', 6: '#8e4ec6' }
const paint = (color: string | undefined): string | undefined => (color === undefined ? undefined : PRESETS[color] ?? (normalizeHex(color) ?? undefined))

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** Markdown reduced to the plain lines a picture can show. */
function plainLines(text: string): string[] {
  return text.split(/\r?\n/)
    .map(line => line.replace(/^\s*#+\s+/, '').replace(/^\s*[-*+] \[[xX]\]\s*/, '☑ ').replace(/^\s*[-*+] \[ \]\s*/, '☐ ').replace(/^\s*[-*+]\s+/, '• ').replace(/\*\*|__|`/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/📅\s*/, ''))
    .filter(line => line.trim() !== '' && !/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line))
}

/** Break a line to a width, by rough character count. Good enough for an image; there is no text engine here. */
function wrap(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line]
  const out: string[] = []
  let current = ''
  for (const word of line.split(' ')) {
    if (word.length > maxChars) {
      if (current !== '') { out.push(current); current = '' }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars))
    } else if (`${current} ${word}`.trim().length > maxChars) {
      out.push(current)
      current = word
    } else current = `${current} ${word}`.trim()
  }
  if (current !== '') out.push(current)
  return out
}

function textBlock(node: Rect, lines: readonly string[], options: { size?: number; weight?: number; top?: number; color?: string } = {}): string {
  const size = options.size ?? 14
  const lineHeight = Math.round(size * 1.4)
  const top = options.top ?? 12
  const maxChars = Math.max(4, Math.floor((node.width - 24) / (size * 0.55)))
  const room = Math.max(0, Math.floor((node.height - top - 8) / lineHeight))
  const wrapped = lines.flatMap(line => wrap(line, maxChars))
  const visible = wrapped.slice(0, room)
  if (wrapped.length > room && visible.length > 0) visible[visible.length - 1] = `${(visible.at(-1) as string).slice(0, Math.max(0, maxChars - 1))}…`
  const spans = visible.map((line, index) => `<tspan x="${node.x + 12}" y="${node.y + top + size + index * lineHeight}">${escapeXml(line)}</tspan>`)
  return `<text font-family="system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif" font-size="${size}" fill="${options.color ?? '#1c1c1e'}"${options.weight !== undefined ? ` font-weight="${options.weight}"` : ''}>${spans.join('')}</text>`
}

function cardSvg(node: CanvasNode, doc: CanvasDoc, images: ReadonlyMap<string, string>): string {
  const kind = cardKind(node, doc)
  const rect = visualRect(node)
  const { x, y, width, height } = rect
  const color = paint(node.color)
  const rx = 8
  if (kind === 'frame') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${color ?? '#000000'}" fill-opacity="0.05" stroke="#000000" stroke-opacity="0.15"/>${textBlock(rect, [node.label ?? ''], { size: 14, weight: 600, top: 4, color: '#555555' })}`
  }
  if (kind === 'column') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${color ?? '#000000'}" fill-opacity="0.05" stroke="#000000" stroke-opacity="0.1"/>${textBlock(rect, [node.label ?? 'Column'], { size: 14, weight: 600 })}`
  }
  const full = color !== undefined && node.tessera?.colorStyle === 'full'
  let out = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${full ? color : '#ffffff'}"${full ? ' fill-opacity="0.22"' : ''} stroke="#000000" stroke-opacity="0.14"/>`
  if (color !== undefined && !full) out += `<rect x="${x}" y="${y}" width="${width}" height="4" fill="${color}"/>`
  const file = typeof node.file === 'string' ? images.get(node.file) : undefined
  if (kind === 'color') {
    const hex = normalizeHex(node.text ?? '') ?? '#000000'
    const swatch = Math.max(0, height - 28)
    return `${out}<rect x="${x}" y="${y}" width="${width}" height="${swatch}" rx="${rx}" fill="${hex}"/>${textBlock({ x, y: y + swatch, width, height: 28 }, [hex], { size: 11, top: 2, color: '#555555' })}`
  }
  if (file !== undefined && (kind === 'image' || kind === 'sketch')) {
    return `${out}<image href="${escapeXml(file)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`
  }
  if (kind === 'link') {
    const preview = node.tessera?.preview
    return out + textBlock(rect, [preview?.title ?? node.url ?? '', ...(preview?.description !== undefined ? [preview.description] : []), ...(typeof node.url === 'string' ? [node.url] : [])], { size: 13 })
  }
  if (kind === 'board' || kind === 'file' || kind === 'image' || kind === 'sketch') {
    return out + textBlock(rect, [`${kind === 'board' ? '▦' : '📎'} ${cardTitle(node)}`], { size: 13, weight: 600 })
  }
  if (typeof node.text === 'string') return out + textBlock(rect, plainLines(node.text))
  return out
}

/**
 * A self-contained SVG picture of a board, or of the given cards and what they hold.
 * @param images - file path to data URL, so the picture carries its images with it.
 * @returns the SVG text and its size, or undefined when there is nothing to draw.
 */
export function boardToSvg(doc: CanvasDoc, options: { ids?: ReadonlySet<string> | undefined; images?: ReadonlyMap<string, string> | undefined; padding?: number } = {}): { svg: string; width: number; height: number } | undefined {
  const images = options.images ?? new Map<string, string>()
  const padding = options.padding ?? 40
  let included: ReadonlySet<string> | undefined
  if (options.ids !== undefined && options.ids.size > 0) {
    const all = new Set(options.ids)
    for (const node of doc.nodes) if (options.ids.has(node.id) && node.type === 'group') for (const child of groupDescendants(doc, node)) all.add(child.id)
    included = all
  }
  const hidden = new Set<string>()
  for (const node of doc.nodes) if (node.type === 'group' && node.tessera?.collapsed === true) for (const member of columnMembers(doc, node)) hidden.add(member.id)
  const nodes = doc.nodes.filter(node => (included === undefined || included.has(node.id)) && !hidden.has(node.id))
  const box = boundsOf(nodes.map(visualRect))
  if (box === undefined) return undefined
  const width = Math.ceil(box.width + padding * 2), height = Math.ceil(box.height + padding * 2)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = doc.edges.flatMap((edge) => {
    const from = byId.get(edge.fromNode), to = byId.get(edge.toNode)
    if (from === undefined || to === undefined) return []
    const route = routeEdge(edge, visualRect(from), visualRect(to))
    const color = paint(edge.color) ?? '#8a8a8e'
    const arrow = (point: { x: number; y: number }, angle: number): string => {
      const a = angle + Math.PI * 0.85, b = angle - Math.PI * 0.85
      return `<path d="M${point.x} ${point.y}L${point.x + Math.cos(a) * 9} ${point.y + Math.sin(a) * 9}L${point.x + Math.cos(b) * 9} ${point.y + Math.sin(b) * 9}Z" fill="${color}"/>`
    }
    const label = typeof edge.label === 'string' && edge.label !== ''
      ? `<text x="${route.mid.x}" y="${route.mid.y}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="11" fill="#555555" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(edge.label)}</text>`
      : ''
    return [`<path d="${route.d}" fill="none" stroke="${color}" stroke-width="1.5"${edge.tessera?.dashed === true ? ' stroke-dasharray="6 6"' : ''}/>${edge.toEnd !== 'none' ? arrow(route.end, route.endAngle) : ''}${edge.fromEnd === 'arrow' ? arrow(route.start, route.startAngle) : ''}${label}`]
  })
  const body = nodes.map(node => cardSvg(node, doc, images)).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x - padding} ${box.y - padding} ${width} ${height}" width="${width}" height="${height}"><rect x="${box.x - padding}" y="${box.y - padding}" width="${width}" height="${height}" fill="#ffffff"/>${edges.join('')}${body}</svg>\n`
  return { svg, width, height }
}

/** Sort into reading order: rows from the top, left to right inside a row. */
function readingOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: CanvasNode[][] = []
  for (const node of sorted) {
    const row = rows.at(-1)
    const anchor = row?.[0]
    // Cards share a row when they overlap vertically with its first card by half their height.
    if (row !== undefined && anchor !== undefined && node.y < anchor.y + anchor.height / 2) row.push(node)
    else rows.push([node])
  }
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x))
}

/** The Markdown for one card, or nothing for a card with no words. */
function cardMarkdown(node: CanvasNode, kind: string): string {
  if (kind === 'link') {
    const title = node.tessera?.preview?.title ?? node.url
    return `- [${title}](${node.url})${typeof node.tessera?.preview?.description === 'string' ? `: ${node.tessera.preview.description}` : ''}`
  }
  if (kind === 'image' || kind === 'sketch') return `![${node.tessera?.caption ?? cardTitle(node)}](${node.file})`
  if (kind === 'file') return `- [${cardTitle(node)}](${node.file})`
  return typeof node.text === 'string' ? node.text.trim() : ''
}

/**
 * A Markdown outline of a board in reading order. Frames and columns become
 * headings, and nested boards become nested headings.
 * @param load - fetches a nested board; undefined means it is missing.
 */
export async function boardToMarkdown(
  title: string,
  doc: CanvasDoc,
  load: (path: string) => Promise<CanvasDoc | undefined>,
  level = 1,
  seen: ReadonlySet<string> = new Set(),
): Promise<string> {
  const heading = (text: string, depth: number): string => `${'#'.repeat(Math.min(6, depth))} ${text}`
  const parts: string[] = [heading(title, level)]
  const groups = doc.nodes.filter(node => node.type === 'group')
  const owned = new Set<string>()
  for (const group of groups) for (const child of (cardKind(group, doc) === 'column' ? columnMembers(doc, group) : geometricChildren(doc, group))) owned.add(child.id)
  const renderNode = async (node: CanvasNode, depth: number): Promise<void> => {
    const kind = cardKind(node, doc)
    if (kind === 'frame' || kind === 'column') {
      parts.push(heading(node.label !== undefined && node.label !== '' ? node.label : kind === 'frame' ? 'Frame' : 'Column', depth))
      const children = kind === 'column' ? columnMembers(doc, node) : readingOrder(geometricChildren(doc, node))
      for (const child of children) await renderNode(child, depth + 1)
      return
    }
    if (kind === 'board' && typeof node.file === 'string') {
      const name = cardTitle(node)
      if (seen.has(node.file)) { parts.push(heading(`${name} (already shown above)`, depth)); return }
      const nested = await load(node.file)
      parts.push(nested === undefined ? heading(`${name} (board not found)`, depth) : (await boardToMarkdown(name, nested, load, depth, new Set([...seen, node.file]))).trimEnd())
      return
    }
    const markdown = cardMarkdown(node, kind)
    if (markdown !== '') parts.push(markdown)
  }
  for (const node of readingOrder(doc.nodes.filter(item => !owned.has(item.id)))) await renderNode(node, level + 1)
  return `${parts.join('\n\n')}\n`
}

/** Frames in presentation order: an explicit slide number first, then reading order. */
export function presentationOrder(doc: CanvasDoc): CanvasNode[] {
  const frames = doc.nodes.filter(node => cardKind(node, doc) === 'frame')
  const reading = readingOrder(frames)
  const rank = (node: CanvasNode): number => (typeof node.tessera?.slide === 'number' ? node.tessera.slide : Number.MAX_SAFE_INTEGER)
  return reading.map((node, index) => ({ node, index })).sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index).map(({ node }) => node)
}

/** A card plus everything joined to it by an edge. */
export function focusSet(doc: CanvasDoc, ids: ReadonlySet<string>): Set<string> {
  const keep = new Set(ids)
  for (const edge of doc.edges) {
    if (ids.has(edge.fromNode)) keep.add(edge.toNode)
    if (ids.has(edge.toNode)) keep.add(edge.fromNode)
  }
  for (const node of doc.nodes) if (ids.has(node.id) && node.type === 'group') for (const child of groupDescendants(doc, node)) keep.add(child.id)
  return keep
}

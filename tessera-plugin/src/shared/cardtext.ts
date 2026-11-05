/** Plain-text formats behind To-do, Color and Document cards. The text stays readable in any Markdown tool. */

export interface TodoItem {
  checked: boolean
  text: string
  /** ISO date `YYYY-MM-DD`, stored in the text with the Obsidian Tasks marker so it survives metadata loss. */
  due?: string
}

const ITEM = /^\s*[-*+] \[([ xX])\](?:\s+(.*))?$/
const DUE = /\s*📅\s*(\d{4}-\d{2}-\d{2})\s*$/

/** Parse checkbox lines. Other lines are ignored here and kept out of the checklist view. */
export function parseTodo(text: string): TodoItem[] {
  return text.split(/\r?\n/).flatMap((line): TodoItem[] => {
    const match = ITEM.exec(line)
    if (match === null) return []
    const raw = match[2] ?? ''
    const due = DUE.exec(raw)?.[1]
    return [{ checked: match[1] !== ' ', text: raw.replace(DUE, ''), ...(due !== undefined ? { due } : {}) }]
  })
}

/** Write items back as Markdown checkboxes. */
export function formatTodo(items: readonly TodoItem[]): string {
  return items.map(item => `- [${item.checked ? 'x' : ' '}] ${item.text}${item.due !== undefined ? ` 📅 ${item.due}` : ''}`.trimEnd()).join('\n')
}

export interface Rgb { r: number; g: number; b: number }
export interface Hsl { h: number; s: number; l: number }

/** Normalize `#abc` or `#aabbcc[dd]` to lowercase `#aabbcc`, or undefined when it is not a color. */
export function normalizeHex(value: string): string | undefined {
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)
  return long === null ? undefined : `#${long[1]}`
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0))
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: Math.round(h * 60) % 360, s: Math.round(s * 100), l: Math.round(l * 100) }
}

export const formatRgb = ({ r, g, b }: Rgb): string => `rgb(${r}, ${g}, ${b})`
export const formatHsl = ({ h, s, l }: Hsl): string => `hsl(${h}, ${s}%, ${l}%)`

/** Black or white, whichever reads better on the color. */
export function contrastText(hex: string): '#000000' | '#ffffff' {
  const { r, g, b } = hexToRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#000000' : '#ffffff'
}

export interface PaletteEntry { name: string; hex: string }

/** Export swatches as CSS custom properties. */
export function paletteToCss(entries: readonly PaletteEntry[]): string {
  const lines = entries.map((entry, index) => {
    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `color-${index + 1}`
    return `  --${slug}: ${entry.hex};`
  })
  return `:root {\n${lines.join('\n')}\n}\n`
}

/** Export swatches as JSON. */
export const paletteToJson = (entries: readonly PaletteEntry[]): string =>
  `${JSON.stringify(entries.map(entry => ({ name: entry.name, hex: entry.hex, rgb: hexToRgb(entry.hex), hsl: rgbToHsl(hexToRgb(entry.hex)) })), null, 2)}\n`

/** A Document's title is its first heading, so it stays visible when the file is read elsewhere. */
export function splitDocument(text: string): { title: string; body: string } {
  const match = /^\s*#\s+(.*)(?:\r?\n|$)/.exec(text)
  if (match === null) return { title: '', body: text }
  return { title: (match[1] as string).trim(), body: text.slice(match[0].length).replace(/^(\r?\n)+/, '') }
}

export function joinDocument(title: string, body: string): string {
  const heading = title.trim()
  return heading === '' ? body : `# ${heading}\n\n${body}`
}

export interface VideoEmbed { provider: 'youtube' | 'vimeo'; id: string; embedUrl: string }

/** Recognize a URL a Link card can play inline. Privacy-preserving player hosts only. */
export function videoEmbed(url: string): VideoEmbed | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const host = parsed.hostname.replace(/^www\.|^m\./, '')
  let youtube: string | null | undefined
  if (host === 'youtu.be') youtube = parsed.pathname.slice(1)
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    youtube = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : /^\/(?:embed|shorts|live)\/([^/?]+)/.exec(parsed.pathname)?.[1]
  }
  if (typeof youtube === 'string' && /^[\w-]{6,20}$/.test(youtube)) {
    return { provider: 'youtube', id: youtube, embedUrl: `https://www.youtube-nocookie.com/embed/${youtube}?autoplay=1` }
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /(?:^|\/)(\d{6,12})(?:$|[/?])/.exec(parsed.pathname)?.[1]
    if (id !== undefined) return { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1` }
  }
  return undefined
}

/** True when a string is a single http(s) URL, used to turn pasted text into a Link card. */
export function isSingleUrl(text: string): boolean {
  const value = text.trim()
  if (/\s/.test(value)) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

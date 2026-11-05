/**
 * Open Graph previews for Link cards. The page itself comes through
 * `ctx.web.fetch`; this module only decides whether a URL may be fetched and
 * reads the result.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { LinkPreviewResult } from '../shared/protocol.ts'
import { TesseraError } from './store.ts'

const blocked = new BlockList()
blocked.addSubnet('0.0.0.0', 8, 'ipv4')
blocked.addSubnet('10.0.0.0', 8, 'ipv4')
blocked.addSubnet('100.64.0.0', 10, 'ipv4')
blocked.addSubnet('127.0.0.0', 8, 'ipv4')
blocked.addSubnet('169.254.0.0', 16, 'ipv4')
blocked.addSubnet('172.16.0.0', 12, 'ipv4')
blocked.addSubnet('192.168.0.0', 16, 'ipv4')
blocked.addSubnet('224.0.0.0', 4, 'ipv4')
blocked.addSubnet('::', 128, 'ipv6')
blocked.addSubnet('::1', 128, 'ipv6')
blocked.addSubnet('fc00::', 7, 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')

/** Whether an IP literal belongs to this machine or a private network. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped !== null) return blocked.check(mapped[1] as string, 'ipv4')
  return blocked.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Refuse URLs that reach this machine or its network. A board can be edited by
 * the agent, and a preview must not turn that into a way to read local services.
 * @param resolve - injected for tests.
 * @throws TesseraError when the URL is not public http(s).
 */
export async function assertPublicUrl(
  url: string,
  resolve: (host: string) => Promise<Array<{ address: string }>> = host => lookup(host, { all: true }),
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TesseraError('bad-url', 'Not a valid URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TesseraError('bad-url', 'Only http and https links have previews.')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new TesseraError('private-url', 'Local addresses have no preview.')
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new TesseraError('private-url', 'Local addresses have no preview.')
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await resolve(host)
  } catch {
    throw new TesseraError('unreachable', `Could not resolve ${host}.`)
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new TesseraError('private-url', 'Local addresses have no preview.')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const point = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all
    }
    return ENTITIES[code.toLowerCase()] ?? all
  })
}

const clip = (text: string | undefined, max: number): string | undefined => {
  if (text === undefined) return undefined
  const value = decodeEntities(text).replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value.slice(0, max)
}

/**
 * Read Open Graph and basic metadata out of an HTML page.
 * @param baseUrl - resolves a relative preview image.
 */
export function parseOpenGraph(html: string, baseUrl: string): LinkPreviewResult {
  const head = html.slice(0, 256 * 1024)
  const meta = new Map<string, string>()
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attribute = (name: string): string | undefined => {
      const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
      return found === null ? undefined : found[2] ?? found[3] ?? found[4]
    }
    const key = (attribute('property') ?? attribute('name'))?.toLowerCase()
    const content = attribute('content')
    if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content)
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const title = clip(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 200)
  const description = clip(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 400)
  const siteName = clip(meta.get('og:site_name'), 100)
  let image: string | undefined
  const rawImage = clip(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), 2000)
  if (rawImage !== undefined) {
    try {
      const resolved = new URL(rawImage, baseUrl)
      if (resolved.protocol === 'https:' || resolved.protocol === 'http:') image = resolved.href
    } catch { /* a malformed image URL only means no preview image */ }
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(siteName !== undefined ? { siteName } : {}),
    ...(image !== undefined ? { image } : {}),
  }
}

/** The part of `ctx.web` this module needs. */
export interface WebFetcher {
  fetch(request: { url: string }): Promise<{ url: string; statusCode: number; body: { kind: string; content?: string } }>
}

/** Fetch and parse one preview. A page with no metadata gives an empty result, not an error. */
export async function fetchPreview(web: WebFetcher, url: string): Promise<LinkPreviewResult> {
  await assertPublicUrl(url)
  const result = await web.fetch({ url })
  if (result.body.kind !== 'html' || typeof result.body.content !== 'string') return {}
  return parseOpenGraph(result.body.content, result.url)
}

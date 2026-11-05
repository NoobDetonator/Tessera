import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrastText, formatHsl, formatRgb, formatTodo, hexToRgb, isSingleUrl, joinDocument, normalizeHex, paletteToCss, paletteToJson, parseTodo, rgbToHsl, splitDocument, videoEmbed } from '../src/shared/cardtext.ts'
import { isChecklistText } from '../src/shared/classify.ts'
import { alignRects, autoPlace, distributeRects, routeEdge, snapMove, snapToGrid } from '../src/shared/geometry.ts'
import { intersects } from '../src/shared/canvas.ts'
import { assertPublicUrl, isPrivateAddress, parseOpenGraph } from '../src/host/linkpreview.ts'
import { backlinkIndex, completeLink, extractLinks, openLinkAt, resolveLink } from '../src/shared/backlinks.ts'
import type { CanvasNode } from '../src/shared/canvas.ts'

test('to-do text round trips, keeping due dates in the text', () => {
  const text = '- [ ] Buy milk 📅 2026-11-10\n- [x] Call Ana\n- [ ] '
  const items = parseTodo(text)
  assert.deepEqual(items[0], { checked: false, text: 'Buy milk', due: '2026-11-10' })
  assert.deepEqual(items[1], { checked: true, text: 'Call Ana' })
  assert.equal(items[2]?.text, '')
  assert.equal(formatTodo(items), '- [ ] Buy milk 📅 2026-11-10\n- [x] Call Ana\n- [ ]')
  assert.ok(isChecklistText(formatTodo(items)), 'a due date must not break the degradation rule')
})

test('hex colors normalize and convert', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc')
  assert.equal(normalizeHex('#FF8800'), '#ff8800')
  assert.equal(normalizeHex('#ff8800cc'), '#ff8800')
  assert.equal(normalizeHex('red'), undefined)
  assert.deepEqual(hexToRgb('#ff8800'), { r: 255, g: 136, b: 0 })
  assert.equal(formatRgb(hexToRgb('#ff8800')), 'rgb(255, 136, 0)')
  assert.equal(formatHsl(rgbToHsl(hexToRgb('#ff8800'))), 'hsl(32, 100%, 50%)')
  assert.equal(formatHsl(rgbToHsl(hexToRgb('#808080'))), 'hsl(0, 0%, 50%)')
  assert.equal(formatHsl(rgbToHsl(hexToRgb('#0000ff'))), 'hsl(240, 100%, 50%)')
  assert.equal(contrastText('#ffffff'), '#000000')
  assert.equal(contrastText('#000000'), '#ffffff')
})

test('palettes export as CSS and JSON', () => {
  const entries = [{ name: 'Deep Sea', hex: '#003366' }, { name: '', hex: '#ffffff' }]
  const css = paletteToCss(entries)
  assert.ok(css.includes('--deep-sea: #003366;'))
  assert.ok(css.includes('--color-2: #ffffff;'))
  const json = JSON.parse(paletteToJson(entries))
  assert.equal(json[0].hex, '#003366')
  assert.deepEqual(json[1].rgb, { r: 255, g: 255, b: 255 })
})

test('a document title is its first heading', () => {
  assert.deepEqual(splitDocument('# Plan\n\nBody text'), { title: 'Plan', body: 'Body text' })
  assert.deepEqual(splitDocument('No heading'), { title: '', body: 'No heading' })
  assert.deepEqual(splitDocument('## Sub\nx'), { title: '', body: '## Sub\nx' })
  assert.equal(joinDocument('Plan', 'Body'), '# Plan\n\nBody')
  assert.equal(joinDocument('', 'Body'), 'Body')
  assert.deepEqual(splitDocument(joinDocument('A', 'B\n\nC')), { title: 'A', body: 'B\n\nC' })
})

test('video urls resolve to privacy-preserving players', () => {
  assert.equal(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.id, 'dQw4w9WgXcQ')
  assert.equal(videoEmbed('https://youtu.be/dQw4w9WgXcQ')?.provider, 'youtube')
  assert.ok(videoEmbed('https://youtu.be/dQw4w9WgXcQ')?.embedUrl.includes('youtube-nocookie.com'))
  assert.equal(videoEmbed('https://vimeo.com/123456789')?.provider, 'vimeo')
  assert.equal(videoEmbed('https://example.com/watch?v=dQw4w9WgXcQ'), undefined)
  assert.equal(videoEmbed('https://www.youtube.com/watch?v=<script>'), undefined)
  assert.equal(videoEmbed('not a url'), undefined)
})

test('only a single http url counts as a pasted link', () => {
  assert.ok(isSingleUrl(' https://example.com/a?b=1 '))
  assert.ok(!isSingleUrl('see https://example.com'))
  assert.ok(!isSingleUrl('javascript:alert(1)'))
  assert.ok(!isSingleUrl('file:///etc/passwd'))
  assert.ok(!isSingleUrl('hello'))
})

test('open graph tags are read in any attribute order', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta content="OG desc" property="og:description">
    <meta property='og:title' content='Real &quot;title&quot;'>
    <meta name="og:site_name" content="Site">
    <meta property="og:image" content="/pic.png"></head></html>`
  const got = parseOpenGraph(html, 'https://example.com/page')
  assert.equal(got.title, 'Real "title"')
  assert.equal(got.description, 'OG desc')
  assert.equal(got.siteName, 'Site')
  assert.equal(got.image, 'https://example.com/pic.png')
  assert.equal(parseOpenGraph('<title>Only &amp; this</title>', 'https://e.com').title, 'Only & this')
  assert.deepEqual(parseOpenGraph('<p>nothing</p>', 'https://e.com'), {})
})

test('a preview image with a dangerous scheme is dropped', () => {
  assert.equal(parseOpenGraph('<meta property="og:image" content="javascript:alert(1)">', 'https://e.com').image, undefined)
  assert.equal(parseOpenGraph('<meta property="og:image" content="data:image/png;base64,AA">', 'https://e.com').image, undefined)
})

test('private addresses are recognized', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '0.0.0.0', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.ok(isPrivateAddress(address), address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.ok(!isPrivateAddress(address), address)
})

test('previews refuse local destinations, including through DNS', async () => {
  const dns = (address: string) => async () => [{ address }]
  await assert.rejects(assertPublicUrl('http://localhost:3000/'), /Local/)
  await assert.rejects(assertPublicUrl('http://127.0.0.1/'), /Local/)
  await assert.rejects(assertPublicUrl('http://[::1]/'), /Local/)
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /Local/)
  await assert.rejects(assertPublicUrl('http://rebind.example/', dns('10.0.0.1')), /Local/)
  await assert.rejects(assertPublicUrl('ftp://example.com/'), /http/)
  await assert.rejects(assertPublicUrl('nonsense'), /valid/)
  await assertPublicUrl('https://example.com/', dns('93.184.216.34'))
})

test('grid and guide snapping', () => {
  assert.equal(snapToGrid(13), 16)
  assert.equal(snapToGrid(11), 8)
  const moving = { x: 103, y: 500, width: 100, height: 50 }
  const other = { x: 100, y: 0, width: 200, height: 50 }
  const snapped = snapMove(moving, [other], 6)
  assert.equal(snapped.x, 100, 'left edges align')
  assert.equal(snapped.guides.length, 1)
  assert.equal(snapped.guides[0]?.axis, 'x')
  assert.equal(snapped.y, 504, 'the other axis falls back to the grid')
  const free = snapMove(moving, [other], 6, false)
  assert.deepEqual([free.x, free.y, free.guides.length], [103, 500, 0], 'Alt disables all snapping')
})

test('align and distribute', () => {
  const a = { x: 0, y: 0, width: 100, height: 10 }, b = { x: 50, y: 40, width: 50, height: 10 }, c = { x: 300, y: 90, width: 100, height: 10 }
  assert.equal(alignRects([a, b], 'right').get(a)?.x, 0)
  assert.equal(alignRects([a, b], 'left').get(b)?.x, 0)
  assert.equal(alignRects([a, c], 'hcenter').get(a)?.x, 150)
  assert.equal(alignRects([a, c], 'bottom').get(a)?.y, 90)
  const spread = distributeRects([a, b, c], 'x')
  assert.equal(spread.get(a)?.x, 0)
  assert.equal(spread.get(c)?.x, 300)
  assert.equal(spread.get(b)?.x, 175, 'equal gaps')
  assert.equal(distributeRects([a, b], 'x').size, 0)
})

test('auto placement never overlaps', () => {
  const existing = [{ x: 0, y: 0, width: 500, height: 300 }, { x: 900, y: 100, width: 200, height: 900 }]
  const sizes = Array.from({ length: 40 }, (_, i) => ({ width: 200 + (i % 3) * 40, height: 80 + (i % 5) * 30 }))
  const spots = autoPlace(existing, sizes)
  const rects = spots.map((spot, i) => ({ ...spot, ...sizes[i] as { width: number; height: number } }))
  const all = [...existing, ...rects]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) assert.ok(!intersects(all[i]!, all[j]!), `${i} overlaps ${j}`)
  }
  assert.equal(autoPlace([], [{ width: 10, height: 10 }])[0]?.x, 0)
  const nearSpots = autoPlace(existing, [{ width: 100, height: 100 }], 48, { x: 10, y: 10 })
  assert.ok(!intersects({ ...nearSpots[0]!, width: 100, height: 100 }, existing[0]!), 'a requested spot steps off existing content')
})

test('edge routes end on the card sides', () => {
  const from = { x: 0, y: 0, width: 100, height: 100 }, to = { x: 300, y: 0, width: 100, height: 100 }
  for (const routing of ['straight', 'curved', 'orthogonal'] as const) {
    const route = routeEdge({ tessera: { routing } }, from, to)
    assert.deepEqual(route.start, { x: 100, y: 50 }, routing)
    assert.deepEqual(route.end, { x: 300, y: 50 }, routing)
    assert.ok(route.d.startsWith('M100 50'), routing)
  }
  assert.deepEqual(routeEdge({ fromSide: 'bottom', toSide: 'top' }, from, to).start, { x: 50, y: 100 })
})

const textNode = (id: string, text: string): CanvasNode => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, text })

test('wiki links are found outside code only', () => {
  assert.deepEqual(extractLinks('see [[One]] and [[ Two ]]\n```\n[[not this]]\n```\n[[Three]]'), ['One', 'Two', 'Three'])
  assert.deepEqual(extractLinks('no links, [single], [[unclosed'), [])
})

test('backlinks index who points at whom', () => {
  const doc = { nodes: [textNode('a', '# Alpha'), textNode('b', 'links to [[Alpha]] twice [[alpha]]'), textNode('c', '[[a]] by id'), textNode('d', '[[d]] and [[missing]]')], edges: [] }
  assert.deepEqual(backlinkIndex(doc).get('a'), ['b', 'c'], 'one entry per source, by title or id, any case')
  assert.equal(backlinkIndex(doc).get('d'), undefined, 'a card linking to itself does not count')
  assert.equal(resolveLink(doc, 'ALPHA')?.id, 'a')
  assert.equal(resolveLink(doc, 'ghost'), undefined)
})

test('link autocomplete finds the open bracket and finishes the link', () => {
  assert.deepEqual(openLinkAt('hi [[Al', 7), { start: 3, query: 'Al' })
  assert.equal(openLinkAt('hi [[Al]] there', 15), undefined)
  assert.equal(openLinkAt('no brackets', 5), undefined)
  assert.equal(openLinkAt('[[line\nbreak', 12), undefined)
  assert.deepEqual(completeLink('hi [[Al rest', 7, 3, 'Alpha'), { text: 'hi [[Alpha]] rest', caret: 12 })
  assert.deepEqual(completeLink('[[Al]]', 4, 0, 'Alpha'), { text: '[[Alpha]]', caret: 9 }, 'a typed closing pair is not doubled')
})

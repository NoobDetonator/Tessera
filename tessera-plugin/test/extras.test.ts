import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasDoc, CanvasNode } from '../src/shared/canvas.ts'
import { boardToMarkdown, boardToSvg, focusSet, presentationOrder } from '../src/shared/export.ts'
import { eraseAt, parseSketch, sketchToSvg, strokeOutline, type Stroke } from '../src/shared/sketch.ts'

const note = (id: string, x: number, y: number, text = id, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', x, y, width: 200, height: 60, text, tessera: { kind: 'note' }, ...extra })
const frame = (id: string, x: number, y: number, width: number, height: number, label: string, slide?: number): CanvasNode => ({ id, type: 'group', x, y, width, height, label, tessera: { kind: 'frame', ...(slide !== undefined ? { slide } : {}) } })
const pen: Stroke = { brush: 'pen', color: '#112233', size: 4, points: [0, 0, 0.5, 10, 0, 1, 20, 5, 0.2] }

test('a sketch survives a round trip through SVG, staying editable', () => {
  const sketch = { width: 400, height: 300, strokes: [pen, { ...pen, brush: 'highlighter' as const, color: '#ff0000' }] }
  const svg = sketchToSvg(sketch)
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes('viewBox="0 0 400 300"'))
  assert.ok(svg.includes('fill-opacity="0.35"'), 'the highlighter is translucent')
  assert.deepEqual(parseSketch(svg), sketch)
})

test('pen pressure changes the stroke width', () => {
  const light = strokeOutline({ ...pen, points: [0, 0, 0.1, 100, 0, 0.1] })
  const heavy = strokeOutline({ ...pen, points: [0, 0, 1, 100, 0, 1] })
  const spread = (d: string): number => {
    const ys = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => Number(m[2]))
    return Math.max(...ys) - Math.min(...ys)
  }
  assert.ok(spread(heavy) > spread(light) * 2)
  const marker = { ...pen, brush: 'marker' as const }
  assert.equal(spread(strokeOutline({ ...marker, points: [0, 0, 0.1, 100, 0, 0.1] })), spread(strokeOutline({ ...marker, points: [0, 0, 1, 100, 0, 1] })), 'the marker ignores pressure')
})

test('single dots and empty strokes draw safely', () => {
  assert.ok(strokeOutline({ ...pen, points: [5, 5, 0.5] }).includes('a'))
  assert.equal(strokeOutline({ ...pen, points: [] }), '')
})

test('a hostile stroke cannot put markup in the SVG', () => {
  const svg = sketchToSvg({ width: 10, height: 10, strokes: [{ ...pen, color: '"><script>alert(1)</script>' }] })
  assert.ok(!svg.includes('<script'), svg)
  assert.ok(svg.includes('fill="#000000"'))
})

test('parsing ignores anything that is not a well-formed stroke', () => {
  const bad = '<svg viewBox="0 0 50 60"><path data-stroke="not json"/><path data-stroke="{&quot;brush&quot;:&quot;pen&quot;}"/><path data-stroke="{&quot;brush&quot;:&quot;pen&quot;,&quot;color&quot;:&quot;red&quot;,&quot;size&quot;:1,&quot;points&quot;:[]}"/><script>x</script></svg>'
  assert.deepEqual(parseSketch(bad), { width: 50, height: 60, strokes: [] })
  assert.deepEqual(parseSketch('<svg/>', { width: 1, height: 2 }), { width: 1, height: 2, strokes: [] })
})

test('the eraser removes whole strokes it touches', () => {
  const far: Stroke = { ...pen, points: [500, 500, 0.5] }
  assert.deepEqual(eraseAt([pen, far], 10, 1, 3), [far])
  assert.deepEqual(eraseAt([pen, far], 250, 250, 3), [pen, far])
})

test('a board exports as a self-contained, well-formed SVG', () => {
  const doc: CanvasDoc = {
    nodes: [
      frame('f', 0, 0, 600, 400, 'Scene & <one>'),
      note('a', 40, 60, '# Title\n\n- [ ] task\n\n<b>"quoted"</b> & more'),
      { id: 'c', type: 'text', x: 300, y: 60, width: 160, height: 160, text: '#ff8800', tessera: { kind: 'color' } },
      { id: 'i', type: 'file', x: 40, y: 200, width: 100, height: 100, file: '_assets/pic.png', tessera: { kind: 'image' } },
      { id: 'b', type: 'file', x: 700, y: 0, width: 200, height: 100, file: 'Sub.canvas' },
      note('n', 700, 200, 'colored', { color: '4' }),
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'c', label: 'x<y', toEnd: 'arrow' }],
  }
  const result = boardToSvg(doc, { images: new Map([['_assets/pic.png', 'data:image/png;base64,AAAA']]) })
  assert.ok(result)
  const { svg } = result
  assert.ok(!svg.includes('<b>'), 'markup in text is escaped')
  assert.ok(!svg.includes('Scene & <one>'))
  assert.ok(svg.includes('Scene &amp; &lt;one&gt;'))
  assert.ok(svg.includes('x&lt;y'))
  assert.ok(svg.includes('data:image/png;base64,AAAA'), 'images travel with the picture')
  assert.ok(svg.includes('#ff8800'))
  assert.ok(svg.includes('#30a46c'), 'preset colors resolve to real colors')
  assert.ok(svg.includes('☐ task'))
  assert.equal(boardToSvg({ nodes: [], edges: [] }), undefined)
})

test('exporting a selection takes what its groups hold, and only that', () => {
  const doc: CanvasDoc = { nodes: [frame('f', 0, 0, 400, 400, 'F'), note('inside', 50, 50, 'inside'), note('outside', 900, 900, 'outside')], edges: [{ id: 'e', fromNode: 'inside', toNode: 'outside' }] }
  const svg = boardToSvg(doc, { ids: new Set(['f']) })?.svg as string
  assert.ok(svg.includes('inside'))
  assert.ok(!svg.includes('outside'))
  assert.ok(!svg.includes('<path'), 'an edge leaving the selection is left out')
  assert.ok(boardToSvg(doc, { ids: new Set(['outside']) })?.svg.includes('outside'))
})

test('the outline follows reading order, and nested boards nest their headings', async () => {
  const doc: CanvasDoc = {
    nodes: [
      note('last', 0, 900, 'Bottom note'),
      frame('f2', 700, 0, 300, 300, 'Right frame'),
      frame('f1', 0, 0, 300, 300, 'Left frame'),
      note('b', 100, 150, 'Lower in left'),
      note('a', 100, 50, 'Upper in left'),
      note('r', 750, 50, 'In right'),
      { id: 'col', type: 'group', x: 0, y: 400, width: 300, height: 200, label: 'List', tessera: { kind: 'column', items: ['two', 'one'] } },
      note('one', 12, 500, 'Item one'),
      note('two', 12, 440, 'Item two'),
      { id: 'sub', type: 'file', x: 400, y: 400, width: 200, height: 100, file: 'Sub.canvas' },
      { id: 'gone', type: 'file', x: 400, y: 600, width: 200, height: 100, file: 'Gone.canvas' },
      { id: 'self', type: 'file', x: 400, y: 800, width: 200, height: 100, file: 'Root.canvas' },
      { id: 'pic', type: 'file', x: 700, y: 400, width: 100, height: 100, file: '_assets/p.png', tessera: { kind: 'image', caption: 'A picture' } },
      { id: 'link', type: 'link', x: 700, y: 600, width: 100, height: 100, url: 'https://a.b', tessera: { preview: { title: 'Site' } } },
    ],
    edges: [],
  }
  const sub: CanvasDoc = { nodes: [note('deep', 0, 0, 'Deep note'), { id: 'back', type: 'file', x: 0, y: 200, width: 10, height: 10, file: 'Sub.canvas' }], edges: [] }
  const markdown = await boardToMarkdown('Root', doc, async path => (path === 'Sub.canvas' ? sub : path === 'Root.canvas' ? doc : undefined), 1, new Set(['Root.canvas']))
  const order = ['# Root', '## Left frame', 'Upper in left', 'Lower in left', '## Right frame', 'In right', '## List', 'Item two', 'Item one', '## Sub', 'Deep note', '### Sub (already shown above)', '![A picture](_assets/p.png)', '## Gone (board not found)', '- [Site](https://a.b)', '## Root (already shown above)', 'Bottom note']
  let last = -1
  for (const piece of order) {
    const at = markdown.indexOf(piece)
    assert.ok(at > last, `"${piece}" is out of order in:\n${markdown}`)
    last = at
  }
})

test('slides follow explicit numbers, then reading order', () => {
  const doc: CanvasDoc = { nodes: [frame('b', 500, 0, 100, 100, 'b'), frame('a', 0, 0, 100, 100, 'a'), frame('two', 0, 500, 100, 100, 'two', 2), frame('one', 500, 500, 100, 100, 'one', 1), note('n', 0, 0)], edges: [] }
  assert.deepEqual(presentationOrder(doc).map(n => n.id), ['one', 'two', 'a', 'b'])
  assert.deepEqual(presentationOrder({ nodes: [note('n', 0, 0)], edges: [] }), [])
})

test('focus keeps the card and its connections', () => {
  const doc: CanvasDoc = { nodes: [note('a', 0, 0), note('b', 0, 0), note('c', 0, 0), note('d', 0, 0)], edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }, { id: 'e2', fromNode: 'c', toNode: 'a' }, { id: 'e3', fromNode: 'c', toNode: 'd' }] }
  assert.deepEqual([...focusSet(doc, new Set(['a']))].sort(), ['a', 'b', 'c'])
})

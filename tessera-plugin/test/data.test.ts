import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCanvas, serializeCanvas, validateCanvas, type CanvasDoc, type CanvasNode } from '../src/shared/canvas.ts'
import { cardKind, columnMembers, geometricChildren, isVerticalStack } from '../src/shared/classify.ts'
import { applyChange, composeChanges, deleteNodesChange, diffDocs, invertChange } from '../src/shared/change.ts'
import { mergeDocs } from '../src/shared/merge.ts'

const text = (id: string, x = 0, y = 0, body = id): CanvasNode =>
  ({ id, type: 'text', x, y, width: 200, height: 60, text: body })

test('round trip keeps unknown fields at every level', () => {
  const source = JSON.stringify({
    custom: { keep: true },
    nodes: [{ id: 'a', type: 'text', x: 1, y: 2, width: 3, height: 4, text: 'hi', unknownField: [1, 2], tessera: { kind: 'note', future: 'x' } }],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a', wobble: 7 }],
  })
  const doc = parseCanvas(source)
  const again = JSON.parse(serializeCanvas(doc))
  assert.deepEqual(again.custom, { keep: true })
  assert.deepEqual(again.nodes[0].unknownField, [1, 2])
  assert.equal(again.nodes[0].tessera.future, 'x')
  assert.equal(again.edges[0].wobble, 7)
  assert.deepEqual(validateCanvas(again), [])
})

test('serialized files pass the strict validator, including rounded geometry', () => {
  const doc: CanvasDoc = { nodes: [{ ...text('a'), x: 1.6, width: 200.2 }, { id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, label: 'L' }], edges: [] }
  assert.deepEqual(validateCanvas(JSON.parse(serializeCanvas(doc))), [])
})

test('validator rejects what the spec forbids', () => {
  const bad = {
    nodes: [
      { id: 'a', type: 'text', x: 1.5, y: 0, width: 1, height: 1 },
      { id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 't', color: 'red' },
      { id: 'b', type: 'wat', x: 0, y: 0, width: 1, height: 1 },
      { id: 'c', type: 'file', x: 0, y: 0, width: 1, height: 1 },
      { id: 'd', type: 'link', x: 0, y: 0, width: 1, height: 1 },
    ],
    edges: [{ id: 'e', fromNode: 'zzz', toNode: 'a', fromSide: 'middle', toEnd: 'dot' }],
  }
  const errors = validateCanvas(bad).join('\n')
  for (const expected of ['x: must be an integer', 'text: required', 'duplicate a', 'color', 'type: must be', 'file: required', 'url: required', 'unknown node zzz', 'fromSide', 'toEnd']) {
    assert.ok(errors.includes(expected), `missing: ${expected}\n${errors}`)
  }
  assert.ok(validateCanvas([]).length > 0)
})

test('opening never fails on missing metadata or odd shapes', () => {
  assert.deepEqual(parseCanvas(''), { nodes: [], edges: [] })
  assert.deepEqual(parseCanvas('{}'), { nodes: [], edges: [] })
  const doc = parseCanvas('{"nodes":[{"type":"text"},{"id":"x","type":"future"},5],"edges":[{"id":"e"}]}')
  assert.equal(doc.nodes.length, 2)
  assert.equal(doc.nodes[0]?.width, 250)
  assert.equal(doc.edges.length, 0)
  assert.throws(() => parseCanvas('nope'), /Not valid JSON/)
  assert.throws(() => parseCanvas('[]'), /must contain/)
})

test('duplicate ids are repaired, not fatal', () => {
  const doc = parseCanvas(JSON.stringify({ nodes: [text('a'), text('a')] }))
  assert.equal(new Set(doc.nodes.map(n => n.id)).size, 2)
})

test('degradation: checkboxes only is a To-do', () => {
  assert.equal(cardKind({ ...text('a'), text: '- [ ] one\n- [x] two\n\n* [ ] three' }), 'todo')
  assert.equal(cardKind({ ...text('a'), text: '- [ ] one\nplain line' }), 'note')
  assert.equal(cardKind({ ...text('a'), text: '- not a box' }), 'note')
})

test('degradation: a lone hex color is a Color', () => {
  assert.equal(cardKind({ ...text('a'), text: '#ff8800' }), 'color')
  assert.equal(cardKind({ ...text('a'), text: ' #abc ' }), 'color')
  assert.equal(cardKind({ ...text('a'), text: '#ff8800 is orange' }), 'note')
  assert.equal(cardKind({ ...text('a'), text: '#notacolor' }), 'note')
})

test('degradation: a group with stacked children is a Column, otherwise a Frame', () => {
  const group: CanvasNode = { id: 'g', type: 'group', x: 0, y: 0, width: 300, height: 400 }
  const stacked: CanvasDoc = { nodes: [group, text('a', 20, 20), text('b', 20, 100), text('c', 20, 180)], edges: [] }
  assert.equal(cardKind(group, stacked), 'column')
  assert.deepEqual(columnMembers(stacked, group).map(n => n.id), ['a', 'b', 'c'])
  const scattered: CanvasDoc = { nodes: [group, text('a', 0, 0), text('b', 60, 10)], edges: [] }
  assert.equal(cardKind(group, scattered), 'frame')
  assert.equal(cardKind(group, { nodes: [group], edges: [] }), 'frame')
})

test('degradation: anything else is a Note, and file nodes go by extension', () => {
  assert.equal(cardKind({ ...text('a'), text: 'hello' }), 'note')
  assert.equal(cardKind({ id: 'u', type: 'mystery', x: 0, y: 0, width: 1, height: 1 }), 'note')
  const file = (name: string): CanvasNode => ({ id: 'f', type: 'file', x: 0, y: 0, width: 1, height: 1, file: name })
  assert.equal(cardKind(file('a/b.canvas')), 'board')
  assert.equal(cardKind(file('a.PNG')), 'image')
  assert.equal(cardKind(file('a.pdf')), 'file')
  assert.equal(cardKind({ id: 'l', type: 'link', x: 0, y: 0, width: 1, height: 1, url: 'https://x' }), 'link')
})

test('metadata wins only when it fits the node type', () => {
  assert.equal(cardKind({ ...text('a'), tessera: { kind: 'document' } }), 'document')
  assert.equal(cardKind({ ...text('a'), tessera: { kind: 'board' } }), 'note')
  assert.equal(cardKind({ ...text('a'), tessera: { kind: 'bogus' as 'note' } }), 'note')
})

test('geometry helpers respect nesting', () => {
  const outer: CanvasNode = { id: 'o', type: 'group', x: 0, y: 0, width: 1000, height: 1000 }
  const inner: CanvasNode = { id: 'i', type: 'group', x: 100, y: 100, width: 300, height: 300 }
  const doc: CanvasDoc = { nodes: [outer, inner, text('in', 120, 120), text('out', 600, 600)], edges: [] }
  assert.deepEqual(geometricChildren(doc, outer).map(n => n.id).sort(), ['i', 'out'])
  assert.deepEqual(geometricChildren(doc, inner).map(n => n.id), ['in'])
  assert.equal(isVerticalStack([text('a', 0, 0)]), false)
})

test('changes apply, invert and compose', () => {
  const base: CanvasDoc = { nodes: [text('a'), text('b')], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }], extra: 1 }
  const change = deleteNodesChange(base, ['a'])
  const after = applyChange(base, change)
  assert.deepEqual(after.nodes.map(n => n.id), ['b'])
  assert.equal(after.edges.length, 0)
  assert.equal(after.extra, 1)
  assert.deepEqual(applyChange(after, invertChange(base, change)), base)

  const add = { nodes: { c: text('c') } }
  const moved = { nodes: { c: { ...text('c'), x: 50 } } }
  const composed = composeChanges(add, moved)
  assert.equal(applyChange(base, composed).nodes.at(-1)?.x, 50)
  const inv1 = invertChange(base, add)
  const inv2 = invertChange(applyChange(base, add), moved)
  assert.deepEqual(applyChange(applyChange(base, composed), composeChanges(inv2, inv1)), base)
})

test('reorder is inverted exactly', () => {
  const base: CanvasDoc = { nodes: [text('a'), text('b'), text('c')], edges: [] }
  const change = { order: ['c', 'a', 'b'] }
  const after = applyChange(base, change)
  assert.deepEqual(after.nodes.map(n => n.id), ['c', 'a', 'b'])
  assert.deepEqual(applyChange(after, invertChange(base, change)), base)
})

test('diffDocs reproduces the target', () => {
  const from: CanvasDoc = { nodes: [text('a'), text('b')], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] }
  const to: CanvasDoc = { nodes: [text('c'), { ...text('b'), x: 5 }], edges: [] }
  const got = applyChange(from, diffDocs(from, to))
  assert.deepEqual(got.nodes, to.nodes)
  assert.deepEqual(got.edges, [])
})

test('merge: disk edits land where the local side did not touch', () => {
  const base: CanvasDoc = { nodes: [text('a'), text('b')], edges: [] }
  const ours: CanvasDoc = { nodes: [{ ...text('a'), x: 100 }, text('b')], edges: [] }
  const theirs: CanvasDoc = { nodes: [{ ...text('a'), text: 'disk' }, { ...text('b'), y: 9 }, text('c')], edges: [] }
  const merged = mergeDocs(base, ours, theirs)
  const a = merged.nodes.find(n => n.id === 'a')
  assert.equal(a?.x, 100)
  assert.equal(a?.text, 'disk')
  assert.equal(merged.nodes.find(n => n.id === 'b')?.y, 9)
  assert.ok(merged.nodes.some(n => n.id === 'c'))
})

test('merge: a conflicting field keeps the unsaved local edit', () => {
  const base: CanvasDoc = { nodes: [text('a')], edges: [] }
  const ours: CanvasDoc = { nodes: [{ ...text('a'), text: 'mine' }], edges: [] }
  const theirs: CanvasDoc = { nodes: [{ ...text('a'), text: 'theirs' }], edges: [] }
  assert.equal(mergeDocs(base, ours, theirs).nodes[0]?.text, 'mine')
})

test('merge: deletes respect edits on the other side', () => {
  const base: CanvasDoc = { nodes: [text('kept'), text('gone'), text('localdel')], edges: [] }
  const ours: CanvasDoc = { nodes: [{ ...text('kept'), text: 'edited' }, text('gone')], edges: [] }
  const theirs: CanvasDoc = { nodes: [text('localdel')], edges: [] }
  const ids = mergeDocs(base, ours, theirs).nodes.map(n => n.id)
  assert.ok(ids.includes('kept'), 'locally edited node survives a disk delete')
  assert.ok(!ids.includes('gone'), 'untouched node follows the disk delete')
  assert.ok(!ids.includes('localdel'), 'untouched disk node follows the local delete')
})

test('merge: unknown root fields and new local nodes survive', () => {
  const base: CanvasDoc = { nodes: [], edges: [], a: 1 }
  const ours: CanvasDoc = { nodes: [text('new')], edges: [], a: 1 }
  const theirs: CanvasDoc = { nodes: [], edges: [], a: 2, b: 3 }
  const merged = mergeDocs(base, ours, theirs)
  assert.equal(merged.a, 2)
  assert.equal(merged.b, 3)
  assert.ok(merged.nodes.some(n => n.id === 'new'))
})

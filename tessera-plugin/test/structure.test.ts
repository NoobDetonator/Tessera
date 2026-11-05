import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { validateCanvas, serializeCanvas, type CanvasDoc, type CanvasNode } from '../src/shared/canvas.ts'
import { applyChange, invertChange } from '../src/shared/change.ts'
import { cardKind, columnMembers, groupDescendants } from '../src/shared/classify.ts'
import { collapsedMembers, COLUMN_HEAD, COLUMN_PAD, columnInsertIndex, columnLayoutChange, estimateTextHeight, extractCards, groupAsColumn, groupAsFrame, insertIntoColumn, owningColumn, removeFromColumns, topNodeAt, visualRect } from '../src/shared/structure.ts'
import { BoardStore } from '../src/host/store.ts'

const note = (id: string, x = 0, y = 0, height = 60, width = 200): CanvasNode => ({ id, type: 'text', x, y, width, height, text: id })
const doc3: CanvasDoc = { nodes: [note('a', 0, 200), note('b', 300, 0), note('c', 600, 100)], edges: [] }
const assertValid = (doc: CanvasDoc): void => { assert.deepEqual(validateCanvas(JSON.parse(serializeCanvas(doc))), []) }

test('a new column stacks cards by height order, under them in z-order', () => {
  const result = groupAsColumn(doc3, ['a', 'b', 'c'], 'Ideas')
  assert.ok(result)
  const doc = applyChange(doc3, result.change)
  const column = doc.nodes.find(n => n.id === result.id) as CanvasNode
  assert.equal(cardKind(column, doc), 'column')
  assert.equal(column.label, 'Ideas')
  assert.deepEqual(column.tessera?.items, ['b', 'c', 'a'])
  assert.equal(doc.nodes[0]?.id, result.id, 'column draws first')
  const [b, c, a] = columnMembers(doc, column) as [CanvasNode, CanvasNode, CanvasNode]
  assert.equal(b.y, column.y + COLUMN_HEAD)
  assert.equal(c.y, b.y + b.height + 8)
  assert.equal(a.y, c.y + c.height + 8)
  assert.equal(b.x, column.x + COLUMN_PAD)
  assert.equal(b.width, column.width - COLUMN_PAD * 2)
  assert.equal(column.height, a.y + a.height - column.y + COLUMN_PAD)
  assertValid(doc)
  assert.equal(columnLayoutChange(doc, column), undefined, 'layout is idempotent')
})

test('a column made from nothing is refused', () => {
  assert.equal(groupAsColumn(doc3, ['nope'], 'x'), undefined)
  assert.equal(groupAsFrame(doc3, [], 'x'), undefined)
})

test('a plain group with stacked children is never laid out', () => {
  const group: CanvasNode = { id: 'g', type: 'group', x: 0, y: 0, width: 300, height: 400 }
  const doc: CanvasDoc = { nodes: [group, note('a', 37, 21), note('b', 37, 150)], edges: [] }
  assert.equal(cardKind(group, doc), 'column')
  assert.equal(columnLayoutChange(doc, group), undefined)
})

test('layout drops members that no longer exist', () => {
  const column: CanvasNode = { id: 'c', type: 'group', x: 0, y: 0, width: 224, height: 200, tessera: { kind: 'column', items: ['gone', 'a'] } }
  const doc: CanvasDoc = { nodes: [column, note('a', COLUMN_PAD, COLUMN_HEAD)], edges: [] }
  const change = columnLayoutChange(doc, column)
  assert.deepEqual(change?.nodes?.c?.tessera?.items, ['a'])
})

test('a frame surrounds its cards and owns them by geometry', () => {
  const result = groupAsFrame(doc3, ['a', 'b'], 'Scene')
  assert.ok(result)
  const doc = applyChange(doc3, result.change)
  const frame = doc.nodes.find(n => n.id === result.id) as CanvasNode
  assert.equal(cardKind(frame, doc), 'frame')
  assert.equal(doc.nodes[0]?.id, result.id)
  assert.deepEqual(groupDescendants(doc, frame).map(n => n.id).sort(), ['a', 'b'])
  assertValid(doc)
})

test('cards move into, within and out of columns', () => {
  const made = groupAsColumn(doc3, ['a', 'b'], '')
  assert.ok(made)
  let doc = applyChange(doc3, made.change)
  const id = made.id
  const items = () => (doc.nodes.find(n => n.id === id) as CanvasNode).tessera?.items
  assert.deepEqual(items(), ['b', 'a'])
  doc = applyChange(doc, insertIntoColumn(doc, id, ['c'], 1))
  assert.deepEqual(items(), ['b', 'c', 'a'])
  assert.equal(owningColumn(doc, 'c')?.id, id)
  doc = applyChange(doc, insertIntoColumn(doc, id, ['a'], 0))
  assert.deepEqual(items(), ['a', 'b', 'c'], 'reorder inside the column')
  const column = doc.nodes.find(n => n.id === id) as CanvasNode
  assert.equal(columnLayoutChange(doc, column), undefined, 'layout settled')
  doc = applyChange(doc, removeFromColumns(doc, ['b']))
  assert.deepEqual(items(), ['a', 'c'])
  assert.equal(owningColumn(doc, 'b'), undefined)
  const c = doc.nodes.find(n => n.id === 'c') as CanvasNode
  const a = doc.nodes.find(n => n.id === 'a') as CanvasNode
  assert.equal(c.y, a.y + a.height + 8, 'the gap closes')
  assertValid(doc)
})

test('moving a card between columns updates both', () => {
  const first = groupAsColumn(doc3, ['a'], '')!
  let doc = applyChange(doc3, first.change)
  const second = groupAsColumn(doc, ['b'], '')!
  doc = applyChange(doc, second.change)
  doc = applyChange(doc, insertIntoColumn(doc, second.id, ['a'], 0))
  assert.deepEqual((doc.nodes.find(n => n.id === first.id) as CanvasNode).tessera?.items, [])
  assert.deepEqual((doc.nodes.find(n => n.id === second.id) as CanvasNode).tessera?.items, ['a', 'b'])
})

test('the insert index follows the pointer', () => {
  const made = groupAsColumn(doc3, ['a', 'b', 'c'], '')!
  const doc = applyChange(doc3, made.change)
  const column = doc.nodes.find(n => n.id === made.id) as CanvasNode
  const [first, second] = columnMembers(doc, column) as [CanvasNode, CanvasNode]
  assert.equal(columnInsertIndex(doc, column, first.y, []), 0)
  assert.equal(columnInsertIndex(doc, column, second.y + second.height - 1, []), 2)
  assert.equal(columnInsertIndex(doc, column, 99999, []), 3)
  assert.equal(columnInsertIndex(doc, column, 99999, [first.id]), 2)
})

test('collapsing hides members and shrinks only the visual rect', () => {
  const made = groupAsColumn(doc3, ['a', 'b'], '')!
  let doc = applyChange(doc3, made.change)
  const column = doc.nodes.find(n => n.id === made.id) as CanvasNode
  const collapsed = { ...column, tessera: { ...column.tessera, collapsed: true } }
  doc = applyChange(doc, { nodes: { [column.id]: collapsed } })
  assert.deepEqual([...collapsedMembers(doc)].sort(), ['a', 'b'])
  assert.equal(visualRect(collapsed).height, 44)
  assert.equal(collapsed.height, column.height, 'the file keeps the full height')
})

test('the top card under a point respects z-order and exclusions', () => {
  const doc: CanvasDoc = { nodes: [note('under', 0, 0, 100, 100), note('over', 0, 0, 100, 100)], edges: [] }
  assert.equal(topNodeAt(doc, { x: 50, y: 50 }, new Set())?.id, 'over')
  assert.equal(topNodeAt(doc, { x: 50, y: 50 }, new Set(['over']))?.id, 'under')
  assert.equal(topNodeAt(doc, { x: 500, y: 50 }, new Set()), undefined)
})

test('height estimates grow with text and stay bounded', () => {
  assert.ok(estimateTextHeight('short', 248) < estimateTextHeight('x'.repeat(2000), 248))
  assert.ok(estimateTextHeight('x\n'.repeat(5000), 248) <= 1200)
  assert.ok(estimateTextHeight('', 248) >= 44)
})

test('moving cards to another board is one undo step on both boards', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-transfer-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  const store = new BoardStore(dir, 60_000)
  const source: CanvasDoc = { nodes: [note('a', 0, 0), note('b', 300, 0), note('keep', 600, 0)], edges: [{ id: 'in', fromNode: 'a', toNode: 'b' }, { id: 'out', fromNode: 'a', toNode: 'keep' }] }
  await store.create('source.canvas', source)
  await store.create('target.canvas', { nodes: [note('t', 0, 0)], edges: [] })

  await store.transfer('source.canvas', 'target.canvas', ['a', 'b'], { origin: 'user' })
  let from = (await store.read('source.canvas')).doc
  let to = (await store.read('target.canvas')).doc
  assert.deepEqual(from.nodes.map(n => n.id), ['keep'])
  assert.equal(from.edges.length, 0, 'edges to moved cards are gone')
  assert.deepEqual(to.nodes.map(n => n.id).sort(), ['a', 'b', 't'])
  assert.deepEqual(to.edges.map(e => e.id), ['in'], 'an edge fully inside the set moves too')
  const moved = to.nodes.filter(n => n.id !== 't')
  const anchor = to.nodes.find(n => n.id === 't') as CanvasNode
  assert.ok(moved.every(n => n.y >= anchor.y + anchor.height), 'moved cards do not cover what is there')

  await store.undo('source.canvas')
  from = (await store.read('source.canvas')).doc
  to = (await store.read('target.canvas')).doc
  assert.deepEqual(from.nodes.map(n => n.id), ['a', 'b', 'keep'])
  assert.equal(from.edges.length, 2)
  assert.deepEqual(to.nodes.map(n => n.id), ['t'], 'undo clears the target too')
  assert.equal(to.edges.length, 0)

  await store.redo('source.canvas')
  assert.deepEqual((await store.read('target.canvas')).doc.nodes.map(n => n.id).sort(), ['a', 'b', 't'])
  assert.deepEqual((await store.read('source.canvas')).doc.nodes.map(n => n.id), ['keep'])
})

test('extracting a column member also fixes its column', () => {
  const made = groupAsColumn(doc3, ['a', 'b'], '')!
  const doc = applyChange(doc3, made.change)
  const { removal, nodes } = extractCards(doc, ['a'])
  assert.deepEqual(nodes.map(n => n.id), ['a'])
  const after = applyChange(doc, removal)
  assert.deepEqual((after.nodes.find(n => n.id === made.id) as CanvasNode).tessera?.items, ['b'])
  assert.ok(!after.nodes.some(n => n.id === 'a'))
  assert.deepEqual(applyChange(after, invertChange(doc, removal)).nodes.map(n => n.id).sort(), doc.nodes.map(n => n.id).sort())
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { intersects, serializeCanvas, validateCanvas, type CanvasDoc, type CanvasNode } from '../src/shared/canvas.ts'
import { cardKind } from '../src/shared/classify.ts'
import { layoutChange } from '../src/shared/layout.ts'
import { applyChange } from '../src/shared/change.ts'
import { searchBoard } from '../src/shared/search.ts'
import { BUILTIN_TEMPLATES, buildTemplate, instantiate } from '../src/shared/templates.ts'
import { AutoSnapshots, HistoryStore } from '../src/host/history.ts'
import { BoardStore } from '../src/host/store.ts'
import { guardReadOnly, toolSpecs, type SandboxPolicyReader, type ToolRun, type ToolSpec } from '../src/host/tools.ts'

let dir: string
let store: BoardStore
let history: HistoryStore
let specs: Map<string, ToolSpec>
let answer = true
const asked: string[][] = []
let turn = 1

const run: ToolRun = { callId: 'c1', agent: { id: 'session-1' } }
const call = (name: string, args: unknown): Promise<any> => (specs.get(name) as ToolSpec).execute(args as never, run) as Promise<any>
const note = (id: string, x = 0, y = 0, text = id, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', x, y, width: 200, height: 60, text, tessera: { kind: 'note' }, ...extra })

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tessera-tools-'))
  store = new BoardStore(dir, 60_000)
  history = new HistoryStore(store, dir)
  specs = new Map(toolSpecs({
    store, root: dir, history,
    confirm: async ({ ids }) => { asked.push(ids); return answer },
    turnKey: (_run, path) => `agent:${turn}:${path}`,
  }).map(spec => [spec.name, spec]))
})
after(async () => {
  await store.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const board = async (name: string, doc: CanvasDoc): Promise<string> => {
  const path = `${name}.canvas`
  await store.create(path, doc)
  return path
}
const docOf = async (path: string): Promise<CanvasDoc> => (await store.read(path)).doc

test('all eleven tools exist, each with an output schema', () => {
  assert.deepEqual([...specs.keys()].sort(), [
    'tessera_connect', 'tessera_create_board', 'tessera_create_cards', 'tessera_delete_cards', 'tessera_group', 'tessera_layout',
    'tessera_list_boards', 'tessera_read_board', 'tessera_search', 'tessera_snapshot', 'tessera_update_cards',
  ])
  for (const spec of specs.values()) {
    assert.ok(spec.output.schema, spec.name)
    assert.equal(spec.output.render({}, { a: 1 })[0]?.type, 'text')
  }
})

test('bad paths are refused by every path-taking tool', async () => {
  for (const [name, args] of Object.entries({
    tessera_read_board: { path: '../x.canvas' },
    tessera_create_cards: { path: '/etc/x.canvas', cards: [{ text: 'x' }] },
    tessera_update_cards: { path: 'C:\\x.canvas', updates: [{ id: 'a' }] },
    tessera_delete_cards: { path: 'a/../../x.canvas', ids: ['a'] },
    tessera_connect: { path: '../x.canvas', fromId: 'a', toId: 'b' },
    tessera_group: { path: '../x.canvas', ids: ['a'], as: 'frame', title: 't' },
    tessera_layout: { path: '../x.canvas', ids: [], mode: 'grid' },
    tessera_snapshot: { path: '../x.canvas', name: 'n' },
  })) await assert.rejects(call(name, args), /escapes|relative/, name)
})

test('create_cards validates its input', async () => {
  const path = await board('validate', { nodes: [], edges: [] })
  const rejects = async (cards: unknown, pattern: RegExp): Promise<void> => { await assert.rejects(call('tessera_create_cards', { path, cards }), pattern) }
  await rejects([], /non-empty/)
  await rejects('nope', /non-empty/)
  await rejects([{ kind: 'board' }], /tessera_create_board/)
  await rejects([{ kind: 'bogus' }], /Cannot create/)
  await rejects([{ kind: 'link', url: 'not a url' }], /valid url/)
  await rejects([{ kind: 'link', url: 'javascript:alert(1)' }], /http/)
  await rejects([{ kind: 'color', text: 'red' }], /hex/)
  await rejects([{ kind: 'image', file: 'missing.png' }], /No file/)
  await rejects([{ kind: 'image', file: '../outside.png' }], /escapes/)
  await rejects([{ text: 'x', x: 'left' }], /number/)
  await rejects([{ text: 'x', width: -5 }], /positive/)
  await rejects([{ text: 'x', color: 'chartreuse' }], /color must be/)
  await rejects([{ text: 'x', tags: [''] }], /tags/)
  await rejects(Array.from({ length: 201 }, () => ({ text: 'x' })), /At most/)
  assert.equal((await docOf(path)).nodes.length, 0, 'nothing applies when input fails')
})

test('create_cards auto-places without overlap and keeps the file valid', async () => {
  const path = await board('create', { nodes: [note('existing', 0, 0)], edges: [] })
  await mkdir(join(dir, '_assets'), { recursive: true })
  await writeFile(join(dir, '_assets', 'pic.png'), 'x')
  const result = await call('tessera_create_cards', {
    path,
    cards: [
      { text: 'plain note' }, { kind: 'document', title: 'Doc', text: 'Body' }, { kind: 'todo', text: 'one\n- [x] two' },
      { kind: 'color', text: '#FF8800' }, { kind: 'link', url: 'https://example.com' }, { kind: 'image', file: '_assets/pic.png', caption: 'c' },
      { kind: 'frame', title: 'F' }, { kind: 'column', title: 'C' }, { text: 'fixed', x: 5000, y: 5000, tags: ['t'], color: '3' },
    ],
  })
  assert.equal(result.created.length, 9)
  const doc = await docOf(path)
  assert.deepEqual(validateCanvas(JSON.parse(serializeCanvas(doc))), [])
  for (let i = 0; i < doc.nodes.length; i++) {
    for (let j = i + 1; j < doc.nodes.length; j++) assert.ok(!intersects(doc.nodes[i]!, doc.nodes[j]!), `${doc.nodes[i]!.id} overlaps ${doc.nodes[j]!.id}`)
  }
  const byKind = (kind: string) => doc.nodes.find(n => n.tessera?.kind === kind) as CanvasNode
  assert.equal(byKind('document').text, '# Doc\n\nBody')
  assert.equal(byKind('todo').text, '- [ ] one\n- [x] two')
  assert.equal(byKind('color').text, '#ff8800')
  assert.equal(byKind('image').file, '_assets/pic.png')
  assert.equal(byKind('frame').label, 'F')
  assert.equal(cardKind(byKind('column'), doc), 'column')
  const fixed = doc.nodes.find(n => n.text === 'fixed') as CanvasNode
  assert.deepEqual([fixed.x, fixed.y, fixed.color, fixed.tessera?.tags], [5000, 5000, '3', ['t']])
})

test('read_board cuts long text and flags it', async () => {
  const long = 'x'.repeat(1000)
  const path = await board('read', { nodes: [note('a', 0, 0, long), note('b', 0, 0, 'short')], edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'L' }] })
  const result = await call('tessera_read_board', { path })
  const a = result.cards.find((c: { id: string }) => c.id === 'a')
  assert.equal(a.text.length, 400)
  assert.equal(a.truncated, true)
  assert.equal(a.fullLength, 1000)
  assert.equal(result.cards.find((c: { id: string }) => c.id === 'b').truncated, undefined)
  assert.deepEqual(result.edges, [{ id: 'e', from: 'a', to: 'b', label: 'L' }])
  await assert.rejects(call('tessera_read_board', { path, depth: 9 }), /depth/)
  await assert.rejects(call('tessera_read_board', { path: 'nope.canvas' }), /No board/)
})

test('read_board follows nested boards to the given depth and survives cycles', async () => {
  const file = (id: string, target: string): CanvasNode => ({ id, type: 'file', file: target, x: 0, y: 0, width: 10, height: 10 })
  await board('cycle-a', { nodes: [file('toB', 'cycle-b.canvas')], edges: [] })
  await board('cycle-b', { nodes: [file('toA', 'cycle-a.canvas'), note('deep')], edges: [] })
  const shallow = await call('tessera_read_board', { path: 'cycle-a.canvas' })
  assert.deepEqual(shallow.nestedBoards, ['cycle-b.canvas'])
  assert.equal(shallow.nested, undefined)
  const deep = await call('tessera_read_board', { path: 'cycle-a.canvas', depth: 3 })
  assert.equal(deep.nested[0].path, 'cycle-b.canvas')
  assert.equal(deep.nested[0].nested[0].cycle, true)
})

test('search filters by words, tags, kinds and board', async () => {
  const path = await board('search', { nodes: [note('one', 0, 0, 'Dragon lore', { tessera: { kind: 'note', tags: ['fantasy'] } }), note('two', 0, 0, 'Lore of ships'), { id: 'c', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '#ff0000' }], edges: [] })
  const within = async (args: object) => (await call('tessera_search', { board: path, query: '', ...args })).matches.map((m: { id: string }) => m.id).sort()
  assert.deepEqual(await within({ query: 'lore' }), ['one', 'two'])
  assert.deepEqual(await within({ query: 'LORE dragon' }), ['one'])
  assert.deepEqual(await within({ tags: ['fantasy'] }), ['one'])
  assert.deepEqual(await within({ types: ['color'] }), ['c'])
  await assert.rejects(call('tessera_search', { query: 'x', types: ['bogus'] }), /Unknown card kind/)
  const everywhere = await call('tessera_search', { query: 'Dragon' })
  assert.ok(everywhere.matches.some((m: { board: string }) => m.board === path))
  assert.equal(searchBoard('b', { nodes: [note('a', 0, 0, 'hello world')], edges: [] }, 'world')[0]?.snippet, 'hello world')
})

test('update_cards changes fields, respects locks, and reports what it skipped', async () => {
  const path = await board('update', { nodes: [note('a'), note('locked', 0, 0, 'x', { tessera: { kind: 'note', locked: true } }), { id: 'l', type: 'link', x: 0, y: 0, width: 1, height: 1, url: 'https://a.b', tessera: { preview: { title: 'old' } } }], edges: [] })
  const result = await call('tessera_update_cards', {
    path,
    updates: [
      { id: 'a', text: 'new', x: 10, color: '#ABC', tags: ['t'] }, { id: 'locked', text: 'no' }, { id: 'ghost', text: 'no' },
      { id: 'l', text: 'no' }, { id: 'l', url: 'https://c.d' },
    ],
  })
  assert.deepEqual(result.updated.sort(), ['a', 'l'])
  assert.deepEqual(result.skipped.map((s: { id: string; reason: string }) => s.reason).sort(), ['locked', 'not found', 'this card has no text'])
  const doc = await docOf(path)
  const a = doc.nodes.find(n => n.id === 'a') as CanvasNode
  assert.deepEqual([a.text, a.x, a.color, a.tessera?.tags], ['new', 10, '#aabbcc', ['t']])
  assert.equal(doc.nodes.find(n => n.id === 'locked')?.text, 'x')
  assert.equal(doc.nodes.find(n => n.id === 'l')?.tessera?.preview, undefined, 'a new url drops the old preview')
  await call('tessera_update_cards', { path, updates: [{ id: 'a', color: null }, { id: 'locked', locked: false }] })
  assert.equal((await docOf(path)).nodes.find(n => n.id === 'a')?.color, undefined)
  await assert.rejects(call('tessera_update_cards', { path, updates: [{ id: 'a', x: 'nope' }] }), /number/)
  await assert.rejects(call('tessera_update_cards', { path, updates: [{ id: 'a', colorStyle: 'neon' }] }), /colorStyle/)
})

test('delete_cards waits for the user and obeys the answer', async () => {
  const path = await board('delete', { nodes: [note('a'), note('b'), note('keep', 0, 0, 'k', { tessera: { kind: 'note', locked: true } })], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] })
  answer = false
  const declined = await call('tessera_delete_cards', { path, ids: ['a'] })
  assert.deepEqual([declined.declined, declined.deleted], [true, []])
  assert.equal((await docOf(path)).nodes.length, 3)
  answer = true
  asked.length = 0
  const done = await call('tessera_delete_cards', { path, ids: ['a', 'keep', 'ghost'] })
  assert.deepEqual(asked, [['a']], 'only deletable cards reach the question')
  assert.deepEqual(done.deleted, ['a'])
  assert.deepEqual(done.skipped.map((s: { reason: string }) => s.reason).sort(), ['locked', 'not found'])
  const doc = await docOf(path)
  assert.deepEqual(doc.nodes.map(n => n.id), ['b', 'keep'])
  assert.equal(doc.edges.length, 0, 'edges go with the card')
  await assert.rejects(call('tessera_delete_cards', { path, ids: [] }), /empty/)
})

test('connect validates cards and style', async () => {
  const path = await board('connect', { nodes: [note('a'), note('b')], edges: [] })
  const { edgeId } = await call('tessera_connect', { path, fromId: 'a', toId: 'b', label: 'then', style: { routing: 'orthogonal', dashed: true, color: '2', arrow: 'both', fromSide: 'right', toSide: 'left' } })
  const edge = (await docOf(path)).edges.find(e => e.id === edgeId)
  assert.deepEqual([edge?.label, edge?.tessera?.routing, edge?.tessera?.dashed, edge?.color, edge?.fromEnd, edge?.toEnd, edge?.fromSide], ['then', 'orthogonal', true, '2', 'arrow', 'arrow', 'right'])
  assert.deepEqual(validateCanvas(JSON.parse(serializeCanvas(await docOf(path)))), [])
  await assert.rejects(call('tessera_connect', { path, fromId: 'a', toId: 'a' }), /two different/)
  await assert.rejects(call('tessera_connect', { path, fromId: 'a', toId: 'ghost' }), /No card/)
  await assert.rejects(call('tessera_connect', { path, fromId: 'a', toId: 'b', style: { routing: 'wiggly' } }), /routing/)
  await assert.rejects(call('tessera_connect', { path, fromId: 'a', toId: 'b', style: { arrow: 'up' } }), /arrow/)
  await assert.rejects(call('tessera_connect', { path, fromId: 'a', toId: 'b', style: { fromSide: 'middle' } }), /side/)
})

test('group makes columns, frames and nested boards', async () => {
  const path = await board('group', { nodes: [note('a', 0, 0), note('b', 300, 0), note('c', 600, 0), note('d', 900, 0), note('e', 1200, 0)], edges: [] })
  const column = await call('tessera_group', { path, ids: ['a', 'b'], as: 'column', title: 'Col' })
  const frame = await call('tessera_group', { path, ids: ['c'], as: 'frame', title: 'Fr' })
  const nested = await call('tessera_group', { path, ids: ['d', 'e'], as: 'board', title: 'Sub' })
  const doc = await docOf(path)
  assert.equal(cardKind(doc.nodes.find(n => n.id === column.id) as CanvasNode, doc), 'column')
  assert.equal(cardKind(doc.nodes.find(n => n.id === frame.id) as CanvasNode, doc), 'frame')
  assert.equal(cardKind(doc.nodes.find(n => n.id === nested.id) as CanvasNode, doc), 'board')
  assert.equal(nested.file, 'Sub.canvas')
  assert.ok(!doc.nodes.some(n => n.id === 'd'))
  assert.deepEqual((await docOf('Sub.canvas')).nodes.map(n => n.id).sort(), ['d', 'e'])
  await assert.rejects(call('tessera_group', { path, ids: ['ghost'], as: 'frame', title: 't' }), /No such cards/)
  await assert.rejects(call('tessera_group', { path, ids: ['a'], as: 'frame', title: '  ' }), /empty/)
  await assert.rejects(call('tessera_group', { path, ids: ['a'], as: 'pile', title: 't' }), /as must be/)
})

test('a whole agent turn undoes as one step, including a nested-board move', async () => {
  const path = await board('turn', { nodes: [note('a', 0, 0), note('b', 300, 0), note('c', 600, 0)], edges: [] })
  const before = JSON.stringify((await docOf(path)).nodes.map(n => [n.id, n.x, n.y]))
  turn = 7
  await call('tessera_update_cards', { path, updates: [{ id: 'a', x: 50 }] })
  await call('tessera_create_cards', { path, cards: [{ text: 'added' }] })
  await call('tessera_group', { path, ids: ['b'], as: 'frame', title: 'F' })
  const moved = await call('tessera_group', { path, ids: ['c'], as: 'board', title: 'TurnSub' })
  await store.undo(path)
  const after = (await docOf(path)).nodes
  assert.equal(JSON.stringify(after.map(n => [n.id, n.x, n.y]).sort()), JSON.stringify(JSON.parse(before).sort()))
  assert.equal((await docOf(moved.file)).nodes.length, 0, 'the nested board is emptied too')
  assert.equal(await store.undo(path), undefined, 'there was only one step')

  turn = 8
  await call('tessera_update_cards', { path, updates: [{ id: 'a', x: 1 }] })
  turn = 9
  await call('tessera_update_cards', { path, updates: [{ id: 'a', x: 2 }] })
  await store.undo(path)
  assert.equal((await docOf(path)).nodes.find(n => n.id === 'a')?.x, 1, 'separate turns stay separate')
})

test('layout modes leave nothing overlapping', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, i * 7, i * 5, `n${i}`, { tessera: { kind: 'note', tags: [i % 2 === 0 ? 'even' : 'odd'] } }))
  const edges = [{ id: 'e1', fromNode: 'n0', toNode: 'n1' }, { id: 'e2', fromNode: 'n1', toNode: 'n2' }, { id: 'e3', fromNode: 'n2', toNode: 'n0' }]
  for (const mode of ['grid', 'tree', 'cluster'] as const) {
    const path = await board(`layout-${mode}`, { nodes, edges })
    const result = await call('tessera_layout', { path, ids: [], mode })
    assert.ok(result.moved > 0, mode)
    const doc = await docOf(path)
    for (let i = 0; i < doc.nodes.length; i++) {
      for (let j = i + 1; j < doc.nodes.length; j++) assert.ok(!intersects(doc.nodes[i]!, doc.nodes[j]!), `${mode}: ${doc.nodes[i]!.id} overlaps ${doc.nodes[j]!.id}`)
    }
  }
  const tree = await board('layout-tree2', { nodes: [note('root', 500, 500), note('kid', 0, 0)], edges: [{ id: 'e', fromNode: 'root', toNode: 'kid' }] })
  await call('tessera_layout', { path: tree, ids: [], mode: 'tree' })
  const doc = await docOf(tree)
  assert.ok((doc.nodes.find(n => n.id === 'kid') as CanvasNode).x > (doc.nodes.find(n => n.id === 'root') as CanvasNode).x, 'children sit to the right of parents')
  await assert.rejects(call('tessera_layout', { path: tree, ids: [], mode: 'spiral' }), /mode/)
})

test('layout carries a group with what is inside it, and skips locked cards', () => {
  const frame: CanvasNode = { id: 'f', type: 'group', x: 1000, y: 1000, width: 400, height: 400, tessera: { kind: 'frame' } }
  const doc: CanvasDoc = { nodes: [frame, note('inside', 1100, 1100), note('free', 0, 0), note('pinned', 50, 50, 'p', { tessera: { locked: true } })], edges: [] }
  const after = applyChange(doc, layoutChange(doc, ['f', 'free', 'pinned'], 'grid'))
  const moved = after.nodes.find(n => n.id === 'f') as CanvasNode
  const inside = after.nodes.find(n => n.id === 'inside') as CanvasNode
  assert.deepEqual([inside.x - moved.x, inside.y - moved.y], [100, 100])
  assert.equal(after.nodes.find(n => n.id === 'pinned')?.x, 50)
})

test('create_board nests under a parent, and templates are all valid', async () => {
  const parent = await board('parent', { nodes: [note('a')], edges: [] })
  const made = await call('tessera_create_board', { parentPath: parent, title: 'Child', template: 'project-plan' })
  assert.equal(made.path, 'Child.canvas')
  assert.ok((await docOf('Child.canvas')).nodes.length > 0)
  const doc = await docOf(parent)
  assert.equal(cardKind(doc.nodes.find(n => n.id === made.cardId) as CanvasNode, doc), 'board')
  assert.ok(!(await call('tessera_create_board', { parentPath: null, title: 'Top' })).cardId)
  await assert.rejects(call('tessera_create_board', { parentPath: null, title: 'x', template: 'nope' }), /Unknown template/)
  await assert.rejects(call('tessera_create_board', { parentPath: 'ghost.canvas', title: 'x' }), /No board/)
  await assert.rejects(call('tessera_create_board', { parentPath: null, title: ' ' }), /empty/)
  assert.equal(BUILTIN_TEMPLATES.length, 8)
  for (const { id } of BUILTIN_TEMPLATES) {
    const template = buildTemplate(id) as CanvasDoc
    assert.ok(template.nodes.length > 0, id)
    assert.deepEqual(validateCanvas(JSON.parse(serializeCanvas(template))), [], id)
    assert.notEqual(buildTemplate(id)?.nodes[0]?.id, template.nodes[0]?.id, 'each use gets new ids')
  }
})

test('snapshots save, list and restore as one undoable step', async () => {
  const path = await board('snap', { nodes: [note('a', 0, 0, 'original')], edges: [] })
  const saved = await call('tessera_snapshot', { path, name: 'Before/changes' })
  await call('tessera_update_cards', { path, updates: [{ id: 'a', text: 'changed' }] })
  await call('tessera_create_cards', { path, cards: [{ text: 'extra' }] })
  const listed = await history.list(path)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.name, 'Before changes')
  assert.equal(listed[0]?.cards, 1)
  assert.equal((await history.read(path, saved.id)).nodes[0]?.text, 'original')
  await history.restore(path, saved.id)
  let doc = await docOf(path)
  assert.deepEqual(doc.nodes.map(n => n.text), ['original'])
  assert.ok((await history.list(path)).some(entry => entry.name === 'Before restore'), 'the state before restoring is kept')
  await store.undo(path)
  doc = await docOf(path)
  assert.ok(doc.nodes.some(n => n.text === 'extra'), 'restore undoes')
  await assert.rejects(history.read(path, '../../evil.canvas'), /Unknown snapshot/)
})

test('read-only sessions cannot change boards, but can still read them', async () => {
  const path = await board('readonly', { nodes: [note('a')], edges: [] })
  const asked: unknown[] = []
  const policy = (mode: string): SandboxPolicyReader => ({ resolve: ({ session }) => { asked.push(session); return { mode } } })
  const spec = (name: string): ToolSpec => specs.get(name) as ToolSpec
  const session = { id: 's' }
  const blocked = guardReadOnly(spec('tessera_create_cards'), () => policy('read-only'))
  await assert.rejects(blocked({ path, cards: [{ text: 'x' }] } as never, { agent: { id: 's', session } } as never), /read-only/)
  assert.equal(asked[0], session, 'the check is about the calling session')
  assert.equal((await docOf(path)).nodes.length, 1, 'nothing changed')
  const reading = guardReadOnly(spec('tessera_read_board'), () => policy('read-only'))
  assert.equal((await reading({ path } as never, { agent: { id: 's', session } } as never) as { cards: unknown[] }).cards.length, 1)
  const writing = guardReadOnly(spec('tessera_create_cards'), () => policy('workspace-write'))
  await writing({ path, cards: [{ text: 'x' }] } as never, { agent: { id: 's', session } } as never)
  assert.equal((await docOf(path)).nodes.length, 2, 'other modes write')
  for (const name of ['tessera_create_cards', 'tessera_update_cards', 'tessera_delete_cards', 'tessera_connect', 'tessera_group', 'tessera_layout', 'tessera_create_board', 'tessera_snapshot']) assert.ok(spec(name).mutates, name)
  for (const name of ['tessera_list_boards', 'tessera_read_board', 'tessera_search']) assert.ok(!spec(name).mutates, name)
})

test('saved templates get fresh ids and keep their structure', () => {
  const column: CanvasNode = { id: 'c', type: 'group', x: 0, y: 0, width: 10, height: 10, tessera: { kind: 'column', items: ['a', 'ghost'] } }
  const doc: CanvasDoc = { nodes: [column, note('a')], edges: [{ id: 'e', fromNode: 'c', toNode: 'a' }, { id: 'dangling', fromNode: 'a', toNode: 'ghost' }], extra: 1 }
  const copy = instantiate(doc)
  assert.ok(copy.nodes.every(node => node.id !== 'c' && node.id !== 'a'))
  const newColumn = copy.nodes[0] as CanvasNode
  assert.deepEqual(newColumn.tessera?.items, [copy.nodes[1]?.id], 'membership follows the new ids, and stale ones drop')
  assert.equal(copy.edges.length, 1)
  assert.equal(copy.edges[0]?.fromNode, newColumn.id)
  assert.equal(copy.extra, 1)
})

test('automatic snapshots wait for the interval and start only after edits', () => {
  let now = 1000
  const auto = new AutoSnapshots(600, () => now)
  assert.equal(auto.shouldSnapshot('a'), false, 'the first save only starts the clock')
  now += 599
  assert.equal(auto.shouldSnapshot('a'), false)
  now += 1
  assert.equal(auto.shouldSnapshot('a'), true)
  assert.equal(auto.shouldSnapshot('a'), false)
  assert.equal(auto.shouldSnapshot('b'), false, 'boards have separate clocks')
})

test('old automatic snapshots are pruned, named ones never are', async () => {
  const path = await board('prune', { nodes: [note('a')], edges: [] })
  await history.snapshot(path, 'Keep me')
  for (let i = 0; i < 55; i++) await history.snapshot(path, 'Auto', true)
  const list = await history.list(path)
  assert.equal(list.filter(item => item.auto).length, 50)
  assert.ok(list.some(item => item.name === 'Keep me'))
  assert.ok(list[0]!.at >= list.at(-1)!.at, 'newest first')
})

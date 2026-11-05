import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { serializeCanvas, validateCanvas, type CanvasNode } from '../src/shared/canvas.ts'
import { BoardStore, normalizeBoardPath, normalizeRelativePath, slugify } from '../src/host/store.ts'

let dir: string
let store: BoardStore
const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
const note = (id: string, body = id): CanvasNode => ({ id, type: 'text', x: 0, y: 0, width: 200, height: 60, text: body })

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tessera-store-'))
  store = new BoardStore(dir, 20)
  await store.start()
})
after(async () => {
  await store.stop()
  await rm(dir, { recursive: true, force: true })
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await wait(15)
  }
}

test('paths cannot leave the root', () => {
  for (const bad of ['../x.canvas', 'a/../../x.canvas', '/etc/x.canvas', 'C:\\x.canvas', 'a//b.canvas', '', 5, 'a\u0000.canvas']) {
    assert.throws(() => normalizeRelativePath(bad), /Path|path/, String(bad))
  }
  assert.equal(normalizeRelativePath('a\\b.canvas'), 'a/b.canvas')
  assert.throws(() => normalizeBoardPath('a.txt'), /Not a board/)
})

test('slugify keeps any script and removes reserved characters', () => {
  assert.equal(slugify('Mundo: Élfico/2'), 'Mundo Élfico 2')
  assert.equal(slugify('  ...  '), 'Untitled')
  assert.equal(slugify('CON'), 'CON-board')
})

test('20 notes survive a restart and the file is valid', async () => {
  const path = 'twenty.canvas'
  await store.create(path, { nodes: [], edges: [] })
  const nodes: Record<string, CanvasNode> = {}
  for (let i = 0; i < 20; i++) nodes[`n${i}`] = { ...note(`n${i}`, `note ${i}`), x: i * 10 }
  await store.apply(path, { nodes }, { origin: 'user' })
  await store.flush(path)
  const onDisk = JSON.parse(await readFile(join(dir, path), 'utf8'))
  assert.deepEqual(validateCanvas(onDisk), [])

  const fresh = new BoardStore(dir, 20)
  const { doc } = await fresh.read(path)
  assert.equal(doc.nodes.length, 20)
  assert.equal(doc.nodes[19]?.text, 'note 19')
})

test('unknown fields survive edits and saves', async () => {
  const path = 'unknown.canvas'
  await writeFile(join(dir, path), JSON.stringify({
    rootThing: 1,
    nodes: [{ ...note('a'), alien: { deep: true }, tessera: { future: 1 } }],
    edges: [],
  }))
  const { doc } = await store.read(path)
  const a = doc.nodes[0] as CanvasNode
  await store.apply(path, { nodes: { a: { ...a, x: 99 } } }, { origin: 'user' })
  await store.flush(path)
  const onDisk = JSON.parse(await readFile(join(dir, path), 'utf8'))
  assert.equal(onDisk.rootThing, 1)
  assert.deepEqual(onDisk.nodes[0].alien, { deep: true })
  assert.equal(onDisk.nodes[0].tessera.future, 1)
  assert.equal(onDisk.nodes[0].x, 99)
})

test('undo and redo walk history, coalesced edits are one step', async () => {
  const path = 'undo.canvas'
  await store.create(path, { nodes: [note('a')], edges: [] })
  await store.apply(path, { nodes: { a: note('a', 'one') } }, { origin: 'user', coalesce: 'k' })
  await store.apply(path, { nodes: { a: note('a', 'two') } }, { origin: 'user', coalesce: 'k' })
  await store.apply(path, { nodes: { b: note('b') } }, { origin: 'agent', label: 'agent' })
  await store.undo(path)
  assert.equal((await store.read(path)).doc.nodes.length, 1)
  await store.undo(path)
  assert.equal((await store.read(path)).doc.nodes[0]?.text, 'a')
  assert.equal(await store.undo(path), undefined)
  await store.redo(path)
  assert.equal((await store.read(path)).doc.nodes[0]?.text, 'two')
  await store.redo(path)
  assert.equal((await store.read(path)).doc.nodes.length, 2)
})

test('derived changes stay out of undo', async () => {
  const path = 'derived.canvas'
  await store.create(path, { nodes: [note('a')], edges: [] })
  await store.apply(path, { nodes: { a: { ...note('a'), height: 99 } } }, { origin: 'user', undoable: false })
  assert.equal(await store.undo(path), undefined)
  assert.equal((await store.read(path)).doc.nodes[0]?.height, 99)
})

test('an external edit merges without losing unsaved local edits', async () => {
  const path = 'external.canvas'
  await store.create(path, { nodes: [note('a'), note('b')], edges: [] })
  await store.read(path)
  const slow = new BoardStore(dir, 60_000) // a long debounce keeps the local edit unsaved
  await slow.start()
  try {
    await slow.apply(path, { nodes: { a: note('a', 'unsaved local') } }, { origin: 'user' })
    await writeFile(join(dir, path), serializeCanvas({ nodes: [note('a'), note('b', 'from disk'), note('c', 'new on disk')], edges: [] }))
    await waitFor(async () => (await slow.read(path)).doc.nodes.length === 3)
    const { doc } = await slow.read(path)
    assert.equal(doc.nodes.find(n => n.id === 'a')?.text, 'unsaved local')
    assert.equal(doc.nodes.find(n => n.id === 'b')?.text, 'from disk')
    await slow.flush(path)
    const saved = JSON.parse(await readFile(join(dir, path), 'utf8'))
    assert.equal(saved.nodes.find((n: CanvasNode) => n.id === 'a').text, 'unsaved local')
    assert.equal(saved.nodes.find((n: CanvasNode) => n.id === 'c').text, 'new on disk')
  } finally {
    await slow.stop()
  }
})

test('own writes do not echo as external changes', async () => {
  const path = 'echo.canvas'
  await store.create(path, { nodes: [note('a')], edges: [] })
  await store.read(path)
  const seen: string[] = []
  const listen = (event: { origin: string; path: string }) => { if (event.path === path) seen.push(event.origin) }
  store.on('change', listen)
  await store.apply(path, { nodes: { a: note('a', 'x') } }, { origin: 'user' })
  await store.flush(path)
  await wait(300)
  store.off('change', listen)
  assert.deepEqual(seen, ['user'])
})

test('a write folds in a disk edit the watcher has not delivered', async () => {
  const path = 'race.canvas'
  const unwatched = new BoardStore(dir, 60_000) // never started, so no watcher
  await unwatched.create(path, { nodes: [note('a')], edges: [] })
  await unwatched.read(path)
  await unwatched.apply(path, { nodes: { b: note('b') } }, { origin: 'user' })
  await writeFile(join(dir, path), serializeCanvas({ nodes: [note('a'), note('disk')], edges: [] }))
  await unwatched.flush(path)
  const saved = JSON.parse(await readFile(join(dir, path), 'utf8'))
  assert.deepEqual(saved.nodes.map((n: CanvasNode) => n.id).sort(), ['a', 'b', 'disk'])
})

test('a corrupt external file is kept aside and memory survives', async () => {
  const path = 'corrupt.canvas'
  const local = new BoardStore(dir, 60_000)
  await local.create(path, { nodes: [note('a')], edges: [] })
  await local.read(path)
  const problems: string[] = []
  local.on('external-invalid', ({ message }) => { problems.push(message) })
  await local.apply(path, { nodes: { a: note('a', 'precious') } }, { origin: 'user' })
  await writeFile(join(dir, path), '{ broken')
  await local.flush(path)
  assert.equal(problems.length, 1)
  const kept = await readdir(join(dir, '_history', 'corrupt'))
  assert.ok(kept.some(name => name.endsWith('corrupt.canvas')))
  const saved = JSON.parse(await readFile(join(dir, path), 'utf8'))
  assert.equal(saved.nodes[0].text, 'precious')
})

test('a failed save keeps memory, reports, and retries', async () => {
  const path = 'locked/file.canvas'
  const local = new BoardStore(dir, 60_000) // a short debounce could save before the folder is broken
  await local.create(path, { nodes: [note('a')], edges: [] })
  await local.read(path)
  const errors: string[] = []
  local.on('save-error', ({ message }) => { errors.push(message) })
  await local.apply(path, { nodes: { a: note('a', 'kept') } }, { origin: 'user' })
  // Replacing the parent folder with a file makes the write fail.
  await rm(join(dir, 'locked'), { recursive: true, maxRetries: 10, retryDelay: 20 }) // Windows reports ENOTEMPTY while the watcher holds the folder
  await writeFile(join(dir, 'locked'), 'in the way')
  await local.flush(path)
  assert.ok(errors.length > 0)
  assert.equal((await local.read(path)).doc.nodes[0]?.text, 'kept')
  await rm(join(dir, 'locked'))
  await mkdir(join(dir, 'locked'))
  await local.flush(path)
  await waitFor(async () => {
    const saved = await readFile(join(dir, path), 'utf8').catch(() => '')
    return saved.includes('kept')
  })
  await local.stop()
})

test('listing skips reserved folders', async () => {
  await mkdir(join(dir, '_history'), { recursive: true })
  await writeFile(join(dir, '_history', 'old.canvas'), '{}')
  await writeFile(join(dir, 'visible.canvas'), '{}')
  const paths = await store.listPaths()
  assert.ok(paths.includes('visible.canvas'))
  assert.ok(!paths.some(path => path.startsWith('_history')))
})

test('freePath avoids collisions', async () => {
  await store.create('Dup.canvas', { nodes: [], edges: [] })
  assert.equal(await store.freePath('Dup'), 'Dup 2.canvas')
})

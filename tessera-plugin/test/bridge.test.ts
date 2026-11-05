import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { boardRoutes, createApiHandler, EventHub, isLoopbackAuthority, isLoopbackBind } from '../src/host/http.ts'
import { BoardStore } from '../src/host/store.ts'

const TOKEN = 'test-token-value'
let dir: string
let store: BoardStore
let server: Server
let port: number
const hub = new EventHub()

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tessera-bridge-'))
  store = new BoardStore(dir, 10)
  await store.start()
  const handler = createApiHandler({
    store, token: TOKEN,
    config: { maxJsonBytes: 1024, maxAssetBytes: 2048 },
    routes: boardRoutes(store, hub),
    warn: () => {},
  })
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    void handler(req, res, url.pathname, url)
  })
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done) })
  port = (server.address() as AddressInfo).port
})

after(async () => {
  hub.close()
  server.closeAllConnections()
  await new Promise(done => { server.close(done) })
  await store.stop()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

interface CallOptions { method?: string; path: string; token?: string | null; host?: string; origin?: string; body?: string | Buffer; headers?: Record<string, string> }

/** A raw request, because fetch refuses to set Host and Origin. */
function call(options: CallOptions): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  const token = options.token === undefined ? TOKEN : options.token
  return new Promise((done, fail) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path: options.path, method: options.method ?? 'GET',
      headers: {
        host: options.host ?? `127.0.0.1:${port}`,
        ...(options.origin !== undefined ? { origin: options.origin } : {}),
        ...(token !== null ? { 'x-tessera-token': token } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => { done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }) })
    })
    req.on('error', fail)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

test('no token is refused', async () => {
  assert.equal((await call({ path: '/board?path=a.canvas', token: null })).status, 401)
})

test('a wrong token is refused', async () => {
  assert.equal((await call({ path: '/board?path=a.canvas', token: 'nope' })).status, 401)
})

test('the token is accepted as a query parameter, as EventSource needs', async () => {
  await writeFile(join(dir, 'q.canvas'), '{}')
  const res = await call({ path: `/board?path=q.canvas&token=${TOKEN}`, token: null })
  assert.equal(res.status, 200)
})

test('a rebinding Host is refused even with the token', async () => {
  assert.equal((await call({ path: '/board?path=a.canvas', host: 'evil.example:3080' })).status, 403)
})

test('a cross-site Origin is refused even with the token', async () => {
  assert.equal((await call({ path: '/board?path=a.canvas', origin: 'https://evil.example' })).status, 403)
  assert.equal((await call({ path: '/board?path=a.canvas', origin: 'null' })).status, 403)
})

test('a same-origin request passes', async () => {
  await writeFile(join(dir, 'same.canvas'), '{}')
  assert.equal((await call({ path: '/board?path=same.canvas', origin: `http://127.0.0.1:${port}` })).status, 200)
})

test('loopback classification', () => {
  for (const good of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080', 'localhost', '127.1.2.3', 'tessera.localhost:80']) assert.ok(isLoopbackAuthority(good), good)
  for (const bad of ['evil.com', '127.0.0.1.evil.com:80', '10.0.0.1:80', '', undefined, 'localhost.evil.com']) assert.ok(!isLoopbackAuthority(bad), String(bad))
  assert.ok(isLoopbackBind('127.0.0.1'))
  assert.ok(!isLoopbackBind('192.168.0.10'))
})

test('path traversal is refused', async () => {
  for (const path of ['/board?path=../x.canvas', `/board?path=${encodeURIComponent('C:\\x.canvas')}`, '/file/..%2F..%2Fx.txt', '/file/%2Fetc%2Fpasswd']) {
    const res = await call({ path })
    assert.equal(res.status, 400, path)
    assert.equal(JSON.parse(res.body.toString()).error.code, 'bad-path')
  }
})

test('a symlink out of the board folder is refused', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'tessera-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  try {
    await symlink(outside, join(dir, 'escape'), 'junction')
  } catch {
    t.skip('symlinks unavailable here')
    return
  }
  const res = await call({ path: '/file/escape/secret.txt' })
  assert.equal(res.status, 400)
  assert.ok(!res.body.toString().includes('secret"'))
})

test('malformed changes are refused', async () => {
  await writeFile(join(dir, 'bad.canvas'), '{}')
  const send = (change: unknown) => call({ method: 'POST', path: '/board/apply', body: JSON.stringify({ path: 'bad.canvas', clientId: 'c', change }) })
  assert.equal((await send({ nodes: { a: { id: 'other', type: 'text', x: 0, y: 0, width: 1, height: 1 } } })).status, 400)
  assert.equal((await send({ nodes: { a: { id: 'a', type: 'text', x: 'no', y: 0, width: 1, height: 1 } } })).status, 400)
  assert.equal((await send({ edges: { e: { id: 'e', fromNode: 5, toNode: 'a' } } })).status, 400)
  assert.equal((await send({ order: [1] })).status, 400)
  assert.equal((await call({ method: 'POST', path: '/board/apply', body: 'not json' })).status, 400)
})

test('oversized bodies are refused', async () => {
  const res = await call({ method: 'POST', path: '/board/apply', body: JSON.stringify({ pad: 'x'.repeat(4096) }) })
  assert.equal(res.status, 413)
})

test('assets are content addressed and deduplicated', async () => {
  const body = Buffer.from([1, 2, 3, 4])
  const one = JSON.parse((await call({ method: 'POST', path: '/asset?name=photo.png', body, headers: { 'content-type': 'image/png' } })).body.toString())
  const two = JSON.parse((await call({ method: 'POST', path: '/asset?name=copy.png', body })).body.toString())
  assert.equal(one.path, two.path)
  assert.match(one.path, /^_assets\/[0-9a-f]{32}\.png$/)
  assert.deepEqual(await readFile(join(dir, one.path)), body)
  const served = await call({ path: `/file/${one.path}` })
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
  assert.deepEqual(served.body, body)
})

const uploadLeftovers = async () => (await readdir(join(dir, '_assets')).catch(() => [] as string[])).filter(name => name.startsWith('.upload-'))

test('an oversized upload with a declared length gets a 413', async () => {
  const body = Buffer.alloc(4096)
  const res = await call({ method: 'POST', path: '/asset?name=big.bin', body, headers: { 'content-length': String(body.length) } })
  assert.equal(res.status, 413)
  assert.deepEqual(await uploadLeftovers(), [])
})

test('a chunked upload past the limit is cut off and leaves no temp file', async () => {
  // Chunked bodies declare no length, so the connection is cut when the limit is crossed.
  await call({ method: 'POST', path: '/asset?name=big.bin', body: Buffer.alloc(4096) }).catch(() => undefined)
  await new Promise(done => setTimeout(done, 50))
  assert.deepEqual(await uploadLeftovers(), [])
})

test('range requests work for media seeking', async () => {
  const upload = JSON.parse((await call({ method: 'POST', path: '/asset?name=a.mp3', body: Buffer.from('0123456789') })).body.toString())
  const res = await call({ path: `/file/${upload.path}`, headers: { range: 'bytes=2-5' } })
  assert.equal(res.status, 206)
  assert.equal(res.body.toString(), '2345')
  assert.equal(res.headers['content-range'], 'bytes 2-5/10')
  assert.equal((await call({ path: `/file/${upload.path}`, headers: { range: 'bytes=50-60' } })).status, 416)
})

test('html files download instead of rendering on this origin', async () => {
  await writeFile(join(dir, 'page.html'), '<script>alert(1)</script>')
  const res = await call({ path: '/file/page.html' })
  assert.equal(res.headers['content-disposition'], 'attachment')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

test('svg files carry a script-blocking policy', async () => {
  await writeFile(join(dir, 'pic.svg'), '<svg/>')
  const res = await call({ path: '/file/pic.svg' })
  assert.match(String(res.headers['content-security-policy']), /script-src 'none'/)
})

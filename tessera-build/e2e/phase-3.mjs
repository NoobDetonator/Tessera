import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const note = (id, x, y, text = id, extra = {}) => ({ id, type: 'text', x, y, width: 200, height: 64, text, tessera: { kind: 'note' }, ...extra })

// 2,000 cards with Markdown bodies, for the measured performance test.
const big = { nodes: [], edges: [] }
for (let i = 0; i < 2000; i++) {
  big.nodes.push(note(`b${i}`, (i % 50) * 240, Math.floor(i / 50) * 120, `## Card ${i}\n\nSome **markdown** body text for card ${i}.`))
  if (i > 0 && i % 7 === 0) big.edges.push({ id: `be${i}`, fromNode: `b${i - 1}`, toNode: `b${i}` })
}

const app = await launch({
  name: 'phase-3',
  port: 3193,
  seed: {
    'Structure.canvas': {
      nodes: [
        note('a', 0, 0), note('b', 300, 0), note('c', 600, 0), note('d', 900, 0),
        note('e', 0, 300), note('f', 300, 300),
        note('s1', 0, 600, '#ff0000', { tessera: { kind: 'color' } }), note('s2', 300, 600, '#00ff00', { tessera: { kind: 'color' } }),
      ],
      edges: [],
    },
    'Big.canvas': big,
  },
})
const { page } = app
const FILE = 'Structure.canvas'
const card = id => page.locator(`[data-card-id="${id}"]`)
const center = async (locator) => {
  const box = await locator.boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
async function drag(from, to, { shift = false, steps = 8 } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(to.x + 1, to.y + 1)
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
}
const saved = async () => {
  await until(async () => (await page.locator('.t-status').textContent()) === 'Saved', { label: 'saved' })
  await sleep(700)
  return app.readBoard(FILE)
}
const fit = async () => {
  await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('Control+0')
  await sleep(250)
}

try {
  await page.locator('.t-tree-row').filter({ hasText: 'Structure' }).click()
  await until(async () => (await page.locator('[data-card-id]').count()) === 8, { label: 'structure board' })
  await fit()

  // Alignment guides during a drag.
  let from = await center(card('d'))
  let target = await center(card('e'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, target.y + 3, { steps: 6 })
  await page.waitForTimeout(100)
  check('alignment guides show during a drag', (await page.locator('.t-guide').count()) > 0)
  await app.shot('01-guides')
  await page.mouse.move(from.x, from.y, { steps: 4 })
  await page.mouse.up()
  await sleep(200)
  check('guides clear after the drag', (await page.locator('.t-guide').count()) === 0)

  // Shift+drop one card on another makes a Column.
  from = await center(card('b'))
  target = await center(card('a'))
  await drag(from, target, { shift: true })
  await until(async () => (await page.locator('[data-kind="column"]').count()) === 1, { label: 'column from shift-drop' })
  check('Shift+drop on a card creates a Column', true)
  let doc = await saved()
  let column = doc.nodes.find(n => n.tessera?.kind === 'column')
  check('the column holds both cards', column.tessera.items.length === 2 && column.tessera.items.includes('a') && column.tessera.items.includes('b'))
  check('the column draws under its cards', doc.nodes.findIndex(n => n.id === column.id) < doc.nodes.findIndex(n => n.id === 'a'))
  await page.keyboard.press('Control+z')
  await until(async () => (await page.locator('[data-kind="column"]').count()) === 0, { label: 'undo column' })
  check('one undo removes the column and restores the cards', true)
  await page.keyboard.press('Control+Shift+z')
  await until(async () => (await page.locator('[data-kind="column"]').count()) === 1, { label: 'redo column' })
  await fit()

  // Drag a card in, reorder, collapse, drag out.
  doc = await saved()
  column = doc.nodes.find(n => n.tessera?.kind === 'column')
  from = await center(card('c'))
  target = await center(page.locator(`[data-card-id="${column.id}"] .t-column-head`))
  await drag(from, { x: target.x, y: target.y + 2 })
  await until(async () => (app.readBoard(FILE).nodes.find(n => n.id === column.id).tessera.items.length) === 3, { label: 'card dragged into the column', timeout: 5000 })
  doc = app.readBoard(FILE)
  column = doc.nodes.find(n => n.tessera?.kind === 'column')
  check('dragging onto a column adds at the pointer position', column.tessera.items[0] === 'c', column.tessera.items.join())
  const members = column.tessera.items.map(id => doc.nodes.find(n => n.id === id))
  check('members stack without overlap', members.every((m, i) => i === 0 || m.y >= members[i - 1].y + members[i - 1].height))
  check('the column grows to fit', column.height >= members.at(-1).y + members.at(-1).height - column.y)
  await fit()
  from = await center(card('c'))
  const last = await card(members.at(-1).id).boundingBox()
  await drag(from, { x: last.x + last.width / 2, y: last.y + last.height - 2 })
  await until(async () => app.readBoard(FILE).nodes.find(n => n.id === column.id).tessera.items.at(-1) === 'c', { label: 'reorder inside the column', timeout: 5000 })
  check('dragging within a column reorders', true)

  await page.locator(`[data-card-id="${column.id}"] .t-column-head button`).first().click()
  await until(async () => (await card('a').count()) === 0, { label: 'collapse' })
  check('collapse hides the members', true)
  await app.shot('02-collapsed')
  await page.locator(`[data-card-id="${column.id}"] .t-column-head button`).first().click()
  await until(async () => (await card('a').count()) === 1, { label: 'expand' })

  await fit()
  from = await center(card('c'))
  const clear = await page.getByTestId('tessera-canvas').boundingBox()
  await drag(from, { x: clear.x + clear.width - 220, y: clear.y + 60 })
  await until(async () => !app.readBoard(FILE).nodes.find(n => n.id === column.id).tessera.items.includes('c'), { label: 'drag out', timeout: 5000 })
  check('dragging clear of a column takes the card out', true)

  // Moving a column moves its members.
  await fit()
  doc = app.readBoard(FILE)
  const memberBefore = doc.nodes.find(n => n.id === 'a')
  const head = await center(page.locator(`[data-card-id="${column.id}"] .t-group-label`))
  await drag(head, { x: head.x + 40, y: head.y + 40 })
  await until(async () => app.readBoard(FILE).nodes.find(n => n.id === 'a').x !== memberBefore.x, { label: 'member moved with column', timeout: 5000 })
  check('moving a column moves its cards', true)

  // Palette export from a column of swatches.
  await fit()
  await card('s1').click()
  await page.keyboard.down('Shift')
  await card('s2').click()
  await page.keyboard.up('Shift')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Make column' }).click()
  await until(async () => (await page.locator('[data-kind="column"]').count()) === 2, { label: 'palette column' })
  await page.locator('[data-kind="column"]').filter({ has: page.locator('.t-chip') }).getByRole('button', { name: 'CSS', exact: true }).click()
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes('#ff0000'), { label: 'palette on clipboard' })
  const css = await page.evaluate(() => navigator.clipboard.readText())
  check('swatches in a column export as CSS', css.includes(':root') && css.includes('#00ff00'), css)
  await page.locator('[data-kind="column"]').filter({ has: page.locator('.t-chip') }).getByRole('button', { name: 'JSON', exact: true }).click()
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())).trim().startsWith('['), { label: 'json palette' })
  check('and as JSON', JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))[1].hex === '#00ff00')

  // Frame: toolbar, cards move with it, pointers pass through its body.
  await fit()
  const canvasBox = await page.getByTestId('tessera-canvas').boundingBox()
  await card('e').click()
  await page.keyboard.down('Shift')
  await card('f').click()
  await page.keyboard.up('Shift')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Make frame' }).click()
  await until(async () => (await page.locator('[data-kind="frame"]').count()) === 1, { label: 'frame' })
  check('Make frame surrounds the selection', true)
  doc = await saved()
  const frame = doc.nodes.find(n => n.tessera?.kind === 'frame')
  check('the frame draws under its cards', doc.nodes.findIndex(n => n.id === frame.id) < doc.nodes.findIndex(n => n.id === 'e'))
  await fit()
  const title = page.locator(`[data-card-id="${frame.id}"] .t-frame-title`)
  await title.dblclick()
  await page.locator('.t-group-input').fill('Scene one')
  await page.keyboard.press('Enter')
  await until(async () => (await title.textContent()) === 'Scene one', { label: 'frame title' })
  check('a frame can be titled', true)
  const eBefore = app.readBoard(FILE).nodes.find(n => n.id === 'e')
  await sleep(700)
  const titlePoint = await center(title)
  await drag(titlePoint, { x: titlePoint.x + 48, y: titlePoint.y + 32 })
  await until(async () => app.readBoard(FILE).nodes.find(n => n.id === 'e').x !== eBefore.x, { label: 'frame move', timeout: 5000 })
  check('cards move with their frame', true)
  await fit()
  const frameBox = await card(frame.id).boundingBox()
  const beforeNotes = await page.locator('[data-kind="note"]').count()
  await page.mouse.dblclick(frameBox.x + frameBox.width - 8, frameBox.y + frameBox.height - 8)
  await page.locator('.t-editor').waitFor({ timeout: 3000 })
  check('double-click inside a frame creates a note there, not on the frame', true)
  await page.locator('.t-editor').fill('inside the frame')
  await page.mouse.click(canvasBox.x + 4, canvasBox.y + 4)
  await until(async () => (await page.locator('[data-kind="note"]').count()) === beforeNotes + 1, { label: 'note in frame' })
  await app.shot('03-frame-and-columns')

  // Edges.
  await fit()
  await card('d').click()
  const anchor = await center(card('d').locator('.t-anchor-left'))
  const edgeTarget = await center(card('c'))
  await drag(anchor, edgeTarget)
  await until(async () => (await page.locator('[data-edge-id]').count()) === 1, { label: 'edge drawn' })
  check('dragging an anchor to a card draws an edge', true)
  await page.getByTestId('edge-bar').waitFor({ timeout: 3000 })
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Orthogonal' }).click()
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Dashed' }).click()
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Arrow at start' }).click()
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Edge label' }).click()
  await page.locator('.t-dialog input').fill('leads to')
  await page.keyboard.press('Enter')
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Color 5', exact: true }).click()
  doc = await saved()
  const edge = doc.edges[0]
  check('edge style reaches the file', edge.tessera.routing === 'orthogonal' && edge.tessera.dashed === true && edge.fromEnd === 'arrow' && edge.label === 'leads to' && edge.color === '5', JSON.stringify(edge))
  await app.shot('04-edge')
  const pathBefore = await page.locator(`[data-edge-id="${edge.id}"] .t-edge-line`).getAttribute('d')
  await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  from = await center(card('d'))
  await drag(from, { x: from.x, y: from.y + 80 })
  await sleep(150)
  const pathAfter = await page.locator(`[data-edge-id="${edge.id}"] .t-edge-line`).getAttribute('d')
  check('an edge follows its card', pathBefore !== pathAfter)
  await page.keyboard.press('Control+z')
  await sleep(200)
  await page.locator(`[data-edge-id="${edge.id}"] .t-edge-hit`).evaluate((path) => {
    path.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  await page.getByTestId('edge-bar').waitFor({ timeout: 3000 })
  await page.getByTestId('edge-bar').getByRole('button', { name: 'Delete' }).click()
  await until(async () => (await page.locator('[data-edge-id]').count()) === 0, { label: 'edge delete' })
  check('an edge can be deleted', true)

  // Nested boards.
  await fit()
  const tool = await center(page.locator('[data-tool="board"]'))
  await page.locator('[data-tool="board"]').click()
  await page.mouse.click(canvasBox.x + canvasBox.width - 300, canvasBox.y + canvasBox.height - 300)
  await page.locator('.t-dialog input').fill('World')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('[data-kind="board"]').count()) === 1, { label: 'board card' })
  check('the toolbar creates a nested Board card', tool.x > 0)
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'World' }).count()) === 1, { label: 'tree entry' })
  doc = await saved()
  const boardNode = doc.nodes.find(n => n.tessera?.kind === 'board')
  check('the card points at a separate file', boardNode.file === 'World.canvas', boardNode.file)
  const rows = await page.locator('.t-tree-row').evaluateAll(all => all.map(row => [row.textContent, row.style.getPropertyValue('--t-depth')]))
  check('the sidebar nests the child board', rows.some(([text, depth]) => text.includes('World') && depth === '1'), JSON.stringify(rows))

  // Drop a card on the Board card: it moves inside, and one undo brings it back.
  await fit()
  const boardCenter = await center(card(boardNode.id))
  from = await center(card('d'))
  await drag(from, boardCenter)
  await until(async () => (await card('d').count()) === 0, { label: 'card moved into board', timeout: 5000 })
  check('dropping a card on a Board moves it inside', true)
  await until(async () => (await card(boardNode.id).locator('.t-mini-card').count()) === 1, { label: 'live mini preview', timeout: 5000 })
  check('the mini-preview shows it live', true)
  await sleep(800)
  check('the card is in the child file', app.readBoard('World.canvas').nodes.some(n => n.id === 'd'))
  check('and gone from the parent file', !app.readBoard(FILE).nodes.some(n => n.id === 'd'))
  await page.keyboard.press('Control+z')
  await until(async () => (await card('d').count()) === 1, { label: 'undo transfer', timeout: 5000 })
  await sleep(800)
  check('one undo brings it back and clears the child', !app.readBoard('World.canvas').nodes.some(n => n.id === 'd'))
  await page.keyboard.press('Control+Shift+z')
  await until(async () => (await card('d').count()) === 0, { label: 'redo transfer', timeout: 5000 })

  await card(boardNode.id).dblclick()
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'World', { label: 'enter board' })
  check('double-click enters the board', true)
  check('breadcrumbs show the path', (await page.locator('.t-crumb').allTextContents()).join('/') === 'Structure/World')
  await app.shot('05-nested')
  await page.locator('.t-crumb').first().click()
  await until(async () => (await page.locator('.t-crumb').count()) === 1, { label: 'back up' })
  check('a breadcrumb goes back up', (await page.locator('.t-crumb').first().textContent()) === 'Structure')

  // Minimap.
  await until(async () => (await card(boardNode.id).count()) === 1, { label: 'structure reopened' })
  const worldBefore = await page.locator('.t-world').getAttribute('style')
  const map = await page.getByTestId('minimap').boundingBox()
  await page.mouse.click(map.x + 8, map.y + 8)
  await sleep(100)
  check('clicking the minimap moves the view', (await page.locator('.t-world').getAttribute('style')) !== worldBefore)

  // Keyboard.
  await fit()
  await page.getByTestId('tessera-canvas').focus()
  await page.keyboard.press('Tab')
  const firstSelected = await page.locator('.t-selected').count()
  await page.keyboard.press('Tab')
  check('Tab walks through cards', firstSelected === 1 && (await page.locator('.t-selected').count()) === 1)

  const errors = validateCanvas(app.readBoard(FILE))
  check('the structured board is still valid JSON Canvas', errors.length === 0, errors.join('; '))

  // ── Measured performance: 2,000 cards ──
  await page.locator('.t-tree-row').filter({ hasText: 'Big' }).click()
  const openStart = Date.now()
  await until(async () => (await page.locator('[data-card-id]').count()) > 0, { label: 'big board', timeout: 60000 })
  const openMs = Date.now() - openStart
  await sleep(1500)
  const fitCount = await page.locator('[data-card-id]').count()
  const lodCount = await page.locator('.t-lod').count()
  check('a far-zoomed board draws cards as plain boxes', lodCount > 0, `${lodCount} of ${fitCount}`)

  // Zoom in on one spot: off-screen cards must leave the DOM.
  const zoomIn = async () => page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="tessera-canvas"]')
    const rect = canvas.getBoundingClientRect()
    for (let i = 0; i < 30; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: rect.left + 200, clientY: rect.top + 200, bubbles: true, cancelable: true }))
  })
  await zoomIn()
  await sleep(1500)
  const closeCount = await page.locator('[data-card-id]').count()
  check('virtualization keeps most of 2,000 cards out of the DOM', closeCount < 200, String(closeCount))

  /** Frame times while panning continuously for about two seconds. */
  const measurePan = () => page.evaluate(() => new Promise((done) => {
    const canvas = document.querySelector('[data-testid="tessera-canvas"]')
    const times = []
    let last = performance.now(), frames = 0
    const tick = (now) => {
      times.push(now - last)
      last = now
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 7.5, deltaY: 3.5, bubbles: true, cancelable: true }))
      if (++frames < 120) requestAnimationFrame(tick)
      else {
        times.sort((a, b) => a - b)
        done({ median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], worst: times.at(-1) })
      }
    }
    requestAnimationFrame(tick)
  }))
  const closePan = await measurePan()
  await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('Control+0')
  await sleep(1500)
  const farPan = await measurePan()
  await app.shot('06-two-thousand')

  // Edit latency with the whole board open: one keystroke-equivalent commit must not repaint every card.
  await zoomIn()
  await sleep(1000)
  const commitMs = await page.evaluate(() => new Promise((done) => {
    const first = document.querySelector('[data-kind="note"]')
    const start = performance.now()
    first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: first.getBoundingClientRect().left + 5, clientY: first.getBoundingClientRect().top + 5 }))
    first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    requestAnimationFrame(() => requestAnimationFrame(() => { done(performance.now() - start) }))
  }))
  const numbers = {
    cards: 2000,
    edges: big.edges.length,
    openToFirstCardMs: openMs,
    domCardsZoomedOut: fitCount,
    domCardsZoomedIn: closeCount,
    panZoomedIn: closePan,
    panZoomedOut: farPan,
    selectClickToNextPaintMs: commitMs,
  }
  console.log('PERF', JSON.stringify(numbers))
  writeFileSync(join(app.runDir, 'perf.json'), JSON.stringify(numbers, null, 2))
  check('panning zoomed in stays near 60 fps (median under 20 ms)', closePan.median < 20, JSON.stringify(closePan))
  check('panning the whole board zoomed out stays usable (median under 34 ms)', farPan.median < 34, JSON.stringify(farPan))

  check('no console errors', app.problems.length === 0, app.problems.join('\n'))
} catch (error) {
  check(`script finished: ${error.message}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(app.problems.join('\n'))
  writeFileSync(join(app.runDir, 'failure.txt'), String(error.stack))
} finally {
  await app.stop()
  summarize()
}

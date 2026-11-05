import { validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const app = await launch({ name: 'phase-1', port: 3191 })
const { page } = app
try {
  page.on('dialog', d => d.accept('Smoke Board'))
  await app.shot('01-empty')
  await page.getByRole('button', { name: 'Create a board' }).click()
  const canvas = page.getByTestId('tessera-canvas')
  await canvas.waitFor()
  check('board created and opened', await page.locator('.t-crumb').last().textContent() === 'Smoke Board')

  // 20 notes via double-click and typing.
  const box = await canvas.boundingBox()
  for (let i = 0; i < 20; i++) {
    const x = box.x + 150 + (i % 4) * 215
    const y = box.y + 60 + Math.floor(i / 4) * 130
    await page.mouse.dblclick(x, y)
    const editor = page.locator('.t-editor')
    await editor.waitFor({ timeout: 3000 })
    await editor.fill(`# Note ${i}\n\nBody of **note** ${i}`)
    await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10)
    await page.locator('.t-editor').waitFor({ state: 'detached', timeout: 3000 })
  }
  await until(async () => (await page.locator('.t-kind-note').count()) === 20, { label: '20 notes rendered' })
  check('20 notes on the canvas', true)
  check('markdown renders', (await page.locator('.t-kind-note strong').count()) === 20)
  await app.shot('02-twenty-notes')

  await until(async () => (await page.locator('.t-status').textContent()) === 'Saved', { label: 'saved state' })
  await sleep(800)
  const file = 'Smoke Board.canvas'
  const saved = app.readBoard(file)
  check('file has 20 nodes', saved.nodes.length === 20, String(saved.nodes.length))
  const errors = validateCanvas(saved)
  check('file passes the strict validator', errors.length === 0, errors.join('; '))

  // Reload the whole page: notes must come back from disk through the Host.
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: 'Tessera' }).first().click({ timeout: 15000 })
  await until(async () => (await page.locator('.t-kind-note').count()) === 20, { label: 'notes after reload', timeout: 15000 })
  check('20 notes survive a reload', true)
  check('note text intact after reload', (await page.locator('.t-kind-note').filter({ hasText: 'Note 7' }).count()) === 1)

  // Selection and drag with undo as one step.
  const first = page.locator('.t-card').first()
  const before = await first.boundingBox()
  await page.mouse.move(before.x + 40, before.y + 20)
  await page.mouse.down()
  await page.mouse.move(before.x + 140, before.y + 120, { steps: 6 })
  await page.mouse.up()
  const after = await first.boundingBox()
  check('drag moves the card', Math.abs(after.x - before.x) > 50 && Math.abs(after.y - before.y) > 50)
  await page.keyboard.press('Control+z')
  await until(async () => Math.abs((await first.boundingBox()).x - before.x) < 2, { label: 'undo of drag' })
  check('one undo reverts the drag', true)
  await page.keyboard.press('Control+Shift+z')
  await until(async () => Math.abs((await first.boundingBox()).x - before.x) > 50, { label: 'redo of drag' })
  check('redo reapplies the drag', true)

  // Select all, delete, undo.
  await page.keyboard.press('Control+a')
  check('select all', (await page.locator('.t-selected').count()) === 20)
  await page.keyboard.press('Delete')
  await until(async () => (await page.locator('.t-kind-note').count()) === 0, { label: 'delete all' })
  check('delete removes cards', true)
  await page.keyboard.press('Control+z')
  await until(async () => (await page.locator('.t-kind-note').count()) === 20, { label: 'undo delete' })
  check('undo restores deleted cards', true)

  // External edit with unknown fields arrives live and stays on save.
  await sleep(800)
  const onDisk = app.readBoard(file)
  onDisk.alienRoot = { keep: 1 }
  onDisk.nodes[0].alienField = 'survive'
  onDisk.nodes.push({ id: 'fromdisk', type: 'text', x: 0, y: 100, width: 240, height: 60, text: 'added on disk' })
  app.writeBoard(file, onDisk)
  await until(async () => (await page.locator('.t-kind-note').filter({ hasText: 'added on disk' }).count()) === 1, { label: 'external edit shown' })
  check('external edit shows up live', true)
  await page.keyboard.press('Control+0')
  await sleep(200)
  await page.locator('.t-kind-note').filter({ hasText: 'added on disk' }).click({ timeout: 3000 })
  await page.keyboard.press('ArrowRight')
  await sleep(1000)
  const merged = app.readBoard(file)
  check('unknown root field preserved', merged.alienRoot?.keep === 1)
  check('unknown node field preserved', merged.nodes.some(n => n.alienField === 'survive'))
  check('still valid after merge', validateCanvas(merged).length === 0, validateCanvas(merged).join('; '))

  // Degradation: open a board written with no metadata at all.
  app.writeBoard('Plain.canvas', {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 250, height: 80, text: '- [ ] one\n- [x] two' },
      { id: 'b', type: 'text', x: 300, y: 0, width: 120, height: 80, text: '#ff8800' },
      { id: 'c', type: 'text', x: 500, y: 0, width: 250, height: 80, text: 'plain words' },
      { id: 'g', type: 'group', x: 0, y: 200, width: 300, height: 400, label: 'Stack' },
      { id: 'd', type: 'text', x: 20, y: 240, width: 250, height: 60, text: 'in stack 1' },
      { id: 'e', type: 'text', x: 20, y: 320, width: 250, height: 60, text: 'in stack 2' },
      { id: 'w', type: 'mystery', x: 800, y: 0, width: 200, height: 100, future: true },
    ],
    edges: [],
  })
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'Plain' }).count()) === 1, { label: 'new file in sidebar' })
  await page.locator('.t-tree-row').filter({ hasText: 'Plain' }).click()
  await until(async () => (await page.locator('[data-card-id]').count()) === 7, { label: 'plain board cards' })
  check('metadata-free board opens', true)
  check('To-do by rule', await page.locator('[data-card-id="a"]').getAttribute('data-kind') === 'todo')
  check('Color by rule', await page.locator('[data-card-id="b"]').getAttribute('data-kind') === 'color')
  check('Note by rule', await page.locator('[data-card-id="c"]').getAttribute('data-kind') === 'note')
  check('Column by rule', await page.locator('[data-card-id="g"]').getAttribute('data-kind') === 'column')
  check('unknown node type shows as Note', await page.locator('[data-card-id="w"]').getAttribute('data-kind') === 'note')
  await app.shot('03-plain-board')
  await sleep(1000)
  const plain = app.readBoard('Plain.canvas')
  check('opening a plain board does not rewrite it', plain.nodes.every(n => n.tessera === undefined) && plain.nodes.find(n => n.id === 'g').height === 400 && plain.nodes.find(n => n.id === 'd').height === 60)

  check('no console errors', app.problems.length === 0, app.problems.join('\n'))
} catch (error) {
  check(`script finished: ${error.message}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(app.problems.join('\n'))
} finally {
  await app.stop()
  summarize()
}

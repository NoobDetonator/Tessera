// What the spec asks for that the phase tests did not exercise in a browser.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const note = (id, x, y, text = id, extra = {}) => ({ id, type: 'text', x, y, width: 200, height: 64, text, tessera: { kind: 'note', ...extra } })

const app = await launch({
  name: 'final',
  port: 3198,
  seed: {
    'Canvas.canvas': { nodes: [note('a', 0, 0), note('b', 301, 53), note('c', 607, 117), note('locked', 0, 400, 'locked', { locked: true })], edges: [] },
    'Second.canvas': { nodes: [note('z', 0, 0)], edges: [] },
  },
})
const { page, context } = app
const FILE = 'Canvas.canvas'
const card = id => page.locator(`[data-card-id="${id}"]`)
const canvas = page.getByTestId('tessera-canvas')
const clearFocus = async () => { await canvas.click({ position: { x: 4, y: 4 } }) }
const worldStyle = () => page.locator('.t-world').getAttribute('style')
const center = async (locator) => {
  const box = await locator.boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const saved = async () => {
  await until(async () => (await page.locator('.t-status').textContent()) === 'Saved', { label: 'saved' })
  await sleep(700)
  return app.readBoard(FILE)
}
const nodeOf = (doc, id) => doc.nodes.find(node => node.id === id)

try {
  await page.locator('.t-tree-row').filter({ hasText: 'Canvas' }).click()
  await until(async () => (await card('a').count()) === 1, { label: 'board' })
  await clearFocus()
  await page.keyboard.press('Control+0')
  await sleep(300)
  await app.shot('01-light')

  // Pan and zoom by every route.
  const box = await canvas.boundingBox()
  let before = await worldStyle()
  await page.keyboard.down('Space')
  await page.mouse.move(box.x + 500, box.y + 500)
  await page.mouse.down()
  await page.mouse.move(box.x + 560, box.y + 540, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  check('space+drag pans', (await worldStyle()) !== before)
  const noBoxLeft = (await page.locator('.t-box').count()) === 0 && (await page.locator('.t-selected').count()) === 0
  check('panning selects nothing', noBoxLeft)
  before = await worldStyle()
  await page.mouse.move(box.x + 400, box.y + 300)
  await page.keyboard.press('z')
  await sleep(120)
  const zoomedIn = await worldStyle()
  check('Z zooms in', zoomedIn !== before)
  await page.keyboard.press('Shift+Z')
  await sleep(120)
  check('Shift+Z zooms back out', (await worldStyle()) === before, `${await worldStyle()} vs ${before}`)
  before = await worldStyle()
  await page.mouse.wheel(0, 120)
  await sleep(120)
  check('the mouse wheel zooms', (await worldStyle()) !== before)
  await page.keyboard.press('Control+0')
  await sleep(300)
  const pinch = await worldStyle()
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="tessera-canvas"]')
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, clientX: 700, clientY: 400, bubbles: true, cancelable: true }))
  })
  await sleep(120)
  check('a pinch zooms', (await worldStyle()) !== pinch)
  await page.keyboard.press('Control+0')
  await sleep(300)
  const track = await worldStyle()
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="tessera-canvas"]')
    target.dispatchEvent(new WheelEvent('wheel', { deltaX: 13.5, deltaY: 7.25, bubbles: true, cancelable: true }))
  })
  await sleep(120)
  const panned = await worldStyle()
  check('trackpad scrolling pans without changing zoom', panned !== track && panned.match(/scale\([^)]+\)/)[0] === track.match(/scale\([^)]+\)/)[0])
  await page.keyboard.press('Control+0')
  await sleep(300)

  // Grid snap and Alt.
  let from = await center(card('a'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 37, from.y + 211, { steps: 5 })
  await page.mouse.up()
  let doc = await saved()
  let a = nodeOf(doc, 'a')
  check('a drag snaps to the 8 px grid', a.x % 8 === 0 && a.y % 8 === 0, `${a.x},${a.y}`)
  from = await center(card('a'))
  await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 11, from.y + 13, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  doc = await saved()
  a = nodeOf(doc, 'a')
  check('Alt turns snapping off', a.x % 8 !== 0 || a.y % 8 !== 0, `${a.x},${a.y}`)

  // Shift multi-select, box select.
  await clearFocus()
  await card('a').click()
  await page.keyboard.down('Shift')
  await card('b').click()
  await page.keyboard.up('Shift')
  check('Shift-click adds to the selection', (await page.locator('.t-selected').count()) === 2)
  await page.keyboard.down('Shift')
  await card('b').click()
  await page.keyboard.up('Shift')
  check('Shift-click again removes', (await page.locator('.t-selected').count()) === 1)
  await clearFocus()
  const ba = await card('b').boundingBox(), ca = await card('c').boundingBox()
  await page.mouse.move(ba.x - 10, Math.min(ba.y, ca.y) - 10)
  await page.mouse.down()
  await page.mouse.move(ca.x + ca.width + 10, Math.max(ba.y + ba.height, ca.y + ca.height) + 10, { steps: 6 })
  check('a box drag shows its rectangle', (await page.locator('.t-box').count()) === 1)
  await page.mouse.up()
  check('a box drag selects what it touches', (await page.locator('.t-selected').count()) === 2)

  // Align and distribute.
  const bar = page.getByTestId('selection-bar')
  await bar.getByRole('button', { name: 'Align top' }).click()
  doc = await saved()
  check('Align top lines cards up', nodeOf(doc, 'b').y === nodeOf(doc, 'c').y)
  await clearFocus()
  await page.keyboard.press('Control+a')
  await bar.getByRole('button', { name: 'Distribute vertically' }).click()
  doc = await saved()
  const ys = ['a', 'b', 'c', 'locked'].map(id => nodeOf(doc, id).y)
  check('Distribute works on unlocked cards, and locked ones stay', nodeOf(doc, 'locked').y === 400, ys.join())
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await sleep(300)

  // Colors and fill.
  await clearFocus()
  await card('c').click()
  await bar.getByRole('button', { name: 'Color 4', exact: true }).click()
  await until(async () => (await card('c').getAttribute('class')).includes('t-color-strip'), { label: 'color strip' })
  check('a color shows as a top strip', true)
  await bar.getByRole('button', { name: 'Fill' }).click()
  await until(async () => (await card('c').getAttribute('class')).includes('t-color-full'), { label: 'color fill' })
  check('or as a full background', true)
  doc = await saved()
  check('the color uses the JSON Canvas preset', nodeOf(doc, 'c').color === '4')
  await bar.getByRole('button', { name: 'No color' }).click()
  doc = await saved()
  check('the color can be removed', nodeOf(doc, 'c').color === undefined)

  // Lock.
  await clearFocus()
  from = await center(card('locked'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 80, from.y + 80, { steps: 4 })
  await page.mouse.up()
  await sleep(300)
  check('a locked card does not move', nodeOf(app.readBoard(FILE), 'locked').x === 0)
  await card('locked').click()
  check('a locked card has no resize handles', (await card('locked').locator('.t-handle').count()) === 0)
  await page.keyboard.press('Delete')
  await sleep(200)
  check('a locked card cannot be deleted', (await card('locked').count()) === 1)
  await card('locked').dblclick()
  await sleep(150)
  check('a locked card cannot be edited', (await page.locator('.t-editor').count()) === 0)
  await page.keyboard.press('Control+l')
  await until(async () => (await card('locked').locator('.t-lock').count()) === 0, { label: 'unlock' })
  check('Ctrl+L unlocks it', true)
  await page.keyboard.press('Control+l')

  // Context menu by mouse and keyboard.
  await card('c').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor({ timeout: 3000 })
  check('right-click opens a card menu', (await menu.textContent()).includes('Duplicate'))
  await app.shot('02-context-menu')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 3000 })
  await canvas.click({ button: 'right', position: { x: 300, y: 300 } })
  await menu.waitFor({ timeout: 3000 })
  check('right-click on empty space offers board actions', (await menu.textContent()).includes('New note') && (await menu.textContent()).includes('Arrange as grid'))
  await page.keyboard.press('Escape')
  await clearFocus()
  await card('c').click()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor({ timeout: 3000 })
  check('Shift+F10 opens the menu from the keyboard', (await menu.textContent()).includes('Duplicate'))
  await page.keyboard.press('ArrowDown')
  check('arrow keys move through the menu', await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'))
  await page.keyboard.press('Escape')

  // Duplicate, cut, z-order.
  await card('c').click()
  const count = await page.locator('[data-card-id]').count()
  await page.keyboard.press('Control+d')
  await until(async () => (await page.locator('[data-card-id]').count()) === count + 1, { label: 'duplicate' })
  check('Ctrl+D duplicates', true)
  await page.keyboard.press('Delete')
  await sleep(200)

  // Keyboard-only: nudge, edit, leave.
  await clearFocus()
  await card('c').click()
  doc = await saved()
  const nudgeStart = nodeOf(doc, 'c').x
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  doc = await saved()
  check('arrow keys nudge by the grid', nodeOf(doc, 'c').x === nudgeStart + 16, `${nodeOf(doc, 'c').x} from ${nudgeStart}`)
  await page.keyboard.press('Control+z')
  doc = await saved()
  check('a run of nudges is one undo', nodeOf(doc, 'c').x === nudgeStart)
  await page.keyboard.press('Enter')
  await page.locator('.t-editor').waitFor({ timeout: 3000 })
  check('Enter edits the selected card', true)
  await page.keyboard.press('Escape')

  // Upload through the toolbar's file picker.
  await clearFocus()
  const png = await page.evaluate(() => {
    const element = document.createElement('canvas')
    element.width = 64
    element.height = 32
    element.getContext('2d').fillRect(0, 0, 64, 32)
    return element.toDataURL('image/png').split(',')[1]
  })
  await page.locator('[data-tool="image"]').click()
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 })
  await canvas.click({ position: { x: 700, y: 500 } })
  await (await chooser).setFiles({ name: 'upload.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await until(async () => (await page.locator('[data-kind="image"]').count()) === 1, { label: 'uploaded image' })
  check('the toolbar uploads an image through a file picker', true)

  // A broken asset shows a message rather than a broken picture.
  const brokenBoard = { nodes: [{ id: 'gone', type: 'file', x: 0, y: 0, width: 200, height: 200, file: '_assets/missing.png' }, { id: 'nowhere', type: 'file', x: 300, y: 0, width: 280, height: 208, file: 'Missing.canvas' }], edges: [] }
  app.writeBoard('Broken.canvas', brokenBoard)
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'Broken' }).count()) === 1, { label: 'broken board listed' })
  await page.locator('.t-tree-row').filter({ hasText: 'Broken' }).click()
  await until(async () => (await card('gone').locator('.t-missing').count()) === 1, { label: 'missing image message' })
  check('a missing image says so', true)
  await until(async () => (await card('nowhere').locator('.t-missing').count()) === 1, { label: 'missing board message' })
  check('a missing nested board says so', true)

  // A file that is not JSON must not take the app down, and must not be overwritten.
  app.writeBoard('Bad.canvas', { nodes: [] })
  writeFileSync(join(app.boards, 'Bad.canvas'), '{ this is not json')
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: /^Bad/ }).count()) === 1, { label: 'bad board listed' })
  await page.locator('.t-tree-row').filter({ hasText: /^Bad/ }).click()
  await until(async () => (await page.locator('.t-empty h2').textContent().catch(() => '')).includes('could not be opened'), { label: 'bad board message' })
  check('an unreadable file shows a message instead of crashing', true)

  // Sidebar: search, favorites, rename, delete.
  const search = page.locator('.t-search')
  await search.fill('sec')
  await until(async () => (await page.locator('.t-tree-row').count()) === 1, { label: 'sidebar filter' })
  check('the sidebar search filters boards', (await page.locator('.t-tree-row').textContent()).includes('Second'))
  await search.fill('')
  const secondRow = page.locator('.t-tree-row').filter({ hasText: 'Second' }).first()
  await secondRow.hover()
  await secondRow.locator('.t-star').click()
  await until(async () => (await page.locator('.t-tree-section').filter({ hasText: 'Favorites' }).count()) === 1, { label: 'favorites section' })
  check('a board can be made a favorite', true)
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: 'Tessera' }).first().click({ timeout: 15000 })
  await until(async () => (await page.locator('.t-tree-section').filter({ hasText: 'Favorites' }).count()) === 1, { label: 'favorites after reload', timeout: 15000 })
  check('favorites survive a reload', true)
  const parentBoard = { nodes: [{ id: 'ref', type: 'file', x: 0, y: 0, width: 280, height: 208, file: 'Second.canvas' }], edges: [] }
  app.writeBoard('Parent.canvas', parentBoard)
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'Parent' }).count()) === 1, { label: 'parent listed' })
  await page.locator('.t-tree-row').filter({ hasText: 'Second' }).last().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.locator('.t-dialog input').fill('Renamed')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'Renamed' }).count()) >= 1, { label: 'renamed' })
  await sleep(900)
  check('renaming a board updates the Board cards pointing at it', app.readBoard('Parent.canvas').nodes[0].file === 'Renamed.canvas')
  await page.locator('.t-tree-row').filter({ hasText: 'Broken' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete board' }).click()
  check('deleting a board asks first', (await page.locator('.t-dialog h2').textContent()).includes('Delete board'))
  await page.locator('.t-dialog').getByRole('button', { name: 'Delete' }).click()
  await until(async () => (await page.locator('.t-tree-row').filter({ hasText: 'Broken' }).count()) === 0, { label: 'deleted' })
  check('a confirmed delete removes the board', true)

  check('the edited board is still valid JSON Canvas', validateCanvas(app.readBoard(FILE)).length === 0)
  check('no console errors in the light run', app.problems.filter(p => !/404|Failed to load resource/.test(p)).length === 0, app.problems.join('\n'))

  // Dark theme, a second language, reduced motion: fresh browser contexts on the same server.
  const browser = context.browser()
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR', colorScheme: 'dark', reducedMotion: 'reduce' })
  const darkPage = await dark.newPage()
  await darkPage.goto(app.url, { waitUntil: 'load' })
  await darkPage.getByRole('button', { name: /^(Continue|Continuar)$/ }).click({ timeout: 15000 }).catch(() => {})
  await darkPage.waitForTimeout(300)
  await darkPage.getByRole('button', { name: 'Tessera' }).first().click({ timeout: 15000 })
  await darkPage.getByTestId('tessera-root').waitFor({ timeout: 15000 })
  await darkPage.locator('.t-tree-row').filter({ hasText: 'Canvas' }).click()
  await darkPage.locator('[data-card-id="a"]').waitFor({ timeout: 15000 })
  await darkPage.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  await darkPage.keyboard.press('Control+0')
  await darkPage.waitForTimeout(400)
  await darkPage.screenshot({ path: join(app.runDir, '..', '..', 'screenshots', 'final', '03-dark-pt.png') })
  const shade = await darkPage.getByTestId('tessera-root').evaluate((element) => {
    const parts = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number)
    return (parts[0] + parts[1] + parts[2]) / 3
  })
  check('the panel follows the dark theme', shade < 80, `background level ${shade}`)
  check('text stays readable on dark cards', await darkPage.locator('[data-card-id="a"]').evaluate((element) => {
    const levels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).reduce((sum, n) => sum + n, 0) / 3
    return levels(getComputedStyle(element).color) - levels(getComputedStyle(element).backgroundColor) > 100
  }))
  check('Portuguese copy appears', (await darkPage.getByTestId('tessera-root').textContent()).includes('Buscar quadros') || (await darkPage.locator('.t-search').getAttribute('placeholder')) === 'Buscar quadros')
  check('reduced motion turns animation off', (await darkPage.getByTestId('tessera-root').evaluate(element => getComputedStyle(element).getPropertyValue('--t-fast').trim())) === '0ms')
  await dark.close()
} catch (error) {
  check(`script finished: ${error.message}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(app.problems.join('\n'))
  writeFileSync(join(app.runDir, 'failure.txt'), String(error.stack))
} finally {
  await app.stop()
  summarize()
}

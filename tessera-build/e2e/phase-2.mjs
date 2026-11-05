import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

// A real 2x2 PNG, so image decoding and the natural-size path are exercised.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')

const app = await launch({ name: 'phase-2', port: 3192, seed: { 'Cards.canvas': { nodes: [], edges: [] } } })
const { page } = app
const FILE = 'Cards.canvas'
const kindCount = kind => page.locator(`[data-kind="${kind}"]`).count()
const saved = async () => {
  await until(async () => (await page.locator('.t-status').textContent()) === 'Saved', { label: 'saved' })
  await sleep(700)
  return app.readBoard(FILE)
}

/** Paste through a real ClipboardEvent, the path the browser uses for Ctrl+V. */
const paste = (payload) => page.evaluate(({ text, png }) => {
  const data = new DataTransfer()
  if (text !== undefined) data.setData('text/plain', text)
  if (png !== undefined) {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
    data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
  }
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}, payload)

/** Drop OS files on the canvas through a real DragEvent. */
const dropFile = (name, type, base64, at) => page.evaluate(({ name, type, base64, at }) => {
  const data = new DataTransfer()
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  data.items.add(new File([bytes], name, { type }))
  const target = document.querySelector('[data-testid="tessera-canvas"]')
  for (const kind of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(kind, { dataTransfer: data, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
}, { name, type, base64, at })

try {
  await page.locator('.t-tree-row').filter({ hasText: 'Cards' }).click()
  const canvas = page.getByTestId('tessera-canvas')
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  const point = (x, y) => ({ x: box.x + x, y: box.y + y })
  await page.mouse.move(box.x + 500, box.y + 400)

  // Toolbar: click arms, next canvas click places.
  await page.locator('[data-tool="color"]').click()
  check('toolbar arms placement', await page.locator('[data-tool="color"]').getAttribute('aria-pressed') === 'true')
  await page.mouse.click(box.x + 120, box.y + 40)
  await until(async () => (await kindCount('color')) === 1, { label: 'color placed' })
  check('click to place a Color card', true)

  // Toolbar: drag onto the canvas.
  const tool = await page.locator('[data-tool="todo"]').boundingBox()
  await page.mouse.move(tool.x + 10, tool.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 330, box.y + 60, { steps: 5 })
  await page.mouse.up()
  await until(async () => (await kindCount('todo')) === 1, { label: 'todo placed' })
  check('drag from the toolbar places a To-do card', true)

  // To-do: type, add, check, due date, progress, reorder.
  const todo = page.locator('[data-kind="todo"]')
  await todo.locator('.t-todo-text').first().fill('First task')
  await page.keyboard.press('Enter')
  await until(async () => (await todo.locator('.t-todo-text').count()) === 2, { label: 'second item' })
  await page.keyboard.type('Second task')
  await todo.locator('input[type="checkbox"]').first().check()
  await until(async () => (await todo.locator('.t-todo-progress span').textContent()) === '1/2', { label: 'progress' })
  check('checklist shows progress 1/2', true)
  await todo.locator('.t-todo-due').nth(1).fill('2026-12-25')
  await todo.locator('.t-todo-text').nth(1).focus()
  await page.keyboard.press('Alt+ArrowUp')
  let doc = await saved()
  const todoText = doc.nodes.find(n => n.tessera?.kind === 'todo').text
  check('reorder and due date reach the file', todoText === '- [ ] Second task 📅 2026-12-25\n- [x] First task', JSON.stringify(todoText))

  // Paste: text, URL, color, image.
  await page.mouse.move(box.x + 650, box.y + 60)
  await paste({ text: 'pasted words' })
  await until(async () => (await page.locator('[data-kind="note"]').filter({ hasText: 'pasted words' }).count()) === 1, { label: 'pasted note' })
  check('pasted text becomes a Note', true)
  await page.mouse.move(box.x + 150, box.y + 300)
  await paste({ text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
  await until(async () => (await kindCount('link')) === 1, { label: 'pasted link' })
  check('pasted URL becomes a Link', true)
  check('a video link offers inline play', (await page.locator('[data-kind="link"] .t-play').count()) === 1)
  // A real preview through ctx.web.fetch. Needs network; the page is a stable public test page.
  await page.mouse.move(box.x + 350, box.y + 300)
  await paste({ text: 'https://example.com/' })
  await until(async () => (await page.locator('[data-kind="link"]').filter({ hasText: 'Example Domain' }).count()) === 1, { label: 'open graph preview', timeout: 20000 })
  check('a link preview arrives through ctx.web.fetch', true)
  await page.mouse.move(box.x + 520, box.y + 330)
  await paste({ text: '#123456' })
  await until(async () => (await kindCount('color')) === 2, { label: 'pasted color' })
  check('a pasted hex becomes a Color', true)
  await page.mouse.move(box.x + 720, box.y + 330)
  // A realistically sized image, made in the page so the test carries no binary fixture.
  const bigPng = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 200
    const context = canvas.getContext('2d')
    context.fillStyle = '#3388cc'
    context.fillRect(0, 0, 300, 200)
    context.fillStyle = '#ffcc00'
    context.fillRect(40, 40, 100, 80)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await paste({ png: bigPng })
  await until(async () => (await kindCount('image')) === 1, { label: 'pasted image' })
  check('a pasted image becomes an Image', true)
  await until(async () => page.locator('[data-kind="image"] img').evaluate(img => img.complete && img.naturalWidth === 300), { label: 'image loads through the bridge' })
  check('the image loads through the authenticated file route', true)
  const assets = readdirSync(join(app.boards, '_assets'))
  check('the asset is named by content hash', assets.some(name => /^[0-9a-f]{32}\.png$/.test(name)), assets.join())

  // Drop OS files.
  await dropFile('song.mp3', 'audio/mpeg', 'AAAA', point(150, 620))
  await until(async () => (await page.locator('[data-kind="file"] audio').count()) === 1, { label: 'audio card' })
  check('a dropped audio file gets a player', true)
  await dropFile('clip.mp4', 'video/mp4', 'AAAA', point(500, 560))
  await until(async () => (await page.locator('[data-kind="file"] video').count()) === 1, { label: 'video card' })
  check('a dropped video file gets a player', true)
  await dropFile('paper.pdf', 'application/pdf', 'JVBERi0xLjQK', point(10, 10))
  await until(async () => (await page.locator('[data-kind="file"] embed').count()) === 1, { label: 'pdf card' })
  check('a dropped PDF gets an embed (rendering is not verifiable here: headless Chromium has no PDF viewer)', true)
  await dropFile('notes.zip', 'application/zip', 'UEsDBA==', point(800, 620))
  await until(async () => (await page.locator('[data-kind="file"]').filter({ hasText: 'notes.zip' }).count()) === 1, { label: 'generic card' })
  check('any other file gets a generic card', true)
  await dropFile('photo.png', 'image/png', PNG.toString('base64'), point(860, 480))
  await until(async () => (await kindCount('image')) >= 1, { label: 'dropped image' })
  check('a dropped image file gets an Image card', true)

  // Image: aspect-locked resize, lightbox, caption. Use a seeded image so it sizes predictably.
  doc = await saved()
  const imageNode = doc.nodes.find(n => n.tessera?.kind === 'image')
  const image = page.locator(`[data-card-id="${imageNode.id}"]`)
  // Canvas shortcuts deliberately do nothing while a text field has focus, so leave the checklist field first.
  await page.mouse.click(box.x + box.width - 5, box.y + box.height - 5)
  await page.keyboard.press('Control+0')
  await sleep(300)
  await image.click({ force: true })
  await image.locator('.t-handle-se').waitFor({ timeout: 3000 })
  const startBox = await image.boundingBox()
  const anchorHit = await image.locator('.t-anchor-right').evaluate((anchor) => {
    const rect = anchor.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { same: hit === anchor, hit: hit === null ? 'none' : `${hit.tagName}.${hit.className}`, rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round), card: anchor.parentElement.dataset.cardId, overflow: getComputedStyle(anchor.parentElement).overflow, parentClass: anchor.parentElement.className }
  })
  check('connection anchors are reachable on a fixed-size card', anchorHit.same, JSON.stringify(anchorHit))
  await app.shot('01b-selected-image')
  const handle = await image.locator('.t-handle-se').boundingBox()
  const grabX = handle.x + handle.width / 2, grabY = handle.y + handle.height / 2
  await page.mouse.move(grabX, grabY)
  await page.mouse.down()
  await page.mouse.move(grabX + 45, grabY + 12, { steps: 4 })
  await page.mouse.up()
  const sized = await image.boundingBox()
  check('resize changes the image', sized.width > startBox.width + 5)
  check('resize keeps the aspect ratio', Math.abs(sized.width / sized.height - startBox.width / startBox.height) < 0.03, `${sized.width}x${sized.height} from ${startBox.width}x${startBox.height}`)
  await image.dblclick({ force: true })
  await page.locator('.t-lightbox').waitFor({ timeout: 3000 })
  check('double-click opens the lightbox', true)
  await app.shot('02-lightbox')
  await page.locator('.t-lightbox-caption').fill('A tiny test image')
  await page.keyboard.press('Escape')
  await page.locator('.t-lightbox').waitFor({ state: 'detached', timeout: 3000 })
  await until(async () => (await image.locator('figcaption').textContent().catch(() => '')) === 'A tiny test image', { label: 'caption' })
  check('the caption shows on the card', true)

  // Document: full-width editor.
  await page.locator('[data-tool="document"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('.t-docedit').waitFor({ timeout: 3000 })
  check('keyboard places a Document and opens its editor', true)
  await page.locator('.t-docedit-title').fill('Design notes')
  await page.locator('.t-docedit-panes textarea').fill('## Goals\n\nShip **Tessera** on time.\n\n| a | b |\n|---|---|\n| 1 | 2 |')
  await until(async () => (await page.locator('.t-docedit-preview table').count()) === 1, { label: 'markdown preview' })
  check('the editor previews Markdown with a real table', true)
  await app.shot('03-document-editor')
  await page.keyboard.press('Escape')
  await page.locator('.t-docedit').waitFor({ state: 'detached', timeout: 3000 })
  const documentCard = page.locator('[data-kind="document"]')
  check('the card shows the title', (await documentCard.locator('.t-document-title').textContent()) === 'Design notes')
  const excerptText = await documentCard.locator('.t-document-excerpt').textContent()
  check('the card shows an excerpt', excerptText.includes('Ship Tessera'), excerptText)
  check('the excerpt has no Markdown table noise', !excerptText.includes('|') && !excerptText.includes('---'), excerptText)
  doc = await saved()
  check('the title is stored as a heading', doc.nodes.find(n => n.tessera?.kind === 'document').text.startsWith('# Design notes\n\n'))

  // Note features: checkbox toggling, wiki links.
  const noteId = doc.nodes.find(n => n.text === 'pasted words').id
  const note = page.locator(`[data-card-id="${noteId}"]`)
  await note.dblclick({ force: true })
  await page.locator('.t-editor').fill('# Heading\n\n- [ ] tick me\n\n[[Design notes]]\n\n| x |\n|---|\n| y |\n\n```js\nconst a = 1\n```')
  await page.mouse.click(box.x + box.width - 5, box.y + box.height - 5)
  await note.locator('input[type="checkbox"]').waitFor({ timeout: 3000 })
  check('a Note renders a heading', (await note.locator('h1').count()) === 1)
  check('a Note renders a table', (await note.locator('table').count()) === 1)
  check('a Note renders a code block', (await note.locator('pre, code').count()) >= 1)
  const checkbox = await note.locator('input[type="checkbox"]').boundingBox()
  await page.mouse.click(checkbox.x + checkbox.width / 2, checkbox.y + checkbox.height / 2)
  await until(async () => note.locator('input[type="checkbox"]').isChecked(), { label: 'checkbox toggled' })
  check('clicking a checkbox in a Note toggles the text', true)
  await page.keyboard.press('Control+z')
  await until(async () => !(await note.locator('input[type="checkbox"]').isChecked()), { label: 'checkbox undo' })
  check('the toggle undoes', true)
  await app.shot('01-all-cards')

  // Copy and paste between boards, keeping an edge.
  await page.keyboard.press('Control+a')
  doc = await saved()
  const count = doc.nodes.length
  await page.evaluate(() => {
    const data = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    window.__tesseraClip = data.getData('application/x-tessera-cards')
  })
  check('copy writes Tessera cards to the clipboard', (await page.evaluate(() => window.__tesseraClip.length)) > 100)
  await page.locator('.t-sidebar-head button').click()
  await page.locator('.t-dialog input').first().fill('Other')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'Other', { label: 'second board' })
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('application/x-tessera-cards', window.__tesseraClip)
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await until(async () => (await page.locator('[data-card-id]').count()) > 0, { label: 'pasted cards' })
  await sleep(1000)
  const other = app.readBoard('Other.canvas')
  check('cards paste into another board', other.nodes.length === count, `${other.nodes.length} of ${count}`)
  check('pasted cards get new ids', !other.nodes.some(n => doc.nodes.some(m => m.id === n.id)))

  // The file stays valid with every card kind on it.
  const errors = validateCanvas(app.readBoard(FILE))
  check('the board with every kind is still valid JSON Canvas', errors.length === 0, errors.join('; '))
  const reread = JSON.parse(readFileSync(join(app.boards, FILE), 'utf8'))
  check('nothing is lost on disk', reread.nodes.length === count)

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

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { intersects, validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const note = (id, x, y, text, tags) => ({ id, type: 'text', x, y, width: 220, height: 64, text, tessera: { kind: 'note', ...(tags ? { tags } : {}) } })
const frame = (id, x, y, width, height, label, slide) => ({ id, type: 'group', x, y, width, height, label, tessera: { kind: 'frame', ...(slide ? { slide } : {}) } })

const app = await launch({
  name: 'phase-6',
  port: 3197,
  seed: {
    'Deck.canvas': {
      nodes: [
        frame('second', 800, 0, 500, 300, 'Second slide', 2),
        frame('first', 0, 0, 500, 300, 'First slide', 1),
        note('s1', 40, 60, 'On the first slide'),
        note('s2', 840, 60, 'On the second slide'),
        note('hub', 300, 600, 'Hub card'),
        note('spoke', 700, 600, 'Connected card'),
        note('lonely', 1100, 600, 'Unconnected card'),
      ],
      edges: [{ id: 'link', fromNode: 'hub', toNode: 'spoke' }],
    },
    'Scatter.canvas': {
      nodes: [note('a', 0, 0, 'a', ['one']), note('b', 30, 30, 'b', ['two']), note('c', 60, 60, 'c', ['one']), note('d', 90, 90, 'd', ['two']), note('e', 120, 120, 'e')],
      edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'bc', fromNode: 'b', toNode: 'c' }],
    },
    'Doc.canvas': {
      nodes: [frame('f', 0, 0, 500, 300, 'Chapter one'), note('inside', 40, 60, 'Inside the chapter'), { id: 'sub', type: 'file', x: 600, y: 0, width: 280, height: 208, file: 'Child.canvas' }, note('after', 0, 500, 'After everything')],
      edges: [],
    },
    'Child.canvas': { nodes: [note('deep', 0, 0, 'Deep inside')], edges: [] },
  },
})
const { page } = app
const card = id => page.locator(`[data-card-id="${id}"]`)
const clearFocus = async () => { await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } }) }
const open = async (name, id) => {
  await page.locator('.t-tree-row').filter({ hasText: name }).first().click()
  await until(async () => (await card(id).count()) === 1, { label: `open ${name}` })
  await clearFocus()
  await page.keyboard.press('Control+0')
  await sleep(300)
}
const more = async (name) => {
  await page.getByTestId('more-button').click()
  await page.getByRole('menuitem', { name }).click()
}

try {
  // Inbox.
  check('the Inbox board exists from the start', app.readBoard('Inbox.canvas').nodes.length === 0)
  check('the Inbox sits at the top of the sidebar', (await page.locator('.t-tree-row').first().textContent()).includes('Inbox'))

  // Sketch: draw, erase, save, reopen.
  await open('Deck', 'hub')
  await page.locator('[data-tool="sketch"]').focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('sketch-editor')
  await editor.waitFor({ timeout: 3000 })
  check('the toolbar opens the sketch editor', true)
  const area = await editor.locator('canvas').boundingBox()
  const drawStroke = async (fromX, fromY, toX, toY) => {
    await page.mouse.move(area.x + fromX, area.y + fromY)
    await page.mouse.down()
    await page.mouse.move(area.x + toX, area.y + toY, { steps: 12 })
    await page.mouse.up()
  }
  await drawStroke(60, 60, 300, 200)
  await editor.locator('[data-sketch-tool="marker"]').click()
  await drawStroke(400, 60, 600, 200)
  await editor.locator('[data-sketch-tool="highlighter"]').click()
  await drawStroke(60, 300, 600, 300)
  const painted = await editor.locator('canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++
    return count
  })
  check('strokes draw on the canvas', painted > 500, String(painted))
  await app.shot('01-sketch-editor')
  await editor.getByRole('button', { name: 'Undo stroke' }).click()
  await editor.getByRole('button', { name: 'Redo stroke' }).click()
  await editor.locator('[data-sketch-tool="eraser"]').click()
  const scale = (await editor.locator('canvas').evaluate(canvas => canvas.width)) / area.width
  await page.mouse.move(area.x + 330 / scale * scale, area.y + 300)
  await page.mouse.down()
  await page.mouse.up()
  await editor.getByRole('button', { name: 'Done' }).click()
  await until(async () => (await page.locator('[data-kind="sketch"]').count()) === 1, { label: 'sketch card' })
  check('finishing creates a Sketch card', true)
  await sleep(800)
  let deck = app.readBoard('Deck.canvas')
  const sketchNode = deck.nodes.find(node => node.tessera?.kind === 'sketch')
  check('the sketch is stored as an SVG asset', /^_assets\/[0-9a-f]+\.svg$/.test(sketchNode.file), sketchNode.file)
  const svg = readFileSync(join(app.boards, sketchNode.file), 'utf8')
  const strokeCount = (svg.match(/data-stroke=/g) ?? []).length
  check('the file is real SVG with the strokes left after erasing', svg.startsWith('<svg') && strokeCount === 2, `${strokeCount} strokes`)
  await page.keyboard.press('Control+0')
  await sleep(300)
  await until(async () => card(sketchNode.id).locator('img').evaluate(img => img.complete && img.naturalWidth > 0), { label: 'sketch image' })
  check('the card shows the drawing', true)
  await card(sketchNode.id).dblclick({ force: true })
  await editor.waitFor({ timeout: 3000 })
  await until(async () => editor.getByRole('button', { name: 'Clear' }).isEnabled(), { label: 'strokes reload' })
  check('double-click reopens the drawing with its strokes', true)
  await page.mouse.move(area.x + 100, area.y + 400)
  await page.mouse.down()
  await page.mouse.move(area.x + 200, area.y + 450, { steps: 5 })
  await page.mouse.up()
  await editor.getByRole('button', { name: 'Done' }).click()
  await editor.waitFor({ state: 'detached', timeout: 3000 })
  await sleep(800)
  const edited = app.readBoard('Deck.canvas').nodes.find(node => node.id === sketchNode.id)
  check('editing points the card at a new asset', edited.file !== sketchNode.file)
  await page.keyboard.press('Control+z')
  await sleep(800)
  check('undo restores the previous drawing', app.readBoard('Deck.canvas').nodes.find(node => node.id === sketchNode.id).file === sketchNode.file)

  // Presentation.
  await clearFocus()
  await more('Present frames')
  const bar = page.getByTestId('presenter-bar')
  await bar.waitFor({ timeout: 3000 })
  await sleep(500)
  check('presenting starts on the first slide by number', (await bar.locator('.t-presenter-count').textContent()) === '1 / 2')
  check('the chrome is hidden', !(await page.locator('.t-sidebar').isVisible()) && !(await page.locator('.t-topbar').isVisible()))
  const rootBox = await page.getByTestId('tessera-root').boundingBox()
  check('the slide covers the whole window', rootBox.x === 0 && rootBox.y === 0 && rootBox.width === 1440, JSON.stringify(rootBox))
  check('other frames and cards leave the slide', (await card('second').count()) === 0 && (await card('hub').count()) === 0 && (await card('s1').count()) === 1)
  const firstBox = await card('first').boundingBox()
  check('the frame fills the screen', firstBox.width > 800, String(firstBox.width))
  await app.shot('02-presentation')
  await page.keyboard.press('ArrowRight')
  await until(async () => (await bar.locator('.t-presenter-count').textContent()) === '2 / 2', { label: 'next slide' })
  await sleep(400)
  const secondBox = await card('second').boundingBox()
  check('arrow keys move between frames', secondBox.x >= 0 && secondBox.width > 800, JSON.stringify(secondBox))
  await page.keyboard.press('ArrowRight')
  check('the last slide stays put', (await bar.locator('.t-presenter-count').textContent()) === '2 / 2')
  const beforeExitDoc = JSON.stringify(app.readBoard('Deck.canvas').nodes)
  await page.keyboard.press('Escape')
  await bar.waitFor({ state: 'detached', timeout: 3000 })
  check('Escape leaves the presentation', await page.locator('.t-sidebar').isVisible())
  await sleep(600)
  check('presenting changes nothing on the board', JSON.stringify(app.readBoard('Deck.canvas').nodes) === beforeExitDoc)

  // Focus mode.
  await clearFocus()
  await page.keyboard.press('f')
  await until(async () => (await page.locator('.t-banner').textContent().catch(() => '')).includes('Select a card'), { label: 'focus needs a selection' })
  check('focus mode asks for a selection first', true)
  await page.keyboard.press('Control+0')
  await sleep(300)
  await card('hub').click()
  await page.keyboard.press('f')
  await until(async () => (await card('lonely').getAttribute('class')).includes('t-dimmed'), { label: 'focus dims' })
  check('focus dims unrelated cards', true)
  check('focus keeps the selected card', !(await card('hub').getAttribute('class')).includes('t-dimmed'))
  check('focus keeps its connections', !(await card('spoke').getAttribute('class')).includes('t-dimmed'))
  check('focus keeps connecting edges bright', !(await page.locator('[data-edge-id="link"]').getAttribute('class')).includes('dimmed'))
  await app.shot('03-focus')
  await page.keyboard.press('Escape')
  await until(async () => !(await card('lonely').getAttribute('class')).includes('t-dimmed'), { label: 'focus ends' })
  check('Escape ends focus mode', true)

  // Auto-layout.
  const overlaps = (doc) => doc.nodes.flatMap((a, i) => doc.nodes.slice(i + 1).filter(b => intersects(a, b)).map(b => `${a.id}/${b.id}`))
  await open('Scatter', 'a')
  const startOverlaps = overlaps(app.readBoard('Scatter.canvas')).length
  check('the test board really starts out overlapping', startOverlaps > 0)
  await more('Arrange as grid')
  await sleep(800)
  check('grid layout removes every overlap', overlaps(app.readBoard('Scatter.canvas')).length === 0)
  await app.shot('04-layout-grid')
  await page.keyboard.press('Control+z')
  await sleep(800)
  check('layout undoes as one step', overlaps(app.readBoard('Scatter.canvas')).length === startOverlaps)
  await more('Arrange as tree')
  await sleep(800)
  let scatter = app.readBoard('Scatter.canvas')
  const nodeOf = id => scatter.nodes.find(node => node.id === id)
  check('tree layout follows the edges', nodeOf('a').x < nodeOf('b').x && nodeOf('b').x < nodeOf('c').x)
  await more('Arrange by tag')
  await sleep(800)
  scatter = app.readBoard('Scatter.canvas')
  check('cluster layout keeps tags together', overlaps(scatter).length === 0 && Math.abs(nodeOf('a').x - nodeOf('c').x) < Math.abs(nodeOf('a').x - nodeOf('b').x), JSON.stringify(scatter.nodes.map(n => [n.id, n.x, n.y])))

  // Exports of the board.
  const download = async (name) => {
    const pending = page.waitForEvent('download', { timeout: 10000 })
    await more(name)
    const file = await pending
    const path = join(app.runDir, file.suggestedFilename())
    await file.saveAs(path)
    return { name: file.suggestedFilename(), path }
  }
  await open('Deck', 'hub')
  const svgFile = await download('Export as SVG')
  check('SVG export downloads', svgFile.name === 'Deck.svg')
  const svgText = readFileSync(svgFile.path, 'utf8')
  check('the SVG holds the board', svgText.startsWith('<svg') && svgText.includes('Hub card') && svgText.includes('Second slide'))
  check('the SVG carries its sketch inside it', svgText.includes('data:image/svg+xml'))
  check('the SVG is well formed', await page.evaluate(text => new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror') === null, svgText))
  const pngFile = await download('Export as PNG')
  const pngBytes = readFileSync(pngFile.path)
  check('PNG export downloads a real PNG', pngFile.name === 'Deck.png' && pngBytes.subarray(1, 4).toString() === 'PNG' && pngBytes.length > 2000, `${pngBytes.length} bytes`)
  const width = pngBytes.readUInt32BE(16), height = pngBytes.readUInt32BE(20)
  check('the PNG has real dimensions', width > 500 && height > 300, `${width}x${height}`)
  const nonBlank = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++
    return dark
  }, pngBytes.toString('base64'))
  check('the PNG is not blank', nonBlank > 500, `${nonBlank} dark pixels`)

  // Export of a selection.
  await card('hub').click()
  const pictureSelected = await download('Export as SVG')
  const selectedText = readFileSync(pictureSelected.path, 'utf8')
  check('with a selection, only the selection is exported', selectedText.includes('Hub card') && !selectedText.includes('Unconnected card'))

  // Markdown outline with a nested board.
  await open('Doc', 'after')
  const outline = readFileSync((await download('Export Markdown outline')).path, 'utf8')
  const expected = ['# Doc', '## Chapter one', 'Inside the chapter', '## Child', 'Deep inside', 'After everything']
  let last = -1
  const inOrder = expected.every((piece) => {
    const at = outline.indexOf(piece)
    const good = at > last
    last = at
    return good
  })
  check('the outline follows reading order, with the nested board as a nested heading', inOrder, outline)
  writeFileSync(join(app.runDir, 'outline.md'), outline)

  // PDF through print: stub the dialog, then render what the print stylesheet would show.
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++ } })
  await more('Print or save as PDF')
  await until(async () => (await page.evaluate(() => window.__printed)) === 1, { label: 'print called' })
  check('PDF export opens the print dialog', (await page.locator('.t-print svg').count()) === 1)
  // Check the print stylesheet first: page.pdf() itself fires afterprint, which cleans the view up.
  await page.emulateMedia({ media: 'print' })
  check('the print view hides the app and shows only the board', !(await page.getByTestId('tessera-root').isVisible()) && await page.locator('.t-print svg').isVisible())
  await page.screenshot({ path: join(app.runDir, '..', '..', 'screenshots', 'phase-6', '05-print-view.png') })
  await page.emulateMedia({ media: 'screen' })
  const pdf = await page.pdf({ printBackground: true, path: join(app.runDir, 'board.pdf') })
  check('the print view produces a PDF', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 1000, `${pdf.length} bytes`)
  await page.evaluate(() => { window.dispatchEvent(new Event('afterprint')) })
  await until(async () => (await page.locator('.t-print').count()) === 0, { label: 'print cleanup' })
  check('the print view cleans up afterwards', true)

  for (const name of ['Deck.canvas', 'Scatter.canvas', 'Doc.canvas']) {
    const errors = validateCanvas(app.readBoard(name))
    check(`${name} stays valid JSON Canvas`, errors.length === 0, errors.join('; '))
  }
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

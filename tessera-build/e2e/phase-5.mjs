import { readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const note = (id, x, y, text, extra = {}) => ({ id, type: 'text', x, y, width: 220, height: 64, text, tessera: { kind: 'note', ...extra } })

const app = await launch({
  name: 'phase-5',
  port: 3196,
  seed: {
    'Atlas.canvas': {
      nodes: [
        note('alpha', 0, 0, '# Alpha base', { tags: ['place', 'north'] }),
        note('beta', 300, 0, 'Beta outpost', { tags: ['place'] }),
        note('gamma', 600, 0, 'Gamma crew', { tags: ['people'] }),
        note('linker', 0, 200, 'Plain text here'),
      ],
      edges: [],
    },
    'Notes.canvas': { nodes: [note('far', 0, 0, 'The zebra crossing is far away')], edges: [] },
  },
})
const { page } = app
const card = id => page.locator(`[data-card-id="${id}"]`)
const clearFocus = async () => { await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } }) }
const FILE = 'Atlas.canvas'

try {
  await page.locator('.t-tree-row').filter({ hasText: 'Atlas' }).click()
  await until(async () => (await page.locator('[data-card-id]').count()) === 4, { label: 'atlas' })
  await clearFocus()

  // Global search across boards.
  await page.keyboard.press('Control+k')
  const search = page.getByTestId('global-search')
  await search.waitFor({ timeout: 3000 })
  check('Ctrl+K opens global search', true)
  await search.locator('input').fill('zebra')
  await until(async () => (await search.locator('.t-picker-row').count()) === 1, { label: 'search result' })
  check('search finds a card on another board', (await search.locator('.t-hit-board').textContent()).includes('Notes'))
  await app.shot('01-search')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'Notes', { label: 'opened result' })
  await until(async () => (await card('far').getAttribute('class').catch(() => '')).includes('t-selected'), { label: 'result selected' })
  check('picking a result opens its board and selects the card', true)
  await page.locator('.t-tree-row').filter({ hasText: 'Atlas' }).click()
  await until(async () => (await card('alpha').count()) === 1, { label: 'back to atlas' })
  await clearFocus()

  // Command palette.
  await page.keyboard.press('/')
  const palette = page.getByTestId('command-palette')
  await palette.waitFor({ timeout: 3000 })
  check('/ opens the command palette', true)
  await palette.locator('input').fill('add note')
  await until(async () => (await palette.locator('.t-picker-row').count()) === 1, { label: 'filtered command' })
  await app.shot('02-palette')
  const before = await page.locator('[data-card-id]').count()
  await page.keyboard.press('Enter')
  await page.locator('.t-editor').waitFor({ timeout: 3000 })
  check('a command runs from the palette', true)
  await page.keyboard.type('From the palette')
  await clearFocus()
  await until(async () => (await page.locator('[data-card-id]').count()) === before + 1, { label: 'palette note' })
  await page.keyboard.press('/')
  await palette.waitFor()
  await page.keyboard.press('Escape')
  await palette.waitFor({ state: 'detached', timeout: 3000 })
  check('Escape closes the palette', true)

  // A / or Ctrl+K typed into a text field must stay text, or search there and not break typing.
  await card('linker').dblclick()
  const editor = page.locator('.t-editor')
  await editor.waitFor()
  await editor.fill('')
  await page.keyboard.type('path/with/slashes ')
  check('/ inside a note types a slash', (await palette.count()) === 0 && (await editor.inputValue()).includes('path/with/slashes'))

  // [[ autocomplete of cards and boards.
  await page.keyboard.type('[[Al')
  const suggest = page.getByTestId('link-suggest')
  await suggest.waitFor({ timeout: 3000 })
  check('[[ suggests cards', (await suggest.textContent()).includes('Alpha base'))
  await app.shot('03-autocomplete')
  await page.keyboard.press('Enter')
  check('Enter finishes the link', (await editor.inputValue()).endsWith('[[Alpha base]]'), await editor.inputValue())
  await page.keyboard.type(' and [[Not')
  await until(async () => (await suggest.textContent().catch(() => '')).includes('Notes'), { label: 'board suggestion' })
  check('[[ suggests boards too', true)
  await page.keyboard.press('Enter')
  await clearFocus()
  await card('linker').locator('a').first().waitFor({ timeout: 3000 })

  // Backlinks.
  await until(async () => (await card('alpha').getByTestId('backlinks').count()) === 1, { label: 'backlink badge' })
  check('a linked card shows what links to it', (await card('alpha').getByTestId('backlinks').textContent()).includes('1'))
  await card('alpha').getByTestId('backlinks').locator('.t-chip').click()
  await card('alpha').getByTestId('backlinks').locator('.t-menu-item').click()
  await until(async () => (await card('linker').getAttribute('class')).includes('t-selected'), { label: 'jump to source' })
  check('the backlink jumps to its source', true)
  await card('linker').locator('a').first().click()
  await until(async () => (await card('alpha').getAttribute('class')).includes('t-selected'), { label: 'jump along link' })
  check('clicking a [[link]] jumps to its card', true)
  await card('linker').locator('a').nth(1).click()
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'Notes', { label: 'link to board' })
  check('a [[link]] to a board opens the board', true)
  await page.locator('.t-tree-row').filter({ hasText: 'Atlas' }).click()
  await until(async () => (await card('alpha').count()) === 1, { label: 'atlas again' })

  // Tags and filter.
  await page.getByTestId('tag-filter').click()
  const popover = page.locator('.t-popover').first()
  await popover.waitFor()
  check('the filter lists the board tags with counts', (await popover.textContent()).includes('place') && (await popover.textContent()).includes('people'))
  await popover.locator('label').filter({ hasText: 'people' }).locator('input').check()
  await until(async () => (await card('alpha').getAttribute('class')).includes('t-dimmed'), { label: 'dim' })
  check('non-matching cards dim', true)
  check('matching cards stay bright', !(await card('gamma').getAttribute('class')).includes('t-dimmed'))
  await app.shot('04-tag-filter')
  await popover.getByRole('button', { name: 'Clear' }).click()
  await until(async () => !(await card('alpha').getAttribute('class')).includes('t-dimmed'), { label: 'undim' })
  check('clearing the filter restores them', true)
  await clearFocus()

  // Adding a tag through the selection bar.
  await card('beta').click()
  await page.getByTestId('selection-bar').getByRole('button', { name: /^Tags/ }).click()
  await page.locator('.t-dialog input').fill('place, new tag, new tag')
  await page.keyboard.press('Enter')
  await until(async () => (await card('beta').locator('.t-tag').count()) === 2, { label: 'tag chips' })
  check('tags can be set and show on the card, without duplicates', true)
  await clearFocus()

  // History: named snapshot, timeline, preview, restore.
  await sleep(800)
  await page.getByTestId('history-button').click()
  const panel = page.getByTestId('history-panel')
  await panel.waitFor()
  check('an empty timeline says so', (await panel.textContent()).includes('No saved versions'))
  await panel.getByRole('button', { name: 'Save this version' }).click()
  await page.locator('.t-dialog input').fill('Before the storm')
  await page.keyboard.press('Enter')
  await until(async () => (await panel.locator('.t-side-row').count()) === 1, { label: 'snapshot listed' })
  check('a named version appears on the timeline', (await panel.locator('.t-side-row').textContent()).includes('Before the storm'))
  const historyDir = join(app.boards, '_history', encodeURIComponent('Atlas'))
  check('the version is a file in _history', existsSync(historyDir) && readdirSync(historyDir).some(file => file.endsWith('.canvas')))
  const versionFile = readdirSync(historyDir).find(file => file.endsWith('.canvas'))
  check('that file is valid JSON Canvas', validateCanvas(JSON.parse((await import('node:fs')).readFileSync(join(historyDir, versionFile), 'utf8'))).length === 0)
  // Change the board, then go back.
  await clearFocus()
  await page.keyboard.press('Control+0')
  await sleep(300)
  await card('gamma').click()
  await page.keyboard.press('Delete')
  await until(async () => (await card('gamma').count()) === 0, { label: 'gamma deleted' })
  await panel.locator('.t-side-row').first().click()
  await page.getByTestId('history-preview').waitFor()
  check('selecting a version previews it', (await page.getByTestId('history-preview').locator('.t-mini-card').count()) >= 5)
  await app.shot('05-history')
  await panel.getByRole('button', { name: 'Restore' }).click()
  await page.locator('.t-dialog').getByRole('button', { name: 'Restore' }).click()
  await until(async () => (await card('gamma').count()) === 1, { label: 'restored' })
  check('restore brings the board back', true)
  await until(async () => (await panel.locator('.t-side-row').count()) === 2, { label: 'safety copy' })
  check('the state before restoring is kept on the timeline', true)
  await page.keyboard.press('Control+z')
  await until(async () => (await card('gamma').count()) === 0, { label: 'undo restore' })
  check('restore can be undone', true)
  await page.keyboard.press('Control+Shift+z')
  await until(async () => (await card('gamma').count()) === 1, { label: 'redo restore' })
  await panel.getByRole('button', { name: 'Close' }).click()

  // Templates: built-in, save as template, use the saved one.
  await page.locator('.t-sidebar-head button').click()
  const select = page.getByTestId('template-select')
  await select.waitFor()
  await until(async () => (await select.locator('option').count()) === 9, { label: 'template list' })
  check('all eight built-in templates are offered', true)
  await select.selectOption('worldbuilding-hub')
  await page.locator('.t-dialog input').first().fill('My World')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'My World', { label: 'template board' })
  await until(async () => (await page.locator('[data-kind="column"]').count()) === 4, { label: 'template columns' })
  check('a built-in template fills the new board', true)
  await clearFocus()
  await page.keyboard.press('Control+0')
  await sleep(600)
  await app.shot('06-template')
  const hub = app.readBoard('My World.canvas')
  check('the template board is valid', validateCanvas(hub).length === 0)
  await page.keyboard.press('/')
  await palette.waitFor()
  await palette.locator('input').fill('save board as')
  await page.keyboard.press('Enter')
  await page.locator('.t-dialog input').fill('Our hub')
  await page.keyboard.press('Enter')
  await until(async () => existsSync(join(app.boards, '_templates', 'Our hub.canvas')), { label: 'saved template file' })
  check('a board can be saved as a template', true)
  await page.locator('.t-sidebar-head button').click()
  await until(async () => (await select.locator('option').count()) === 10, { label: 'saved template listed' })
  await select.selectOption('saved:Our hub.canvas')
  await page.keyboard.press('Enter')
  await until(async () => (await page.locator('.t-crumb').last().textContent()) === 'Our hub', { label: 'saved template board' })
  await sleep(800)
  const fromSaved = app.readBoard('Our hub.canvas')
  check('the saved template creates a board with the same cards', fromSaved.nodes.length === hub.nodes.length)
  check('with new ids', !fromSaved.nodes.some(node => hub.nodes.some(other => other.id === node.id)))
  check('and columns still hold their members', fromSaved.nodes.filter(n => n.tessera?.kind === 'column').every(column => column.tessera.items.every(id => fromSaved.nodes.some(n => n.id === id))))
  check('templates stay out of the board list', (await page.locator('.t-tree-row').filter({ hasText: /^_templates/ }).count()) === 0)

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

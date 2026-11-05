// The Phase 4 acceptance test: the real model organizes a messy board, and one undo reverts it.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { intersects, validateCanvas } from '../../tessera-plugin/src/shared/canvas.ts'
import { apiKeyEnv } from '../harness.mjs'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const THEMES = {
  cooking: ['Slow-roast tomatoes with garlic', 'Sourdough starter feeding schedule', 'Best knife for chopping onions', 'Simmer the stock for four hours', 'Salt the pasta water generously', 'Caramelize onions over low heat', 'Rest the steak before slicing', 'Whisk the vinaigrette until it emulsifies', 'Toast spices in a dry pan', 'Fold the egg whites gently'],
  astronomy: ['Jupiter has at least 95 known moons', 'The Andromeda galaxy is approaching us', 'Neutron stars spin hundreds of times a second', 'Saturn rings are mostly water ice', 'A light year is about 9.46 trillion km', 'Mars has the tallest volcano in the solar system', 'Black holes bend light around them', 'The Moon is slowly drifting away from Earth', 'Venus rotates backwards', 'Comet tails always point away from the Sun'],
  gardening: ['Prune the roses in late winter', 'Compost needs both greens and browns', 'Water tomato plants at the roots', 'Mulch keeps the soil moist', 'Plant garlic cloves in autumn', 'Rotate crops to protect the soil', 'Bees love lavender and borage', 'Stake the climbing beans early', 'Thin the carrot seedlings', 'Test the soil pH every spring'],
}

// Shuffled into one overlapping heap, so "messy" is true and themes are not already adjacent.
const words = Object.values(THEMES).flat()
const shuffled = words.map((text, index) => ({ text, order: (index * 17) % words.length })).sort((a, b) => a.order - b.order)
const messy = {
  nodes: shuffled.map(({ text }, index) => ({
    id: `card${String(index).padStart(2, '0')}`, type: 'text', text,
    x: (index * 137) % 900, y: (index * 89) % 520, width: 240, height: 64, tessera: { kind: 'note' },
  })),
  edges: [],
}
const FILE = 'Messy.canvas'

const secret = apiKeyEnv().DEEPSEEK_API_KEY
const scrub = text => String(text).replaceAll(secret, '[key hidden]')

const app = await launch({
  name: 'phase-4',
  port: 3194,
  withKey: true,
  seed: { [FILE]: messy, 'Keep.canvas': { nodes: [{ id: 'victim', type: 'text', x: 0, y: 0, width: 240, height: 64, text: 'Please keep me', tessera: { kind: 'note' } }, { id: 'other', type: 'text', x: 0, y: 200, width: 240, height: 64, text: 'Also here', tessera: { kind: 'note' } }], edges: [] } },
})
const { page } = app
const composer = page.locator('[contenteditable="true"]').first()
const tessera = page.getByRole('button', { name: 'Tessera' }).first()

/** Wait for the agent to finish its turn, answering nothing on its behalf. */
async function waitForAgent(label, timeout = 240_000) {
  await until(async () => (await page.getByRole('button', { name: /^(Stop|Parar)/ }).count()) > 0 || (await page.locator('.t-dialog').count()) > 0, { label: `${label}: agent starts`, timeout: 30_000 }).catch(() => {})
  let quiet = 0
  const start = Date.now()
  while (quiet < 6) {
    if (Date.now() - start > timeout) throw new Error(`${label}: the agent did not finish in time`)
    const running = await page.getByRole('button', { name: /^(Stop|Parar)/ }).count()
    quiet = running > 0 ? 0 : quiet + 1
    await sleep(1000)
  }
}

try {
  await page.locator('.t-tree-row').filter({ hasText: 'Messy' }).click()
  await until(async () => (await page.locator('[data-card-id]').count()) === 30, { label: '30 cards' })
  await app.shot('01-messy-before')
  const original = new Map(messy.nodes.map(node => [node.id, node]))

  // Ask the agent: the chat opens with the board and selection already there.
  await page.locator('[data-card-id="card00"]').click({ force: true })
  await page.getByTestId('ask-agent').click()
  await composer.waitFor({ timeout: 15000 })
  await until(async () => (await composer.textContent()).includes(FILE), { label: 'context in the composer' })
  const draft = await composer.textContent()
  check('"Ask the agent" opens the chat with the current board', draft.includes(`Tessera board: ${FILE}`), draft)
  check('and with the selected card', draft.includes('card00'), draft)
  await app.shot('02-ask-the-agent')

  // Replace the single-card selection in the draft: the acceptance task is about the whole board.
  await composer.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(`Tessera board: ${FILE}\n`.replace('\n', ' '))
  await page.keyboard.type('Organize this messy board by theme into frames, using your Tessera tools. There are 30 cards. Every card must end up inside exactly one frame.')
  await page.keyboard.press('Enter')
  const startedAt = Date.now()
  await waitForAgent('organize')
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  console.log(`  agent finished in about ${seconds} s`)
  await app.shot('03-chat-after')

  // Back on the panel: the edits must already be live.
  await tessera.click()
  await page.getByTestId('tessera-root').waitFor()
  await sleep(1500)
  await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('Control+0')
  await sleep(1500)
  await app.shot('04-organized')
  const organized = app.readBoard(FILE)
  writeFileSync(join(app.runDir, 'organized.json'), JSON.stringify(organized, null, 1))

  const frames = organized.nodes.filter(node => node.type === 'group')
  const cards = organized.nodes.filter(node => node.type !== 'group')
  check('the agent created frames', frames.length >= 2, `${frames.length} frames`)
  check('frames are titled', frames.every(frame => typeof frame.label === 'string' && frame.label.trim() !== ''), frames.map(f => f.label).join(' | '))
  console.log(`  frames: ${frames.map(f => f.label).join(' | ')}`)
  check('no card was lost', [...original.keys()].every(id => cards.some(card => card.id === id)), `${cards.length} cards`)
  check('no text was changed', cards.every(card => !original.has(card.id) || original.get(card.id).text === card.text))
  const errors = validateCanvas(organized)
  check('the organized file passes the strict validator', errors.length === 0, errors.join('; '))

  const center = node => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 })
  const inFrame = (node, frame) => {
    const c = center(node)
    return c.x >= frame.x && c.x <= frame.x + frame.width && c.y >= frame.y && c.y <= frame.y + frame.height
  }
  const homes = cards.filter(card => original.has(card.id)).map(card => frames.filter(frame => inFrame(card, frame)).length)
  const outside = homes.filter(count => count === 0).length
  const twice = homes.filter(count => count > 1).length
  check('every card ended up inside a frame', outside === 0, `${outside} of 30 outside`)
  check('no card sits in two frames', twice === 0, `${twice} of 30 in two frames`)

  // Report (not fail on) how well the model separated the themes: it is a model's judgment, not Tessera's.
  const themeOf = new Map(Object.entries(THEMES).flatMap(([theme, list]) => list.map(text => [text, theme])))
  for (const frame of frames) {
    const counts = {}
    for (const card of cards) if (inFrame(card, frame)) counts[themeOf.get(card.text)] = (counts[themeOf.get(card.text)] ?? 0) + 1
    console.log(`    ${frame.label}: ${JSON.stringify(counts)}`)
  }
  const overlappingFrames = frames.flatMap((a, i) => frames.slice(i + 1).filter(b => intersects(a, b)).map(b => `${a.label}/${b.label}`))
  console.log(`  overlapping frames: ${overlappingFrames.length === 0 ? 'none' : overlappingFrames.join(', ')}`)

  // The acceptance step: one undo reverts the whole turn.
  await until(async () => page.getByRole('button', { name: 'Undo' }).isEnabled(), { label: 'undo enabled' })
  await page.getByRole('button', { name: 'Undo' }).click()
  await until(async () => (await page.locator('[data-kind="frame"]').count()) === 0, { label: 'frames gone after one undo', timeout: 10000 })
  await sleep(1200)
  await app.shot('05-after-one-undo')
  const reverted = app.readBoard(FILE)
  check('one undo removes every frame', reverted.nodes.every(node => node.type !== 'group'))
  check('one undo keeps all 30 cards', reverted.nodes.length === 30, String(reverted.nodes.length))
  const moved = reverted.nodes.filter((node) => {
    const before = original.get(node.id)
    return before === undefined || before.x !== node.x || before.y !== node.y
  })
  check('one undo puts every card back exactly', moved.length === 0, moved.map(n => n.id).join())
  check('the reverted file is still valid', validateCanvas(reverted).length === 0)
  await page.getByRole('button', { name: 'Redo' }).click()
  await until(async () => (await page.locator('[data-kind="frame"]').count()) === frames.length, { label: 'redo restores frames', timeout: 10000 })
  check('redo brings the whole organization back', true)

  // Delete confirmation: the question must appear over the chat, and a no must hold.
  await page.locator('.t-tree-row').filter({ hasText: 'Keep' }).click()
  await until(async () => (await page.locator('[data-card-id="victim"]').count()) === 1, { label: 'keep board' })
  await page.getByTestId('ask-agent').click()
  await composer.waitFor({ timeout: 15000 })
  await until(async () => (await composer.textContent()).includes('Keep.canvas'), { label: 'keep context' })
  await composer.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Use tessera_delete_cards to delete the card with id "victim" from this board. If it is declined, just tell me and stop.')
  await page.keyboard.press('Enter')
  await page.locator('.t-dialog').waitFor({ timeout: 120_000 })
  check('a delete asks in the UI, over the chat', (await page.locator('.t-dialog h2').textContent()).includes('delete'))
  await app.shot('06-delete-question')
  await page.locator('.t-dialog').getByRole('button', { name: 'Cancel' }).click()
  await waitForAgent('declined delete', 120_000)
  check('a declined delete leaves the card', app.readBoard('Keep.canvas').nodes.some(node => node.id === 'victim'))
  await composer.click()
  await page.keyboard.type('I changed my mind. Delete it now with tessera_delete_cards.')
  await page.keyboard.press('Enter')
  await page.locator('.t-dialog').waitFor({ timeout: 120_000 })
  await page.locator('.t-dialog').getByRole('button', { name: 'Delete' }).click()
  await waitForAgent('approved delete', 120_000)
  await sleep(800)
  check('an approved delete removes the card', !app.readBoard('Keep.canvas').nodes.some(node => node.id === 'victim'))

  // The skill is in the catalog.
  await composer.click()
  await page.keyboard.type('/tessera')
  await sleep(1500)
  const menu = await page.locator('body').innerText()
  check('the skill is available in the chat', menu.includes('tessera-boards'))
  await app.shot('07-skill')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')

  const appErrors = app.problems.filter(problem => !/favicon|ERR_BLOCKED|net::/.test(problem))
  check('no console errors', appErrors.length === 0, scrub(appErrors.join('\n')))
} catch (error) {
  check(`script finished: ${scrub(error.message)}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(scrub(app.problems.join('\n')))
  console.log(scrub(app.run.log.join('').slice(-2500)))
} finally {
  await app.stop()
  summarize()
}

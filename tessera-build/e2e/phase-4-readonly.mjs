// A session in read-only mode must not be able to change a board through the Tessera tools.
import { apiKeyEnv } from '../harness.mjs'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const FILE = 'Locked.canvas'
const scrub = text => String(text).replaceAll(apiKeyEnv().DEEPSEEK_API_KEY, '[key hidden]')
const app = await launch({
  name: 'phase-4-readonly',
  port: 3195,
  withKey: true,
  env: { DSH_PERMISSION_MODE: 'read-only' },
  seed: { [FILE]: { nodes: [{ id: 'one', type: 'text', x: 0, y: 0, width: 240, height: 64, text: 'Only card', tessera: { kind: 'note' } }], edges: [] } },
})
const { page } = app
try {
  await page.locator('.t-tree-row').filter({ hasText: 'Locked' }).click()
  await until(async () => (await page.locator('[data-card-id]').count()) === 1, { label: 'board open' })
  await page.getByTestId('ask-agent').click()
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ timeout: 15000 })
  await until(async () => (await composer.textContent()).includes(FILE), { label: 'context' })
  await composer.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('First call tessera_read_board on this board and tell me the text of its only card. Then call tessera_create_cards to add a note saying "hello". Report exactly what each tool returned.')
  await page.keyboard.press('Enter')
  await until(async () => (await page.getByRole('button', { name: /^(Stop|Parar)/ }).count()) > 0, { label: 'agent starts', timeout: 30000 }).catch(() => {})
  let quiet = 0
  const start = Date.now()
  while (quiet < 6) {
    if (Date.now() - start > 180_000) throw new Error('the agent did not finish in time')
    quiet = (await page.getByRole('button', { name: /^(Stop|Parar)/ }).count()) > 0 ? 0 : quiet + 1
    await sleep(1000)
  }
  await app.shot('01-readonly-chat')
  const reply = await page.locator('body').innerText()
  check('the agent could still read the board', reply.includes('Only card'))
  check('the agent was told the session is read-only', /read-only/i.test(reply))
  await sleep(800)
  const doc = app.readBoard(FILE)
  check('the board did not change', doc.nodes.length === 1 && doc.nodes[0].id === 'one', JSON.stringify(doc.nodes.map(n => n.id)))
} catch (error) {
  check(`script finished: ${scrub(error.message)}`, false)
  await app.shot('zz-failure').catch(() => {})
} finally {
  await app.stop()
  summarize()
}

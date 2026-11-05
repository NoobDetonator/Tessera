// The configuration the README documents, applied through a real profile patch, plus automatic snapshots.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectRoot } from '../harness.mjs'
import { check, launch, sleep, summarize, until } from './lib.mjs'

const patchDir = resolve(projectRoot, '.test-run')
mkdirSync(patchDir, { recursive: true })
const patch = join(patchDir, 'config-test.patch.yml')
writeFileSync(patch, `- id: tessera
  config:
    root: my-boards
    autoSnapshotMinutes: 0.02
`)

const app = await launch({
  name: 'config',
  port: 3189,
  args: ['--patch', patch],
  boardsDir: 'my-boards',
  seed: { 'Custom.canvas': { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 64, text: 'hello', tessera: { kind: 'note' } }], edges: [] } },
})
const { page } = app
try {
  await page.locator('.t-tree-row').filter({ hasText: 'Custom' }).click()
  await until(async () => (await page.locator('[data-card-id="a"]').count()) === 1, { label: 'board in the configured folder' })
  check('the root option moves the board folder', true)
  check('nothing is written to the default folder', !existsSync(join(app.runDir, 'tessera')))

  // Two edits more than the interval apart: the first only starts the clock, the second snapshots.
  await page.getByTestId('tessera-canvas').click({ position: { x: 4, y: 4 } })
  await page.locator('[data-card-id="a"]').click()
  await page.keyboard.press('ArrowRight')
  await sleep(1800)
  await page.keyboard.press('ArrowRight')
  const folder = join(app.boards, '_history', 'Custom')
  await until(() => existsSync(folder) && readdirSync(folder).some(file => file.includes('--auto--')), { label: 'automatic snapshot', timeout: 10000 })
  check('editing creates an automatic snapshot', true)
  await page.getByTestId('history-button').click()
  const panel = page.getByTestId('history-panel')
  await panel.waitFor()
  await until(async () => (await panel.locator('.t-side-row').count()) >= 1, { label: 'timeline entry' })
  check('it shows on the timeline as automatic', (await panel.locator('.t-side-row').first().textContent()).includes('Automatic save'))
  check('no console errors', app.problems.length === 0, app.problems.join('\n'))
} catch (error) {
  check(`script finished: ${error.message}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(app.run.log.join('').replace(/token=[^&\s]+/g, 'token=***').slice(-1500))
} finally {
  await app.stop()
  summarize()
}

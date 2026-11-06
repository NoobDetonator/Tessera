// Installs a packed Tessera into a brand-new dsh home and checks it works with nothing from this checkout.
// Usage: node e2e/run.mjs release.mjs <path-or-url-of-.tgz>
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const spec = process.argv[2]
if (spec === undefined) throw new Error('usage: release.mjs <path or URL of the .tgz>')
const home = resolve(import.meta.dirname, '../../.test-run/release-home')
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
process.env.TESSERA_DSH_HOME = home
// Imported only now, so the harness picks up the clean home.
const { check, launch, sleep, summarize, until } = await import('./lib.mjs')
const { projectRoot } = await import('../harness.mjs')

const app = await launch({ name: 'release', port: 3186, installSpec: spec })
const { page } = app
try {
  const installed = join(home, 'profiles', 'web', 'node_modules', '@tessera', 'dsh-tessera')
  check('the package is installed in the profile', existsSync(join(installed, 'lib', 'client.js')))
  const real = realpathSync(installed)
  check('it is a copy from the tarball, not a link to this checkout', !real.startsWith(resolve(projectRoot, 'tessera-plugin')), real)
  const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  check('dsh registered it as a bundle', profile.dsh?.profile?.bundles?.includes('@tessera/dsh-tessera'), JSON.stringify(profile.dsh))

  check('the Tessera panel opens', (await page.getByTestId('tessera-root').count()) === 1)
  check('the Inbox is created on first start', existsSync(join(app.boards, 'Inbox.canvas')))
  await page.getByRole('button', { name: 'Create a board' }).click()
  await page.locator('.t-dialog input').first().fill('Release check')
  await page.keyboard.press('Enter')
  const canvas = page.getByTestId('tessera-canvas')
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  await page.mouse.dblclick(box.x + 300, box.y + 200)
  await page.locator('.t-editor').fill('Installed from the release')
  await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10)
  await until(async () => (await page.locator('.t-status').textContent()) === 'Saved', { label: 'saved' })
  await sleep(700)
  check('a note saves to disk', app.readBoard('Release check.canvas').nodes[0]?.text === 'Installed from the release')

  // The Host half registered its skill, which shows without calling a model.
  await page.getByTestId('ask-agent').click()
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ timeout: 15000 })
  await until(async () => (await composer.textContent()).includes('Release check.canvas'), { label: 'ask the agent' })
  check('"Ask the agent" opens the chat with the board', true)
  await composer.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type('/tessera')
  await sleep(1500)
  check('the agent skill is registered', (await page.locator('body').innerText()).includes('tessera-boards'))
  check('no console errors', app.problems.length === 0, app.problems.join('\n'))
} catch (error) {
  check(`script finished: ${error.message}`, false)
  await app.shot('zz-failure').catch(() => {})
  console.log(app.run.log.join('').replace(/token=[^&\s]+/g, 'token=***').slice(-2500))
} finally {
  await app.stop()
  summarize()
}

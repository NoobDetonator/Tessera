// Shared smoke-test helpers: a fresh dsh with its own board folder, and a browser page on the panel.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { installPlugin, projectRoot, startDsh } from '../harness.mjs'

export { projectRoot }
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) throw new Error('Run through tessera-build/e2e/run.mjs so the local browser is used.')

let passed = 0
const failures = []
export function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name} ${detail}`)
  }
}
export function summarize() {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(failures.map(f => ` - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

export async function launch({ name, port, withKey = false, env = {}, seed } = {}) {
  installPlugin()
  const runDir = resolve(projectRoot, '.test-run', name)
  rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const boards = join(runDir, 'tessera')
  mkdirSync(boards, { recursive: true })
  if (seed) {
    for (const [file, content] of Object.entries(seed)) {
      mkdirSync(dirname(join(boards, file)), { recursive: true })
      writeFileSync(join(boards, file), typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
    }
  }
  // Without any key the shell blocks on a sign-in dialog. UI-only runs never call the model, so a placeholder is enough.
  const run = startDsh({ port, runDir, withKey, env: withKey ? env : { DEEPSEEK_API_KEY: 'placeholder-not-a-real-key', ...env } })
  const url = await run.url
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 500)}`) })
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: /^(Continue|Continuar)$/ }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Tessera' }).first().click({ timeout: 15000 })
  await page.getByTestId('tessera-root').waitFor({ timeout: 15000 })
  const stop = async () => {
    await browser.close().catch(() => {})
    await run.stop()
  }
  const shots = resolve(projectRoot, 'screenshots', name)
  mkdirSync(shots, { recursive: true })
  return {
    page, context, run, boards, runDir, problems, stop, url,
    shot: file => page.screenshot({ path: join(shots, `${file}.png`) }),
    readBoard: file => JSON.parse(readFileSync(join(boards, file), 'utf8')),
    writeBoard: (file, doc) => writeFileSync(join(boards, file), JSON.stringify(doc)),
  }
}

export const sleep = ms => new Promise(done => setTimeout(done, ms))

export async function until(test, { timeout = 8000, step = 100, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await sleep(step)
  }
}

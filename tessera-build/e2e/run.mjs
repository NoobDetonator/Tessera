// Usage: node e2e/run.mjs <phase-script>. Builds, then points Playwright at the browser kept inside this folder.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = process.argv[2]
if (!script) {
  console.error('usage: node e2e/run.mjs <script>')
  process.exit(2)
}
const build = spawnSync(process.execPath, [resolve(here, '../build.mjs')], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)
const result = spawnSync(process.execPath, [resolve(here, script), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(here, '../.pw-browsers') },
})
process.exit(result.status ?? 1)

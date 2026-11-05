// Runs every suite in turn and prints one line each. Add --model to include the two that spend API credit.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = ['phase-1.mjs', 'phase-2.mjs', 'phase-3.mjs', 'phase-5.mjs', 'phase-6.mjs', 'final.mjs', 'config.mjs']
if (process.argv.includes('--model')) suites.push('phase-4.mjs', 'phase-4-readonly.mjs')

let failed = 0
for (const suite of suites) {
  const result = spawnSync(process.execPath, [resolve(here, 'run.mjs'), suite], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout}${result.stderr}`
  const summary = output.match(/\d+ passed, \d+ failed/)?.[0] ?? 'did not finish'
  const ok = result.status === 0 && summary.endsWith(' 0 failed')
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${suite}: ${summary}`)
  for (const line of output.split('\n')) if (/FAIL |^PERF |agent finished|frames: /.test(line)) console.log(`     ${line.trim().slice(0, 500)}`)
}
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITES FAILED`)
process.exit(failed === 0 ? 0 : 1)

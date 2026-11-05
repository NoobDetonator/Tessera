// Runs the pinned dsh with every piece of state contained in this folder.
// `node harness.mjs install` links the plugin into the web profile.
// `node harness.mjs start [port]` runs the Web UI until killed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(here, '..')
export const dshHome = resolve(projectRoot, '.dsh-home')
export const defaultRunDir = resolve(projectRoot, '.test-run/default')
const bin = resolve(here, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

function containedEnv(extra = {}) {
  const profile = resolve(dshHome, 'user')
  mkdirSync(profile, { recursive: true })
  return {
    ...process.env,
    DSH_HOME: dshHome,
    HOME: profile,
    USERPROFILE: profile,
    LOCALAPPDATA: resolve(profile, 'AppData/Local'),
    APPDATA: resolve(profile, 'AppData/Roaming'),
    PNPM_HOME: resolve(profile, 'pnpm'),
    PATH: `${resolve(here, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
    ...extra,
  }
}

/** Reads the API key file without ever exposing the value on stdout. */
export function apiKeyEnv() {
  const file = resolve(projectRoot, 'env.env')
  if (!existsSync(file)) throw new Error('env.env is missing')
  const match = readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*"?([^"\r\n]+)"?\s*$/m)
  if (!match) throw new Error('env.env has no DEEPSEEK_API_KEY line')
  return { DEEPSEEK_API_KEY: match[1] }
}

export function installPlugin() {
  const result = spawnSync(process.execPath, [bin, 'plugin', '--profile', 'web', 'add', resolve(projectRoot, 'tessera-plugin')], {
    cwd: projectRoot, env: containedEnv(), encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`plugin add failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/** Starts `dsh --profile web`; resolves with the tokenized URL once the server prints it. */
export function startDsh({ port = 3180, runDir = defaultRunDir, env = {}, withKey = false, args = [] } = {}) {
  mkdirSync(runDir, { recursive: true })
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--no-open', '--port', String(port), ...args], {
    cwd: runDir,
    env: containedEnv({ ...(withKey ? apiKeyEnv() : {}), ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  const url = new Promise((ok, fail) => {
    const onData = (chunk) => {
      const text = chunk.toString()
      log.push(text)
      const found = text.match(/dsh web:\s*(https?:\/\/\S+)/)
      if (found) ok(found[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => fail(new Error(`dsh exited with ${code}:\n${log.join('').slice(-4000)}`)))
    setTimeout(() => fail(new Error(`dsh startup timeout:\n${log.join('').slice(-4000)}`)), 120_000).unref()
  })
  const stop = () => new Promise((ok) => {
    if (child.exitCode !== null) return ok()
    child.once('exit', () => ok())
    child.kill()
  })
  return { child, url, log, stop }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, port] = process.argv.slice(2)
  if (command === 'install') console.log(installPlugin())
  else if (command === 'start') {
    const run = startDsh({ port: Number(port ?? 3180), withKey: process.argv.includes('--key') })
    console.log('url', await run.url)
    run.child.stdout.pipe(process.stdout)
    run.child.stderr.pipe(process.stderr)
  } else {
    console.error('usage: node harness.mjs install | start [port] [--key]')
    process.exit(1)
  }
}

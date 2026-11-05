// Builds the Tessera bundle: an ESM Host half and a __ModuleLoader__ Client half.
import { build, context } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '../tessera-plugin')
const pkg = JSON.parse(await readFile(resolve(plugin, 'package.json'), 'utf8'))
await mkdir(resolve(plugin, 'lib'), { recursive: true })

// Every specifier here is seeded by the shell's frozen module table (client/web/src/platform.ts).
const clientExternals = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

const hostOptions = {
  absWorkingDir: plugin,
  tsconfigRaw: '{}', // tsconfig paths point at type packages and must not pull them into the bundle
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'warning',
  packages: 'external',
}

const clientOptions = {
  absWorkingDir: plugin,
  tsconfigRaw: '{}',
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'warning',
  external: clientExternals,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  // The module loader hands the factory a synchronous `require`; esbuild's CJS output uses it directly.
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory(require){const module={exports:{}};let exports=module.exports;` },
  footer: { js: 'return module.exports}});' },
}

if (process.argv.includes('--watch')) {
  for (const options of [hostOptions, clientOptions]) await (await context(options)).watch()
  console.log('tessera: watching')
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
  console.log('tessera: built lib/index.js and lib/client.js')
}

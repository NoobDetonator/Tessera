# Tessera architecture

Tessera is one DeepSeek Harness bundle with a Host half and a Client half. Built against `@deepseek-ai/dsh@0.2.2-rc.1`.

```text
Browser (shell page)                         Node (dsh Host)
┌──────────────────────────┐                 ┌─────────────────────────────────────┐
│ Client half (lib/client.js)                │ Host half (lib/index.js)            │
│  App, CanvasView, cards  │  fetch /tessera/api   http.ts  auth, routes, files    │
│  store.ts ───────────────┼────────────────►│  workspace.ts  board list, prefs    │
│  bridge.ts ◄─────────────┼─────SSE─────────┤  store.ts  memory, undo, atomic     │
│                          │                 │            writes, disk merge       │
└──────────────────────────┘                 │  tools.ts  tessera_* agent tools    │
                                             └──────────────┬──────────────────────┘
                                                            ▼
                                                   tessera/*.canvas, _assets/, _history/
```

## Folders

| Path | What it holds |
|---|---|
| `tessera-plugin/src/shared/` | Pure TypeScript used by both halves: JSON Canvas model and validator, degradation rules, `Change`, three-way merge, geometry |
| `tessera-plugin/src/host/` | Board store, HTTP bridge, agent tools, skill |
| `tessera-plugin/src/client/` | React UI. `bridge.ts` is the only file that talks to the Host |
| `tessera-plugin/test/` | Unit tests, run with `node --test` |
| `tessera-build/` | esbuild, TypeScript, Playwright, the pinned dsh, and the smoke tests in `e2e/` |
| `tessera/` | Default board folder, relative to the directory dsh starts in |

## How it plugs into the Harness

Verified against the source at tag `dsh-v0.2.2-rc.1`.

- **Package.** `package.json` declares `dsh.bundle.patch`, which inserts the Host row, and `dsh.client`, which declares the browser half. `exports` maps `.` and `./client`.
- **Client format.** esbuild emits CommonJS wrapped in `window.__ModuleLoader__.load({ id, factory(require) })`. The shell's frozen module table supplies `react`, `react/jsx-runtime` and `dsh-client-ui-primitives`, so those stay external.
- **UI.** The panel is a `main` slot entry keyed `tessera`, with a matching `sidebar.panellist` entry. Colors come from the `--dsw-alias-*` theme tokens.
- **Tools.** `ctx.tools.register(defineTool(...))`, with a mandatory `output` schema.
- **Skill.** `ctx.skills.register(...)`, an embedded runtime skill.

## Decisions

### The Host owns state and undo

The Host keeps each open board in memory and is authoritative. The Client applies an edit locally at once, then sends it through a serial per-board queue. Every revision goes out over SSE.

Undo and redo live on the Host because agent edits have to undo the same way as user edits, even when no tab was open while the agent ran. They also survive a page reload for the life of the process.

### One mutation type

A `Change` upserts or deletes whole objects by id. Applying, inverting and composing are short and easy to verify. Unknown fields travel with their object, so nothing has to know about them.

### Never lose data

- Writes are atomic (temp file, then rename) and debounced 500 ms.
- Before each write the Host re-reads the file and folds in any disk edit the watcher has not delivered yet.
- The three-way merge is node and field level, and a real conflict keeps the local value.
- An unparseable external file is copied to `_history/corrupt/` before anything overwrites it.
- A failed write keeps memory intact, shows a warning, and retries.
- Offline edits stay in the Client queue and retry.

### Opening a board never rewrites it

A card's height follows its content only when Tessera wrote that card (`tessera` metadata present). A card from a plain file keeps its stored height until the user edits it.

### The bridge

One prefix route at `/tessera/api`. Requests must pass three checks: a loopback `Host` (blocks DNS rebinding), a matching `Origin` (blocks cross-site calls), and the per-process token. The token reaches the browser through an index-injection row, and the Harness already gates that page behind its own login cookie. `fetch` sends the token as a header. `EventSource` and media `src` URLs send it as a query parameter. The route does not register when the server is bound to a non-loopback address.

Files are served inline only for images, audio, video, PDF and plain text. Anything else downloads, so an uploaded HTML file cannot run on this origin. SVG responses carry a script-blocking policy.

### Why `node:fs` rather than `ctx.fs`

`ctx.fs` has no binary write and watches one directory level. See `QUESTIONS.md` Q1.

## Rendering

Cards are DOM elements positioned inside one CSS-transformed world element. Panning and zooming write that transform directly, without a React render. The render set is recalculated only when the view leaves a margin around what is already mounted, so off-screen cards are not in the DOM. Below 30% zoom, cards draw as plain boxes. A drag updates live rectangles in local state and commits one `Change` on release, which makes it one undo step.

Card views read the document from the store instead of receiving it as a prop, so one edit re-renders only the card it touched.

## Columns and Frames

A Column's order lives in `tessera.items`. A layout pass stacks the members and sizes the column whenever the document changes, and stays out of undo because it is derived. It only touches columns with `items`, so a plain group that merely looks like a column is never moved.

A Frame owns cards by geometry: the smallest group containing a card's center. Its body lets pointers through, so box-select and double-click still work inside it. You select or drag it by its title.

Moving cards to another board changes two files, so the undo entry on the source board carries the target board's inverse too. One undo restores both.

## Testing

| Command (from `tessera-build/`) | What it runs |
|---|---|
| `node --test ../tessera-plugin/test/*.test.ts` | Data layer, store and bridge unit tests |
| `npx tsc -p tsconfig.plugin.json --noEmit` | Strict type check |
| `node e2e/run.mjs phase-N.mjs` | Builds, boots a real `dsh --profile web`, drives it in headless Chromium, and saves screenshots to `screenshots/phase-N/` |

All test state stays inside this folder: `DSH_HOME` is `.dsh-home/`, boards are under `.test-run/`, and the browser is in `tessera-build/.pw-browsers/`. UI-only runs use a placeholder API key. Your real key is read from `env.env` only for the model test.

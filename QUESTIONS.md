# Questions and assumptions

Open items for review. Each one lists the assumption I took so work could continue. Nothing here blocked progress.

## Discrepancies with the section 1 findings

Verified against `vendor/deepseek-harness` at tag `dsh-v0.2.2-rc.1`.

| # | Finding | What the source says | What I did |
|---|---|---|---|
| D1 | The Client `require` only resolves `react`; no JSX runtime | The shell's frozen table (`packages/client/web/src/platform.ts`) has `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives` and `dsh-client-ui-dockkit` | Build with JSX through `react/jsx-runtime` and reuse `MarkdownText` and other primitives. The esbuild format is unchanged. |
| D2 | `webServer` is a Loader row | The row id is `webserver`; the service is `ctx.webServer` | Inject `webServer`, which is what matters. |
| D3 | Row `fs` (`fs-sandbox`) | The row id is `fs-sandbox`; the service is `ctx.fs`. It has no binary write, and `watch` covers one file or a directory's direct entries only | See Q1. |
| D4 | `dsh plugin` works on its own | `dsh plugin` shells out to `pnpm`, which must be on PATH | `pnpm` is a devDependency of `tessera-build/`. `tessera-build/harness.mjs` puts it on PATH. |

These findings held up: the `main` and `sidebar.panellist` slots, `shell.overlay`, mandatory `output` through `defineTool`, the bundle structure, and `ctx.remote` needing internal codegen (`docs/cookbook/adding-a-remote-api.md`). Decision 1 (the HTTP bridge) still stands.

## Open questions

**Q1. Board files go through `node:fs`, not `ctx.fs`.** `ctx.fs` writes text only and watches a single directory level. Tessera needs binary assets and a recursive watch of the board tree, so one code path through `node:fs` (temp file plus rename) is simpler than two. Paths are confined to the board folder, and symlinks that point outside it are refused.
- Consequence: a session in `read-only` sandbox mode can still change boards through the Tessera tools. See Q6 for how the tools treat this.

**Q2. Where the token reaches the browser.** The per-process token goes into `window.__TESSERA__` through a `webserver/index-inject` row. The index response is already gated by the Harness browser cookie (`packages/host/frontend-static`), so only an authenticated browser receives it. Every request also has its `Host` and `Origin` checked to block DNS rebinding and cross-site requests. The route refuses to register when the server is bound to a non-loopback address.

**Q3. Degradation rules beyond the four you listed.** I read "anything else → Note" as applying to text nodes and to node types Tessera does not recognise.
- A plain group without stacked children becomes a Frame, not a Note.
- A `link` node stays a Link.
- A `file` node goes by extension: Board, Image or File.
- An unrecognised node type displays as a Note and is saved back untouched.

**Q4. Keyboard zoom.** The spec says "Zoom with wheel, pinch or Z" without saying how Z behaves. I took `Z` as zoom in at the pointer and `Shift+Z` as zoom out.

**Q5. Telling a mouse wheel from a trackpad.** Browsers do not report the device. Large integer `deltaY` with no `deltaX` is treated as a mouse wheel and zooms. Everything else pans. A pinch arrives as `ctrlKey` and zooms.

**Q6. Harness session log upload (not a Tessera call).** The base bundle enables `session-log-deepseek`, which sends the session log to the official DeepSeek API alongside model requests. Tessera makes no such call, but board content the agent reads ends up in that log. I left the Harness default alone. To turn it off, disable the row in a profile patch:

```yaml
- id: session-log-deepseek
  disabled: true
```

**Q7. Obsidian paths.** JSON Canvas `file` paths are relative to the vault root. Tessera writes them relative to the board folder, so nested boards and images resolve only when you open `tessera/` itself as the vault. If you would rather open a parent folder as the vault, tell me and I will make the path prefix configurable.

**Q8. To-do due dates.** Due dates live in the item text (`- [ ] Buy milk 📅 2026-11-10`, the Obsidian Tasks convention) instead of in `tessera` metadata, so they survive Obsidian stripping unknown fields.

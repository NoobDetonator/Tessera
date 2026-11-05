# Tessera

A local-first infinite board for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Place cards on a canvas, group and connect them, and nest boards inside boards. Boards are plain [JSON Canvas](https://jsoncanvas.org/) files, the same `.canvas` format Obsidian uses. The Harness agent can read and edit them with you.

Built and tested against `@deepseek-ai/dsh@0.2.2-rc.1`. The plugin only declares support for `>=0.2.2-rc.1 <0.3.0`, because Harness APIs still change between versions.

## Install

You need Node 24.9 or newer, the `dsh` CLI, and `pnpm` on your PATH (`dsh plugin` calls it).

1. Build the plugin:

```bash
cd tessera-build && npm install && node build.mjs
```

2. Add it to your Web profile, from the project root:

```bash
dsh plugin --profile web add ./tessera-plugin
```

3. Start the Web UI and click **Tessera** in the sidebar:

```bash
dsh --profile web
```

Boards are stored in `tessera/`, inside the folder you start `dsh` from. To change that or anything else, add a `config` to the row in your profile's `cordis.patch.yml`:

```yaml
- id: tessera
  config:
    root: /path/to/boards
```

| Option | Default | Meaning |
|---|---|---|
| `root` | `tessera` | Board folder |
| `saveDebounceMs` | `500` | Delay between the last edit and the write |
| `autoSnapshotMinutes` | `10` | Time between automatic history snapshots of a board being edited |
| `confirmTimeoutMs` | `120000` | How long an agent delete waits for your answer before counting as declined |
| `maxAssetBytes` | 1 GiB | Largest single upload |
| `maxJsonBytes` | 64 MiB | Largest JSON request |

### Using it with Obsidian

Open the `tessera/` folder itself as your vault, so nested boards and images resolve.

Obsidian may remove Tessera's extra fields when it saves. Tessera still opens those boards and works out each card's type from its content. Tags, locks, captions and link previews are lost at that point, and a column's order falls back to top-to-bottom position. Due dates are safe, because they live in the checklist text.

## Features

**Canvas.** Pan, zoom, fit to all, an 8 px snap grid, alignment guides, box and Shift selection, align and distribute, unlimited undo and redo, copy and paste between boards, a minimap, and context menus. Paste an image, URL, hex color or text to get the matching card, or drop files from your computer.

**Cards.** Each has a resizable width, a color (top strip or full fill), tags, a lock and a stable ID.

| Card | What it does |
|---|---|
| Note | Markdown with headings, nested lists, tables, code blocks, clickable checkboxes and `[[links]]` |
| Document | Title and excerpt on the canvas, with a full-width editor and live preview |
| Image | Upload, paste or drop, with a caption, a lightbox and aspect-locked resize |
| Link | Open Graph preview. YouTube and Vimeo play inline |
| File | PDF preview, audio and video players, and "open with system app" for anything else |
| To-do | Checklist with due dates, reordering and progress |
| Color | HEX, RGB and HSL, click to copy. Swatches in a column export as CSS or JSON |
| Sketch | Freehand drawing with pen pressure, three brushes and an eraser, stored as SVG |
| Board | A nested board with a live mini-preview and breadcrumbs. Drop cards on it to move them inside |
| Column | An ordered stack you can reorder and collapse. Shift+drop one card on another to create one |
| Frame | A titled region whose cards move with it. Frames are also presentation slides |

Edges can be straight, curved or orthogonal, solid or dashed, with arrowheads, a label and a color. They follow their cards.

**Finding and organizing.** A board sidebar with search and favorites, global search, a command palette, tag filters that dim non-matching cards, backlinks, and auto-layout as a grid, a tree following edges, or clusters by tag.

**Templates.** Moodboard, Character sheet, Worldbuilding hub, Story structure, Game design doc, Project plan, Creative brief and Research. You can also save any board as a template.

**History.** Automatic and named snapshots in `tessera/_history/`, with a timeline to preview and restore. Restoring saves the current state first, and undo reverses it.

**Presenting.** Full-screen slides from your frames, ordered by `tessera.slide` and then top to bottom, left to right. Focus mode dims everything except the selected card and what it connects to.

**Exports.** PNG or SVG of the board or the selection, a Markdown outline in reading order with nested boards as nested headings, and PDF through the browser's print dialog.

**Inbox.** `Inbox.canvas` is always there, at the top of the sidebar, for links and notes the agent clips.

## Shortcuts

On a Mac, use Cmd instead of Ctrl.

| Keys | Action |
|---|---|
| Space + drag, middle-button drag, or trackpad scroll | Pan |
| Mouse wheel, pinch | Zoom |
| `Z` / `Shift+Z` | Zoom in / out at the pointer |
| `Ctrl+0` | Fit all |
| Double-click empty space | New note |
| Double-click a card | Edit, open, or enter it |
| `Enter` | Edit the selected text card |
| `Esc` | Stop editing, clear the selection, leave focus mode |
| `Tab` / `Shift+Tab` | Next / previous card |
| Arrow keys | Nudge by 8 px (`Alt`: 1 px) |
| `Alt` while dragging or resizing | Turn off snapping |
| `Shift` + click | Add to or remove from the selection |
| `Shift` + drop on a card | Make a column |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Undo / redo |
| `Ctrl+A` | Select all |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste |
| `Ctrl+D` | Duplicate |
| `Ctrl+L` | Lock or unlock |
| `Delete` or `Backspace` | Delete the selection |
| `Shift+F10` or the Menu key | Open the context menu |
| `Ctrl+K` | Search all boards |
| `/` | Command palette |
| `F` | Focus mode |
| `[[` in a note | Link to a card or board |
| `Alt+Up` / `Alt+Down` in a checklist | Move the item |
| Arrow keys, `Space`, `PageUp` / `PageDown` while presenting | Change slide (`Esc` to leave) |

## Agent tools

All tools return compact JSON. Edits appear live in any open tab, and **everything the agent changes in one turn undoes as a single step**. In a session running in read-only mode, the tools that change boards are refused.

| Tool | What it does |
|---|---|
| `tessera_list_boards()` | Every board, with its path, title, card count and nested boards |
| `tessera_read_board(path, {depth?})` | Cards and edges. Text over 400 characters is cut and flagged. `depth` includes nested boards |
| `tessera_search(query, {tags?, types?, board?})` | Search card text across boards. Returns at most 50 matches |
| `tessera_create_cards(path, cards[])` | Add up to 200 cards. Cards without `x` and `y` are placed without overlapping anything |
| `tessera_update_cards(path, updates[])` | Change text, color, tags, position and so on. Reports what it skipped, such as locked cards |
| `tessera_delete_cards(path, ids[])` | Asks you in a dialog over whichever panel is showing. A no comes back as `declined: true` |
| `tessera_connect(path, fromId, toId, {label?, style?})` | Draw an edge |
| `tessera_group(path, ids[], {as, title})` | `column`, `frame` or `board`. `board` moves the cards to a new nested board |
| `tessera_layout(path, ids[], {mode})` | `grid`, `tree` or `cluster`. Empty `ids` means every top-level card |
| `tessera_create_board(parentPath, title, {template?})` | Create a board, nested when `parentPath` is set |
| `tessera_snapshot(path, name)` | Save a named version to history |

The `tessera-boards` skill teaches the agent these workflows: organize a messy board by theme into frames, turn a board into a document, build a worldbuilding hub, add a "what's missing" note, and summarize a board.

The **Ask the agent** button opens a new chat with the current board and selected cards already in the message.

## Privacy and network

Tessera makes no network calls of its own except these, and all of them come from something you did:

- **Link previews.** The page is fetched through the Harness's `ctx.web.fetch`, and the preview image then loads directly in your browser from the remote site. Local and private addresses are refused.
- **Video embeds.** A YouTube or Vimeo player loads only when you press play.

The bridge is a route on the Harness's own web server, and it turns itself off if that server is bound to anything but a loopback address. Every request needs a per-process token and a same-origin, loopback `Host`.

**One Harness default worth knowing about.** It is not part of Tessera, but the Harness's `session-log-deepseek` row, on by default, sends the session log to the official DeepSeek API alongside model requests. Board content the agent reads ends up in that log. To turn it off, add this to your profile's `cordis.patch.yml`:

```yaml
- id: session-log-deepseek
  disabled: true
```

## Known limitations

**Not verified on real hardware or in a real browser.** The tests run in headless Chromium:
- PDF preview. Headless Chromium has no PDF viewer, so only the embed element is confirmed.
- Pen pressure from a real stylus. Tests use a mouse; pressure handling itself is unit tested.
- Pinch and trackpad gestures, which the tests send as synthetic wheel events.
- Video playback inside the YouTube and Vimeo embeds.
- "Open with system app". Its refusal rules are tested, but actually launching an app is not.
- The system color picker opened by double-clicking a Color card.
- Opening boards in Obsidian itself. The strict validator passes, and the round trip is tested without Obsidian.

**Behavior you may run into:**
- Telling a mouse wheel from a trackpad is a guess: large whole-number scroll steps zoom, and anything else pans. Some mice or drivers may land on the wrong side.
- Exported PNG and SVG files show cards in a simplified style with wrapped plain text, not the exact on-screen rendering. Text wrapping is estimated.
- Backlinks only cover cards on the same board.
- Undoing a "group as board" empties the new nested board but leaves its file behind.
- Link cards the agent creates show no preview until you click "Load preview".
- The agent can only clip remote media as Link cards. It cannot download a file into a board.
- Assets replaced by a new sketch or no longer used stay in `_assets/`. Nothing cleans them up.
- The Chinese translation covers only part of the UI, and the rest falls back to English. English and Portuguese are complete.
- The Harness's plugin APIs are pre-stable, so a new `dsh` minor version may need changes here.

## Development

From `tessera-build/`:

```bash
npm install
```

```bash
node build.mjs
```

```bash
npx tsc -p tsconfig.plugin.json --noEmit
```

```bash
node --test ../tessera-plugin/test/*.test.ts
```

To run the browser tests, install Chromium inside this folder once:

```bash
PLAYWRIGHT_BROWSERS_PATH=.pw-browsers npx playwright install chromium --only-shell
```

Then run a suite. `final.mjs` and `phase-1.mjs` to `phase-6.mjs` need no API key:

```bash
node e2e/run.mjs final.mjs
```

`phase-4.mjs` and `phase-4-readonly.mjs` use the real model and spend a small amount of API credit. They read `DEEPSEEK_API_KEY` from `env.env` in the project root, which git ignores.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, [PROGRESS.md](PROGRESS.md) for what was tested, and [QUESTIONS.md](QUESTIONS.md) for open decisions.

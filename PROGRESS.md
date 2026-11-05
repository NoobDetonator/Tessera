# Progress

**Pinned Harness version:** `@deepseek-ai/dsh@0.2.2-rc.1` (tag `dsh-v0.2.2-rc.1`, the npm `latest` when work started).

**Status:** Phases 1 to 5 done. Working on Phase 6.

Open items and assumptions are in [QUESTIONS.md](QUESTIONS.md). The design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Phases

| Phase | Status | Evidence |
|---|---|---|
| 1. Foundations | Done, tag `phase-1` | Browser checks in `e2e/phase-1.mjs` |
| 2. Card types | Done, tag `phase-2` | Browser checks in `e2e/phase-2.mjs` |
| 3. Structure | Done, tag `phase-3` | Browser checks in `e2e/phase-3.mjs`, including 2,000 cards |
| 4. Agent tools, skill, Ask the agent | Done, tag `phase-4` | `e2e/phase-4.mjs` with the real model |
| 5. Power features | Done, tag `phase-5` | Browser checks in `e2e/phase-5.mjs` |
| 6. Extras | Next | |

## Phase 1

**Built:** the bridge (auth, SSE, files), the board store (undo, atomic writes, disk merge), the canvas (pan, zoom, snap, guides, box and Shift select, drag, resize, edges, virtualization), Notes with Markdown, `[[links]]` and checkboxes, copy and paste within and between boards, the context menu, and the board sidebar with search and favorites.

**Tested against a real `dsh --profile web` in headless Chromium:**
- 20 notes created by double-click survive a full page reload.
- The saved file passes the strict JSON Canvas validator.
- Unknown root and node fields survive an external edit and a later save.
- Drag and delete each undo as one step, and redo works.
- An external disk edit appears live.
- A board with no metadata opens with the right card kinds, and opening it leaves the file unchanged.
- No console errors.

**Unit tests cover:** round trip, the validator, all degradation rules, `Change` apply/invert/compose, three-way merge, unsaved edits surviving an external change, failed saves, corrupt files, token and Host and Origin checks, path traversal, symlink escape, upload limits, and range requests.

**Bugs the smoke test caught, now fixed:**
- Opening a board could shrink group and plain-file cards and write that to disk. See "Opening a board never rewrites it" in ARCHITECTURE.md.
- esbuild was bundling Harness packages through tsconfig `paths`, which stopped the plugin from activating.

**Not verified yet:**
- Opening files in Obsidian. That is your check, per the mission.
- Performance with 1,000+ cards. It gets its own measured test in Phase 3.

**Note on git history:** commit `b31bd9f` says it fixed a flaky store test, but its teardown race was still there. Commit `80cb0c2` is the real fix. The flakiness was in the tests, not in the store.

## Phase 2

**Built:** Image (aspect-locked resize, lightbox, caption), Link (Open Graph preview, inline YouTube and Vimeo), File (PDF, audio, video, generic with "open with system app"), To-do (due dates, drag and keyboard reorder, progress), Color (HEX, RGB, HSL, click to copy, picker), Document (title and excerpt, full-width editor with live preview), the left toolbar (click, drag or keyboard to place), paste (image, URL, hex, text), OS file drop, and an in-panel dialog replacing browser prompts.

**Tested in the browser:** placing cards all three ways, the checklist down to the saved text, every paste type, dropping each file type, content-hash asset names, images loading through the authenticated route, aspect-locked resize, lightbox and caption, the document editor, tables and code blocks in Notes, toggling a checkbox and undoing it, a real preview through `ctx.web.fetch`, and copying cards to another board with new ids.

**Bugs the smoke tests caught, now fixed:**
- Typing a space at the end of a checklist item was impossible, because each keystroke rewrote the field with trailing spaces removed.
- Double-clicking a card created a new note behind it instead of editing it, because pointer capture sent the event to the canvas.
- Resize handles and connection anchors were clipped on fixed-height cards, so they could not be reached.

**Not verified:**
- PDF rendering. Headless Chromium has no PDF viewer, so the test only confirms the embed element exists. Please try one in a real browser.
- Actually playing a YouTube or Vimeo video. The test confirms the play button appears, but not the embedded player.
- "Open with system app". The test run has no desktop to open it on, so only the refusal rules are in place, and the route has no test yet.

## Phase 3

**Built:** Column (drag in and out, reorder, collapse, Shift+drop to create, palette export), Frame (cards move with it, pointers pass through its body), nested Board (mini-preview that updates live, breadcrumbs, drop a card to move it inside as one undo across both files, nested sidebar tree), edge styling (straight, curved, orthogonal, dashed, arrowheads, label, color), the selection bar (color, fill or strip, tags, lock, align, distribute, group), the minimap, and Tab navigation between cards.

**Measured with 2,000 cards and 285 edges** in headless Chromium, software rendered, on this machine:

| Measure | Result |
|---|---|
| Open to first card | 712 ms |
| Cards in the DOM, zoomed in | 9 of 2,000 |
| Cards in the DOM, fit to all | 2,000, drawn as plain boxes below 30% zoom |
| Pan, zoomed in | median 16.7 ms a frame, p95 16.8 ms, worst 33 ms |
| Pan, fit to all | median 16.7 ms a frame, p95 33 ms, worst 267 ms |

These are from one run, so treat them as a rough indication. The 267 ms outlier in the zoomed-out case means an occasional visible hitch, which I did not chase down.

**Bugs the smoke tests caught, now fixed:**
- A Color card could not be selected or dragged, because its swatch took the click. Click now selects, and double-click opens the picker.

**Not verified:**
- Pinch zoom and trackpad panning on real hardware. The tests send synthetic wheel events.
- Double-click on a Color card opening the system color picker. The picker is an OS dialog the test cannot see.

## Phase 4

**Built:** all eleven `tessera_*` tools with output schemas, the `tessera-boards` skill with the five workflows, the "Ask the agent" button, and a delete confirmation that appears over any panel. To support the tools, this phase also added auto-layout, search, version history and the eight built-in templates on the Host; their UI comes in Phases 5 and 6.

**Acceptance test, real model (DeepSeek V4.1 Flash, `deepseek-flash`), run through the Web UI:**
- A shuffled, overlapping board of 30 cards from 3 subjects, organized in about 45 seconds.
- The model made three frames: Cooking, Gardening and Astronomy, each with exactly its 10 cards. That sort quality is the model's, from one run, so another run could differ.
- No card lost, no text changed, every card in exactly one frame, and the file passes the strict validator.
- **One undo removed all three frames and put all 30 cards back at their exact coordinates.** Redo brought it all back.

**Also tested with the real model:** a delete asks in a dialog over the chat, declining keeps the card, approving removes it. A session in read-only mode could not change a board. The skill appears in the chat's slash menu.

**How one undo covers a whole turn:** every edit in one agent turn shares an undo key taken from the Harness's `turn/start` event. Editing yourself in between starts a new step.

**Limitations:**
- Undoing a "group as board" empties the new nested board but leaves its file. Only the board's cards are undone.
- A Link card the agent creates shows no preview until you click "Load preview", so the agent adding links causes no network calls.
- The other four skill workflows are written but were not run against the model.

## Phase 5

**Built:** global search (Ctrl+K), the command palette (/), the tag filter that dims non-matching cards, the new-board dialog with all eight built-in templates, save board as template, `[[` autocomplete of cards and boards, a backlink badge on each linked card, and the history timeline with preview, restore and named versions.

**Tested in the browser:** every item above, including a search result on another board, a `/` typed in a note staying text, following links to cards and to boards, restoring a version and then undoing that, and a saved template creating a board with new ids and intact columns.

**Bugs the tests caught, now fixed:**
- A card linking to one target with two spellings counted twice in the backlinks.
- The history panel covered cards. It now takes its width from the canvas instead.

**Not verified in the browser:** automatic snapshots. The interval logic and pruning have unit tests with a fake clock, but no browser test waits the ten minutes.

**Limitation:** backlinks only cover cards on the same board. A `[[link]]` to another board opens it, but that board's cards do not list it as a source.

## Next step

Phase 6: Sketch, presentation mode, focus mode, auto-layout UI, exports, Inbox.

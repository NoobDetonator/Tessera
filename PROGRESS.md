# Progress

**Pinned Harness version:** `@deepseek-ai/dsh@0.2.2-rc.1` (tag `dsh-v0.2.2-rc.1`, the npm `latest` when work started).

**Status:** Phase 1 done. Working on Phase 2.

Open items and assumptions are in [QUESTIONS.md](QUESTIONS.md). The design is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Phases

| Phase | Status | Evidence |
|---|---|---|
| 1. Foundations | Done, tag `phase-1` | 48 unit tests, 25 browser checks |
| 2. Card types | Next | |
| 3. Structure | Not started | |
| 4. Agent tools, skill, Ask the agent | Not started | |
| 5. Power features | Not started | |
| 6. Extras | Not started | |

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

## Next step

Phase 2: Image, Link, File, To-do, Color and Document cards, the left toolbar, paste and drop.

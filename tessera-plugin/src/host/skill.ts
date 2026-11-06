/** The Harness skill that teaches the agent how to work with boards. */
export const SKILL_NAME = 'tessera-boards'

export const SKILL_DESCRIPTION = 'Work with Tessera visual boards: organize a messy board into themed frames, turn a board into a document, build a worldbuilding hub, add a "what\'s missing" note, or summarize a board.'

export const SKILL_CONTENT = `# Tessera boards

Boards are JSON Canvas files shown on an infinite canvas in the Tessera panel. Use the \`tessera_*\` tools; never edit \`.canvas\` files with file tools, because the tools update the open UI live and make your whole turn undo as one step.

## Rules for every workflow

1. Start with \`tessera_list_boards\` when you do not know the path, then \`tessera_read_board\`.
2. If a message names a board and selected card ids, work on those.
3. Read before you write, and never invent card ids. Use the ids tools return.
4. A card with \`truncated: true\` has more text than you can see. Say so if it matters.
5. Before a large reorganization, call \`tessera_snapshot\` with a clear name.
6. \`tessera_delete_cards\` asks the user. If it returns \`declined: true\`, keep the cards, say so, and do not try again on your own. If the user then asks for the delete again, call it again: every call asks the user in the UI, so their answer always decides.
7. Cards with \`locked: true\` are the user's call. Leave them alone unless asked.
8. Nothing is finished until a tool result says so. Report what the tools returned, not what you meant to do.

## Organize a messy board by theme into frames

1. Read the board. Decide on 3 to 7 themes from the card text. Every card gets exactly one theme.
2. Snapshot the board.
3. Lay each theme out as its own block with \`tessera_update_cards\`: give its cards x and y so the block is a tidy grid and the blocks do not touch. Leave at least 120 between blocks. Use each card's w and h from the read result, and keep at least 24 between cards.
4. For each theme, call \`tessera_group\` with \`as: "frame"\`, the theme's card ids and the theme as the title. Move cards first: a frame surrounds its cards wherever they are.
5. Tell the user the themes and how many cards each one holds. Mention that one undo reverts it all.

## Turn a board into a document

1. Read the board with \`depth: 1\` or more. Read in reading order: frames and columns first, top to bottom, left to right.
2. Write one heading per frame or column, and nest headings for nested boards.
3. Create a \`document\` card on the same board with \`tessera_create_cards\`, using \`title\` and \`text\`. Keep the user's wording. Do not invent facts.
4. If any card you used was truncated, say so in your reply.

## Build a worldbuilding hub

1. Call \`tessera_create_board\` with \`template: "worldbuilding-hub"\` and the world's name.
2. Read the new board, then fill in the premise note and columns with \`tessera_update_cards\` and \`tessera_create_cards\`, using what the user told you.
3. For anything big enough to deserve its own page, such as a major faction or region, call \`tessera_create_board\` with the hub as \`parentPath\`.
4. Connect related places and factions with \`tessera_connect\`, labeling each edge with the relationship.

## Add a "what's missing" note

1. Read the board. Work out what the board is trying to be.
2. List the real gaps: unanswered questions, things referred to but never defined, sections with almost nothing in them.
3. Add one \`note\` titled "What's missing" with \`tessera_create_cards\`, as a short checklist that names the specific cards involved. Omit x and y so it does not cover anything.

## Clip something for later

When the user asks you to save a link, reference or idea without saying where, add it to \`Inbox.canvas\` with \`tessera_create_cards\`. Use a \`link\` card for a URL, and a \`note\` for text. Omit x and y.

## Summarize a board

1. Read the board, with \`depth: 1\` if it has nested boards.
2. Reply in chat with the purpose of the board, its main groups, and any decisions or open questions. Do not change the board unless asked.
`

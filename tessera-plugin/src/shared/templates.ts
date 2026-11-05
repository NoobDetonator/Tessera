/** Built-in board templates. Each builds a fresh document with new ids. */
import { newId, type CanvasDoc, type CanvasNode } from './canvas.ts'
import { COLUMN_GAP, COLUMN_HEAD, COLUMN_PAD, estimateTextHeight } from './structure.ts'

export const BUILTIN_TEMPLATES = [
  { id: 'moodboard', title: 'Moodboard' },
  { id: 'character-sheet', title: 'Character sheet' },
  { id: 'worldbuilding-hub', title: 'Worldbuilding hub' },
  { id: 'story-structure', title: 'Story structure' },
  { id: 'game-design-doc', title: 'Game design doc' },
  { id: 'project-plan', title: 'Project plan' },
  { id: 'creative-brief', title: 'Creative brief' },
  { id: 'research', title: 'Research' },
] as const

export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATES)[number]['id']

const note = (x: number, y: number, text: string, width = 248, color?: string): CanvasNode => ({
  id: newId(), type: 'text', x, y, width, height: estimateTextHeight(text, width), text,
  tessera: { kind: 'note' }, ...(color !== undefined ? { color } : {}),
})

const swatch = (x: number, y: number, hex: string): CanvasNode => ({
  id: newId(), type: 'text', x, y, width: 136, height: 136, text: hex, tessera: { kind: 'color' },
})

const frame = (x: number, y: number, width: number, height: number, label: string, slide?: number): CanvasNode => ({
  id: newId(), type: 'group', x, y, width, height, label, tessera: { kind: 'frame', ...(slide !== undefined ? { slide } : {}) },
})

/** A Column with its members stacked. Members follow the column in z-order. */
function column(x: number, y: number, label: string, items: readonly string[], color?: string): CanvasNode[] {
  const width = 288
  const inner = width - COLUMN_PAD * 2
  let cursor = y + COLUMN_HEAD
  const members = items.map((text) => {
    const member = note(x + COLUMN_PAD, cursor, text, inner)
    cursor += member.height + COLUMN_GAP
    return member
  })
  const height = Math.max(COLUMN_HEAD + COLUMN_PAD, cursor - y + COLUMN_PAD - (members.length > 0 ? COLUMN_GAP : 0))
  const group: CanvasNode = {
    id: newId(), type: 'group', x, y, width, height, label,
    tessera: { kind: 'column', items: members.map(member => member.id) },
    ...(color !== undefined ? { color } : {}),
  }
  return [group, ...members]
}

const todo = (x: number, y: number, items: readonly string[]): CanvasNode => {
  const text = items.map(item => `- [ ] ${item}`).join('\n')
  return { id: newId(), type: 'text', x, y, width: 288, height: 44 + items.length * 26, text, tessera: { kind: 'todo' } }
}

const BUILDERS: Record<BuiltinTemplateId, () => CanvasNode[]> = {
  moodboard: () => [
    frame(0, 0, 720, 480, 'Images'),
    note(32, 56, 'Drop or paste reference images here.', 300),
    frame(752, 0, 336, 480, 'Palette'),
    swatch(784, 56, '#2d3142'), swatch(936, 56, '#ef8354'), swatch(784, 208, '#bfc0c0'), swatch(936, 208, '#ffffff'),
    frame(0, 512, 1088, 200, 'Words'),
    note(32, 568, 'Mood, texture and references in a few words.', 400),
  ],
  'character-sheet': () => [
    note(0, 0, '# Character name\n\nOne line that captures who they are.', 400),
    ...column(0, 160, 'Basics', ['**Age:**', '**Role:**', '**Home:**', '**Voice:**']),
    ...column(320, 160, 'Inner life', ['**Wants:**', '**Needs:**', '**Fears:**', '**Secret:**']),
    ...column(640, 160, 'Arc', ['**Starts as:**', '**Turning point:**', '**Ends as:**']),
    frame(960, 0, 400, 480, 'Portrait and references'),
  ],
  'worldbuilding-hub': () => [
    note(0, 0, '# World name\n\nThe premise of this world in two sentences.', 480),
    ...column(0, 176, 'Places', ['Capital', 'The frontier']),
    ...column(320, 176, 'Peoples and factions', ['Faction one', 'Faction two']),
    ...column(640, 176, 'History', ['Founding event', 'The great change']),
    ...column(960, 176, 'Systems', ['Magic or technology', 'Economy', 'Religion']),
  ],
  'story-structure': () => [
    frame(0, 0, 380, 560, 'Act I: Setup', 1),
    note(32, 56, '**Hook**\n\nWhat grabs the reader?', 316),
    note(32, 200, '**Inciting incident**\n\nWhat changes everything?', 316),
    note(32, 344, '**Break into two**\n\nThe choice that starts the story.', 316),
    frame(412, 0, 380, 560, 'Act II: Confrontation', 2),
    note(444, 56, '**Rising action**\n\nHow do things get harder?', 316),
    note(444, 200, '**Midpoint**\n\nA false victory or defeat.', 316),
    note(444, 344, '**All is lost**\n\nThe lowest point.', 316),
    frame(824, 0, 380, 560, 'Act III: Resolution', 3),
    note(856, 56, '**Climax**\n\nThe final confrontation.', 316),
    note(856, 200, '**Resolution**\n\nThe new normal.', 316),
  ],
  'game-design-doc': () => [
    note(0, 0, '# Game title\n\n**Pitch:** one sentence.\n\n**Pillars:** three words that decide every argument.', 480),
    ...column(0, 208, 'Core loop', ['What the player does each minute', 'What they get for it', 'Why they come back']),
    ...column(320, 208, 'Mechanics', ['Movement', 'Combat or interaction', 'Progression']),
    ...column(640, 208, 'Content', ['Levels', 'Characters', 'Items']),
    ...column(960, 208, 'Art and audio', ['Visual style', 'Sound direction']),
  ],
  'project-plan': () => [
    note(0, 0, '# Project name\n\n**Goal:** what done looks like.', 480),
    ...column(0, 144, 'To do', ['First task']),
    ...column(320, 144, 'In progress', []),
    ...column(640, 144, 'Done', []),
    todo(960, 144, ['Agree on the scope', 'Set the first milestone', 'Name an owner']),
  ],
  'creative-brief': () => [
    note(0, 0, '# Brief title', 480),
    ...column(0, 96, 'Why', ['**Background:**', '**Problem to solve:**']),
    ...column(320, 96, 'Who', ['**Audience:**', '**What they think today:**', '**What they should think:**']),
    ...column(640, 96, 'What', ['**Key message:**', '**Deliverables:**', '**Tone:**']),
    ...column(960, 96, 'When', ['**Deadline:**', '**Approvers:**']),
  ],
  research: () => [
    note(0, 0, '# Research question\n\nWhat exactly are you trying to find out?', 480),
    ...column(0, 176, 'Sources', ['Paste links here']),
    ...column(320, 176, 'Findings', ['One claim per card, with its source']),
    ...column(640, 176, 'Open questions', ['What is still unclear?']),
    note(960, 176, '**Summary**\n\nWrite what you now believe, and why.', 288),
  ],
}

/** Build a built-in template, or undefined when the id is unknown. */
export function buildTemplate(id: string): CanvasDoc | undefined {
  const build = BUILDERS[id as BuiltinTemplateId] as (() => CanvasNode[]) | undefined
  return build === undefined ? undefined : { nodes: build(), edges: [] }
}

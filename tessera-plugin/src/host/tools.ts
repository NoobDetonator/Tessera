/**
 * The agent tools. Written as plain specs so input validation can be tested
 * without a Harness; `index.ts` wraps each one with `defineTool`.
 */
import { existsSync } from 'node:fs'
import { boundsOf, CARD_KINDS, newId, type CanvasDoc, type CanvasEdge, type CanvasNode, type CardKind, type EdgeSide, type TesseraMeta } from '../shared/canvas.ts'
import { deleteNodesChange, composeChanges, type Change } from '../shared/change.ts'
import { cardKind, columnMembers } from '../shared/classify.ts'
import { normalizeHex } from '../shared/cardtext.ts'
import { autoPlace, snapToGrid } from '../shared/geometry.ts'
import { LAYOUT_MODES, layoutChange, type LayoutMode } from '../shared/layout.ts'
import { cardTitle, searchBoard, type SearchHit } from '../shared/search.ts'
import { estimateTextHeight, groupAsColumn, groupAsFrame, removeFromColumns } from '../shared/structure.ts'
import { BUILTIN_TEMPLATES, buildTemplate } from '../shared/templates.ts'
import type { HistoryStore } from './history.ts'
import { normalizeBoardPath, normalizeRelativePath, TesseraError, type ApplyMeta, type BoardStore } from './store.ts'
import { childBoards, listBoards, titleOf } from './workspace.ts'

/** What a tool needs from the Harness's execution context. */
export interface ToolRun {
  callId?: string
  agent?: { id?: unknown } | undefined
  signal?: AbortSignal
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  /** Whether the tool changes boards. Read-only sandbox sessions may not run these. */
  mutates: boolean
  execute: (args: never, run: ToolRun) => Promise<unknown>
}

export interface ToolDeps {
  store: BoardStore
  root: string
  history: HistoryStore
  /** Ask the user in the UI. Resolves true only on an explicit yes. */
  confirm: (request: { path: string; ids: string[]; titles: string[]; signal?: AbortSignal | undefined }) => Promise<boolean>
  /** A key shared by every edit in one agent turn, so they undo as one step. */
  turnKey: (run: ToolRun, path: string) => string
}

const MAX_TEXT = 400
const MAX_CARDS = 200

const compact = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value) }]
const openObject = { type: 'object', additionalProperties: true } as const
const stringList = { type: 'array', items: { type: 'string' } } as const

const fail = (message: string): never => { throw new TesseraError('bad-input', message) }

function text(value: unknown, field: string, { max = 200_000, optional = false } = {}): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') return fail(`${field} must be a string.`)
  if (value.length > max) return fail(`${field} is longer than ${max} characters.`)
  return value
}

function nonEmpty(value: unknown, field: string, max = 200): string {
  const out = text(value, field, { max }) as string
  if (out.trim() === '') return fail(`${field} must not be empty.`)
  return out.trim()
}

function idList(value: unknown, field = 'ids'): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item !== '')) return fail(`${field} must be a list of card ids.`)
  if (value.length > 2000) return fail(`${field} has too many entries.`)
  return [...new Set(value as string[])]
}

function coordinate(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) return fail(`${field} must be a reasonable number.`)
  return Math.round(value)
}

function size(value: unknown, field: string): number | undefined {
  const out = coordinate(value, field)
  if (out !== undefined && out <= 0) return fail(`${field} must be positive.`)
  return out
}

function color(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && /^[1-6]$/.test(value)) return value
  if (typeof value === 'string') {
    const hex = normalizeHex(value)
    if (hex !== undefined) return hex
  }
  return fail('color must be a preset "1" to "6" or a hex color like "#ff8800".')
}

function tagList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string' && tag.trim() !== '')) return fail('tags must be a list of non-empty strings.')
  return [...new Set((value as string[]).map(tag => tag.trim()))]
}

const CREATABLE: readonly CardKind[] = ['note', 'document', 'todo', 'color', 'link', 'image', 'file', 'column', 'frame']

interface CardSpec {
  kind?: unknown; text?: unknown; title?: unknown; url?: unknown; file?: unknown; caption?: unknown
  color?: unknown; tags?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown
}

/**
 * Turn one card spec into a node, with x and y still unset when omitted.
 * @param exists - checks a referenced file; injected so paths stay inside the board folder.
 */
export function nodeFromSpec(spec: CardSpec, exists: (path: string) => boolean): { node: CanvasNode; placed: boolean } {
  if (typeof spec !== 'object' || spec === null) return fail('Each card must be an object.')
  const kind = (spec.kind ?? 'note') as CardKind
  if (!CREATABLE.includes(kind)) return fail(`Cannot create a card of kind "${String(spec.kind)}". Use one of: ${CREATABLE.join(', ')}. Use tessera_create_board for a nested board.`)
  const meta: TesseraMeta = { kind }
  const tags = tagList(spec.tags)
  if (tags !== undefined && tags.length > 0) meta.tags = tags
  const x = coordinate(spec.x, 'x'), y = coordinate(spec.y, 'y')
  const givenWidth = size(spec.width, 'width'), givenHeight = size(spec.height, 'height')
  const paint = color(spec.color)
  const node: CanvasNode = { id: newId(), type: 'text', x: x ?? 0, y: y ?? 0, width: givenWidth ?? 248, height: givenHeight ?? 64, tessera: meta, ...(paint !== undefined ? { color: paint } : {}) }
  switch (kind) {
    case 'note': {
      node.text = text(spec.text ?? '', 'text') as string
      node.height = givenHeight ?? estimateTextHeight(node.text, node.width)
      break
    }
    case 'document': {
      const title = text(spec.title, 'title', { max: 200, optional: true })
      const body = text(spec.text ?? '', 'text') as string
      node.text = title !== undefined && title.trim() !== '' ? `# ${title.trim()}\n\n${body}` : body
      node.width = givenWidth ?? 280
      node.height = givenHeight ?? 120
      break
    }
    case 'todo': {
      const body = text(spec.text ?? '', 'text') as string
      const lines = body.split(/\r?\n/).filter(line => line.trim() !== '')
      node.text = lines.map(line => (/^\s*[-*+] \[[ xX]\]/.test(line) ? line : `- [ ] ${line.trim()}`)).join('\n')
      node.width = givenWidth ?? 280
      node.height = givenHeight ?? 44 + lines.length * 26
      break
    }
    case 'color': {
      const hex = normalizeHex((text(spec.text, 'text', { max: 16 }) as string))
      if (hex === undefined) return fail('A color card needs text with a hex color such as "#ff8800".')
      node.text = hex
      node.width = givenWidth ?? 168
      node.height = givenHeight ?? 168
      if (typeof spec.title === 'string') meta.title = spec.title
      break
    }
    case 'link': {
      const url = text(spec.url, 'url', { max: 2048 }) as string
      let protocol = ''
      try {
        protocol = new URL(url).protocol
      } catch {
        return fail(`Not a valid url: ${url}`)
      }
      if (protocol !== 'http:' && protocol !== 'https:') return fail('A link must be http or https.')
      node.type = 'link'
      node.url = url
      node.width = givenWidth ?? 320
      node.height = givenHeight ?? 220
      break
    }
    case 'image':
    case 'file': {
      const file = normalizeRelativePath(spec.file)
      if (!exists(file)) return fail(`No file at ${file} in the board folder.`)
      node.type = 'file'
      node.file = file
      node.width = givenWidth ?? (kind === 'image' ? 320 : 280)
      node.height = givenHeight ?? (kind === 'image' ? 240 : 88)
      const caption = text(spec.caption, 'caption', { max: 500, optional: true })
      if (caption !== undefined) meta.caption = caption
      break
    }
    case 'column':
    case 'frame': {
      node.type = 'group'
      const label = text(spec.title, 'title', { max: 200, optional: true })
      if (label !== undefined) node.label = label
      node.width = givenWidth ?? (kind === 'column' ? 280 : 480)
      node.height = givenHeight ?? (kind === 'column' ? 56 : 320)
      if (kind === 'column') meta.items = []
      break
    }
    default:
      return fail(`Unknown kind ${kind}.`)
  }
  return { node, placed: x !== undefined && y !== undefined }
}

/** One card as the model reads it. Long text is cut and flagged. */
export function describeCard(node: CanvasNode, doc: CanvasDoc): Record<string, unknown> {
  const kind = cardKind(node, doc)
  const out: Record<string, unknown> = { id: node.id, kind, x: node.x, y: node.y, w: node.width, h: node.height }
  if (typeof node.text === 'string') {
    if (node.text.length > MAX_TEXT) {
      out.text = node.text.slice(0, MAX_TEXT)
      out.truncated = true
      out.fullLength = node.text.length
    } else out.text = node.text
  }
  if (typeof node.label === 'string' && node.label !== '') out.title = node.label
  if (typeof node.url === 'string') out.url = node.url
  if (typeof node.file === 'string') out.file = node.file
  if (typeof node.tessera?.preview?.title === 'string') out.previewTitle = node.tessera.preview.title
  if (typeof node.tessera?.caption === 'string') out.caption = node.tessera.caption
  if (node.color !== undefined) out.color = node.color
  if (Array.isArray(node.tessera?.tags) && node.tessera.tags.length > 0) out.tags = node.tessera.tags
  if (node.tessera?.locked === true) out.locked = true
  if (kind === 'column') out.items = columnMembers(doc, node).map(member => member.id)
  if (kind !== 'note' && kind !== 'document' && kind !== 'todo' && kind !== 'color') out.name = cardTitle(node)
  return out
}

/** Read a board for the model, following nested boards up to `depth`. */
export async function readForAgent(store: BoardStore, path: string, depth: number, seen: ReadonlySet<string>): Promise<Record<string, unknown>> {
  const { doc, rev } = await store.read(path)
  const out: Record<string, unknown> = {
    path, title: titleOf(path), rev,
    cards: doc.nodes.map(node => describeCard(node, doc)),
    edges: doc.edges.map(edge => ({
      id: edge.id, from: edge.fromNode, to: edge.toNode,
      ...(typeof edge.label === 'string' && edge.label !== '' ? { label: edge.label } : {}),
    })),
  }
  const children = childBoards(doc)
  if (children.length === 0) return out
  if (depth <= 0) {
    out.nestedBoards = children
    return out
  }
  const nested: Array<Record<string, unknown>> = []
  for (const child of children) {
    if (seen.has(child)) { nested.push({ path: child, cycle: true }); continue }
    try {
      nested.push(await readForAgent(store, child, depth - 1, new Set([...seen, child])))
    } catch (error) {
      nested.push({ path: child, error: (error as Error).message })
    }
  }
  out.nested = nested
  return out
}

const EDGE_ROUTING = ['straight', 'curved', 'orthogonal'] as const
const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left']

/** The part of `ctx.sandboxPolicy` the tools need. */
export interface SandboxPolicyReader {
  resolve(request: { session: never }): { mode: string }
}

/**
 * Wrap a tool so a read-only session cannot change boards. Boards live outside
 * `ctx.fs`, so its sandbox fence never sees these writes and this check stands in for it.
 * @param policy - read at call time, because the service can come and go.
 */
export function guardReadOnly(spec: ToolSpec, policy: () => SandboxPolicyReader | undefined): ToolSpec['execute'] {
  if (!spec.mutates) return spec.execute
  return async (args, run) => {
    const session = (run as ToolRun & { agent?: { session?: unknown } }).agent?.session
    if (session !== undefined && policy()?.resolve({ session: session as never }).mode === 'read-only') {
      throw new TesseraError('read-only', 'This session is in read-only mode, so boards cannot be changed.')
    }
    return spec.execute(args, run)
  }
}

/** Build every tool spec. */
export function toolSpecs(deps: ToolDeps): ToolSpec[] {
  const { store, root, history } = deps
  const meta = (run: ToolRun, path: string, label: string): ApplyMeta => ({ origin: 'agent', label, coalesce: deps.turnKey(run, path) })
  const fileExists = (path: string): boolean => existsSync(`${root}/${path}`)

  return [
    {
      name: 'tessera_list_boards',
      description: 'List every Tessera board with its path, title, card count and the boards nested inside it.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { boards: { type: 'array', items: openObject, required: true } } }, render: compact },
      mutates: false,
      execute: async () => {
        const { boards, favorites } = await listBoards(store, root)
        return { boards: boards.map(board => ({ ...board, ...(favorites.includes(board.path) ? { favorite: true } : {}) })) }
      },
    },
    {
      name: 'tessera_read_board',
      description: 'Read a board: its cards (id, kind, position, size, text, tags) and edges. Text over 400 characters is cut and flagged with truncated: true. depth > 0 also reads nested boards.',
      parameters: {
        path: { type: 'string', required: true, description: 'Board path from tessera_list_boards, such as "Ideas.canvas".' },
        depth: { type: 'integer', description: 'Levels of nested boards to include. Default 0.' },
      },
      output: { schema: openObject, render: compact },
      mutates: false,
      execute: async (args: { path: unknown; depth?: unknown }) => {
        const path = normalizeBoardPath(args.path)
        const depth = args.depth === undefined ? 0 : Number(args.depth)
        if (!Number.isInteger(depth) || depth < 0 || depth > 5) return fail('depth must be between 0 and 5.')
        return readForAgent(store, path, depth, new Set([path]))
      },
    },
    {
      name: 'tessera_search',
      description: 'Search card text across all boards, or one board. Every word must match. Filter by tags and card kinds. An empty query with a filter lists everything that matches the filter.',
      parameters: {
        query: { type: 'string', required: true },
        tags: { ...stringList, description: 'Cards must have all of these tags.' },
        types: { ...stringList, description: `Card kinds to include: ${CARD_KINDS.join(', ')}.` },
        board: { type: 'string', description: 'Limit the search to this board path.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { matches: { type: 'array', items: openObject, required: true }, truncated: { type: 'boolean', required: true } } }, render: compact },
      mutates: false,
      execute: async (args: { query: unknown; tags?: unknown; types?: unknown; board?: unknown }) => {
        const query = text(args.query, 'query', { max: 500 }) as string
        const tags = tagList(args.tags)
        const types = args.types === undefined ? undefined : idList(args.types, 'types') as CardKind[]
        for (const kind of types ?? []) if (!CARD_KINDS.includes(kind)) fail(`Unknown card kind: ${kind}`)
        const paths = args.board === undefined ? await store.listPaths() : [normalizeBoardPath(args.board)]
        const matches: SearchHit[] = []
        for (const path of paths) {
          const doc = await store.peek(path)
          if (doc !== undefined) matches.push(...searchBoard(path, doc, query, { ...(tags !== undefined ? { tags } : {}), ...(types !== undefined ? { types } : {}) }))
        }
        return { matches: matches.slice(0, 50), truncated: matches.length > 50 }
      },
    },
    {
      name: 'tessera_create_cards',
      description: `Add cards to a board. Each card has a kind (${CREATABLE.join(', ')}; default note) and, as fits the kind: text, title, url, file, caption, color, tags, x, y, width, height. Cards without both x and y are placed automatically without overlapping anything. A todo card takes one item per line of text. A color card takes a hex color as text. Returns the new ids. Links and notes to keep for later go on the Inbox board, Inbox.canvas.`,
      parameters: {
        path: { type: 'string', required: true },
        cards: { type: 'array', required: true, items: openObject, description: 'The cards to add, at most 200.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { created: { type: 'array', items: openObject, required: true }, rev: { type: 'integer', required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; cards: unknown }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        if (!Array.isArray(args.cards) || args.cards.length === 0) return fail('cards must be a non-empty list.')
        if (args.cards.length > MAX_CARDS) return fail(`At most ${MAX_CARDS} cards per call.`)
        const built = (args.cards as CardSpec[]).map(spec => nodeFromSpec(spec, fileExists))
        const { doc } = await store.read(path)
        const pending = built.filter(entry => !entry.placed)
        const spots = autoPlace([...doc.nodes, ...built.filter(entry => entry.placed).map(entry => entry.node)], pending.map(entry => entry.node))
        pending.forEach((entry, index) => { Object.assign(entry.node, spots[index]) })
        const nodes = Object.fromEntries(built.map(({ node }) => [node.id, node]))
        const rev = await store.apply(path, { nodes }, meta(run, path, 'Agent: add cards'))
        return { created: built.map(({ node }) => ({ id: node.id, kind: node.tessera?.kind, x: node.x, y: node.y, w: node.width, h: node.height })), rev }
      },
    },
    {
      name: 'tessera_update_cards',
      description: 'Change existing cards. Each update names an id and any of: text, title, url, caption, color (null clears it), tags, x, y, width, height, colorStyle ("full" or "strip"), locked. Locked cards are skipped unless the update sets locked: false.',
      parameters: {
        path: { type: 'string', required: true },
        updates: { type: 'array', required: true, items: openObject },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { updated: { type: 'array', items: { type: 'string' }, required: true }, skipped: { type: 'array', items: openObject, required: true }, rev: { type: 'integer', required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; updates: unknown }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        if (!Array.isArray(args.updates) || args.updates.length === 0) return fail('updates must be a non-empty list.')
        const { doc } = await store.read(path)
        const byId = new Map(doc.nodes.map(node => [node.id, node]))
        const nodes: Record<string, CanvasNode> = {}
        const skipped: Array<{ id: string; reason: string }> = []
        for (const update of args.updates as Array<Record<string, unknown>>) {
          const id = nonEmpty(update?.id, 'id')
          const node = byId.get(id)
          if (node === undefined) { skipped.push({ id, reason: 'not found' }); continue }
          if (node.tessera?.locked === true && update.locked !== false) { skipped.push({ id, reason: 'locked' }); continue }
          const next: CanvasNode = { ...node, tessera: { ...node.tessera } }
          const nextMeta = next.tessera as TesseraMeta
          if (update.text !== undefined) {
            if (node.type !== 'text') { skipped.push({ id, reason: 'this card has no text' }); continue }
            next.text = text(update.text, 'text') as string
          }
          if (update.title !== undefined) {
            const title = text(update.title, 'title', { max: 200 }) as string
            if (node.type === 'group') next.label = title
            else nextMeta.title = title
          }
          if (update.url !== undefined) {
            if (node.type !== 'link') { skipped.push({ id, reason: 'this card has no url' }); continue }
            next.url = text(update.url, 'url', { max: 2048 }) as string
            delete nextMeta.preview
          }
          if (update.caption !== undefined) nextMeta.caption = text(update.caption, 'caption', { max: 500 }) as string
          if (update.color === null) delete next.color
          else if (update.color !== undefined) next.color = color(update.color) as string
          const tags = tagList(update.tags)
          if (tags !== undefined) nextMeta.tags = tags
          if (update.colorStyle !== undefined) {
            if (update.colorStyle !== 'full' && update.colorStyle !== 'strip') return fail('colorStyle must be "full" or "strip".')
            nextMeta.colorStyle = update.colorStyle
          }
          if (update.locked !== undefined) {
            if (typeof update.locked !== 'boolean') return fail('locked must be true or false.')
            nextMeta.locked = update.locked
          }
          next.x = coordinate(update.x, 'x') ?? next.x
          next.y = coordinate(update.y, 'y') ?? next.y
          next.width = size(update.width, 'width') ?? next.width
          next.height = size(update.height, 'height') ?? next.height
          nodes[id] = next
        }
        const rev = await store.apply(path, { nodes }, meta(run, path, 'Agent: edit cards'))
        return { updated: Object.keys(nodes), skipped, rev }
      },
    },
    {
      name: 'tessera_delete_cards',
      description: 'Delete cards and their edges. The user must confirm in the UI, so this waits for an answer and can come back with declined: true. After a decline, do not try again on your own; if the user asks for the delete again, call this again, and they will be asked again in the UI.',
      parameters: {
        path: { type: 'string', required: true },
        ids: { ...stringList, required: true },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'array', items: { type: 'string' }, required: true }, declined: { type: 'boolean', required: true }, skipped: { type: 'array', items: openObject, required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; ids: unknown }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        const ids = idList(args.ids)
        if (ids.length === 0) return fail('ids must not be empty.')
        const { doc } = await store.read(path)
        const byId = new Map(doc.nodes.map(node => [node.id, node]))
        const skipped: Array<{ id: string; reason: string }> = []
        const removable = ids.filter((id) => {
          const node = byId.get(id)
          if (node === undefined) { skipped.push({ id, reason: 'not found' }); return false }
          if (node.tessera?.locked === true) { skipped.push({ id, reason: 'locked' }); return false }
          return true
        })
        if (removable.length === 0) return { deleted: [], declined: false, skipped }
        const titles = removable.slice(0, 20).map(id => cardTitle(byId.get(id) as CanvasNode) || id)
        const approved = await deps.confirm({ path, ids: removable, titles, signal: run.signal })
        if (!approved) return { deleted: [], declined: true, skipped }
        const current = (await store.read(path)).doc
        const change = composeChanges(removeFromColumns(current, removable), deleteNodesChange(current, removable))
        await store.apply(path, change, meta(run, path, 'Agent: delete cards'))
        return { deleted: removable, declined: false, skipped }
      },
    },
    {
      name: 'tessera_connect',
      description: 'Draw an edge between two cards on a board. Optional label and style: routing (straight, curved, orthogonal), dashed, color, arrow (to, from, both, none), fromSide, toSide.',
      parameters: {
        path: { type: 'string', required: true },
        fromId: { type: 'string', required: true },
        toId: { type: 'string', required: true },
        label: { type: 'string' },
        style: openObject,
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { edgeId: { type: 'string', required: true }, rev: { type: 'integer', required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; fromId: unknown; toId: unknown; label?: unknown; style?: Record<string, unknown> }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        const fromId = nonEmpty(args.fromId, 'fromId'), toId = nonEmpty(args.toId, 'toId')
        if (fromId === toId) return fail('An edge needs two different cards.')
        const { doc } = await store.read(path)
        for (const id of [fromId, toId]) if (!doc.nodes.some(node => node.id === id)) return fail(`No card ${id} on this board.`)
        const style = args.style ?? {}
        const routing = style.routing
        if (routing !== undefined && !(EDGE_ROUTING as readonly unknown[]).includes(routing)) return fail(`routing must be one of ${EDGE_ROUTING.join(', ')}.`)
        const arrow = style.arrow ?? 'to'
        if (!['to', 'from', 'both', 'none'].includes(arrow as string)) return fail('arrow must be to, from, both or none.')
        for (const side of [style.fromSide, style.toSide]) if (side !== undefined && !EDGE_SIDES.includes(side as EdgeSide)) return fail('A side must be top, right, bottom or left.')
        const paint = color(style.color)
        const label = text(args.label, 'label', { max: 200, optional: true })
        const edgeId = newId()
        const edge: CanvasEdge = {
          id: edgeId, fromNode: fromId, toNode: toId,
          fromEnd: arrow === 'from' || arrow === 'both' ? 'arrow' : 'none',
          toEnd: arrow === 'to' || arrow === 'both' ? 'arrow' : 'none',
          ...(style.fromSide !== undefined ? { fromSide: style.fromSide as EdgeSide } : {}),
          ...(style.toSide !== undefined ? { toSide: style.toSide as EdgeSide } : {}),
          ...(paint !== undefined ? { color: paint } : {}),
          ...(label !== undefined && label !== '' ? { label } : {}),
          ...(routing !== undefined || style.dashed === true ? { tessera: { ...(routing !== undefined ? { routing: routing as 'straight' } : {}), ...(style.dashed === true ? { dashed: true } : {}) } } : {}),
        }
        const rev = await store.apply(path, { edges: { [edgeId]: edge } }, meta(run, path, 'Agent: connect cards'))
        return { edgeId, rev }
      },
    },
    {
      name: 'tessera_group',
      description: 'Group cards. as: "column" stacks them in an ordered list, "frame" draws a titled region around them where they are, "board" moves them into a new nested board and leaves a Board card in their place. Move cards together with tessera_update_cards first if a frame should not span the whole board.',
      parameters: {
        path: { type: 'string', required: true },
        ids: { ...stringList, required: true },
        as: { type: 'string', enum: ['column', 'frame', 'board'], required: true },
        title: { type: 'string', required: true },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, as: { type: 'string', required: true }, file: { type: 'string' } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; ids: unknown; as: unknown; title: unknown }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        const ids = idList(args.ids)
        if (ids.length === 0) return fail('ids must not be empty.')
        const title = nonEmpty(args.title, 'title')
        const { doc } = await store.read(path)
        const unknown = ids.filter(id => !doc.nodes.some(node => node.id === id))
        if (unknown.length > 0) return fail(`No such cards on this board: ${unknown.join(', ')}`)
        if (args.as === 'column') {
          const made = groupAsColumn(applyLeaving(doc, ids), ids, title)
          if (made === undefined) return fail('Nothing to group.')
          await store.apply(path, composeChanges(removeFromColumns(doc, ids), made.change), meta(run, path, 'Agent: make column'))
          return { id: made.id, as: 'column' }
        }
        if (args.as === 'frame') {
          const made = groupAsFrame(doc, ids, title)
          if (made === undefined) return fail('Nothing to group.')
          await store.apply(path, made.change, meta(run, path, 'Agent: make frame'))
          return { id: made.id, as: 'frame' }
        }
        if (args.as === 'board') {
          const box = boundsOf(doc.nodes.filter(node => ids.includes(node.id))) ?? { x: 0, y: 0, width: 0, height: 0 }
          const file = await store.freePath(title, path)
          await store.create(file, { nodes: [], edges: [] })
          const applyMeta = meta(run, path, 'Agent: move to nested board')
          await store.transfer(path, file, ids, applyMeta)
          const id = newId()
          const card: CanvasNode = { id, type: 'file', file, x: snapToGrid(box.x), y: snapToGrid(box.y), width: 280, height: 208, tessera: { kind: 'board' } }
          await store.apply(path, { nodes: { [id]: card } }, applyMeta)
          return { id, as: 'board', file }
        }
        return fail('as must be column, frame or board.')
      },
    },
    {
      name: 'tessera_layout',
      description: 'Arrange cards. mode: "grid" in reading order, "tree" in layers following edges, "cluster" grouped by first tag. Empty ids means every top-level card. Cards never overlap afterwards.',
      parameters: {
        path: { type: 'string', required: true },
        ids: { ...stringList, required: true },
        mode: { type: 'string', enum: [...LAYOUT_MODES], required: true },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { moved: { type: 'integer', required: true }, rev: { type: 'integer', required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; ids: unknown; mode: unknown }, run: ToolRun) => {
        const path = normalizeBoardPath(args.path)
        const ids = idList(args.ids)
        if (!LAYOUT_MODES.includes(args.mode as LayoutMode)) return fail(`mode must be one of ${LAYOUT_MODES.join(', ')}.`)
        const { doc } = await store.read(path)
        const change = layoutChange(doc, ids, args.mode as LayoutMode)
        const rev = await store.apply(path, change, meta(run, path, 'Agent: lay out cards'))
        return { moved: Object.keys(change.nodes ?? {}).length, rev }
      },
    },
    {
      name: 'tessera_create_board',
      description: `Create a board. With parentPath, also adds a Board card to that parent so the new board nests inside it; use null for a top-level board. Optional template: ${BUILTIN_TEMPLATES.map(template => template.id).join(', ')}.`,
      parameters: {
        parentPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        title: { type: 'string', required: true },
        template: { type: 'string' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, cardId: { type: 'string' } } }, render: compact },
      mutates: true,
      execute: async (args: { parentPath: unknown; title: unknown; template?: unknown }, run: ToolRun) => {
        const parent = args.parentPath === null || args.parentPath === undefined ? undefined : normalizeBoardPath(args.parentPath)
        const title = nonEmpty(args.title, 'title')
        let doc: CanvasDoc = { nodes: [], edges: [] }
        if (args.template !== undefined) {
          const built = buildTemplate(nonEmpty(args.template, 'template'))
          if (built === undefined) return fail(`Unknown template. Choose one of: ${BUILTIN_TEMPLATES.map(template => template.id).join(', ')}.`)
          doc = built
        }
        if (parent !== undefined && !await store.exists(parent)) return fail(`No board at ${parent}.`)
        const path = await store.freePath(title, parent)
        await store.create(path, doc)
        if (parent === undefined) return { path }
        const parentDoc = (await store.read(parent)).doc
        const [spot] = autoPlace(parentDoc.nodes, [{ width: 280, height: 208 }])
        const cardId = newId()
        const card: CanvasNode = { id: cardId, type: 'file', file: path, x: spot?.x ?? 0, y: spot?.y ?? 0, width: 280, height: 208, tessera: { kind: 'board' } }
        await store.apply(parent, { nodes: { [cardId]: card } }, meta(run, parent, 'Agent: add nested board'))
        return { path, cardId }
      },
    },
    {
      name: 'tessera_snapshot',
      description: 'Save a named version of a board to its history. Do this before a large reorganization.',
      parameters: {
        path: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, name: { type: 'string', required: true }, at: { type: 'number', required: true } } }, render: compact },
      mutates: true,
      execute: async (args: { path: unknown; name: unknown }) => {
        const path = normalizeBoardPath(args.path)
        const snapshot = await history.snapshot(path, nonEmpty(args.name, 'name'))
        return { id: snapshot.id, name: snapshot.name, at: snapshot.at }
      },
    },
  ]
}

/** The document as it will be once these cards have left their columns. */
function applyLeaving(doc: CanvasDoc, ids: readonly string[]): CanvasDoc {
  const change: Change = removeFromColumns(doc, ids)
  const nodes = doc.nodes.map(node => change.nodes?.[node.id] ?? node)
  return { ...doc, nodes }
}


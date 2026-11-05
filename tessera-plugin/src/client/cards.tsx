/**
 * The card-type registry. Each kind declares its sizing rules and its view;
 * the canvas handles position, selection and resizing around it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, type CanvasDoc, type CanvasNode, type CardKind } from '../shared/canvas.ts'
import { cardTitle } from '../shared/search.ts'
import type { TesseraStore } from './store.ts'

export { cardTitle }

export interface CardViewProps {
  node: CanvasNode
  store: TesseraStore
  editing: boolean
  selected: boolean
  t: (key: string) => string
  /** Open a nested board or full-width editor. */
  shell: CardShell
}

/** What a card may ask the surrounding app to do. */
export interface CardShell {
  openDocument(id: string): void
  openLightbox(id: string): void
  enterBoard(path: string): void
  jumpToCard(id: string): void
}

export interface CardType {
  kind: CardKind
  /** i18n key for the type's name. */
  label: string
  minWidth: number
  minHeight: number
  /** Height follows content; only the width is user-resizable. */
  autoHeight: boolean
  /** Resizing keeps the current aspect ratio. */
  aspectLock?: boolean
  /** Double-click starts in-place text editing. */
  editable?: boolean
  /** Only the width is user-resizable, even though the height is not measured from content. */
  widthOnly?: boolean
  view: ComponentType<CardViewProps>
}

/** Labels the shared Markdown renderer needs. Not exposed in any translated UI on the canvas. */
const MARKDOWN_LABELS = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

const LINK_HOST = 'https://tessera.invalid/card/'
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g
const CHECKBOX_ITEM = /^(\s*[-*+] \[)([ xX])(\])/gm

/** Turn `[[Name]]` into a link the note's click handler recognizes. Skips fenced code. */
export function renderWikiLinks(text: string): string {
  return text.split(/(```[\s\S]*?```)/g).map((part, index) => index % 2 === 1 ? part
    : part.replace(WIKI_LINK, (_all, name: string) => `[${name}](${LINK_HOST}${encodeURIComponent(name)})`)).join('')
}

/** Flip the nth markdown checkbox in a text. */
export function toggleCheckbox(text: string, index: number): string {
  let seen = -1
  return text.replace(CHECKBOX_ITEM, (all, open: string, mark: string, close: string) => {
    seen++
    return seen === index ? `${open}${mark === ' ' ? 'x' : ' '}${close}` : all
  })
}

/** Find the card a wiki-link name refers to: exact id, then a first line or title match. */
export function resolveCardName(doc: CanvasDoc, name: string): CanvasNode | undefined {
  const wanted = name.trim().toLowerCase()
  return doc.nodes.find(node => node.id === name)
    ?? doc.nodes.find(node => cardTitle(node).toLowerCase() === wanted)
}

function TextEditor({ node, store, field = 'text' }: { node: CanvasNode; store: TesseraStore; field?: 'text' }): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  const key = useRef(`text:${node.id}:${newId()}`)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(node.text ?? '')

  const fit = useCallback(() => {
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [])

  const flush = useCallback(() => {
    if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined }
    const current = store.node(node.id)
    if (current !== undefined && current[field] !== latest.current) {
      // Editing marks the card as Tessera's, so its height now follows its text.
      store.commit({ nodes: { [node.id]: { ...current, [field]: latest.current, tessera: { ...current.tessera } } } }, { coalesce: key.current, label: 'Edit text' })
    }
  }, [store, node.id, field])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
    fit()
    return () => {
      flush()
      // Leaving a card with no text means the user abandoned it.
      const current = store.node(node.id)
      if (current !== undefined && (current.text ?? '').trim() === '') {
        store.commit({ nodes: { [node.id]: null } }, { coalesce: key.current })
      }
    }
  }, [fit, flush, store, node.id])

  return (
    <textarea
      ref={ref}
      className="t-editor"
      defaultValue={node.text ?? ''}
      spellCheck
      onChange={(event) => {
        latest.current = event.target.value
        fit()
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(flush, 300)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); store.setEditing(undefined) }
      }}
      onPointerDown={event => { event.stopPropagation() }}
      onDoubleClick={event => { event.stopPropagation() }}
    />
  )
}

const NoteView = memo(function NoteView({ node, store, editing, shell }: CardViewProps) {
  const rendered = useMemo(() => renderWikiLinks(node.text ?? ''), [node.text])
  if (editing) return <div className="t-note"><TextEditor node={node} store={store} /></div>
  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    if (anchor?.href.startsWith(LINK_HOST)) {
      event.preventDefault()
      event.stopPropagation()
      const { doc } = store.state
      const found = doc === undefined ? undefined : resolveCardName(doc, decodeURIComponent(anchor.href.slice(LINK_HOST.length)))
      if (found !== undefined) shell.jumpToCard(found.id)
      else store.notify(`[[${decodeURIComponent(anchor.href.slice(LINK_HOST.length))}]]?`)
      return
    }
    if (node.tessera?.locked === true) return
    // Rendered checkboxes are disabled inputs, so find the one under the pointer by position.
    const boxes = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const index = boxes.findIndex((box) => {
      const rect = box.getBoundingClientRect()
      return event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2 && event.clientY >= rect.top - 2 && event.clientY <= rect.bottom + 2
    })
    if (index >= 0) {
      event.stopPropagation()
      store.patchNode(node.id, { text: toggleCheckbox(node.text ?? '', index) }, { label: 'Toggle checkbox' })
    }
  }
  return (
    <div className="t-note" onClick={onClick}>
      {(node.text ?? '') === '' ? <span className="t-placeholder">&nbsp;</span> : <MarkdownText text={rendered} labels={MARKDOWN_LABELS} omitHtml />}
    </div>
  )
})

/** Cards this build does not know how to show yet still display and save untouched. */
export const registry = new Map<CardKind, CardType>()

export function registerCard(type: CardType): void {
  registry.set(type.kind, type)
}

registerCard({ kind: 'note', label: 'card.note', minWidth: 120, minHeight: 40, autoHeight: true, editable: true, view: NoteView })

/** Sizing rules for a kind, falling back to Note. */
export const cardTypeOf = (kind: CardKind): CardType => registry.get(kind) ?? registry.get('note') as CardType


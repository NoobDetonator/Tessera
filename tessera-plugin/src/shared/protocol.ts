/** Wire types of the same-origin HTTP bridge between the Client and the Host. */
import type { CanvasDoc } from './canvas.ts'
import type { Change } from './change.ts'

export const API_PREFIX = '/tessera/api'

/** The board the agent clips links and media into. */
export const INBOX_PATH = 'Inbox.canvas'

export interface BoardInfo {
  path: string
  title: string
  cards: number
  /** Boards this board has a Board card pointing at. */
  children: string[]
}

export interface BoardList {
  boards: BoardInfo[]
  favorites: string[]
  root: string
}

export interface BoardState {
  doc: CanvasDoc
  rev: number
  canUndo: boolean
  canRedo: boolean
}

export interface ApplyRequest {
  path: string
  change: Change
  clientId: string
  label?: string
  coalesce?: string
  undoable?: boolean
}

export type ServerEvent =
  | { type: 'hello'; serverId: string }
  | { type: 'change'; path: string; rev: number; change: Change; origin: string; clientId?: string; label?: string; canUndo: boolean; canRedo: boolean }
  | { type: 'saved'; path: string; rev: number }
  | { type: 'save-error'; path: string; message: string }
  | { type: 'external-invalid'; path: string; message: string }
  | { type: 'boards-changed' }
  | { type: 'board-removed'; path: string }
  | { type: 'confirm'; id: string; path: string; ids: string[]; titles: string[] }
  | { type: 'confirm-resolved'; id: string }

export interface AssetResult {
  path: string
  size: number
  mime: string
  name: string
}

export interface LinkPreviewResult {
  title?: string
  description?: string
  image?: string
  siteName?: string
}

/** Boot values the Host injects into the authenticated index page. */
export interface BootGlobals {
  token: string
}

export const BOOT_GLOBAL = '__TESSERA__'

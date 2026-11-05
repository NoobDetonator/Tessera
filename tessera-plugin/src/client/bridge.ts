/**
 * All Client-to-Host transport lives here, so a future supported RPC replaces
 * this one file. Same-origin fetch for requests, SSE for pushes.
 */
import type { Change } from '../shared/change.ts'
import { BOOT_GLOBAL, type AssetResult, type BoardList, type BoardState, type BootGlobals, type LinkPreviewResult, type ServerEvent } from '../shared/protocol.ts'

export class BridgeError extends Error {
  override readonly name = 'BridgeError'
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function boot(): BootGlobals | undefined {
  return (globalThis as unknown as Record<string, BootGlobals | undefined>)[BOOT_GLOBAL]
}

/** False when the Host refused to mount the bridge, for example on a non-loopback bind. */
export const bridgeAvailable = (): boolean => boot()?.token !== undefined

const base = (): string => new URL('tessera/api', document.baseURI).pathname
const tokenHeader = (): Record<string, string> => ({ 'x-tessera-token': boot()?.token ?? '' })

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json() as T
  let code = 'http', message = `HTTP ${response.status}`
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } }
    code = body.error?.code ?? code
    message = body.error?.message ?? message
  } catch { /* a non-JSON failure keeps the HTTP status as its message */ }
  throw new BridgeError(response.status, code, message)
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString()
  return parseResponse<T>(await fetch(`${base()}${path}${query === '' ? '' : `?${query}`}`, { headers: tokenHeader() }))
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return parseResponse<T>(await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

/** URL of a file in the board folder, usable directly in `src` attributes. */
export function fileUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base()}/file/${encoded}?token=${encodeURIComponent(boot()?.token ?? '')}`
}

/** Open the event stream. EventSource reconnects by itself; `onOpen` lets the caller resync. */
export function connectEvents(onEvent: (event: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
  const source = new EventSource(`${base()}/events?token=${encodeURIComponent(boot()?.token ?? '')}`)
  source.onmessage = (message) => { onEvent(JSON.parse(message.data as string) as ServerEvent) }
  source.onopen = () => { onStatus(true) }
  source.onerror = () => { onStatus(false) }
  return () => { source.close() }
}

export const api = {
  listBoards: () => get<BoardList>('/boards'),
  readBoard: (path: string) => get<BoardState>('/board', { path }),
  apply: (body: { path: string; change: Change; clientId: string; label?: string; coalesce?: string; undoable?: boolean }) => post<{ rev: number }>('/board/apply', body),
  undo: (path: string) => post<{ rev: number | null; label?: string }>('/board/undo', { path }),
  redo: (path: string) => post<{ rev: number | null; label?: string }>('/board/redo', { path }),
  seal: (path: string) => post<{ ok: boolean }>('/board/seal', { path }),
  createBoard: (title: string, options: { parent?: string; template?: string } = {}) => post<{ path: string }>('/board/create', { title, ...options }),
  renameBoard: (path: string, title: string) => post<{ path: string }>('/board/rename', { path, title }),
  deleteBoard: (path: string) => post<{ ok: boolean }>('/board/delete', { path }),
  setFavorites: (favorites: string[]) => post<{ ok: boolean }>('/prefs', { favorites }),
  /** Upload a file into the asset folder. */
  upload: async (file: Blob, name: string): Promise<AssetResult> => parseResponse<AssetResult>(await fetch(`${base()}/asset?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })),
  linkPreview: (url: string) => get<LinkPreviewResult>('/link-preview', { url }),
  openExternal: (path: string) => post<{ ok: boolean }>('/open', { path }),
  answerConfirm: (id: string, approved: boolean) => post<{ ok: boolean }>('/confirm', { id, approved }),
  request: post,
  fetch: get,
}


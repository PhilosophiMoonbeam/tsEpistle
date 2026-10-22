import { decodeCollaborationUpdate } from './collaboration.ts'

export const LIVE_NOTE_TEXT_KEY = 'content' as const
export const LIVE_NOTE_WEBSOCKET_PATH = '/_api/live-notes/_socket' as const
export const LIVE_NOTE_MAX_TEXT_BYTES = 1024 * 1024
export const LIVE_NOTE_MAX_UPDATE_BYTES = 64 * 1024
export const LIVE_NOTE_MAX_STATE_BYTES = 5 * 1024 * 1024
export type LiveNoteAccess = 'private' | 'read' | 'edit'
export interface LiveNoteSummary {
  id: string
  key: string
  ownerId: number | null
  title: string
  access: LiveNoteAccess
  revision: number
  updatedAt: string
  canEdit: boolean
  canManage: boolean
}
export interface LiveNoteView extends LiveNoteSummary {
  state: string
}
export interface LiveNoteSession {
  token: string
  key: string
  websocketPath: typeof LIVE_NOTE_WEBSOCKET_PATH
  expiresAt: string
}
export interface LiveNoteHistoryItem {
  revision: number
  createdAt: string
  actorId: number | null
  title: string
}
export interface LiveNoteList {
  items: LiveNoteSummary[]
  hasMore: boolean
  nextCursor: string | null
}
export interface LiveNoteHistoryList {
  items: LiveNoteHistoryItem[]
  hasMore: boolean
  nextCursor: string | null
}
export type LiveNoteClientMessage = { type: 'auth'; token: string } | { type: 'update'; requestId: string; update: string }
export type LiveNoteServerMessage =
  | { type: 'sync'; note: LiveNoteView }
  | { type: 'ack'; requestId: string; note: LiveNoteView }
  | { type: 'error'; code: string; error: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const liveNoteExactKeys = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> =>
  record(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const boundedUpdate = (value: unknown, maxBytes: number): void => {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw new TypeError('Live note update size is invalid')
  decodeCollaborationUpdate(value, maxBytes)
}
export const isLiveNoteRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value))
const reservedKeys: Record<string, true> = {
  api: true,
  admin: true,
  auth: true,
  assets: true,
  new: true,
  create: true,
  session: true,
  sessions: true,
  revisions: true,
  updates: true,
  profile: true,
  login: true,
  logout: true
}
export const isLiveNoteKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/u.test(value) && !Object.hasOwn(reservedKeys, value)
export const isLiveNoteAccess = (value: unknown): value is LiveNoteAccess => value === 'private' || value === 'read' || value === 'edit'
export const isLiveNoteRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
const summaryKeys = ['id', 'key', 'ownerId', 'title', 'access', 'revision', 'updatedAt', 'canEdit', 'canManage'] as const
const summary = (value: Record<string, unknown>): boolean =>
  typeof value.id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.id) &&
  isLiveNoteKey(value.key) &&
  (value.ownerId === null || id(value.ownerId)) &&
  typeof value.title === 'string' &&
  value.title.length <= 200 &&
  isLiveNoteAccess(value.access) &&
  isLiveNoteRevision(value.revision) &&
  date(value.updatedAt) &&
  typeof value.canEdit === 'boolean' &&
  typeof value.canManage === 'boolean'
export const parseLiveNoteSummary = (value: unknown): LiveNoteSummary => {
  if (!liveNoteExactKeys(value, summaryKeys) || !summary(value)) throw new TypeError('Live note summary is invalid')
  return value as unknown as LiveNoteSummary
}
export const parseLiveNoteView = (value: unknown): LiveNoteView => {
  if (!liveNoteExactKeys(value, [...summaryKeys, 'state']) || !summary(value)) throw new TypeError('Live note is invalid')
  boundedUpdate(value.state, LIVE_NOTE_MAX_STATE_BYTES)
  return value as unknown as LiveNoteView
}
export const parseLiveNoteSession = (value: unknown): LiveNoteSession => {
  if (
    !liveNoteExactKeys(value, ['token', 'key', 'websocketPath', 'expiresAt']) ||
    typeof value.token !== 'string' ||
    value.token.length < 1 ||
    value.token.length > 8192 ||
    !isLiveNoteKey(value.key) ||
    value.websocketPath !== LIVE_NOTE_WEBSOCKET_PATH ||
    !date(value.expiresAt)
  )
    throw new TypeError('Live note session is invalid')
  return value as unknown as LiveNoteSession
}
export const parseLiveNoteHistoryItem = (value: unknown): LiveNoteHistoryItem => {
  if (
    !liveNoteExactKeys(value, ['revision', 'createdAt', 'actorId', 'title']) ||
    !isLiveNoteRevision(value.revision) ||
    !date(value.createdAt) ||
    !(value.actorId === null || id(value.actorId)) ||
    typeof value.title !== 'string' ||
    value.title.length > 200
  )
    throw new TypeError('Live note revision is invalid')
  return value as unknown as LiveNoteHistoryItem
}
const list = <T>(value: unknown, parse: (item: unknown) => T): { items: T[]; hasMore: boolean; nextCursor: string | null } => {
  if (
    !liveNoteExactKeys(value, ['items', 'hasMore', 'nextCursor']) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    typeof value.hasMore !== 'boolean' ||
    !(value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 256)) ||
    value.hasMore !== (value.nextCursor !== null)
  )
    throw new TypeError('Live note list is invalid')
  return { items: value.items.map(parse), hasMore: value.hasMore, nextCursor: value.nextCursor }
}
export const parseLiveNoteList = (value: unknown): LiveNoteList => list(value, parseLiveNoteSummary)
export const parseLiveNoteHistoryList = (value: unknown): LiveNoteHistoryList => list(value, parseLiveNoteHistoryItem)
export const parseLiveNoteClientMessage = (value: unknown): LiveNoteClientMessage => {
  if (
    liveNoteExactKeys(value, ['type', 'token']) &&
    value.type === 'auth' &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    value.token.length <= 8192
  )
    return value as unknown as LiveNoteClientMessage
  if (liveNoteExactKeys(value, ['type', 'requestId', 'update']) && value.type === 'update' && isLiveNoteRequestId(value.requestId)) {
    boundedUpdate(value.update, LIVE_NOTE_MAX_UPDATE_BYTES)
    return value as unknown as LiveNoteClientMessage
  }
  throw new TypeError('Live note message is invalid')
}
export const parseLiveNoteServerMessage = (value: unknown): LiveNoteServerMessage => {
  if (liveNoteExactKeys(value, ['type', 'note']) && value.type === 'sync') parseLiveNoteView(value.note)
  else if (liveNoteExactKeys(value, ['type', 'requestId', 'note']) && value.type === 'ack' && isLiveNoteRequestId(value.requestId))
    parseLiveNoteView(value.note)
  else if (
    !(
      liveNoteExactKeys(value, ['type', 'code', 'error']) &&
      value.type === 'error' &&
      typeof value.code === 'string' &&
      value.code.length > 0 &&
      value.code.length <= 100 &&
      typeof value.error === 'string' &&
      value.error.length <= 1000
    )
  )
    throw new TypeError('Live note message is invalid')
  return value as unknown as LiveNoteServerMessage
}

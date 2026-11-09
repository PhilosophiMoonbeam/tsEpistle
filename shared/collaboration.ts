import * as Y from 'yjs'

export const COLLABORATION_PROTOCOL_VERSION = 1 as const
export const COLLABORATION_UPDATE_VERSION = 1 as const
export const COLLABORATION_FORMAT = 'markdown' as const
export const COLLABORATION_TEXT_KEY = 'content' as const
export const COLLABORATION_WEBSOCKET_PATH = '/collaboration' as const
export const COLLABORATION_WEBSOCKET_PROTOCOL = 'wiki-collaboration-v1' as const
export const COLLABORATION_MAX_UPDATE_BYTES = 256 * 1024
export const COLLABORATION_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
export const COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE = 4410
export const COLLABORATION_MAX_PRESENCE_BYTES = 8 * 1024
export const COLLABORATION_MAX_PRESENCE_PARTICIPANTS = 32
export const COLLABORATION_MAX_RECENT_RANGES = 4
export const COLLABORATION_MAX_RECENT_LENGTH = 2048
export const COLLABORATION_MAX_SELECTION_LENGTH = 8192
export const COLLABORATION_PRESENCE_TTL_MS = 30_000
export const COLLABORATION_RECENT_TTL_MS = 8_000
export const COLLABORATION_PRESENCE_INTERVAL_MS = 250

export interface CollaborationPosition {
  tname: typeof COLLABORATION_TEXT_KEY
  item: { client: number; clock: number } | null
  assoc: -1 | 0
}

export interface CollaborationRange {
  start: CollaborationPosition
  end: CollaborationPosition
}

export interface CollaborationParticipant {
  token: string
  label: string
  selection: CollaborationRange | null
  recent: CollaborationRange[]
  expiresAt: number
}

export interface CollaborationAwareness {
  type: 'awareness'
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  generation: number
  enabled: boolean
  selection: CollaborationRange | null
  recent: CollaborationRange[]
}

export type CollaborationConflictReason = 'disabled' | 'draft-discarded' | 'page-changed' | 'permission-revoked' | 'protocol-error'

export interface CollaborationSession {
  token: string
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  generation: number
  revision: number
  baseSourceRevision: string
  baseUpdatedAt: string
  state: string
  websocketPath: typeof COLLABORATION_WEBSOCKET_PATH
}

export interface CollaborationClientUpdate {
  type: 'update'
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  generation: number
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  update: string
}

export type CollaborationClientMessage = CollaborationClientUpdate | CollaborationAwareness

export type CollaborationServerMessage =
  | {
      type: 'sync'
      protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
      updateVersion: typeof COLLABORATION_UPDATE_VERSION
      update: string
      generation: number
      revision: number
      baseSourceRevision: string
      baseUpdatedAt: string
      participants: number
    }
  | {
      type: 'update'
      protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
      updateVersion: typeof COLLABORATION_UPDATE_VERSION
      update: string
      generation: number
      revision: number
    }
  | { type: 'presence', participants: number }
  | { type: 'awareness', generation: number, self: string | null, peers: CollaborationParticipant[] }
  | { type: 'saved', baseUpdatedAt: string, baseSourceRevision: string }
  | { type: 'conflict', reason: CollaborationConflictReason }

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isDateString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))

const isPosition = (value: unknown): value is CollaborationPosition =>
  isRecord(value) && hasExactKeys(value, ['tname', 'item', 'assoc']) && value.tname === COLLABORATION_TEXT_KEY &&
  (value.assoc === -1 || value.assoc === 0) && (value.item === null ||
    (isRecord(value.item) && hasExactKeys(value.item, ['client', 'clock']) &&
      isNonNegativeInteger(value.item.client) && isNonNegativeInteger(value.item.clock)))

const isRange = (value: unknown): value is CollaborationRange =>
  isRecord(value) && hasExactKeys(value, ['start', 'end']) && isPosition(value.start) && isPosition(value.end)

const isRecentRange = (value: unknown): value is CollaborationRange =>
  isRange(value) && value.start.assoc === 0 && value.end.assoc === -1 &&
  value.start.item !== null && value.end.item !== null && value.start.item.client === value.end.item.client &&
  value.end.item.clock >= value.start.item.clock && value.end.item.clock - value.start.item.clock < COLLABORATION_MAX_RECENT_LENGTH

const isPresenceRanges = (value: Record<string, unknown>): boolean =>
  (value.selection === null || isRange(value.selection)) && Array.isArray(value.recent) &&
  value.recent.length <= COLLABORATION_MAX_RECENT_RANGES && value.recent.every(isRecentRange)

export const createCollaborationRange = (text: Y.Text, from: number, to = from): CollaborationRange => {
  const position = (index: number, assoc: -1 | 0): CollaborationPosition => {
    const relative = Y.createRelativePositionFromTypeIndex(text, index, assoc)
    return { tname: COLLABORATION_TEXT_KEY, item: relative.item ? { client: relative.item.client, clock: relative.item.clock } : null, assoc }
  }
  return { start: position(from, 0), end: position(to, to === from ? 0 : -1) }
}

export const resolveCollaborationRange = (text: Y.Text, range: CollaborationRange): { from: number; to: number } | null => {
  if (!text.doc || !isRange(range)) return null
  const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(range.start), text.doc, false)
  const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(range.end), text.doc, false)
  if (!start || !end || start.type !== text || end.type !== text || start.index > end.index ||
    end.index > text.length) return null
  if (start.index === end.index && (range.start.assoc !== range.end.assoc ||
    range.start.item?.client !== range.end.item?.client || range.start.item?.clock !== range.end.item?.clock)) return null
  if (end.index - start.index > COLLABORATION_MAX_SELECTION_LENGTH) return null
  if (start.index === end.index && range.start.item) {
    const surviving = Y.createRelativePositionFromTypeIndex(text, start.index, range.start.assoc).item
    if (surviving?.client !== range.start.item.client || surviving.clock !== range.start.item.clock) return null
  }
  return { from: start.index, to: end.index }
}

// Filter by surviving CRDT item IDs, not just the outer endpoints: concurrent
// insertions inside a recent edit must never acquire that participant's label.
export const resolveCollaborationRecent = (text: Y.Text, range: CollaborationRange): Array<{ from: number; to: number }> => {
  if (!isRecentRange(range)) return []
  const resolved = resolveCollaborationRange(text, range)
  if (!resolved || resolved.to - resolved.from > COLLABORATION_MAX_RECENT_LENGTH) return []
  const first = range.start.item!, last = range.end.item!
  const result: Array<{ from: number; to: number }> = []
  for (let index = resolved.from; index < resolved.to; index += 1) {
    const item = Y.createRelativePositionFromTypeIndex(text, index).item
    if (!item || item.client !== first.client || item.clock < first.clock || item.clock > last.clock) continue
    const previous = result[result.length - 1]
    if (previous?.to === index) previous.to += 1
    else result.push({ from: index, to: index + 1 })
  }
  return result
}

export const encodeCollaborationUpdate = (value: Uint8Array, maxBytes = COLLABORATION_MAX_DOCUMENT_BYTES): string => {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maxBytes) {
    throw new TypeError('Collaboration update size is invalid')
  }
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

export const decodeCollaborationUpdate = (value: unknown, maxBytes = COLLABORATION_MAX_DOCUMENT_BYTES): Uint8Array => {
  if (typeof value !== 'string' || value.length < 1 || !base64Pattern.test(value)) {
    throw new TypeError('Collaboration update must be canonical base64')
  }
  let binary: string
  try {
    binary = globalThis.atob(value)
  } catch {
    throw new TypeError('Collaboration update must be canonical base64')
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new TypeError('Collaboration update size is invalid')
  }
  if (encodeCollaborationUpdate(bytes, maxBytes) !== value) {
    throw new TypeError('Collaboration update must be canonical base64')
  }
  return bytes
}

export const parseCollaborationSession = (value: unknown): CollaborationSession => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'token', 'pageId', 'format', 'protocolVersion', 'updateVersion', 'generation', 'revision', 'baseSourceRevision', 'baseUpdatedAt', 'state', 'websocketPath'
  ])) throw new TypeError('Collaboration session is invalid')
  if (typeof value.token !== 'string' || value.token.length < 1 || !isPositiveInteger(value.pageId) ||
    value.format !== COLLABORATION_FORMAT || value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    value.updateVersion !== COLLABORATION_UPDATE_VERSION || !isPositiveInteger(value.generation) || !isNonNegativeInteger(value.revision) ||
    typeof value.baseSourceRevision !== 'string' || !/^[1-9][0-9]*$/u.test(value.baseSourceRevision) ||
    !isDateString(value.baseUpdatedAt) || value.websocketPath !== COLLABORATION_WEBSOCKET_PATH) {
    throw new TypeError('Collaboration session is invalid')
  }
  decodeCollaborationUpdate(value.state)
  return value as unknown as CollaborationSession
}

export const parseCollaborationClientMessage = (value: unknown): CollaborationClientMessage => {
  if (isRecord(value) && value.type === 'awareness') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'generation', 'enabled', 'selection', 'recent']) ||
      value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION || !isPositiveInteger(value.generation) ||
      typeof value.enabled !== 'boolean' || !isPresenceRanges(value) ||
      (!value.enabled && (value.selection !== null || (value.recent as unknown[]).length !== 0)) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > COLLABORATION_MAX_PRESENCE_BYTES) {
      throw new TypeError('Collaboration awareness message is invalid')
    }
    return value as unknown as CollaborationAwareness
  }
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'generation', 'update']) ||
    value.type !== 'update' || value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    value.updateVersion !== COLLABORATION_UPDATE_VERSION || !isPositiveInteger(value.generation)) {
    throw new TypeError('Collaboration client message is invalid')
  }
  decodeCollaborationUpdate(value.update, COLLABORATION_MAX_UPDATE_BYTES)
  return value as unknown as CollaborationClientMessage
}

export const parseCollaborationServerMessage = (value: unknown): CollaborationServerMessage => {
  if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('Collaboration server message is invalid')
  if (value.type === 'sync') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'generation', 'update', 'revision', 'baseSourceRevision', 'baseUpdatedAt', 'participants']) ||
      value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION || value.updateVersion !== COLLABORATION_UPDATE_VERSION ||
      !isPositiveInteger(value.generation) || !isNonNegativeInteger(value.revision) ||
      typeof value.baseSourceRevision !== 'string' || !/^[1-9][0-9]*$/u.test(value.baseSourceRevision) ||
      !isDateString(value.baseUpdatedAt) || !isNonNegativeInteger(value.participants)) {
      throw new TypeError('Collaboration sync message is invalid')
    }
    decodeCollaborationUpdate(value.update)
  } else if (value.type === 'update') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'generation', 'update', 'revision']) ||
      value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION || value.updateVersion !== COLLABORATION_UPDATE_VERSION ||
      !isPositiveInteger(value.generation) || !isNonNegativeInteger(value.revision)) throw new TypeError('Collaboration update message is invalid')
    decodeCollaborationUpdate(value.update, COLLABORATION_MAX_UPDATE_BYTES)
  } else if (value.type === 'presence') {
    if (!hasExactKeys(value, ['type', 'participants']) || !isNonNegativeInteger(value.participants)) {
      throw new TypeError('Collaboration presence message is invalid')
    }
  } else if (value.type === 'awareness') {
    const validToken = (token: unknown): token is string => typeof token === 'string' && /^[0-9a-f-]{36}$/u.test(token)
    if (!hasExactKeys(value, ['type', 'generation', 'self', 'peers']) || !isPositiveInteger(value.generation) ||
      (value.self !== null && !validToken(value.self)) || !Array.isArray(value.peers) ||
      value.peers.length > COLLABORATION_MAX_PRESENCE_PARTICIPANTS ||
      !value.peers.every(peer => isRecord(peer) && hasExactKeys(peer, ['token', 'label', 'selection', 'recent', 'expiresAt']) &&
        validToken(peer.token) && typeof peer.label === 'string' && /^Participant [0-9a-f]{8}$/u.test(peer.label) &&
        isPresenceRanges(peer) && isPositiveInteger(peer.expiresAt)) ||
      new Set(value.peers.map(peer => (peer as CollaborationParticipant).token)).size !== value.peers.length) {
      throw new TypeError('Collaboration awareness message is invalid')
    }
  } else if (value.type === 'saved') {
    if (!hasExactKeys(value, ['type', 'baseUpdatedAt', 'baseSourceRevision']) ||
      typeof value.baseSourceRevision !== 'string' || !/^[1-9][0-9]*$/u.test(value.baseSourceRevision) ||
      !isDateString(value.baseUpdatedAt)) {
      throw new TypeError('Collaboration saved message is invalid')
    }
  } else if (value.type === 'conflict') {
    if (!hasExactKeys(value, ['type', 'reason']) || !['disabled', 'draft-discarded', 'page-changed', 'permission-revoked', 'protocol-error'].includes(String(value.reason))) {
      throw new TypeError('Collaboration conflict message is invalid')
    }
  } else {
    throw new TypeError('Collaboration server message is invalid')
  }
  return value as CollaborationServerMessage
}

export const COLLABORATION_PROTOCOL_VERSION = 1 as const
export const COLLABORATION_UPDATE_VERSION = 1 as const
export const COLLABORATION_FORMAT = 'markdown' as const
export const COLLABORATION_TEXT_KEY = 'content' as const
export const COLLABORATION_WEBSOCKET_PATH = '/collaboration' as const
export const COLLABORATION_WEBSOCKET_PROTOCOL = 'wiki-collaboration-v1' as const
export const COLLABORATION_MAX_UPDATE_BYTES = 256 * 1024
export const COLLABORATION_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

export type CollaborationConflictReason = 'disabled' | 'page-changed' | 'permission-revoked' | 'protocol-error'

export interface CollaborationSession {
  token: string
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  revision: number
  baseUpdatedAt: string
  state: string
  websocketPath: typeof COLLABORATION_WEBSOCKET_PATH
}

export interface CollaborationClientUpdate {
  type: 'update'
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  update: string
}

export type CollaborationClientMessage = CollaborationClientUpdate

export type CollaborationServerMessage =
  | {
      type: 'sync'
      protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
      updateVersion: typeof COLLABORATION_UPDATE_VERSION
      update: string
      revision: number
      baseUpdatedAt: string
      participants: number
    }
  | {
      type: 'update'
      protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
      updateVersion: typeof COLLABORATION_UPDATE_VERSION
      update: string
      revision: number
    }
  | { type: 'presence', participants: number }
  | { type: 'saved', baseUpdatedAt: string }
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
    'token', 'pageId', 'format', 'protocolVersion', 'updateVersion', 'revision', 'baseUpdatedAt', 'state', 'websocketPath'
  ])) throw new TypeError('Collaboration session is invalid')
  if (typeof value.token !== 'string' || value.token.length < 1 || !isPositiveInteger(value.pageId) ||
    value.format !== COLLABORATION_FORMAT || value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    value.updateVersion !== COLLABORATION_UPDATE_VERSION || !isNonNegativeInteger(value.revision) ||
    !isDateString(value.baseUpdatedAt) || value.websocketPath !== COLLABORATION_WEBSOCKET_PATH) {
    throw new TypeError('Collaboration session is invalid')
  }
  decodeCollaborationUpdate(value.state)
  return value as unknown as CollaborationSession
}

export const parseCollaborationClientMessage = (value: unknown): CollaborationClientMessage => {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'update']) ||
    value.type !== 'update' || value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    value.updateVersion !== COLLABORATION_UPDATE_VERSION) {
    throw new TypeError('Collaboration client message is invalid')
  }
  decodeCollaborationUpdate(value.update, COLLABORATION_MAX_UPDATE_BYTES)
  return value as unknown as CollaborationClientMessage
}

export const parseCollaborationServerMessage = (value: unknown): CollaborationServerMessage => {
  if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('Collaboration server message is invalid')
  if (value.type === 'sync') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'update', 'revision', 'baseUpdatedAt', 'participants']) ||
      value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION || value.updateVersion !== COLLABORATION_UPDATE_VERSION ||
      !isNonNegativeInteger(value.revision) || !isDateString(value.baseUpdatedAt) || !isNonNegativeInteger(value.participants)) {
      throw new TypeError('Collaboration sync message is invalid')
    }
    decodeCollaborationUpdate(value.update)
  } else if (value.type === 'update') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'updateVersion', 'update', 'revision']) ||
      value.protocolVersion !== COLLABORATION_PROTOCOL_VERSION || value.updateVersion !== COLLABORATION_UPDATE_VERSION ||
      !isNonNegativeInteger(value.revision)) throw new TypeError('Collaboration update message is invalid')
    decodeCollaborationUpdate(value.update, COLLABORATION_MAX_UPDATE_BYTES)
  } else if (value.type === 'presence') {
    if (!hasExactKeys(value, ['type', 'participants']) || !isNonNegativeInteger(value.participants)) {
      throw new TypeError('Collaboration presence message is invalid')
    }
  } else if (value.type === 'saved') {
    if (!hasExactKeys(value, ['type', 'baseUpdatedAt']) || !isDateString(value.baseUpdatedAt)) {
      throw new TypeError('Collaboration saved message is invalid')
    }
  } else if (value.type === 'conflict') {
    if (!hasExactKeys(value, ['type', 'reason']) || !['disabled', 'page-changed', 'permission-revoked', 'protocol-error'].includes(String(value.reason))) {
      throw new TypeError('Collaboration conflict message is invalid')
    }
  } else {
    throw new TypeError('Collaboration server message is invalid')
  }
  return value as CollaborationServerMessage
}

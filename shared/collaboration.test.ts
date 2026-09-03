import { describe, expect, it } from '../server/test/bun-test.mts'
import * as Y from 'yjs'

import {
  COLLABORATION_FORMAT,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PATH,
  decodeCollaborationUpdate,
  encodeCollaborationUpdate,
  parseCollaborationClientMessage,
  parseCollaborationServerMessage,
  parseCollaborationSession
} from './collaboration.ts'

const state = (): string => {
  const document = new Y.Doc()
  document.getText(COLLABORATION_TEXT_KEY).insert(0, '# Shared\n')
  return encodeCollaborationUpdate(Y.encodeStateAsUpdate(document))
}

describe('collaboration protocol contract', () => {
  it('round trips a canonical versioned session and Yjs state', () => {
    const encoded = state()
    const session = parseCollaborationSession({
      token: 'signed-token',
      pageId: 42,
      format: COLLABORATION_FORMAT,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      generation: 4,
      revision: 3,
      baseSourceRevision: '9',
      baseUpdatedAt: '2026-08-15T12:00:00.000Z',
      state: encoded,
      websocketPath: COLLABORATION_WEBSOCKET_PATH
    })
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(session.state))
    expect(document.getText(COLLABORATION_TEXT_KEY).toString()).toBe('# Shared\n')
  })

  it('rejects unknown fields, versions, malformed base64, and oversized updates', () => {
    const encoded = state()
    expect(() => parseCollaborationClientMessage({
      type: 'update',
      protocolVersion: 1,
      generation: 4,
      updateVersion: 1,
      update: encoded,
      extra: true
    })).toThrow(/invalid/)
    expect(() => parseCollaborationClientMessage({
      type: 'update',
      protocolVersion: 2,
      generation: 4,
      updateVersion: 1,
      update: encoded
    })).toThrow(/invalid/)
    expect(() => decodeCollaborationUpdate('not base64!')).toThrow(/canonical base64/)
    expect(() => encodeCollaborationUpdate(new Uint8Array(9), 8)).toThrow(/size/)
  })

  it('accepts each exact server message shape and rejects mixed variants', () => {
    expect(parseCollaborationServerMessage({ type: 'presence', participants: 2 })).toEqual({ type: 'presence', participants: 2 })
    expect(parseCollaborationServerMessage({
      type: 'saved',
      baseUpdatedAt: '2026-08-15T12:00:00.000Z',
      baseSourceRevision: '9'
    })).toEqual({
      type: 'saved',
      baseUpdatedAt: '2026-08-15T12:00:00.000Z',
      baseSourceRevision: '9'
    })
    expect(() => parseCollaborationServerMessage({ type: 'conflict', reason: 'unknown' })).toThrow(/invalid/)
    expect(() => parseCollaborationServerMessage({ type: 'presence', participants: 2, revision: 1 })).toThrow(/invalid/)
  })
})

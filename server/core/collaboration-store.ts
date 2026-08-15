import type { Knex } from 'knex'
import * as Y from 'yjs'

import {
  COLLABORATION_FORMAT,
  COLLABORATION_MAX_DOCUMENT_BYTES,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_UPDATE_VERSION,
  decodeCollaborationUpdate,
  encodeCollaborationUpdate
} from '../../shared/collaboration.ts'

export interface CollaborationPageRecord {
  id: number
  content: string
  editorKey: string
  updatedAt: string | Date
}

export interface CollaborationRoomRecord {
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  revision: number
  state: string
  baseUpdatedAt: string
  updatedAt: string | Date
  updatedBy: number | null
}

export interface CollaborationApplyResult extends CollaborationRoomRecord {
  appliedUpdate: string
}

export type CollaborationPageSyncResult =
  | { kind: 'missing' }
  | { kind: 'saved', room: CollaborationRoomRecord }
  | { kind: 'reset', room: CollaborationRoomRecord }

const TABLE_NAME = 'pageCollaborationRooms'
const COMPACT_EVERY_REVISIONS = 32
const COMPACT_ABOVE_BYTES = 1024 * 1024
const MAX_CAS_ATTEMPTS = 12

const timestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('Page update timestamp is invalid')
  return date.toISOString()
}

const documentState = (content: string): Uint8Array => {
  const document = new Y.Doc()
  document.getText(COLLABORATION_TEXT_KEY).insert(0, content)
  const state = Y.encodeStateAsUpdate(document)
  document.destroy()
  if (state.byteLength > COLLABORATION_MAX_DOCUMENT_BYTES) throw new TypeError('Collaborative document is too large')
  return state
}

export const collaborationStateContent = (state: string): string => {
  const document = new Y.Doc()
  Y.applyUpdate(document, decodeCollaborationUpdate(state))
  const content = document.getText(COLLABORATION_TEXT_KEY).toString()
  document.destroy()
  return content
}

const compactState = (state: Uint8Array): Uint8Array => {
  const document = new Y.Doc()
  Y.applyUpdate(document, state)
  const compacted = Y.encodeStateAsUpdate(document)
  document.destroy()
  return compacted
}

const assertRoom = (row: CollaborationRoomRecord | undefined): CollaborationRoomRecord => {
  if (!row || row.format !== COLLABORATION_FORMAT || row.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    row.updateVersion !== COLLABORATION_UPDATE_VERSION || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new TypeError('Collaboration room schema is incompatible')
  }
  decodeCollaborationUpdate(row.state)
  return row
}

export class CollaborationRoomStore {
  private readonly knex: Knex

  constructor (knex: Knex) {
    this.knex = knex
  }

  async get(pageId: number): Promise<CollaborationRoomRecord | null> {
    const row = await this.knex<CollaborationRoomRecord>(TABLE_NAME).where({ pageId }).first()
    return row ? assertRoom(row) : null
  }

  async open(page: CollaborationPageRecord, userId: number): Promise<CollaborationRoomRecord> {
    if (page.editorKey !== COLLABORATION_FORMAT) throw new TypeError('Only Markdown source pages support collaboration')
    const baseUpdatedAt = timestamp(page.updatedAt)
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.get(page.id)
      if (!existing) {
        const now = new Date()
        const created: CollaborationRoomRecord = {
          pageId: page.id,
          format: COLLABORATION_FORMAT,
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          updateVersion: COLLABORATION_UPDATE_VERSION,
          revision: 0,
          state: encodeCollaborationUpdate(documentState(page.content)),
          baseUpdatedAt,
          updatedAt: now,
          updatedBy: userId
        }
        try {
          await this.knex<CollaborationRoomRecord>(TABLE_NAME).insert(created)
          return created
        } catch (error) {
          if (!await this.get(page.id)) throw error
          continue
        }
      }
      if (timestamp(existing.baseUpdatedAt) === baseUpdatedAt) return existing
      const next = {
        state: encodeCollaborationUpdate(documentState(page.content)),
        baseUpdatedAt,
        revision: existing.revision + 1,
        updatedAt: new Date(),
        updatedBy: userId
      }
      const changed = await this.knex<CollaborationRoomRecord>(TABLE_NAME)
        .where({ pageId: page.id, revision: existing.revision })
        .update(next)
      if (changed === 1) return assertRoom({ ...existing, ...next })
    }
    throw new Error('Collaboration room changed too frequently')
  }

  async apply(pageId: number, update: Uint8Array, userId: number): Promise<CollaborationApplyResult> {
    if (!(update instanceof Uint8Array) || update.byteLength < 1) throw new TypeError('Collaboration update is invalid')
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.get(pageId)
      if (!existing) throw new Error('Collaboration room does not exist')
      const incoming = encodeCollaborationUpdate(update, COLLABORATION_MAX_DOCUMENT_BYTES)
      let merged: Uint8Array
      try {
        merged = Y.mergeUpdates([decodeCollaborationUpdate(existing.state), update])
      } catch {
        throw new TypeError('Collaboration update is invalid')
      }
      const revision = existing.revision + 1
      if (revision % COMPACT_EVERY_REVISIONS === 0 || merged.byteLength > COMPACT_ABOVE_BYTES) merged = compactState(merged)
      if (merged.byteLength > COLLABORATION_MAX_DOCUMENT_BYTES) throw new TypeError('Collaborative document is too large')
      const next = {
        state: encodeCollaborationUpdate(merged),
        revision,
        updatedAt: new Date(),
        updatedBy: userId
      }
      const changed = await this.knex<CollaborationRoomRecord>(TABLE_NAME)
        .where({ pageId, revision: existing.revision })
        .update(next)
      if (changed === 1) return { ...existing, ...next, appliedUpdate: incoming }
    }
    throw new Error('Collaboration update contention exceeded retry limit')
  }

  async synchronizePage(page: CollaborationPageRecord, userId: number): Promise<CollaborationPageSyncResult> {
    const baseUpdatedAt = timestamp(page.updatedAt)
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.get(page.id)
      if (!existing) return { kind: 'missing' }
      const sameContent = collaborationStateContent(existing.state) === page.content
      if (sameContent && timestamp(existing.baseUpdatedAt) === baseUpdatedAt) return { kind: 'saved', room: existing }
      const next = sameContent
        ? { baseUpdatedAt, revision: existing.revision + 1, updatedAt: new Date(), updatedBy: userId }
        : {
            state: encodeCollaborationUpdate(documentState(page.content)),
            baseUpdatedAt,
            revision: existing.revision + 1,
            updatedAt: new Date(),
            updatedBy: userId
          }
      const changed = await this.knex<CollaborationRoomRecord>(TABLE_NAME)
        .where({ pageId: page.id, revision: existing.revision })
        .update(next)
      if (changed === 1) return { kind: sameContent ? 'saved' : 'reset', room: assertRoom({ ...existing, ...next }) }
    }
    throw new Error('Collaboration room changed too frequently')
  }
}

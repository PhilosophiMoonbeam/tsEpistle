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
  sourceRevision: string
}

export interface CollaborationRoomRecord {
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  generation: number
  revision: number
  state: string
  baseSourceRevision: string
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

export type CollaborationDiscardResult =
  | { kind: 'reset', room: CollaborationRoomRecord }
  | { kind: 'stale-page' }
  | { kind: 'stale-room' }
  | { kind: 'other-contributors' }
  | { kind: 'active-peer' }

const ROOM_TABLE = 'pageCollaborationRooms'
const CONTRIBUTOR_TABLE = 'pageCollaborationContributors'
const CONNECTION_TABLE = 'pageCollaborationConnections'
const PAGE_TABLE = 'pages'
const COMPACT_EVERY_REVISIONS = 32
const COMPACT_ABOVE_BYTES = 1024 * 1024
const MAX_CREATE_ATTEMPTS = 3

const timestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('Page update timestamp is invalid')
  return date.toISOString()
}

const sourceRevision = (value: string): string => {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new TypeError('Page source revision is invalid')
  return value
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
  const baseSourceRevision = String(row?.baseSourceRevision ?? '')
  if (!row || row.format !== COLLABORATION_FORMAT || row.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    row.updateVersion !== COLLABORATION_UPDATE_VERSION || !Number.isSafeInteger(row.generation) || row.generation < 1 ||
    !Number.isSafeInteger(row.revision) || row.revision < 0 || !/^[1-9][0-9]*$/u.test(baseSourceRevision)) {
    throw new TypeError('Collaboration room schema is incompatible')
  }
  decodeCollaborationUpdate(row.state)
  return { ...row, baseSourceRevision }
}

const lockedRoom = async (transaction: Knex.Transaction, pageId: number): Promise<CollaborationRoomRecord | null> => {
  const row = await transaction<CollaborationRoomRecord>(ROOM_TABLE).where({ pageId }).forUpdate().first()
  return row ? assertRoom(row) : null
}

const clearGenerationState = async (transaction: Knex.Transaction, pageId: number): Promise<void> => {
  await transaction(CONNECTION_TABLE).where({ pageId }).delete()
  await transaction(CONTRIBUTOR_TABLE).where({ pageId }).delete()
}

export class CollaborationRoomStore {
  private readonly knex: Knex

  constructor (knex: Knex) {
    this.knex = knex
  }

  async get(pageId: number): Promise<CollaborationRoomRecord | null> {
    const row = await this.knex<CollaborationRoomRecord>(ROOM_TABLE).where({ pageId }).first()
    return row ? assertRoom(row) : null
  }

  async open(page: CollaborationPageRecord): Promise<CollaborationRoomRecord> {
    if (page.editorKey !== COLLABORATION_FORMAT) throw new TypeError('Only Markdown source pages support collaboration')
    const baseUpdatedAt = timestamp(page.updatedAt)
    const baseSourceRevision = sourceRevision(page.sourceRevision)
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        return await this.knex.transaction(async transaction => {
          const existing = await lockedRoom(transaction, page.id)
          if (!existing) {
            const created: CollaborationRoomRecord = {
              pageId: page.id,
              format: COLLABORATION_FORMAT,
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
              updateVersion: COLLABORATION_UPDATE_VERSION,
              generation: 1,
              revision: 0,
              state: encodeCollaborationUpdate(documentState(page.content)),
              baseUpdatedAt,
              baseSourceRevision,
              updatedAt: new Date(),
              updatedBy: null
            }
            await transaction<CollaborationRoomRecord>(ROOM_TABLE).insert(created)
            return created
          }
          if (timestamp(existing.baseUpdatedAt) === baseUpdatedAt && existing.baseSourceRevision === baseSourceRevision) return existing

          const sameContent = collaborationStateContent(existing.state) === page.content
          const next = {
            ...(sameContent ? {} : {
              state: encodeCollaborationUpdate(documentState(page.content)),
              generation: existing.generation + 1
            }),
            baseUpdatedAt,
            baseSourceRevision,
            revision: existing.revision + 1,
            updatedAt: new Date(),
            updatedBy: null
          }
          const changed = await transaction<CollaborationRoomRecord>(ROOM_TABLE)
            .where({ pageId: page.id, generation: existing.generation, revision: existing.revision })
            .update(next)
          if (changed !== 1) throw new Error('Collaboration room changed while opening')
          await transaction(CONTRIBUTOR_TABLE).where({ pageId: page.id }).delete()
          if (!sameContent) await transaction(CONNECTION_TABLE).where({ pageId: page.id }).delete()
          return assertRoom({ ...existing, ...next })
        })
      } catch (error) {
        const concurrent = await this.get(page.id)
        if (concurrent && timestamp(concurrent.baseUpdatedAt) === baseUpdatedAt &&
          concurrent.baseSourceRevision === baseSourceRevision) return concurrent
        if (attempt + 1 >= MAX_CREATE_ATTEMPTS) throw error
      }
    }
    throw new Error('Collaboration room could not be opened')
  }

  async admit(
    pageId: number,
    generation: number,
    userId: number,
    connectionId: string,
    expiresAt: Date,
    expectedBaseUpdatedAt: string,
    expectedBaseSourceRevision: string
  ): Promise<CollaborationRoomRecord | null> {
    return this.knex.transaction(async transaction => {
      const room = await lockedRoom(transaction, pageId)
      if (!room || room.generation !== generation || timestamp(room.baseUpdatedAt) !== timestamp(expectedBaseUpdatedAt) ||
        room.baseSourceRevision !== expectedBaseSourceRevision) return null
      await transaction(CONNECTION_TABLE).where('expiresAt', '<=', new Date()).delete()
      await transaction(CONNECTION_TABLE).insert({ id: connectionId, pageId, generation, userId, expiresAt })
      return room
    })
  }

  async leave(connectionId: string): Promise<void> {
    await this.knex(CONNECTION_TABLE).where({ id: connectionId }).delete()
  }

  async apply(
    pageId: number,
    generation: number,
    connectionId: string,
    update: Uint8Array,
    userId: number
  ): Promise<CollaborationApplyResult | null> {
    if (!(update instanceof Uint8Array) || update.byteLength < 1) throw new TypeError('Collaboration update is invalid')
    return this.knex.transaction(async transaction => {
      const existing = await lockedRoom(transaction, pageId)
      if (!existing || existing.generation !== generation) return null
      const now = new Date()
      await transaction(CONNECTION_TABLE).where('expiresAt', '<=', now).delete()
      const connection = await transaction(CONNECTION_TABLE)
        .where({ id: connectionId, pageId, generation, userId })
        .where('expiresAt', '>', now)
        .first('id')
      if (!connection) return null

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
      const changed = await transaction<CollaborationRoomRecord>(ROOM_TABLE)
        .where({ pageId, generation, revision: existing.revision })
        .update(next)
      if (changed !== 1) throw new Error('Collaboration room changed while applying an update')
      await transaction(CONTRIBUTOR_TABLE)
        .insert({ pageId, generation, userId })
        .onConflict(['pageId', 'generation', 'userId'])
        .ignore()
      return { ...existing, ...next, appliedUpdate: incoming }
    })
  }

  async resetDraft(
    page: CollaborationPageRecord,
    userId: number,
    expectedRevision: number,
    expectedGeneration: number,
    expectedSourceRevision: string
  ): Promise<CollaborationDiscardResult> {
    if (page.editorKey !== COLLABORATION_FORMAT) throw new TypeError('Only Markdown source pages support collaboration')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new TypeError('Collaboration revision is invalid')
    return this.knex.transaction(async transaction => {
      const lockedPage = await transaction<{ id: number, sourceRevision: string | number }>(PAGE_TABLE)
        .where({ id: page.id })
        .forUpdate()
        .first('sourceRevision')
      if (!lockedPage || String(lockedPage.sourceRevision) !== expectedSourceRevision) return { kind: 'stale-page' }

      const existing = await lockedRoom(transaction, page.id)
      if (!existing || existing.revision !== expectedRevision || existing.generation !== expectedGeneration) return { kind: 'stale-room' }
      const otherContributor = await transaction(CONTRIBUTOR_TABLE)
        .where({ pageId: page.id, generation: existing.generation })
        .whereNot({ userId })
        .first('userId')
      if (otherContributor) return { kind: 'other-contributors' }

      const now = new Date()
      await transaction(CONNECTION_TABLE).where('expiresAt', '<=', now).delete()
      const activePeer = await transaction(CONNECTION_TABLE)
        .where({ pageId: page.id, generation: existing.generation })
        .whereNot({ userId })
        .where('expiresAt', '>', now)
        .first('userId')
      if (activePeer) return { kind: 'active-peer' }

      const next = {
        state: encodeCollaborationUpdate(documentState(page.content)),
        baseUpdatedAt: timestamp(page.updatedAt),
        baseSourceRevision: expectedSourceRevision,
        generation: existing.generation + 1,
        revision: existing.revision + 1,
        updatedAt: new Date(),
        updatedBy: null
      }
      const changed = await transaction<CollaborationRoomRecord>(ROOM_TABLE)
        .where({ pageId: page.id, generation: expectedGeneration, revision: expectedRevision })
        .update(next)
      if (changed !== 1) return { kind: 'stale-room' }
      await clearGenerationState(transaction, page.id)
      return { kind: 'reset', room: assertRoom({ ...existing, ...next }) }
    })
  }

  async synchronizePage(page: CollaborationPageRecord, userId: number): Promise<CollaborationPageSyncResult> {
    const baseUpdatedAt = timestamp(page.updatedAt)
    const baseSourceRevision = sourceRevision(page.sourceRevision)
    return this.knex.transaction(async transaction => {
      const existing = await lockedRoom(transaction, page.id)
      if (!existing) return { kind: 'missing' }
      const sameContent = collaborationStateContent(existing.state) === page.content
      if (sameContent && timestamp(existing.baseUpdatedAt) === baseUpdatedAt &&
        existing.baseSourceRevision === baseSourceRevision) return { kind: 'saved', room: existing }
      const next = sameContent
        ? { baseUpdatedAt, baseSourceRevision, revision: existing.revision + 1, updatedAt: new Date(), updatedBy: userId }
        : {
            state: encodeCollaborationUpdate(documentState(page.content)),
            baseUpdatedAt,
            baseSourceRevision,
            generation: existing.generation + 1,
            revision: existing.revision + 1,
            updatedAt: new Date(),
            updatedBy: userId
          }
      const changed = await transaction<CollaborationRoomRecord>(ROOM_TABLE)
        .where({ pageId: page.id, generation: existing.generation, revision: existing.revision })
        .update(next)
      if (changed !== 1) throw new Error('Collaboration room changed while synchronizing the page')
      await transaction(CONTRIBUTOR_TABLE).where({ pageId: page.id }).delete()
      if (!sameContent) await transaction(CONNECTION_TABLE).where({ pageId: page.id }).delete()
      return { kind: sameContent ? 'saved' : 'reset', room: assertRoom({ ...existing, ...next }) }
    })
  }
}

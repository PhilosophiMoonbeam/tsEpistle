
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import * as Y from 'yjs'

import { CollaborationRoomStore, collaborationStateContent, type CollaborationRoomRecord } from '../../core/collaboration-store.ts'
import { up as upCollaboration } from '../../db/migrations/2.5.136.ts'
import { up as upDiscardFencing } from '../../db/migrations/tsfranki-000012-collaboration-discard-fencing.ts'
import {
  COLLABORATION_TEXT_KEY,
  decodeCollaborationUpdate
} from '../../../shared/collaboration.ts'

let knex: Knex
let store: CollaborationRoomStore

const basePage = {
  id: 42,
  content: '# Shared\n',
  editorKey: 'markdown',
  updatedAt: '2026-08-15T12:00:00.000Z',
  sourceRevision: '1'
}

const updateFrom = (state: string, change: (text: Y.Text) => void): Uint8Array => {
  const document = new Y.Doc()
  Y.applyUpdate(document, decodeCollaborationUpdate(state))
  let update: Uint8Array | null = null
  document.on('update', value => { update = value })
  change(document.getText(COLLABORATION_TEXT_KEY))
  if (!update) throw new Error('Expected a Yjs update')
  return update
}

const admit = async (
  target: CollaborationRoomStore,
  room: CollaborationRoomRecord,
  userId: number,
  connectionId: string
): Promise<void> => {
  const admitted = await target.admit(
    room.pageId,
    room.generation,
    userId,
    connectionId,
    new Date(Date.now() + 60_000),
    room.baseUpdatedAt,
    room.baseSourceRevision
  )
  expect(admitted?.generation).toBe(room.generation)
}

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('sourceRevision').notNullable()
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }])
  await knex('pages').insert({ id: basePage.id, sourceRevision: basePage.sourceRevision })
  await upCollaboration(knex)
  await upDiscardFencing(knex)
  store = new CollaborationRoomStore(knex)
})

afterEach(async () => {
  await knex.destroy()
})

describe('collaboration room store', () => {
  it('durably merges admitted updates from independent stores without losing either edit', async () => {
    const opened = await store.open(basePage)
    const peerStore = new CollaborationRoomStore(knex)
    await admit(store, opened, 7, 'primary-connection')
    await admit(peerStore, opened, 8, 'peer-connection')
    const append = updateFrom(opened.state, text => text.insert(text.length, 'A'))
    const prepend = updateFrom(opened.state, text => text.insert(0, 'B'))

    await Promise.all([
      store.apply(basePage.id, opened.generation, 'primary-connection', append, 7),
      peerStore.apply(basePage.id, opened.generation, 'peer-connection', prepend, 8)
    ])

    const durable = await new CollaborationRoomStore(knex).get(basePage.id)
    expect(durable?.revision).toBe(2)
    expect(collaborationStateContent(durable?.state ?? '')).toBe('B# Shared\nA')
  })

  it('fences stale cross-instance admissions and updates after reset generation advances', async () => {
    const opened = await store.open(basePage)
    const peerStore = new CollaborationRoomStore(knex)
    await admit(peerStore, opened, 7, 'peer-tab')
    const changed = await peerStore.apply(
      basePage.id,
      opened.generation,
      'peer-tab',
      updateFrom(opened.state, text => text.insert(text.length, 'discarded')),
      7
    )
    if (!changed) throw new Error('Expected collaboration update')

    const reset = await store.resetDraft(basePage, 7, changed.revision, changed.generation, basePage.sourceRevision)
    expect(reset.kind).toBe('reset')
    if (reset.kind !== 'reset') throw new Error('Expected reset')
    expect(reset.room.generation).toBe(opened.generation + 1)
    expect(await peerStore.apply(
      basePage.id,
      opened.generation,
      'peer-tab',
      updateFrom(changed.state, text => text.insert(text.length, 'resurrected')),
      7
    )).toBeNull()
    expect(await peerStore.admit(
      basePage.id,
      opened.generation,
      7,
      'late-old-session',
      new Date(Date.now() + 60_000),
      opened.baseUpdatedAt,
      opened.baseSourceRevision
    )).toBeNull()
    expect(collaborationStateContent((await store.get(basePage.id))?.state ?? '')).toBe(basePage.content)
  })

  it('rejects discard when a different principal is durably active on another instance', async () => {
    const opened = await store.open(basePage)
    const peerStore = new CollaborationRoomStore(knex)
    await admit(peerStore, opened, 8, 'remote-peer')

    const result = await store.resetDraft(basePage, 7, opened.revision, opened.generation, basePage.sourceRevision)

    expect(result.kind).toBe('active-peer')
    expect((await store.get(basePage.id))?.generation).toBe(opened.generation)
  })

  it('rejects mixed-contributor discard even when the requester wrote last and the peer disconnected', async () => {
    const opened = await store.open(basePage)
    await admit(store, opened, 8, 'other-user')
    const otherChange = await store.apply(
      basePage.id,
      opened.generation,
      'other-user',
      updateFrom(opened.state, text => text.insert(text.length, 'other')),
      8
    )
    if (!otherChange) throw new Error('Expected other-user update')
    await store.leave('other-user')
    await admit(store, otherChange, 7, 'requester')
    const requesterChange = await store.apply(
      basePage.id,
      opened.generation,
      'requester',
      updateFrom(otherChange.state, text => text.insert(text.length, 'requester')),
      7
    )
    if (!requesterChange) throw new Error('Expected requester update')

    const result = await store.resetDraft(basePage, 7, requesterChange.revision, requesterChange.generation, basePage.sourceRevision)

    expect(result.kind).toBe('other-contributors')
    expect(collaborationStateContent((await store.get(basePage.id))?.state ?? '')).toContain('other')
  })

  it('rejects discard after a page save wins the shared page-row lock', async () => {
    const opened = await store.open(basePage)
    await knex('pages').where({ id: basePage.id }).update({ sourceRevision: '2' })

    const result = await store.resetDraft(basePage, 7, opened.revision, opened.generation, basePage.sourceRevision)

    expect(result.kind).toBe('stale-page')
    expect((await store.get(basePage.id))?.generation).toBe(opened.generation)
  })

  it('clears contributor history at a saved baseline and bumps generation for external replacement', async () => {
    const opened = await store.open(basePage)
    await admit(store, opened, 7, 'author')
    const changed = await store.apply(
      basePage.id,
      opened.generation,
      'author',
      updateFrom(opened.state, text => text.insert(text.length, 'saved')),
      7
    )
    if (!changed) throw new Error('Expected collaboration update')
    const saved = await store.synchronizePage({
      ...basePage,
      content: '# Shared\nsaved',
      updatedAt: '2026-08-15T12:01:00.000Z',
      sourceRevision: '2'
    }, 7)
    expect(saved.kind).toBe('saved')

    const reset = await store.synchronizePage({
      ...basePage,
      content: '# External\n',
      updatedAt: '2026-08-15T12:02:00.000Z',
      sourceRevision: '3'
    }, 8)
    expect(reset.kind).toBe('reset')
    if (reset.kind !== 'reset') throw new Error('Expected reset room')
    expect(reset.room.generation).toBe(opened.generation + 1)
    expect(collaborationStateContent(reset.room.state)).toBe('# External\n')
  })
})

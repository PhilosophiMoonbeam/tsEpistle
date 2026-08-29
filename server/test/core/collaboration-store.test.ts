
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import * as Y from 'yjs'

import { CollaborationRoomStore } from '../../core/collaboration-store.ts'
import { up as upCollaboration } from '../../db/migrations/2.5.136.ts'
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
  updatedAt: '2026-08-15T12:00:00.000Z'
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

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => table.integer('id').primary())
  await knex('users').insert([{ id: 7 }, { id: 8 }])
  await knex('pages').insert({ id: basePage.id })
  await upCollaboration(knex)
  store = new CollaborationRoomStore(knex)
})

afterEach(async () => {
  await knex.destroy()
})

describe('collaboration room store', () => {
  it('durably merges concurrent updates from independent stores without losing either edit', async () => {
    const opened = await store.open(basePage, 7)
    const peerStore = new CollaborationRoomStore(knex)
    const append = updateFrom(opened.state, text => text.insert(text.length, 'A'))
    const prepend = updateFrom(opened.state, text => text.insert(0, 'B'))

    await Promise.all([
      store.apply(basePage.id, append, 7),
      peerStore.apply(basePage.id, prepend, 8)
    ])

    const restarted = new CollaborationRoomStore(knex)
    const durable = await restarted.get(basePage.id)
    expect(durable?.revision).toBe(2)
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(durable?.state))
    expect(document.getText(COLLABORATION_TEXT_KEY).toString()).toBe('B# Shared\nA')
  })

  it('advances the save base for matching content and resets on an external edit', async () => {
    const opened = await store.open(basePage, 7)
    const update = updateFrom(opened.state, text => text.insert(text.length, 'local'))
    await store.apply(basePage.id, update, 7)
    const matchingContent = '# Shared\nlocal'

    const saved = await store.synchronizePage({
      ...basePage,
      content: matchingContent,
      updatedAt: '2026-08-15T12:01:00.000Z'
    }, 7)
    expect(saved.kind).toBe('saved')
    if (saved.kind !== 'saved') throw new Error('Expected saved room')
    expect(saved.room.baseUpdatedAt).toBe('2026-08-15T12:01:00.000Z')

    const reset = await store.synchronizePage({
      ...basePage,
      content: '# External\n',
      updatedAt: '2026-08-15T12:02:00.000Z'
    }, 8)
    expect(reset.kind).toBe('reset')
    if (reset.kind !== 'reset') throw new Error('Expected reset room')
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(reset.room.state))
    expect(document.getText(COLLABORATION_TEXT_KEY).toString()).toBe('# External\n')
  })
})

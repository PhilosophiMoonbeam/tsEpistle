import createKnex, { type Knex } from 'knex'
import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { createLiveNotesStore, type LiveNotesOperations } from '../../operations/live-notes.ts'
import { decodeCollaborationUpdate, encodeCollaborationUpdate } from '../../../shared/collaboration.ts'

const connection = getPostgresTestConnection('_live_notes_test', import.meta.path)
const suite = connection ? describe : describe.skip
const owner = { id: 7, authVersion: 0 } as Express.User
const peer = { id: 8, authVersion: 0 } as Express.User
const edit = (state: string, value: string): string => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeCollaborationUpdate(state))
    const before = Y.encodeStateVector(doc)
    doc.getText('content').insert(doc.getText('content').length, value)
    return encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc, before))
  } finally {
    doc.destroy()
  }
}
const source = (state: string): string => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeCollaborationUpdate(state))
    return doc.getText('content').toString()
  } finally {
    doc.destroy()
  }
}

suite('native live note transaction fencing', () => {
  let db: Knex
  let notes: LiveNotesOperations
  let second: LiveNotesOperations
  beforeAll(async () => {
    db = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable().defaultTo(true)
      table.integer('authVersion').notNullable().defaultTo(0)
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId')
      table.integer('groupId')
    })
    await up(db)
  })
  beforeEach(async () => {
    for (const table of ['liveNoteConnections', 'liveNoteRequests', 'liveNoteRevisions', 'liveNotes', 'userGroups', 'groups', 'users']) await db(table).delete()
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db('groups').insert([{ id: 3, permissions: '["write:notes"]' }])
    await db('userGroups').insert([
      { userId: 7, groupId: 3 },
      { userId: 8, groupId: 3 }
    ])
    const dependencies = { db, secret: 'application-session-root', audience: 'urn:wiki:test' }
    notes = createLiveNotesStore(dependencies)
    second = createLiveNotesStore(dependencies)
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['liveNoteConnections', 'liveNoteRequests', 'liveNoteRevisions', 'liveNotes', 'userGroups', 'groups', 'users'])
        await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  it('serializes independent-instance CRDT merges and concurrent duplicate acknowledgements', async () => {
    const created = await notes.create(owner, {})
    const shared = await notes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' })
    const a = edit(shared.state, 'Alice'),
      b = edit(shared.state, 'Bob')
    await Promise.all([
      notes.applyUpdate(owner, created.key, { update: a, requestId: 'alice' }),
      second.applyUpdate(peer, created.key, { update: b, requestId: 'bob' }),
      second.applyUpdate(owner, created.key, { update: a, requestId: 'alice' })
    ])
    const reopened = createLiveNotesStore({ db, secret: 'application-session-root', audience: 'urn:wiki:test' })
    const durable = await reopened.read(owner, created.key)
    expect(durable.revision).toBe(3)
    expect(['AliceBob', 'BobAlice']).toContain(source(durable.state))
    expect(await db('liveNoteRequests').where('noteId', created.id)).toHaveLength(2)
    expect((await notes.history(owner, created.key)).items.map(item => item.revision)).toEqual([3, 2, 1, 0])
    expect((await notes.list(peer)).items).toEqual([])
    const historical = await reopened.revision(owner, created.key, 2)
    const offline = edit(durable.state, '/offline')
    const restored = await second.restore(owner, created.key, 2, { expectedRevision: 3 })
    expect(restored.revision).toBe(4)
    expect(source(restored.state)).toBe(source(historical.state))
    const reconnected = await reopened.applyUpdate(owner, created.key, { requestId: 'after-restore', update: offline })
    expect(reconnected.revision).toBe(5)
    expect(source(reconnected.state)).toContain(source(historical.state))
    expect(source(reconnected.state)).not.toBe(source(durable.state))
  })

  it('rolls back unsupported pending formatting while another instance commits plain text', async () => {
    const created = await notes.create(owner, {}),
      doc = new Y.Doc(),
      updates: Uint8Array[] = []
    try {
      doc.on('update', update => updates.push(update))
      doc.getText('content').insert(0, 'dependency')
      doc.getText('content').format(0, 10, { bold: true })
      const results = await Promise.allSettled([
        notes.applyUpdate(owner, created.key, { requestId: 'unsupported', update: encodeCollaborationUpdate(updates[1]!) }),
        second.applyUpdate(owner, created.key, { requestId: 'plain', update: edit(created.state, '# Safe') })
      ])
      expect(results[0].status).toBe('rejected')
      if (results[0].status === 'rejected') expect(results[0].reason).toMatchObject({ status: 400 })
      expect(results[1].status).toBe('fulfilled')
      const durable = await second.read(owner, created.key)
      expect(durable.revision).toBe(1)
      expect(source(durable.state)).toBe('# Safe')
      expect((await notes.history(owner, created.key)).items.map(item => item.revision)).toEqual([1, 0])
      expect((await db('liveNoteRequests').where('noteId', created.id)).map(row => row.requestId)).toEqual(['plain'])
      const afterReconnect = await notes.applyUpdate(owner, created.key, { requestId: 'unsupported', update: encodeCollaborationUpdate(updates[0]!) })
      expect(afterReconnect.revision).toBe(2)
      expect(source(afterReconnect.state)).toContain('dependency')
      expect(source(afterReconnect.state)).toContain('# Safe')
    } finally {
      doc.destroy()
    }
  })

  it('observes committed group and account invalidation instead of cached requester grants', async () => {
    const created = await notes.create(owner, {}),
      update = edit(created.state, 'must not persist')
    const policyChange = await db.transaction()
    await policyChange('groups').where('id', 3).forUpdate().first()
    await policyChange('groups').where('id', 3).update({ permissions: '[]' })
    const blockedWrite = second.applyUpdate(owner, created.key, { update, requestId: 'revoked' })
    await policyChange.commit()
    await expect(blockedWrite).rejects.toMatchObject({ status: 404 })
    expect(source((await db('liveNotes').where('id', created.id).first()).state)).toBe('')
    expect(await db('liveNoteRequests')).toHaveLength(0)
    await db('groups').where('id', 3).update({ permissions: '["write:notes"]' })
    const token = await notes.session(owner, created.key)
    await db('users').where('id', 7).update({ authVersion: 1 })
    await expect(second.authorizeSession(token.token)).rejects.toMatchObject({ status: 401 })
    await expect(second.applyUpdate(owner, created.key, { update, requestId: 'stale-account' })).rejects.toMatchObject({ status: 401 })
    expect(Number((await db('liveNotes').where('id', created.id).first()).revision)).toBe(0)
  })

  it('allows only one concurrent metadata decision and fences deleted-note leases', async () => {
    const created = await notes.create(owner, {})
    const results = await Promise.allSettled([
      notes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' }),
      second.updateAccess(owner, created.key, { expectedRevision: 0, access: 'read' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => (result.status === 'rejected' ? result.reason.status : 0))).toEqual([409])
    const current = await notes.read(owner, created.key)
    await notes.lease(created.key, 'first-room', new Date(Date.now() + 60_000))
    await notes.remove(owner, created.key, { expectedRevision: current.revision })
    await expect(second.lease(created.key, 'late-room', new Date(Date.now() + 60_000))).rejects.toMatchObject({ status: 404 })
    expect(await db('liveNoteConnections')).toHaveLength(0)
    expect((await notes.list(owner)).items).toEqual([])
  })
})

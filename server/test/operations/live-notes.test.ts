import createKnex, { type Knex } from 'knex'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { up, down } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { createLiveNotesStore, type LiveNotesOperations } from '../../operations/live-notes.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import { decodeCollaborationUpdate, encodeCollaborationUpdate } from '../../../shared/collaboration.ts'
import {
  LIVE_NOTE_MAX_UPDATE_BYTES,
  parseLiveNoteList,
  parseLiveNoteView,
  parseLiveNoteSession,
  parseLiveNoteClientMessage
} from '../../../shared/live-notes.ts'
import { groupPermissions } from '../../../shared/group-policy.ts'

const owner = { id: 7, authVersion: 0 } as Express.User
const other = { id: 8, authVersion: 0 } as Express.User
const guest = { id: 2, authVersion: 0, ownershipUserId: null } as Express.User
const manager = { id: 9, authVersion: 0 } as Express.User
const text = (state: string): string => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeCollaborationUpdate(state))
    return doc.getText('content').toString()
  } finally {
    doc.destroy()
  }
}
const edit = (state: string, change: (value: Y.Text) => void): string => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeCollaborationUpdate(state))
    const before = Y.encodeStateVector(doc)
    doc.transact(() => change(doc.getText('content')))
    return encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc, before))
  } finally {
    doc.destroy()
  }
}
let db: Knex
let notes: LiveNotesOperations
let instant: Date
beforeEach(async () => {
  instant = new Date('2026-10-22T12:00:00.000Z')
  db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
    // SQLite represents the PostgreSQL boolean account column as 0/1.
    postProcessResponse: value => {
      const normalize = (row: unknown) => {
        if (typeof row === 'object' && row !== null && 'isActive' in row) return { ...row, isActive: Boolean(row.isActive) }
        return row
      }
      return Array.isArray(value) ? value.map(normalize) : normalize(value)
    }
  })
  await db.raw('PRAGMA foreign_keys = ON')
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.integer('authVersion').notNullable().defaultTo(0)
  })
  await db.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions').notNullable()
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId')
    table.integer('groupId')
  })
  await db('users').insert([2, 7, 8, 9].map(id => ({ id })))
  await db('groups').insert([
    { id: 2, permissions: '["read:notes","write:notes"]' },
    { id: 3, permissions: '["write:notes"]' },
    { id: 4, permissions: '["manage:system"]' }
  ])
  await db('userGroups').insert([
    { userId: 2, groupId: 2 },
    { userId: 7, groupId: 3 },
    { userId: 8, groupId: 3 },
    { userId: 9, groupId: 4 }
  ])
  await up(db)
  notes = createLiveNotesStore({ db, secret: 'existing-session-root', audience: 'urn:wiki:test', now: () => instant })
})
afterEach(async () => {
  await db.destroy()
})

describe('standalone live note operation behavior', () => {
  it('allows empty-schema rollback but refuses to erase authoritative notes or history', async () => {
    await down(db)
    expect(await db.schema.hasTable('liveNotes')).toBe(false)
    await up(db)
    const created = await notes.create(owner, {})
    await expect(down(db)).rejects.toThrow('authoritative documents or history')
    expect((await notes.read(owner, created.key)).id).toBe(created.id)
    expect((await notes.history(owner, created.key)).items).toHaveLength(1)
  })

  it('keeps inventory owner-only with bounded cursors, private creation, and pathless permissions', async () => {
    const first = parseLiveNoteView(await notes.create(owner, { key: 'my-scratch' }))
    await notes.create(owner, {})
    const foreign = await notes.create(other, { key: 'another-person' })
    expect(first).toMatchObject({ ownerId: 7, access: 'private', title: '', revision: 0, canEdit: true, canManage: true })
    expect(text(first.state)).toBe('')
    const page = parseLiveNoteList(await notes.list(owner, { limit: 1 }))
    expect(page.items).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    const next = await notes.list(owner, { limit: 1, cursor: page.nextCursor })
    expect(next.items).toHaveLength(1)
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id)
    expect(next.hasMore).toBe(false)
    expect((await notes.list(manager, {})).items).toEqual([])
    expect((await notes.list(other, {})).items.map(item => item.key)).toEqual([foreign.key])
    // Bun's rejection matcher needs a native Promise, not the Knex transaction thenable.
    await expect(Promise.resolve(notes.read(other, first.key))).rejects.toMatchObject({ status: 404 })
    await expect(Promise.resolve(notes.read(owner, 'does-not-exist'))).rejects.toMatchObject({ status: 404 })
    await expect(notes.create(owner, { key: first.key })).rejects.toMatchObject({ status: 409 })
    for (const input of [{ ownerId: 8 }, { key: 'ab' }, { key: 'Admin' }, { key: 'session' }])
      await expect(notes.create(owner, input)).rejects.toMatchObject({ status: 400 })
    for (const permission of ['read:notes', 'write:notes'])
      expect(groupPermissions.find(item => item.key === permission)).toMatchObject({ pageScoped: false, tier: 'content' })
  })

  it('grants only current eligible shared readers and never guest or API-key writes', async () => {
    const note = await notes.create(owner, {})
    const shared = await notes.updateAccess(owner, note.key, { expectedRevision: 0, access: 'edit' })
    expect(await notes.read(guest, note.key)).toMatchObject({ canEdit: false, canManage: false })
    expect(await notes.read(other, note.key)).toMatchObject({ canEdit: true, canManage: false })
    const update = edit(shared.state, value => value.insert(0, '# Hello'))
    for (const requester of [guest, createApiPrincipal(12, 3, ['manage:system'])]) {
      await expect(notes.create(requester, {})).rejects.toMatchObject({ status: requester === guest ? 403 : 401 })
      await expect(notes.applyUpdate(requester, note.key, { update, requestId: 'guest-write' })).rejects.toMatchObject({
        status: requester === guest ? 404 : 401
      })
      await expect(notes.restore(requester, note.key, 0, { expectedRevision: 1 })).rejects.toMatchObject({ status: requester === guest ? 404 : 401 })
    }
    await expect(notes.updateAccess(other, note.key, { expectedRevision: 1, access: 'private' })).rejects.toMatchObject({ status: 404 })
    await db('groups').where('id', 2).update({ permissions: '["write:notes"]' })
    await expect(Promise.resolve(notes.read(guest, note.key))).rejects.toMatchObject({ status: 404 })
    expect((await notes.read(owner, note.key)).revision).toBe(1)
  })

  it('revokes issued sessions and historical access after policy, group, or account changes', async () => {
    const created = await notes.create(owner, {})
    await notes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'read' })
    const session = parseLiveNoteSession(await notes.session(other, created.key))
    expect(await notes.authorizeSession(session.token)).toMatchObject({ key: created.key, principal: { id: 8 } })
    await notes.updateAccess(owner, created.key, { expectedRevision: 1, access: 'private' })
    await expect(notes.authorizeSession(session.token)).rejects.toMatchObject({ status: 404 })
    await expect(notes.revision(other, created.key, 1)).rejects.toMatchObject({ status: 404 })
    await notes.updateAccess(owner, created.key, { expectedRevision: 2, access: 'read' })
    await db('users').where('id', 8).update({ authVersion: 1 })
    await expect(notes.authorizeSession(session.token)).rejects.toMatchObject({ status: 401 })
    await db('users').where('id', 8).update({ authVersion: 0, isActive: false })
    await expect(Promise.resolve(notes.read(other, created.key))).rejects.toMatchObject({ status: 401 })
    await db('users').where('id', 8).update({ isActive: true })
    await db('userGroups').where('userId', 8).delete()
    await expect(notes.authorizeSession(session.token)).rejects.toMatchObject({ status: 404 })
    await db('users').where('id', 7).delete()
    expect(await notes.read(manager, created.key)).toMatchObject({ ownerId: null, canManage: true })
    await expect(Promise.resolve(notes.read(owner, created.key))).rejects.toMatchObject({ status: 401 })
  })

  it('merges offline updates durably without reseeding and acknowledges retries idempotently', async () => {
    const created = await notes.create(owner, {})
    const base = await notes.applyUpdate(owner, created.key, { update: edit(created.state, value => value.insert(0, '# Base\n')), requestId: 'base' })
    const a = edit(base.state, value => value.insert(value.length, 'A'))
    const b = edit(base.state, value => value.insert(0, 'B'))
    await notes.applyUpdate(owner, created.key, { update: a, requestId: 'a' })
    const reopened = createLiveNotesStore({ db, secret: 'existing-session-root', audience: 'urn:wiki:test', now: () => instant })
    const merged = await reopened.applyUpdate(owner, created.key, { update: b, requestId: 'b' })
    expect(text(merged.state)).toBe('B# Base\nA')
    expect((await reopened.applyUpdate(owner, created.key, { update: a, requestId: 'a' })).revision).toBe(3)
    expect((await reopened.applyUpdate(owner, created.key, { update: a, requestId: 'different-request-same-update' })).revision).toBe(3)
    await expect(notes.applyUpdate(owner, created.key, { update: b, requestId: 'a' })).rejects.toMatchObject({ status: 409 })
    expect((await reopened.history(owner, created.key, {})).items.map(item => item.revision)).toEqual([3, 2, 1, 0])
  })

  it('persists out-of-order causal updates until their missing predecessor reconnects', async () => {
    const created = await notes.create(owner, {}),
      doc = new Y.Doc()
    const updates: Uint8Array[] = []
    doc.on('update', value => updates.push(value))
    doc.getText('content').insert(0, 'A')
    doc.getText('content').insert(1, 'B')
    await notes.applyUpdate(owner, created.key, { requestId: 'second', update: encodeCollaborationUpdate(updates[1]!) })
    const reopened = createLiveNotesStore({ db, secret: 'existing-session-root', audience: 'urn:wiki:test', now: () => instant })
    const completed = await reopened.applyUpdate(owner, created.key, { requestId: 'first', update: encodeCollaborationUpdate(updates[0]!) })
    expect(text(completed.state)).toBe('AB')
    doc.getText('content').delete(0, 1)
    const compacted = await reopened.applyUpdate(owner, created.key, { requestId: 'tombstones', update: encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc)) })
    expect(text(compacted.state)).toBe('B')
    expect(text((await reopened.restore(owner, created.key, 2, { expectedRevision: compacted.revision })).state)).toBe('AB')
    doc.destroy()
  })

  it('restores history through a new CRDT edit and rejects stale metadata or deletion', async () => {
    const created = await notes.create(owner, {})
    const first = await notes.applyUpdate(owner, created.key, { update: edit(created.state, value => value.insert(0, '# First\nBody')), requestId: 'first' })
    const second = await notes.applyUpdate(owner, created.key, {
      update: edit(first.state, value => {
        value.delete(0, value.length)
        value.insert(0, '# Second')
      }),
      requestId: 'second'
    })
    const staleOffline = edit(second.state, value => value.insert(value.length, '\nOffline'))
    const restored = await notes.restore(owner, created.key, 1, { expectedRevision: 2 })
    expect(restored).toMatchObject({ revision: 3, title: 'First' })
    expect(text(restored.state)).toBe('# First\nBody')
    expect(text((await notes.revision(owner, created.key, 2)).state)).toBe('# Second')
    const afterReconnect = await notes.applyUpdate(owner, created.key, { update: staleOffline, requestId: 'offline' })
    expect(text(afterReconnect.state)).toContain('# First\nBody')
    expect(text(afterReconnect.state)).not.toContain('# Second')
    await expect(notes.updateAccess(owner, created.key, { expectedRevision: 2, access: 'edit' })).rejects.toMatchObject({ status: 409 })
    await expect(notes.remove(owner, created.key, { expectedRevision: 2 })).rejects.toMatchObject({ status: 409 })
    await notes.lease(created.key, 'open-connection', new Date(instant.getTime() + 60_000))
    await notes.remove(owner, created.key, { expectedRevision: afterReconnect.revision })
    expect(await db('liveNoteConnections')).toEqual([])
    await expect(notes.lease(created.key, 'resurrect', new Date(instant.getTime() + 60_000))).rejects.toMatchObject({ status: 404 })
    await expect(Promise.resolve(notes.read(owner, created.key))).rejects.toMatchObject({ status: 404 })
  })

  it('sweeps only bounded never-edited old empty notes, respecting leases and touch time', async () => {
    const untouched = await notes.create(owner, {}),
      active = await notes.create(owner, {}),
      recent = await notes.create(owner, {}),
      cleared = await notes.create(owner, {})
    const filled = await notes.applyUpdate(owner, cleared.key, { requestId: 'fill', update: edit(cleared.state, value => value.insert(0, 'Keep my history')) })
    await notes.applyUpdate(owner, cleared.key, { requestId: 'clear', update: edit(filled.state, value => value.delete(0, value.length)) })
    instant = new Date(instant.getTime() + 25 * 60 * 60 * 1000)
    await notes.lease(active.key, 'active-room', new Date(instant.getTime() + 60_000))
    // Exercise the lease fence independently of the touch-time fence.
    await db('liveNotes')
      .where('id', active.id)
      .update({ touchedAt: new Date(instant.getTime() - 25 * 60 * 60 * 1000) })
    await notes.read(owner, recent.key)
    expect(await notes.sweepUntouched()).toBe(1)
    await expect(Promise.resolve(notes.read(owner, untouched.key))).rejects.toMatchObject({ status: 404 })
    expect(text((await notes.read(owner, cleared.key)).state)).toBe('')
    expect((await notes.history(owner, cleared.key)).items).toHaveLength(3)
    expect(await notes.read(owner, active.key)).toMatchObject({ id: active.id })
    expect(await notes.read(owner, recent.key)).toMatchObject({ id: recent.id })
    await notes.release('active-room')
    // Bounded candidate selection cannot become an unbounded data drain.
    for (let index = 0; index < 102; index++) await notes.create(owner, {})
    instant = new Date(instant.getTime() + 25 * 60 * 60 * 1000)
    expect(await notes.sweepUntouched()).toBe(100)
    expect((await notes.list(owner, { limit: 100 })).items.length).toBeGreaterThan(1)
  })

  it('keeps owner management dependent on current write authority', async () => {
    const created = await notes.create(owner, {})
    await db('groups').where('id', 3).update({ permissions: '["read:notes"]' })
    expect(await notes.read(owner, created.key)).toMatchObject({ canEdit: false, canManage: false })
    await expect(notes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' })).rejects.toMatchObject({ status: 404 })
    await expect(notes.remove(owner, created.key, { expectedRevision: 0 })).rejects.toMatchObject({ status: 404 })
    await expect(notes.restore(owner, created.key, 0, { expectedRevision: 0 })).rejects.toMatchObject({ status: 404 })
  })

  it('enforces the canonical UTF-8 source limit without truncation or partial persistence', async () => {
    let current = await notes.create(owner, {})
    // Each update is below 64KiB, while the accumulated UTF-8 source exceeds 1MiB.
    for (let index = 0; index < 17; index++)
      current = await notes.applyUpdate(owner, current.key, {
        requestId: `chunk-${index}`,
        update: edit(current.state, value => value.insert(value.length, 'é'.repeat(30_000)))
      })
    expect(Buffer.byteLength(text(current.state), 'utf8')).toBe(1_020_000)
    await expect(
      notes.applyUpdate(owner, current.key, {
        requestId: 'overflow',
        update: edit(current.state, value => value.insert(value.length, 'é'.repeat(30_000)))
      })
    ).rejects.toMatchObject({ status: 413 })
    const durable = await notes.read(owner, current.key)
    expect(durable.revision).toBe(17)
    expect(Buffer.byteLength(text(durable.state), 'utf8')).toBe(1_020_000)
  })

  it('rejects rich, embedded, nested, map, and unknown-root updates without durable side effects', async () => {
    const unsupported: Array<[string, (doc: Y.Doc) => void]> = [
      [
        'attributes',
        doc => {
          const value = doc.getText('content')
          value.insert(0, 'x'.repeat(200))
          for (let index = 0; index < 200; index++) value.format(index, 200 - index, { [`attribute-${index}`]: true })
        }
      ],
      [
        'object-embed',
        doc => {
          doc.getText('content').insertEmbed(0, { image: '/asset.png' })
        }
      ],
      [
        'binary-embed',
        doc => {
          doc.getText('content').insertEmbed(0, new Uint8Array([1, 2]))
        }
      ],
      [
        'nested-type',
        doc => {
          doc.getArray('content').insert(0, [new Y.Text('nested')])
        }
      ],
      [
        'map-value',
        doc => {
          doc.getMap('content').set('field', 'not canonical text')
        }
      ],
      [
        'unknown-root',
        doc => {
          doc.getText('other').insert(0, 'hidden')
        }
      ]
    ]
    for (const [requestId, change] of unsupported) {
      const created = await notes.create(owner, {}),
        doc = new Y.Doc()
      let update: string
      try {
        change(doc)
        update = encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc))
      } finally {
        doc.destroy()
      }
      const before = await db('liveNotes').where('id', created.id).first()
      const revisions = await db('liveNoteRevisions').where('noteId', created.id)
      await expect(notes.applyUpdate(owner, created.key, { requestId, update })).rejects.toMatchObject({ status: 400 })
      expect(await db('liveNotes').where('id', created.id).first()).toEqual(before)
      expect(await db('liveNoteRevisions').where('noteId', created.id)).toEqual(revisions)
      expect(await db('liveNoteRequests').where('noteId', created.id)).toEqual([])
    }
  })

  it('refuses pending formatting before its dependency arrives and leaves the request ID reusable', async () => {
    const created = await notes.create(owner, {}),
      doc = new Y.Doc(),
      updates: Uint8Array[] = []
    try {
      doc.on('update', update => updates.push(update))
      doc.getText('content').insert(0, 'plain')
      doc.getText('content').format(0, 5, { bold: true })
      const before = await db('liveNotes').where('id', created.id).first()
      await expect(notes.applyUpdate(owner, created.key, { requestId: 'pending', update: encodeCollaborationUpdate(updates[1]!) })).rejects.toMatchObject({
        status: 400
      })
      expect(await db('liveNotes').where('id', created.id).first()).toEqual(before)
      expect(await db('liveNoteRevisions').where('noteId', created.id)).toHaveLength(1)
      expect(await db('liveNoteRequests').where('noteId', created.id)).toEqual([])
      const reconnected = createLiveNotesStore({ db, secret: 'existing-session-root', audience: 'urn:wiki:test', now: () => instant })
      const accepted = await reconnected.applyUpdate(owner, created.key, { requestId: 'pending', update: encodeCollaborationUpdate(updates[0]!) })
      expect(accepted.revision).toBe(1)
      expect(text(accepted.state)).toBe('plain')
      await expect(
        reconnected.applyUpdate(owner, created.key, { requestId: 'format-after-dependency', update: encodeCollaborationUpdate(updates[1]!) })
      ).rejects.toMatchObject({ status: 400 })
      expect((await reconnected.read(owner, created.key)).state).toBe(accepted.state)
      expect(await db('liveNoteRequests').where('noteId', created.id)).toHaveLength(1)
    } finally {
      doc.destroy()
    }
  })

  it('refuses unsupported persisted current and historical states, including pending formatting', async () => {
    for (const pending of [false, true]) {
      const doc = new Y.Doc(),
        updates: Uint8Array[] = []
      let poisoned: string
      try {
        doc.on('update', update => updates.push(update))
        doc.getText('content').insert(0, 'unsafe')
        doc.getText('content').format(0, 6, { bold: true })
        poisoned = encodeCollaborationUpdate(pending ? updates[1]! : Y.encodeStateAsUpdate(doc))
      } finally {
        doc.destroy()
      }
      const created = await notes.create(owner, {})
      await db('liveNotes').where('id', created.id).update({ state: poisoned })
      const before = await db('liveNotes').where('id', created.id).first()
      await expect(Promise.resolve(notes.read(owner, created.key))).rejects.toMatchObject({ status: 400 })
      await expect(
        notes.applyUpdate(owner, created.key, { requestId: 'stored', update: edit(created.state, value => value.insert(0, 'safe')) })
      ).rejects.toMatchObject({ status: 400 })
      await expect(notes.restore(owner, created.key, 0, { expectedRevision: 0 })).rejects.toMatchObject({ status: 400 })
      expect(await db('liveNotes').where('id', created.id).first()).toEqual(before)
      expect(await db('liveNoteRevisions').where('noteId', created.id)).toHaveLength(1)
      expect(await db('liveNoteRequests').where('noteId', created.id)).toEqual([])
      await db('liveNotes').where('id', created.id).update({ state: created.state })
      await db('liveNoteRevisions').where({ noteId: created.id, revision: 0 }).update({ state: poisoned })
      const safe = await db('liveNotes').where('id', created.id).first()
      const revisions = await db('liveNoteRevisions').where('noteId', created.id)
      await expect(notes.revision(owner, created.key, 0)).rejects.toMatchObject({ status: 400 })
      await expect(notes.restore(owner, created.key, 0, { expectedRevision: 0 })).rejects.toMatchObject({ status: 400 })
      expect(await db('liveNotes').where('id', created.id).first()).toEqual(safe)
      expect(await db('liveNoteRevisions').where('noteId', created.id)).toEqual(revisions)
      expect(await db('liveNoteRequests').where('noteId', created.id)).toEqual([])
    }
  })

  it('derives bounded Markdown titles from long lines without losing canonical content', async () => {
    const cases = [
      { source: `# x${' '.repeat(2500)}y`, title: `x${' '.repeat(199)}` },
      { source: '\n \t\nIntro\n   # Heading ### \t\nBody', title: 'Heading' },
      { source: '# C#\nBody', title: 'C#' },
      { source: `\n${'fallback'.repeat(1000)}\n## Not H1`, title: 'fallback'.repeat(29).slice(0, 200) },
      { source: '# \t\nBody', title: '#' },
      { source: '# \u0000Clean\u007f title ###', title: 'Clean title' }
    ]
    for (const item of cases) {
      const created = await notes.create(owner, {})
      const updated = await notes.applyUpdate(owner, created.key, { requestId: 'title', update: edit(created.state, value => value.insert(0, item.source)) })
      expect(updated.title).toBe(item.title)
      expect(text(updated.state)).toBe(item.source)
      expect((await notes.revision(owner, created.key, 1)).title).toBe(item.title)
    }
  })

  it('checks decoded update bytes, strict wire fields, token expiry, and retained page/assets', async () => {
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.text('content')
    })
    await db.schema.createTable('assets', table => {
      table.integer('id').primary()
      table.text('path')
    })
    await db('pages').insert({ id: 100, content: 'Untouched wiki page' })
    await db('assets').insert({ id: 200, path: '/canonical/file.png' })
    const created = await notes.create(owner, {}),
      session = await notes.session(owner, created.key)
    const valid = edit(created.state, value => value.insert(0, 'x'.repeat(50_000)))
    expect(valid.length).toBeGreaterThan(LIVE_NOTE_MAX_UPDATE_BYTES)
    expect((await notes.applyUpdate(owner, created.key, { requestId: 'decoded-bytes', update: valid })).revision).toBe(1)
    await expect(
      notes.applyUpdate(owner, created.key, { requestId: 'too-large', update: encodeCollaborationUpdate(new Uint8Array(LIVE_NOTE_MAX_UPDATE_BYTES + 1)) })
    ).rejects.toMatchObject({ status: 400 })
    expect(() => parseLiveNoteClientMessage({ type: 'update', requestId: 'id', update: valid, ownerId: 9 })).toThrow()
    expect(() => parseLiveNoteView({ ...created, revision: Infinity })).toThrow()
    expect(() => parseLiveNoteView({ ...created, source: 'noncanonical duplicate' })).toThrow()
    instant = new Date(instant.getTime() + 300_000)
    await expect(notes.authorizeSession(session.token)).rejects.toMatchObject({ status: 401 })
    await notes.remove(owner, created.key, { expectedRevision: 1 })
    expect(await db('pages')).toEqual([{ id: 100, content: 'Untouched wiki page' }])
    expect(await db('assets')).toEqual([{ id: 200, path: '/canonical/file.png' }])
  })
})

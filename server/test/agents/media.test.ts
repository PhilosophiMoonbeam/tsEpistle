import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { createAgentMediaTestDatabase } from './media-database.ts'
import { beforeEach, afterEach, describe, expect, it } from '../bun-test.mts'
import { up, down } from '../../db/migrations/tsepistle-000044-agent-media.ts'
import {
  AGENT_MEDIA_MAX_BYTES,
  assertAgentMediaCapability,
  bindAgentMedia,
  getOwnedAgentMedia,
  mediaFilename,
  projectAgentMedia,
  storeAgentMedia,
  validateAgentMedia
} from '../../agents/media.ts'

const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
  .png()
  .toBuffer()
const sessionId = randomUUID()
const secondSessionId = randomUUID()
const messageId = randomUUID()
const runId = randomUUID()
describe('private Agent media', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  beforeEach(async () => {
    ;({ db, destroy: destroyDatabase } = await createAgentMediaTestDatabase())
    if (db.client.config.client !== 'pg') await db.raw('PRAGMA foreign_keys = ON')
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db.schema.createTable('agentSessions', table => {
      table.uuid('id').primary()
      table.integer('ownerId')
      table.string('retention').defaultTo('saved')
      table.string('executionMode').defaultTo('agent')
      table.dateTime('deletedAt').nullable()
      table.dateTime('createdAt')
      table.dateTime('updatedAt')
      table.dateTime('lastActivityAt')
      table.dateTime('expiresAt').nullable()
    })
    for (const id of [sessionId, secondSessionId])
      await db('agentSessions').insert({
        id,
        ownerId: 7,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastActivityAt: new Date(),
        expiresAt: null,
        deletedAt: null
      })
    await db.schema.createTable('agentMessages', table => table.uuid('id').primary())
    await db('agentMessages').insert({ id: messageId })
    await db.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('assistantMessageId')
      table.uuid('sessionId')
      table.integer('ownerId')
      table.string('status')
      table.boolean('sideEffectsStarted').defaultTo(false)
      table.dateTime('cancelRequestedAt').nullable()
      table.string('leaseOwner')
      table.uuid('leaseToken')
    })
    await db('agentRuns').insert({
      id: runId,
      sessionId,
      assistantMessageId: messageId,
      ownerId: 7,
      status: 'running',
      cancelRequestedAt: null,
      leaseOwner: 'worker',
      leaseToken: runId
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.string('transportKind')
      table.string('baseUrl')
      table.text('adapterConfig')
    })
    await up(db)
  })
  afterEach(async () => {
    await destroyDatabase()
  })
  const upload = () => storeAgentMedia(db, { ownerId: 7, sessionId, payload: png, mimeType: 'image/png', filename: '../photo.png' })
  it('validates byte signatures, rejects active formats and oversized files', () => {
    expect(validateAgentMedia(png, 'image/png')).toBe('image/png')
    expect(() => validateAgentMedia(Buffer.from('<svg/>'), 'image/svg+xml')).toThrow()
    expect(() => validateAgentMedia(Buffer.from('<html>'), 'image/png')).toThrow()
    expect(() => validateAgentMedia(Buffer.alloc(AGENT_MEDIA_MAX_BYTES + 1), 'application/pdf')).toThrow()
    expect(validateAgentMedia(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe('application/pdf')
    expect(mediaFilename('a/\nb.png')).toBe('a__b.png')
  })
  it('keeps bytes private to the session owner and omits payload/provider handles from projections', async () => {
    const media = await upload()
    expect((await getOwnedAgentMedia(db, 7, media.id)).payload).toEqual(png)
    await expect(getOwnedAgentMedia(db, 8, media.id)).rejects.toMatchObject({ status: 404 })
    expect(Object.keys(projectAgentMedia(media)).sort()).toEqual(['available', 'byteLength', 'filename', 'id', 'kind', 'mimeType'])
    await db('agentSessions').where({ id: sessionId }).update({ deletedAt: new Date() })
    await expect(getOwnedAgentMedia(db, 7, media.id)).rejects.toMatchObject({ status: 404 })
  })
  it('binds only unexpired owner/session attachments once and preserves sent files', async () => {
    const media = await upload()
    const bind = async (ownerId = 7, target = sessionId) =>
      db.transaction(tx => bindAgentMedia(tx, { ownerId, sessionId: target, attachmentIds: [media.id], messageId, runId }))
    await expect(bind(8)).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await expect(bind(7, secondSessionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await bind()
    expect(await db('agentMedia').where({ id: media.id }).first('messageId', 'expiresAt')).toEqual({ messageId, expiresAt: null })
    await expect(bind()).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await expect(down(db)).rejects.toThrow('Cannot discard')
    await db('agentSessions').where({ id: sessionId }).delete()
    expect(await db('agentMedia').first()).toBeUndefined()
    await down(db)
    expect(await db.schema.hasTable('agentMedia')).toBe(false)
    expect(await db.schema.hasColumn('agentRuns', 'mediaRequest')).toBe(false)
  })
  it('rolls back earlier binds if a later attachment fails', async () => {
    const media = await upload()
    await expect(
      (async () => await db.transaction(tx => bindAgentMedia(tx, { ownerId: 7, sessionId, attachmentIds: [media.id, randomUUID()], messageId, runId })))()
    ).rejects.toThrow()
    expect((await db('agentMedia').where({ id: media.id }).first()).messageId).toBeNull()
  })
  it('bounds owner storage and removes expired unbound uploads before admission', async () => {
    const media = await upload()
    await db('agentMedia')
      .where({ id: media.id })
      .update({ byteLength: 100 * 1024 * 1024 })
    await expect(upload()).rejects.toMatchObject({ code: 'AGENT_MEDIA_QUOTA' })
    await db('agentMedia')
      .where({ id: media.id })
      .update({ expiresAt: new Date(Date.now() - 1) })
    await upload()
    expect(await db('agentMedia').where({ id: media.id }).first()).toBeUndefined()
  })
  it('rejects stale generated-output leases and cancellation', async () => {
    const input = {
      ownerId: 7,
      sessionId,
      payload: png,
      mimeType: 'image/png',
      filename: 'generated.png',
      kind: 'generated-image' as const,
      messageId,
      runId,
      leaseOwner: 'worker',
      leaseToken: randomUUID()
    }
    await expect(storeAgentMedia(db, input)).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    await db('agentRuns').where({ id: runId }).update({ cancelRequestedAt: new Date() })
    await expect(storeAgentMedia(db, { ...input, leaseToken: runId })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    expect(await db('agentMedia').first()).toBeUndefined()
  })
  it('rejects modified saved attachment bytes before serving them', async () => {
    const media = await upload()
    await db('agentMedia')
      .where({ id: media.id })
      .update({ payload: Buffer.from('changed') })
    await expect(getOwnedAgentMedia(db, 7, media.id)).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
  })
  it('requires explicit official Gemini capability configuration', async () => {
    const id = randomUUID()
    const adapterConfig = { timeoutMs: 30000, maxRetries: 0, media: { attachments: true } }
    await db('agentProviderProfileVersions').insert({
      id,
      transportKind: 'gemini-api',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      adapterConfig: JSON.stringify(adapterConfig)
    })
    await assertAgentMediaCapability(db, id, 'attachments')
    await expect(assertAgentMediaCapability(db, id, 'transcription')).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
    await db('agentProviderProfileVersions').where({ id }).update({ baseUrl: 'https://example.test/v1beta' })
    await expect(assertAgentMediaCapability(db, id, 'attachments')).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
  })
})

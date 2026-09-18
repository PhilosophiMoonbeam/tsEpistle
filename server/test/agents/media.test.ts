import sharp from 'sharp'
import { AGENT_GENERATED_VIDEO_MAX_BYTES, AGENT_GENERATED_AUDIO_MAX_BYTES } from '../../../shared/agents/media-limits.ts'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { createAgentMediaTestDatabase } from './media-database.ts'
import { beforeEach, afterEach, describe, expect, it } from '../bun-test.mts'
import { up, down } from '../../db/migrations/tsepistle-000044-agent-media.ts'
import {
  AGENT_MEDIA_MAX_BYTES,
  AGENT_MEDIA_OWNER_MAX_BYTES,
  AGENT_MEDIA_GLOBAL_MAX_BYTES,
  getOwnedAgentMediaMetadata,
  ownedAgentMediaSource,
  stageOwnedAgentMedia,
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
    const large = Buffer.alloc(11 * 1024 * 1024)
    large.write('%PDF-1.7')
    expect(validateAgentMedia(large, 'application/pdf')).toBe('application/pdf')
    expect(() => validateAgentMedia(large, 'image/png')).toThrow()
    expect(mediaFilename('a/\nb.png')).toBe('a__b.png')
  })
  ;(process.env.WIKI_AGENT_LARGE_PDF_PROOF === '1' ? it : it.skip)('stores a full 250 MiB original in PostgreSQL for the isolated memory admission proof', async () => {
    expect(db.client.config.client).toBe('pg')
    const payload = Buffer.alloc(AGENT_MEDIA_MAX_BYTES, 32)
    payload.write('%PDF-1.7')
    const media = await storeAgentMedia(db, { ownerId: 7, sessionId, payload, mimeType: 'application/pdf', filename: '250mb.pdf' })
    expect(Number((await getOwnedAgentMediaMetadata(db, 7, media.id)).byteLength)).toBe(250 * 1024 * 1024)
    expect(media.sha256).toHaveLength(64)
  }, 120_000)
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
      .update({ byteLength: AGENT_MEDIA_OWNER_MAX_BYTES })
    await expect(upload()).rejects.toMatchObject({ code: 'AGENT_MEDIA_QUOTA' })
    await db('agentMedia')
      .where({ id: media.id })
      .update({ expiresAt: new Date(Date.now() - 1) })
    await upload()
    expect(await db('agentMedia').where({ id: media.id }).first()).toBeUndefined()
  })
  it('enforces global storage across owners while retaining the per-owner file-count bound', async () => {
    const media = await upload()
    await db('agentMedia').where({ id: media.id }).delete()
    for (let index = 0; index < 10; index++) await db('agentMedia').insert({ ...media, id: randomUUID(), ownerId: 8, byteLength: AGENT_MEDIA_GLOBAL_MAX_BYTES / 10, createdAt: new Date(), metadata: '{}' })
    await expect(upload()).rejects.toMatchObject({ code: 'AGENT_MEDIA_QUOTA' })
    await db('agentMedia').delete()
    const row = await upload()
    for (let index = 1; index < 200; index++) await db('agentMedia').insert({ ...row, id: randomUUID(), createdAt: new Date(), metadata: '{}' })
    await expect(upload()).rejects.toMatchObject({ code: 'AGENT_MEDIA_QUOTA' })
  })
  it('admits only one of two owners competing for the final global storage bytes', async () => {
    const seed = await upload()
    await db('agentMedia').delete()
    await db('users').insert({ id: 9 })
    await db('agentSessions').where({ id: secondSessionId }).update({ ownerId: 9 })
    for (let index = 0; index < 10; index++) await db('agentMedia').insert({ ...seed, id: randomUUID(), ownerId: 8, byteLength: AGENT_MEDIA_GLOBAL_MAX_BYTES / 10 - (index === 0 ? png.length : 0), createdAt: new Date(), metadata: '{}' })
    const results = await Promise.allSettled([
      upload(),
      storeAgentMedia(db, { ownerId: 9, sessionId: secondSessionId, payload: png, mimeType: 'image/png', filename: 'other.png' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['AGENT_MEDIA_QUOTA'])
    const usage = await db('agentMedia').sum('byteLength as bytes').first()
    expect(Number(usage?.bytes)).toBe(AGENT_MEDIA_GLOBAL_MAX_BYTES)
  })
  it('keeps a PDF larger than the former 40 MiB window lazy and stages it in integrity-checked bounded chunks', async () => {
    const payload = Buffer.alloc(41 * 1024 * 1024, 32)
    payload.write('%PDF-1.7')
    const row = await storeAgentMedia(db, { ownerId: 7, sessionId, payload, mimeType: 'application/pdf', filename: 'large.pdf' })
    const metadata = await getOwnedAgentMediaMetadata(db, 7, row.id)
    expect('payload' in metadata).toBe(false)
    const lazy = ownedAgentMediaSource(db, 7, sessionId, metadata)
    expect(lazy.payload).toBeUndefined()
    expect(lazy.preparePdf).toBeTypeOf('function')
    const queries: string[] = []
    const record = (query: { sql: string }) => queries.push(query.sql)
    db.on('query', record)
    const staged = await stageOwnedAgentMedia(db, 7, row.id, new AbortController().signal)
    db.off('query', record)
    try {
      expect(await readFile(staged.path)).toEqual(payload)
      expect(queries.filter(sql => /substr(?:ing)?\(/.test(sql))).toHaveLength(41)
      expect(queries.some(sql => /select \*/.test(sql) && sql.includes('agentMedia'))).toBe(false)
      expect((await stat(staged.path)).mode & 0o777).toBe(0o600)
    } finally { await staged.cleanup() }
    await expect(stageOwnedAgentMedia(db, 8, row.id, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
    await db('agentMedia').where({ id: row.id }).update({ sha256: '0'.repeat(64) })
    await expect(stageOwnedAgentMedia(db, 7, row.id, new AbortController().signal)).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
  })
  it('reauthorizes lazy small-file reads and refuses altered content after descriptor creation', async () => {
    const row = await upload()
    const source = ownedAgentMediaSource(db, 7, sessionId, await getOwnedAgentMediaMetadata(db, 7, row.id))
    expect(await source.loadPayload!(new AbortController().signal)).toEqual(png)
    await db('agentSessions').where({ id: sessionId }).update({ deletedAt: new Date() })
    await expect(source.loadPayload!(new AbortController().signal)).rejects.toMatchObject({ status: 404 })
  })
  it.each(['generated-video', 'generated-audio'] as const)('stores %s only with a live run lease, expected MIME, signature, and generated size limit', async kind => {
    const video = kind === 'generated-video'
    const payload = Buffer.from(video ? '\0\0\0\x18ftypisom0000000000000000' : 'ID3generated music bytes')
    const input = { ownerId: 7, sessionId, payload, mimeType: video ? 'video/mp4' : 'audio/mpeg', filename: video ? 'clip.mp4' : 'song.mp3', kind, messageId, runId, leaseOwner: 'worker', leaseToken: runId }
    await expect(storeAgentMedia(db, { ...input, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    await expect(storeAgentMedia(db, { ...input, mimeType: 'text/html' })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(storeAgentMedia(db, { ...input, payload: Buffer.from('not playable media') })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    const oversized = Buffer.alloc((video ? AGENT_GENERATED_VIDEO_MAX_BYTES : AGENT_GENERATED_AUDIO_MAX_BYTES) + 1)
    payload.copy(oversized)
    await expect(storeAgentMedia(db, { ...input, payload: oversized })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    const stored = await storeAgentMedia(db, input)
    expect(stored.kind).toBe(kind)
    expect(stored.expiresAt).toBeNull()
    expect((await getOwnedAgentMedia(db, 7, stored.id)).payload).toEqual(payload)
    await expect(getOwnedAgentMedia(db, 8, stored.id)).rejects.toMatchObject({ status: 404 })
    expect((await db('agentRuns').where({ id: runId }).first('sideEffectsStarted')).sideEffectsStarted).toBeTruthy()
    expect(() => validateAgentMedia(payload, 'video/mp4')).toThrow()
    await db('agentSessions').where({ id: sessionId }).delete()
    expect(await db('agentMedia').where({ id: stored.id }).first()).toBeUndefined()
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

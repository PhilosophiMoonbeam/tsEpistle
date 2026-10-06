import sharp from 'sharp'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_GENERATED_VIDEO_MAX_BYTES, AGENT_GENERATED_AUDIO_MAX_BYTES } from '../../../shared/agents/media-limits.ts'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { createAgentMediaTestDatabase } from './media-database.ts'
import { beforeEach, afterEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up, down } from '../../db/migrations/tsepistle-000044-agent-media.ts'
import { up as upMediaContextState } from '../../db/migrations/tsepistle-000047-agent-media-context-state.ts'
import {
  AGENT_MEDIA_MAX_BYTES,
  AGENT_MEDIA_OWNER_MAX_BYTES,
  AGENT_MEDIA_GLOBAL_MAX_BYTES,
  getOwnedAgentMediaMetadata,
  ownedAgentMediaSource,
  stageOwnedAgentMedia,
  bindAgentMedia,
  getOwnedAgentMedia,
  mediaFilename,
  projectAgentMedia,
  storeAgentMedia,
  validateAgentMedia
} from '../../agents/media.ts'

const postgresConnection = process.env.WIKI_AGENT_MEDIA_POSTGRES === '1' ? getPostgresTestConnection('_agents_test', import.meta.path) : null

const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
  .png()
  .toBuffer()
const sessionId = randomUUID()
const secondSessionId = randomUUID()
const messageId = randomUUID()
const runId = randomUUID()
const playableGeneratedMedia = async (video: boolean): Promise<Buffer> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-media-storage-test-'))
  try {
    const path = join(directory, video ? 'clip.mp4' : 'song.mp3')
    const child = spawnSync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        video ? 'color=c=blue:s=16x16:r=4:d=0.5' : 'sine=frequency=440:sample_rate=16000:duration=0.5',
        '-threads',
        '1',
        ...(video ? ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] : ['-c:a', 'libmp3lame', '-b:a', '32k']),
        path
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
    )
    if (child.error || child.status !== 0) throw new Error(`Cannot create playable storage fixture: ${child.error?.message ?? child.stderr.toString()}`)
    return await readFile(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
describe('private Agent media', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  beforeEach(async () => {
    ;({ db, destroy: destroyDatabase } = await createAgentMediaTestDatabase(postgresConnection))
    if (db.client.config.client !== 'pg') await db.raw('PRAGMA foreign_keys = ON')
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db.schema.createTable('agentSessions', table => {
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
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
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
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
    await up(db)
    await upMediaContextState(db)
  })
  afterEach(async () => {
    await destroyDatabase()
  })
  const upload = () => storeAgentMedia(db, { ownerId: 7, sessionId, payload: png, mimeType: 'image/png', filename: '../photo.png' })
  it('validates byte signatures, rejects active formats and oversized files', () => {
    expect(validateAgentMedia(png, 'image/png')).toBe('image/png')
    expect(() => validateAgentMedia(Buffer.from('<svg/>'), 'image/svg+xml')).toThrow()
    expect(() => validateAgentMedia(Buffer.from('<html>'), 'image/png')).toThrow()
    const oversizedPdf = Buffer.alloc(AGENT_MEDIA_MAX_BYTES + 1)
    oversizedPdf.write('%PDF-1.7')
    expect(() => validateAgentMedia(oversizedPdf, 'application/pdf')).toThrow()
    const large = Buffer.alloc(11 * 1024 * 1024)
    large.write('%PDF-1.7')
    expect(validateAgentMedia(large, 'application/pdf')).toBe('application/pdf')
    const oversizedPng = Buffer.alloc(11 * 1024 * 1024)
    png.copy(oversizedPng)
    expect(() => validateAgentMedia(oversizedPng, 'image/png')).toThrow()
    expect(mediaFilename('a/\nb.png')).toBe('a__b.png')
  })
  ;(process.env.WIKI_AGENT_LARGE_PDF_PROOF === '1' ? it : it.skip)(
    'stores a full 250 MiB original in PostgreSQL for the isolated memory admission proof',
    async () => {
      expect(db.client.config.client).toBe('pg')
      const payload = Buffer.alloc(AGENT_MEDIA_MAX_BYTES, 32)
      payload.write('%PDF-1.7')
      const expectedSha256 = createHash('sha256').update(payload).digest('hex')
      const media = await storeAgentMedia(db, { ownerId: 7, sessionId, payload, mimeType: 'application/pdf', filename: '250mb.pdf' })
      expect(Number((await getOwnedAgentMediaMetadata(db, 7, media.id)).byteLength)).toBe(250 * 1024 * 1024)
      expect(media.sha256).toBe(expectedSha256)
      const stored = await db('agentMedia')
        .where({ id: media.id })
        .first(db.raw('octet_length(??) as ??', ['payload', 'storedBytes']))
      expect(Number(stored.storedBytes)).toBe(payload.length)
    },
    120_000
  )
  it('keeps bytes private to the session owner and omits payload/provider handles from projections', async () => {
    const media = await upload()
    expect((await getOwnedAgentMedia(db, 7, media.id)).payload).toEqual(png)
    await expect(getOwnedAgentMedia(db, 8, media.id)).rejects.toMatchObject({ status: 404 })
    expect(Object.keys(projectAgentMedia(media)).sort()).toEqual(['available', 'byteLength', 'detached', 'filename', 'id', 'kind', 'mimeType'])
    await db('agentSessions').where({ id: sessionId }).update({ deletedAt: new Date() })
    await expect(getOwnedAgentMedia(db, 7, media.id)).rejects.toMatchObject({ status: 404 })
  })
  it('binds only unexpired owner/session attachments once and preserves sent files', async () => {
    const media = await upload()
    const bind = async (ownerId = 7, target = sessionId) =>
      db.transaction(tx => bindAgentMedia(tx, { ownerId, sessionId: target, attachmentIds: [media.id], messageId, runId }))
    await expect(bind(8)).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await expect(bind(7, secondSessionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await db('agentMedia')
      .where({ id: media.id })
      .update({ expiresAt: new Date(Date.now() - 60_000) })
    await expect(bind()).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await db('agentMedia')
      .where({ id: media.id })
      .update({ expiresAt: new Date(Date.now() + 3600_000) })
    await bind()
    expect(await db('agentMedia').where({ id: media.id }).first('messageId', 'expiresAt')).toEqual({ messageId, expiresAt: null })
    await expect(bind()).rejects.toMatchObject({ code: 'AGENT_MEDIA_UNAVAILABLE' })
    await expect(down(db)).rejects.toThrow()
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
    await db('agentMedia').where({ id: media.id }).update({ byteLength: AGENT_MEDIA_OWNER_MAX_BYTES })
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
    for (let index = 0; index < 10; index++)
      await db('agentMedia').insert({
        ...media,
        id: randomUUID(),
        ownerId: 8,
        byteLength: AGENT_MEDIA_GLOBAL_MAX_BYTES / 10,
        createdAt: new Date(),
        metadata: '{}'
      })
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
    for (let index = 0; index < 10; index++)
      await db('agentMedia').insert({
        ...seed,
        id: randomUUID(),
        ownerId: 8,
        byteLength: AGENT_MEDIA_GLOBAL_MAX_BYTES / 10 - (index === 0 ? png.length : 0),
        createdAt: new Date(),
        metadata: '{}'
      })
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
    const queries: { sql: string; bindings: readonly unknown[] }[] = []
    const record = (query: { sql: string; bindings: readonly unknown[] }) => queries.push(query)
    db.on('query', record)
    const staged = await stageOwnedAgentMedia(db, 7, row.id, new AbortController().signal)
    db.off('query', record)
    try {
      expect(await readFile(staged.path)).toEqual(payload)
      let nextByte = 1
      for (const query of queries.filter(query => /substr(?:ing)?\(/.test(query.sql))) {
        const offset = Number(query.bindings[0])
        const length = Number(query.bindings[1])
        expect(offset).toBe(nextByte)
        expect(Number.isSafeInteger(length)).toBe(true)
        expect(length).toBeGreaterThan(0)
        expect(length).toBeLessThanOrEqual(AGENT_ATTACHMENT_MAX_BYTES)
        nextByte += length
      }
      expect(nextByte - 1).toBe(payload.length)
      expect(queries.some(query => /select \*/.test(query.sql) && query.sql.includes('agentMedia'))).toBe(false)
      expect((await stat(staged.path)).mode & 0o777).toBe(0o600)
    } finally {
      await staged.cleanup()
    }
    await expect(stageOwnedAgentMedia(db, 8, row.id, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
    await db('agentMedia')
      .where({ id: row.id })
      .update({ sha256: '0'.repeat(64) })
    await expect(stageOwnedAgentMedia(db, 7, row.id, new AbortController().signal)).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
  })
  it('reauthorizes lazy small-file reads and refuses altered content after descriptor creation', async () => {
    const row = await upload()
    const source = ownedAgentMediaSource(db, 7, sessionId, await getOwnedAgentMediaMetadata(db, 7, row.id))
    expect(await source.loadPayload!(new AbortController().signal)).toEqual(png)
    const replacement = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    await db('agentMedia')
      .where({ id: row.id })
      .update({
        payload: replacement,
        byteLength: replacement.length,
        sha256: createHash('sha256').update(replacement).digest('hex')
      })
    await expect(source.loadPayload!(new AbortController().signal)).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
    await db('agentMedia').where({ id: row.id }).update({ payload: row.payload, byteLength: row.byteLength, sha256: row.sha256 })
    await db('agentSessions').where({ id: sessionId }).update({ deletedAt: new Date() })
    await expect(source.loadPayload!(new AbortController().signal)).rejects.toMatchObject({ status: 404 })
  })
  it.each(['generated-video', 'generated-audio'] as const)('stores fully decoded %s only with owner permission and a live run lease', async kind => {
    const video = kind === 'generated-video'
    const payload = await playableGeneratedMedia(video)
    const input = {
      ownerId: 7,
      sessionId,
      payload,
      mimeType: video ? 'video/mp4' : 'audio/mpeg',
      filename: video ? 'clip.mp4' : 'song.mp3',
      kind,
      messageId,
      runId,
      leaseOwner: 'worker',
      leaseToken: runId
    }
    await expect(storeAgentMedia(db, { ...input, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    await expect(storeAgentMedia(db, { ...input, ownerId: 8 })).rejects.toMatchObject({ status: 404 })
    await expect(storeAgentMedia(db, { ...input, mimeType: 'text/html' })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(storeAgentMedia(db, { ...input, payload: Buffer.from('not playable media') })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(storeAgentMedia(db, { ...input, payload: payload.subarray(0, 12) })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    const oversized = Buffer.alloc((video ? AGENT_GENERATED_VIDEO_MAX_BYTES : AGENT_GENERATED_AUDIO_MAX_BYTES) + 1)
    payload.copy(oversized)
    await expect(storeAgentMedia(db, { ...input, payload: oversized })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await db('agentRuns').where({ id: runId }).update({ cancelRequestedAt: new Date() })
    await expect(storeAgentMedia(db, input)).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    expect(await db('agentMedia').first()).toBeUndefined()
    expect((await db('agentRuns').where({ id: runId }).first('sideEffectsStarted')).sideEffectsStarted).toBeFalsy()
    await db('agentRuns').where({ id: runId }).update({ cancelRequestedAt: null })
    const stored = await storeAgentMedia(db, input)
    expect(stored.kind).toBe(kind)
    expect(stored.expiresAt).toBeNull()
    expect((await getOwnedAgentMedia(db, 7, stored.id)).payload).toEqual(payload)
    await expect(getOwnedAgentMedia(db, 8, stored.id)).rejects.toMatchObject({ status: 404 })
    expect((await db('agentRuns').where({ id: runId }).first('sideEffectsStarted')).sideEffectsStarted).toBeTruthy()
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
})

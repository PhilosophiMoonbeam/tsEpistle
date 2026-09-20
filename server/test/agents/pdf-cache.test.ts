import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { AgentPdfDiskCache, type AgentPdfCacheSource } from '../../agents/pdf-cache.ts'
import type { PreparedAgentPdf } from '../../agents/pdf-preparation.ts'

describe('private prepared PDF disk cache', () => {
  let db: Knex
  let root: string
  let source: AgentPdfCacheSource
  let builds = 0
  const payload = Buffer.from('%PDF-1.7\nprepared fixture')
  const signal = () => new AbortController().signal
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    root = await mkdtemp(join(tmpdir(), 'pdf-cache-test-'))
    await db.schema.createTable('agentSessions', t => {
      t.boolean('googleSearchEnabled').notNullable().defaultTo(false)
      t.string('id').primary()
      t.integer('ownerId')
      t.string('retention').defaultTo('saved')
      t.string('executionMode').defaultTo('agent')
      t.timestamp('deletedAt')
      t.timestamp('createdAt')
      t.timestamp('updatedAt')
      t.timestamp('lastActivityAt')
    })
    await db.schema.createTable('agentMedia', t => {
      t.string('id').primary()
      t.string('sessionId')
      t.integer('ownerId')
      t.string('sha256')
      t.integer('byteLength')
      t.string('mimeType')
      t.timestamp('expiresAt')
    })
    source = { id: randomUUID(), sessionId: randomUUID(), ownerId: 7, byteLength: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }
    await db('agentSessions').insert({
      id: source.sessionId,
      ownerId: 7,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date()
    })
    await db('agentMedia').insert({ ...source, mimeType: 'application/pdf', expiresAt: null })
    builds = 0
  })
  afterEach(async () => {
    await db.destroy()
    await rm(root, { recursive: true, force: true })
  })
  const build = async (): Promise<PreparedAgentPdf> => {
    builds++
    const directory = await mkdtemp(join(tmpdir(), 'pdf-cache-prepared-'))
    const path = join(directory, 'part.pdf')
    await writeFile(path, payload, { mode: 0o600 })
    return {
      pageCount: 2,
      parts: [{ path, startPage: 1, endPage: 2, byteLength: payload.length }],
      cleanup: () => rm(directory, { recursive: true, force: true })
    }
  }
  it('reuses prepared files across prompts and process restart without rebuilding or storing another original', async () => {
    const cache = new AgentPdfDiskCache(db, root)
    const first = await cache.acquire(source, signal(), build)
    const path = first.parts[0]!.path
    await first.cleanup()
    const again = await cache.acquire(source, signal(), build)
    expect(again.parts[0]!.path).toBe(path)
    await again.cleanup()
    const restarted = await new AgentPdfDiskCache(db, root).acquire(source, signal(), build)
    expect(await readFile(restarted.parts[0]!.path)).toEqual(payload)
    expect(builds).toBe(1)
    expect((await readdir(dirname(path))).sort()).toEqual(['manifest.json', 'part-0.pdf'])
    await restarted.cleanup()
  })
  it('regenerates corrupted cached parts and expired entries from the authoritative source', async () => {
    const cache = new AgentPdfDiskCache(db, root)
    const first = await cache.acquire(source, signal(), build)
    await first.cleanup()
    await writeFile(first.parts[0]!.path, Buffer.alloc(payload.length), { mode: 0o600 })
    const repaired = await cache.acquire(source, signal(), build)
    expect(builds).toBe(2)
    await repaired.cleanup()
    const manifest = join(dirname(repaired.parts[0]!.path), 'manifest.json')
    const record = JSON.parse(await readFile(manifest, 'utf8'))
    record.createdAt = 0
    await writeFile(manifest, JSON.stringify(record), { mode: 0o600 })
    const expired = await new AgentPdfDiskCache(db, root).acquire(source, signal(), build)
    expect(builds).toBe(3)
    await expired.cleanup()
  })
  it('retiring a deleted conversation preserves active lease until release then removes all parts', async () => {
    const cache = new AgentPdfDiskCache(db, root)
    const prepared = await cache.acquire(source, signal(), build)
    await db('agentSessions').update({ deletedAt: new Date() })
    await cache.sweep({ sessionId: source.sessionId })
    expect(await readFile(prepared.parts[0]!.path)).toEqual(payload)
    await expect(cache.acquire(source, signal(), build)).rejects.toMatchObject({ status: 404 })
    await prepared.cleanup()
    expect(await readdir(root)).toEqual([])
    expect(builds).toBe(1)
  })
  it('rejects ownership changes and prevents deleted sources from being republished during preparation', async () => {
    const cache = new AgentPdfDiskCache(db, root)
    await expect(cache.acquire({ ...source, ownerId: 8 }, signal(), build)).rejects.toMatchObject({ status: 404 })
    await expect(
      cache.acquire(source, signal(), async () => {
        const result = await build()
        await db('agentMedia').delete()
        return result
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(await readdir(root)).toEqual([])
  })
  it('bounds storage, never evicts leased parts, and evicts unused entries before admitting work', async () => {
    const limit = 300 * 1024 * 1024
    const cache = new AgentPdfDiskCache(db, root, { globalBytes: limit, ownerBytes: limit })
    const first = await cache.acquire(source, signal(), build)
    const second = { ...source, id: randomUUID() }
    await db('agentMedia').insert({ ...second, mimeType: 'application/pdf', expiresAt: null })
    await expect(cache.acquire(second, signal(), build)).rejects.toMatchObject({ code: 'PDF_PREPARATION_BUSY' })
    await first.cleanup()
    const admitted = await cache.acquire(second, signal(), build)
    expect((await readdir(root)).length).toBe(1)
    expect(builds).toBe(2)
    await admitted.cleanup()
  })
})

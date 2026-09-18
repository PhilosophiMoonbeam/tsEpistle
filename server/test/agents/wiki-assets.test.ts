import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { readAgentWikiAsset } from '../../agents/wiki-assets.ts'
import assetHelper from '../../helpers/asset.ts'

describe('Wiki asset attachment snapshots', () => {
  let db: Knex
  const payload = Buffer.from('%PDF-1.7\nsource')
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('assets', t => {
      t.integer('id').primary()
      t.string('filename')
      t.integer('folderId')
      t.string('hash')
      t.string('ext')
      t.integer('fileSize')
    })
    await db.schema.createTable('assetFolders', t => {
      t.integer('id').primary()
      t.integer('parentId')
      t.string('slug')
    })
    await db.schema.createTable('assetData', t => {
      t.integer('id').primary()
      t.binary('data')
    })
    await db('assetFolders').insert({ id: 2, parentId: null, slug: 'documents' })
    await db('assets').insert({
      id: 1,
      filename: 'brief.pdf',
      folderId: 2,
      hash: assetHelper.generateHash('documents/brief.pdf'),
      ext: 'pdf',
      fileSize: payload.length
    })
    await db('assetData').insert({ id: 1, data: payload })
  })
  afterEach(async () => db.destroy())
  const read = (authorize: (path: string) => Promise<void> = async () => {}) =>
    readAgentWikiAsset(db, { assetId: 1, signal: new AbortController().signal, authorize })
  it('uses authoritative folder identity and returns a validated private snapshot', async () => {
    const paths: string[] = []
    expect(
      await read(async path => {
        paths.push(path)
      })
    ).toEqual({ filename: 'brief.pdf', mimeType: 'application/pdf', payload })
    expect(paths).toEqual(['documents/brief.pdf', 'documents/brief.pdf'])
  })
  it('denies unreadable or locked assets before loading their bytes', async () => {
    const queries: string[] = []
    db.on('query', query => {
      queries.push(query.sql)
    })
    await expect(
      read(async () => {
        throw Object.assign(new Error('locked'), { status: 403 })
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(queries.some(query => query.includes('from `assetData`'))).toBe(false)
  })
  it('rejects stale identity, cyclic folders, oversized and corrupt source bytes', async () => {
    await db('assets').update({ hash: 'stale' })
    await expect(read()).rejects.toMatchObject({ status: 404 })
    await db('assets').update({ hash: assetHelper.generateHash('documents/brief.pdf') })
    await db('assetFolders').update({ parentId: 2 })
    await expect(read()).rejects.toMatchObject({ status: 404 })
    await db('assetFolders').update({ parentId: null })
    await db('assets').update({ fileSize: 251 * 1024 * 1024 })
    await expect(read()).rejects.toMatchObject({ status: 413 })
    await db('assets').update({ fileSize: payload.length })
    await db('assetData').update({ data: Buffer.alloc(payload.length) })
    await expect(read()).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
  })
})

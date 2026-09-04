import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import createKnex, { type Knex } from 'knex'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createSiteLogoController from '../../controllers/site-logo.ts'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

interface PublicObject {
  kind: 'source' | 'logo-png' | 'particle-v1' | 'effect-static-png'
  filename: 'logo.png' | 'particle.bin' | 'effect.png'
  contentType: string
  bytes: Buffer
  hash: string
}
const trackObjectReads = (db: Knex): (() => number) => {
  let reads = 0
  db.on('query', query => {
    if (query.sql.startsWith('select') && query.sql.includes('siteLogoObjects')) reads += 1
  })
  return () => reads
}

describe('public managed site logo objects', () => {
  let db: Knex
  let server: Server
  let baseUrl: string
  let accessCheck = vi.fn(() => false)
  let objects: PublicObject[]

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('siteLogoObjects', table => {
      table.string('kind').notNullable()
      table.string('sha256', 64).notNullable()
      table.binary('bytes').notNullable()
      table.integer('byteLength').notNullable()
      table.string('contentType').notNullable()
      table.dateTime('createdAt').notNullable()
      table.primary(['kind', 'sha256'])
    })

    objects = [
      { kind: 'logo-png', filename: 'logo.png', contentType: 'image/png', bytes: Buffer.from('exact ordinary logo bytes'), hash: '' },
      {
        kind: 'particle-v1',
        filename: 'particle.bin',
        contentType: 'application/octet-stream',
        bytes: Buffer.from('exact personalized particle bytes'),
        hash: ''
      },
      { kind: 'effect-static-png', filename: 'effect.png', contentType: 'image/png', bytes: Buffer.from('exact static fallback bytes'), hash: '' }
    ].map(object => ({ ...object, hash: digest(object.bytes) }))
    for (const object of objects) {
      await db('siteLogoObjects').insert({
        kind: object.kind,
        sha256: object.hash,
        bytes: object.bytes,
        byteLength: object.bytes.byteLength,
        contentType: object.contentType,
        createdAt: new Date()
      })
    }

    accessCheck = vi.fn(() => false)
    global.WIKI = { auth: { checkAccess: accessCheck }, config: { auth: { guestAccess: false } } }
    const app = express()
    app.use('/', createSiteLogoController(db))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Public logo test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await db.destroy()
  })

  it('serves exact role-bound bytes anonymously with immutable, nosniff, and strong validator headers', async () => {
    for (const object of objects) {
      const response = await fetch(`${baseUrl}/_site-logo/${object.hash}/${object.filename}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(object.contentType)
      expect(response.headers.get('content-length')).toBe(String(object.bytes.byteLength))
      expect(response.headers.get('cache-control')).toBe('public, max-age=2592000, immutable')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('etag')).toBe(`"${object.hash}"`)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(object.bytes)
    }
    expect(accessCheck).not.toHaveBeenCalled()
  })

  it('reuses one verified read across anonymous HEAD, conditional, and GET requests', async () => {
    const logo = objects.find(object => object.kind === 'logo-png')!
    const url = `${baseUrl}/_site-logo/${logo.hash}/logo.png`
    const objectReads = trackObjectReads(db)

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(logo.bytes.byteLength))
    expect(head.headers.get('content-type')).toBe('image/png')
    expect(head.headers.get('etag')).toBe(`"${logo.hash}"`)
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const repeatedHead = await fetch(url, { method: 'HEAD' })
    expect(repeatedHead.status).toBe(200)
    expect((await repeatedHead.arrayBuffer()).byteLength).toBe(0)

    const unchanged = await fetch(url, { headers: { 'if-none-match': `"unrelated", W/"${logo.hash}"` } })
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('etag')).toBe(`"${logo.hash}"`)
    expect(unchanged.headers.get('cache-control')).toBe('public, max-age=2592000, immutable')
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0)

    const fetched = await fetch(url)
    expect(fetched.status).toBe(200)
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(logo.bytes)
    expect(objectReads()).toBe(1)
    expect(accessCheck).not.toHaveBeenCalled()
  })

  it('authorizes by the lowercase composite role and hash rather than hash alone', async () => {
    const logo = objects.find(object => object.kind === 'logo-png')!
    const particle = objects.find(object => object.kind === 'particle-v1')!
    const sourceBytes = Buffer.from('private source image')
    const sourceHash = digest(sourceBytes)
    await db('siteLogoObjects').insert({
      kind: 'source',
      sha256: sourceHash,
      bytes: sourceBytes,
      byteLength: sourceBytes.byteLength,
      contentType: 'image/png',
      createdAt: new Date()
    })

    const negativePaths = [
      `/_site-logo/${logo.hash}/particle.bin`,
      `/_site-logo/${particle.hash}/logo.png`,
      `/_site-logo/${sourceHash}/logo.png`,
      `/_site-logo/${logo.hash.toUpperCase()}/logo.png`,
      `/_site-logo/${logo.hash}/LOGO.PNG`,
      `/_site-logo/${logo.hash}/source.png`,
      `/_site-logo/${logo.hash}%2F..%2F${particle.hash}/logo.png`
    ]
    for (const path of negativePaths) {
      const response = await fetch(`${baseUrl}${path}`)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('private source image')
    }
  })

  it('returns 404 without caching unknown, corrupt, or incomplete stored objects', async () => {
    const unknownHash = '0'.repeat(64)
    const mismatchedHash = '1'.repeat(64)
    const incompleteBytes = Buffer.from('incomplete object')
    const incompleteHash = digest(incompleteBytes)
    await db('siteLogoObjects').insert([
      {
        kind: 'logo-png',
        sha256: mismatchedHash,
        bytes: Buffer.from('corrupt bytes awaiting repair'),
        byteLength: Buffer.byteLength('corrupt bytes awaiting repair'),
        contentType: 'image/png',
        createdAt: new Date()
      },
      {
        kind: 'logo-png',
        sha256: incompleteHash,
        bytes: incompleteBytes,
        byteLength: incompleteBytes.byteLength + 1,
        contentType: 'image/png',
        createdAt: new Date()
      }
    ])

    const objectReads = trackObjectReads(db)
    for (const hash of [unknownHash, mismatchedHash, mismatchedHash, incompleteHash]) {
      const response = await fetch(`${baseUrl}/_site-logo/${hash}/logo.png`)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBeNull()
    }
    expect(objectReads()).toBe(4)
  })

  it('returns 404 for noncanonical paths and methods', async () => {
    const logo = objects.find(object => object.kind === 'logo-png')!
    const paths = [
      `/_site-logo/${logo.hash}/unknown.bin`,
      `/_site-logo/${logo.hash}/logo.png/extra`,
      `/_site-logo//${logo.hash}/logo.png`,
      `/_site-logo/${logo.hash.slice(1)}/logo.png`
    ]
    for (const path of paths) expect((await fetch(`${baseUrl}${path}`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/_site-logo/${logo.hash}/logo.png`, { method: 'POST' })).status).toBe(404)
  })

  it('rejects query-bearing object URLs before reading storage', async () => {
    const logo = objects.find(object => object.kind === 'logo-png')!
    const objectReads = trackObjectReads(db)

    const response = await fetch(`${baseUrl}/_site-logo/${logo.hash}/logo.png?download=1`)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBeNull()
    expect(objectReads()).toBe(0)
  })

  it('isolates cached objects by role even when their hashes are identical', async () => {
    const logo = objects.find(object => object.kind === 'logo-png')!
    await db('siteLogoObjects').insert({
      kind: 'particle-v1',
      sha256: logo.hash,
      bytes: logo.bytes,
      byteLength: logo.bytes.byteLength,
      contentType: 'application/octet-stream',
      createdAt: new Date()
    })
    const objectReads = trackObjectReads(db)

    const logoResponse = await fetch(`${baseUrl}/_site-logo/${logo.hash}/logo.png`)
    const particleResponse = await fetch(`${baseUrl}/_site-logo/${logo.hash}/particle.bin`)
    expect(logoResponse.status).toBe(200)
    expect(logoResponse.headers.get('content-type')).toBe('image/png')
    expect(particleResponse.status).toBe(200)
    expect(particleResponse.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await particleResponse.arrayBuffer())).toEqual(logo.bytes)
    expect(objectReads()).toBe(2)
  })

  it('evicts the least recently used verified bytes when the cache byte budget is exhausted', async () => {
    const largeObjects = [0x41, 0x42, 0x43].map(fill => {
      const bytes = Buffer.alloc(800 * 1024, fill)
      return { bytes, hash: digest(bytes) }
    })
    await db('siteLogoObjects').insert(
      largeObjects.map(object => ({
        kind: 'effect-static-png',
        sha256: object.hash,
        bytes: object.bytes,
        byteLength: object.bytes.byteLength,
        contentType: 'image/png',
        createdAt: new Date()
      }))
    )
    const objectReads = trackObjectReads(db)
    const get = async (index: number): Promise<number> => {
      const response = await fetch(`${baseUrl}/_site-logo/${largeObjects[index]!.hash}/effect.png`)
      await response.arrayBuffer()
      return response.status
    }

    expect(await get(0)).toBe(200)
    expect(await get(1)).toBe(200)
    expect(await get(0)).toBe(200)
    expect(await get(2)).toBe(200)
    expect(await get(0)).toBe(200)
    expect(objectReads()).toBe(3)

    expect(await get(1)).toBe(200)
    expect(objectReads()).toBe(4)
  })
})

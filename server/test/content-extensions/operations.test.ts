import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  listContentExtensions,
  setContentExtensionEnabled
} from '../../content-extensions/operations.ts'

const qrFence = '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"cached","size":256,"errorCorrection":"M"}}\n```\n'

describe('content extension operations', () => {
  let db: Knex
  let events: string[]
  let cachedHashes: Set<string>
  const cacheDelete = vi.fn()
  const renderPage = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    events = []
    cachedHashes = new Set(['qr-hash', 'plain-hash'])
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { max: 1, min: 1 },
      useNullAsDefault: true
    })
    await db.schema.createTable('contentExtensions', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.integer('version').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.integer('updatedBy').nullable()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('hash').notNullable()
      table.text('content').notNullable()
      table.text('render').notNullable()
    })
    await db('contentExtensions').insert([
      { key: 'qr', isEnabled: true, version: 1, updatedAt: new Date(), updatedBy: null },
      { key: 'gallery', isEnabled: false, version: 1, updatedAt: new Date(), updatedBy: null },
      { key: 'index', isEnabled: false, version: 1, updatedAt: new Date(), updatedBy: null }
    ])
    await db('pages').insert([
      { id: 1, hash: 'qr-hash', content: qrFence, render: '<svg>active QR</svg>' },
      { id: 2, hash: 'plain-hash', content: '```js\nconst wikiExtension = true\n```', render: '<pre>plain</pre>' }
    ])

    cacheDelete.mockImplementation(async (hash: string) => {
      events.push(`cache:${hash}`)
      cachedHashes.delete(hash)
    })
    renderPage.mockImplementation(async (page: { id: number }) => {
      events.push(`render:${page.id}`)
      const state = await db('contentExtensions').where({ key: 'qr' }).first('isEnabled')
      await db('pages').where({ id: page.id }).update({
        render: state?.isEnabled ? '<svg>active QR</svg>' : '<pre>escaped source</pre>'
      })
    })
    global.WIKI = {
      events: { outbound: { emit: (_event: string, hash: string) => events.push(`event:${hash}`) } },
      models: {
        knex: db,
        pages: {
          deletePageFromCache: cacheDelete,
          renderPage
        }
      }
    }
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('persists a toggle, invalidates cached rich output, and rerenders only matching pages', async () => {
    const status = await setContentExtensionEnabled('qr', false, 42)

    expect(status).toMatchObject({ key: 'qr', isEnabled: false, compatible: true, diagnostic: null })
    await expect(db('contentExtensions').where({ key: 'qr' }).first('isEnabled', 'updatedBy')).resolves.toMatchObject({
      isEnabled: 0,
      updatedBy: 42
    })
    await expect(db('pages').where({ id: 1 }).first('render')).resolves.toMatchObject({ render: '<pre>escaped source</pre>' })
    expect(cachedHashes.has('qr-hash')).toBe(false)
    expect(cachedHashes.has('plain-hash')).toBe(true)
    expect(events).toEqual(['cache:qr-hash', 'event:qr-hash', 'render:1'])
    expect(renderPage).toHaveBeenCalledTimes(1)
  })

  it('reports persisted version mismatches as editor-usable incompatibility diagnostics', async () => {
    await db('contentExtensions').where({ key: 'qr' }).update({ version: 2 })

    const status = await listContentExtensions()
    expect(status.hostVersion).toBe(1)
    expect(status.extensions).toHaveLength(3)
    expect(status.extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'qr',
        isEnabled: true,
        compatible: false,
        diagnostic: 'Installed extension "qr" version 2 does not match renderer version 1.'
      }),
      expect.objectContaining({ key: 'gallery', isEnabled: false, compatible: true, diagnostic: null }),
      expect.objectContaining({ key: 'index', isEnabled: false, compatible: true, diagnostic: null })
    ]))
  })
})

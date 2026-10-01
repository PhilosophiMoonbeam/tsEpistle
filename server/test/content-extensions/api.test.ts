import createKnex, { type Knex } from 'knex'
import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'

vi.mockModule('express', import.meta.url, () => {
  const routers: Array<Record<string, ReturnType<typeof vi.fn>>> = []
  const expressMock = {
    Router: () => {
      const router = { get: vi.fn(), patch: vi.fn() }
      routers.push(router)
      return router
    },
    __routers: routers
  }
  return { default: expressMock, ...expressMock }
})

// Capture real implementations before the controller dependency mock replaces the module exports.
const {
  listContentExtensions: realListContentExtensions,
  setContentExtensionEnabled: realSetContentExtensionEnabled
} = await import('../../content-extensions/operations.ts')

const operations = vi.hoisted(() => ({
  listContentExtensions: vi.fn(),
  setContentExtensionEnabled: vi.fn()
}))
vi.mockModule('../../content-extensions/operations.ts', import.meta.url, () => operations)

const pages = vi.hoisted(() => ({ listIndex: vi.fn() }))
vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({ default: pages }))

const express = await import('express')
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

type TestWiki = { auth: { checkAccess: ReturnType<typeof vi.fn> }; models?: { knex: Knex } }
let wiki: TestWiki
let db: Knex | undefined

const installRegistry = async () => {
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('users', table => { table.integer('id').primary() })
  await db('users').insert({ id: 1 })
  await createRegistry(db)
  await createDurableJobs(db)
  await addDurableJobLeaseToken(db)
  await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: true })
  wiki.models = { knex: db }
  return db
}
const response = () => ({
  json: vi.fn(),
  sendStatus: vi.fn(),
  setHeader: vi.fn(),
  status: vi.fn().mockReturnThis()
})

const loadHandlers = async () => {
  await vi.importFresh('../../controllers/api/content-extensions.ts', import.meta.url)
  const router = (express as unknown as { __routers: Array<{ get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> }> }).__routers[0]!
  return {
    list: router.get.mock.calls.find(([path]) => path === '/')?.[1],
    index: router.get.mock.calls.find(([path]) => path === '/index')?.[1],
    update: router.patch.mock.calls.find(([path]) => path === '/:key')?.[1]
  }
}

describe('content extension API', () => {
  beforeEach(() => {
    vi.resetModules()
    ;(express as unknown as { __routers: unknown[] }).__routers.length = 0
    operations.listContentExtensions.mockReset()
    operations.setContentExtensionEnabled.mockReset()
    pages.listIndex.mockReset()
    wiki = { auth: { checkAccess: vi.fn() } }
    ;(globalThis as unknown as { WIKI: TestWiki }).WIKI = wiki
  })
  afterEach(async () => {
    await db?.destroy()
    db = undefined
  })

  it('lists editor compatibility diagnostics', async () => {
    await installRegistry()
    operations.listContentExtensions.mockImplementation(realListContentExtensions)
    const { list } = await loadHandlers()
    const res = response()

    await list({}, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({
      hostVersion: 1,
      extensions: expect.arrayContaining([
        expect.objectContaining({
          key: 'qr',
          version: 1,
          title: expect.any(String),
          description: expect.any(String),
          icon: expect.any(String),
          isEnabled: true,
          compatible: true,
          diagnostic: null
        })
      ])
    })
  })

  it('passes the current requester and bounded query controls with private no-store index headers', async () => {
    operations.listContentExtensions.mockResolvedValue({
      hostVersion: 1,
      extensions: [{ key: 'index', isEnabled: true, compatible: true }]
    })
    pages.listIndex.mockResolvedValue([{ id: 7, title: 'Visible', href: '/en/guide/visible' }])
    const { index } = await loadHandlers()
    const res = response()
    const requester = { id: 12 }

    await index({
      query: { path: 'guide', locale: 'en', depth: '2', order: 'title', limit: '40' },
      user: requester
    }, res, vi.fn())

    expect(pages.listIndex).toHaveBeenCalledWith({
      requester,
      path: 'guide',
      locale: 'en',
      depth: 2,
      order: 'title',
      limit: 40
    })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.json).toHaveBeenCalledWith({ items: expect.any(Array) })
  })

  it('fails closed when the page index extension is disabled', async () => {
    operations.listContentExtensions.mockResolvedValue({
      hostVersion: 1,
      extensions: [{ key: 'index', isEnabled: false, compatible: true }]
    })
    const { index } = await loadHandlers()
    const res = response()

    await index({ query: {}, user: { id: 12 } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(pages.listIndex).not.toHaveBeenCalled()
  })

  it('refuses unauthorized toggles without changing registry state', async () => {
    wiki.auth.checkAccess.mockReturnValue(false)
    const { update } = await loadHandlers()
    const res = response()

    await update({ body: { isEnabled: false }, params: { key: 'qr' }, user: { id: 8 } }, res, vi.fn())

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(operations.setContentExtensionEnabled).not.toHaveBeenCalled()
  })

  it('validates and persists an administrator toggle', async () => {
    wiki.auth.checkAccess.mockReturnValue(true)
    const registry = await installRegistry()
    operations.listContentExtensions.mockImplementation(realListContentExtensions)
    operations.setContentExtensionEnabled.mockImplementation(realSetContentExtensionEnabled)
    const { update } = await loadHandlers()
    const res = response()

    await update({ body: { isEnabled: false }, params: { key: 'qr' }, user: { id: 1 } }, res, vi.fn())

    expect(await registry('contentExtensions').where({ key: 'qr' }).first('isEnabled', 'updatedBy')).toEqual({
      isEnabled: 0,
      updatedBy: 1
    })
    expect(await registry('durableJobs').where({ type: 'rerender-content-extension' }).first()).toMatchObject({
      version: 1,
      state: 'pending',
      attempts: 0,
      payload: JSON.stringify({ key: 'qr' })
    })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      key: 'qr',
      isEnabled: false,
      compatible: true,
      diagnostic: null
    }))
  })

  it.each([
    [{ isEnabled: false, force: true }],
    [{ isEnabled: 'false' }]
  ])('rejects extra or incorrectly typed toggle fields independently', async body => {
    wiki.auth.checkAccess.mockReturnValue(true)
    const { update } = await loadHandlers()
    const res = response()

    await update({ body, params: { key: 'qr' }, user: { id: 1 } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(operations.setContentExtensionEnabled).not.toHaveBeenCalled()
  })
})

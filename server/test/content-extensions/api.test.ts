vi.mock('express', () => {
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

const operations = vi.hoisted(() => ({
  listContentExtensions: vi.fn(),
  setContentExtensionEnabled: vi.fn()
}))
vi.mock('../../content-extensions/operations.ts', () => operations)

const pages = vi.hoisted(() => ({ listIndex: vi.fn() }))
vi.mock('../../operations/pages.ts', () => ({ default: pages }))

import * as express from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestWiki = { auth: { checkAccess: ReturnType<typeof vi.fn> } }
let wiki: TestWiki

const response = () => ({
  json: vi.fn(),
  sendStatus: vi.fn(),
  setHeader: vi.fn(),
  status: vi.fn().mockReturnThis()
})

const loadHandlers = async () => {
  await import('../../controllers/api/content-extensions.ts')
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

  it('lists editor compatibility diagnostics', async () => {
    const payload = { hostVersion: 1, extensions: [{ key: 'qr', compatible: true }] }
    operations.listContentExtensions.mockResolvedValue(payload)
    const { list } = await loadHandlers()
    const res = response()

    await list({}, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith(payload)
  })

  it('returns a no-store page index filtered by the current requester', async () => {
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
    expect(res.json).toHaveBeenCalledWith({ items: [{ id: 7, title: 'Visible', href: '/en/guide/visible' }] })
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
    operations.setContentExtensionEnabled.mockResolvedValue({ key: 'qr', isEnabled: false })
    const { update } = await loadHandlers()
    const res = response()

    await update({ body: { isEnabled: false }, params: { key: 'qr' }, user: { id: 1 } }, res, vi.fn())

    expect(operations.setContentExtensionEnabled).toHaveBeenCalledWith('qr', false, 1)
    expect(res.json).toHaveBeenCalledWith({ key: 'qr', isEnabled: false })
  })

  it('rejects extra or incorrectly typed toggle fields', async () => {
    wiki.auth.checkAccess.mockReturnValue(true)
    const { update } = await loadHandlers()
    const res = response()

    await update({ body: { isEnabled: 'false', force: true }, params: { key: 'qr' }, user: { id: 1 } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(operations.setContentExtensionEnabled).not.toHaveBeenCalled()
  })
})

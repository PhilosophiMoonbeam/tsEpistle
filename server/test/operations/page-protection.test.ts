import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as upProtection } from '../../db/migrations/2.5.134.ts'

let knex: Knex
let page: Record<string, unknown>
const searchUpdated = vi.fn()

const user = (id: number, permissions: string[]) => ({ id, email: `user-${id}@example.test`, permissions })

beforeEach(async () => {
  vi.resetModules()
  searchUpdated.mockReset()
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.text('content').notNullable()
    table.text('render').notNullable()
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }, { id: 9 }])
  await knex('pages').insert({ id: 42, content: '![Plan](/uploads/private-plan.png)', render: '<img src="/uploads/private-plan.png">' })
  await upProtection(knex)
  page = {
    id: 42,
    title: 'Protected plan',
    path: 'plans/private',
    localeCode: 'en',
    visibility: 'public',
    ownerId: null,
    tags: [],
    safeContent: 'classified text'
  }
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: (principal: { permissions?: string[] }, permissions: string[]) => permissions.some(permission => principal.permissions?.includes(permission))
    },
    data: { searchEngine: { updated: searchUpdated } },
    models: {
      knex,
      pages: {
        getPageFromDb: async () => ({ ...page }),
        cleanHTML: (value: string) => value,
        query: () => ({
          findById: (id: number) => ({ select: (...columns: string[]) => knex('pages').where({ id }).first(...columns) })
        })
      }
    }
  })
})

afterEach(async () => {
  delete (global as typeof globalThis & { WIKI?: unknown }).WIKI
  await knex.destroy()
})

describe('password-protected pages', () => {
  it('stores only a cost-12 hash, grants the setter session, and protects linked assets', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    const state = await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'correct horse battery staple',
      sessionId: 'manager-session'
    })
    expect(state).toMatchObject({ protected: true, version: 1 })
    const row = await knex('pageAccessPasswords').where({ pageId: 42 }).first()
    expect(row.passwordHash).toMatch(/^\$2[ayb]\$12\$/)
    expect(row.passwordHash).not.toContain('correct horse battery staple')
    expect(await protection.pageRequiresUnlock({ requester: user(7, ['read:pages']), pageId: 42, sessionId: 'manager-session' })).toBe(false)
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(true)
    expect(await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })).toBe(true)
    expect(await knex('pageProtectedAssets')).toEqual([{ pageId: 42, assetPath: 'uploads/private-plan.png' }])
    expect(searchUpdated).toHaveBeenCalledWith(expect.objectContaining({ safeContent: '' }))
  })

  it('uses session-scoped expiring grants and rejects wrong passwords without disclosure', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({ requester: user(7, ['write:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'manager-session' })
    await expect(Promise.resolve(protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'incorrect password', sessionId: 'reader-session' }))).rejects.toMatchObject({ status: 403, message: 'Access denied' })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(false)
    expect(await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })).toBe(false)
    expect(await protection.protectedAssetRequiresUnlock({ requester: user(9, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })).toBe(true)
    expect(await protection.pageRequiresUnlock({ requester: user(9, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(true)
    await knex('pageUnlockGrants').where({ sessionId: 'reader-session' }).update({ expiresAt: new Date('2026-08-14T00:00:00.000Z') })
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session', now: new Date('2026-08-15T00:00:00.000Z') })).toBe(true)
  })

  it('rotates passwords, revokes old grants, and allows administrator recovery', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({ requester: user(7, ['write:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'manager-session' })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })
    const rotated = await protection.setPageProtection({ requester: user(7, ['write:pages']), pageId: 42, password: 'a completely different password', sessionId: 'manager-session' })
    expect(rotated.version).toBe(2)
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(true)
    await expect(Promise.resolve(protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' }))).rejects.toMatchObject({ status: 403 })
    expect(await protection.pageRequiresUnlock({ requester: user(9, ['manage:system']), pageId: 42, sessionId: '' })).toBe(false)
    expect(await knex('pageUnlockGrants').where({ pageId: 42 })).toEqual([
      expect.objectContaining({ sessionId: 'manager-session', passwordVersion: 2 })
    ])
  })

  it('composes with private ownership and restores full indexing when removed', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    page.visibility = 'private'
    page.ownerId = 7
    await protection.setPageProtection({ requester: user(7, []), pageId: 42, password: 'private owner password', sessionId: 'owner-session' })
    expect(await protection.pageRequiresUnlock({ requester: user(7, []), pageId: 42, sessionId: 'other-owner-session' })).toBe(true)
    await expect(Promise.resolve(protection.unlockPage({
      requester: user(8, ['read:pages']),
      pageId: 42,
      password: 'private owner password',
      sessionId: 'outsider-session'
    }))).rejects.toMatchObject({ status: 403, message: 'Access denied' })
    await expect(Promise.resolve(protection.assertPageUnlocked({
      requester: user(8, ['read:pages']),
      pageId: 42,
      sessionId: 'outsider-session'
    }))).rejects.toMatchObject({ status: 404, name: 'PAGE_NOT_FOUND' })
    await protection.removePageProtection({ requester: user(7, []), pageId: 42 })
    expect(await protection.isPageProtected(42)).toBe(false)
    expect(searchUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ safeContent: '<img src="/uploads/private-plan.png">' }))
    expect(await knex('pageUnlockGrants')).toEqual([])
    expect(await knex('pageProtectedAssets')).toEqual([])
  })
})

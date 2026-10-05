import { createHash } from 'node:crypto'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as upProtection } from '../../db/migrations/2.5.134.ts'
import { enqueuePageMutationEffects, PageProjectionLifecycle } from '../../core/page-mutation-outbox.ts'

let knex: Knex
let page: Record<string, unknown>
let otherPage: Record<string, unknown> | undefined
const searchUpdated = vi.fn()
const protectedAssetPath = 'uploads/private-plan.png'
const protectedAssetHash = createHash('sha1').update(protectedAssetPath).digest('hex')

const user = (id: number, permissions: string[]) => ({ id, email: `user-${id}@example.test`, permissions })
const authorityFor = (requester: { permissions?: string[] } | undefined) => ({
  requester,
  permissions: requester?.permissions ?? [],
  groups: [],
  tagAliases: {}
})

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
  await knex.schema.createTable('assets', table => {
    table.integer('id').primary()
    table.string('hash').notNullable()
  })
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.bigInteger('sourceRevision').notNullable()
    table.bigInteger('renderedSourceRevision').nullable()
    table.string('title').notNullable()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.boolean('isSearchable').notNullable()
    table.dateTime('publishStartDate').nullable()
    table.dateTime('publishEndDate').nullable()
    table.text('content').notNullable()
    table.text('render').notNullable()
    table.text('extra').notNullable().defaultTo('{}')
  })
  await knex.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag').notNullable()
  })
  await knex.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await knex.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  await knex.schema.createTable('pageLinks', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.unique(['pageId', 'localeCode', 'path'])
  })
  await knex.schema.createTable('pagesVector', table => {
    table.integer('pageId').primary()
    table.bigInteger('sourceRevision').notNullable()
  })
  await knex.schema.createTable('pagesWords', table => {
    table.integer('pageId').notNullable()
    table.string('word').notNullable()
    table.primary(['pageId', 'word'])
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }, { id: 9 }])
  await knex('pages').insert({
    id: 42,
    sourceRevision: 8,
    renderedSourceRevision: 8,
    title: 'Protected plan',
    path: 'plans/private',
    localeCode: 'en',
    visibility: 'public',
    ownerId: null,
    isPublished: true,
    isSearchable: true,
    content: '![Plan](/uploads/private-plan.png)',
    render: '<img src="/uploads/private-plan.png">',
    extra: '{}'
  })

  await knex('assets').insert({ id: 101, hash: protectedAssetHash })
  await upProtection(knex)
  await knex.schema.alterTable('pageProtectedAssets', table => {
    table.integer('assetId').nullable()
  })

  page = {
    id: 42,
    sourceRevision: 8,
    renderedSourceRevision: 8,
    isPublished: true,
    isSearchable: true,
    title: 'Protected plan',
    path: 'plans/private',
    localeCode: 'en',
    visibility: 'public',
    ownerId: null,
    tags: [],
    safeContent: 'classified text'
  }
  otherPage = undefined
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: (principal: { permissions?: string[] }, permissions: string[]) =>
        permissions.some(permission => principal.permissions?.includes(permission)),
      checkPageAccess: (
        principal: { permissions?: string[] },
        permissions: string[],
        _context: unknown,
        authority: { requester: unknown; permissions: string[] }
      ) => authority.requester === principal && permissions.some(permission => authority.permissions.includes(permission)),
      loadPageRuleAuthority: async (requester: { permissions?: string[] } | undefined) => authorityFor(requester)
    },
    data: { searchEngine: { updated: searchUpdated } },
    models: {
      knex,
      pages: {
        getPageFromDb: async (id: number) => (id === 42 ? { ...page } : otherPage?.id === id ? { ...otherPage } : undefined),
        cleanHTML: (value: string) => value,
        query: () => ({
          findById: (id: number) => ({
            select: (...columns: string[]) =>
              knex('pages')
                .where({ id })
                .first(...columns)
          })
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
    expect(
      await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })
    ).toBe(true)
    expect(await knex('pageProtectedAssets')).toEqual([{ pageId: 42, assetPath: 'uploads/private-plan.png', assetId: 101 }])
    expect(searchUpdated).toHaveBeenCalledWith(expect.objectContaining({ safeContent: '' }))
  })

  it('keeps protected access attached to the stable asset id after a move', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    const destinationPath = 'uploads/moved/private-plan.png'
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'stable asset identity password',
      sessionId: 'manager-session'
    })
    expect(await knex('pageProtectedAssets')).toEqual([{ pageId: 42, assetPath: protectedAssetPath, assetId: 101 }])

    await knex('assets')
      .where({ id: 101 })
      .update({ hash: createHash('sha1').update(destinationPath).digest('hex') })

    await expect(
      protection.protectedAssetRequiresUnlock({
        requester: user(8, ['read:pages']),
        assetPath: destinationPath,
        sessionId: 'reader-session'
      })
    ).resolves.toBe(true)
  })

  it('protects assets referenced only by page branding metadata', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await knex('pages')
      .where({ id: 42 })
      .update({
        content: 'Protected branding',
        render: '<p>Protected branding</p>',
        extra: JSON.stringify({ branding: { assetId: 101 } })
      })
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'branding page password',
      sessionId: 'manager-session'
    })
    expect(await knex('pageProtectedAssets')).toEqual([])
    expect(
      await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: protectedAssetPath, sessionId: 'reader-session' })
    ).toBe(true)
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'branding page password', sessionId: 'reader-session' })
    expect(
      await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: protectedAssetPath, sessionId: 'reader-session' })
    ).toBe(false)
  })

  it('uses session-scoped expiring grants and rejects wrong passwords without disclosure', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'correct horse battery staple',
      sessionId: 'manager-session'
    })
    await expect(
      Promise.resolve(protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'incorrect password', sessionId: 'reader-session' }))
    ).rejects.toMatchObject({ status: 403, message: 'Access denied' })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(false)
    expect(
      await protection.protectedAssetRequiresUnlock({ requester: user(8, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })
    ).toBe(false)
    expect(
      await protection.protectedAssetRequiresUnlock({ requester: user(9, ['read:pages']), assetPath: 'uploads/private-plan.png', sessionId: 'reader-session' })
    ).toBe(true)
    expect(await protection.pageRequiresUnlock({ requester: user(9, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(true)
    await knex('pageUnlockGrants')
      .where({ sessionId: 'reader-session' })
      .update({ expiresAt: new Date('2026-08-14T00:00:00.000Z') })
    expect(
      await protection.pageRequiresUnlock({
        requester: user(8, ['read:pages']),
        pageId: 42,
        sessionId: 'reader-session',
        now: new Date('2026-08-15T00:00:00.000Z')
      })
    ).toBe(true)
  })

  it('scopes expired grant cleanup to the current page and session transactionally', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'correct horse battery staple',
      sessionId: 'manager-session'
    })
    const expiredAt = new Date('2026-08-14T00:00:00.000Z')
    await knex('pageUnlockGrants').insert([
      {
        id: '00000000-0000-4000-8000-000000000001',
        pageId: 42,
        sessionId: 'reader-session',
        userId: 8,
        passwordVersion: 1,
        createdAt: expiredAt,
        expiresAt: expiredAt
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        pageId: 42,
        sessionId: 'other-session',
        userId: 9,
        passwordVersion: 1,
        createdAt: expiredAt,
        expiresAt: expiredAt
      }
    ])

    await expect(
      Promise.resolve(
        knex.transaction(async transaction => {
          expect(
            await protection.pageRequiresUnlock({
              requester: user(8, ['read:pages']),
              pageId: 42,
              sessionId: 'reader-session',
              now: new Date('2026-08-15T00:00:00.000Z'),
              transaction
            })
          ).toBe(true)
          throw new Error('rollback')
        })
      )
    ).rejects.toThrow('rollback')
    expect(await knex('pageUnlockGrants')).toHaveLength(3)

    expect(
      await protection.pageRequiresUnlock({
        requester: user(8, ['read:pages']),
        pageId: 42,
        sessionId: 'reader-session',
        now: new Date('2026-08-15T00:00:00.000Z')
      })
    ).toBe(true)
    expect(await knex('pageUnlockGrants').where({ sessionId: 'reader-session' })).toHaveLength(0)
    expect(await knex('pageUnlockGrants').where({ sessionId: 'other-session' })).toHaveLength(1)
  })

  it('requires current page authorization after an asset unlock grant is issued', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'correct horse battery staple',
      sessionId: 'manager-session'
    })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })

    expect(
      await protection.protectedAssetRequiresUnlock({
        requester: user(8, ['read:pages']),
        assetPath: 'uploads/private-plan.png',
        sessionId: 'reader-session'
      })
    ).toBe(false)
    expect(
      await protection.protectedAssetRequiresUnlock({
        requester: user(8, []),
        assetPath: 'uploads/private-plan.png',
        sessionId: 'reader-session'
      })
    ).toBe(true)
  })

  it('requires an unlock grant and current authorization for the same linked page', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await knex('pages').insert({
      id: 43,
      sourceRevision: 9,
      renderedSourceRevision: 9,
      title: 'Reader plan',
      path: 'plans/reader',
      localeCode: 'en',
      visibility: 'private',
      ownerId: 8,
      isPublished: true,
      isSearchable: true,
      content: '![Plan](/uploads/private-plan.png)',
      render: '<img src="/uploads/private-plan.png">',
      extra: '{}'
    })
    otherPage = {
      id: 43,
      title: 'Reader plan',
      path: 'plans/reader',
      localeCode: 'en',
      visibility: 'private',
      ownerId: 8,
      tags: [],
      safeContent: 'reader text'
    }
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'first linked page password',
      sessionId: 'manager-session'
    })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'first linked page password', sessionId: 'reader-session' })
    await protection.setPageProtection({ requester: user(8, []), pageId: 43, password: 'second linked page password', sessionId: 'owner-session' })
    await knex('pageUnlockGrants').where({ pageId: 43, sessionId: 'owner-session' }).delete()
    page.visibility = 'private'
    page.ownerId = 7

    await knex('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: 7 })
    expect(
      await protection.protectedAssetRequiresUnlock({
        requester: user(8, []),
        assetPath: 'uploads/private-plan.png',
        sessionId: 'reader-session'
      })
    ).toBe(true)

    await protection.unlockPage({ requester: user(8, []), pageId: 43, password: 'second linked page password', sessionId: 'reader-session' })
    expect(
      await protection.protectedAssetRequiresUnlock({
        requester: user(8, []),
        assetPath: 'uploads/private-plan.png',
        sessionId: 'reader-session'
      })
    ).toBe(false)
  })

  it('rotates passwords, revokes old grants, and allows administrator recovery', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'correct horse battery staple',
      sessionId: 'manager-session'
    })
    await protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })
    const rotated = await protection.setPageProtection({
      requester: user(7, ['write:pages']),
      pageId: 42,
      password: 'a completely different password',
      sessionId: 'manager-session'
    })
    expect(rotated.version).toBe(2)
    expect(await protection.pageRequiresUnlock({ requester: user(8, ['read:pages']), pageId: 42, sessionId: 'reader-session' })).toBe(true)
    await expect(
      Promise.resolve(
        protection.unlockPage({ requester: user(8, ['read:pages']), pageId: 42, password: 'correct horse battery staple', sessionId: 'reader-session' })
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(await protection.pageRequiresUnlock({ requester: user(9, ['manage:system']), pageId: 42, sessionId: '' })).toBe(false)
    expect(await knex('pageUnlockGrants').where({ pageId: 42 })).toEqual([expect.objectContaining({ sessionId: 'manager-session', passwordVersion: 2 })])
  })

  it('composes with private ownership and restores full indexing when removed', async () => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    page.visibility = 'private'
    page.ownerId = 7
    await knex('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: 7 })
    await protection.setPageProtection({ requester: user(7, []), pageId: 42, password: 'private owner password', sessionId: 'owner-session' })
    expect(await protection.pageRequiresUnlock({ requester: user(7, []), pageId: 42, sessionId: 'other-owner-session' })).toBe(true)
    await expect(
      Promise.resolve(
        protection.unlockPage({
          requester: user(8, ['read:pages']),
          pageId: 42,
          password: 'private owner password',
          sessionId: 'outsider-session'
        })
      )
    ).rejects.toMatchObject({ status: 403, message: 'Access denied' })
    await expect(
      Promise.resolve(
        protection.assertPageUnlocked({
          requester: user(8, ['read:pages']),
          pageId: 42,
          sessionId: 'outsider-session'
        })
      )
    ).rejects.toMatchObject({ status: 404, name: 'PAGE_NOT_FOUND' })
    await protection.removePageProtection({ requester: user(7, []), pageId: 42 })
    expect(await protection.isPageProtected(42)).toBe(false)
    expect(searchUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ safeContent: '<img src="/uploads/private-plan.png">' }))
    expect(await knex('pageUnlockGrants')).toEqual([])
    expect(await knex('pageProtectedAssets')).toEqual([])
  })

  it.each(['set', 'remove'] as const)('repairs %s protection after the immediate search callback fails without mutating immutable intent', async action => {
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    const source = 'classifiedbody'
    await knex('pages').where({ id: 42 }).update({ content: source, render: '<p>classifiedbody</p>' })
    await enqueuePageMutationEffects(knex, {
      pageId: 42,
      sourceRevision: 8,
      desiredState: 'present',
      action: 'update',
      source,
      location: { locale: 'en', path: 'plans/private', visibility: 'public', ownerId: null },
      effects: ['render', 'links', 'search']
    })
    if (action === 'remove') {
      await protection.setPageProtection({
        requester: user(7, ['write:pages']),
        pageId: 42,
        password: 'durable protection password',
        sessionId: 'manager-session'
      })
    }
    await knex('pageMutationOutbox').update({ status: 'succeeded', attempts: 3, result: '{"indexed":true}', postcondition: '{"satisfied":true}' })
    await knex('pagesVector').insert({ pageId: 42, sourceRevision: 8 })
    await knex('pagesWords').insert({ pageId: 42, word: action === 'set' ? 'classifiedbody' : 'protectedmetadata' })
    const immutable = await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'sourceRevision', 'payload', 'payloadSha256', 'effectKey')
    searchUpdated.mockRejectedValueOnce(new Error('search callback unavailable'))

    await expect(action === 'set'
      ? protection.setPageProtection({ requester: user(7, ['write:pages']), pageId: 42, password: 'durable protection password', sessionId: 'manager-session' })
      : protection.removePageProtection({ requester: user(7, ['write:pages']), pageId: 42 })
    ).rejects.toThrow('search callback unavailable')

    expect(await protection.isPageProtected(42)).toBe(action === 'set')
    expect(await knex('pages').where({ id: 42 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')).toEqual({
      content: source, render: '<p>classifiedbody</p>', sourceRevision: 8, renderedSourceRevision: 8
    })
    if (action === 'set') {
      expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([])
      expect(await knex('pagesWords').where({ pageId: 42 })).toEqual([])
      expect(await knex('pageUnlockGrants').where({ pageId: 42 })).toEqual([
        expect.objectContaining({ sessionId: 'manager-session', userId: 7, passwordVersion: 1 })
      ])
    }
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'sourceRevision', 'payload', 'payloadSha256', 'effectKey')).toEqual(immutable)
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts', 'leaseToken', 'result', 'postcondition')).toEqual({
      status: 'retry',
      attempts: 0,
      leaseToken: null,
      result: null,
      postcondition: null
    })
    const reconcileSearchPage = vi.fn(async (pageId: number) => {
      const current = await knex('pages').where({ id: pageId }).first('render', 'sourceRevision')
      const searchable = await protection.redactProtectedPageForSearch({ id: pageId, safeContent: current.render })
      await knex.transaction(async transaction => {
        await transaction('pagesWords').where({ pageId }).delete()
        await transaction('pagesVector').insert({ pageId, sourceRevision: current.sourceRevision }).onConflict('pageId').merge()
        await transaction('pagesWords').insert({ pageId, word: searchable.safeContent.includes('classifiedbody') ? 'classifiedbody' : 'protectedmetadata' })
      })
    })
    const lifecycle = new PageProjectionLifecycle(knex, 'protection-repair-worker', {
      renderPage: async () => { throw new Error('Protection-only repair must not rerender certified source') },
      evictLocation: async () => undefined,
      reconcileSearchPage,
      removeSearchPage: async () => { throw new Error('Published public protection repair must not remove the page') }
    })
    await lifecycle.runOnce()

    expect(reconcileSearchPage).toHaveBeenCalledTimes(1)
    expect(await knex('pagesWords').where({ pageId: 42, word: 'classifiedbody' })).toHaveLength(action === 'remove' ? 1 : 0)
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toEqual({ status: 'succeeded', attempts: 1 })
    expect(await knex('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'sourceRevision', 'payload', 'payloadSha256', 'effectKey')).toEqual(immutable)
    expect(await knex('pagesVector').where({ pageId: 42 })).toEqual([{ pageId: 42, sourceRevision: 8 }])
  })
})

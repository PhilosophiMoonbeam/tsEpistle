import express from 'express'
import type { Server } from 'node:http'
import knexModule, { type Knex } from 'knex'
import bcrypt from 'bcryptjs-then'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageErrors from '../../helpers/error.ts'
import type pageOperations from '../../operations/pages.ts'
import type * as pageProtection from '../../operations/page-protection.ts'
import { up as createProtectionSchema } from '../../db/migrations/2.5.134.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_link_suggestions_test', import.meta.path)
const suite = connection ? describe : describe.skip
const permissions = ['read:pages', 'write:pages']
const requester = { id: 7, permissions } as Express.User
const otherOwner = { id: 8, permissions } as Express.User
const manager = { id: 9, permissions: ['manage:system'] } as Express.User
const password = 'native-link-suggestion-password'
const originalWiki = globalThis.WIKI

suite('PostgreSQL root-path link suggestions', () => {
  let db: Knex
  let operations: typeof pageOperations
  let protection: typeof pageProtection
  let server: Server | undefined
  let baseUrl: string
  let passwordHash: string
  const lang = { code: 'en', namespacing: false, namespaces: ['en', 'fr', 'zh-Hant'] }
  const allow = { match: 'START', path: '', deny: false, roles: permissions, locales: [] }
  const seed = (id: number, path: string, extra: Record<string, unknown> = {}) => db('pages').insert({
    id, path, title: `Title ${id}`, localeCode: 'en', visibility: 'public', ownerId: null,
    isPublished: true, isSearchable: true, sourceRevision: 1, renderedSourceRevision: 1,
    hash: `page-${id}`, description: '', content: 'Canonical source', render: '<p>Canonical source</p>',
    toc: '[]', extra: '{}', editorKey: 'markdown', contentType: 'markdown', authorId: 7, creatorId: 7,
    createdAt: new Date(), updatedAt: new Date(), ...extra
  })
  const suggest = (pathPrefix = '/', extra: Record<string, unknown> = {}) => operations.linkSuggestions({
    requester, sessionId: 'owner-session', locale: 'en', pathPrefix, limit: 20, ...extra
  })
  const protect = (pageId: number) => db('pageAccessPasswords').insert({
    pageId, passwordHash, version: 1, updatedBy: 7, updatedAt: new Date()
  })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL, title text NOT NULL,
        "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false);
      CREATE TABLE pages (
        id integer PRIMARY KEY, path text NOT NULL, title text NOT NULL, "localeCode" text NOT NULL,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL, "publishStartDate" text, "publishEndDate" text,
        hash text NOT NULL, description text NOT NULL, content text NOT NULL, render text NOT NULL,
        toc jsonb NOT NULL, extra jsonb NOT NULL, "editorKey" text NOT NULL, "contentType" text NOT NULL,
        "authorId" integer NOT NULL, "creatorId" integer NOT NULL,
        "sourceRevision" bigint NOT NULL, "renderedSourceRevision" bigint, "changeReason" varchar(200),
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id));
    `)
    await createProtectionSchema(db)
    await db('users').insert([7, 8, 9].map(id => ({ id, name: `Author ${id}`, email: `author${id}@example.test` })))
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 8, groupId: 3 }, { userId: 9, groupId: 1 }])
    await db('groups').insert([
      { id: 3, name: 'Authors', permissions: JSON.stringify(permissions), pageRules: JSON.stringify([allow]) },
      { id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']), pageRules: JSON.stringify([]) }
    ])
    const models: Record<string, unknown> & { knex: Knex } = { knex: db }
    globalThis.WIKI = {
      config: { db: { type: 'postgres' }, lang, sessionSecret: 'link-suggestion-native-test' },
      configSvc: {}, lang: { localeCodes: ['en', 'fr', 'zh-Hant'] }, data: {}, events: {}, startedAt: {},
      logger: console, Error: pageErrors, models,
      auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority }
    } as never
    // Canonical models and operations capture the installed native runtime.
    const [{ default: Page }, { default: Tag }, pageOps, protectionOps] = await Promise.all([
      import('../../models/pages.ts'), import('../../models/tags.ts'),
      import('../../operations/pages.ts'), import('../../operations/page-protection.ts')
    ])
    models.pages = Page.bindKnex(db)
    Tag.knex(db)
    models.tags = Tag
    operations = pageOps.default
    protection = protectionOps
    passwordHash = await bcrypt.hash(password, 4)
    // The router imports operations that capture WIKI; the native runtime must exist first.
    const { default: router } = await import('../../controllers/api/pages.ts')
    const app = express()
    app.use((req, _res, next) => {
      const context = req as typeof req & { sessionID: string }
      context.user = req.get('Cookie') === 'actor=other' ? otherOwner : requester
      context.sessionID = req.get('Cookie') === 'actor=other' ? 'other-session' : 'owner-session'
      next()
    })
    app.use('/_api/pages', router)
    app.use(((error, _req, res, _next) => {
      res.status(error.status ?? 500).json({ error: 'Request failed' })
    }) as express.ErrorRequestHandler)
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    server.once('error', listening.reject)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Link suggestion fixture did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    await db('pages').delete()
    await db('tags').delete()
    await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(permissions), pageRules: JSON.stringify([allow]) })
    lang.namespacing = false
  })

  afterAll(async () => {
    try {
      if (server?.listening) {
        const closed = Promise.withResolvers<void>()
        server.close(error => error ? closed.reject(error) : closed.resolve())
        await closed.promise
      }
    } finally {
      globalThis.WIKI = originalWiki
      await db?.destroy()
    }
  })

  it('offers only searchable live public pages and the current owner’s private pages, including for writers and managers', async () => {
    await seed(1, 'docs/live')
    await seed(2, 'docs/unsearchable', { isSearchable: false })
    await seed(3, 'docs/draft', { isPublished: false })
    await seed(4, 'docs/future', { publishStartDate: '2999-01-01T00:00:00.000Z' })
    await seed(5, 'docs/expired', { publishEndDate: '2000-01-01T00:00:00.000Z' })
    await seed(6, 'docs/invalid-window', { publishStartDate: 'not-a-date' })
    await seed(7, 'docs/own', { visibility: 'private', ownerId: 7, isPublished: false })
    await seed(8, 'docs/other', { visibility: 'private', ownerId: 8 })
    await seed(9, 'docs/locked')
    await protect(9)
    expect(await suggest('/docs/')).toEqual({ items: [
      { id: 1, title: 'Title 1', locale: 'en', path: 'docs/live', visibility: 'public', href: '/docs/live' },
      { id: 7, title: 'Title 7', locale: 'en', path: 'docs/own', visibility: 'private', href: '/_private/en/docs/own' }
    ] })
    expect((await suggest('/docs/', { requester: manager })).items.map(item => item.id)).toEqual([1, 9])
    expect(await suggest('/docs/other')).toEqual({ items: [] })
    expect(await suggest('/docs/absent')).toEqual({ items: [] })
    expect((await suggest('/docs/', { requester: otherOwner })).items.map(item => item.id)).toEqual([1, 8])
  })

  it('uses native tags, current persisted ACL and agent scope rather than a retained authority', async () => {
    await seed(1, 'docs/allowed')
    await seed(2, 'docs/path-denied')
    await seed(3, 'docs/tag-denied')
    await seed(4, 'docs/elsewhere')
    await db('tags').insert({ id: 1, tag: 'restricted', title: 'Restricted' })
    await db('pageTags').insert({ pageId: 3, tagId: 1 })
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([
      allow,
      { match: 'EXACT', path: 'docs/path-denied', deny: true, roles: ['read:pages'], locales: ['en'] },
      { match: 'TAG', path: 'restricted', deny: true, roles: ['read:pages'], locales: ['en'] }
    ]) })
    const authority = await loadPageRuleAuthority(requester)
    expect((await suggest('/docs/')).items.map(item => item.id)).toEqual([1, 4])
    expect((await suggest('/docs/', { agentScope: { kind: 'selected', pageIds: [1, 2, 3] } })).items.map(item => item.id)).toEqual([1])
    expect(await suggest('/docs/', { agentScope: { kind: 'locale', locale: 'fr' } })).toEqual({ items: [] })
    expect((await suggest('/docs/', { agentScope: { kind: 'section', locale: 'en', path: 'docs/allowed' } })).items.map(item => item.id)).toEqual([1])
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([]) })
    expect(await suggest('/docs/', { authority })).toEqual({ items: [] })
  })

  it('admits current native unlock grants only, then withdraws rows after session, owner, version, expiry or ACL changes', async () => {
    await seed(1, 'protected/public')
    await seed(2, 'protected/private', { visibility: 'private', ownerId: 7 })
    await protect(1)
    await protect(2)
    expect(await suggest('/protected/')).toEqual({ items: [] })
    await protection.unlockPage({ requester, pageId: 1, password, sessionId: 'owner-session' })
    await protection.unlockPage({ requester, pageId: 2, password, sessionId: 'owner-session' })
    expect((await suggest('/protected/')).items.map(item => item.id)).toEqual([2, 1])
    expect(await suggest('/protected/', { sessionId: 'another-session' })).toEqual({ items: [] })
    expect(await suggest('/protected/', { requester: otherOwner })).toEqual({ items: [] })
    await db('pageAccessPasswords').where({ pageId: 1 }).update({ version: 2 })
    expect((await suggest('/protected/')).items.map(item => item.id)).toEqual([2])
    await db('pageUnlockGrants').where({ pageId: 2 }).update({ expiresAt: new Date(0) })
    expect(await suggest('/protected/')).toEqual({ items: [] })
    await db('pageAccessPasswords').where({ pageId: 1 }).update({ version: 1 })
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([]) })
    expect(await suggest('/protected/')).toEqual({ items: [] })
  })

  it('normalizes explicit locale/private roots, encoding and case while returning canonical native hrefs', async () => {
    await seed(1, 'Guides/École')
    await seed(2, 'Guides/École', { localeCode: 'fr' })
    await seed(3, 'Guides/École', { localeCode: 'fr', visibility: 'private', ownerId: 7 })
    await seed(4, '教材/入門', { localeCode: 'zh-Hant' })
    expect((await suggest('/GUIDES/%C3%89')).items).toEqual([
      { id: 1, title: 'Title 1', locale: 'en', path: 'Guides/École', visibility: 'public', href: '/Guides/%C3%89cole' }
    ])
    expect((await suggest('/FR/guides/')).items.map(item => [item.id, item.href])).toEqual([
      [3, '/_private/fr/Guides/%C3%89cole'], [2, '/fr/Guides/%C3%89cole']
    ])
    expect((await suggest('/_private/FR/guides/')).items.map(item => item.id)).toEqual([3])
    expect((await suggest('/zh-hant/%E6%95%99%E6%9D%90/')).items.map(item => item.href)).toEqual(['/zh-Hant/%E6%95%99%E6%9D%90/%E5%85%A5%E9%96%80'])
    expect((await suggest('/fr/')).items.map(item => item.id)).toEqual([3, 2])
    expect((await suggest('/', { locale: 'FR' })).items.map(item => item.id)).toEqual([3, 2])
    lang.namespacing = true
    expect((await suggest('/Guides/')).items.map(item => item.href)).toEqual(['/en/Guides/%C3%89cole'])
  })

  it('matches SQL wildcard characters literally and orders shallow paths first with stable ties', async () => {
    await seed(1, 'z-root')
    await seed(2, 'alpha/child/deep')
    await seed(3, 'alpha/child')
    await seed(4, 'alpha')
    await seed(5, 'alpha', { visibility: 'private', ownerId: 7 })
    await seed(6, 'literal_%/page')
    await seed(7, 'literalXY/page')
    const result = await suggest('/')
    expect(result.items.slice(0, 4).map(item => item.id)).toEqual([5, 4, 1, 3])
    expect(result.items.at(-1)?.id).toBe(2)
    expect(await suggest('/')).toEqual(result)
    expect((await suggest('/alpha', { limit: 2 })).items.map(item => item.id)).toEqual([5, 4])
    expect((await suggest('/literal_%')).items.map(item => item.id)).toEqual([6])
    expect((await suggest('/literal%5F%25')).items.map(item => item.id)).toEqual([6])
  })

  it('bounds candidate scans without revealing withheld totals or whether a wider prefix exhausted its window', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1, path: `scan/${String(index).padStart(4, '0')}`, title: `Withheld ${index}`, localeCode: 'en',
      visibility: 'public', ownerId: null, isPublished: true, isSearchable: true,
      sourceRevision: 1, renderedSourceRevision: 1, hash: `scan-${index}`, description: '', content: '', render: '',
      toc: '[]', extra: '{}', editorKey: 'markdown', contentType: 'markdown', authorId: 7, creatorId: 7,
      createdAt: new Date(), updatedAt: new Date()
    }))
    await db.batchInsert('pages', rows, 250)
    await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([
      { match: 'EXACT', path: 'scan/1000', deny: false, roles: ['read:pages'], locales: ['en'] }
    ]) })
    expect(await suggest('/scan/')).toEqual({ items: [] })
    expect((await suggest('/scan/1000')).items.map(item => item.id)).toEqual([1001])
    await expect(suggest('/', { limit: 51 })).rejects.toMatchObject({ status: 400 })
    await expect(suggest('/', { limit: 0 })).rejects.toMatchObject({ status: 400 })
  })

  it('routes HTTP suggestions before dynamic IDs with no-store headers and rejects non-scalar or oversized requests', async () => {
    await seed(1, 'api/live')
    await seed(2, 'api/private', { visibility: 'private', ownerId: 7 })
    const query = new URLSearchParams({ locale: 'en', pathPrefix: '/api/', limit: '20' })
    const response = await fetch(`${baseUrl}/_api/pages/link-suggestions?${query}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain('Cookie')
    expect(await response.json()).toEqual({ items: [
      { id: 1, title: 'Title 1', locale: 'en', path: 'api/live', visibility: 'public', href: '/api/live' },
      { id: 2, title: 'Title 2', locale: 'en', path: 'api/private', visibility: 'private', href: '/_private/en/api/private' }
    ] })
    const other = await fetch(`${baseUrl}/_api/pages/link-suggestions?${query}`, { headers: { Cookie: 'actor=other' } })
    expect(await other.json()).toEqual({ items: [
      { id: 1, title: 'Title 1', locale: 'en', path: 'api/live', visibility: 'public', href: '/api/live' }
    ] })
    for (const invalid of [
      'locale=en&pathPrefix=/&limit=51', 'locale=en&pathPrefix=/&limit=0',
      'locale=en&pathPrefix=/&limit=1&limit=2', 'locale=en&pathPrefix=/&limit[x]=1',
      'locale=en&locale=fr&pathPrefix=/', 'locale[x]=en&pathPrefix=/',
      'locale=en&pathPrefix=/&pathPrefix=/api/', 'locale=en&pathPrefix[x]=/',
      'locale=en', 'locale=en&pathPrefix=//external', 'locale=en&pathPrefix=/../secret',
      `locale=en&pathPrefix=${'x'.repeat(2049)}`
    ]) {
      const failure = await fetch(`${baseUrl}/_api/pages/link-suggestions?${invalid}`)
      expect(failure.status).toBe(400)
    }
    const empty = await fetch(`${baseUrl}/_api/pages/link-suggestions?locale=en&pathPrefix=`)
    expect(empty.status).toBe(200)
  })
})

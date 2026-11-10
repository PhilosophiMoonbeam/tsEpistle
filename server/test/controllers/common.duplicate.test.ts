import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { CommonWiki } from '../../controllers/common.ts'
import type * as CommonModule from '../../controllers/common.ts'
import { evaluateGroupAccess, type AccessPage, type PageRuleAuthority } from '../../helpers/group-access.ts'
import domainErrors from '../../helpers/error.ts'

const originalWiki = globalThis.WIKI
const requester = { id: 42, permissions: ['read:pages', 'write:pages'] } as Express.User
let server: Server | undefined
let baseUrl: string
let permissions: string[]
let protectedPage: boolean
let grant: { sessionId: string; userId: number; passwordVersion: number; expiresAt: Date } | null
const sourcePage = () => ({
  id: 7, path: 'reference/source', locale: 'en', localeCode: 'en', visibility: 'public' as 'public' | 'private', ownerId: null as number | null,
  title: 'Source', description: 'Readable source', content: '# Native source', contentType: 'markdown', sourceRevision: '1',
  isPublished: true, isSearchable: true, publishStartDate: '', publishEndDate: '', editorKey: 'markdown', editor: 'markdown',
  updatedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z', tags: [], extra: { css: '.source {}', js: 'sourceOnly()' },
  toc: [], render: '<p>Native source</p>'
})
const pageRules = [
  { match: 'SUBTREE' as const, path: 'reference', deny: false, roles: ['read:pages', 'read:history', 'read:source'], locales: ['en'] },
  { match: 'SUBTREE' as const, path: 'workspace', deny: false, roles: ['write:pages'], locales: ['fr'] }
]
let source = sourcePage()
const loadAuthority = async (user: Express.User | undefined): Promise<PageRuleAuthority> => ({
  requester: user, permissions: [...permissions], groups: [{ id: 3, permissions: [...permissions], pageRules }], tagAliases: {}
})
const checkPageAccess = (user: Express.User | undefined, requested: readonly string[], page: AccessPage, authority: PageRuleAuthority) =>
  authority.requester === user && evaluateGroupAccess(authority.permissions, requested, authority.groups, page, authority.tagAliases, false).allowed

beforeEach(() => {
  permissions = ['read:pages', 'write:pages', 'read:history', 'read:source']
  source = sourcePage()
  protectedPage = false
  grant = null
})
beforeAll(async () => {
  // Durable reads are fixture-owned; routing, native source authorization,
  // publication, ownership and session/password grant matching are real.
  const db = Object.assign((table: string) => {
    const predicates: Array<(row: Record<string, unknown>) => boolean> = []
    const query = {
      where(column: string | Record<string, unknown>, operator?: unknown, value?: unknown) {
        if (typeof column === 'object') predicates.push(row => Object.entries(column).every(([key, expected]) => row[key] === expected))
        else if (operator === '>') predicates.push(row => Number(row[column]) > Number(value))
        else if (operator === '<=') predicates.push(row => Number(row[column]) <= Number(value))
        return query
      },
      select() { return query },
      orderBy() { return query },
      forShare() { return query },
      async first() {
        const row = table === 'pageAccessPasswords' && protectedPage ? { pageId: source.id, version: 3 }
          : table === 'pageUnlockGrants' && grant ? { pageId: source.id, ...grant } : undefined
        return row && predicates.every(predicate => predicate(row)) ? row : undefined
      },
      async delete() { return 0 }
    }
    return query
  }, { transaction: async (work: (transaction: unknown) => unknown) => work(db) })
  const wiki = {
    Error: domainErrors,
    config: {
      seo: { robots: '' }, metrics: { isEnabled: false }, lang: { code: 'en', namespacing: true },
      theming: { injectCSS: '', injectHead: '', injectBody: '' }, pageExtensions: [], features: { featurePageComments: false }, host: 'http://wiki.example'
    },
    auth: {
      checkAccess: (_user: unknown, requested: readonly string[]) => requested.some(permission => permissions.includes(permission)),
      checkPageAccess, loadPageRuleAuthority: loadAuthority,
      getEffectivePermissions(req: express.Request, context: AccessPage, authority: PageRuleAuthority) {
        const allowed = (permission: string) => checkPageAccess(req.user, [permission], context, authority)
        return {
          pages: { read: allowed('read:pages'), write: allowed('write:pages'), manage: false, delete: false, script: false, style: false },
          comments: { read: false, write: false, manage: false }, history: { read: allowed('read:history') }, source: { read: allowed('read:source') }, system: { manage: false }
        }
      }
    },
    models: {
      knex: db,
      pages: {
        getPage: async () => ({ ...source, extra: { ...source.extra } }),
        getPageFromDb: async (input: number | { path: string }) => typeof input === 'number' ? source : input.path === source.path ? source : null,
        query() {
          const query = { select: () => query, withGraphJoined: () => query, modifyGraph: () => query, findById: async () => source }
          return query
        }
      },
      pageHistory: { getVersion: async () => ({ ...source, content: '# Historical source', tags: [] }) },
      navigation: { getTree: async () => [] }, assets: { getAsset: async () => undefined }, users: { getUserAvatarData: async () => null }
    },
    data: { commentProvider: { codeTemplate: '', head: '', body: '', main: '' } }
  }
  globalThis.WIKI = wiki as unknown as typeof WIKI
  const { default: createCommonController } = await vi.importFresh<typeof CommonModule>('../../controllers/common.ts', import.meta.url)
  const app = express()
  app.use((req, res, next) => {
    req.user = requester
    req.sessionID = 'current-session'
    req.i18n = { changeLanguage: () => undefined, dir: () => 'ltr' } as never
    res.locals.siteConfig = {}
    res.locals.pageMeta = {}
    res.render = ((view: string, model: unknown) => res.json({ view, model })) as typeof res.render
    next()
  })
  app.use(createCommonController(wiki as unknown as CommonWiki))
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
    res.status(status).json({ error: error instanceof Error ? error.name : String(error) })
  })
  server = app.listen(0, '127.0.0.1')
  const listening = Promise.withResolvers<void>()
  server.once('listening', listening.resolve)
  server.once('error', listening.reject)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Duplicate fixture did not bind loopback')
  baseUrl = `http://127.0.0.1:${address.port}`
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
  }
})
const get = async (path: string) => {
  const response = await fetch(`${baseUrl}${path}`)
  return { response, body: await response.json() as { view: string; model: { effectivePermissions: { pages: { write: boolean; duplicate: boolean }; source: { read: boolean } }; page: Record<string, unknown> } } }
}

describe('reader Duplicate discovery and native editor admission', () => {
  it('offers source-eligible readers Duplicate without source-write or read:source and admits only their selected destination', async () => {
    permissions = permissions.filter(permission => permission !== 'read:source')
    const reader = await get('/en/reference/source')
    expect(reader.response.status).toBe(200)
    expect(reader.body.view).toBe('page')
    expect(reader.body.model.effectivePermissions).toMatchObject({ pages: { write: false, duplicate: true }, source: { read: false } })
    const editor = await get('/e/fr/workspace/copy?from=7')
    expect(editor.response.status).toBe(200)
    expect(editor.body.view).toBe('editor')
    expect(editor.body.model.page).toMatchObject({ path: 'workspace/copy', localeCode: 'fr', visibility: 'public', ownerId: null, content: Buffer.from(source.content).toString('base64'), extra: { css: '', js: '' } })
    for (const path of ['/e/en/reference/copy?from=7', '/e/en/workspace/copy?from=7', '/e/fr/forbidden/copy?from=7']) {
      const denied = await get(path)
      expect(denied.response.status).toBe(403)
      expect(denied.body.view).toBe('unauthorized')
    }
  })

  it('withdraws discovery and refuses editor admission when current membership loses write permission despite stale session hints', async () => {
    expect((await get('/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(true)
    permissions = permissions.filter(permission => permission !== 'write:pages')
    expect(requester.permissions).toContain('write:pages')
    expect((await get('/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(false)
    expect((await get('/e/fr/workspace/copy?from=7')).response.status).toBe(403)
  })

  it('refuses unreadable, foreign-private, unpublished, scheduled and expired live sources even at writable destinations', async () => {
    const unreadable = permissions.filter(permission => permission !== 'read:pages')
    for (const scenario of [
      { permissions: unreadable }, { source: { visibility: 'private' as const, ownerId: 9 } }, { source: { isPublished: false } },
      { source: { publishStartDate: '2099-01-01T00:00:00Z' } }, { source: { publishEndDate: '2000-01-01T00:00:00Z' } }
    ]) {
      source = { ...sourcePage(), ...scenario.source }
      permissions = scenario.permissions ?? ['read:pages', 'write:pages']
      const denied = await get('/e/fr/workspace/copy?from=7')
      expect(denied.response.status).toBe(404)
      expect(denied.body.view).toBe('notfound')
    }
  })

  it('requires the current password unlock session both for reader discovery and later source retrieval', async () => {
    protectedPage = true
    expect((await get('/en/reference/source')).response.status).toBe(401)
    const validGrant = { sessionId: 'current-session', userId: requester.id, passwordVersion: 3, expiresAt: new Date(Date.now() + 60_000) }
    for (const mismatch of [{ sessionId: 'other-session' }, { userId: 9 }, { passwordVersion: 2 }, { expiresAt: new Date(0) }]) {
      grant = { ...validGrant, ...mismatch }
      expect((await get('/e/fr/workspace/copy?from=7')).response.status).toBe(401)
    }
    grant = validGrant
    expect((await get('/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(true)
    expect((await get('/e/fr/workspace/copy?from=7')).body.view).toBe('editor')
    grant = null
    expect((await get('/e/fr/workspace/copy?from=7')).response.status).toBe(401)
  })

  it('keeps private ownership at the source and requires deliberate publication in the explicit public destination', async () => {
    source = { ...sourcePage(), visibility: 'private', ownerId: requester.id }
    for (const from of ['7', '7,9']) {
      const editor = await get(`/e/fr/workspace/copy?from=${from}`)
      expect(editor.response.status).toBe(200)
      expect(editor.body.model.page).toMatchObject({ visibility: 'public', ownerId: null, isPublished: false })
    }
  })

  it('does not turn the live-source hint into history access and strips historical code outside destination capabilities', async () => {
    expect((await get('/h/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(true)
    expect((await get('/s/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(true)
    const historical = await get('/e/fr/workspace/copy?from=7,9')
    expect(historical.response.status).toBe(200)
    expect(historical.body.model.page).toMatchObject({ content: Buffer.from('# Historical source').toString('base64'), extra: { css: '', js: '' } })
    permissions = permissions.filter(permission => permission !== 'read:history')
    expect((await get('/en/reference/source')).body.model.effectivePermissions.pages.duplicate).toBe(true)
    const deniedHistory = await get('/e/fr/workspace/copy?from=7,9')
    expect(deniedHistory.response.status).toBe(403)
    expect(deniedHistory.body).toEqual({ view: 'unauthorized', model: { action: 'template' } })
  })
})

import express from 'express'
import { load } from 'cheerio'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { CommonWiki } from '../../controllers/common.ts'
import type * as CommonModule from '../../controllers/common.ts'

const globalWiki = globalThis as unknown as { WIKI: unknown }
const previous = globalWiki.WIKI
let server: Server
let base: string
let allowed = true
let published = true
let visibility = 'public'
let protectedPage = false
let unlocked = false
const page = () => ({ id: 7, locale: 'fr', localeCode: 'fr', path: 'guide', title: 'Le guide <safe>', description: 'Une description', content: 'source must not be rendered', contentType: 'markdown', sourceRevision: '4', render: '<h2 id="active">Bonjour</h2><p>Texte actuel <a href="/fr/grid">Grid</a></p><script>unsafe()</script>', authorId: 42, isPublished: published, isSearchable: true, updatedAt: '2026-11-08T12:00:00Z', createdAt: '2026-11-08T12:00:00Z', tags: [], visibility, ownerId: visibility === 'private' ? 42 : null, editorKey: 'markdown', editor: 'markdown', toc: [], extra: {} })
const config = { title: 'Reader Wiki', seo: { robots: '' }, metrics: { isEnabled: false }, lang: { code: 'en', namespacing: true, namespaces: ['fr'] }, theming: { injectCSS: '', injectHead: '', injectBody: '', iconset: 'md' }, pageExtensions: [], features: { featurePageComments: false }, host: 'http://wiki.example', nav: { mode: 'MIXED' }, editShortcuts: [] }
const getPage = vi.fn(async (args: { path: string; locale: string; visibility: string; ownerId: number | null }) => {
  const record = page()
  return args.path === record.path && args.locale === record.localeCode && args.visibility === record.visibility && args.ownerId === record.ownerId ? record : undefined
})

beforeAll(async () => {
  const knex = Object.assign(vi.fn((table: string) => {
    const query = { where: (..._args: unknown[]) => query, delete: async () => 0, first: async () => table === 'pageAccessPasswords' && protectedPage ? { version: 1 } : table === 'pageUnlockGrants' && unlocked ? { pageId: 7 } : undefined, select: async () => [] }
    return query
  }), { client: { pool: { numFree: () => 1, numUsed: () => 0 } } })
  const wiki = {
    config, auth: {
      checkAccess: () => false, checkPageAccess: () => allowed,
      loadPageRuleAuthority: async (requester: unknown) => ({ requester, permissions: ['read:pages'], groups: [], tagAliases: {} }),
      getEffectivePermissions: () => ({ pages: { read: allowed, write: false }, history: { read: false }, source: { read: false } })
    },
    models: { knex, pages: { getPage }, navigation: { getTree: async () => [] } },
    lang: { localeCodes: ['en', 'fr'] },
    data: { reservedPaths: [], commentProvider: { codeTemplate: '', head: '', body: '', main: '' } }
  }
  globalWiki.WIKI = wiki
  // Protection and page operations capture WIKI at module evaluation after fixture setup.
  const { default: controller } = await vi.importFresh<typeof CommonModule>('../../controllers/common.ts', import.meta.url)
  const app = express()
  app.set('view engine', 'pug')
  app.set('views', fileURLToPath(new URL('../../views', import.meta.url)))
  app.use((req, res, next) => {
    Object.assign(req, { sessionID: 'reader-session', user: { id: req.headers['x-owner'] ? 42 : 2, groups: [], permissions: ['read:pages'] }, i18n: { changeLanguage: () => {}, dir: () => 'rtl' } })
    Object.assign(res.locals, { config, siteConfig: { lang: 'fr', product: { revision: 'test' } }, pageMeta: {}, langs: [], devMode: false, vite: { css: [], preloads: [], file: '/app.js' }, analyticsCode: { head: '', bodyStart: '', bodyEnd: '' } })
    next()
  })
  app.use(controller(wiki as unknown as CommonWiki))
  server = app.listen(0)
  const listening = Promise.withResolvers<void>()
  server.once('listening', listening.resolve)
  server.once('error', listening.reject)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => { allowed = true; published = true; visibility = 'public'; protectedPage = false; unlocked = false; getPage.mockClear() })
afterAll(async () => {
  const closing = Promise.withResolvers<void>()
  server.close(error => error ? closing.reject(error) : closing.resolve())
  await closing.promise
  if (previous === undefined) Reflect.deleteProperty(globalWiki, 'WIKI')
  else globalWiki.WIKI = previous
})

describe('authorized no-script reader response', () => {
  it('delivers current semantic public prose and locale with no duplicate JS-enabled content', async () => {
    const response = await fetch(`${base}/fr/guide`)
    expect(response.status).toBe(200)
    expect(getPage).toHaveBeenCalledWith({ path: 'guide', locale: 'fr', visibility: 'public', ownerId: null })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain('Cookie')
    const html = await response.text()
    const passive = load(html, { scriptingEnabled: false })
    expect(passive('noscript main').attr('lang')).toBe('fr')
    expect(passive('noscript main').attr('dir')).toBe('rtl')
    expect(passive('noscript h1').text()).toBe('Le guide <safe>')
    expect(passive('noscript').text()).toContain('Une description')
    expect(passive('noscript h2').text()).toBe('Bonjour')
    expect(passive('noscript a[href="/fr/grid"]').text()).toBe('Grid')
    expect(passive('noscript nav a').attr('href')).toBe('/fr/home')
    expect(passive('noscript script,noscript [id]').length).toBe(0)
    expect(passive('noscript').text()).not.toContain('source must not be rendered')
    const active = load(html, { scriptingEnabled: true })
    expect(active('noscript h2').length).toBe(0)
    expect(active('template[data-wiki-page-contents]').length).toBe(1)
  })

  it('keeps an admitted private owner response request-specific', async () => {
    visibility = 'private'
    const response = await fetch(`${base}/_private/fr/guide`, { headers: { 'x-owner': '42' } })
    expect(response.status).toBe(200)
    expect(getPage).toHaveBeenCalledWith({ path: 'guide', locale: 'fr', visibility: 'private', ownerId: 42 })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(load(await response.text(), { scriptingEnabled: false })('noscript h2').text()).toBe('Bonjour')
  })

  it('requires the existing password grant before exposing the passive article', async () => {
    protectedPage = true
    const locked = await fetch(`${base}/fr/guide`)
    expect(locked.status).toBe(401)
    expect(locked.headers.get('cache-control')).toBe('private, no-store')
    expect(await locked.text()).not.toContain('Texte actuel')
    unlocked = true
    const admitted = await fetch(`${base}/fr/guide`)
    expect(admitted.status).toBe(200)
    expect(load(await admitted.text(), { scriptingEnabled: false })('noscript h2').text()).toBe('Bonjour')
  })

  it('does not disclose passive content to denied readers or unpublished public readers', async () => {
    for (const denied of [true, false]) {
      allowed = !denied
      published = denied
      const response = await fetch(`${base}/fr/guide`)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('Texte actuel')
    }
  })
})

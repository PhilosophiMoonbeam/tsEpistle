import express from 'express'
import { load } from 'cheerio'
import i18next from 'i18next'
import english from '../../locales/en.json'
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
const defaultRender = '<h2 id="active">Bonjour</h2><p>Texte actuel <a href="/fr/grid?view=source&amp;term=hello%20world#section">Grid</a></p><script>unsafe()</script>'
let storedRender = defaultRender
let presentation: Record<string, unknown> = {}
let restoreIndex: (() => void) | undefined
const translations = i18next.createInstance()
const page = () => ({ id: 7, locale: 'fr', localeCode: 'fr', path: 'guide', title: 'Le guide <safe>', description: 'Une description', content: 'source must not be rendered', contentType: 'markdown', sourceRevision: '4', render: storedRender, authorId: 42, isPublished: published, isSearchable: true, updatedAt: '2026-11-08T12:00:00Z', createdAt: '2026-11-08T12:00:00Z', tags: [], visibility, ownerId: visibility === 'private' ? 42 : null, editorKey: 'markdown', editor: 'markdown', toc: [], extra: {} })
const config = { title: 'Reader Wiki', seo: { robots: '' }, metrics: { isEnabled: false }, lang: { code: 'en', namespacing: true, namespaces: ['fr'] }, theming: { injectCSS: '', injectHead: '', injectBody: '', iconset: 'md' }, pageExtensions: [], features: { featurePageComments: false }, host: 'http://wiki.example', nav: { mode: 'MIXED' }, editShortcuts: [] }
const getPage = async (args: { path: string; locale: string; visibility: string; ownerId: number | null }) => {
  const record = page()
  return args.path === record.path && args.locale === record.localeCode && args.visibility === record.visibility && args.ownerId === record.ownerId ? record : undefined
}

beforeAll(async () => {
  await translations.init({ lng: 'fr', fallbackLng: 'en', defaultNS: 'common', ns: ['common'], resources: { en: english } })
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
  const { default: pageOperations } = await import('../../operations/pages.ts')
  const index = vi.spyOn(pageOperations, 'listIndex').mockResolvedValue([
    { id: 8, title: 'Dated guide', description: null, path: 'guide/dated', href: '/fr/guide/dated', updatedAt: '2026-11-08T16:30:00.000Z', tags: [], pageAccent: null }
  ])
  restoreIndex = () => index.mockRestore()
  const app = express()
  app.set('view engine', 'pug')
  app.set('views', fileURLToPath(new URL('../../views', import.meta.url)))
  app.use((req, res, next) => {
    Object.assign(req, { sessionID: 'reader-session', user: { id: req.headers['x-owner'] ? 42 : 2, groups: [], permissions: ['read:pages'], ...presentation }, i18n: { changeLanguage: () => {}, dir: () => 'rtl' } })
    Object.assign(res.locals, { config, siteConfig: { lang: 'fr', product: { revision: 'test' } }, pageMeta: {}, langs: [], devMode: false, vite: { css: [], preloads: [], file: '/app.js' }, analyticsCode: { head: '', bodyStart: '', bodyEnd: '' }, t: translations.t.bind(translations) })
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
beforeEach(() => { allowed = true; published = true; visibility = 'public'; protectedPage = false; unlocked = false; storedRender = defaultRender; presentation = {} })
afterAll(async () => {
  const closing = Promise.withResolvers<void>()
  server.close(error => error ? closing.reject(error) : closing.resolve())
  await closing.promise
  restoreIndex?.()
  if (previous === undefined) Reflect.deleteProperty(globalWiki, 'WIKI')
  else globalWiki.WIKI = previous
})

describe('authorized no-script reader response', () => {
  it('delivers current semantic public prose and locale with no duplicate JS-enabled content', async () => {
    const response = await fetch(`${base}/fr/guide`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain('Cookie')
    const html = await response.text()
    const passive = load(html, { scriptingEnabled: false })
    expect(passive('noscript main').attr('lang')).toBe('fr')
    expect(passive('noscript main').attr('dir')).toBe('rtl')
    expect(passive('noscript h1').text()).toBe('Le guide <safe>')
    expect(passive('noscript').text()).toContain('Une description')
    expect(passive('noscript h2').text()).toBe('Bonjour')
    expect(passive('noscript a[href="/fr/grid?view=source&term=hello%20world#section"]').text()).toBe('Grid')
    expect(passive('noscript nav a').attr('href')).toBe('/fr/home')
    expect(passive('noscript script,noscript [id]').length).toBe(0)
    expect(passive('noscript').text()).not.toContain('source must not be rendered')
    const active = load(html, { scriptingEnabled: true })
    expect(active('noscript h2').length).toBe(0)
    expect(active('template[data-wiki-page-contents]').length).toBe(1)
  })

  it('formats the authorized index instant for both JWT and refreshed-account principals without cross-reader leakage', async () => {
    storedRender = '<section class="content-extension--index" data-index-path="guide" data-index-locale="fr" data-index-depth="1" data-index-limit="50" data-index-show-updated-at="true"></section>'
    for (const example of [
      { principal: { tz: 'Pacific/Auckland', df: 'DD/MM/YYYY', tf: '24h' }, expected: '09/11/2026 05:30' },
      { principal: { timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '12h' }, expected: '2026-11-08 11:30 AM' }
    ]) {
      presentation = example.principal
      const response = await fetch(`${base}/fr/guide`, { headers: { 'x-owner': '42' } })
      expect(response.status).toBe(200)
      const passive = load(await response.text(), { scriptingEnabled: false })
      expect(passive('noscript time').attr('datetime')).toBe('2026-11-08T16:30:00.000Z')
      expect(passive('noscript time').text()).toBe(example.expected)
      expect(passive('noscript a[href="/fr/guide/dated"]').text()).toBe('Dated guide')
    }
  })

  it('keeps an admitted private owner response request-specific', async () => {
    visibility = 'private'
    const response = await fetch(`${base}/_private/fr/guide`, { headers: { 'x-owner': '42' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(load(await response.text(), { scriptingEnabled: false })('noscript h2').text()).toBe('Bonjour')
  })

  it('keeps a private page unavailable to a guest while offering a passive way home', async () => {
    visibility = 'private'
    const response = await fetch(`${base}/_private/fr/guide`)
    expect(response.status).toBe(404)
    const html = await response.text()
    const passive = load(html, { scriptingEnabled: false })
    expect(passive('noscript main h1').length).toBe(1)
    expect(passive('noscript main a[href="/"]').length).toBe(1)
    expect(passive('noscript').text()).not.toContain(page().title)
    expect(passive('noscript').text()).not.toContain('Texte actuel')
    expect(load(html, { scriptingEnabled: true })('noscript main').length).toBe(0)
  })

  it('requires the existing password grant before exposing the passive article', async () => {
    protectedPage = true
    const locked = await fetch(`${base}/fr/guide`)
    expect(locked.status).toBe(401)
    expect(locked.headers.get('cache-control')).toBe('private, no-store')
    const lockedHtml = await locked.text()
    const passive = load(lockedHtml, { scriptingEnabled: false })
    expect(passive('noscript main h1').length).toBe(1)
    expect(passive('noscript main a[href="/"]').length).toBe(1)
    expect(passive('noscript').text()).not.toContain(page().title)
    expect(lockedHtml).not.toContain('Texte actuel')
    expect(load(lockedHtml, { scriptingEnabled: true })('noscript main').length).toBe(0)
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
      const html = await response.text()
      const passive = load(html, { scriptingEnabled: false })
      expect(passive('noscript main h1').length).toBe(1)
      expect(passive('noscript main a[href="/"]').length).toBe(1)
      expect(passive('noscript').text()).not.toContain(page().title)
      expect(html).not.toContain('Texte actuel')
      expect(load(html, { scriptingEnabled: true })('noscript main').length).toBe(0)
    }
  })
})

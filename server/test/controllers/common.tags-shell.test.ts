import express from 'express'
import * as cheerio from 'cheerio'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { CommonWiki } from '../../controllers/common.ts'
import type NavigationModel from '../../models/navigation.ts'
import type * as NavigationModule from '../../models/navigation.ts'
import type * as CommonModule from '../../controllers/common.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: unknown }
const originalWiki = wikiGlobal.WIKI
const encodedLabel = 'Équipe </tags><script data-menu-injection>alert("menu")</script> & "Guides"'
const config = {
  title: 'Tags fixture wiki',
  seo: { robots: '' },
  metrics: { isEnabled: false },
  lang: { code: 'en', namespacing: true },
  theming: { iconset: 'md', injectCSS: '', injectHead: '', injectBody: '' },
  pageExtensions: [],
  features: { featurePageComments: false },
  host: 'http://wiki.example',
  nav: { mode: 'MIXED', expandParent: true }
}
const navigationTrees = [
  {
    locale: 'en',
    items: [
      {
        id: 'english-docs',
        kind: 'link',
        label: 'English documentation',
        icon: 'mdi-book-open',
        targetType: 'page',
        target: '/en/docs',
        visibilityMode: 'all',
        visibilityGroups: []
      },
      {
        id: 'english-team',
        kind: 'link',
        label: 'Editorial workspace',
        icon: 'mdi-pencil',
        targetType: 'page',
        target: '/en/editorial',
        visibilityMode: 'restricted',
        visibilityGroups: [7]
      },
      {
        id: 'english-private',
        kind: 'link',
        label: 'Confidential English notes',
        icon: 'mdi-lock',
        targetType: 'page',
        target: '/_private/en/confidential-notes',
        visibilityMode: 'restricted',
        visibilityGroups: [9]
      }
    ]
  },
  {
    locale: 'fr',
    items: [
      {
        id: 'french-docs',
        kind: 'link',
        label: 'Documentation française',
        icon: 'mdi-book-open',
        targetType: 'page',
        target: '/fr/documentation',
        visibilityMode: 'all',
        visibilityGroups: []
      },
      {
        id: 'french-team',
        kind: 'link',
        label: encodedLabel,
        icon: 'mdi-pencil',
        targetType: 'page',
        target: '/fr/equipe?q=%3Ctags%3E&source=menu',
        visibilityMode: 'restricted',
        visibilityGroups: [7]
      },
      {
        id: 'french-private',
        kind: 'link',
        label: 'Notes françaises confidentielles',
        icon: 'mdi-lock',
        targetType: 'page',
        target: '/_private/fr/notes-confidentielles',
        visibilityMode: 'restricted',
        visibilityGroups: [9]
      }
    ]
  }
]
const cache = new Map<string, unknown>()
let locale = 'fr'
let server: Server | undefined
let baseUrl: string
let Navigation: typeof NavigationModel

beforeAll(async () => {
  const models: { navigation?: typeof NavigationModel } = {}
  const wiki = {
    config,
    auth: {},
    models,
    cache: {
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => {
        cache.set(key, value)
      }
    },
    logger: { warn: vi.fn() }
  }
  wikiGlobal.WIKI = wiki
  Navigation = (await vi.importFresh<typeof NavigationModule>('../../models/navigation.ts', import.meta.url)).default
  models.navigation = Navigation
  // Only the durable read is stubbed: audience filtering and cache reuse run in the real model.
  vi.spyOn(Navigation, 'query').mockReturnValue({
    findOne: vi.fn(async () => ({ key: 'site', config: structuredClone(navigationTrees) }))
  } as never)
  const { default: createCommonController } = await vi.importFresh<typeof CommonModule>('../../controllers/common.ts', import.meta.url)
  const app = express()
  app.set('views', fileURLToPath(new URL('../../views/', import.meta.url)))
  app.set('view engine', 'pug')
  Object.assign(app.locals, {
    config,
    langs: [],
    devMode: false,
    vite: { client: '', css: [], preloads: [], file: '/assets/app.js' },
    analyticsCode: { head: '', bodyStart: '', bodyEnd: '' }
  })
  app.use((req, res, next) => {
    const audience = req.get('X-Fixture-Audience')
    if (audience === 'editor') req.user = { id: 42, groups: [7] } as Express.User
    if (audience === 'reviewer') req.user = { id: 43, groups: [9] } as Express.User
    res.locals.siteConfig = { lang: locale, product: { revision: 'tags-shell-fixture' } }
    res.locals.pageMeta = {}
    next()
  })
  app.use(createCommonController(wiki as unknown as CommonWiki))
  server = app.listen(0, '127.0.0.1')
  const listening = Promise.withResolvers<void>()
  server.once('listening', listening.resolve)
  server.once('error', listening.reject)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Tags shell fixture did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  cache.clear()
  locale = 'fr'
  config.nav.mode = 'MIXED'
  config.nav.expandParent = true
})

afterAll(async () => {
  try {
    if (server?.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => (error ? closed.reject(error) : closed.resolve()))
      await closed.promise
    }
  } finally {
    vi.restoreAllMocks()
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  }
})

const getShell = async (path: string, audience?: 'editor' | 'reviewer') => {
  const response = await fetch(`${baseUrl}${path}`, audience ? { headers: { 'X-Fixture-Audience': audience } } : {})
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const html = await response.text()
  const $ = cheerio.load(html)
  const tags = $('tags')
  expect(tags).toHaveLength(1)
  const sidebar = tags.attr('sidebar')
  expect(sidebar).toBeDefined()
  return {
    $,
    tags,
    html,
    sidebar: JSON.parse(Buffer.from(sidebar!, 'base64').toString('utf8')) as Array<{ k: string; l: string; c: string; y: string; t: string }>
  }
}

describe('common Tags response shell', () => {
  it.each([
    { path: '/t', language: 'fr', mode: 'MIXED', expandParent: false },
    { path: '/t/architecture/vue%20%26%20r%C3%A9seau', language: 'en', mode: 'STATIC', expandParent: true },
    { path: '/t/design', language: 'fr', mode: 'TREE', expandParent: true },
    { path: '/t', language: 'en', mode: 'NONE', expandParent: false }
  ])('projects $language locale and $mode navigation into $path without defaulting saved settings', async ({ path, language, mode, expandParent }) => {
    locale = language
    config.nav.mode = mode
    config.nav.expandParent = expandParent
    const shell = await getShell(path, 'editor')
    expect(shell.$('html').attr('lang')).toBe(language)
    expect(shell.tags.attr('shell-locale')).toBe(language)
    expect(shell.tags.attr('nav-mode')).toBe(mode)
    expect(shell.tags.attr(':nav-expand-parent')).toBe(String(expandParent))
    expect(shell.sidebar).toEqual(
      language === 'fr'
        ? [
            expect.objectContaining({ k: 'link', l: 'Documentation française', c: 'mdi-book-open', y: 'page', t: '/fr/documentation' }),
            expect.objectContaining({ k: 'link', l: encodedLabel, c: 'mdi-pencil', y: 'page', t: '/fr/equipe?q=%3Ctags%3E&source=menu' })
          ]
        : [
            expect.objectContaining({ k: 'link', l: 'English documentation', c: 'mdi-book-open', y: 'page', t: '/en/docs' }),
            expect.objectContaining({ k: 'link', l: 'Editorial workspace', c: 'mdi-pencil', y: 'page', t: '/en/editorial' })
          ]
    )
  })

  it('filters a shared cached locale menu for each requester on direct and selected-tag loads', async () => {
    const editor = await getShell('/t', 'editor')
    expect(editor.sidebar.map(item => item.t)).toEqual(['/fr/documentation', '/fr/equipe?q=%3Ctags%3E&source=menu'])
    expect(editor.sidebar[1]?.l).toBe(encodedLabel)
    expect(editor.$('script[data-menu-injection]')).toHaveLength(0)
    expect(editor.html).not.toContain(encodedLabel)

    const reviewer = await getShell('/t/relecture', 'reviewer')
    expect(reviewer.sidebar.map(item => item.t)).toEqual(['/fr/documentation', '/_private/fr/notes-confidentielles'])
    expect(reviewer.sidebar.map(item => item.l)).not.toContain(encodedLabel)

    const guest = await getShell('/t/architecture')
    expect(guest.sidebar).toEqual([expect.objectContaining({ k: 'link', l: 'Documentation française', c: 'mdi-book-open', y: 'page', t: '/fr/documentation' })])
  })
})

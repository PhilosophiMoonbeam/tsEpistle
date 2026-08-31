import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type NavigationModel from '../../models/navigation.ts'
import type * as NavigationModule from '../../models/navigation.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI

type NavigationItem = Record<string, unknown>
type NavigationTree = { locale: string; items: NavigationItem[] }
type NavigationCache = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown, ttl: number) => Promise<unknown> }
type NavigationWiki = { cache: NavigationCache; logger: { warn: (message: string) => void }; models: { navigation: typeof NavigationModel } }

const home = { id: 'home', kind: 'link', label: 'Home', targetType: 'home', target: '/' }
const ordinaryLink = { id: 'docs', kind: 'link', label: 'Docs', targetType: 'page', target: '/en/docs', visibilityMode: 'all', visibilityGroups: [] }
const restrictedVisibleLink = {
  id: 'private',
  kind: 'link',
  label: 'Private',
  targetType: 'page',
  target: '/en/private',
  visibilityMode: 'restricted',
  visibilityGroups: [7]
}
const restrictedHiddenLink = {
  id: 'admin',
  kind: 'link',
  label: 'Admin',
  targetType: 'page',
  target: '/en/admin',
  visibilityMode: 'restricted',
  visibilityGroups: [9]
}
const header = { id: 'docs-header', kind: 'header', label: 'Documentation', visibilityMode: 'all', visibilityGroups: [] }
const divider = { id: 'docs-divider', kind: 'divider', visibilityMode: 'all', visibilityGroups: [] }

let Navigation: typeof NavigationModel
let cacheGet = vi.fn()
let cacheSet = vi.fn()
let findOne = vi.fn()

beforeEach(async () => {
  vi.resetModules()
  cacheGet = vi.fn()
  cacheSet = vi.fn().mockResolvedValue(undefined)
  findOne = vi.fn()
  const cache: NavigationCache = { get: cacheGet, set: cacheSet }
  wikiGlobal.WIKI = {
    cache,
    logger: { warn: vi.fn() },
    models: { navigation: {} }
  }
  Navigation = (await vi.importFresh<typeof NavigationModule>('../../models/navigation.ts', import.meta.url)).default
  const testWiki = wikiGlobal.WIKI as unknown as NavigationWiki
  testWiki.models.navigation = Navigation
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('models/navigation legacy Home normalization', () => {
  it('removes cached legacy Home while retaining links, headers, dividers, and authorized group items', async () => {
    const cachedItems = [home, ordinaryLink, restrictedVisibleLink, restrictedHiddenLink, header, divider]
    cacheGet.mockResolvedValue(cachedItems)

    await expect(Navigation.getTree({ cache: true, locale: 'en', groups: [7] })).resolves.toEqual([ordinaryLink, restrictedVisibleLink, header, divider])
    expect(cacheGet).toHaveBeenCalledWith('nav:sidebar:en')
  })

  it('removes legacy Home from uncached locale trees before returning and caching them', async () => {
    const trees: NavigationTree[] = [
      { locale: 'en', items: [home, ordinaryLink, header, divider] },
      { locale: 'fr', items: [home, { ...ordinaryLink, id: 'guides', target: '/fr/guides' }] }
    ]
    findOne.mockResolvedValue({ key: 'site', config: trees })
    const navigationQuery = { findOne }
    const queryResult = navigationQuery as never
    vi.spyOn(Navigation, 'query').mockReturnValue(queryResult)

    await expect(Navigation.getTree({ cache: true, locale: 'all', bypassAuth: true })).resolves.toEqual([
      { locale: 'en', items: [ordinaryLink, header, divider] },
      { locale: 'fr', items: [{ ...ordinaryLink, id: 'guides', target: '/fr/guides' }] }
    ])
    expect(findOne).toHaveBeenCalledWith('key', 'site')
    expect(cacheSet).toHaveBeenNthCalledWith(1, 'nav:sidebar:en', [ordinaryLink, header, divider], 300)
    expect(cacheSet).toHaveBeenNthCalledWith(2, 'nav:sidebar:fr', [{ ...ordinaryLink, id: 'guides', target: '/fr/guides' }], 300)
  })
})

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

    await expect(Navigation.getTree({ cache: true, locale: 'en', groups: [7] })).resolves.toEqual([ordinaryLink, restrictedVisibleLink])
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
    expect(cacheSet).toHaveBeenCalledWith('nav:sidebar:en', [ordinaryLink, header, divider], 300)
    expect(cacheSet).toHaveBeenCalledWith('nav:sidebar:fr', [{ ...ordinaryLink, id: 'guides', target: '/fr/guides' }], 300)
  })
})

describe('published navigation cache revisions and audience cleanup', () => {
  it('reads the active revision instead of a previously published cache key', async () => {
    Reflect.set(wikiGlobal.WIKI!, 'config', { nav: { revision: 'published-new' } })
    cacheGet.mockImplementation(key => key === 'nav:sidebar:en:published-old' ? [ordinaryLink] : undefined)
    findOne.mockResolvedValue({ key: 'site', config: [{ locale: 'en', items: [] }] })
    vi.spyOn(Navigation, 'query').mockReturnValue({ findOne } as never)
    expect(await Navigation.getTree({ cache: true, locale: 'en' })).toEqual([])
    expect(cacheGet).toHaveBeenCalledWith('nav:sidebar:en:published-new')
    expect(cacheSet).toHaveBeenCalledWith('nav:sidebar:en:published-new', [], 300)
  })
  it('does not serve cached menus for a locale removed by a new publication', async () => {
    Reflect.set(wikiGlobal.WIKI!, 'config', { nav: { revision: 'after-locale-removal' } })
    cacheGet.mockImplementation(key => key === 'nav:sidebar:fr' ? [ordinaryLink] : undefined)
    findOne.mockResolvedValue({ key: 'site', config: [{ locale: 'en', items: [ordinaryLink] }] })
    vi.spyOn(Navigation, 'query').mockReturnValue({ findOne } as never)
    expect(await Navigation.getTree({ cache: true, locale: 'fr' })).toEqual([])
  })
  it('omits unsafe links, empty headings and surplus separators for the actual audience', () => {
    const tree = [divider, header, restrictedVisibleLink, { ...header, id: 'public' }, ordinaryLink, divider, divider, { ...ordinaryLink, id: 'unsafe', targetType: 'external', target: 'javascript:alert(1)' }, divider]
    expect(Navigation.getAuthorizedItems(tree as never, [])).toEqual([{ ...header, id: 'public' }, ordinaryLink])
    expect(Navigation.getAuthorizedItems(tree as never, [7])).toEqual([header, restrictedVisibleLink, { ...header, id: 'public' }, ordinaryLink])
  })
})

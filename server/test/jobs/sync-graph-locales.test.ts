import { beforeEach, afterEach, describe, expect, it, vi } from '../bun-test.mts'
const fetchCatalog = vi.fn(),
  fetchStrings = vi.fn(),
  publish = vi.fn()
vi.mockModule('../../repositories/locale-packages.ts', import.meta.url, () => ({ fetchLocaleCatalog: fetchCatalog, fetchLocaleStrings: fetchStrings }))
vi.mockModule('../../operations/locale-synchronization.ts', import.meta.url, () => ({ publishLocaleSynchronization: publish }))
const originalWiki = globalThis.WIKI
const fr = { code: 'fr', name: 'French', nativeName: 'Français', isRTL: false, availability: 90 }
const ar = { code: 'ar', name: 'Arabic', nativeName: 'العربية', isRTL: true, availability: 85 }
const createWiki = () => ({
  config: { graphEndpoint: 'https://languages.example.test', offline: false, lang: { code: 'fr', autoUpdate: true, namespacing: false, namespaces: [] as string[] } },
  models: {
    knex: vi.fn(() => ({
      select: async () => [
        { code: 'fr', updatedAt: 'before' },
        { code: 'ar', updatedAt: 'before-ar' }
      ]
    }))
  },
  cache: { set: vi.fn() },
  lang: { refreshNamespaces: vi.fn() },
  configSvc: { loadFromDb: vi.fn() },
  events: { outbound: { emit: vi.fn() } },
  logger: { info: vi.fn(), error: vi.fn() }
})
let wiki: ReturnType<typeof createWiki>
beforeEach(() => {
  wiki = createWiki()
  globalThis.WIKI = wiki as never
  fetchCatalog.mockResolvedValue([fr])
  fetchStrings.mockResolvedValue({ common: { title: 'Bonjour' } })
  publish.mockResolvedValue({ changed: ['fr'] })
})
afterEach(() => {
  globalThis.WIKI = originalWiki
})
const load = async () => (await vi.importFresh('../../jobs/sync-graph-locales.ts', import.meta.url)).default
describe('automatic language synchronization', () => {
  it('stages every active package before a guarded publication and activates the committed revision', async () => {
    wiki.config.lang.namespacing = true
    wiki.config.lang.namespaces = ['ar']
    fetchCatalog.mockResolvedValue([fr, ar])
    const stringsGate = Promise.withResolvers<{ common: { title: string } }>()
    const publicationGate = Promise.withResolvers<{ changed: string[] }>()
    fetchStrings.mockResolvedValueOnce({ common: { title: 'Bonjour' } }).mockImplementationOnce(() => stringsGate.promise)
    publish.mockImplementationOnce(() => publicationGate.promise)
    const synchronization = (await load())()
    try {
      await vi.waitFor(() => expect(fetchStrings).toHaveBeenCalledWith(wiki.config.graphEndpoint, 'ar'))
      expect(publish).not.toHaveBeenCalled()
      expect(wiki.cache.set).not.toHaveBeenCalled()
      expect(wiki.configSvc.loadFromDb).not.toHaveBeenCalled()
      expect(wiki.lang.refreshNamespaces).not.toHaveBeenCalled()
      expect(wiki.events.outbound.emit).not.toHaveBeenCalled()
      stringsGate.resolve({ common: { title: 'مرحبا' } })
      await vi.waitFor(() => expect(publish).toHaveBeenCalled())
      expect(publish).toHaveBeenCalledOnce()
      expect(fetchStrings).toHaveBeenCalledWith(wiki.config.graphEndpoint, 'fr')
      expect(publish).toHaveBeenCalledWith(
        wiki.models.knex,
        expect.objectContaining({
          updates: [
            { locale: fr, expectedUpdatedAt: 'before', strings: { common: { title: 'Bonjour' } } },
            { locale: ar, expectedUpdatedAt: 'before-ar', strings: { common: { title: 'مرحبا' } } }
          ]
        })
      )
      expect(wiki.cache.set).not.toHaveBeenCalled()
      expect(wiki.configSvc.loadFromDb).not.toHaveBeenCalled()
      expect(wiki.lang.refreshNamespaces).not.toHaveBeenCalled()
      expect(wiki.events.outbound.emit).not.toHaveBeenCalled()
    } finally {
      stringsGate.resolve({ common: { title: 'مرحبا' } })
      publicationGate.resolve({ changed: ['fr', 'ar'] })
      await synchronization
    }
    expect(wiki.cache.set).toHaveBeenCalledWith('locales', [fr, ar])
    expect(wiki.configSvc.loadFromDb).toHaveBeenCalled()
    expect(wiki.lang.refreshNamespaces).toHaveBeenCalled()
    expect(wiki.events.outbound.emit).toHaveBeenCalledWith('reloadConfig')
  })
  it('preserves installed state if any package fetch fails', async () => {
    wiki.config.lang.namespacing = true
    wiki.config.lang.namespaces = ['ar']
    fetchCatalog.mockResolvedValue([fr, ar])
    fetchStrings.mockResolvedValueOnce({ common: { title: 'Bonjour' } }).mockRejectedValueOnce(new Error('private source details'))
    const synchronization = (await load())()
    await expect(synchronization).rejects.toThrow(Error)
    const failure = await synchronization.catch(error => error)
    expect(failure.message).not.toContain('private source')
    expect(fetchStrings).toHaveBeenCalledWith(wiki.config.graphEndpoint, 'fr')
    expect(fetchStrings).toHaveBeenCalledWith(wiki.config.graphEndpoint, 'ar')
    expect(publish).not.toHaveBeenCalled()
    expect(wiki.cache.set).not.toHaveBeenCalled()
    expect(wiki.configSvc.loadFromDb).not.toHaveBeenCalled()
    expect(wiki.lang.refreshNamespaces).not.toHaveBeenCalled()
    expect(wiki.events.outbound.emit).not.toHaveBeenCalled()
    expect(JSON.stringify(wiki.logger.error.mock.calls)).not.toContain('private source')
  })
  it('refreshes only the catalog when updates are disabled and skips all remote work offline', async () => {
    wiki.config.lang.autoUpdate = false
    publish.mockResolvedValue({ changed: [] })
    await (await load())()
    expect(fetchCatalog).toHaveBeenCalledWith(wiki.config.graphEndpoint)
    expect(publish).toHaveBeenCalledWith(wiki.models.knex, expect.objectContaining({ catalog: [fr], updates: [] }))
    expect(wiki.cache.set).toHaveBeenCalledWith('locales', [fr])
    expect(fetchStrings).not.toHaveBeenCalled()
    expect(wiki.lang.refreshNamespaces).not.toHaveBeenCalled()
    fetchCatalog.mockClear()
    publish.mockClear()
    wiki.cache.set.mockClear()
    wiki.configSvc.loadFromDb.mockClear()
    wiki.lang.refreshNamespaces.mockClear()
    wiki.events.outbound.emit.mockClear()
    wiki.config.offline = true
    await (await load())()
    expect(fetchCatalog).not.toHaveBeenCalled()
    expect(fetchStrings).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(wiki.cache.set).not.toHaveBeenCalled()
    expect(wiki.configSvc.loadFromDb).not.toHaveBeenCalled()
    expect(wiki.lang.refreshNamespaces).not.toHaveBeenCalled()
    expect(wiki.events.outbound.emit).not.toHaveBeenCalled()
  })
  it('retains an installed language absent from the upstream catalog', async () => {
    fetchCatalog.mockResolvedValue([])
    publish.mockResolvedValue({ changed: [] })
    await (await load())()
    expect(fetchStrings).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledWith(wiki.models.knex, expect.objectContaining({ updates: [] }))
  })
})

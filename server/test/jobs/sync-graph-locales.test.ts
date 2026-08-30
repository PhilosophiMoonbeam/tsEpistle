import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const logger = {
  error: vi.fn(),
  info: vi.fn()
}
const cacheSet = vi.fn()
const refreshNamespaces = vi.fn()
const update = vi.fn()
const where = vi.fn()
const query = { update, where }
const wiki = {
  config: {
    graphEndpoint: 'https://graph.example.test/graphql',
    lang: {
      autoUpdate: true,
      namespacing: false,
      namespaces: [],
      code: 'fr'
    }
  },
  logger,
  cache: { set: cacheSet },
  models: { locales: { query: vi.fn(() => query) } },
  lang: { refreshNamespaces }
}
Reflect.set(globalThis, 'WIKI', wiki)

const fetchMock = vi.fn()
Reflect.set(globalThis, 'fetch', fetchMock)

// The jobs capture WIKI at module load, so the test runtime must install its boundary first.
const { default: syncGraphLocales } = await import('../../jobs/sync-graph-locales.ts')

const graphResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK'
  })

const localeListResponse = {
  data: {
    localization: {
      locales: [
        {
          availability: 98,
          code: 'fr',
          isRTL: false,
          name: 'French',
          nativeName: 'Français'
        }
      ]
    }
  }
}

const originalCachedLocales = [
  {
    availability: 50,
    code: 'fr',
    isInstalled: true,
    isRTL: false,
    name: 'Old French',
    nativeName: 'Ancien français'
  }
]

let cachedLocales: unknown
let storedLocale: Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  cachedLocales = structuredClone(originalCachedLocales)
  storedLocale = {
    availability: 50,
    code: 'fr',
    isRTL: false,
    name: 'Old French',
    nativeName: 'Ancien français',
    strings: { greeting: { hello: 'Last known good' } }
  }
  cacheSet.mockImplementation((_key: string, value: unknown) => {
    cachedLocales = value
  })
  update.mockImplementation((value: Record<string, unknown>) => {
    storedLocale = { ...value }
    return query
  })
  where.mockReturnValue(query)
  refreshNamespaces.mockResolvedValue(undefined)
})

describe('sync-graph-locales snapshot replacement', () => {
  it('rejects HTTP 200 GraphQL errors from a locale strings request before replacing cache or stored strings', async () => {
    fetchMock.mockResolvedValueOnce(graphResponse(localeListResponse)).mockResolvedValueOnce(
      graphResponse({
        data: { localization: null },
        errors: [{ message: 'strings unavailable' }]
      })
    )

    await expect(syncGraphLocales()).rejects.toThrow('Graph request failed: strings unavailable')

    expect(cachedLocales).toEqual(originalCachedLocales)
    expect(storedLocale.strings).toEqual({ greeting: { hello: 'Last known good' } })
    expect(cacheSet).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(refreshNamespaces).not.toHaveBeenCalled()
  })

  it('rejects a missing localization strings field before replacing cache or stored strings', async () => {
    fetchMock.mockResolvedValueOnce(graphResponse(localeListResponse)).mockResolvedValueOnce(graphResponse({ data: { localization: {} } }))

    await expect(syncGraphLocales()).rejects.toThrow()

    expect(cachedLocales).toEqual(originalCachedLocales)
    expect(storedLocale.strings).toEqual({ greeting: { hello: 'Last known good' } })
    expect(cacheSet).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects a missing locale-list field without replacing the locale-list cache', async () => {
    fetchMock.mockResolvedValue(graphResponse({ data: { localization: {} } }))

    await expect(syncGraphLocales()).rejects.toThrow()

    expect(cachedLocales).toEqual(originalCachedLocales)
    expect(cacheSet).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('replaces cache and stored strings after the complete snapshot is valid', async () => {
    fetchMock.mockResolvedValueOnce(graphResponse(localeListResponse)).mockResolvedValueOnce(
      graphResponse({
        data: {
          localization: {
            strings: [
              { key: 'greeting:hello', value: 'Bonjour' },
              { key: 'fallback', value: '' }
            ]
          }
        }
      })
    )

    await syncGraphLocales()

    expect(cachedLocales).toEqual([
      {
        availability: 98,
        code: 'fr',
        isInstalled: false,
        isRTL: false,
        name: 'French',
        nativeName: 'Français'
      }
    ])
    expect(storedLocale).toEqual({
      availability: 98,
      code: 'fr',
      isRTL: false,
      name: 'French',
      nativeName: 'Français',
      strings: {
        fallback: 'fallback',
        greeting: { hello: 'Bonjour' }
      }
    })
    expect(cacheSet).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(refreshNamespaces).toHaveBeenCalledOnce()
  })
})

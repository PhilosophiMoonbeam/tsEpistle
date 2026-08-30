import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const logger = {
  error: vi.fn(),
  info: vi.fn()
}
const cacheGet = vi.fn()
const refreshNamespaces = vi.fn()
const first = vi.fn()
const patch = vi.fn()
const insert = vi.fn()
const where = vi.fn()
const query = { first, insert, patch, where }
const wiki = {
  config: { graphEndpoint: 'https://graph.example.test/graphql' },
  logger,
  cache: { get: cacheGet },
  models: { locales: { query: vi.fn(() => query) } },
  lang: { refreshNamespaces }
}
Reflect.set(globalThis, 'WIKI', wiki)

const fetchMock = vi.fn()
Reflect.set(globalThis, 'fetch', fetchMock)

// The job captures WIKI at module load, so the test runtime must install its boundary first.
const { default: fetchGraphLocale } = await import('../../jobs/fetch-graph-locale.ts')

const graphResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable'
  })

let storedStrings: unknown

beforeEach(() => {
  vi.clearAllMocks()
  storedStrings = { greeting: { hello: 'Last known good' } }
  fetchMock.mockReset()
  cacheGet.mockResolvedValue([
    {
      availability: 100,
      code: 'fr',
      isRTL: false,
      name: 'French',
      nativeName: 'Français'
    }
  ])
  first.mockResolvedValue({ code: 'fr' })
  where.mockReturnValue(query)
  patch.mockImplementation((data: Record<string, unknown>) => {
    storedStrings = data.strings
    return query
  })
  insert.mockResolvedValue(undefined)
  refreshNamespaces.mockResolvedValue(undefined)
})

describe('fetch-graph-locale snapshot replacement', () => {
  it('rejects HTTP 200 GraphQL errors without replacing stored strings', async () => {
    fetchMock.mockResolvedValue(
      graphResponse({
        data: { localization: null },
        errors: [{ message: 'upstream failed' }]
      })
    )

    await expect(fetchGraphLocale('fr')).rejects.toThrow('Graph request failed: upstream failed')

    expect(storedStrings).toEqual({ greeting: { hello: 'Last known good' } })
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(refreshNamespaces).not.toHaveBeenCalled()
  })

  it('rejects a missing localization strings field without replacing stored strings', async () => {
    fetchMock.mockResolvedValue(graphResponse({ data: { localization: {} } }))

    await expect(fetchGraphLocale('fr')).rejects.toThrow()

    expect(storedStrings).toEqual({ greeting: { hello: 'Last known good' } })
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(refreshNamespaces).not.toHaveBeenCalled()
  })

  it('rejects a non-2xx response without replacing stored strings', async () => {
    fetchMock.mockResolvedValue(graphResponse({ data: { localization: { strings: [] } } }, 503))

    await expect(fetchGraphLocale('fr')).rejects.toThrow('Network request failed with status 503')

    expect(storedStrings).toEqual({ greeting: { hello: 'Last known good' } })
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('replaces stored strings after a valid snapshot is fully validated', async () => {
    fetchMock.mockResolvedValue(
      graphResponse({
        data: {
          localization: {
            strings: [
              { key: 'greeting:hello', value: 'Bonjour' },
              { key: 'fallback', value: '' },
              { key: 'internal::ignored', value: 'Ignored' }
            ]
          }
        }
      })
    )

    await fetchGraphLocale('fr')

    expect(storedStrings).toEqual({
      fallback: 'fallback',
      greeting: { hello: 'Bonjour' }
    })
    expect(patch).toHaveBeenCalledOnce()
    expect(insert).not.toHaveBeenCalled()
    expect(refreshNamespaces).toHaveBeenCalledOnce()
  })
})

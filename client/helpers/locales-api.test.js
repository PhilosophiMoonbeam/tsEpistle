import { fetchLocales } from './locales-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('locales api helper', () => {
  test('fetches and validates locales list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        availability: 100,
        code: 'en',
        createdAt: '2026-01-01T00:00:00.000Z',
        installDate: '2026-01-01T00:00:00.000Z',
        isInstalled: true,
        isRTL: false,
        name: 'English',
        nativeName: 'English',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]))

    expect(await fetchLocales(fetchImpl)).toEqual([
      {
        availability: 100,
        code: 'en',
        createdAt: '2026-01-01T00:00:00.000Z',
        installDate: '2026-01-01T00:00:00.000Z',
        isInstalled: true,
        isRTL: false,
        name: 'English',
        nativeName: 'English',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/locales', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed rows and unsuccessful or non-JSON locale list responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        availability: '100',
        code: 'en',
        isInstalled: true,
        isRTL: false,
        name: 'English',
        nativeName: 'English'
      }
    ]))

    await expect(Promise.resolve(fetchLocales(fetchImpl, 'Bad locales payload'))).rejects.toThrow('Bad locales payload')

    const apiError = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system is required' }, false))
    await expect(fetchLocales(apiError)).rejects.toThrow('manage:system is required')

    const unsuccessfulList = vi.fn().mockResolvedValue(createJsonResponse([], false))
    await expect(fetchLocales(unsuccessfulList)).rejects.toThrow()

    const json = vi.fn().mockResolvedValue([])
    const nonJson = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/plain' },
      json
    })
    await expect(fetchLocales(nonJson)).rejects.toThrow()
    expect(json).not.toHaveBeenCalled()
  })
})

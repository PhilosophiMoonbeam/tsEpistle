const { fetchLocales, fetchLocaleConfig } = require('./locales-api')

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
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

    await expect(fetchLocales(fetchImpl)).resolves.toEqual([
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

  test('rejects malformed locale rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        availability: '100',
        code: 'en',
        isInstalled: true,
        isRTL: false,
        name: 'English',
        nativeName: 'English'
      }
    ]))

    await expect(fetchLocales(fetchImpl, 'Bad locales payload')).rejects.toThrow('Bad locales payload')
  })

  test('fetches and validates locale config', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      locale: 'en',
      autoUpdate: true,
      namespacing: false,
      namespaces: ['en', 'fr']
    }))

    await expect(fetchLocaleConfig(fetchImpl)).resolves.toEqual({
      locale: 'en',
      autoUpdate: true,
      namespacing: false,
      namespaces: ['en', 'fr']
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/locales/config', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('surfaces API error messages for locale config failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchLocaleConfig(fetchImpl, 'Bad locale config')).rejects.toThrow('manage:system is required')
  })
})

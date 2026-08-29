import { fetchLocales, fetchLocaleConfig, saveLocaleConfig, downloadLocale } from './locales-api.ts'

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

  test('rejects malformed locale rows', async () => {
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
  })

  test('fetches and validates locale config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      locale: 'en',
      autoUpdate: true,
      namespacing: false,
      namespaces: ['en', 'fr']
    }))

    expect(await fetchLocaleConfig(fetchImpl)).toEqual({
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
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(Promise.resolve(fetchLocaleConfig(fetchImpl, 'Bad locale config'))).rejects.toThrow('manage:system is required')
  })

  test('saves locale config with same-origin JSON POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Locale config updated' }))
    const config = {
      locale: 'fr',
      autoUpdate: false,
      namespacing: true,
      namespaces: ['en', 'fr']
    }

    expect(await saveLocaleConfig(fetchImpl, config)).toEqual({ message: 'Locale config updated' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/locales/config', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    })
  })

  test('rejects malformed locale save success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(saveLocaleConfig(fetchImpl, {}, 'Bad locale save'))).rejects.toThrow('Bad locale save')
  })

  test('propagates locale save REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid locale config payload' }, false))

    await expect(Promise.resolve(saveLocaleConfig(fetchImpl, {}, 'Bad locale save'))).rejects.toThrow('Invalid locale config payload')
  })

  test('rejects non-JSON successful locale save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(saveLocaleConfig(fetchImpl, {}, 'Bad locale save content type'))).rejects.toThrow('Bad locale save content type')
  })

  test('downloads locales with same-origin POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Locale downloaded successfully' }))

    expect(await downloadLocale(fetchImpl, 'pt-BR')).toEqual({ message: 'Locale downloaded successfully' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/locales/pt-BR/download', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('encodes locale download path parameters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Locale downloaded successfully' }))

    await downloadLocale(fetchImpl, 'zh Hans')

    expect(fetchImpl.mock.calls[0][0]).toBe('/_api/locales/zh%20Hans/download')
  })

  test('rejects malformed locale download success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(downloadLocale(fetchImpl, 'fr', 'Bad locale download'))).rejects.toThrow('Bad locale download')
  })

  test('propagates locale download REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'download failed' }, false))

    await expect(Promise.resolve(downloadLocale(fetchImpl, 'fr', 'Bad locale download'))).rejects.toThrow('download failed')
  })
})

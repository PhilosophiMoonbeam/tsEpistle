import { fetchAnalyticsProviders, saveAnalyticsProviders } from './analytics-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('analytics api helper', () => {
  test('requests analytics providers with same-origin JSON options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    expect(await fetchAnalyticsProviders(fetchImpl)).toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/analytics/providers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates, sanitizes, and sorts provider config by parsed value order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: [
          {
            key: 'trackingId',
            value: JSON.stringify({ type: 'string', title: 'Tracking ID', order: 2, value: 'example-tracking-id' })
          },
          {
            key: 'anonymizeIp',
            value: JSON.stringify({ type: 'boolean', title: 'Anonymize IP', order: 1, value: false })
          }
        ]
      }
    ]))

    expect(await fetchAnalyticsProviders(fetchImpl)).toEqual([
      {
        isEnabled: true,
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: [
          {
            key: 'anonymizeIp',
            value: { type: 'boolean', title: 'Anonymize IP', order: 1, value: false }
          },
          {
            key: 'trackingId',
            value: { type: 'string', title: 'Tracking ID', order: 2, value: 'example-tracking-id' }
          }
        ]
      }
    ])
  })

  test('strips extra provider and config fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'matomo',
        title: 'Matomo',
        description: 'Matomo analytics provider.',
        isAvailable: true,
        logo: '/matomo.svg',
        website: 'https://matomo.org',
        privateField: 'must-not-return',
        props: { raw: true },
        config: [
          {
            key: 'siteId',
            value: JSON.stringify({ type: 'string', title: 'Site ID', order: 1, value: '2' }),
            rawValue: 'must-not-return'
          }
        ]
      }
    ]))

    expect(await fetchAnalyticsProviders(fetchImpl)).toEqual([
      {
        isEnabled: false,
        key: 'matomo',
        title: 'Matomo',
        description: 'Matomo analytics provider.',
        isAvailable: true,
        logo: '/matomo.svg',
        website: 'https://matomo.org',
        config: [
          {
            key: 'siteId',
            value: { type: 'string', title: 'Site ID', order: 1, value: '2' }
          }
        ]
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ providers: [] }))

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics payload'))).rejects.toThrow('Bad analytics payload')
  })

  test('rejects malformed provider rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: 'yes',
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: []
      }
    ]))

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics row'))).rejects.toThrow('Bad analytics row')
  })

  test('rejects malformed config rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: [{ key: 12, value: '{}' }]
      }
    ]))

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics config'))).rejects.toThrow('Bad analytics config')
  })

  test('rejects malformed config JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: [{ key: 'trackingId', value: '{not-json' }]
      }
    ]))

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics JSON'))).rejects.toThrow('Bad analytics JSON')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics load'))).rejects.toThrow('manage:system is required')
  })

  test('saves analytics providers with same-origin JSON POST options', async () => {
    const providers = [{ key: 'google', isEnabled: true, config: [] }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Providers updated successfully' }))

    expect(await saveAnalyticsProviders(fetchImpl, providers)).toEqual({ message: 'Providers updated successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/analytics/providers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ providers })
    })
  })

  test('rejects malformed successful analytics provider save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(saveAnalyticsProviders(fetchImpl, [], 'Bad save payload'))).rejects.toThrow('Bad save payload')
  })

  test('propagates API JSON errors for analytics provider saves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid analytics providers payload' }, false))

    await expect(Promise.resolve(saveAnalyticsProviders(fetchImpl, [], 'Bad save'))).rejects.toThrow('Invalid analytics providers payload')
  })

  test('rejects non-JSON successful analytics provider save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(saveAnalyticsProviders(fetchImpl, [], 'Bad save content type'))).rejects.toThrow('Bad save content type')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(fetchAnalyticsProviders(fetchImpl, 'Bad analytics content type'))).rejects.toThrow('Bad analytics content type')
  })
})

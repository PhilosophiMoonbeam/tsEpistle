const { fetchLoggingLoggers } = require('./logging-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('logging api helper', () => {
  test('requests logging loggers with same-origin JSON options', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchLoggingLoggers(fetchImpl)).resolves.toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/logging/loggers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates, sanitizes, and sorts logger config by parsed value order', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: [
          {
            key: 'endpoint',
            value: JSON.stringify({ type: 'string', title: 'Endpoint', order: 2, value: 'example-endpoint' })
          },
          {
            key: 'redact',
            value: JSON.stringify({ type: 'boolean', title: 'Redact Values', order: 1, value: true })
          },
          {
            key: 'format',
            value: JSON.stringify({ type: 'string', title: 'Format', value: 'compact' })
          }
        ]
      }
    ]))

    await expect(fetchLoggingLoggers(fetchImpl)).resolves.toEqual([
      {
        isEnabled: true,
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: [
          {
            key: 'redact',
            value: { type: 'boolean', title: 'Redact Values', order: 1, value: true }
          },
          {
            key: 'endpoint',
            value: { type: 'string', title: 'Endpoint', order: 2, value: 'example-endpoint' }
          },
          {
            key: 'format',
            value: { type: 'string', title: 'Format', value: 'compact' }
          }
        ]
      }
    ])
  })

  test('strips extra logger and config fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'beta',
        title: 'Beta Logger',
        description: 'Beta logging provider.',
        logo: '/beta.svg',
        website: 'https://example.test/beta-logger',
        level: 'warn',
        privateField: 'must-not-return',
        props: { raw: true },
        config: [
          {
            key: 'format',
            value: JSON.stringify({ type: 'string', title: 'Format', order: 1, value: 'compact' }),
            rawValue: 'must-not-return'
          }
        ]
      }
    ]))

    await expect(fetchLoggingLoggers(fetchImpl)).resolves.toEqual([
      {
        isEnabled: false,
        key: 'beta',
        title: 'Beta Logger',
        description: 'Beta logging provider.',
        logo: '/beta.svg',
        website: 'https://example.test/beta-logger',
        level: 'warn',
        config: [
          {
            key: 'format',
            value: { type: 'string', title: 'Format', order: 1, value: 'compact' }
          }
        ]
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ loggers: [] }))

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging payload')).rejects.toThrow('Bad logging payload')
  })

  test('rejects malformed logger rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: 'yes',
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: []
      }
    ]))

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging row')).rejects.toThrow('Bad logging row')
  })

  test('rejects malformed config rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: [{ key: 12, value: '{}' }]
      }
    ]))

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging config')).rejects.toThrow('Bad logging config')
  })

  test('rejects malformed config JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: [{ key: 'endpoint', value: '{not-json' }]
      }
    ]))

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging JSON')).rejects.toThrow('Bad logging JSON')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'manage:system is required' })
    })

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchLoggingLoggers(fetchImpl, 'Bad logging content type')).rejects.toThrow('Bad logging content type')
  })
})

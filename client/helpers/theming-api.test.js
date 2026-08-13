import { fetchThemeConfig, saveThemeConfig } from './theming-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

function validConfig (overrides = {}) {
  return {
    theme: 'default',
    iconset: 'mdi',
    darkMode: false,
    tocPosition: 'left',
    injectCSS: '.contents { color: red; }',
    injectHead: '<meta name="test" content="head">',
    injectBody: '<div>body</div>',
    ...overrides
  }
}

describe('theming api helper', () => {
  test('fetches theme config with same-origin JSON options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(validConfig()))

    await expect(fetchThemeConfig(fetchImpl)).resolves.toEqual(validConfig())

    expect(fetchImpl).toHaveBeenCalledWith('/_api/theming/config', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates and sanitizes a valid config payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(validConfig({
      theme: 'custom',
      iconset: 'fa',
      darkMode: true,
      tocPosition: 'right',
      injectCSS: '',
      injectHead: '',
      injectBody: ''
    })))

    await expect(fetchThemeConfig(fetchImpl)).resolves.toEqual({
      theme: 'custom',
      iconset: 'fa',
      darkMode: true,
      tocPosition: 'right',
      injectCSS: '',
      injectHead: '',
      injectBody: ''
    })
  })

  test('strips extra fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(validConfig({
      privateField: 'must-not-return',
      nested: { raw: true }
    })))

    await expect(fetchThemeConfig(fetchImpl)).resolves.toEqual(validConfig())
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchThemeConfig(fetchImpl, 'Bad theme payload')).rejects.toThrow('Bad theme payload')
  })

  test('rejects missing and wrong field types', async () => {
    const malformedPayloads = [
      validConfig({ theme: undefined }),
      validConfig({ iconset: 42 }),
      validConfig({ darkMode: 'false' }),
      validConfig({ tocPosition: null }),
      validConfig({ injectCSS: null }),
      validConfig({ injectHead: false }),
      validConfig({ injectBody: {} })
    ]

    for (const payload of malformedPayloads) {
      const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))
      await expect(fetchThemeConfig(fetchImpl, 'Bad theme field')).rejects.toThrow('Bad theme field')
    }
  })

  test('surfaces JSON API error messages on non-ok responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:theme is required' })
    })

    await expect(fetchThemeConfig(fetchImpl, 'Bad theme load')).rejects.toThrow('manage:theme is required')
  })

  test('rejects successful non-JSON responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchThemeConfig(fetchImpl, 'Bad theme content type')).rejects.toThrow('Bad theme content type')
  })

  test('saves theme config with same-origin JSON POST options', async () => {
    const payload = validConfig({ darkMode: true })
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Theme config updated' }))

    await expect(saveThemeConfig(fetchImpl, payload)).resolves.toEqual({ message: 'Theme config updated' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/theming/config', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  })

  test('rejects malformed theme save success responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(saveThemeConfig(fetchImpl, validConfig(), 'Bad theme save')).rejects.toThrow('Bad theme save')
  })

  test('surfaces JSON API error messages on theme save failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Theme CSS is invalid' }, false))

    await expect(saveThemeConfig(fetchImpl, validConfig(), 'Bad theme save')).rejects.toThrow('Theme CSS is invalid')
  })
})

const { fetchSiteConfig, saveSiteConfig } = require('./site-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: jest.fn().mockResolvedValue(payload)
  }
}

describe('site api helper', () => {
  it('fetches site config with same-origin JSON headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ title: 'Wiki' }))

    const result = await fetchSiteConfig(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/config', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
    expect(result).toEqual({ title: 'Wiki' })
  })

  it('rejects malformed successful site config responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchSiteConfig(fetchImpl, 'Unexpected site config response')).rejects.toThrow('Unexpected site config response')
  })

  it('surfaces JSON REST site config fetch errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'fetch failed' }, false))

    await expect(fetchSiteConfig(fetchImpl)).rejects.toThrow('fetch failed')
  })

  it('saves site config with same-origin JSON PUT', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Site configuration updated successfully' }))
    const config = { title: 'Next Wiki' }

    const result = await saveSiteConfig(fetchImpl, config)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/config', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    })
    expect(result).toEqual({ message: 'Site configuration updated successfully' })
  })

  it('rejects malformed successful site config save responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(saveSiteConfig(fetchImpl, {}, 'Unexpected save response')).rejects.toThrow('Unexpected save response')
  })

  it('surfaces JSON REST site config save errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'save failed' }, false))

    await expect(saveSiteConfig(fetchImpl, {})).rejects.toThrow('save failed')
  })

  it('uses fallback message for non-JSON failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => 'text/plain' }
    })

    await expect(fetchSiteConfig(fetchImpl, 'Site fallback')).rejects.toThrow('Site fallback')
  })
})

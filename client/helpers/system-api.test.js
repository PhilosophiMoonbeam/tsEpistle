const { fetchSystemSummary, fetchSystemInfo, fetchSystemFlags, updateSystemFlags } = require('./system-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('system api helper', () => {
  test('fetches and validates system summary', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    }))

    await expect(fetchSystemSummary(fetchImpl)).resolves.toEqual({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/summary', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('fetches and validates system info summary', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    }))

    await expect(fetchSystemInfo(fetchImpl)).resolves.toEqual({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/info', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system info payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      groupsTotal: '3'
    }))

    await expect(fetchSystemInfo(fetchImpl, 'Bad system info')).rejects.toThrow('Bad system info')
  })

  test('fetches and normalizes system flags', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { key: 'ldapdebug', value: true },
      { key: 'sqllog', value: false }
    ]))

    await expect(fetchSystemFlags(fetchImpl)).resolves.toEqual({
      ldapdebug: true,
      sqllog: false
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/flags', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system flags payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([{ key: 'ldapdebug', value: 'yes' }]))

    await expect(fetchSystemFlags(fetchImpl, 'Bad flags payload')).rejects.toThrow('Bad flags payload')
  })

  test('submits system flags update as xhr JSON and returns parsed message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'System flags applied successfully.' }))

    await expect(updateSystemFlags(fetchImpl, {
      ldapdebug: true,
      sqllog: false
    })).resolves.toEqual({ message: 'System flags applied successfully.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/flags', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        flags: [
          { key: 'ldapdebug', value: true },
          { key: 'sqllog', value: false }
        ]
      })
    })
  })

  test('surfaces API error messages for failed flag updates', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(updateSystemFlags(fetchImpl, { ldapdebug: true }, 'Bad update')).rejects.toThrow('manage:system is required')
  })
})

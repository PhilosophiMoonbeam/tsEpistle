const { fetchSystemSummary, fetchSystemInfo, fetchSystemTelemetry, fetchSystemFlags, fetchSystemExtensions, updateSystemFlags } = require('./system-api')

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

  test('fetches and validates rich system info payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      configFile: '/wiki/config.yml',
      cpuCores: 8,
      currentVersion: '2.0.0',
      dbHost: 'postgres.example.com',
      dbType: 'PostgreSQL',
      dbVersion: '15.4',
      hostname: 'wiki-host',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      nodeVersion: '18.19.0',
      operatingSystem: 'Ubuntu 24.04 LTS',
      platform: 'linux',
      ramTotal: '16 GB',
      upgradeCapable: true,
      workingDirectory: '/srv/wiki'
    }))

    await expect(fetchSystemInfo(fetchImpl)).resolves.toEqual({
      configFile: '/wiki/config.yml',
      cpuCores: 8,
      currentVersion: '2.0.0',
      dbHost: 'postgres.example.com',
      dbType: 'PostgreSQL',
      dbVersion: '15.4',
      hostname: 'wiki-host',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      nodeVersion: '18.19.0',
      operatingSystem: 'Ubuntu 24.04 LTS',
      platform: 'linux',
      ramTotal: '16 GB',
      upgradeCapable: true,
      workingDirectory: '/srv/wiki'
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
      configFile: '/wiki/config.yml',
      cpuCores: '8',
      currentVersion: '2.0.0',
      dbHost: 'postgres.example.com',
      dbType: 'PostgreSQL',
      dbVersion: '15.4',
      hostname: 'wiki-host',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      nodeVersion: '18.19.0',
      operatingSystem: 'Ubuntu 24.04 LTS',
      platform: 'linux',
      ramTotal: '16 GB',
      upgradeCapable: true,
      workingDirectory: '/srv/wiki'
    }))

    await expect(fetchSystemInfo(fetchImpl, 'Bad system info')).rejects.toThrow('Bad system info')
  })

  test('fetches and validates system telemetry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      telemetry: true,
      telemetryClientId: 'client-123',
      privateValue: 'must not be returned by helper'
    }))

    await expect(fetchSystemTelemetry(fetchImpl)).resolves.toEqual({
      telemetry: true,
      telemetryClientId: 'client-123'
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/telemetry', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts null system telemetry client IDs', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      telemetry: false,
      telemetryClientId: null
    }))

    await expect(fetchSystemTelemetry(fetchImpl)).resolves.toEqual({
      telemetry: false,
      telemetryClientId: null
    })
  })

  test('rejects malformed system telemetry payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      telemetry: 'yes',
      telemetryClientId: 'client-123'
    }))

    await expect(fetchSystemTelemetry(fetchImpl, 'Bad telemetry payload')).rejects.toThrow('Bad telemetry payload')
  })

  test('surfaces API error messages for failed telemetry loads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemTelemetry(fetchImpl, 'Bad telemetry load')).rejects.toThrow('manage:system is required')
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

  test('fetches and validates system extensions', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        key: 'alpha',
        title: 'Alpha Extension',
        description: 'Alpha extension description.',
        isInstalled: true,
        isCompatible: false,
        privateValue: 'must not be returned by helper'
      }
    ]))

    await expect(fetchSystemExtensions(fetchImpl)).resolves.toEqual([
      {
        key: 'alpha',
        title: 'Alpha Extension',
        description: 'Alpha extension description.',
        isInstalled: true,
        isCompatible: false
      }
    ])
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/extensions', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system extensions payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        key: 'alpha',
        title: 'Alpha Extension',
        description: 'Alpha extension description.',
        isInstalled: true,
        isCompatible: 'yes'
      }
    ]))

    await expect(fetchSystemExtensions(fetchImpl, 'Bad extensions payload')).rejects.toThrow('Bad extensions payload')
  })

  test('surfaces API error messages for failed extension loads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'manage:system is required' })
    })

    await expect(fetchSystemExtensions(fetchImpl, 'Bad extension load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful extension responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemExtensions(fetchImpl, 'Bad extension load')).rejects.toThrow('Bad extension load')
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

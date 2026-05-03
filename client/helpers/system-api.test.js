const { fetchSystemSummary, fetchSystemInfo, fetchSystemTelemetry, fetchSystemExportStatus, fetchSystemHost, fetchSystemSsl, fetchSystemFlags, fetchSystemExtensions, updateSystemFlags, updateSystemTelemetry, resetSystemTelemetryClientId } = require('./system-api')

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

  test('fetches and validates export status payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      status: 'running',
      progress: 42,
      message: 'Export is running',
      startedAt: '2026-04-25T12:00:00.000Z'
    }))

    await expect(fetchSystemExportStatus(fetchImpl)).resolves.toEqual({
      status: 'running',
      progress: 42,
      message: 'Export is running',
      startedAt: '2026-04-25T12:00:00.000Z'
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/export-status', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('strips extra fields from export status payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      status: 'success',
      progress: 100,
      message: null,
      startedAt: null,
      archivePath: '/private/export.tar.gz',
      entities: ['pages'],
      privateNote: 'must not be returned by helper'
    }))

    await expect(fetchSystemExportStatus(fetchImpl)).resolves.toEqual({
      status: 'success',
      progress: 100,
      message: null,
      startedAt: null
    })
  })

  test.each([
    ['missing root', null],
    ['array root', []]
  ])('rejects malformed export status roots: %s', async (label, payload) => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status')).rejects.toThrow('Bad export status')
  })

  test.each([
    ['status', null],
    ['progress', '42'],
    ['progress', Infinity],
    ['message', false],
    ['startedAt', 123]
  ])('rejects malformed export status field %s', async (field, value) => {
    const payload = {
      status: 'running',
      progress: 42,
      message: 'Export is running',
      startedAt: '2026-04-25T12:00:00.000Z'
    }
    payload[field] = value
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status')).rejects.toThrow('Bad export status')
  })

  test('surfaces API error messages for failed export status loads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful export status responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status load')).rejects.toThrow('Bad export status load')
  })

  test('fetches and validates system host', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      host: 'https://docs.example.test',
      title: 'must not be returned by helper'
    }))

    await expect(fetchSystemHost(fetchImpl)).resolves.toEqual({
      host: 'https://docs.example.test'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/host', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test.each([
    ['missing host', {}],
    ['non-string host', { host: null }],
    ['array root', []]
  ])('rejects malformed system host payloads: %s', async (label, payload) => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemHost(fetchImpl, 'Bad host payload')).rejects.toThrow('Bad host payload')
  })

  test('surfaces API error messages for failed system host loads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemHost(fetchImpl, 'Bad host load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful system host responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemHost(fetchImpl, 'Bad host load')).rejects.toThrow('Bad host load')
  })

  test('fetches and validates SSL status payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      httpPort: 3000,
      httpRedirection: true,
      httpsPort: 3443,
      sslDomain: 'docs.example.test',
      sslExpirationDate: '2026-06-01T00:00:00.000Z',
      sslProvider: 'letsencrypt',
      sslStatus: 'OK',
      sslSubscriberEmail: 'ops@example.test',
      privateValue: 'must not be returned by helper'
    }))

    await expect(fetchSystemSsl(fetchImpl)).resolves.toEqual({
      httpPort: 3000,
      httpRedirection: true,
      httpsPort: 3443,
      sslDomain: 'docs.example.test',
      sslExpirationDate: '2026-06-01T00:00:00.000Z',
      sslProvider: 'letsencrypt',
      sslStatus: 'OK',
      sslSubscriberEmail: 'ops@example.test'
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/ssl', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts nullable SSL status fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      httpPort: 0,
      httpRedirection: false,
      httpsPort: 0,
      sslDomain: null,
      sslExpirationDate: null,
      sslProvider: null,
      sslStatus: 'OK',
      sslSubscriberEmail: null
    }))

    await expect(fetchSystemSsl(fetchImpl)).resolves.toEqual({
      httpPort: 0,
      httpRedirection: false,
      httpsPort: 0,
      sslDomain: null,
      sslExpirationDate: null,
      sslProvider: null,
      sslStatus: 'OK',
      sslSubscriberEmail: null
    })
  })

  test('rejects malformed SSL status payload roots', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL payload')).rejects.toThrow('Bad SSL payload')
  })

  test.each([
    ['httpPort', '3000'],
    ['httpsPort', Infinity],
    ['httpRedirection', 'true'],
    ['sslStatus', null],
    ['sslDomain', false],
    ['sslExpirationDate', 123],
    ['sslProvider', {}],
    ['sslSubscriberEmail', []]
  ])('rejects malformed SSL status field %s', async (field, value) => {
    const payload = {
      httpPort: 3000,
      httpRedirection: false,
      httpsPort: 3443,
      sslDomain: 'docs.example.test',
      sslExpirationDate: '2026-06-01T00:00:00.000Z',
      sslProvider: 'letsencrypt',
      sslStatus: 'OK',
      sslSubscriberEmail: 'ops@example.test'
    }
    payload[field] = value
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL payload')).rejects.toThrow('Bad SSL payload')
  })

  test('surfaces API error messages for failed SSL status loads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful SSL status responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL load')).rejects.toThrow('Bad SSL load')
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

  test('submits telemetry updates as REST JSON and returns parsed message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Telemetry updated successfully.' }))

    await expect(updateSystemTelemetry(fetchImpl, true)).resolves.toEqual({ message: 'Telemetry updated successfully.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/telemetry', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ enabled: true })
    })
  })

  test('rejects malformed telemetry update success payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(updateSystemTelemetry(fetchImpl, false, 'Bad telemetry update')).rejects.toThrow('Bad telemetry update')
  })

  test('surfaces API error messages for failed telemetry updates', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'enabled must be a boolean' }, false))

    await expect(updateSystemTelemetry(fetchImpl, 'yes', 'Bad telemetry update')).rejects.toThrow('enabled must be a boolean')
  })

  test('resets telemetry client IDs through the REST endpoint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Telemetry Client ID reset successfully.' }))

    await expect(resetSystemTelemetryClientId(fetchImpl)).resolves.toEqual({ message: 'Telemetry Client ID reset successfully.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/telemetry/reset-client-id', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('surfaces API error messages for failed telemetry client ID resets', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'reset failed' }, false))

    await expect(resetSystemTelemetryClientId(fetchImpl, 'Bad reset')).rejects.toThrow('reset failed')
  })
})

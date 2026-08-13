import { fetchSystemSummary, fetchSystemInfo, fetchSystemTelemetry, fetchSystemExportStatus, fetchSystemHost, fetchSystemSsl, updateSystemSslRedirection, renewSystemSslCertificate, fetchSystemFlags, fetchSystemExtensions, updateSystemFlags, updateSystemTelemetry, resetSystemTelemetryClientId, flushSystemCache, flushSystemTemporaryUploads, rebuildPageTree, migratePagesToLocale, renderPage, purgePageHistory, performSystemUpgrade, startSystemExport } from './system-api.ts'
import { createProductMetadata } from '../../shared/product.ts'


function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}
const product = createProductMetadata({
  revision: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-08-13T00:00:00.000Z'
})
const summaryPayload = {
  product,
  currentVersion: product.version,
  latestVersion: null,
  latestVersionReleaseDate: null,
  updateStatus: 'unavailable',
  groupsTotal: 3,
  pagesTotal: 42,
  usersTotal: 11,
  tagsTotal: 7
}
const infoPayload = {
  ...summaryPayload,
  configFile: '/wiki/config.yml',
  cpuCores: 8,
  dbHost: 'postgres.example.com',
  dbType: 'PostgreSQL',
  dbVersion: '15.4',
  hostname: 'wiki-host',
  nodeVersion: '24.9.0',
  operatingSystem: 'Ubuntu 24.04 LTS',
  platform: 'linux',
  ramTotal: '16 GB',
  upgradeCapable: false,
  workingDirectory: '/srv/wiki'
}


describe('system api helper', () => {
  test('fetches and validates system summary metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(summaryPayload))

    await expect(fetchSystemSummary(fetchImpl)).resolves.toEqual(summaryPayload)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/summary', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('fetches and validates rich system info payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(infoPayload))

    await expect(fetchSystemInfo(fetchImpl)).resolves.toEqual(infoPayload)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/info', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system info payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      ...infoPayload,
      cpuCores: '8'
    }))

    await expect(fetchSystemInfo(fetchImpl, 'Bad system info')).rejects.toThrow('Bad system info')
  })

  test('rejects a source URL that does not identify the reported revision', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      ...summaryPayload,
      product: {
        ...product,
        sourceUrl: product.sourceRepository
      }
    }))

    await expect(fetchSystemSummary(fetchImpl, 'Bad product metadata')).rejects.toThrow('Bad product metadata')
  })

  test('fetches and validates system telemetry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      telemetry: false,
      telemetryClientId: null
    }))

    await expect(fetchSystemTelemetry(fetchImpl)).resolves.toEqual({
      telemetry: false,
      telemetryClientId: null
    })
  })

  test('rejects malformed system telemetry payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      telemetry: 'yes',
      telemetryClientId: 'client-123'
    }))

    await expect(fetchSystemTelemetry(fetchImpl, 'Bad telemetry payload')).rejects.toThrow('Bad telemetry payload')
  })

  test('surfaces API error messages for failed telemetry loads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemTelemetry(fetchImpl, 'Bad telemetry load')).rejects.toThrow('manage:system is required')
  })

  test('fetches and validates export status payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status')).rejects.toThrow('Bad export status')
  })

  test('surfaces API error messages for failed export status loads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful export status responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemExportStatus(fetchImpl, 'Bad export status load')).rejects.toThrow('Bad export status load')
  })

  test('fetches and validates system host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemHost(fetchImpl, 'Bad host payload')).rejects.toThrow('Bad host payload')
  })

  test('surfaces API error messages for failed system host loads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemHost(fetchImpl, 'Bad host load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful system host responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemHost(fetchImpl, 'Bad host load')).rejects.toThrow('Bad host load')
  })

  test('fetches and validates SSL status payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL payload')).rejects.toThrow('Bad SSL payload')
  })

  test('surfaces API error messages for failed SSL status loads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful SSL status responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemSsl(fetchImpl, 'Bad SSL load')).rejects.toThrow('Bad SSL load')
  })

  test('fetches and normalizes system flags', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ key: 'ldapdebug', value: 'yes' }]))

    await expect(fetchSystemFlags(fetchImpl, 'Bad flags payload')).rejects.toThrow('Bad flags payload')
  })

  test('fetches and validates system extensions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
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
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'manage:system is required' })
    })

    await expect(fetchSystemExtensions(fetchImpl, 'Bad extension load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful extension responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchSystemExtensions(fetchImpl, 'Bad extension load')).rejects.toThrow('Bad extension load')
  })

  test('flushes system cache through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Cache flushed successfully.' }))

    await expect(flushSystemCache(fetchImpl)).resolves.toEqual({ message: 'Cache flushed successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/cache/flush', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system cache flush responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(flushSystemCache(fetchImpl)).rejects.toThrow('Cache flush failed')
  })

  test('surfaces API error messages for failed system cache flushes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'cache denied' }, false))

    await expect(flushSystemCache(fetchImpl)).rejects.toThrow('cache denied')
  })

  test('flushes temporary uploads through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Temporary Uploads flushed successfully.' }))

    await expect(flushSystemTemporaryUploads(fetchImpl)).resolves.toEqual({ message: 'Temporary Uploads flushed successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/cache/temp-uploads/flush', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed temporary uploads flush responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(flushSystemTemporaryUploads(fetchImpl)).rejects.toThrow('Temporary Uploads flush failed')
  })

  test('surfaces API error messages for failed temporary uploads flushes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'uploads denied' }, false))

    await expect(flushSystemTemporaryUploads(fetchImpl)).rejects.toThrow('uploads denied')
  })

  test('rebuilds the page tree through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Page tree rebuilt successfully.' }))

    await expect(rebuildPageTree(fetchImpl)).resolves.toEqual({ message: 'Page tree rebuilt successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/content/rebuild-tree', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed page tree rebuild responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(rebuildPageTree(fetchImpl, 'Bad tree rebuild')).rejects.toThrow('Bad tree rebuild')
  })

  test('surfaces API error messages for page tree rebuild failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'tree backend failed' }, false))

    await expect(rebuildPageTree(fetchImpl, 'Bad tree rebuild')).rejects.toThrow('tree backend failed')
  })

  test('migrates pages to a locale through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      message: 'Migrated content to target locale successfully.',
      count: 3
    }))

    await expect(migratePagesToLocale(fetchImpl, 'en', 'fr')).resolves.toEqual({
      message: 'Migrated content to target locale successfully.',
      count: 3
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/content/migrate-locale', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sourceLocale: 'en',
        targetLocale: 'fr'
      })
    })
  })

  test.each([
    ['missing count', { message: 'Migrated content to target locale successfully.' }],
    ['string count', { message: 'Migrated content to target locale successfully.', count: '3' }],
    ['infinite count', { message: 'Migrated content to target locale successfully.', count: Infinity }],
    ['empty message', { message: '', count: 3 }]
  ])('rejects malformed locale migration response: %s', async (label, payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(migratePagesToLocale(fetchImpl, 'en', 'fr', 'Bad locale migration')).rejects.toThrow('Bad locale migration')
  })

  test('surfaces API error messages for locale migration failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'migration backend failed' }, false))

    await expect(migratePagesToLocale(fetchImpl, 'en', 'fr', 'Bad locale migration')).rejects.toThrow('migration backend failed')
  })

  test('renders pages through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Page rendered successfully.' }))

    await expect(renderPage(fetchImpl, 12)).resolves.toEqual({ message: 'Page rendered successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/content/render-page', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: 12 })
    })
  })

  test('rejects malformed page render success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(renderPage(fetchImpl, 12, 'Bad page render')).rejects.toThrow('Bad page render')
  })

  test('surfaces API error messages for page render failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'render denied' }, false))

    await expect(renderPage(fetchImpl, 12, 'Bad page render')).rejects.toThrow('render denied')
  })

  test('purges page history through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Page history purged successfully.' }))

    await expect(purgePageHistory(fetchImpl, 'P1Y')).resolves.toEqual({ message: 'Page history purged successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/content/purge-history', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ olderThan: 'P1Y' })
    })
  })

  test('rejects malformed page history purge success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(purgePageHistory(fetchImpl, 'P1Y', 'Bad page history purge')).rejects.toThrow('Bad page history purge')
  })

  test('surfaces API error messages for page history purge failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'purge denied' }, false))

    await expect(purgePageHistory(fetchImpl, 'P1Y', 'Bad page history purge')).rejects.toThrow('purge denied')
  })

  test('submits system flags update as xhr JSON and returns parsed message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'System flags applied successfully.' }))

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
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(updateSystemFlags(fetchImpl, { ldapdebug: true }, 'Bad update')).rejects.toThrow('manage:system is required')
  })

  test('submits telemetry updates as REST JSON and returns parsed message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Telemetry updated successfully.' }))

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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(updateSystemTelemetry(fetchImpl, false, 'Bad telemetry update')).rejects.toThrow('Bad telemetry update')
  })

  test('surfaces API error messages for failed telemetry updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'enabled must be a boolean' }, false))

    await expect(updateSystemTelemetry(fetchImpl, 'yes', 'Bad telemetry update')).rejects.toThrow('enabled must be a boolean')
  })

  test('resets telemetry client IDs through the REST endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Telemetry Client ID reset successfully.' }))

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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'reset failed' }, false))

    await expect(resetSystemTelemetryClientId(fetchImpl, 'Bad reset')).rejects.toThrow('reset failed')
  })

  test('performs system upgrade with same-origin POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Upgrade has started.' }))

    await expect(performSystemUpgrade(fetchImpl)).resolves.toEqual({ message: 'Upgrade has started.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/upgrade', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed system upgrade success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(performSystemUpgrade(fetchImpl, 'Bad upgrade payload')).rejects.toThrow('Bad upgrade payload')
  })

  test('propagates system upgrade REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'companion missing' }, false))

    await expect(performSystemUpgrade(fetchImpl, 'Bad upgrade')).rejects.toThrow('companion missing')
  })

  test('updates SSL redirection through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'HTTP Redirection state set successfully.' }))

    await expect(updateSystemSslRedirection(fetchImpl, true)).resolves.toEqual({ message: 'HTTP Redirection state set successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/ssl/redirection', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ enabled: true })
    })
  })

  test('rejects malformed SSL redirection update responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: '' }))

    await expect(updateSystemSslRedirection(fetchImpl, false, 'Bad SSL redirection')).rejects.toThrow('Bad SSL redirection')
  })

  test('surfaces API error messages for failed SSL redirection updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'enabled must be a boolean' }, false))

    await expect(updateSystemSslRedirection(fetchImpl, 'yes', 'Bad SSL redirection')).rejects.toThrow('enabled must be a boolean')
  })

  test('renews SSL certificates through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'SSL Certificate renewed successfully.' }))

    await expect(renewSystemSslCertificate(fetchImpl)).resolves.toEqual({ message: 'SSL Certificate renewed successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/ssl/renew', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed SSL certificate renewal responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(renewSystemSslCertificate(fetchImpl, 'Bad SSL renew')).rejects.toThrow('Bad SSL renew')
  })

  test('surfaces API error messages for failed SSL certificate renewals', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'SSL is disabled' }, false))

    await expect(renewSystemSslCertificate(fetchImpl, 'Bad SSL renew')).rejects.toThrow('SSL is disabled')
  })

  test('starts system export with same-origin JSON POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Export started successfully.' }))
    const entities = ['pages', 'assets']

    await expect(startSystemExport(fetchImpl, entities, './data/export')).resolves.toEqual({ message: 'Export started successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/system/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ entities, path: './data/export' })
    })
  })

  test('rejects malformed system export success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(startSystemExport(fetchImpl, ['pages'], './data/export', 'Bad export start')).rejects.toThrow('Bad export start')
  })

  test('propagates system export REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Target directory must be empty!' }, false))

    await expect(startSystemExport(fetchImpl, ['pages'], './data/export', 'Bad export start')).rejects.toThrow('Target directory must be empty!')
  })
})

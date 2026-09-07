import { fetchSystemHost, fetchSystemInfo, fetchSystemSummary, performSystemUpgrade, renderPage } from './system-api.ts'

const response = (payload, ok = true) => ({
  ok,
  json: async () => payload
})

const product = {
  name: 'Atlas Docs',
  version: '7.4.2',
  description: 'Documentation for the Atlas platform',
  sourceRepository: 'https://code.example.test/atlas/docs',
  containerRepository: 'registry.example.test/atlas/docs',
  upstreamName: 'Atlas Core',
  upstreamVersion: '6.9.0',
  independentFork: true,
  modifiedAt: '2026-08-13',
  revision: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-08-13T00:00:00.000Z',
  upstreamBase: 'Atlas Core 6.9.0',
  sourceUrl: 'https://code.example.test/atlas/docs/tree/0123456789abcdef0123456789abcdef01234567'
}
const summary = {
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
const info = {
  ...summary,
  configFile: '/srv/wiki/config.yml',
  cpuCores: 8,
  dbHost: '127.0.0.1',
  dbType: 'PostgreSQL',
  dbVersion: '17.1',
  hostname: 'atlas',
  bunVersion: '1.2.0',
  operatingSystem: 'Linux',
  platform: 'linux',
  ramTotal: '32 GB',
  workingDirectory: '/srv/wiki',
  upgradeCapable: false
}

describe('system api helper', () => {
  test('accepts a complete public summary and rejects a product-version mismatch', async () => {
    await expect(fetchSystemSummary(async () => response(summary))).resolves.toEqual(summary)
    await expect(fetchSystemSummary(async () => response({ ...summary, currentVersion: '7.4.1' }), 'Bad summary')).rejects.toThrow('Bad summary')
  })

  test('requires every detailed observation expected by the Administration overview', async () => {
    await expect(fetchSystemInfo(async () => response(info))).resolves.toEqual(info)
    const { hostname, ...missingHostname } = info
    await expect(fetchSystemInfo(async () => response(missingHostname), 'Bad info')).rejects.toThrow('Bad info')
  })

  test('surfaces server error messages for protected observations', async () => {
    await expect(fetchSystemHost(async () => response({ error: 'System administration is required.' }, false), 'Host failed')).rejects.toThrow(
      'System administration is required.'
    )
  })

  test('uses same-origin JSON requests for retained page rendering and upgrade endpoints', async () => {
    const requests = []
    const fetchImpl = async (input, init) => {
      requests.push({ input, init })
      return response({ message: 'accepted' })
    }
    await expect(renderPage(fetchImpl, 42)).resolves.toEqual({ message: 'accepted' })
    await expect(performSystemUpgrade(fetchImpl)).resolves.toEqual({ message: 'accepted' })
    expect(requests).toEqual([
      {
        input: '/_api/system/content/render-page',
        init: expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ id: 42 }) })
      },
      {
        input: '/_api/system/upgrade',
        init: expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
      }
    ])
  })
})

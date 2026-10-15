import { fetchSystemSummary, renderPage } from './system-api.ts'

const response = (payload, status = 200) => Response.json(payload, { status })

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
  tagsTotal: 7,
  assetsTotal: null,
  assetsBytes: null,
  commentsTotal: null
}

describe('system api helper', () => {
  test('rejects inconsistent product versions and nonnumeric protected metrics', async () => {
    await expect(fetchSystemSummary(async () => response({ ...summary, currentVersion: '7.4.1' }))).rejects.toThrow()
    await expect(fetchSystemSummary(async () => response({ ...summary, assetsBytes: '1024' }))).rejects.toThrow()
  })

  test('rejects HTTP success without durable render admission', async () => {
    const receipt = {
      message: 'Page render accepted.',
      effectId: 'effect-42',
      pageId: 42,
      sourceRevision: '7',
      statusUrl: '/_api/system/content/render-page/status/effect-42'
    }
    await expect(renderPage(async () => response(receipt, 200), 42)).rejects.toThrow()
  })
})

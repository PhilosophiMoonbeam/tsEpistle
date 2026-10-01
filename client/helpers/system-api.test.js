import { fetchRenderPageStatus, fetchSystemSummary, renderPage } from './system-api.ts'

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
  tagsTotal: 7
}

describe('system api helper', () => {
  test('accepts a complete public summary and rejects a product-version mismatch', async () => {
    await expect(fetchSystemSummary(async () => response(summary))).resolves.toEqual(summary)
    await expect(fetchSystemSummary(async () => response({ ...summary, currentVersion: '7.4.1' }), 'Bad summary')).rejects.toThrow('Bad summary')
  })

  test('surfaces server error messages for protected observations', async () => {
    await expect(fetchSystemSummary(async () => response({ error: 'System administration is required.' }, 403), 'Summary failed')).rejects.toThrow(
      'System administration is required.'
    )
  })

  test('uses same-origin JSON requests and requires accepted render admission before polling status', async () => {
    const requests = []
    const receipt = {
      message: 'Page render accepted.',
      effectId: 'effect-42',
      pageId: 42,
      sourceRevision: '7',
      statusUrl: '/_api/system/content/render-page/status/effect-42'
    }
    const status = { effectId: 'effect-42', pageId: 42, sourceRevision: '7', status: 'succeeded', result: {}, postcondition: {} }
    const fetchImpl = async (input, init) => {
      requests.push({ input, init })
      if (input === receipt.statusUrl) return response(status, 200)
      if (input === '/_api/system/content/render-page') return response(receipt, 202)
      throw new Error(`Unexpected request: ${input}`)
    }
    await expect(renderPage(fetchImpl, 42)).resolves.toEqual(receipt)
    await expect(fetchRenderPageStatus(fetchImpl, receipt.statusUrl)).resolves.toEqual(status)
    await expect(renderPage(async () => response(receipt, 200), 42, 'Render admission failed')).rejects.toThrow('Render admission failed')
    expect(requests).toEqual([
      {
        input: '/_api/system/content/render-page',
        init: expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 42 })
        })
      },
      {
        input: receipt.statusUrl,
        init: expect.objectContaining({
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        })
      }
    ])
  })
})

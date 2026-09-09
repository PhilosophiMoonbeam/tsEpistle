import { describe, expect, test, vi } from '../../server/test/bun-test.mts'
import { themePolicyFromConfiguration } from '../../shared/theme-policy.ts'
import { fetchThemeWorkspace } from './theme-workspace-api.ts'

const response = payload => ({
  ok: true,
  headers: { get: () => 'application/json; charset=utf-8' },
  json: async () => payload
})
const workspace = capabilities => ({
  policy: themePolicyFromConfiguration({}),
  fingerprint: 'review-one',
  history: [],
  runtime: { state: 'applied', observedAt: '2026-09-08T00:00:00.000Z' },
  capabilities
})

describe('theme workspace capability client', () => {
  test('accepts the server-derived custom code capability for delegated administrators', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(workspace({ editCustomCode: false })))
    globalThis.window = { fetch: fetchImpl }
    const result = await fetchThemeWorkspace()
    expect(result.capabilities).toEqual({ editCustomCode: false })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/theming/workspace', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  test('rejects workspace responses that omit the authority capability', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(workspace(undefined)))
    globalThis.window = { fetch: fetchImpl }
    await expect(fetchThemeWorkspace()).rejects.toThrow('invalid settings')
  })
})

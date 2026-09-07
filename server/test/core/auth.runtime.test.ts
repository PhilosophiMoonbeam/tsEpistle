import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const originalWiki = globalThis.WIKI
const getStrategies = vi.fn()
const { default: auth } = await vi.importFresh('../../core/auth.ts', import.meta.url)

afterAll(() => {
  globalThis.WIKI = originalWiki
})

beforeEach(() => {
  getStrategies.mockReset()
  globalThis.WIKI = {
    config: {
      api: { isEnabled: true },
      auth: { audience: 'urn:test', tokenExpiration: '30m', tokenRenewal: '15m' },
      certs: { public: 'fixture-public-key', private: 'fixture-private-key' },
      features: { featurePageComments: false },
      host: 'https://wiki.example.invalid',
      sessionSecret: 'fixture-root'
    },
    configSvc: {},
    events: {},
    lang: {},
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    models: { authentication: { getStrategies } },
    startedAt: {}
  } as never
})

describe('strict authentication runtime activation', () => {
  it('keeps ordinary reloads observable but rejects a strict rotation activation failure', async () => {
    getStrategies.mockRejectedValue(new Error('private provider failure'))

    await expect(auth.activateStrategies()).resolves.toBeUndefined()
    await expect(auth.activateStrategies(true)).rejects.toThrow('Authentication strategies could not be activated.')
    expect(globalThis.WIKI.logger.error).toHaveBeenCalled()
  })
})

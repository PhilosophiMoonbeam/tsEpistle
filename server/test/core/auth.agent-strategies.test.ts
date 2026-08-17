/** @vitest-environment node */

import auth from '../../core/auth.ts'
import { DateTime } from 'luxon'

const strategyInit = vi.hoisted(() => vi.fn((passportInstance, config) => {
  passportInstance.use(config.key, { authenticate: vi.fn() })
}))

vi.mock('../../modules/authentication/github/authentication.ts', () => ({
  default: { init: strategyInit }
}))


describe('isolated agents authentication strategies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.WIKI = {
      config: {
        api: { isEnabled: false },
        agents: {
          publicOrigin: 'https://agents.example.test',
          cookieAudience: 'wiki-agents-ui'
        },
        auth: {
          audience: 'urn:wiki:test',
          tokenExpiration: '30m',
          tokenRenewal: '15m'
        },
        certs: { private: '', public: 'test-public-key' },
        features: { featurePageComments: true },
        host: 'https://wiki.example.test',
        sessionSecret: 'test'
      },
      configSvc: { saveToDb: vi.fn() },
      events: {
        inbound: { on: vi.fn() },
        outbound: { emit: vi.fn() }
      },
      lang: { t: vi.fn() },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {
        apiKeys: { query: vi.fn() },
        authentication: {
          getStrategies: vi.fn().mockResolvedValue([{
            config: { clientId: 'public-id', clientSecret: 'test-secret' },
            displayName: 'GitHub',
            key: 'github',
            strategyKey: 'github'
          }])
        },
        groups: { query: vi.fn() },
        users: {
          getGuestUser: vi.fn(),
          query: vi.fn(),
          refreshToken: vi.fn()
        }
      },
      startedAt: DateTime.utc().minus({ days: 1 })
    }
  })

  it('registers distinct ordinary and agents callbacks and namespaces', async () => {
    await auth.activateStrategies()

    expect(strategyInit).toHaveBeenCalledTimes(2)
    expect(strategyInit.mock.calls[0]?.[1]).toMatchObject({
      audience: 'urn:wiki:test',
      callbackURL: 'https://wiki.example.test/login/github/callback',
      cookieName: 'jwt',
      key: 'github',
      sessionNamespace: 'wiki'
    })
    expect(strategyInit.mock.calls[1]?.[1]).toMatchObject({
      audience: 'wiki-agents-ui',
      callbackURL: 'https://agents.example.test/auth/login/github/callback',
      cookieName: 'wiki_agents',
      key: 'agents:github',
      sessionNamespace: 'wiki-agents'
    })
    expect(auth.strategies.github?.key).toBe('github')
    expect(auth.agentStrategies.github?.key).toBe('agents:github')
  })
})

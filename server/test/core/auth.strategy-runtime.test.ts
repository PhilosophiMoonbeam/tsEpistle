import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const originalWiki = globalThis.WIKI,
  use = vi.fn(),
  unuse = vi.fn(),
  initialize = vi.fn(),
  getStrategies = vi.fn()
const passport = { _strategies: { session: {}, jwt: {}, old: {} }, use, unuse }
let sharedPluginConfig = { sentinel: 'shared-plugin-configuration' }
const localPlugin = { init: initialize, config: sharedPluginConfig }
vi.mockModule('passport', import.meta.url, () => ({ default: passport }))
vi.mockModule('../../helpers/security.ts', import.meta.url, () => ({ default: { extractJWT: () => null } }))
vi.mockModule('passport-jwt', import.meta.url, () => ({ default: { Strategy: class {} } }))
vi.mockModule('../../modules/authentication/local/authentication.ts', import.meta.url, () => ({ default: localPlugin }))
const { default: auth } = await vi.importFresh('../../core/auth.ts', import.meta.url)
const row = (key = 'local', overrides = {}) => ({
  key,
  strategyKey: 'local',
  displayName: key,
  isEnabled: true,
  adminRevision: 'review-one',
  config: {},
  ...overrides
})
beforeEach(() => {
  initialize.mockReset()
  getStrategies.mockReset()
  use.mockReset()
  unuse.mockClear()
  sharedPluginConfig = { sentinel: 'shared-plugin-configuration' }
  localPlugin.config = sharedPluginConfig
  globalThis.WIKI = {
    config: { host: 'https://wiki.example.invalid', auth: { audience: 'workspace' }, certs: { public: 'fixture-public-key' } },
    configSvc: {},
    events: {},
    lang: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    models: { authentication: { getStrategies } },
    startedAt: {}
  } as never
})
afterAll(() => {
  globalThis.WIKI = originalWiki
})
describe('authentication runtime observations', () => {
  it('initializes enabled providers, skips disabled modules and records exact revisions without config values', async () => {
    getStrategies.mockResolvedValue([row(), row('disabled', { strategyKey: 'missing-disabled-module', isEnabled: false, config: { secret: 'private-value' } })])
    await auth.activateStrategies()
    expect(initialize).toHaveBeenCalledOnce()
    expect(auth.jwtAudience).toBe('workspace')
    expect(auth.strategyHost).toBe('https://wiki.example.invalid')
    expect(auth.strategyStatus.local).toMatchObject({ state: 'ready', revision: 'review-one' })
    expect(auth.strategyStatus.disabled?.state).toBe('disabled')
    expect(auth.strategies.disabled).toBeUndefined()
    expect(JSON.stringify(auth.strategyStatus)).not.toContain('private-value')
    expect(unuse).toHaveBeenCalledWith('old')
    expect(unuse).not.toHaveBeenCalledWith('session')
  })
  it('clears the observed JWT audience when registration fails', async () => {
    getStrategies.mockResolvedValue([row()])
    await auth.activateStrategies()
    use.mockImplementationOnce(() => {
      throw new Error('Cannot register JWT validation')
    })
    await auth.activateStrategies()
    expect(auth.jwtAudience).toBeNull()
    expect(auth.strategyHost).toBeNull()
  })
  it('registers callbacks from one captured origin and exposes that origin for runtime checks', async () => {
    getStrategies.mockResolvedValue([row('first'), row('second')])
    initialize.mockImplementationOnce(() => { globalThis.WIKI.config.host = 'https://next.example.invalid' })
    await auth.activateStrategies()
    expect(auth.strategyHost).toBe('https://wiki.example.invalid')
    expect(initialize.mock.calls[0]?.[1].callbackURL).toBe('https://wiki.example.invalid/login/first/callback')
    expect(initialize.mock.calls[1]?.[1].callbackURL).toBe('https://wiki.example.invalid/login/second/callback')
    await auth.activateStrategies()
    expect(auth.strategyHost).toBe('https://next.example.invalid')
    expect(initialize.mock.calls[3]?.[1].callbackURL).toBe('https://next.example.invalid/login/second/callback')
  })
  it('records failed initialization separately from saved enablement and removes partial registrations', async () => {
    getStrategies.mockResolvedValue([row('broken')])
    initialize.mockRejectedValue(new Error('private upstream diagnostic'))
    await auth.activateStrategies()
    expect(auth.strategyStatus.broken?.state).toBe('failed')
    expect(auth.strategies.broken).toBeUndefined()
    expect(unuse).toHaveBeenCalledWith('broken')
    expect(JSON.stringify(auth.strategyStatus)).not.toContain('private upstream diagnostic')
  })
  it('preserves a provider-specific audience and does not mutate the shared plugin configuration', async () => {
    getStrategies.mockResolvedValue([row('first', { config: { audience: 'provider-audience' } }), row('second')])
    await auth.activateStrategies()
    expect(initialize.mock.calls[0]?.[1].audience).toBe('provider-audience')
    expect(initialize.mock.calls[1]?.[1].audience).toBe('workspace')
    expect(auth.strategies.first?.config.key).toBe('first')
    expect(auth.strategies.second?.config.key).toBe('second')
    expect(localPlugin.config).toBe(sharedPluginConfig)
    expect(localPlugin.config).toEqual({ sentinel: 'shared-plugin-configuration' })
  })
  it('serializes concurrent reloads so an older initializer cannot overwrite the latest policy', async () => {
    let release: () => void = () => {},
      started: () => void = () => {}
    const beginning = new Promise<void>(resolve => {
      started = resolve
    })
    initialize.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
          started()
        })
    )
    getStrategies.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row('new', { adminRevision: 'review-two' })])
    const first = auth.activateStrategies()
    await beginning
    const second = auth.activateStrategies()
    expect(getStrategies).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    expect(getStrategies).toHaveBeenCalledTimes(2)
    expect(auth.strategies.local).toBeUndefined()
    expect(auth.strategyStatus.new).toMatchObject({ state: 'ready', revision: 'review-two' })
  })
})

import { randomUUID } from 'node:crypto'
import Keypairs from '@root/keypairs'
import type { AcmeCertificate } from 'acme'
import type { RootKeypair } from '@root/keypairs'
import { createLetsEncryptService } from '../../core/letsencrypt.ts'
import { AcmeStateError, type AcmeSavedState, AcmeStateSnapshot, AcmeStateStore } from '../../repositories/acme-state.ts'
import { describeTlsCertificate } from '../../repositories/tls-material.ts'
import { tlsFixture } from '../helpers/tls-fixture.ts'
let fixture: ReturnType<typeof tlsFixture>, accountKeypair: RootKeypair
beforeAll(async () => {
  fixture = tlsFixture(90)
  accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' })
})
afterAll(() => fixture.close())
const payload = (): AcmeCertificate => ({
  cert: fixture.first.cert,
  chain: '',
  expires: '2050-01-01T00:00:00.000Z',
  identifiers: [{ type: 'dns', value: 'wiki.example.test' }]
})
const original = (): AcmeSavedState => ({
  account: { key: { kid: 'fixture-account' } },
  accountKeypair,
  serverKey: fixture.first.key,
  opaque: { retained: true }
})
const setup = (initial = original()) => {
  let current: AcmeStateSnapshot = { value: structuredClone(initial), token: 'initial' }
  const persisted: AcmeSavedState[] = []
  const store: AcmeStateStore = {
    read: vi.fn(async () => structuredClone(current)),
    save: vi.fn(async (expected, value) => {
      if (expected.token !== current.token) throw new AcmeStateError('Saved ACME state changed. Reload before requesting another certificate.')
      current = { value: structuredClone(value), token: randomUUID() }
      persisted.push(structuredClone(value))
      return structuredClone(current)
    }),
    exclusive: vi.fn(async task => task(async () => {}))
  }
  const client = {
    init: vi.fn(async () => ({})),
    accounts: { create: vi.fn(async () => ({ key: { kid: 'new-fixture-account' } })) },
    certificates: { create: vi.fn(async () => payload()) }
  }
  const deployment = { enabled: true, provider: 'letsencrypt', domain: 'wiki.example.test', subscriberEmail: 'admin@example.test', offline: false }
  const publish = vi.fn(),
    configureTls = vi.fn(),
    logger = { info: vi.fn(), warn: vi.fn() },
    createClient = vi.fn(() => client)
  let clock = Date.now()
  const service = createLetsEncryptService({
    now: () => clock,
    state: store,
    deployment: () => deployment,
    maintainerEmail: 'fixture@example.test',
    version: 'fixture',
    staging: true,
    publish,
    configureTls,
    logger,
    createClient
  })
  return {
    service,
    store,
    persisted,
    client,
    deployment,
    publish,
    configureTls,
    logger,
    createClient,
    current: () => current,
    advance: (ms: number) => {
      clock += ms
    }
  }
}
describe('ACME issuance and saved certificate lifecycle', () => {
  it('validates and saves the actual certificate separately from listener application', async () => {
    const test = setup(),
      certificate = await test.service.requestCertificate()
    expect(test.client.init).toHaveBeenCalledWith('https://acme-staging-v02.api.letsencrypt.org/directory')
    expect(test.client.accounts.create).not.toHaveBeenCalled()
    expect(certificate.subjectAlternativeNames).toContain('DNS:wiki.example.test')
    expect(test.current().value.payload?.expires).toBe(certificate.validUntil)
    expect(test.current().value.payload?.expires).not.toBe('2050-01-01T00:00:00.000Z')
    expect(test.current().value.opaque).toEqual({ retained: true })
    expect(test.configureTls).not.toHaveBeenCalled()
    expect(test.service.challenge).toBeNull()
    expect(JSON.stringify(certificate)).not.toContain('PRIVATE KEY')
  })
  it('persists key identity before account creation and reuses it after an uncertain account response', async () => {
    const test = setup({})
    let observedBeforeAccount: AcmeSavedState | null = null
    test.client.accounts.create.mockImplementationOnce(async () => {
      observedBeforeAccount = structuredClone(test.current().value)
      throw new Error('private-provider-response')
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(observedBeforeAccount).toHaveProperty('accountKeypair.private')
    expect(observedBeforeAccount).toHaveProperty('serverKey', test.current().value.serverKey)
    const keys = structuredClone(test.current().value)
    // Stop before issuance: the returned fixture uses a different server key from newly generated material.
    test.client.certificates.create.mockRejectedValueOnce(new Error('fixture stop'))
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(test.current().value.accountKeypair).toEqual(keys.accountKeypair)
    expect(test.current().value.serverKey).toBe(keys.serverKey)
    expect(test.client.accounts.create.mock.calls[0]![0].accountKey).toEqual(test.client.accounts.create.mock.calls[1]![0].accountKey)
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain('private-provider-response')
  })
  it('keeps prior certificate state when final persistence fails', async () => {
    const prior = { ...original(), payload: payload() },
      test = setup(prior)
    test.store.save = vi.fn(async () => {
      throw new Error('database-private-detail')
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(test.current().value).toEqual(prior)
    expect(test.publish).not.toHaveBeenCalled()
    expect(test.configureTls).not.toHaveBeenCalled()
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain('database-private-detail')
  })
  it('rejects a mismatched certificate/key without publishing or saving it', async () => {
    const test = setup()
    test.client.certificates.create.mockResolvedValueOnce({ ...payload(), cert: fixture.second.cert })
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(test.store.save).not.toHaveBeenCalled()
    expect(test.publish).not.toHaveBeenCalled()
  })
  it('rejects a certificate for a different configured hostname', async () => {
    const test = setup()
    test.deployment.domain = 'other.example.test'
    await expect(test.service.requestCertificate()).rejects.toThrow('does not match')
    expect(test.store.save).not.toHaveBeenCalled()
  })
  it('does not revive saved challenge values, exposes only the active challenge, and clears it on failure', async () => {
    const test = setup({ ...original(), challenge: { token: 'old-token', keyAuthorization: 'old-secret' } })
    expect(test.service.challenge).toBeNull()
    let callbackVerified = false
    test.client.certificates.create.mockImplementationOnce(async options => {
      const handler = options.challenges['http-01'],
        challenge = {
          type: 'http-01',
          altname: 'wiki.example.test',
          hostname: 'wiki.example.test',
          token: 'live-token',
          keyAuthorization: 'live-public-authorization',
          url: 'https://ca.example.test/challenge'
        }
      handler.set!({ challenge })
      const observed = test.service.challenge!
      expect(observed.token).toBe('live-token')
      observed.token = 'mutated-copy'
      expect(test.service.challenge?.token).toBe('live-token')
      expect(await handler.get!({ challenge: { ...challenge, token: 'wrong-token' } })).toBeNull()
      expect(await handler.get!({ challenge })).toMatchObject({ token: 'live-token' })
      callbackVerified = true
      throw new Error('fixture challenge failed')
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(callbackVerified).toBe(true)
    expect(test.service.challenge).toBeNull()
  })
  it('blocks overlapping local requests and clears the guard when the first request finishes', async () => {
    const test = setup()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => {
        release = resolve
      }),
      waiting = new Promise<void>(resolve => {
        entered = resolve
      })
    test.client.init.mockImplementationOnce(async () => {
      entered()
      await gate
      return {}
    })
    const first = test.service.requestCertificate()
    await waiting
    await expect(test.service.requestCertificate()).rejects.toThrow('already in progress')
    release()
    await first
    await expect(test.service.requestCertificate()).resolves.toMatchObject({ subject: 'CN=wiki.example.test' })
  })
  it('checks offline mode and current authority before external effects', async () => {
    const test = setup()
    test.deployment.offline = true
    await expect(test.service.requestCertificate()).rejects.toThrow('offline mode')
    expect(test.createClient).not.toHaveBeenCalled()
    test.deployment.offline = false
    await expect(
      test.service.requestCertificate(async () => {
        throw new Error('revoked authority')
      })
    ).rejects.toThrow('could not be confirmed')
    expect(test.createClient).not.toHaveBeenCalled()
  })
  it('stops after a deployment change without replacing the saved certificate', async () => {
    const test = setup()
    test.client.certificates.create.mockImplementationOnce(async () => {
      test.deployment.domain = 'changed.example.test'
      return payload()
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('settings changed')
    expect(test.store.save).not.toHaveBeenCalled()
    expect(test.configureTls).not.toHaveBeenCalled()
  })
  it('uses a valid saved certificate at startup even when provider expiry metadata is stale and offline mode is on', async () => {
    const test = setup({ ...original(), payload: { ...payload(), expires: '2000-01-01T00:00:00.000Z' } })
    test.deployment.offline = true
    await test.service.init()
    expect(test.createClient).not.toHaveBeenCalled()
    expect(test.configureTls).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'pem', inline: true, key: fixture.first.key, cert: fixture.first.cert + '\n' })
    )
    expect(describeTlsCertificate(fixture.first.cert).daysRemaining).toBeGreaterThan(5)
  })
  it('does not log raw authority notification payloads', async () => {
    const test = setup()
    await test.service.requestCertificate()
    const options = test.createClient.mock.calls[0]![0]
    options.notify('error', { secret: 'fixture-account-private-key' })
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain('fixture-account-private-key')
  })
  it('does not treat provider error text as a trusted application error', async () => {
    const test = setup()
    test.client.certificates.create.mockRejectedValueOnce(new Error('Configure a valid private-provider-account-secret'))
    await expect(test.service.requestCertificate()).rejects.toThrow('Certificate issuance or persistence could not be confirmed.')
  })
  it('expires active HTTP challenges and hides them after deployment or offline changes', async () => {
    const test = setup()
    let callbackVerified = false
    test.client.certificates.create.mockImplementationOnce(async options => {
      const handler = options.challenges['http-01'],
        challenge = {
          type: 'http-01',
          altname: 'wiki.example.test',
          hostname: 'wiki.example.test',
          token: 'current-token',
          keyAuthorization: 'public-authorization',
          url: 'https://ca.example.test/challenge'
        }
      handler.set!({ challenge })
      expect(test.service.challenge?.token).toBe('current-token')
      test.deployment.offline = true
      expect(test.service.challenge).toBeNull()
      test.deployment.offline = false
      test.deployment.domain = 'changed.example.test'
      expect(test.service.challenge).toBeNull()
      test.deployment.domain = 'wiki.example.test'
      expect(test.service.challenge?.token).toBe('current-token')
      test.advance(10 * 60 * 1000)
      expect(test.service.challenge).toBeNull()
      expect(await handler.get!({ challenge })).toBeNull()
      callbackVerified = true
      throw new Error('fixture expired challenge')
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('could not be confirmed')
    expect(callbackVerified).toBe(true)
  })
  it('captures subscriber identity and aborts when its settings change during issuance', async () => {
    const test = setup()
    test.client.certificates.create.mockImplementationOnce(async () => {
      test.deployment.subscriberEmail = 'changed@example.test'
      return payload()
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('settings changed')
    expect(test.store.save).not.toHaveBeenCalled()
  })
  it('stops when native certificate management is disabled before the next effect', async () => {
    const test = setup()
    test.client.init.mockImplementationOnce(async () => {
      test.deployment.enabled = false
      return {}
    })
    await expect(test.service.requestCertificate()).rejects.toThrow('not enabled')
    expect(test.client.certificates.create).not.toHaveBeenCalled()
  })
})

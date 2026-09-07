import ACME from 'acme'
import Keypairs from '@root/keypairs'
import CSR from '@root/csr'
import PEM from '@root/pem'
import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import type { Knex } from 'knex'
import type { AcmeChallenge, AcmeClient } from 'acme'
import { createAcmeStateStore, AcmeStateError, type AcmeSavedState, type AcmeStateStore } from '../repositories/acme-state.ts'
import { loadTlsMaterial, type TlsMaterialConfiguration } from '../repositories/tls-material.ts'
import type { TlsCertificateEvidence } from '../../shared/tls-workspace.ts'

interface Deployment {
  enabled: boolean
  provider: string
  domain: string
  subscriberEmail: string
  offline: boolean
}
interface Dependencies {
  state: AcmeStateStore
  deployment(): Deployment
  maintainerEmail: string
  version: string
  staging: boolean
  publish(state: AcmeSavedState): void
  configureTls(material: TlsMaterialConfiguration): void
  logger: { info(message: string): void; warn(message: string): void }
  createClient?: typeof ACME.create
  now?(): number
}
export interface LetsEncryptService {
  readonly apiDirectory: string
  readonly challenge: AcmeChallenge | null
  init(): Promise<void>
  requestCertificate(beforeEffect?: () => Promise<void>): Promise<TlsCertificateEvidence>
}
class AcmeLifecycleError extends Error {}
const domain = (value: string): string => {
  if (typeof value !== 'string') throw new AcmeLifecycleError('Configure a valid certificate domain in deployment settings.')
  const ascii = domainToASCII(value.trim()).toLowerCase()
  if (
    !ascii ||
    isIP(ascii) !== 0 ||
    ascii.length > 253 ||
    !ascii.includes('.') ||
    !ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new AcmeLifecycleError('Configure a valid certificate domain in deployment settings.')
  return ascii
}
export const acmeTlsConfiguration = (state: AcmeSavedState): TlsMaterialConfiguration => {
  if (!state.payload?.cert || !state.serverKey) throw new AcmeLifecycleError('Saved ACME certificate material is incomplete.')
  return { format: 'pem', inline: true, key: state.serverKey, cert: state.payload.cert + '\n' + (state.payload.chain ?? ''), passphrase: null, dhparam: null }
}
const validateSaved = async (state: AcmeSavedState, hostname: string): Promise<TlsCertificateEvidence> => {
  const material = await loadTlsMaterial(acmeTlsConfiguration(state))
  if (!material.certificate || !new X509Certificate(state.payload!.cert).checkHost(hostname))
    throw new AcmeLifecycleError('The certificate does not match its configured domain.')
  return material.certificate
}
export const createLetsEncryptService = (deps: Dependencies): LetsEncryptService => {
  let challenge: AcmeChallenge | null = null,
    running = false
  let challengeExpiresAt = 0
  const now = deps.now ?? Date.now
  const apiDirectory = deps.staging ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : 'https://acme-v02.api.letsencrypt.org/directory'
  const service: LetsEncryptService = {
    apiDirectory,
    get challenge() {
      if (!challenge || challengeExpiresAt <= now() || deps.deployment().offline) return null
      try {
        if (domain(deps.deployment().domain) !== domain(challenge.hostname)) return null
      } catch {
        return null
      }
      return { ...challenge }
    },
    async init() {
      let saved = await deps.state.read()
      const hostname = domain(deps.deployment().domain)
      let certificate: TlsCertificateEvidence | null = null
      try {
        certificate = await validateSaved(saved.value, hostname)
      } catch {
        /* Missing or invalid material requires issuance. */
      }
      if (!certificate || certificate.validity === 'not-yet-valid' || new Date(certificate.validUntil).getTime() <= Date.now() + 5 * 86400000) {
        await service.requestCertificate()
        saved = await deps.state.read()
        certificate = await validateSaved(saved.value, hostname)
      }
      if (['expired', 'not-yet-valid'].includes(certificate.validity)) throw new AcmeLifecycleError('Saved ACME certificate is outside its validity period.')
      if (domain(deps.deployment().domain) !== hostname) throw new AcmeLifecycleError('Certificate deployment settings changed during startup.')
      deps.publish(saved.value)
      deps.configureTls(acmeTlsConfiguration(saved.value))
      deps.logger.info('(LETSENCRYPT) Validated saved certificate for the HTTPS listener.')
    },
    async requestCertificate(beforeEffect = async () => {}) {
      if (running) throw new AcmeLifecycleError('Another certificate request is already in progress.')
      running = true
      try {
        return await deps.state.exclusive(async assertHeld => {
          const selected = { ...deps.deployment() },
            hostname = domain(selected.domain)
          if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(selected.subscriberEmail) || selected.subscriberEmail.length > 254)
            throw new AcmeLifecycleError('Configure a valid ACME subscriber email in deployment settings.')
          const guard = async () => {
            await assertHeld()
            const current = deps.deployment()
            if (!current.enabled || current.provider !== 'letsencrypt')
              throw new AcmeLifecycleError('Native Let’s Encrypt is not enabled in deployment settings.')
            if (current.offline) throw new AcmeLifecycleError('Certificate requests are paused while offline mode is enabled.')
            if (domain(current.domain) !== hostname || current.subscriberEmail !== selected.subscriberEmail)
              throw new AcmeLifecycleError('Certificate deployment settings changed during the request.')
            await beforeEffect()
          }
          await guard()
          let saved = await deps.state.read()
          const persist = async (value: AcmeSavedState) => {
            await guard()
            saved = await deps.state.save(saved, value)
            deps.publish(saved.value)
          }
          if (saved.value.account && !saved.value.accountKeypair)
            throw new AcmeLifecycleError('The saved ACME account has no key. Restore its key before requesting a certificate.')
          // Persist key identity first. Retrying account creation with the same key is idempotent.
          const next = structuredClone(saved.value)
          let generated = false
          if (!next.accountKeypair) {
            next.accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' })
            generated = true
          }
          if (!next.serverKey) {
            const pair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' })
            next.serverKey = await Keypairs.export({ jwk: pair.private })
            generated = true
          }
          if (generated) await persist(next)
          const client: AcmeClient = (deps.createClient ?? ACME.create)({
            maintainerEmail: deps.maintainerEmail,
            packageAgent: `tsepistle/${deps.version}`,
            notify: event => {
              // Provider payloads can contain account keys, challenge material and raw responses.
              if (event === 'warning' || event === 'error') deps.logger.warn('(LETSENCRYPT) The certificate authority reported a request issue.')
            }
          })
          await guard()
          await client.init(apiDirectory)
          if (!saved.value.account) {
            await guard()
            const account = await client.accounts.create({
              subscriberEmail: selected.subscriberEmail,
              agreeToTerms: true,
              accountKey: saved.value.accountKeypair!.private
            })
            await persist({ ...saved.value, account })
          }
          const serverKey = await Keypairs.import({ pem: saved.value.serverKey! })
          const csrDer = await CSR.csr({ jwk: serverKey, domains: [hostname], encoding: 'der' })
          const csr = PEM.packBlock({ type: 'CERTIFICATE REQUEST', bytes: csrDer })
          await guard()
          const payload = await client.certificates.create({
            account: saved.value.account!,
            accountKey: saved.value.accountKeypair!.private,
            csr,
            domains: [hostname],
            challenges: {
              'http-01': {
                init() {},
                set(data) {
                  if (
                    domain(data.challenge.hostname) !== hostname ||
                    !/^[a-zA-Z0-9_-]{1,256}$/.test(data.challenge.token) ||
                    !data.challenge.keyAuthorization ||
                    data.challenge.keyAuthorization.length > 4096
                  )
                    throw new AcmeLifecycleError('The certificate authority supplied an invalid HTTP challenge.')
                  challenge = { ...data.challenge }
                  challengeExpiresAt = now() + 10 * 60 * 1000
                  return null
                },
                get(data) {
                  const current = service.challenge
                  return current?.token === data.challenge.token ? current : null
                },
                async remove(data) {
                  if (challenge?.token === data.challenge.token) challenge = null
                  return null
                }
              }
            }
          })
          const candidate: AcmeSavedState = { ...saved.value, payload, domain: hostname }
          const certificate = await validateSaved(candidate, hostname)
          if (['expired', 'not-yet-valid'].includes(certificate.validity))
            throw new AcmeLifecycleError('The issued certificate is outside its validity period.')
          // The actual certificate is authoritative; do not trust provider-supplied expiry metadata.
          candidate.payload = { ...payload, expires: certificate.validUntil }
          await persist(candidate)
          deps.logger.info('(LETSENCRYPT) Issued certificate validated and saved. Listener application is a separate step.')
          return certificate
        })
      } catch (error) {
        deps.logger.warn('(LETSENCRYPT) Certificate request did not complete. Inspect saved certificate state before retrying.')
        // Never propagate raw CA or key parsing errors through legacy callers or logs.
        const safe = error instanceof AcmeLifecycleError || error instanceof AcmeStateError
        throw new AcmeLifecycleError(
          safe
            ? (error as Error).message
            : 'Certificate issuance or persistence could not be confirmed. Inspect saved certificate state before requesting another certificate.'
        )
      } finally {
        challenge = null
        running = false
      }
    }
  }
  return service
}
interface WikiContext {
  dev?: boolean
  version: string
  models: { knex: Knex }
  config: {
    letsencrypt: AcmeSavedState
    maintainerEmail: string
    offline?: boolean
    ssl: { enabled?: boolean; provider?: string; domain: string; subscriberEmail: string } & TlsMaterialConfiguration
  }
  logger: Dependencies['logger']
}
let instance: LetsEncryptService | null = null
const getService = () => {
  const wiki = WIKI as unknown as WikiContext
  return (instance ??= createLetsEncryptService({
    state: createAcmeStateStore(wiki.models.knex, () => wiki.config.letsencrypt),
    deployment: () => ({
      enabled: wiki.config.ssl.enabled === true,
      provider: wiki.config.ssl.provider ?? '',
      domain: wiki.config.ssl.domain,
      subscriberEmail: wiki.config.ssl.subscriberEmail,
      offline: wiki.config.offline === true
    }),
    maintainerEmail: wiki.config.maintainerEmail,
    version: wiki.version,
    staging: wiki.dev === true,
    logger: wiki.logger,
    publish: state => {
      wiki.config.letsencrypt = structuredClone(state)
    },
    configureTls: material => {
      Object.assign(wiki.config.ssl, material)
    }
  }))
}
const letsencrypt: LetsEncryptService = {
  get apiDirectory() {
    return getService().apiDirectory
  },
  get challenge() {
    return instance?.challenge ?? null
  },
  init: () => getService().init(),
  requestCertificate: beforeEffect => getService().requestCertificate(beforeEffect)
}
export default letsencrypt

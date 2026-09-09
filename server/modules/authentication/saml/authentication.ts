import type { Knex } from 'knex'
import { randomBytes } from 'node:crypto'
import { synchronizeProviderGroups } from '../../../helpers/authentication-provisioning.ts'
import { consumeFederatedLogin, issueFederatedLogin, type FederatedLoginRequest } from '../../../helpers/federated-login.ts'
import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import { FederatedLoginStore, FEDERATED_LOGIN_TTL_MS, type FederatedLoginConsumed } from '../../../repositories/federated-login.ts'
import _ from 'lodash'

// ------------------------------------
// SAML Account
// ------------------------------------


import { MultiSamlStrategy, ValidateInResponseTo, type CacheProvider, type MultiStrategyConfig, type PassportSamlConfig } from '@node-saml/passport-saml'
const asPassportUser = <T extends object>(user: T): T => user

const getSignatureAlgorithm = (algorithm: string): 'sha1' | 'sha256' | 'sha512' => {
  if (algorithm === 'sha1' || algorithm === 'sha256' || algorithm === 'sha512') {
    return algorithm
  }
  throw new Error(`Invalid SAML signature algorithm: ${algorithm}`)
}

const getRacComparison = (comparison: string): 'exact' | 'minimum' | 'maximum' | 'better' => {
  if (comparison === 'exact' || comparison === 'minimum' || comparison === 'maximum' || comparison === 'better') {
    return comparison
  }
  throw new Error(`Invalid SAML authentication context comparison: ${comparison}`)
}

const getAudience = (value: unknown): string | undefined => {
  if (_.isEmpty(value)) {
    return undefined
  }
  if (typeof value === 'string') {
    return value
  }
  throw new Error('SAML audience must be a string.')
}
type SamlRequest = FederatedLoginRequest & {
  readonly body?: unknown
  readonly query?: unknown
  readonly path?: string
  readonly originalUrl?: string
}

type SamlRequestCacheInput = {
  request: SamlRequest
  store: FederatedLoginStore
  providerKey: string
  providerRevision: string
  expectedRequestId?: string
}

const requestValue = (request: SamlRequest, name: string): unknown => {
  const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : undefined
  const query = typeof request.query === 'object' && request.query !== null ? request.query as Record<string, unknown> : undefined
  return body?.[name] ?? query?.[name]
}

const stringRequestValue = (request: SamlRequest, name: string): string | undefined => {
  const value = requestValue(request, name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const isSamlCallbackRequest = (request: SamlRequest): boolean => {
  const path = typeof request.path === 'string'
    ? request.path
    : typeof request.originalUrl === 'string' ? request.originalUrl.split('?', 1)[0] ?? '' : ''
  return /^\/login\/[^/]+\/callback$/u.test(path) ||
    stringRequestValue(request, 'SAMLResponse') !== undefined ||
    stringRequestValue(request, 'SAMLRequest') !== undefined
}

const samlCacheProvider = (input: SamlRequestCacheInput): CacheProvider => {
  const values = new Map<string, string | null>()
  const pending = new Map<string, Promise<string | null>>()
  return {
    async saveAsync(key, value) {
      if (!input.expectedRequestId || key !== input.expectedRequestId) throw new Error('SAML request correlation is unavailable.')
      if (typeof value !== 'string') throw new Error('SAML request correlation timestamp is unavailable.')
      values.set(key, value)
      const createdAt = Date.parse(value)
      return Number.isFinite(createdAt) ? { value, createdAt } : null
    },
    async getAsync(key) {
      const cached = values.get(key)
      if (cached !== undefined) return cached
      const existing = pending.get(key)
      if (existing) return await existing
      const consume = (async (): Promise<string | null> => {
        const consumed = await consumeFederatedLogin({
          request: input.request,
          store: input.store,
          providerKey: input.providerKey,
          protocol: 'saml',
          providerRevision: input.providerRevision,
          requestId: key
        })
        if (!consumed || !matchesSamlAttempt(consumed, key, stringRequestValue(input.request, 'RelayState'))) return null
        return consumed.issuedAt.toISOString()
      })()
      pending.set(key, consume)
      const result = await consume
      values.set(key, result)
      return result
    },
    async removeAsync(key) {
      if (key === null) return null
      return values.get(key) ?? null
    }
  }
}

const matchesSamlAttempt = (consumed: FederatedLoginConsumed, requestId: string, relayState: string | undefined): boolean => {
  const payload = consumed.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  if (!('requestId' in payload) || payload.requestId !== requestId) return false
  const expectedRelayState = 'relayState' in payload && typeof payload.relayState === 'string' ? payload.relayState : undefined
  return expectedRelayState === relayState
}

const plugin: AuthenticationPlugin = {
  init(passport, conf) {
    const providerRevision = (conf as AuthenticationConfig & { adminRevision?: unknown }).adminRevision
    if (typeof providerRevision !== 'string' || providerRevision.length === 0) {
      throw new Error('SAML authentication requires a provider configuration revision.')
    }
    const store = new FederatedLoginStore(wiki.models.knex as unknown as Knex)
    const audience = getAudience(conf.audience)
    const samlConfig: PassportSamlConfig = {
      callbackUrl: conf.callbackURL,
      entryPoint: conf.entryPoint,
      issuer: conf.issuer,
      idpCert: (conf.cert || '').split('|'),
      signatureAlgorithm: getSignatureAlgorithm(conf.signatureAlgorithm),
      digestAlgorithm: conf.digestAlgorithm,
      identifierFormat: conf.identifierFormat,
      wantAssertionsSigned: conf.wantAssertionsSigned,
      acceptedClockSkewMs: _.toSafeInteger(conf.acceptedClockSkewMs),
      disableRequestedAuthnContext: conf.disableRequestedAuthnContext,
      authnContext: (conf.authnContext || '').split('|'),
      racComparison: getRacComparison(conf.racComparison),
      forceAuthn: conf.forceAuthn,
      passive: conf.passive,
      providerName: conf.providerName,
      skipRequestCompression: conf.skipRequestCompression,
      authnRequestBinding: conf.authnRequestBinding,
      passReqToCallback: true,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: FEDERATED_LOGIN_TTL_MS,
      ...(audience === undefined ? {} : { audience }),
      ...(!_.isEmpty(conf.privateKey) && { privateKey: conf.privateKey }),
      ...(!_.isEmpty(conf.decryptionPvk) && { decryptionPvk: conf.decryptionPvk })
    }

    const getSamlOptions: MultiStrategyConfig['getSamlOptions'] = (request, done): void => {
      const callbackRequest = isSamlCallbackRequest(request)
      if (callbackRequest && stringRequestValue(request, 'SAMLResponse') === undefined && stringRequestValue(request, 'SAMLRequest') === undefined) {
        done(new Error('SAML callback correlation is missing.'))
        return
      }

      if (callbackRequest) {
        done(null, {
          ...samlConfig,
          validateInResponseTo: ValidateInResponseTo.always,
          requestIdExpirationPeriodMs: FEDERATED_LOGIN_TTL_MS,
          cacheProvider: samlCacheProvider({
            request,
            store,
            providerKey: conf.key,
            providerRevision
          })
        })
        return
      }

      const requestId = `_${randomBytes(32).toString('base64url')}`
      const relayState = stringRequestValue(request, 'RelayState')
      if (!request.res || typeof request.res.cookie !== 'function') {
        done(new Error('SAML federation requires a response cookie writer.'))
        return
      }
      void issueFederatedLogin({
        request,
        response: request.res,
        store,
        providerKey: conf.key,
        protocol: 'saml',
        providerRevision,
        payload: relayState === undefined ? { requestId } : { requestId, relayState }
      }).then(() => {
        done(null, {
          ...samlConfig,
          validateInResponseTo: ValidateInResponseTo.always,
          requestIdExpirationPeriodMs: FEDERATED_LOGIN_TTL_MS,
          generateUniqueId: () => requestId,
          cacheProvider: samlCacheProvider({
            request,
            store,
            providerKey: conf.key,
            providerRevision,
            expectedRequestId: requestId
          })
        })
      }).catch(error => done(asError(error)))
    }

    passport.use(
      conf.key,
      new MultiSamlStrategy(
        {
          ...samlConfig,
          validateInResponseTo: ValidateInResponseTo.always,
          requestIdExpirationPeriodMs: FEDERATED_LOGIN_TTL_MS,
          getSamlOptions
        },
        async (req, profile, cb) => {
          try {
            if (!profile) {
              throw new Error('SAML profile is missing.')
            }
            const userId = _.get(profile, [conf.mappingUID], null) || _.get(profile, 'nameID', null)
            if (!userId) {
              throw new Error('Invalid or Missing Unique ID field!')
            }

            const user = await wiki.models.users.processProfile({
              providerKey: req.params.strategy,
              profile: {
                id: userId,
                email: _.get(profile, conf.mappingEmail, ''),
                displayName: _.get(profile, conf.mappingDisplayName, '???'),
                picture: _.get(profile, conf.mappingPicture, '')
              }
            })

            // map users provider groups to wiki groups with the same name, and remove any groups that don't match
            // Code copied from the LDAP implementation with a slight variation on the field we extract the value from
            // In SAML v2 groups come in profile.attributes and can be 1 string or an array of strings
            if (conf.mapGroups) {
              const attributes = typeof profile.attributes === 'object' && profile.attributes !== null ? profile.attributes : {}
              const mappedGroups = _.get(attributes, conf.mappingGroups)
              const groups = Array.isArray(mappedGroups) ? mappedGroups : mappedGroups ? [mappedGroups] : null

              if (groups) {
                const groupNames = groups.filter((group: unknown): group is string => typeof group === 'string')
                const membership = await synchronizeProviderGroups({ userId: user.id, providerKey: String(req.params.strategy), groupNames: groupNames })
                Object.assign(user, { authVersion: membership.authVersion, adminRevision: membership.adminRevision })
                if (membership.changed) Reflect.deleteProperty(user, 'groups')
              }
            }

            cb(null, asPassportUser(user))
          } catch (err: unknown) {
            cb(asError(err))
          }
        },
        (req, _profile, cb) => {
          cb(null, req.user === undefined ? undefined : asPassportUser(req.user))
        }
      )
    )
  }
}

export default plugin

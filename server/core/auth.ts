import type { AuthenticationRuntime } from '../../shared/authentication-policy.ts'
import { accountSessionIsCurrent, sessionVersion } from '../helpers/account-session.ts'
import { tagAliasMap, type TagIdentity } from '../helpers/tag-aliases.ts'
import type { SystemRequester } from '../helpers/system-authority.ts'
import { requireSystemAuthority } from '../helpers/system-authority.ts'
import type { Knex } from 'knex'
import passport from 'passport'
import passportJwt from 'passport-jwt'
import jwt from 'jsonwebtoken'
import ms from 'ms'
import { generateKeyPairSync } from 'node:crypto'
import pemJwk from 'pem-jwk'
import type NodeCache from 'node-cache'
import type { NextFunction, Request, Response } from 'express'
import { DateTime } from 'luxon'

import commonHelper from '../helpers/common.ts'
import securityHelper from '../helpers/security.ts'
import cache from './cache.ts'
import { apiAccessContract, isApiKeyTransportPath } from '../../shared/api-access.ts'
import { evaluateGroupAccess } from '../helpers/group-access.ts'

type UnknownRecord = Record<string, unknown>
type PageRuleMatch = 'START' | 'END' | 'REGEX' | 'TAG' | 'EXACT'

interface GroupRecord extends UnknownRecord {
  id: number
  permissions: string[]
  pageRules: PageRule[]
}

interface PageRule {
  deny: boolean
  locales?: string[]
  match: PageRuleMatch
  path: string
  roles: string[]
}

interface PageContext {
  locale?: string
  path: string
  tags?: Array<{ tag: string }>
}

interface AccessUser extends Express.User {
  groups?: Array<number | { id?: unknown }>
  permissions?: string[]
  getGlobalPermissions?: () => string[]
  getGroups?: () => number[]
}

interface StoredUser extends AccessUser {
  id: number
  isActive: boolean
  authVersion?: number
  email: string
  name: string
  pictureUrl: string | null
  timezone: string
  localeCode: string
  groups: Array<number | GroupRecord>
  $relatedQuery(relation: string): { relate(id: number): Promise<unknown> }
}

interface GuestState extends AccessUser {
  cacheExpiration: DateTime
}

interface JwtUser extends Express.User {
  id: number
  iat: number
  authVersion?: number
  groups: number[]
  permissions?: string[]
}

interface ApiPrincipal extends Express.User {
  api: number
  grp: number
  exp?: number
  mcpResource?: string
  mcpResourceVersion?: number
}

interface AuthenticationError extends Error {
  code: string
  status: number
}
interface StrategyConfig extends UnknownRecord {
  audience?: string
  callbackURL?: string
  cookieName?: string
  key?: string
  redirectUri?: string
  sessionNamespace?: string
}

interface StrategyRecord extends UnknownRecord {
  config: StrategyConfig
  displayName: string
  key: string
  strategyKey: string
  isEnabled: boolean
  adminRevision?: string
}

interface LoadedStrategy extends UnknownRecord {
  config?: StrategyConfig
  init(passportInstance: typeof passport, config: StrategyConfig): Promise<void> | void
}

interface StrategyModule {
  default: LoadedStrategy
}

interface ActiveStrategy extends StrategyRecord, LoadedStrategy {
  config: StrategyConfig
}

interface SelectBuilder {
  select(...columns: string[]): void
}

interface UserLookup extends PromiseLike<StoredUser | undefined> {
  withGraphFetched(relation: string): UserLookup
  withGraphJoined(relation: string): UserLookup
  modifyGraph(relation: string, callback: (builder: SelectBuilder) => void): UserLookup
}

interface UserDeleteQuery extends PromiseLike<number> {
  where(criteria: UnknownRecord): UserDeleteQuery
  orWhere(column: string, value: unknown): UserDeleteQuery
}

interface UsersQuery {
  delete(): UserDeleteQuery
  findById(id: unknown): UserLookup
  insert(value: UnknownRecord): Promise<StoredUser>
}

interface GroupQuery extends PromiseLike<GroupRecord[]> {
  first(): Promise<GroupRecord | undefined>
  where(column: string, value: unknown): GroupQuery
  whereIn(column: string, values: readonly number[]): GroupQuery
}

interface ApiKeyRecord {
  id: number
}

interface ApiKeyQuery extends PromiseLike<ApiKeyRecord[]> {
  andWhere(column: string, operator: string, value: string): ApiKeyQuery
  select(column: string): ApiKeyQuery
  where(column: string, value: unknown): ApiKeyQuery
}

interface WikiModels {
  apiKeys: { query(): ApiKeyQuery }
  authentication: { getStrategies(): Promise<StrategyRecord[]> }
  groups: { query(): GroupQuery }
  knex: Knex
  tags: { query(): PromiseLike<TagIdentity[]> }
  users: {
    getGuestUser(): Promise<StoredUser>
    query(): UsersQuery
    refreshToken(id: number, options?: { expectedAuthVersion: number }): Promise<{ token: string; user: StoredUser }>
  }
}

interface WikiConfig extends UnknownRecord {
  api: { isEnabled: boolean }
  auth: { audience: string; tokenExpiration: string; tokenRenewal: string }
  certs: { jwk?: JsonWebKey; private: string | Buffer; public: string | Buffer }
  features: { featurePageComments: boolean }
  host: string
  sessionSecret: string
}

interface WikiContext extends UnknownRecord {
  config: WikiConfig
  configSvc: { saveToDb(keys: string[]): Promise<unknown> }
  events: {
    inbound: { on(event: string, listener: (value: unknown) => void): void }
    outbound: { emit(event: string): void }
  }
  lang: { t(key: string): string }
  logger: { error(value: unknown): void; info(value: unknown): void; warn(value: unknown): void }
  models: WikiModels
  startedAt: DateTime
}

interface RuleState {
  deny: boolean
  match: PageRuleMatch | false
  specificity: string
}

interface RuleApplication {
  checkState: RuleState
  higherPriority?: PageRuleMatch[]
  rule: PageRule
}

interface RevokeRequest {
  id: number
  kind?: string
}

interface EffectivePermissions {
  comments: { manage: boolean; read: boolean; write: boolean }
  history: { read: boolean }
  pages: { delete: boolean; manage: boolean; read: boolean; script: boolean; style: boolean; write: boolean }
  source: { read: boolean }
  system: { manage: boolean }
}

interface AuthService {
  activateStrategies(strict?: boolean): Promise<void>
  authenticateUserToken(token: string): Promise<StoredUser | null>
  authenticate(req: Request, res: Response, next: NextFunction): void
  checkAccess(user: AccessUser | undefined, permissions?: string[], page?: PageContext | false): boolean
  checkAssignUserToGroupAccess(requester: AccessUser, groupIds?: number[]): Promise<boolean>
  checkExclusiveAccess(user: AccessUser, includePermissions?: string[], excludePermissions?: string[]): boolean
  getEffectivePermissions(req: Request, page: PageContext): EffectivePermissions
  tagAliases: Record<string, string | null>
  groups: Record<string, GroupRecord>
  guest: GuestState
  init(): AuthService
  passport: typeof passport
  regenerateCertificates(requester?: SystemRequester): Promise<{ revokedApiKeys: number }>
  reloadApiKeys(): Promise<void>
  reloadGroups(): Promise<void>
  resetGuestUser(requester?: SystemRequester): Promise<void>
  revocationList: NodeCache
  revokeUserTokens(request: RevokeRequest): void
  strategies: Record<string, ActiveStrategy>
  jwtAudience: string | null
  strategyHost: string | null
  strategyStatus: Record<string, AuthenticationRuntime>
  subscribeToEvents(): void
  validApiKeys: number[]
  _applyPageRuleSpecificity(application: RuleApplication): RuleState
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null
const isWikiContext = (value: unknown): value is WikiContext => {
  if (!isRecord(value)) return false
  return (
    isRecord(value.config) &&
    isRecord(value.configSvc) &&
    isRecord(value.events) &&
    isRecord(value.lang) &&
    isRecord(value.logger) &&
    isRecord(value.models) &&
    isRecord(value.startedAt)
  )
}
const getWiki = (): WikiContext => {
  const value: unknown = WIKI
  if (!isWikiContext(value)) throw new Error('WIKI authentication services are not initialized')
  return value
}
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))
const isStrategyModule = (value: unknown): value is StrategyModule => {
  if (!isRecord(value) || !isRecord(value.default)) return false
  return typeof value.default.init === 'function'
}
const isJwtUser = (value: unknown): value is JwtUser =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.iat === 'number' &&
  Array.isArray(value.groups) &&
  value.groups.every(group => typeof group === 'number')
const isApiPrincipal = (value: unknown): value is ApiPrincipal => isRecord(value) && typeof value.api === 'number' && typeof value.grp === 'number'
const isAccessUser = (value: unknown): value is AccessUser =>
  isRecord(value) &&
  (value.permissions === undefined || (Array.isArray(value.permissions) && value.permissions.every(permission => typeof permission === 'string'))) &&
  (value.getGlobalPermissions === undefined || typeof value.getGlobalPermissions === 'function')
const isExpressUser = (value: unknown): value is Express.User => isRecord(value)
const getPermissions = (user: AccessUser | undefined): string[] => {
  if (!user) return []
  if (Array.isArray(user.permissions)) return user.permissions
  return user.getGlobalPermissions?.() ?? []
}
const getGroupId = (group: number | { id?: unknown }): number | null => {
  if (typeof group === 'number') return group
  return typeof group.id === 'number' ? group.id : null
}
const getPassportStrategyNames = (): string[] => {
  const passportObject: object = passport
  if (!('_strategies' in passportObject) || !isRecord(passportObject._strategies)) {
    throw new Error('Passport strategy registry is unavailable')
  }
  return Object.keys(passportObject._strategies)
}
const getExpiredAt = (info: unknown): string | null => {
  if (!isRecord(info) || info.name !== 'TokenExpiredError') return null
  const expiredAt = info.expiredAt
  if (expiredAt instanceof Date) return expiredAt.toISOString()
  return typeof expiredAt === 'string' ? expiredAt : null
}
const extractBearerToken = (req: Request): string | null => {
  const authorization = req.get('authorization')
  if (!authorization) return null
  const match = /^Bearer ([^\s]+)$/i.exec(authorization)
  return match?.[1] ?? null
}
const isDedicatedMcpRequest = (req: Request): boolean =>
  req.originalUrl === apiAccessContract.mcpPath && isRecord(req.route) && req.route.path === apiAccessContract.mcpPath
const isRevokeRequest = (value: unknown): value is RevokeRequest =>
  isRecord(value) && typeof value.id === 'number' && (value.kind === undefined || typeof value.kind === 'string')
const createAuthenticationError = (message: string, status: number, code: string): AuthenticationError => Object.assign(new Error(message), { code, status })
const loadCurrentUser = (wiki: WikiContext, id: unknown): UserLookup =>
  wiki.models.users
    .query()
    .findById(id)
    .withGraphFetched('groups')
    .modifyGraph('groups', builder => {
      builder.select('groups.id', 'permissions')
    })
const verifyUserToken = (wiki: WikiContext, token: string, allowExpired = false): JwtUser | null => {
  try {
    const user = jwt.verify(token, wiki.config.certs.public, {
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js',
      algorithms: ['RS256'],
      ...(allowExpired ? { ignoreExpiration: true } : {})
    })
    return isJwtUser(user) ? user : null
  } catch {
    return null
  }
}
const userTokenNeedsRevalidation = (user: JwtUser, revocationList: NodeCache, startedAt: DateTime): boolean => {
  const userRevalidation = revocationList.get<number>(`u${String(user.id)}`)
  if ((userRevalidation !== undefined && user.iat < userRevalidation) || DateTime.fromSeconds(user.iat) <= startedAt) return true
  return user.groups.some(groupId => {
    const groupRevalidation = revocationList.get<number>(`g${String(groupId)}`)
    return groupRevalidation !== undefined && user.iat < groupRevalidation
  })
}

let activationQueue: Promise<void> = Promise.resolve()

const auth: AuthService = {
  strategies: {},
  strategyStatus: {},
  jwtAudience: null,
  strategyHost: null,
  passport,
  guest: { cacheExpiration: DateTime.utc().minus({ days: 1 }) },
  groups: {},
  tagAliases: {},
  validApiKeys: [],
  revocationList: cache.init(),

  init() {
    passport.serializeUser((user, done) => done(null, user.id))
    passport.deserializeUser<unknown>(async (id, done) => {
      try {
        const wiki = getWiki()
        const user = await loadCurrentUser(wiki, id)
        done(user ? null : new Error(wiki.lang.t('auth:errors:usernotfound')), user ?? null)
      } catch (error: unknown) {
        done(asError(error), null)
      }
    })
    void this.reloadGroups()
    void this.reloadApiKeys()
    return this
  },

  async activateStrategies(strict = false) {
    let failed = false
    const activation = activationQueue.then(async () => {
      const wiki = getWiki()
      try {
        this.strategies = {}
        this.strategyStatus = {}
        this.jwtAudience = null
        this.strategyHost = null
        const activationHost = wiki.config.host
        for (const strategyName of getPassportStrategyNames()) {
          if (strategyName !== 'session') passport.unuse(strategyName)
        }

        passport.use(
          'jwt',
          new passportJwt.Strategy(
            {
              jwtFromRequest: securityHelper.extractJWT,
              secretOrKey: wiki.config.certs.public,
              audience: wiki.config.auth.audience,
              issuer: 'urn:wiki.js',
              algorithms: ['RS256']
            },
            (jwtPayload: unknown, done) => done(null, jwtPayload)
          )
        )

        this.jwtAudience = wiki.config.auth.audience
        const records = await wiki.models.authentication.getStrategies()
        for (const strategyRecord of records) {
          const observed = { checkedAt: new Date().toISOString(), revision: strategyRecord.adminRevision ?? '' }
          if (!strategyRecord.isEnabled) {
            this.strategyStatus[strategyRecord.key] = { ...observed, state: 'disabled' }
            continue
          }
          this.strategyStatus[strategyRecord.key] = { ...observed, state: 'pending' }
          try {
            // Strategy key comes from the runtime plugin registry, so this cannot be a static import.
            const imported: unknown = await import(`../modules/authentication/${strategyRecord.strategyKey}/authentication.ts`)
            if (!isStrategyModule(imported)) throw new Error(`Invalid authentication strategy module: ${strategyRecord.strategyKey}`)
            const strategy = imported.default
            const callbackURL = `${activationHost}/login/${strategyRecord.key}/callback`
            const config: StrategyConfig = {
              ...strategyRecord.config,
              audience: strategyRecord.config.audience ?? wiki.config.auth.audience,
              callbackURL,
              cookieName: 'jwt',
              key: strategyRecord.key,
              redirectUri: callbackURL,
              sessionNamespace: 'wiki'
            }
            await strategy.init(passport, config)
            this.strategies[strategyRecord.key] = { ...strategy, ...strategyRecord, config }
            this.strategyStatus[strategyRecord.key] = { ...observed, checkedAt: new Date().toISOString(), state: 'ready' }
            wiki.logger.info(`Authentication Strategy ${strategyRecord.displayName}: [ OK ]`)
          } catch (error: unknown) {
            failed = true
            this.strategyStatus[strategyRecord.key] = { ...observed, checkedAt: new Date().toISOString(), state: 'failed' }
            passport.unuse(strategyRecord.key)
            wiki.logger.error(`Authentication Strategy ${strategyRecord.displayName} (${strategyRecord.key}): [ FAILED ]`)
            wiki.logger.error(error)
          }
        }
        this.strategyHost = activationHost
      } catch (error: unknown) {
        failed = true
        wiki.logger.error('Failed to initialize Authentication Strategies: [ ERROR ]')
        wiki.logger.error(error)
      }
    })
    activationQueue = activation.catch(() => {})
    await activation
    if (strict && failed) throw new Error('Authentication strategies could not be activated.')
  },

  authenticate(req, res, next) {
    passport.authenticate('jwt', { session: false }, async (error: unknown, authenticatedUser: Express.User | false | null | undefined, info: unknown) => {
      if (error) return next()
      let user: unknown = authenticatedUser
      let mustRevalidate = false
      const expiredAt = getExpiredAt(info)
      const wiki = getWiki()

      if (expiredAt && DateTime.utc().minus(ms(wiki.config.auth.tokenRenewal)) < DateTime.fromISO(expiredAt)) {
        mustRevalidate = true
      }

      if (isJwtUser(user) && !mustRevalidate && userTokenNeedsRevalidation(user, this.revocationList, wiki.startedAt)) {
        mustRevalidate = true
      }

      let claims = isJwtUser(user) ? user : null
      if (!claims && mustRevalidate) {
        const token = securityHelper.extractJWT(req)
        claims = token ? verifyUserToken(wiki, token, true) : null
      }
      if (claims) {
        try {
          const account =
            Number.isSafeInteger(claims.id) && claims.id > 0 && claims.id <= 2147483647 ? await wiki.models.users.query().findById(claims.id) : undefined
          if (!accountSessionIsCurrent(claims, account)) {
            claims = null
            user = false
            mustRevalidate = false
          }
        } catch (stateError) {
          return next(asError(stateError))
        }
      } else if (mustRevalidate) {
        // Renewal must have a verified user token, including its session version.
        user = false
        mustRevalidate = false
      } else if (user && !isApiPrincipal(user)) {
        user = false
      }

      if (mustRevalidate && claims) {
        const userId = claims.id,
          expectedAuthVersion = sessionVersion(claims.authVersion)!
        try {
          const refreshed = await wiki.models.users.refreshToken(userId, { expectedAuthVersion })
          user = refreshed.user
          refreshed.user.permissions = refreshed.user.getGlobalPermissions?.() ?? []
          refreshed.user.groups = refreshed.user.getGroups?.() ?? []
          req.user = refreshed.user
          if (req.get('content-type') === 'application/json') res.set('new-jwt', refreshed.token)
          else res.cookie('jwt', refreshed.token, commonHelper.getCookieOpts())
          res.set('Cache-Control', 'no-store')
        } catch (refreshError: unknown) {
          wiki.logger.warn(refreshError)
          return next()
        }
      }

      if (!user) {
        if (this.guest.cacheExpiration <= DateTime.utc()) {
          this.guest = { ...(await wiki.models.users.getGuestUser()), cacheExpiration: DateTime.utc().plus({ minutes: 1 }) }
        }
        if (!isAccessUser(this.guest)) return next(new Error('Guest user is unavailable'))
        this.guest.ownershipUserId = null
        req.user = this.guest
        req.authContext = { kind: 'guest', ownershipUserId: null, principal: this.guest }
        return next()
      }

      if (isApiPrincipal(user)) {
        if (!isApiKeyTransportPath(req.path) && !isDedicatedMcpRequest(req)) {
          return next(
            createAuthenticationError(
              'API keys are supported only for the GraphQL, REST v1, and dedicated MCP transports. Browser and internal routes require a user session.',
              403,
              'API_KEY_TRANSPORT_FORBIDDEN'
            )
          )
        }
        if (!wiki.config.api.isEnabled) {
          return next(createAuthenticationError('API access is disabled. Enable it in Administration → API Access.', 403, 'API_ACCESS_DISABLED'))
        }
        if (!this.validApiKeys.includes(user.api)) {
          return next(createAuthenticationError('API key is invalid or was revoked.', 401, 'API_KEY_INVALID'))
        }
        const permissions = this.groups[String(user.grp)]?.permissions ?? []
        const groups = [user.grp]
        const principal: Express.User = {
          id: 1,
          email: 'api@localhost',
          name: 'API',
          pictureUrl: null,
          timezone: 'America/New_York',
          localeCode: 'en',
          permissions,
          groups,
          getGlobalPermissions: () => permissions,
          ownershipUserId: null,
          getGroups: () => groups
        }
        req.user = principal
        req.authContext = {
          kind: 'apiKey',
          apiKeyId: user.api,
          groupId: user.grp,
          ownershipUserId: null,
          principal
        }
        req.apiKeyAuth = {
          apiKeyId: user.api,
          groupId: user.grp,
          expiresAt: typeof user.exp === 'number' ? user.exp : null,
          mcpResource: typeof user.mcpResource === 'string' ? user.mcpResource : null,
          mcpResourceVersion: typeof user.mcpResourceVersion === 'number' ? user.mcpResourceVersion : null,
          bearerToken: extractBearerToken(req)
        }
        return next()
      }

      if (!isExpressUser(user) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0 || user.id === 2) return next()
      user.ownershipUserId = user.id
      req.authContext = { kind: 'user', userId: user.id, ownershipUserId: user.id, principal: user }
      req.logIn(user, { session: false }, loginError => (loginError ? next(loginError) : next()))
    })(req, res, next)
  },
  async authenticateUserToken(token) {
    const wiki = getWiki()
    const claims = verifyUserToken(wiki, token)
    if (
      !claims ||
      !Number.isSafeInteger(claims.id) ||
      claims.id <= 0 ||
      claims.id === 2 ||
      userTokenNeedsRevalidation(claims, this.revocationList, wiki.startedAt)
    )
      return null

    const user = await loadCurrentUser(wiki, claims.id)
    if (!accountSessionIsCurrent(claims, user)) return null
    if (!user) return null
    user.permissions = user.getGlobalPermissions?.() ?? []
    user.groups = user.getGroups?.() ?? []
    return user
  },

  checkAccess(user, permissions = [], page = false) {
    if (!user) return false
    const userPermissions = getPermissions(user)
    if (userPermissions.includes('manage:system')) return true
    if (!permissions.some(permission => userPermissions.includes(permission))) return false
    if (!page) return true
    if (!user.groups) return false

    const groups = user.groups.flatMap(group => {
      const id = getGroupId(group)
      const record = id === null ? undefined : this.groups[String(id)]
      return record ? [record] : []
    })
    return evaluateGroupAccess(userPermissions, permissions, groups, page, this.tagAliases, false).allowed
  },

  checkExclusiveAccess(user, includePermissions = [], excludePermissions = []) {
    const permissions = getPermissions(user)
    return includePermissions.some(permission => permissions.includes(permission)) && !excludePermissions.some(permission => permissions.includes(permission))
  },

  async checkAssignUserToGroupAccess(requester, groupIds = []) {
    if (groupIds.length < 1) return true
    const requesterPermissions = getPermissions(requester)
    if (requesterPermissions.includes('manage:system')) return true
    if (!requesterPermissions.some(permission => ['write:users', 'manage:users', 'write:groups', 'manage:groups'].includes(permission))) return false

    const groups = await getWiki().models.groups.query().whereIn('id', groupIds)
    return groups.every(group => {
      if (group.permissions.some(permission => permission === 'write:scripts' || permission.split(':').at(-1) === 'system')) return false
      const hasAdministrativePermission = group.permissions.some(permission => {
        const permissionType = permission.split(':').at(-1)
        return permissionType !== undefined && ['users', 'groups', 'navigation', 'theme', 'api'].includes(permissionType)
      })
      return !hasAdministrativePermission || requesterPermissions.includes('manage:groups')
    })
  },

  _applyPageRuleSpecificity({ rule, checkState, higherPriority = [] }) {
    if (rule.path.length === checkState.specificity.length) {
      if (checkState.match !== false && higherPriority.includes(checkState.match)) return checkState
      if (rule.match === checkState.match && checkState.deny && !rule.deny) return checkState
    } else if (rule.path.length < checkState.specificity.length) {
      return checkState
    }
    return { deny: rule.deny, match: rule.match, specificity: rule.path }
  },

  async reloadGroups() {
    try {
      const [groups, tags] = await Promise.all([getWiki().models.groups.query(), getWiki().models.tags.query()])
      const aliases = tagAliasMap(tags)
      const indexedGroups: Record<string, GroupRecord> = {}
      for (const group of groups) indexedGroups[String(group.id)] = group
      this.groups = indexedGroups
      this.tagAliases = aliases
    } catch (error) {
      // A failed refresh must not preserve a permission that was just removed.
      this.groups = {}
      this.tagAliases = {}
      throw error
    } finally {
      this.guest.cacheExpiration = DateTime.utc().minus({ days: 1 })
    }
  },

  async reloadApiKeys() {
    const now = DateTime.utc().toISO()
    if (now === null) throw new Error('Failed to determine the API key validation time')
    const keys = await getWiki().models.apiKeys.query().select('id').where('isRevoked', false).andWhere('expiration', '>', now)
    this.validApiKeys = keys.map(key => key.id)
  },

  async regenerateCertificates(requester?: SystemRequester) {
    const wiki = getWiki()
    wiki.logger.info('Regenerating certificates...')
    const certificates = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: wiki.config.sessionSecret }
    })
    const nextCertificates = {
      jwk: pemJwk.pem2jwk(certificates.publicKey),
      public: certificates.publicKey,
      private: certificates.privateKey
    }
    const revokedApiKeys = await wiki.models.knex.transaction(async tx => {
      if (requester) await requireSystemAuthority(tx, requester, true)
      const updatedAt = new Date().toISOString()
      await tx('settings').insert({ key: 'certs', value: nextCertificates, updatedAt }).onConflict('key').merge({ value: nextCertificates, updatedAt })
      const revoked = await tx('apiKeys').where('isRevoked', false).update({ isRevoked: true, updatedAt }, ['id'])
      return revoked.length
    })
    wiki.config.certs = nextCertificates
    await this.activateStrategies(true)
    await this.reloadApiKeys()
    wiki.events.outbound.emit('reloadConfig')
    wiki.events.outbound.emit('reloadAuthStrategies')
    wiki.logger.info('Regenerated certificates: [ COMPLETED ]')
    return { revokedApiKeys }
  },

  async resetGuestUser(requester?: SystemRequester) {
    const wiki = getWiki()
    wiki.logger.info('Resetting guest account...')
    await wiki.models.knex.transaction(async tx => {
      if (requester) await requireSystemAuthority(tx, requester, true)
      const guestGroup = await tx('groups').where('id', 2).forUpdate().first('id')
      if (!guestGroup) throw new Error('Guest group is missing')
      const currentGuest = await tx('users').where('id', 2).forUpdate().first('id')
      const duplicateGuest = await tx('users').where({ providerKey: 'local', email: 'guest@example.com' }).whereNot('id', 2).forUpdate().first('id')
      if (duplicateGuest) throw new Error('The reserved guest identity is already assigned to another account')
      const updatedAt = new Date().toISOString()
      const guest = {
        providerKey: 'local',
        email: 'guest@example.com',
        name: 'Guest',
        password: '',
        tfaIsActive: false,
        tfaSecret: null,
        localeCode: 'en',
        defaultEditor: 'markdown',
        isSystem: true,
        isActive: true,
        isVerified: true,
        mustChangePwd: false,
        updatedAt
      }
      if (currentGuest) await tx('users').where('id', 2).update(guest)
      else await tx('users').insert({ id: 2, ...guest, createdAt: updatedAt })
      await tx('userGroups').where('userId', 2).delete()
      await tx('userGroups').insert({ userId: 2, groupId: 2 })
    })
    this.guest.cacheExpiration = DateTime.utc().minus({ days: 1 })
    wiki.logger.info('Guest user has been reset: [ COMPLETED ]')
  },

  subscribeToEvents() {
    const inbound = getWiki().events.inbound
    inbound.on('reloadGroups', () => {
      void this.reloadGroups().catch(error => getWiki().logger.warn(error))
    })
    inbound.on('reloadApiKeys', () => {
      void this.reloadApiKeys()
    })
    inbound.on('reloadAuthStrategies', () => {
      void this.activateStrategies()
    })
    inbound.on('addAuthRevoke', value => {
      if (isRevokeRequest(value)) this.revokeUserTokens(value)
    })
  },

  getEffectivePermissions(req, page) {
    if (!isAccessUser(req.user)) throw new Error('Authenticated user is unavailable')
    const commentsEnabled = getWiki().config.features.featurePageComments
    return {
      comments: {
        read: commentsEnabled && this.checkAccess(req.user, ['read:comments'], page),
        write: commentsEnabled && this.checkAccess(req.user, ['write:comments'], page),
        manage: commentsEnabled && this.checkAccess(req.user, ['manage:comments'], page)
      },
      history: { read: this.checkAccess(req.user, ['read:history'], page) },
      source: { read: this.checkAccess(req.user, ['read:source'], page) },
      pages: {
        read: this.checkAccess(req.user, ['read:pages'], page),
        write: this.checkAccess(req.user, ['write:pages'], page),
        manage: this.checkAccess(req.user, ['manage:pages'], page),
        delete: this.checkAccess(req.user, ['delete:pages'], page),
        script: this.checkAccess(req.user, ['write:scripts'], page),
        style: this.checkAccess(req.user, ['write:styles'], page)
      },
      system: { manage: this.checkAccess(req.user, ['manage:system'], page) }
    }
  },

  revokeUserTokens({ id, kind = 'u' }) {
    this.revocationList.set(
      `${kind}${String(id)}`,
      Math.round(DateTime.utc().minus({ seconds: 5 }).toSeconds()),
      Math.ceil(ms(getWiki().config.auth.tokenExpiration) / 1000)
    )
  }
}

export default auth

import passport from 'passport'
import passportJwt from 'passport-jwt'
import jwt from 'jsonwebtoken'
import ms from 'ms'
import { DateTime } from 'luxon'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import pemJwk from 'pem-jwk'
import type NodeCache from 'node-cache'
import type { NextFunction, Request, Response } from 'express'

import commonHelper from '../helpers/common.ts'
import securityHelper from '../helpers/security.ts'
import cache from './cache.ts'
import { apiAccessContract, isApiKeyTransportPath } from '../../shared/api-access.ts'
import { pageRuleRegexMatches } from '../helpers/page-access.ts'

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
  users: {
    getGuestUser(): Promise<StoredUser>
    query(): UsersQuery
    refreshToken(id: number): Promise<{ token: string; user: StoredUser }>
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
  activateStrategies(): Promise<void>
  authenticateUserToken(token: string): Promise<StoredUser | null>
  authenticate(req: Request, res: Response, next: NextFunction): void
  checkAccess(user: AccessUser | undefined, permissions?: string[], page?: PageContext | false): boolean
  checkAssignUserToGroupAccess(requester: AccessUser, groupIds?: number[]): Promise<boolean>
  checkExclusiveAccess(user: AccessUser, includePermissions?: string[], excludePermissions?: string[]): boolean
  getEffectivePermissions(req: Request, page: PageContext): EffectivePermissions
  groups: Record<string, GroupRecord>
  guest: GuestState
  init(): AuthService
  passport: typeof passport
  regenerateCertificates(): Promise<void>
  reloadApiKeys(): Promise<void>
  reloadGroups(): Promise<void>
  resetGuestUser(): Promise<void>
  revocationList: NodeCache
  revokeUserTokens(request: RevokeRequest): void
  strategies: Record<string, ActiveStrategy>
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
const getDecodedUserId = (token: string): number | null => {
  const payload = jwt.decode(token)
  return isRecord(payload) && typeof payload.id === 'number' ? payload.id : null
}
const randomBytesPromise = (size: number): Promise<Buffer> => {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  randomBytes(size, (error, buffer) => (error ? reject(error) : resolve(buffer)))
  return promise
}
const extractBearerToken = (req: Request): string | null => {
  const authorization = req.get('authorization')
  if (!authorization) return null
  const match = /^Bearer ([^\\s]+)$/.exec(authorization)
  return match?.[1] ?? null
}
const isDedicatedMcpRequest = (req: Request): boolean =>
  req.path === apiAccessContract.mcpPath && isRecord(req.route) && req.route.path === apiAccessContract.mcpPath
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
const verifyUserToken = (wiki: WikiContext, token: string): JwtUser | null => {
  try {
    const user = jwt.verify(token, wiki.config.certs.public, {
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js',
      algorithms: ['RS256']
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

const auth: AuthService = {
  strategies: {},
  passport,
  guest: { cacheExpiration: DateTime.utc().minus({ days: 1 }) },
  groups: {},
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

  async activateStrategies() {
    const wiki = getWiki()
    try {
      this.strategies = {}
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

      const enabledStrategies = await wiki.models.authentication.getStrategies()
      for (const strategyRecord of enabledStrategies) {
        try {
          // Strategy key comes from the runtime plugin registry, so this cannot be a static import.
          const imported: unknown = await import(`../modules/authentication/${strategyRecord.strategyKey}/authentication.ts`)
          if (!isStrategyModule(imported)) throw new Error(`Invalid authentication strategy module: ${strategyRecord.strategyKey}`)
          const strategy = imported.default
          const callbackURL = `${wiki.config.host}/login/${strategyRecord.key}/callback`
          const config: StrategyConfig = {
            ...strategyRecord.config,
            audience: wiki.config.auth.audience,
            callbackURL,
            cookieName: 'jwt',
            key: strategyRecord.key,
            redirectUri: callbackURL,
            sessionNamespace: 'wiki'
          }
          await strategy.init(passport, config)
          strategy.config = config
          this.strategies[strategyRecord.key] = { ...strategy, ...strategyRecord, config }
          wiki.logger.info(`Authentication Strategy ${strategyRecord.displayName}: [ OK ]`)
        } catch (error: unknown) {
          wiki.logger.error(`Authentication Strategy ${strategyRecord.displayName} (${strategyRecord.key}): [ FAILED ]`)
          wiki.logger.error(error)
        }
      }
    } catch (error: unknown) {
      wiki.logger.error('Failed to initialize Authentication Strategies: [ ERROR ]')
      wiki.logger.error(error)
    }
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

      if (mustRevalidate) {
        const token = securityHelper.extractJWT(req)
        const userId = token ? getDecodedUserId(token) : null
        if (userId === null) return next()
        try {
          const refreshed = await wiki.models.users.refreshToken(userId)
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
    if (!user?.isActive) return null
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

    let checkState: RuleState = { deny: false, match: false, specificity: '' }
    for (const group of user.groups) {
      const groupId = getGroupId(group)
      if (groupId === null) continue
      for (const rule of this.groups[String(groupId)]?.pageRules ?? []) {
        if (rule.locales?.length && (!page.locale || !rule.locales.includes(page.locale))) continue
        if (!rule.roles.some(role => permissions.includes(role))) continue
        switch (rule.match) {
          case 'START':
            if (`/${page.path}`.startsWith(`/${rule.path}`))
              checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['END', 'REGEX', 'EXACT', 'TAG'] })
            break
          case 'END':
            if (page.path.endsWith(rule.path)) checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['REGEX', 'EXACT', 'TAG'] })
            break
          case 'REGEX':
            if (pageRuleRegexMatches(rule.path, page.path)) checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['EXACT', 'TAG'] })
            break
          case 'TAG':
            for (const tag of page.tags ?? []) {
              if (tag.tag === rule.path) checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['EXACT'] })
            }
            break
          case 'EXACT':
            if (`/${page.path}` === `/${rule.path}`) checkState = this._applyPageRuleSpecificity({ rule, checkState })
            break
        }
      }
    }
    return checkState.match !== false && !checkState.deny
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
    const groups = await getWiki().models.groups.query()
    const indexedGroups: Record<string, GroupRecord> = {}
    for (const group of groups) indexedGroups[String(group.id)] = group
    this.groups = indexedGroups
    this.guest.cacheExpiration = DateTime.utc().minus({ days: 1 })
  },

  async reloadApiKeys() {
    const now = DateTime.utc().toISO()
    if (now === null) throw new Error('Failed to determine the API key validation time')
    const keys = await getWiki().models.apiKeys.query().select('id').where('isRevoked', false).andWhere('expiration', '>', now)
    this.validApiKeys = keys.map(key => key.id)
  },

  async regenerateCertificates() {
    const wiki = getWiki()
    wiki.logger.info('Regenerating certificates...')
    wiki.config.sessionSecret = (await randomBytesPromise(32)).toString('hex')
    const certificates = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: wiki.config.sessionSecret }
    })
    wiki.config.certs = {
      jwk: pemJwk.pem2jwk(certificates.publicKey),
      public: certificates.publicKey,
      private: certificates.privateKey
    }
    await wiki.configSvc.saveToDb(['certs', 'sessionSecret'])
    await this.activateStrategies()
    wiki.events.outbound.emit('reloadAuthStrategies')
    wiki.logger.info('Regenerated certificates: [ COMPLETED ]')
  },

  async resetGuestUser() {
    const wiki = getWiki()
    wiki.logger.info('Resetting guest account...')
    const guestGroup = await wiki.models.groups.query().where('id', 2).first()
    if (!guestGroup) throw new Error('Guest group is missing')
    await wiki.models.users.query().delete().where({ providerKey: 'local', email: 'guest@example.com' }).orWhere('id', 2)
    const guestUser = await wiki.models.users.query().insert({
      id: 2,
      provider: 'local',
      email: 'guest@example.com',
      name: 'Guest',
      password: '',
      locale: 'en',
      defaultEditor: 'markdown',
      tfaIsActive: false,
      isSystem: true,
      isActive: true,
      isVerified: true
    })
    await guestUser.$relatedQuery('groups').relate(guestGroup.id)
    wiki.logger.info('Guest user has been reset: [ COMPLETED ]')
  },

  subscribeToEvents() {
    const inbound = getWiki().events.inbound
    inbound.on('reloadGroups', () => {
      void this.reloadGroups()
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

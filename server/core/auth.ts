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
import { createApiPrincipal, isApiPrincipal } from '../helpers/api-principal.ts'
import { apiAccessContract, isApiKeyTransportPath } from '../../shared/api-access.ts'
import {
  evaluateGroupAccess,
  pageRuleAuthorityMatchesRequester,
  pageRuleRequesterBinding,
  type AccessGroup,
  type AccessPage,
  type PageRuleAuthority
} from '../helpers/group-access.ts'

export type { PageRuleAuthority, PageRuleRequesterBinding } from '../helpers/group-access.ts'

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

type PageContext = AccessPage

interface AuthorityGroupRow extends UnknownRecord {
  id: unknown
  name?: unknown
  permissions: unknown
  pageRules: unknown
}

interface AuthorityTagRow extends UnknownRecord {
  id: unknown
  tag: unknown
  redirectToId?: unknown
  isArchived?: unknown
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


interface AuthenticationError extends Error {
  code: string
  status: number
}
interface StrategyConfig extends UnknownRecord {
  audience?: string
  adminRevision?: string
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

interface EffectivePermissions {
  comments: { read: boolean; write: boolean; manage: boolean }
  pages: { read: boolean; write: boolean; manage: boolean; delete: boolean; script: boolean; style: boolean }
  history: { read: boolean }
  source: { read: boolean }
  system: { manage: boolean }
}

interface RevokeRequest {
  id: number
  kind?: string
}

interface AuthService {
  activateStrategies(strict?: boolean): Promise<void>
  authenticateUserToken(token: string): Promise<StoredUser | null>
  authenticate(req: Request, res: Response, next: NextFunction): void
  checkAccess(user: AccessUser | undefined, permissions: readonly string[]): boolean
  checkPageAccess(user: AccessUser | undefined, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
  loadPageRuleAuthority(requester: AccessUser | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  checkAssignUserToGroupAccess(requester: AccessUser, groupIds?: number[]): Promise<boolean>
  checkExclusiveAccess(user: AccessUser, includePermissions?: string[], excludePermissions?: string[]): boolean
  getEffectivePermissions(req: Request, page: PageContext, authority: PageRuleAuthority): EffectivePermissions
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
const authorityMatches = (value: unknown): value is PageRuleMatch =>
  value === 'START' || value === 'END' || value === 'REGEX' || value === 'TAG' || value === 'EXACT'

const authorityArray = (value: unknown, field: string): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') throw new Error(`Authentication authority ${field} is invalid`)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new Error(`Authentication authority ${field} is invalid`)
  }
}

const authorityStrings = (value: unknown, field: string): string[] => {
  const values = authorityArray(value, field)
  if (!values.every(item => typeof item === 'string')) throw new Error(`Authentication authority ${field} is invalid`)
  return values as string[]
}

const authorityRule = (value: unknown): PageRule => {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('Authentication authority page rule is invalid')
  const id = value.id,
    match = value.match,
    path = value.path,
    deny = value.deny,
    roles = value.roles,
    locales = value.locales
  if (
    (id !== undefined && typeof id !== 'string') ||
    !authorityMatches(match) ||
    typeof path !== 'string' ||
    typeof deny !== 'boolean'
  )
    throw new Error('Authentication authority page rule is invalid')
  const parsedRoles = authorityStrings(roles, 'page rule roles'),
    parsedLocales = locales === undefined ? [] : authorityStrings(locales, 'page rule locales')
  return {
    ...(id === undefined ? {} : { id }),
    match,
    path,
    deny,
    roles: parsedRoles,
    locales: parsedLocales
  }
}

const authorityGroup = (value: AuthorityGroupRow): AccessGroup => {
  const id = value.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Authentication authority group is invalid')
  if (value.name !== undefined && typeof value.name !== 'string') throw new Error('Authentication authority group is invalid')
  const permissions = authorityStrings(value.permissions, `group ${String(id)} permissions`),
    rules = authorityArray(value.pageRules, `group ${String(id)} page rules`).map(authorityRule)
  return Object.freeze({
    id,
    ...(value.name === undefined ? {} : { name: value.name }),
    permissions: Object.freeze(permissions),
    pageRules: Object.freeze(rules.map(rule => Object.freeze({ ...rule, roles: Object.freeze(rule.roles), locales: Object.freeze(rule.locales ?? []) })))
  })
}

const authorityTag = (value: AuthorityTagRow): TagIdentity => {
  const id = value.id,
    tag = value.tag,
    redirectToId = value.redirectToId,
    isArchived = value.isArchived
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof tag !== 'string' ||
    tag.length < 1 ||
    (redirectToId !== undefined && redirectToId !== null && (typeof redirectToId !== 'number' || !Number.isSafeInteger(redirectToId) || redirectToId < 1)) ||
    (isArchived !== undefined && isArchived !== true && isArchived !== false && isArchived !== 0 && isArchived !== 1)
  )
    throw new Error('Authentication authority tag is invalid')
  return {
    id,
    tag,
    redirectToId: redirectToId === undefined ? null : redirectToId,
    isArchived: isArchived === true || isArchived === 1
  }
}

const authoritySnapshot = (requester: AccessUser | undefined, rows: AuthorityGroupRow[], tags: AuthorityTagRow[]): PageRuleAuthority => {
  const seenTagIds = new Set<number>(),
    seenTagNames = new Set<string>(),
    identities = tags.map(authorityTag)
  for (const tag of identities) {
    if (seenTagIds.has(tag.id) || seenTagNames.has(tag.tag)) throw new Error('Authentication authority contains duplicate tags')
    seenTagIds.add(tag.id)
    seenTagNames.add(tag.tag)
  }
  const aliases = tagAliasMap(identities),
    groups = rows.map(authorityGroup),
    permissions = [...new Set(groups.flatMap(group => group.permissions ?? []))]
  return Object.freeze({
    requester,
    permissions: Object.freeze(permissions),
    groups: Object.freeze(groups),
    tagAliases: Object.freeze(aliases)
  })
}

const selectedGroupIds = async (requester: AccessUser | undefined, transaction: Knex.Transaction): Promise<number[]> => {
  const binding = pageRuleRequesterBinding(requester)
  if (binding.kind === 'anonymous') return []
  if (binding.kind === 'apiKey') return [binding.groupId]
  const rows = await transaction<{ groupId: unknown }>('userGroups')
    .select('groupId')
    .where('userId', binding.userId)
    .orderBy('groupId')
  const ids = rows.map(row => row.groupId)
  if (!ids.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) throw new Error('Authentication authority membership is invalid')
  return [...new Set(ids)].sort((left, right) => left - right)
}

const loadPageRuleAuthorityInTransaction = async (requester: AccessUser | undefined, transaction: Knex.Transaction): Promise<PageRuleAuthority> => {
  const groupIds = await selectedGroupIds(requester, transaction)
  const tagRows = await transaction<AuthorityTagRow>('tags')
    .select('id', 'tag', 'redirectToId', 'isArchived')
    .orderBy('id')
    .forShare()
  const groupRows =
    groupIds.length === 0
      ? []
      : await transaction<AuthorityGroupRow>('groups')
          .select('id', 'name', 'permissions', 'pageRules')
          .whereIn('id', groupIds)
          .orderBy('id')
          .forShare()
  return authoritySnapshot(requester, groupRows, tagRows)
}

export const loadPageRuleAuthority = async (
  requester: AccessUser | undefined,
  transaction?: Knex.Transaction
): Promise<PageRuleAuthority> => {
  const wiki = getWiki()
  if (transaction) return loadPageRuleAuthorityInTransaction(requester, transaction)
  return wiki.models.knex.transaction(
    current => loadPageRuleAuthorityInTransaction(requester, current),
    { isolationLevel: 'repeatable read' }
  )
}


const validAuthority = (value: unknown): value is PageRuleAuthority => {
  if (!isRecord(value) || Array.isArray(value)) return false
  if (value.requester !== undefined && (!isRecord(value.requester) || Array.isArray(value.requester))) return false
  if (!Array.isArray(value.permissions) || !value.permissions.every(permission => typeof permission === 'string')) return false
  if (!Array.isArray(value.groups) || !value.groups.every(group => {
    if (!isRecord(group) || Array.isArray(group) || typeof group.id !== 'number' || !Number.isSafeInteger(group.id) || group.id < 1) return false
    if (group.name !== undefined && typeof group.name !== 'string') return false
    if (group.permissions !== undefined && (!Array.isArray(group.permissions) || !group.permissions.every(permission => typeof permission === 'string'))) return false
    return Array.isArray(group.pageRules) && group.pageRules.every(rule => {
      if (!isRecord(rule) || Array.isArray(rule) || !authorityMatches(rule.match) || typeof rule.path !== 'string' || typeof rule.deny !== 'boolean') return false
      if (rule.id !== undefined && typeof rule.id !== 'string') return false
      if (!Array.isArray(rule.roles) || !rule.roles.every(role => typeof role === 'string')) return false
      return rule.locales === undefined || (Array.isArray(rule.locales) && rule.locales.every(locale => typeof locale === 'string'))
    })
  })) return false
  const aliases = value.tagAliases
  return isRecord(aliases) && !Array.isArray(aliases) && Object.values(aliases).every(alias => alias === null || typeof alias === 'string')
}

const validAccessPage = (value: unknown): value is AccessPage => {
  if (!isRecord(value) || Array.isArray(value) || typeof value.path !== 'string' || value.path.length < 1) return false
  if (value.locale !== undefined && typeof value.locale !== 'string') return false
  return (
    value.tags === undefined ||
    (Array.isArray(value.tags) &&
      value.tags.every(tag => isRecord(tag) && !Array.isArray(tag) && typeof tag.tag === 'string' && tag.tag.length > 0))
  )
}
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
              sessionNamespace: 'wiki',
              adminRevision: strategyRecord.adminRevision ?? ''
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
          res.cookie('jwt', refreshed.token, commonHelper.getCookieOpts())
          res.set('x-wiki-auth-refreshed', '1')
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
        const principal = createApiPrincipal(user.api, user.grp, permissions)
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

  checkAccess(user, permissions) {
    if (!user || !Array.isArray(permissions) || !permissions.every(permission => typeof permission === 'string')) return false
    const userPermissions = getPermissions(user)
    if (userPermissions.includes('manage:system')) return true
    return permissions.some(permission => userPermissions.includes(permission))
  },

  checkPageAccess(user, permissions, context, authority) {
    if (
      !isAccessUser(user) ||
      !Array.isArray(permissions) ||
      !permissions.every(permission => typeof permission === 'string') ||
      !validAccessPage(context) ||
      !validAuthority(authority) ||
      !pageRuleAuthorityMatchesRequester(user, authority)
    )
      return false
    return evaluateGroupAccess(authority.permissions, permissions, authority.groups, context, authority.tagAliases, false).allowed
  },

  loadPageRuleAuthority(requester, transaction) {
    return loadPageRuleAuthority(requester, transaction)
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

  getEffectivePermissions(req, page, authority) {
    if (!isAccessUser(req.user)) throw new Error('Authenticated user is unavailable')
    const commentsEnabled = getWiki().config.features.featurePageComments
    return {
      comments: {
        read: commentsEnabled && this.checkPageAccess(req.user, ['read:comments'], page, authority),
        write: commentsEnabled && this.checkPageAccess(req.user, ['write:comments'], page, authority),
        manage: commentsEnabled && this.checkPageAccess(req.user, ['manage:comments'], page, authority)
      },
      history: { read: this.checkPageAccess(req.user, ['read:history'], page, authority) },
      source: { read: this.checkPageAccess(req.user, ['read:source'], page, authority) },
      pages: {
        read: this.checkPageAccess(req.user, ['read:pages'], page, authority),
        write: this.checkPageAccess(req.user, ['write:pages'], page, authority),
        manage: this.checkPageAccess(req.user, ['manage:pages'], page, authority),
        delete: this.checkPageAccess(req.user, ['delete:pages'], page, authority),
        script: this.checkPageAccess(req.user, ['write:scripts'], page, authority),
        style: this.checkPageAccess(req.user, ['write:styles'], page, authority)
      },
      system: { manage: this.checkPageAccess(req.user, ['manage:system'], page, authority) }
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

import type { Request } from 'express'
import type { Knex } from 'knex'

import _ from 'lodash'

import configuration from './configuration.ts'
import errors from './errors.ts'
import { createAuthRateLimiter, type AuthRateLimiter } from '../helpers/auth-rate-limiter.ts'

const { parseConfig, preserveSensitiveConfig, serializeConfig } = configuration
const { ApplicationError } = errors

interface ConfigEntry {
  key: string
  value: string
}
interface Strategy extends Record<string, unknown> {
  key: string
  strategyKey: string
  displayName: string
  order: number
  isEnabled: boolean
  selfRegistration: boolean
  domainWhitelist: string[]
  autoEnrollGroups: number[]
  config: ConfigEntry[] | Record<string, unknown>
}
interface StrategyDefinition extends Record<string, unknown> {
  key: string
  isAvailable?: boolean
  useForm?: boolean
  props?: Record<string, Record<string, unknown>>
}
interface AuthQuery {
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
  insert(data: Record<string, unknown>): Promise<unknown>
  delete(): { where(column: string, value: unknown): Promise<unknown> }
}
interface UserQuery {
  count(expression: string): { where(criteria: Record<string, unknown>): { first(): Promise<{ total: number | string }> } }
}
interface UserModel {
  query(): UserQuery
  login(args: unknown, context: unknown): unknown
  loginTFA(args: unknown, context: unknown): unknown
  loginChangePassword(args: unknown, context: unknown): Promise<{ jwt: string; userId: number }>
  loginForgotPassword(args: unknown, context: unknown): unknown
  resetPassword(args: unknown): Promise<number>
  verifyEmail(args: unknown): unknown
  register(args: Record<string, unknown>, context: unknown): unknown
}
interface AuthenticationModel {
  getStrategies(): Promise<Strategy[]>
  query(): AuthQuery
}
interface AuthService {
  strategies: Record<string, Strategy>
  activateStrategies(): Promise<unknown>
  regenerateCertificates(): unknown
  resetGuestUser(): unknown
  revokeUserTokens(input: { id: number; kind: 'u' }): void
}
interface RegistrationContext {
  req: Request
}
interface AuthenticationErrors {
  BruteTooManyAttempts: new () => Error
}

const getAuthenticationModel = (): AuthenticationModel => (WIKI.models as { authentication: AuthenticationModel }).authentication
const getUserModel = (): UserModel => (WIKI.models as { users: UserModel }).users
const getKnex = (): Knex => {
  const models = WIKI.models as { knex: Knex }
  return models.knex
}
const getDefinitions = (): StrategyDefinition[] => (WIKI.data as { authentication: StrategyDefinition[] }).authentication
const getAuth = (): AuthService => WIKI.auth as unknown as AuthService
const getOutboundEvents = (): { emit(event: string, payload?: Record<string, unknown>): void } => {
  const events = WIKI.events as { outbound: { emit(event: string, payload?: Record<string, unknown>): void } }
  return events.outbound
}
const getConfig = (): { metrics: { isEnabled: boolean } } => WIKI.config as { metrics: { isEnabled: boolean } }
const getMetrics = (): { init(): Promise<unknown> } => WIKI.metrics as { init(): Promise<unknown> }
const getConfigService = (): { saveToDb(keys: string[]): Promise<unknown> } => WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }
const getAuthenticationErrors = (): AuthenticationErrors => WIKI.Error as AuthenticationErrors
const revokeUser = (id: number): void => {
  getAuth().revokeUserTokens({ id, kind: 'u' })
  getOutboundEvents().emit('addAuthRevoke', { id, kind: 'u' })
}

const registrationLimiters = new WeakMap<Knex, AuthRateLimiter>()
const registrationRequest = (context: unknown): Request => {
  if (typeof context !== 'object' || context === null) throw new TypeError('Registration requires request context')
  const req = Reflect.get(context, 'req')
  if (typeof req !== 'object' || req === null) throw new TypeError('Registration requires request context')
  return req as Request
}
const getRegistrationLimiter = (): AuthRateLimiter => {
  const knex = getKnex()
  let limiter = registrationLimiters.get(knex)
  if (limiter === undefined) {
    limiter = createAuthRateLimiter({ knex, keyPrefix: 'auth-api' })
    registrationLimiters.set(knex, limiter)
  }
  return limiter
}
const admitRegistration = async (context: unknown): Promise<void> => {
  const retryAfterMilliseconds = await getRegistrationLimiter().admit(registrationRequest(context))
  if (retryAfterMilliseconds === null) return
  const error = new (getAuthenticationErrors().BruteTooManyAttempts)()
  error.message = 'Too many failed attempts. Try again later.'
  throw Object.assign(error, { status: 429, retryAfterMilliseconds })
}

const validStrategy = (strategy: unknown): strategy is Strategy =>
  Boolean(
    strategy &&
      _.isPlainObject(strategy) &&
      _.isString(Reflect.get(strategy as object, 'key')) &&
      Reflect.get(strategy as object, 'key').length > 0 &&
      _.isString(Reflect.get(strategy as object, 'strategyKey')) &&
      Reflect.get(strategy as object, 'strategyKey').length > 0 &&
      _.isString(Reflect.get(strategy as object, 'displayName')) &&
      Reflect.get(strategy as object, 'displayName').length > 0 &&
      Number.isInteger(Reflect.get(strategy as object, 'order')) &&
      _.isBoolean(Reflect.get(strategy as object, 'isEnabled')) &&
      _.isBoolean(Reflect.get(strategy as object, 'selfRegistration')) &&
      Array.isArray(Reflect.get(strategy as object, 'domainWhitelist')) &&
      Reflect.get(strategy as object, 'domainWhitelist').every(_.isString) &&
      Array.isArray(Reflect.get(strategy as object, 'autoEnrollGroups')) &&
      Reflect.get(strategy as object, 'autoEnrollGroups').every(Number.isInteger) &&
      Array.isArray(Reflect.get(strategy as object, 'config'))
  )

const listDefinitions = () =>
  getDefinitions().map(strategy => ({
    ...strategy,
    isAvailable: strategy.isAvailable === true,
    props: _.sortBy(
      Object.entries(strategy.props ?? {}).map(([key, value]) => ({ key, value: JSON.stringify(value) })),
      'key'
    )
  }))

const listActive = async (enabledOnly?: boolean) => {
  const strategies = (await getAuthenticationModel().getStrategies()).map(strategy => {
    const definition = _.find(getDefinitions(), ['key', strategy.strategyKey]) ?? { key: strategy.strategyKey }
    const serializedConfig = serializeConfig({
      config: strategy.config as Record<string, unknown>,
      definition,
      knownOnly: true,
      maskSensitive: true
    })
    return {
      ...strategy,
      isEnabled: Boolean(strategy.isEnabled),
      selfRegistration: Boolean(strategy.selfRegistration),
      strategy: definition,
      config: _.sortBy(serializedConfig, 'key')
    }
  })
  return enabledOnly ? _.filter(strategies, 'isEnabled') : strategies
}

const listPublic = async () => {
  const strategies = await getAuthenticationModel().getStrategies()
  return _.filter(strategies, 'isEnabled').map(strategy => {
    const definition = _.find(getDefinitions(), ['key', strategy.strategyKey]) ?? { key: strategy.strategyKey }
    return {
      key: strategy.key,
      displayName: strategy.displayName,
      order: strategy.order,
      selfRegistration: Boolean(strategy.selfRegistration),
      strategy: {
        ..._.pick(definition, ['key', 'title', 'logo', 'color', 'icon', 'useForm', 'usernameType']),
        color: typeof definition.color === 'string' ? definition.color : '',
        icon: typeof definition.icon === 'string' ? definition.icon : '',
        useForm: definition.useForm === true,
        usernameType: typeof definition.usernameType === 'string' ? definition.usernameType : 'email'
      }
    }
  })
}

const listProviderOptions = async () =>
  (await getAuthenticationModel().getStrategies()).map(strategy => ({
    key: strategy.key,
    displayName: strategy.displayName,
    order: strategy.order,
    isEnabled: Boolean(strategy.isEnabled)
  }))

const updateStrategies = async (strategies: unknown): Promise<void> => {
  if (!Array.isArray(strategies) || strategies.some(strategy => !validStrategy(strategy))) {
    throw new ApplicationError('strategies must be an array of valid authentication strategies', { code: 'INVALID_AUTHENTICATION_STRATEGIES' })
  }
  const parsedUpdates = strategies.map(strategy => ({
    ...strategy,
    config: parseConfig(strategy.config, {
      errorMessage: 'strategies must be an array of valid authentication strategies',
      code: 'INVALID_AUTHENTICATION_STRATEGIES'
    })
  }))
  const authenticationModel = getAuthenticationModel()
  const previousStrategies = await authenticationModel.getStrategies()
  const updates = parsedUpdates.map(strategy => {
    const definition = _.find(getDefinitions(), ['key', strategy.strategyKey])
    const previous = _.find(previousStrategies, ['key', strategy.key])
    const current = previous && _.isPlainObject(previous.config) ? (previous.config as Record<string, unknown>) : {}
    return {
      ...strategy,
      config: preserveSensitiveConfig({ config: strategy.config, current, definition: definition ?? {} })
    }
  })
  for (const strategy of updates) {
    const patch = {
      key: strategy.key,
      strategyKey: strategy.strategyKey,
      displayName: strategy.displayName,
      order: strategy.order,
      isEnabled: strategy.isEnabled,
      config: strategy.config,
      selfRegistration: strategy.selfRegistration,
      domainWhitelist: { v: strategy.domainWhitelist },
      autoEnrollGroups: { v: strategy.autoEnrollGroups }
    }
    if (_.some(previousStrategies, ['key', strategy.key])) await authenticationModel.query().patch(patch).where('key', strategy.key)
    else await authenticationModel.query().insert(patch)
  }
  for (const strategy of _.differenceBy(previousStrategies, updates, 'key')) {
    const users = await getUserModel().query().count('* as total').where({ providerKey: strategy.key }).first()
    if (_.toSafeInteger(users.total) > 0) {
      throw new ApplicationError(`Cannot delete ${strategy.displayName} as 1 or more users are still using it.`, { code: 'AUTHENTICATION_STRATEGY_IN_USE' })
    }
    await authenticationModel.query().delete().where('key', strategy.key)
  }
  await getAuth().activateStrategies()
  getOutboundEvents().emit('reloadAuthStrategies')
}

const login = (args: unknown, context: unknown): unknown => getUserModel().login(args, context)
const loginForm = (input: { strategyKey: string; username: unknown; password: unknown }, context: unknown): unknown => {
  const { strategyKey, username, password } = input
  const strategy = getAuth().strategies[strategyKey]
  const definition = strategy && _.find(getDefinitions(), ['key', strategy.strategyKey])
  if (!strategy || !definition) throw new ApplicationError('Authentication strategy is invalid', { code: 'INVALID_AUTHENTICATION_STRATEGY' })
  if (!strategy.isEnabled) throw new ApplicationError('Authentication strategy is disabled', { code: 'DISABLED_AUTHENTICATION_STRATEGY' })
  if (!definition.useForm) throw new ApplicationError('REST login only supports form-based strategies', { code: 'UNSUPPORTED_AUTHENTICATION_STRATEGY' })
  if (!username || !password) throw new ApplicationError('username and password are required', { code: 'MISSING_AUTHENTICATION_CREDENTIALS' })
  if (!_.isString(username) || !_.isString(password))
    throw new ApplicationError('username and password must be strings', { code: 'INVALID_AUTHENTICATION_CREDENTIALS' })
  return login({ strategy: strategyKey, username, password }, context)
}
const loginTfa = (args: unknown, context: unknown): unknown => getUserModel().loginTFA(args, context)
const loginChangePassword = async (args: unknown, context: unknown): Promise<{ jwt: string }> => {
  const result = await getUserModel().loginChangePassword(args, context)
  revokeUser(result.userId)
  return { jwt: result.jwt }
}
const forgotPassword = (args: unknown, context: unknown): unknown => getUserModel().loginForgotPassword(args, context)
const regenerateCertificates = (): unknown => getAuth().regenerateCertificates()
const resetGuestUser = (): unknown => getAuth().resetGuestUser()
const register = async (args: Record<string, unknown>, context: RegistrationContext): Promise<unknown> => {
  await admitRegistration(context)
  return getUserModel().register({ ...args, verify: true }, context)
}
const resetPassword = async (args: unknown): Promise<void> => {
  const userId = await getUserModel().resetPassword(args)
  revokeUser(userId)
}
const verifyEmail = (args: unknown): unknown => getUserModel().verifyEmail(args)
const getMetricsState = (): boolean => getConfig().metrics.isEnabled
const setMetricsState = async (enabled: unknown): Promise<void> => {
  const config = getConfig()
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_METRICS_STATE' })
  const previousState = config.metrics.isEnabled
  try {
    config.metrics.isEnabled = enabled
    await getMetrics().init()
    const saved = await getConfigService().saveToDb(['metrics'])
    if (!saved) throw new Error('Failed to persist metrics state change')
  } catch (error) {
    config.metrics.isEnabled = previousState
    try {
      await getMetrics().init()
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`Failed to rollback metrics runtime state: ${message}`, { cause: rollbackError })
    }
    throw error
  }
}

export default {
  forgotPassword,
  getMetricsState,
  listActive,
  listDefinitions,
  listProviderOptions,
  listPublic,
  login,
  loginForm,
  loginChangePassword,
  loginTfa,
  regenerateCertificates,
  register,
  resetGuestUser,
  resetPassword,
  setMetricsState,
  updateStrategies,
  verifyEmail
}

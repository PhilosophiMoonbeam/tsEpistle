import type { Response } from 'express'
import _ from 'lodash'

import errors from './errors.ts'
import { accountAdministration } from './account-administration.ts'
import commonHelper from '../helpers/common.ts'
import { ProfilePreferencesInputSchema } from '../../shared/user-presentation.ts'
import { principalId } from '../helpers/page-access.ts'

const { ApplicationError } = errors
interface GroupRecord extends Record<string, unknown> {
  id: number
  name: string
  permissions?: string[]
}
interface UserRecord extends Record<string, unknown> {
  id: number
  email: string
  name: string
  providerKey: string
  providerId: unknown
  password: string
  tfaSecret: string
  location?: string
  jobTitle?: string
  timezone?: string
  dateFormat?: string
  appearance?: string
  pictureUrl?: string | null
  localeCode?: string
  defaultEditor?: unknown
  fontFamily?: string
  permissions?: string[]
  groups?: GroupRecord[]
  isSystem?: boolean | number
  isActive: boolean | number
  isVerified: boolean | number
  createdAt: unknown
  updatedAt: unknown
  lastLoginAt: unknown
  tfaIsActive?: boolean
  providerName?: string
  providerIs2FACapable?: boolean
  verifyPassword(password: string): Promise<boolean>
  $relatedQuery(relation: 'groups'): GroupQuery
}
export interface ListUser {
  id: number
  email: string
  name: string
  providerKey: string
  isSystem?: boolean
  isActive: boolean
  createdAt: unknown
  lastLoginAt: unknown
}
interface GroupQuery extends PromiseLike<GroupRecord[]> {
  select(...columns: string[]): GroupQuery
}
interface FilterBuilder {
  where(column: string, operatorOrValue: unknown, value?: unknown): FilterBuilder
  orWhere(column: string, operatorOrValue: unknown, value?: unknown): FilterBuilder
}
interface CountRow {
  total: string | number
}
interface CountQuery {
  where(column: string, value: unknown): CountQuery
  first(): Promise<CountRow>
}
interface PatchQuery {
  findById(id: number): Promise<number>
}
interface UserQuery extends PromiseLike<UserRecord[]> {
  where(callback: (builder: FilterBuilder) => void): UserQuery
  where(column: string, operatorOrValue: unknown, value?: unknown): UserQuery
  orWhere(column: string, operatorOrValue: unknown, value?: unknown): UserQuery
  andWhere(column: string, value: unknown): UserQuery
  whereNotNull(column: string): UserQuery
  select(...columns: string[]): UserQuery
  orderBy(column: string, direction: 'asc' | 'desc'): UserQuery
  offset(value: number): UserQuery
  limit(value: number): UserQuery
  count(expression: string): CountQuery
  findById(id: number): Promise<UserRecord | undefined>
  patch(data: Record<string, unknown>): PatchQuery
}
interface CreateUserInput extends Record<string, unknown> {
  providerKey: string
  email: string
  name: string
  groups: number[]
  passwordRaw?: string
  mustChangePassword?: boolean
  sendWelcomeEmail?: boolean
}
interface UpdateUserInput extends Record<string, unknown> {
  id: number
  groups?: number[]
}
interface UserRequest {
  requester: Express.User | undefined
  input: unknown
  response?: Response
}
type WikiErrorName = 'AuthRequired' | 'AuthAccountBanned' | 'AuthAccountNotVerified' | 'AuthProviderInvalid' | 'AuthPasswordInvalid' | 'InputInvalid'
interface WikiUsers {
  Error: Record<WikiErrorName, new () => Error>
  auth: {
    strategies: Record<string, unknown>
    checkAssignUserToGroupAccess(requester: Express.User | undefined, groups: number[] | undefined): Promise<boolean>
    revokeUserTokens(input: { id: number; kind: 'u' }): void
  }
  data: { authentication: unknown }
  events: { outbound: { emit(event: 'addAuthRevoke', input: { id: number; kind: 'u' }): void } }
  models: {
    users: {
      query(): UserQuery
      createNewUser(input: CreateUserInput): Promise<unknown>
      sendWelcomeEmail(input: { id: number; expectedEmail?: string }): Promise<void>
      updateUser(input: UpdateUserInput): Promise<boolean>
      deleteUser(id: number, replaceId: number): Promise<unknown>
      refreshToken(user: number | UserRecord): Promise<{ token: string }>
    }
    pages: { query(): { count(expression: string): CountQuery } }
  }
}
interface ListOptions {
  page: number
  pageSize: number
  offset: number
  filter: string
  providerKey: string
  orderBy: string
  orderByDirection: 'asc' | 'desc'
}
interface AuthDefinition extends Record<string, unknown> {
  key: string
  useForm?: boolean
}
interface AuthStrategy extends Record<string, unknown> {
  strategyKey: string
  displayName: string
  strategy?: AuthDefinition
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isAuthStrategy = (value: unknown): value is AuthStrategy =>
  isRecord(value) &&
  typeof value.strategyKey === 'string' &&
  typeof value.displayName === 'string' &&
  (value.strategy === undefined || isRecord(value.strategy))
const wiki = WIKI as unknown as WikiUsers

const recordValue = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new ApplicationError('input must be an object', { code: 'INVALID_INPUT' })
  return value
}
const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ApplicationError(`${label} must be a positive integer`, { code: 'INVALID_INPUT' })
  return value
}
const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new ApplicationError(`${label} must be a string`, { code: 'INVALID_INPUT' })
  return value
}
const groupsValue = (value: unknown): number[] => {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0))
    throw new ApplicationError('groups must contain positive integers', { code: 'INVALID_INPUT' })
  return value
}
const optionalString = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]
  return value === undefined || value === null ? undefined : stringValue(value, key)
}
const strategyFor = (key: string): AuthStrategy | undefined => {
  const value = wiki.auth.strategies[key]
  return isAuthStrategy(value) ? value : undefined
}
const definitionFor = (key: string): AuthDefinition | undefined =>
  Array.isArray(wiki.data.authentication)
    ? wiki.data.authentication.find(
        (value: unknown): value is AuthDefinition => isRecord(value) && value.key === key && (value.useForm === undefined || typeof value.useForm === 'boolean')
      )
    : undefined

const listOrderFields: readonly string[] = ['id', 'name', 'email', 'providerKey', 'createdAt', 'lastLoginAt']
const normalizeListOptions = (value: unknown): ListOptions => {
  const args = isRecord(value) ? value : {}
  const page = Math.max(_.toSafeInteger(args.page) || 1, 1)
  const pageSize = Math.max(_.toSafeInteger(args.pageSize) || 15, 1)
  const orderBy = typeof args.orderBy === 'string' ? args.orderBy : ''
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    filter: typeof args.filter === 'string' ? _.trim(args.filter) : '',
    providerKey: typeof args.providerKey === 'string' && args.providerKey ? args.providerKey : 'all',
    orderBy: listOrderFields.includes(orderBy) ? orderBy : 'name',
    orderByDirection: typeof args.orderByDirection === 'string' && _.toLower(args.orderByDirection) === 'desc' ? 'desc' : 'asc'
  }
}
const applyListFilters = (query: UserQuery, options: ListOptions): UserQuery => {
  if (options.filter)
    query.where(builder => {
      builder.where('email', 'like', `%${options.filter}%`).orWhere('name', 'like', `%${options.filter}%`)
    })
  if (options.providerKey !== 'all') query.andWhere('providerKey', options.providerKey)
  return query
}
const list = async (args: unknown): Promise<{ users: ListUser[]; total: number }> => {
  const options = normalizeListOptions(args)
  const totalResult = await applyListFilters(wiki.models.users.query(), options).count('* as total').first()
  const users = await applyListFilters(wiki.models.users.query(), options)
    .select('id', 'email', 'name', 'providerKey', 'isSystem', 'isActive', 'createdAt', 'lastLoginAt')
    .orderBy(options.orderBy, options.orderByDirection)
    .offset(options.offset)
    .limit(options.pageSize)
  return {
    users: users.map(user => ({
      ...user,
      isSystem: user.isSystem === true || user.isSystem === 1,
      isActive: user.isActive === true || user.isActive === 1
    })),
    total: _.toSafeInteger(totalResult.total)
  }
}
const search = (value: unknown): UserQuery => {
  const query = stringValue(value, 'query')
  return wiki.models.users
    .query()
    .where('email', 'like', `%${query}%`)
    .orWhere('name', 'like', `%${query}%`)
    .limit(10)
    .select('id', 'name', 'email', 'providerKey')
}
const lastLogins = (): UserQuery =>
  wiki.models.users.query().select('id', 'name', 'lastLoginAt').whereNotNull('lastLoginAt').orderBy('lastLoginAt', 'desc').limit(10)
const get = async (value: unknown): Promise<UserRecord> => {
  const user = await wiki.models.users.query().findById(positiveInteger(value, 'id'))
  if (!user) throw new ApplicationError('User not found', { code: 'USER_NOT_FOUND', status: 404 })
  user.password = ''
  user.tfaSecret = ''
  const strategy = strategyFor(user.providerKey)
  if (strategy) {
    const definition = definitionFor(strategy.strategyKey)
    if (definition) strategy.strategy = definition
    user.providerName = strategy.displayName
    user.providerIs2FACapable = definition?.useForm ?? false
  }
  return user
}
const getAdminDetail = async (value: unknown) => {
  const user = await get(value)
  const provider = strategyFor(user.providerKey)
  const definition = provider ? definitionFor(provider.strategyKey) : undefined
  const groups = await user.$relatedQuery('groups').select('groups.id', 'groups.name')
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    providerKey: user.providerKey,
    providerName: provider?.displayName ?? 'Unknown',
    providerId: user.providerId ?? null,
    providerIs2FACapable: definition?.useForm ?? false,
    location: user.location || '',
    jobTitle: user.jobTitle || '',
    timezone: user.timezone || '',
    isSystem: Boolean(user.isSystem),
    isActive: Boolean(user.isActive),
    isVerified: Boolean(user.isVerified),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
    tfaIsActive: Boolean(user.tfaIsActive),
    groups: groups.map(group => _.pick(group, ['id', 'name']))
  }
}
const createInput = (value: unknown): CreateUserInput => {
  const input = recordValue(value)
  const result: CreateUserInput = {
    providerKey: stringValue(input.providerKey, 'providerKey'),
    email: stringValue(input.email, 'email'),
    name: stringValue(input.name, 'name'),
    groups: groupsValue(input.groups)
  }
  const passwordRaw = optionalString(input, 'passwordRaw')
  if (passwordRaw !== undefined) result.passwordRaw = passwordRaw
  if (input.mustChangePassword !== undefined && typeof input.mustChangePassword !== 'boolean')
    throw new ApplicationError('mustChangePassword must be a boolean', { code: 'INVALID_INPUT' })
  if (typeof input.mustChangePassword === 'boolean') result.mustChangePassword = input.mustChangePassword
  if (input.sendWelcomeEmail !== undefined && typeof input.sendWelcomeEmail !== 'boolean')
    throw new ApplicationError('sendWelcomeEmail must be a boolean', { code: 'INVALID_INPUT' })
  if (typeof input.sendWelcomeEmail === 'boolean') result.sendWelcomeEmail = input.sendWelcomeEmail
  return result
}
const updateInput = (value: unknown): UpdateUserInput => {
  const input = recordValue(value)
  const result: UpdateUserInput = { id: positiveInteger(input.id, 'id') }
  const stringFields = ['email', 'name', 'newPassword', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance']
  for (const field of stringFields) {
    const normalized = optionalString(input, field)
    if (normalized !== undefined) result[field] = normalized
  }
  if (input.groups !== undefined && input.groups !== null) result.groups = groupsValue(input.groups)
  return result
}
const create = async ({ requester, input }: UserRequest): Promise<{ id: number; welcomeEmailError?: string }> => {
  const normalized = createInput(input), store = accountAdministration(), options = await store.creationOptions(requester)
  const result = await store.create(requester, { fingerprint: options.fingerprint, providerKey: normalized.providerKey, profile: { name: normalized.name, email: normalized.email, groups: normalized.groups, location: '', jobTitle: '', timezone: 'UTC' }, password: normalized.passwordRaw, isVerified: true, mustChangePassword: normalized.mustChangePassword ?? false, reason: 'Account created through the administration API' })
  if (normalized.sendWelcomeEmail) {
    try { await wiki.models.users.sendWelcomeEmail({ id: result.id }) }
    catch { return { ...result, welcomeEmailError: 'The account was created, but the welcome email could not be sent.' } }
  }
  return result
}
const update = async ({ requester, input }: UserRequest): Promise<void> => {
  const normalized = updateInput(input), store = accountAdministration(), current = await store.inspect(requester, normalized.id)
  const profile = { ...current.profile }
  for (const key of ['name', 'email', 'location', 'jobTitle', 'timezone'] as const) if (typeof normalized[key] === 'string') profile[key] = normalized[key]
  if (normalized.groups) profile.groups = normalized.groups
  // Legacy transports have no client review token. Read and pass a current
  // fingerprint so even these writes use the same target guards and CAS boundary.
  if (JSON.stringify(profile) === JSON.stringify(current.profile) && !normalized.newPassword && normalized.appearance === undefined && normalized.dateFormat === undefined) return
  await store.updateProfile(requester, normalized.id, { fingerprint: current.fingerprint, reason: 'Account updated through the administration API', profile, password: normalized.newPassword, appearance: normalized.appearance, dateFormat: normalized.dateFormat })
  revoke(normalized.id)
}
const revoke = (id: number): void => {
  wiki.auth.revokeUserTokens({ id, kind: 'u' })
  wiki.events.outbound.emit('addAuthRevoke', { id, kind: 'u' })
}
const requesterValue = (value: unknown): Express.User | undefined => isRecord(value) ? value as Express.User : undefined
const remove = async (value: unknown): Promise<void> => {
  const input = recordValue(value), id = positiveInteger(input.id, 'id'), replaceId = positiveInteger(input.replaceId, 'replaceId'), requester = requesterValue(input.requester), store = accountAdministration()
  const current = await store.inspect(requester, id)
  await store.remove(requester, id, { fingerprint: current.fingerprint, replaceId, reason: 'Account deleted through the administration API' })
  revoke(id)
}
const setActive = async (value: unknown): Promise<void> => {
  const input = recordValue(value), id = positiveInteger(input.id, 'id'), requester = requesterValue(input.requester), store = accountAdministration()
  if (typeof input.isActive !== 'boolean') throw new ApplicationError('isActive must be a boolean', { code: 'INVALID_INPUT' })
  const current = await store.inspect(requester, id)
  if (current.isActive === input.isActive) return
  await store.act(requester, id, { fingerprint: current.fingerprint, action: input.isActive ? 'activate' : 'deactivate', reason: 'Account availability updated through the administration API' })
  revoke(id)
}
const verify = async (value: unknown, requester?: Express.User): Promise<void> => {
  const id = positiveInteger(value, 'id'), store = accountAdministration(), current = await store.inspect(requester, id)
  if (current.isVerified) return
  await store.act(requester, id, { fingerprint: current.fingerprint, action: 'verify', reason: 'Email address verified through the administration API' })
}
const sendWelcomeEmail = async (value: unknown, requester?: Express.User, review?: Record<string, unknown>): Promise<void> => {
  const id = positiveInteger(value, 'id'), store = accountAdministration()
  const input = review ?? { fingerprint: (await store.inspect(requester, id)).fingerprint, reason: 'Welcome email requested through the administration API' }
  const prepared = await store.prepareWelcome(requester, id, input)
  let accepted = false
  try { await wiki.models.users.sendWelcomeEmail({ id, expectedEmail: prepared.email }); accepted = true }
  catch { /* Preserve a bounded outcome without recording mail transport credentials. */ }
  try { await store.finishWelcome(id, prepared.requestId, accepted) }
  catch { throw new ApplicationError(accepted ? 'The mail service accepted the welcome email, but its history could not be updated. Do not resend without checking delivery.' : 'The welcome email failed and its history could not be updated.', { status: 503 }) }
  if (!accepted) throw new ApplicationError('The mail service did not accept the welcome email. Check Mail settings before retrying.', { status: 502 })
}
const setTfa = async (value: unknown): Promise<void> => {
  const input = recordValue(value), id = positiveInteger(input.id, 'id'), requester = requesterValue(input.requester), store = accountAdministration()
  if (typeof input.enabled !== 'boolean') throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_INPUT' })
  const current = await store.inspect(requester, id)
  const action = input.enabled ? current.twoFactor === 'enrolled' ? 'reset-2fa' : 'require-2fa' : 'disable-2fa'
  await store.act(requester, id, { fingerprint: current.fingerprint, action, reason: 'Authenticator policy updated through the administration API' })
  revoke(id)
}
const requireProfileUser = async (requester: Express.User | undefined): Promise<UserRecord> => {
  const userId = principalId(requester)
  const hasOwnershipIdentity = isRecord(requester) && Object.hasOwn(requester, 'ownershipUserId')
  const ownershipUserId = hasOwnershipIdentity ? requester.ownershipUserId : undefined
  const requesterId = requester?.id
  if (
    userId === null ||
    userId === 2 ||
    requesterId !== userId ||
    requester?.ownershipUserId === null ||
    (hasOwnershipIdentity && ownershipUserId !== userId)
  ) {
    throw new wiki.Error.AuthRequired()
  }
  const user = await wiki.models.users.query().findById(userId)
  if (!user) throw new wiki.Error.AuthRequired()
  if (!user.isActive) throw new wiki.Error.AuthAccountBanned()
  return user
}
const getProfile = async (requester: Express.User | undefined): Promise<UserRecord> => {
  const user = await requireProfileUser(requester)
  const groups = await user.$relatedQuery('groups').select('groups.id', 'name', 'permissions')
  user.groups = groups
  user.permissions = _.uniq(groups.flatMap(group => Array.isArray(group.permissions) ? group.permissions.filter((permission): permission is string => typeof permission === 'string') : []))
  user.providerName = strategyFor(user.providerKey)?.displayName ?? 'Unknown'
  user.lastLoginAt = user.lastLoginAt || user.updatedAt
  user.password = ''
  user.providerId = ''
  user.tfaSecret = ''
  return user
}
const issueReplacementCookie = (response: Response | undefined, token: string): void => {
  if (!response) throw new Error('Authentication response is unavailable')
  response.cookie('jwt', token, commonHelper.getCookieOpts())
  response.set('Cache-Control', 'no-store')
}
const updateProfile = async ({ requester, input: value, response }: UserRequest): Promise<void> => {
  const user = await requireProfileUser(requester)
  if (!user.isVerified) throw new wiki.Error.AuthAccountNotVerified()
  const input = recordValue(value)
  const name = stringValue(input.name, 'name')
  const jobTitle = stringValue(input.jobTitle, 'jobTitle')
  const location = stringValue(input.location, 'location')
  const timezone = stringValue(input.timezone, 'timezone')
  const dateFormat = stringValue(input.dateFormat, 'dateFormat')
  const appearance = stringValue(input.appearance, 'appearance')
  if (!['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD'].includes(dateFormat)) throw new wiki.Error.InputInvalid()
  if (!['', 'light', 'dark', 'system'].includes(appearance)) throw new wiki.Error.InputInvalid()
  await wiki.models.users.updateUser({
    id: user.id,
    name: _.trim(name),
    jobTitle: _.trim(jobTitle),
    location: _.trim(location),
    timezone,
    dateFormat,
    appearance
  })
  issueReplacementCookie(response, (await wiki.models.users.refreshToken(user.id)).token)
}
const updateProfilePreferences = async ({ requester, input: value, response }: UserRequest): Promise<void> => {
  const user = await requireProfileUser(requester)
  if (!user.isVerified) throw new wiki.Error.AuthAccountNotVerified()
  const result = ProfilePreferencesInputSchema.safeParse(value)
  if (!result.success) throw new wiki.Error.InputInvalid()
  await wiki.models.users.updateUser({ id: user.id, ...result.data })
  issueReplacementCookie(response, (await wiki.models.users.refreshToken(user.id)).token)
}

const changePassword = async (value: unknown): Promise<void> => {
  const input = recordValue(value)
  const user = await requireProfileUser(isRecord(input.requester) ? input.requester : undefined)
  if (!user.isVerified) throw new wiki.Error.AuthAccountNotVerified()
  if (user.providerKey !== 'local') throw new wiki.Error.AuthProviderInvalid()
  const current = stringValue(input.current, 'current')
  const newPassword = stringValue(input.newPassword, 'newPassword')
  try {
    await user.verifyPassword(current)
  } catch {
    throw new wiki.Error.AuthPasswordInvalid()
  }
  if (await wiki.models.users.updateUser({ id: user.id, newPassword })) revoke(user.id)
  const response = input.response as Response | undefined
  issueReplacementCookie(response, (await wiki.models.users.refreshToken(user.id)).token)
}
const listUserGroups = (user: UserRecord): GroupQuery => user.$relatedQuery('groups')
const listProfileGroups = async (user: UserRecord): Promise<string[]> => (await user.$relatedQuery('groups')).map(group => group.name)
const countPages = async (user: UserRecord): Promise<number> =>
  _.toSafeInteger((await wiki.models.pages.query().count('* as total').where('creatorId', user.id).first()).total)

export default {
  changePassword,
  countPages,
  create,
  get,
  getAdminDetail,
  getProfile,
  lastLogins,
  list,
  listProfileGroups,
  listUserGroups,
  remove,
  search,
  sendWelcomeEmail,
  setActive,
  setTfa,
  update,
  updateProfile,
  updateProfilePreferences,
  verify
}

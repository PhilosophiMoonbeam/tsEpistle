import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

interface GroupRecord extends Record<string, unknown> { id: number, name: string }
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
interface GroupQuery extends PromiseLike<GroupRecord[]> { select(...columns: string[]): GroupQuery }
interface FilterBuilder {
  where(column: string, operatorOrValue: unknown, value?: unknown): FilterBuilder
  orWhere(column: string, operatorOrValue: unknown, value?: unknown): FilterBuilder
}
interface CountRow { total: string | number }
interface CountQuery { where(column: string, value: unknown): CountQuery, first(): Promise<CountRow> }
interface PatchQuery { findById(id: number): Promise<number> }
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
interface UserRequest { requester: Express.User | undefined, input: unknown }
type WikiErrorName = 'AuthRequired' | 'AuthAccountBanned' | 'AuthAccountNotVerified' | 'AuthProviderInvalid' | 'AuthPasswordInvalid' | 'InputInvalid'
interface WikiUsers {
  Error: Record<WikiErrorName, new () => Error>
  auth: {
    strategies: Record<string, unknown>
    checkAssignUserToGroupAccess(requester: Express.User | undefined, groups: number[] | undefined): Promise<boolean>
    revokeUserTokens(input: { id: number, kind: 'u' }): void
  }
  data: { authentication: unknown }
  events: { outbound: { emit(event: 'addAuthRevoke', input: { id: number, kind: 'u' }): void } }
  models: {
    users: {
      query(): UserQuery
      createNewUser(input: CreateUserInput): Promise<unknown>
      updateUser(input: UpdateUserInput): Promise<unknown>
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
interface AuthDefinition extends Record<string, unknown> { key: string, useForm?: boolean }
interface AuthStrategy extends Record<string, unknown> { strategyKey: string, displayName: string, strategy?: AuthDefinition }

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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ApplicationError(`${label} must be a positive integer`, { code: 'INVALID_INPUT' })
  return value
}
const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new ApplicationError(`${label} must be a string`, { code: 'INVALID_INPUT' })
  return value
}
const groupsValue = (value: unknown): number[] => {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) throw new ApplicationError('groups must contain positive integers', { code: 'INVALID_INPUT' })
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
const definitionFor = (key: string): AuthDefinition | undefined => Array.isArray(wiki.data.authentication)
  ? wiki.data.authentication.find((value: unknown): value is AuthDefinition => isRecord(value) && value.key === key && (value.useForm === undefined || typeof value.useForm === 'boolean'))
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
  if (options.filter) query.where(builder => { builder.where('email', 'like', `%${options.filter}%`).orWhere('name', 'like', `%${options.filter}%`) })
  if (options.providerKey !== 'all') query.andWhere('providerKey', options.providerKey)
  return query
}
const list = async (args: unknown): Promise<{ users: ListUser[], total: number }> => {
  const options = normalizeListOptions(args)
  const totalResult = await applyListFilters(wiki.models.users.query(), options).count('* as total').first()
  const users = await applyListFilters(wiki.models.users.query(), options)
    .select('id', 'email', 'name', 'providerKey', 'isSystem', 'isActive', 'createdAt', 'lastLoginAt')
    .orderBy(options.orderBy, options.orderByDirection).offset(options.offset).limit(options.pageSize)
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
  return wiki.models.users.query().where('email', 'like', `%${query}%`).orWhere('name', 'like', `%${query}%`).limit(10).select('id', 'name', 'email', 'providerKey')
}
const lastLogins = (): UserQuery => wiki.models.users.query().select('id', 'name', 'lastLoginAt').whereNotNull('lastLoginAt').orderBy('lastLoginAt', 'desc').limit(10)
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
    id: user.id, name: user.name, email: user.email, providerKey: user.providerKey,
    providerName: provider?.displayName ?? 'Unknown', providerId: user.providerId ?? null,
    providerIs2FACapable: definition?.useForm ?? false, location: user.location || '', jobTitle: user.jobTitle || '',
    timezone: user.timezone || '', isSystem: Boolean(user.isSystem), isActive: Boolean(user.isActive),
    isVerified: Boolean(user.isVerified), createdAt: user.createdAt, updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null, tfaIsActive: Boolean(user.tfaIsActive), groups: groups.map(group => _.pick(group, ['id', 'name']))
  }
}
const createInput = (value: unknown): CreateUserInput => {
  const input = recordValue(value)
  const result: CreateUserInput = {
    providerKey: stringValue(input.providerKey, 'providerKey'), email: stringValue(input.email, 'email'),
    name: stringValue(input.name, 'name'), groups: groupsValue(input.groups)
  }
  const passwordRaw = optionalString(input, 'passwordRaw')
  if (passwordRaw !== undefined) result.passwordRaw = passwordRaw
  if (input.mustChangePassword !== undefined && typeof input.mustChangePassword !== 'boolean') throw new ApplicationError('mustChangePassword must be a boolean', { code: 'INVALID_INPUT' })
  if (typeof input.mustChangePassword === 'boolean') result.mustChangePassword = input.mustChangePassword
  if (input.sendWelcomeEmail !== undefined && typeof input.sendWelcomeEmail !== 'boolean') throw new ApplicationError('sendWelcomeEmail must be a boolean', { code: 'INVALID_INPUT' })
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
const create = async ({ requester, input }: UserRequest): Promise<void> => {
  const normalized = createInput(input)
  if (!(await wiki.auth.checkAssignUserToGroupAccess(requester, normalized.groups))) throw new ApplicationError('You are not authorized to create a user with an assignment to an administrative group.', { code: 'USER_CREATE_GROUP_FORBIDDEN', status: 403 })
  await wiki.models.users.createNewUser(normalized)
}
const update = async ({ requester, input }: UserRequest): Promise<void> => {
  const normalized = updateInput(input)
  if (!(await wiki.auth.checkAssignUserToGroupAccess(requester, normalized.groups))) throw new ApplicationError('You are not authorized to modify / assign a user from / to an administrative group.', { code: 'USER_UPDATE_GROUP_FORBIDDEN', status: 403 })
  await wiki.models.users.updateUser(normalized)
}
const revoke = (id: number): void => {
  wiki.auth.revokeUserTokens({ id, kind: 'u' })
  wiki.events.outbound.emit('addAuthRevoke', { id, kind: 'u' })
}
const remove = async (value: unknown): Promise<void> => {
  const input = recordValue(value)
  const id = positiveInteger(input.id, 'id')
  const replaceId = positiveInteger(input.replaceId, 'replaceId')
  if (id <= 2) throw new ApplicationError('Cannot delete a protected system account.', { code: 'USER_DELETE_PROTECTED', status: 400 })
  try { await wiki.models.users.deleteUser(id, replaceId) } catch (err: unknown) {
    if (err instanceof Error && _.includes(_.toLower(err.message), 'foreign')) throw new ApplicationError('Cannot delete user because of content relational constraints.', { code: 'USER_DELETE_FOREIGN_CONSTRAINT', status: 400 })
    throw err
  }
  revoke(id)
}
const setActive = async (value: unknown): Promise<void> => {
  const input = recordValue(value)
  const id = positiveInteger(input.id, 'id')
  if (typeof input.isActive !== 'boolean') throw new ApplicationError('isActive must be a boolean', { code: 'INVALID_INPUT' })
  if (!input.isActive && id <= 2) throw new ApplicationError('Cannot deactivate system accounts.', { code: 'USER_DEACTIVATE_PROTECTED', status: 400 })
  await wiki.models.users.query().patch({ isActive: input.isActive }).findById(id)
  if (!input.isActive) revoke(id)
}
const verify = (value: unknown): Promise<number> => wiki.models.users.query().patch({ isVerified: true }).findById(positiveInteger(value, 'id'))
const setTfa = (value: unknown): Promise<number> => {
  const input = recordValue(value)
  const id = positiveInteger(input.id, 'id')
  if (typeof input.enabled !== 'boolean') throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_INPUT' })
  return wiki.models.users.query().patch({ tfaIsActive: input.enabled, tfaSecret: null }).findById(id)
}
const requireProfileUser = async (requester: Express.User | undefined): Promise<UserRecord> => {
  if (typeof requester?.id !== 'number' || requester.id < 1 || requester.id === 2) throw new wiki.Error.AuthRequired()
  const user = await wiki.models.users.query().findById(requester.id)
  if (!user) throw new wiki.Error.AuthRequired()
  if (!user.isActive) throw new wiki.Error.AuthAccountBanned()
  return user
}
const getProfile = async (requester: Express.User | undefined): Promise<UserRecord> => {
  const user = await requireProfileUser(requester)
  user.providerName = strategyFor(user.providerKey)?.displayName ?? 'Unknown'
  user.lastLoginAt = user.lastLoginAt || user.updatedAt
  user.password = ''
  user.providerId = ''
  user.tfaSecret = ''
  return user
}
const updateProfile = async ({ requester, input: value }: UserRequest): Promise<string> => {
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
  await wiki.models.users.updateUser({ id: user.id, name: _.trim(name), jobTitle: _.trim(jobTitle), location: _.trim(location), timezone, dateFormat, appearance })
  return (await wiki.models.users.refreshToken(user.id)).token
}
const changePassword = async (value: unknown): Promise<string> => {
  const input = recordValue(value)
  const user = await requireProfileUser(isRecord(input.requester) ? input.requester : undefined)
  if (!user.isVerified) throw new wiki.Error.AuthAccountNotVerified()
  if (user.providerKey !== 'local') throw new wiki.Error.AuthProviderInvalid()
  const current = stringValue(input.current, 'current')
  const newPassword = stringValue(input.newPassword, 'newPassword')
  try { await user.verifyPassword(current) } catch { throw new wiki.Error.AuthPasswordInvalid() }
  await wiki.models.users.updateUser({ id: user.id, newPassword })
  return (await wiki.models.users.refreshToken(user)).token
}
const listUserGroups = (user: UserRecord): GroupQuery => user.$relatedQuery('groups')
const listProfileGroups = async (user: UserRecord): Promise<string[]> => (await user.$relatedQuery('groups')).map(group => group.name)
const countPages = async (user: UserRecord): Promise<number> => _.toSafeInteger((await wiki.models.pages.query().count('* as total').where('creatorId', user.id).first()).total)

export default {
  changePassword, countPages, create, get, getAdminDetail, getProfile, lastLogins, list, listProfileGroups,
  listUserGroups, remove, search, setActive, setTfa, update, updateProfile, verify
}

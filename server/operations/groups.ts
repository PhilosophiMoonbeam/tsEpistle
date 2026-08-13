import { createRequire } from 'node:module'

import errors from './errors.ts'

const { ApplicationError } = errors

const safeRegex: unknown = createRequire(import.meta.url)('safe-regex')
if (typeof safeRegex !== 'function') {
  throw new TypeError('safe-regex must export a function')
}

interface PageRule extends Record<string, unknown> {
  match: string
  path: string
}

interface UserRecord extends Record<string, unknown> {
  id: number
  name: string
  email: string
}

interface RelationMutation extends PromiseLike<number> {
  where(column: string, value: unknown): RelationMutation
}

interface UserRelationQuery extends PromiseLike<UserRecord[]> {
  select(...columns: string[]): UserRelationQuery
  relate(id: number): Promise<unknown>
  unrelate(): RelationMutation
}

interface GroupRecord extends Record<string, unknown> {
  id: number
  name: string
  isSystem: boolean
  permissions?: unknown
  redirectOnLogin?: string
  createdAt?: unknown
  updatedAt?: unknown
  userCount?: string
  $relatedQuery(relation: 'users'): UserRelationQuery
}

interface GroupMutation extends PromiseLike<number> {
  where(column: string, value: unknown): GroupMutation
}

interface GroupQuery extends PromiseLike<GroupRecord[]> {
  select(...columns: unknown[]): GroupQuery
  findById(id: number): Promise<GroupRecord | undefined>
  insertAndFetch(data: Record<string, unknown>): Promise<GroupRecord>
  patch(data: Record<string, unknown>): GroupMutation
  deleteById(id: number): Promise<number>
}

interface GroupAggregateQuery {
  count(): GroupAggregateQuery
  as(alias: string): unknown
}

interface UserQuery {
  findById(id: number): Promise<UserRecord | undefined>
}

interface KnexQuery {
  where(criteria: Record<string, unknown>): KnexQuery
  first(): Promise<Record<string, unknown> | undefined>
}

interface WikiOperations {
  auth: {
    checkExclusiveAccess(requester: Express.User | undefined, permissions: readonly string[], overrides: readonly string[]): boolean
    reloadGroups(): Promise<unknown>
    revokeUserTokens(input: { id: number, kind: 'g' | 'u' }): void
  }
  data: { groups: { defaultPermissions: unknown, defaultPageRules: unknown } }
  events: { outbound: { emit(event: string, payload?: Record<string, unknown>): void } }
  models: {
    groups: { query(): GroupQuery, relatedQuery(relation: 'users'): GroupAggregateQuery }
    users: { query(): UserQuery }
    knex(table: string): KnexQuery
  }
}

interface GroupAssignmentInput {
  requester?: Express.User
  groupId?: unknown
  userId?: unknown
}

interface GroupUpdateInput {
  requester?: Express.User
  id?: unknown
  name?: unknown
  redirectOnLogin?: unknown
  permissions?: unknown
  pageRules?: unknown
}

const wiki = WIKI as unknown as WikiOperations
const administrativeResourceTypes = ['users', 'groups', 'navigation', 'theme', 'api', 'system']

const requirePositiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApplicationError(`${label} must be a positive integer`, { code: 'INVALID_INPUT' })
  }
  return value as number
}

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length < 1) {
    throw new ApplicationError(`${label} must be a non-empty string`, { code: 'INVALID_INPUT' })
  }
  return value
}

const requirePermissions = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(permission => typeof permission !== 'string')) {
    throw new ApplicationError('permissions must be an array of strings', { code: 'INVALID_INPUT' })
  }
  return value
}

const requirePageRules = (value: unknown): PageRule[] => {
  if (!Array.isArray(value) || value.some(rule => (
    !rule || typeof rule !== 'object' || Array.isArray(rule) ||
    typeof Reflect.get(rule, 'match') !== 'string' ||
    typeof Reflect.get(rule, 'path') !== 'string'
  ))) {
    throw new ApplicationError('pageRules must be an array of valid page rules', { code: 'INVALID_INPUT' })
  }
  return value as PageRule[]
}

const permissionResourceType = (permission: unknown): string => String(permission).split(':').pop() ?? ''

const hasAdministrativePermissions = (permissions: readonly unknown[]): boolean => {
  return permissions.some(permission => administrativeResourceTypes.includes(permissionResourceType(permission)))
}

const hasSystemPermissions = (permissions: readonly unknown[]): boolean => {
  return permissions.some(permission => permissionResourceType(permission) === 'system')
}

const revoke = (id: number, kind: 'g' | 'u'): void => {
  wiki.auth.revokeUserTokens({ id, kind })
  wiki.events.outbound.emit('addAuthRevoke', { id, kind })
}

const reload = async (): Promise<void> => {
  await wiki.auth.reloadGroups()
  wiki.events.outbound.emit('reloadGroups')
}

const list = (): GroupQuery => wiki.models.groups.query().select(
  'groups.id',
  'groups.name',
  'groups.isSystem',
  'groups.createdAt',
  'groups.updatedAt',
  wiki.models.groups.relatedQuery('users').count().as('userCount')
)

const listPickerOptions = (): GroupQuery => wiki.models.groups.query().select('id', 'name', 'isSystem')

const get = (value: unknown): Promise<GroupRecord | undefined> => wiki.models.groups.query().findById(requirePositiveInteger(value, 'id'))

const listUsers = (group: GroupRecord): UserRelationQuery => group.$relatedQuery('users').select('users.id', 'users.name', 'users.email')

const create = async (value: unknown): Promise<GroupRecord> => {
  const name = requireNonEmptyString(value, 'name')
  const group = await wiki.models.groups.query().insertAndFetch({
    name,
    permissions: wiki.data.groups.defaultPermissions,
    pageRules: wiki.data.groups.defaultPageRules,
    isSystem: false
  })
  await reload()
  return group
}

const assignUser = async ({ requester, groupId: groupIdValue, userId: userIdValue }: GroupAssignmentInput): Promise<void> => {
  const groupId = requirePositiveInteger(groupIdValue, 'groupId')
  const userId = requirePositiveInteger(userIdValue, 'userId')
  if (userId === 2) {
    throw new ApplicationError('Cannot assign the Guest user to a group.', { code: 'GROUP_ASSIGN_GUEST' })
  }

  const group = await get(groupId)
  if (!group) {
    throw new ApplicationError('Invalid Group ID', { code: 'GROUP_NOT_FOUND', status: 404 })
  }

  const permissions = Array.isArray(group.permissions) ? group.permissions : []
  if (
    wiki.auth.checkExclusiveAccess(requester, ['manage:users', 'write:groups'], ['manage:groups', 'manage:system']) &&
    hasAdministrativePermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to assign a user to this administrative group.', { code: 'GROUP_ASSIGN_FORBIDDEN', status: 403 })
  }
  if (
    wiki.auth.checkExclusiveAccess(requester, ['manage:groups'], ['manage:system']) &&
    hasSystemPermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to assign a user to a group with the manage:system permission.', { code: 'GROUP_ASSIGN_SYSTEM_FORBIDDEN', status: 403 })
  }

  const user = await wiki.models.users.query().findById(userId)
  if (!user) {
    throw new ApplicationError('Invalid User ID', { code: 'USER_NOT_FOUND', status: 404 })
  }

  const relation = await wiki.models.knex('userGroups').where({ userId, groupId }).first()
  if (relation) {
    throw new ApplicationError('User is already assigned to group.', { code: 'GROUP_ASSIGN_EXISTS' })
  }

  await group.$relatedQuery('users').relate(user.id)
  revoke(user.id, 'u')
}

const unassignUser = async ({ groupId: groupIdValue, userId: userIdValue }: GroupAssignmentInput): Promise<void> => {
  const groupId = requirePositiveInteger(groupIdValue, 'groupId')
  const userId = requirePositiveInteger(userIdValue, 'userId')
  if (userId === 2) {
    throw new ApplicationError('Cannot unassign Guest user', { code: 'GROUP_UNASSIGN_GUEST' })
  }
  if (userId === 1 && groupId === 1) {
    throw new ApplicationError('Cannot unassign Administrator user from Administrators group.', { code: 'GROUP_UNASSIGN_ADMINISTRATOR' })
  }

  const group = await get(groupId)
  if (!group) {
    throw new ApplicationError('Invalid Group ID', { code: 'GROUP_NOT_FOUND', status: 404 })
  }
  const user = await wiki.models.users.query().findById(userId)
  if (!user) {
    throw new ApplicationError('Invalid User ID', { code: 'USER_NOT_FOUND', status: 404 })
  }

  await group.$relatedQuery('users').unrelate().where('userId', user.id)
  revoke(user.id, 'u')
}

const remove = async (value: unknown): Promise<void> => {
  const id = requirePositiveInteger(value, 'id')
  if (id === 1 || id === 2) {
    throw new ApplicationError('Cannot delete this group.', { code: 'GROUP_DELETE_PROTECTED' })
  }
  await wiki.models.groups.query().deleteById(id)
  revoke(id, 'g')
  await reload()
}

const update = async (input: GroupUpdateInput): Promise<void> => {
  const id = requirePositiveInteger(input.id, 'id')
  const name = requireNonEmptyString(input.name, 'name')
  const redirectOnLogin = input.redirectOnLogin === undefined || input.redirectOnLogin === null
    ? '/'
    : requireNonEmptyString(input.redirectOnLogin, 'redirectOnLogin')
  const permissions = requirePermissions(input.permissions)
  const pageRules = requirePageRules(input.pageRules)
  const requester = input.requester
  if (pageRules.some(rule => {
    const isSafe: unknown = safeRegex(rule.path)
    return isSafe !== true
  })) {
    throw new ApplicationError('Some Page Rules contains unsafe or exponential time regex.', { code: 'GROUP_PAGE_RULE_UNSAFE' })
  }

  if (
    wiki.auth.checkExclusiveAccess(requester, ['write:groups'], ['manage:groups', 'manage:system']) &&
    hasAdministrativePermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to manage this group or assign these administrative permissions.', { code: 'GROUP_UPDATE_FORBIDDEN', status: 403 })
  }
  if (
    wiki.auth.checkExclusiveAccess(requester, ['manage:groups'], ['manage:system']) &&
    hasSystemPermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to manage this group or assign the manage:system permissions.', { code: 'GROUP_UPDATE_SYSTEM_FORBIDDEN', status: 403 })
  }

  await wiki.models.groups.query().patch({
    name,
    redirectOnLogin: redirectOnLogin || '/',
    permissions,
    pageRules
  }).where('id', id)

  revoke(id, 'g')
  await reload()
}

export default {
  assignUser,
  create,
  get,
  hasAdministrativePermissions,
  hasSystemPermissions,
  listPickerOptions,
  list,
  listUsers,
  remove,
  unassignUser,
  update
}

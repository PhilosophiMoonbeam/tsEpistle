import { getGroupAdministrationStore } from './group-administration.ts'
import errors from './errors.ts'
interface UserRecord extends Record<string, unknown> {
  id: number
  name: string
  email: string
}

interface UserRelationQuery extends PromiseLike<UserRecord[]> {
  select(...columns: string[]): UserRelationQuery
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

interface GroupQuery extends PromiseLike<GroupRecord[]> {
  select(...columns: unknown[]): GroupQuery
  findById(id: number): Promise<GroupRecord | undefined>
}

interface GroupAggregateQuery {
  count(): GroupAggregateQuery
  as(alias: string): unknown
}

interface WikiOperations {
  data: { groups: { defaultPermissions: string[]; defaultPageRules: unknown[] } }
  models: { groups: { query(): GroupQuery; relatedQuery(relation: 'users'): GroupAggregateQuery } }
}
const wiki = () => WIKI as unknown as WikiOperations
const validId = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new errors.ApplicationError('Choose a valid group or account.', { status: 400 })
  return value
}
const nameValue = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255)
    throw new errors.ApplicationError('Enter a group name of 1–255 characters.', { status: 400 })
  return value.trim()
}
const hasAdministrativePermissions = (permissions: readonly unknown[]) =>
  permissions.some(p => ['users', 'groups', 'navigation', 'theme', 'api', 'system'].includes(String(p).split(':').at(-1) ?? '') || p === 'write:scripts')
const hasSystemPermissions = (permissions: readonly unknown[]) => permissions.some(p => String(p).endsWith(':system') || p === 'write:scripts')
const list = () =>
  wiki()
    .models.groups.query()
    .select(
      'groups.id',
      'groups.name',
      'groups.isSystem',
      'groups.createdAt',
      'groups.updatedAt',
      wiki().models.groups.relatedQuery('users').count().as('userCount')
    )
const listPickerOptions = () => wiki().models.groups.query().select('id', 'name', 'isSystem')
const get = (id: unknown) => wiki().models.groups.query().findById(validId(id))
const listUsers = (group: GroupRecord) => group.$relatedQuery('users').select('users.id', 'users.name', 'users.email')
// Older transports have no review token. Resolve their saved version at the
// boundary; all validation, current authority and mutations share the new store.
const create = async (name: unknown, requester?: Express.User) => {
  const store = getGroupAdministrationStore(),
    options = await store.creationOptions(requester)
  const result = await store.create(requester, {
    fingerprint: options.fingerprint,
    policy: {
      name: nameValue(name),
      description: '',
      redirectOnLogin: '/',
      formMfaRequired: false,
      permissions: wiki().data.groups.defaultPermissions,
      pageRules: wiki().data.groups.defaultPageRules
    },
    reason: 'Group created through the legacy administration API.'
  })
  const row = await get(result.id)
  if (!row) throw new errors.ApplicationError('The group was created but could not be loaded.', { status: 503 })
  return row
}
const update = async (input: {
  requester: Express.User | undefined
  id?: unknown
  name?: unknown
  redirectOnLogin?: unknown
  permissions?: unknown
  pageRules?: unknown
}) => {
  const store = getGroupAdministrationStore(),
    id = validId(input.id),
    row = await store.inspect(input.requester, id)
  await store.savePolicy(input.requester, id, {
    fingerprint: row.fingerprint,
    policy: {
      name: input.name,
      description: row.description,
      redirectOnLogin: input.redirectOnLogin || '/',
      formMfaRequired: row.formMfaRequired,
      permissions: input.permissions,
      pageRules: input.pageRules
    },
    reason: 'Group policy updated through the legacy administration API.'
  })
}
const membership = async (input: { requester: Express.User | undefined; groupId?: unknown; userId?: unknown }, action: 'add' | 'remove') => {
  const store = getGroupAdministrationStore(),
    id = validId(input.groupId),
    row = await store.inspectForMembership(input.requester, id)
  await store.changeMembers(input.requester, id, {
    fingerprint: row.fingerprint,
    action,
    userIds: [validId(input.userId)],
    reason: `Group membership ${action === 'add' ? 'assigned' : 'removed'} through the legacy administration API.`
  })
}
const assignUser = (input: { requester: Express.User | undefined; groupId?: unknown; userId?: unknown }) => membership(input, 'add')
const unassignUser = (input: { requester: Express.User | undefined; groupId?: unknown; userId?: unknown }) => membership(input, 'remove')
const remove = async (input: { requester: Express.User | undefined; id?: unknown }) => {
  const store = getGroupAdministrationStore(),
    id = validId(input.id),
    row = await store.inspect(input.requester, id)
  await store.remove(input.requester, id, { fingerprint: row.fingerprint, reason: 'Group deleted through the legacy administration API.' })
}
export default { assignUser, create, get, hasAdministrativePermissions, hasSystemPermissions, listPickerOptions, list, listUsers, remove, unassignUser, update }

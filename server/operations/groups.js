const safeRegex = require('safe-regex')

const { ApplicationError } = require('./errors')

/* global WIKI */

const administrativeResourceTypes = ['users', 'groups', 'navigation', 'theme', 'api', 'system']

const permissionResourceType = permission => String(permission).split(':').pop()

const hasAdministrativePermissions = permissions => {
  return permissions.some(permission => administrativeResourceTypes.includes(permissionResourceType(permission)))
}

const hasSystemPermissions = permissions => {
  return permissions.some(permission => permissionResourceType(permission) === 'system')
}

const revoke = (id, kind) => {
  WIKI.auth.revokeUserTokens({ id, kind })
  WIKI.events.outbound.emit('addAuthRevoke', { id, kind })
}

const reload = async () => {
  await WIKI.auth.reloadGroups()
  WIKI.events.outbound.emit('reloadGroups')
}

const list = () => WIKI.models.groups.query().select(
  'groups.id',
  'groups.name',
  'groups.isSystem',
  'groups.createdAt',
  'groups.updatedAt',
  WIKI.models.groups.relatedQuery('users').count().as('userCount')
)

const listPickerOptions = () => WIKI.models.groups.query().select('id', 'name', 'isSystem')

const get = id => WIKI.models.groups.query().findById(id)

const listUsers = group => group.$relatedQuery('users').select('id', 'name', 'email')

const create = async name => {
  const group = await WIKI.models.groups.query().insertAndFetch({
    name,
    permissions: JSON.stringify(WIKI.data.groups.defaultPermissions),
    pageRules: JSON.stringify(WIKI.data.groups.defaultPageRules),
    isSystem: false
  })
  await reload()
  return group
}

const assignUser = async ({ requester, groupId, userId }) => {
  if (userId === 2) {
    throw new ApplicationError('Cannot assign the Guest user to a group.', { code: 'GROUP_ASSIGN_GUEST' })
  }

  const group = await get(groupId)
  if (!group) {
    throw new ApplicationError('Invalid Group ID', { code: 'GROUP_NOT_FOUND', status: 404 })
  }

  const permissions = Array.isArray(group.permissions) ? group.permissions : []
  if (
    WIKI.auth.checkExclusiveAccess(requester, ['manage:users', 'write:groups'], ['manage:groups', 'manage:system']) &&
    hasAdministrativePermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to assign a user to this administrative group.', { code: 'GROUP_ASSIGN_FORBIDDEN', status: 403 })
  }
  if (
    WIKI.auth.checkExclusiveAccess(requester, ['manage:groups'], ['manage:system']) &&
    hasSystemPermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to assign a user to a group with the manage:system permission.', { code: 'GROUP_ASSIGN_SYSTEM_FORBIDDEN', status: 403 })
  }

  const user = await WIKI.models.users.query().findById(userId)
  if (!user) {
    throw new ApplicationError('Invalid User ID', { code: 'USER_NOT_FOUND', status: 404 })
  }

  const relation = await WIKI.models.knex('userGroups').where({ userId, groupId }).first()
  if (relation) {
    throw new ApplicationError('User is already assigned to group.', { code: 'GROUP_ASSIGN_EXISTS' })
  }

  await group.$relatedQuery('users').relate(user.id)
  revoke(user.id, 'u')
}

const unassignUser = async ({ groupId, userId }) => {
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
  const user = await WIKI.models.users.query().findById(userId)
  if (!user) {
    throw new ApplicationError('Invalid User ID', { code: 'USER_NOT_FOUND', status: 404 })
  }

  await group.$relatedQuery('users').unrelate().where('userId', user.id)
  revoke(user.id, 'u')
}

const remove = async id => {
  if (id === 1 || id === 2) {
    throw new ApplicationError('Cannot delete this group.', { code: 'GROUP_DELETE_PROTECTED' })
  }
  await WIKI.models.groups.query().deleteById(id)
  revoke(id, 'g')
  await reload()
}

const update = async ({ requester, id, name, redirectOnLogin, permissions, pageRules }) => {
  if (pageRules.some(rule => rule.match === 'REGEX' && !safeRegex(rule.path))) {
    throw new ApplicationError('Some Page Rules contains unsafe or exponential time regex.', { code: 'GROUP_PAGE_RULE_UNSAFE' })
  }

  if (
    WIKI.auth.checkExclusiveAccess(requester, ['write:groups'], ['manage:groups', 'manage:system']) &&
    hasAdministrativePermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to manage this group or assign these administrative permissions.', { code: 'GROUP_UPDATE_FORBIDDEN', status: 403 })
  }
  if (
    WIKI.auth.checkExclusiveAccess(requester, ['manage:groups'], ['manage:system']) &&
    hasSystemPermissions(permissions)
  ) {
    throw new ApplicationError('You are not authorized to manage this group or assign the manage:system permissions.', { code: 'GROUP_UPDATE_SYSTEM_FORBIDDEN', status: 403 })
  }

  await WIKI.models.groups.query().patch({
    name,
    redirectOnLogin: redirectOnLogin || '/',
    permissions: JSON.stringify(permissions),
    pageRules: JSON.stringify(pageRules)
  }).where('id', id)

  revoke(id, 'g')
  await reload()
}

module.exports = {
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

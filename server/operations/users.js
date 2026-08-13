const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const listOrderFields = ['id', 'name', 'email', 'providerKey', 'createdAt', 'lastLoginAt']

const normalizeListOptions = args => {
  const page = Math.max(_.toSafeInteger(args.page) || 1, 1)
  const pageSize = Math.max(_.toSafeInteger(args.pageSize) || 15, 1)
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    filter: _.trim(args.filter || ''),
    providerKey: args.providerKey || 'all',
    orderBy: listOrderFields.includes(args.orderBy) ? args.orderBy : 'name',
    orderByDirection: _.toLower(args.orderByDirection) === 'desc' ? 'desc' : 'asc'
  }
}

const applyListFilters = (queryBuilder, options) => {
  if (options.filter) {
    queryBuilder.where(builder => {
      builder.where('email', 'like', `%${options.filter}%`)
        .orWhere('name', 'like', `%${options.filter}%`)
    })
  }
  if (options.providerKey !== 'all') {
    queryBuilder.andWhere('providerKey', options.providerKey)
  }
  return queryBuilder
}

const list = async args => {
  const options = normalizeListOptions(args)
  const totalResult = await applyListFilters(WIKI.models.users.query(), options)
    .count('* as total')
    .first()
  const users = await applyListFilters(WIKI.models.users.query(), options)
    .select('id', 'email', 'name', 'providerKey', 'isSystem', 'isActive', 'createdAt', 'lastLoginAt')
    .orderBy(options.orderBy, options.orderByDirection)
    .offset(options.offset)
    .limit(options.pageSize)
  return {
    users,
    total: _.toSafeInteger(totalResult.total)
  }
}

const search = query => WIKI.models.users.query()
  .where('email', 'like', `%${query}%`)
  .orWhere('name', 'like', `%${query}%`)
  .limit(10)
  .select('id', 'name', 'email', 'providerKey')

const lastLogins = () => WIKI.models.users.query()
  .select('id', 'name', 'lastLoginAt')
  .whereNotNull('lastLoginAt')
  .orderBy('lastLoginAt', 'desc')
  .limit(10)

const get = async id => {
  const user = await WIKI.models.users.query().findById(id)
  if (!user) {
    throw new ApplicationError('User not found', { code: 'USER_NOT_FOUND', status: 404 })
  }

  user.password = ''
  user.tfaSecret = ''
  const strategy = _.get(WIKI.auth.strategies, user.providerKey)
  if (strategy) {
    strategy.strategy = _.find(WIKI.data.authentication, ['key', strategy.strategyKey])
    user.providerName = strategy.displayName
    user.providerIs2FACapable = _.get(strategy, 'strategy.useForm', false)
  }
  return user
}

const getAdminDetail = async id => {
  const user = await get(id)
  const provider = _.get(WIKI.auth, ['strategies', user.providerKey], null)
  const definition = provider ? _.find(WIKI.data.authentication, ['key', provider.strategyKey]) : null
  const groups = await user.$relatedQuery('groups').select('id', 'name')
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    providerKey: user.providerKey,
    providerName: _.get(provider, 'displayName', 'Unknown'),
    providerId: _.isNil(user.providerId) ? null : user.providerId,
    providerIs2FACapable: _.get(definition, 'useForm', false),
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

const create = async ({ requester, input }) => {
  if (!(await WIKI.auth.checkAssignUserToGroupAccess(requester, input.groups))) {
    throw new ApplicationError('You are not authorized to create a user with an assignment to an administrative group.', { code: 'USER_CREATE_GROUP_FORBIDDEN', status: 403 })
  }
  await WIKI.models.users.createNewUser(input)
}

const update = async ({ requester, input }) => {
  if (!(await WIKI.auth.checkAssignUserToGroupAccess(requester, input.groups))) {
    throw new ApplicationError('You are not authorized to modify / assign a user from / to an administrative group.', { code: 'USER_UPDATE_GROUP_FORBIDDEN', status: 403 })
  }
  await WIKI.models.users.updateUser(input)
}

const revoke = id => {
  WIKI.auth.revokeUserTokens({ id, kind: 'u' })
  WIKI.events.outbound.emit('addAuthRevoke', { id, kind: 'u' })
}

const remove = async ({ id, replaceId }) => {
  if (id <= 2) {
    throw new ApplicationError('Cannot delete a protected system account.', { code: 'USER_DELETE_PROTECTED', status: 400 })
  }
  try {
    await WIKI.models.users.deleteUser(id, replaceId)
  } catch (err) {
    if (_.includes(_.toLower(err.message), 'foreign')) {
      throw new ApplicationError('Cannot delete user because of content relational constraints.', { code: 'USER_DELETE_FOREIGN_CONSTRAINT', status: 400 })
    }
    throw err
  }
  revoke(id)
}

const setActive = async ({ id, isActive }) => {
  if (!isActive && id <= 2) {
    throw new ApplicationError('Cannot deactivate system accounts.', { code: 'USER_DEACTIVATE_PROTECTED', status: 400 })
  }
  await WIKI.models.users.query().patch({ isActive }).findById(id)
  if (!isActive) {
    revoke(id)
  }
}

const verify = id => WIKI.models.users.query().patch({ isVerified: true }).findById(id)

const setTfa = ({ id, enabled }) => WIKI.models.users.query().patch({
  tfaIsActive: enabled,
  tfaSecret: null
}).findById(id)

const requireProfileUser = async requester => {
  if (!requester || requester.id < 1 || requester.id === 2) throw new WIKI.Error.AuthRequired()
  const user = await WIKI.models.users.query().findById(requester.id)
  if (!user.isActive) throw new WIKI.Error.AuthAccountBanned()
  return user
}

const getProfile = async requester => {
  const user = await requireProfileUser(requester)
  user.providerName = _.get(WIKI.auth.strategies, [user.providerKey, 'displayName'], 'Unknown')
  user.lastLoginAt = user.lastLoginAt || user.updatedAt
  user.password = ''
  user.providerId = ''
  user.tfaSecret = ''
  return user
}

const updateProfile = async ({ requester, input }) => {
  const user = await requireProfileUser(requester)
  if (!user.isVerified) throw new WIKI.Error.AuthAccountNotVerified()
  if (!['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD'].includes(input.dateFormat)) throw new WIKI.Error.InputInvalid()
  if (!['', 'light', 'dark'].includes(input.appearance)) throw new WIKI.Error.InputInvalid()
  await WIKI.models.users.updateUser({
    id: user.id,
    name: _.trim(input.name),
    jobTitle: _.trim(input.jobTitle),
    location: _.trim(input.location),
    timezone: input.timezone,
    dateFormat: input.dateFormat,
    appearance: input.appearance
  })
  return (await WIKI.models.users.refreshToken(user.id)).token
}

const changePassword = async ({ requester, current, newPassword }) => {
  const user = await requireProfileUser(requester)
  if (!user.isVerified) throw new WIKI.Error.AuthAccountNotVerified()
  if (user.providerKey !== 'local') throw new WIKI.Error.AuthProviderInvalid()
  try {
    await user.verifyPassword(current)
  } catch (err) {
    throw new WIKI.Error.AuthPasswordInvalid()
  }
  await WIKI.models.users.updateUser({ id: user.id, newPassword })
  return (await WIKI.models.users.refreshToken(user)).token
}

const listUserGroups = user => user.$relatedQuery('groups')
const listProfileGroups = async user => (await user.$relatedQuery('groups')).map(group => group.name)
const countPages = async user => _.toSafeInteger((await WIKI.models.pages.query().count('* as total').where('creatorId', user.id).first()).total)
module.exports = {
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
  setActive,
  setTfa,
  update,
  updateProfile,
  verify
}

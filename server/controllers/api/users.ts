import express from 'express'
import { type Request, type Response, getWikiAuth } from '../_types.ts'
import _ from 'lodash'
import userOperations, { type ListUser } from '../../operations/users.ts'

const router = express.Router()

interface SearchUser {
  id: unknown
  name: unknown
  email: unknown
  providerKey: unknown
}

interface LastLoginUser {
  id: unknown
  name: unknown
  lastLoginAt: unknown
}
const profileFields = ['name', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance'] as const
type ProfileInput = Record<(typeof profileFields)[number], string>

const isProfileInput = (value: Record<string, unknown>): value is ProfileInput =>
  profileFields.every(field => typeof value[field] === 'string')
const profileAppearances = ['system', 'light', 'dark'] as const
type ProfileAppearance = (typeof profileAppearances)[number]

const isProfileAppearance = (value: unknown): value is ProfileAppearance =>
  typeof value === 'string' && profileAppearances.includes(value as ProfileAppearance)


const requestBody = (req: Request): Record<string, unknown> => {
  const body: unknown = req.body
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

const errorMessage = (err: unknown, fallback: string): string => {
  const message = err instanceof Error ? err.message : String(err)
  return message || fallback
}

const errorStatus = (err: unknown, fallback: number): number => {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
    return err.status
  }
  return fallback
}



const userActivityAccessPermissions = ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system']
const userMutationAccessPermissions = ['write:users', 'manage:users', 'manage:system']

const pickListUser = (user: ListUser) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  providerKey: user.providerKey,
  isSystem: Boolean(user.isSystem),
  isActive: Boolean(user.isActive),
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt || null
})

const normalizeUserIdParam = (value: string, res: Response): number | null => {
  if (!/^[1-9]\d*$/.test(value)) {
    res.status(400).json({ error: 'user id must be a positive integer' })
    return null
  }

  const id = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(id)) {
    res.status(400).json({ error: 'user id must be a positive integer' })
    return null
  }
  return id
}

const requireBooleanBodyValue = (req: Request, res: Response, field: string): boolean | null => {
  const value = _.get(req, ['body', field])
  if (typeof value !== 'boolean') {
    res.status(400).json({ error: `${field} must be a boolean` })
    return null
  }

  return value
}

const requireUserSearchAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, userActivityAccessPermissions)) {
    res.status(403).json({ error: 'a user search admin permission is required' })
    return false
  }

  return true
}

const requireUserLastLoginsAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, userActivityAccessPermissions)) {
    res.status(403).json({ error: 'a dashboard user activity permission is required' })
    return false
  }

  return true
}

const requireUserDetailAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:users', 'manage:system'])) {
    res.status(403).json({ error: 'manage:users or manage:system is required' })
    return false
  }

  return true
}

const requireUserMutationAccess = (req: Request, res: Response): boolean => {
  if (!getWikiAuth().checkAccess(req.user, userMutationAccessPermissions)) {
    res.status(403).json({ error: 'write:users, manage:users or manage:system is required' })
    return false
  }

  return true
}

router.post('/', async (req, res) => {
  if (!requireUserMutationAccess(req, res)) {
    return
  }

  const payload = _.pick(requestBody(req), ['providerKey', 'email', 'passwordRaw', 'name', 'groups', 'mustChangePassword', 'sendWelcomeEmail'])
  if (!Array.isArray(payload.groups)) {
    return res.status(400).json({ error: 'groups must be an array' })
  }

  try {
    const result = await userOperations.create({ requester: req.user, input: payload })
    return res.json({
      succeeded: true,
      message: 'User created successfully',
      ...(result.welcomeEmailError ? { welcomeEmailError: result.welcomeEmailError } : {})
    })
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'User could not be created.') })
  }
})

router.post('/:id/welcome-email', async (req, res) => {
  if (!requireUserMutationAccess(req, res)) {
    return
  }
  try {
    await userOperations.sendWelcomeEmail(Number(req.params.id))
    return res.json({
      succeeded: true,
      message: 'Welcome email sent successfully'
    })
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'Welcome email could not be sent.') })
  }
})

router.get('/', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  try {
    const result = await userOperations.list(req.query)
    return res.json({
      total: result.total,
      users: result.users.map(pickListUser)
    })
  } catch (err) {
    return next(err)
  }
})

router.get('/search', async (req, res, next) => {
  if (!requireUserSearchAccess(req, res)) {
    return
  }

  const queryValue: unknown = _.get(req, 'query.query', '')
  const query = typeof queryValue === 'string' ? _.trim(queryValue) : ''
  if (query.length < 2) {
    return res.json([])
  }

  try {
    const users = await userOperations.search(query)
    const searchUsers: SearchUser[] = users
    return res.json(searchUsers.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      providerKey: user.providerKey
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/last-logins', async (req, res, next) => {
  if (!requireUserLastLoginsAccess(req, res)) {
    return
  }

  try {
    const users = await userOperations.lastLogins()
    const loginUsers: LastLoginUser[] = users
    return res.json(loginUsers.map(user => ({
      id: user.id,
      name: user.name,
      lastLoginAt: user.lastLoginAt
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/whoami', async (req, res) => {
  const userId = req.user?.id
  if (typeof userId !== 'number' || userId < 1 || userId === 2) {
    return res.json({ authenticated: false, user: null })
  }

  return res.json({
    authenticated: true,
    user: _.pick(req.user, ['id', 'name', 'email', 'providerKey', 'permissions'])
  })
})

router.get('/profile', async (req, res, next) => {
  try {
    const user = await userOperations.getProfile(req.user)
    const [groups, pagesTotal] = await Promise.all([
      userOperations.listProfileGroups(user),
      userOperations.countPages(user)
    ])
    res.json({
      ..._.pick(user, ['id', 'name', 'email', 'providerKey', 'providerName', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance', 'createdAt', 'updatedAt', 'lastLoginAt']),
      isSystem: user.isSystem === true || user.isSystem === 1,
      isVerified: user.isVerified === true || user.isVerified === 1,
      groups,
      pagesTotal
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/profile', async (req, res, next) => {
  const body = requestBody(req)
  const input = _.pick(body, profileFields)
  if (!isProfileInput(input)) {
    return res.status(400).json({ error: 'Profile fields must be strings' })
  }
  try {
    const token = await userOperations.updateProfile({ requester: req.user, input })
    res.json({ token })
  } catch (err) {
    next(err)
  }
})
router.patch('/profile/appearance', async (req, res, next) => {
  const appearance = requestBody(req).appearance
  if (!isProfileAppearance(appearance)) {
    return res.status(400).json({ error: 'appearance must be one of system, light or dark' })
  }
  try {
    const token = await userOperations.updateProfileAppearance({ requester: req.user, input: { appearance } })
    return res.json({ token })
  } catch (err) {
    return next(err)
  }
})


router.post('/profile/password', async (req, res, next) => {
  const current = _.get(req, 'body.current')
  const newPassword = _.get(req, 'body.newPassword')
  if (typeof current !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'current and newPassword must be strings' })
  }
  try {
    const token = await userOperations.changePassword({ requester: req.user, current, newPassword })
    res.json({ token })
  } catch (err) {
    next(err)
  }
})

router.put('/:id', async (req, res) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const payload = _.pick(requestBody(req), ['email', 'name', 'newPassword', 'groups', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance'])
  if (!_.isNil(payload.groups) && !Array.isArray(payload.groups)) {
    return res.status(400).json({ error: 'groups must be an array' })
  }

  try {
    await userOperations.update({
      requester: req.user,
      input: {
        id,
        ...payload
      }
    })
    return res.json({
      succeeded: true,
      message: 'User updated successfully'
    })
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'User could not be updated.') })
  }
})

router.delete('/:id', async (req, res) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const replaceId = normalizeUserIdParam(_.toString(_.get(req, ['body', 'replaceId'], '')), res)
  if (replaceId === null) {
    return
  }

  try {
    await userOperations.remove({ id, replaceId })
    return res.json({
      succeeded: true,
      message: 'User deleted successfully'
    })
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'User could not be deleted.') })
  }
})

router.patch('/:id/status', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const isActive = requireBooleanBodyValue(req, res, 'isActive')
  if (isActive === null) {
    return
  }

  try {
    await userOperations.setActive({ id, isActive })

    return res.json({
      succeeded: true,
      message: isActive ? 'User activated successfully' : 'User deactivated successfully'
    })
  } catch (err) {
    if (errorStatus(err, 0) > 0) return res.status(errorStatus(err, 500)).json({ error: errorMessage(err, 'User status update failed') })
    return next(err)
  }
})

router.patch('/:id/verification', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const isVerified = requireBooleanBodyValue(req, res, 'isVerified')
  if (isVerified === null) {
    return
  }
  if (!isVerified) {
    return res.status(400).json({ error: 'isVerified must be true' })
  }

  try {
    await userOperations.verify(id)
    return res.json({
      succeeded: true,
      message: 'User verified successfully'
    })
  } catch (err) {
    return next(err)
  }
})

router.patch('/:id/tfa', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const enabled = requireBooleanBodyValue(req, res, 'enabled')
  if (enabled === null) {
    return
  }

  try {
    await userOperations.setTfa({ id, enabled })
    return res.json({
      succeeded: true,
      message: enabled ? 'User 2FA enabled successfully' : 'User 2FA disabled successfully'
    })
  } catch (err) {
    return next(err)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  try {
    return res.json(await userOperations.getAdminDetail(id))
  } catch (err) {
    if (errorStatus(err, 0) === 404) return res.status(404).json({ error: 'user not found' })
    return next(err)
  }
})

export default router

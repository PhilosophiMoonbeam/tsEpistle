import express from 'express'
import { errorStatus, objectValue, type NextFunction, type Request, type Response, getWikiAuth } from '../_types.ts'

import groupOperations from '../../operations/groups.ts'
import { isValidPageRuleRegex } from '../../helpers/page-access.ts'

const router = express.Router()

const requireAccess = (req: Request, res: Response, permissions: string[], message: string): boolean => {
  if (!getWikiAuth().checkAccess(req.user, permissions)) {
    res.status(403).json({ error: message })
    return false
  }
  return true
}

const requireGroupsPickerAccess = (req: Request, res: Response): boolean =>
  requireAccess(
    req,
    res,
    ['write:groups', 'manage:groups', 'manage:system', 'write:users', 'manage:users', 'manage:navigation', 'manage:api'],
    'an admin groups picker permission is required'
  )

const requireGroupsListAccess = (req: Request, res: Response): boolean =>
  requireAccess(req, res, ['write:groups', 'manage:groups', 'manage:system'], 'write:groups, manage:groups, or manage:system is required')

const requireGroupUserAssignmentAccess = (req: Request, res: Response): boolean =>
  requireAccess(
    req,
    res,
    ['manage:users', 'write:groups', 'manage:groups', 'manage:system'],
    'manage:users, write:groups, manage:groups, or manage:system is required'
  )

const normalizePositiveIntegerParam = (value: string, label: string, res: Response): number | null => {
  if (!/^[1-9]\d*$/.test(value)) {
    res.status(400).json({ error: `${label} must be a positive integer` })
    return null
  }
  return Number.parseInt(value, 10)
}

const handleOperationError = (err: unknown, res: Response, next: NextFunction) => {
  const status = errorStatus(err)
  if (status !== undefined) {
    const message = err instanceof Error ? err.message : String(err)
    return res.status(status).json({ error: message })
  }
  return next(err)
}

interface GroupPageRulePayload {
  id: string
  path: string
  match: string
  deny: boolean
  roles: string[]
  locales: string[]
}

interface GroupUpdatePayload {
  name: string
  redirectOnLogin: string
  permissions: string[]
  pageRules: GroupPageRulePayload[]
}

const normalizeGroupUpdatePayload = (body: unknown, res: Response): GroupUpdatePayload | null => {
  const name = objectValue(body, 'name')
  const permissionsValue = objectValue(body, 'permissions')
  const pageRulesValue = objectValue(body, 'pageRules')
  const validPageRuleMatches = ['START', 'EXACT', 'END', 'REGEX', 'TAG']

  if (typeof name !== 'string' || name.length < 1) {
    res.status(400).json({ error: 'group name is required' })
    return null
  }
  if (!Array.isArray(permissionsValue) || !permissionsValue.every((permission: unknown) => typeof permission === 'string')) {
    res.status(400).json({ error: 'group permissions must be an array of strings' })
    return null
  }
  if (!Array.isArray(pageRulesValue)) {
    res.status(400).json({ error: 'group page rules must be an array' })
    return null
  }

  const pageRules: GroupPageRulePayload[] = []
  for (const candidate of pageRulesValue as unknown[]) {
    const id = objectValue(candidate, 'id')
    const path = objectValue(candidate, 'path')
    const match = objectValue(candidate, 'match')
    const deny = objectValue(candidate, 'deny')
    const rolesValue = objectValue(candidate, 'roles')
    const localesValue = objectValue(candidate, 'locales')
    if (
      typeof id !== 'string' ||
      id.length < 1 ||
      typeof path !== 'string' ||
      typeof match !== 'string' ||
      !validPageRuleMatches.includes(match) ||
      typeof deny !== 'boolean' ||
      !Array.isArray(rolesValue) ||
      !rolesValue.every((role: unknown) => typeof role === 'string') ||
      !Array.isArray(localesValue) ||
      !localesValue.every((locale: unknown) => typeof locale === 'string')
    ) {
      res.status(400).json({ error: 'group page rules are invalid' })
      return null
    }
    if (match === 'REGEX' && !isValidPageRuleRegex(path)) {
      res.status(400).json({ error: 'group page rule regular expression is invalid' })
      return null
    }
    pageRules.push({
      id,
      path,
      match,
      deny,
      roles: rolesValue as string[],
      locales: localesValue as string[]
    })
  }

  const redirectOnLogin = objectValue(body, 'redirectOnLogin')
  return {
    name,
    redirectOnLogin: typeof redirectOnLogin === 'string' && redirectOnLogin.length > 0 ? redirectOnLogin : '/',
    permissions: permissionsValue as string[],
    pageRules
  }
}

router.post('/', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const groupName = objectValue(req.body, 'name')
  const name = typeof groupName === 'string' ? groupName.trim() : ''
  if (!name) return res.status(400).json({ error: 'group name is required' })

  try {
    const group = await groupOperations.create(name)
    res.json({
      succeeded: true,
      message: 'Group created successfully.',
      group: {
        id: objectValue(group, 'id'),
        name: objectValue(group, 'name'),
        isSystem: Boolean(objectValue(group, 'isSystem'))
      }
    })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.get('/', async (req, res, next) => {
  if (!requireGroupsPickerAccess(req, res)) return
  try {
    const result: unknown = await groupOperations.listPickerOptions()
    const groups: unknown[] = Array.isArray(result) ? result : []
    res.json(
      groups.map((group: unknown) => ({
        id: objectValue(group, 'id'),
        name: objectValue(group, 'name'),
        isSystem: Boolean(objectValue(group, 'isSystem'))
      }))
    )
  } catch (err) {
    next(err)
  }
})

router.get('/list', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  try {
    const result: unknown = await groupOperations.list()
    const groups: unknown[] = Array.isArray(result) ? result : []
    res.json(
      groups.map((group: unknown) => ({
        id: objectValue(group, 'id'),
        name: objectValue(group, 'name'),
        isSystem: Boolean(objectValue(group, 'isSystem')),
        userCount: Number.parseInt(String(objectValue(group, 'userCount')), 10) || 0,
        createdAt: objectValue(group, 'createdAt'),
        updatedAt: objectValue(group, 'updatedAt')
      }))
    )
  } catch (err) {
    next(err)
  }
})

router.post('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) return
  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) return

  try {
    await groupOperations.assignUser({
      requester: req.user,
      groupId,
      userId
    })
    res.json({ succeeded: true, message: 'User has been assigned to group.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.delete('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) return
  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) return

  try {
    await groupOperations.unassignUser({ requester: req.user, groupId, userId })
    res.json({ succeeded: true, message: 'User has been unassigned from group.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) return

  try {
    await groupOperations.remove({ requester: req.user, id })
    res.json({ succeeded: true, message: 'Group has been deleted.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.patch('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) return
  const payload = normalizeGroupUpdatePayload(req.body, res)
  if (payload === null) return

  try {
    await groupOperations.update({
      requester: req.user,
      id,
      ...payload
    })
    res.json({ succeeded: true, message: 'Group has been updated.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (groupId === null) return

  try {
    const group = await groupOperations.get(groupId)
    if (!group) return res.status(404).json({ error: 'group not found' })
    const usersResult: unknown = await groupOperations.listUsers(group)
    const users: unknown[] = Array.isArray(usersResult) ? usersResult : []
    const permissionsValue = objectValue(group, 'permissions')
    const pageRulesValue = objectValue(group, 'pageRules')
    const pageRules: unknown[] = Array.isArray(pageRulesValue) ? pageRulesValue : []
    res.json({
      id: objectValue(group, 'id'),
      name: objectValue(group, 'name'),
      redirectOnLogin: objectValue(group, 'redirectOnLogin'),
      isSystem: Boolean(objectValue(group, 'isSystem')),
      permissions: Array.isArray(permissionsValue) ? permissionsValue.filter((permission: unknown) => typeof permission === 'string') : [],
      pageRules: pageRules.map((rule: unknown) => {
        const rolesValue = objectValue(rule, 'roles')
        const localesValue = objectValue(rule, 'locales')
        return {
          id: objectValue(rule, 'id'),
          path: objectValue(rule, 'path'),
          roles: Array.isArray(rolesValue) ? rolesValue.filter((role: unknown) => typeof role === 'string') : [],
          match: objectValue(rule, 'match'),
          deny: Boolean(objectValue(rule, 'deny')),
          locales: Array.isArray(localesValue) ? localesValue.filter((locale: unknown) => typeof locale === 'string') : []
        }
      }),
      users: users.map((user: unknown) => ({
        id: objectValue(user, 'id'),
        name: objectValue(user, 'name'),
        email: objectValue(user, 'email')
      })),
      createdAt: objectValue(group, 'createdAt'),
      updatedAt: objectValue(group, 'updatedAt')
    })
  } catch (err) {
    next(err)
  }
})

export default router

import crypto from 'node:crypto'

import _ from 'lodash'
import { MongoClient } from 'mongodb'
import { customAlphabet } from 'nanoid/non-secure'

import errors from './errors.ts'

const nanoid = customAlphabet('1234567890abcdef', 10)
const { ApplicationError } = errors

interface LegacyRight {
  role: string
  path: string
  exact: boolean
  deny: boolean
}

interface LegacyUser {
  provider: string
  email: string
  name: string
  password: string
  rights: LegacyRight[]
}

interface ImportFailure {
  provider: string
  email: string
  error: string
}

interface ReusableGroup {
  groupId: number
  hash: string
}

interface GroupRecord { id: number }
interface GroupQuery {
  insert(data: Record<string, unknown>): Promise<GroupRecord>
}

interface WikiImportOperations {
  version: string
  auth: { reloadGroups(): Promise<unknown> }
  data: { groups: { defaultPermissions: unknown, defaultPageRules: unknown } }
  events: { outbound: { emit(event: string): void } }
  logger: { warn(message: unknown): void }
  models: {
    groups: { query(): GroupQuery }
    users: {
      createNewUser(input: {
        providerKey: string
        email: string
        name: string
        passwordRaw: string
        groups: number[]
        mustChangePassword: boolean
        sendWelcomeEmail: boolean
      }): Promise<unknown>
    }
  }
}

interface ImportUsersInput {
  mongoDbConnString?: unknown
  groupMode?: unknown
}

const wiki = WIKI as unknown as WikiImportOperations

const buildPageRules = (rights: readonly LegacyRight[]) => rights.map(rule => ({
  id: nanoid(),
  roles: rule.role === 'write' ?
    ['read:pages', 'read:assets', 'read:comments', 'write:comments', 'write:pages', 'manage:pages', 'read:source', 'read:history', 'write:assets', 'manage:assets'] :
    ['read:pages', 'read:assets', 'read:comments', 'write:comments'],
  match: rule.exact ? 'EXACT' : 'START',
  deny: rule.deny,
  path: rule.path.indexOf('/') === 0 ? rule.path.substring(1) : rule.path,
  locales: [] as string[]
}))

const importUsers = async ({ mongoDbConnString: connectionValue, groupMode: groupModeValue }: ImportUsersInput): Promise<{
  usersCount: number
  groupsCount: number
  failed: ImportFailure[]
}> => {
  if (typeof connectionValue !== 'string' || connectionValue.length <= 10) {
    throw new ApplicationError('MongoDB Connection String is missing or invalid.', { code: 'INVALID_MONGODB_CONNECTION' })
  }
  if (groupModeValue !== 'SINGLE' && groupModeValue !== 'MULTI' && groupModeValue !== 'NONE') {
    throw new ApplicationError('Group mode is missing or invalid.', { code: 'INVALID_GROUP_MODE' })
  }
  const mongoDbConnString = connectionValue
  const groupMode = groupModeValue
  const client = await MongoClient.connect(mongoDbConnString, { appName: `tsFranki Wiki.js 1.x Migration Tool ${wiki.version}` })
  try {
    const cursor = client.db().collection<LegacyUser>('users').find({ email: { '$ne': 'guest' } })
    const timestamp = new Date().toISOString()
    const failed: ImportFailure[] = []
    let usersCount = 0
    let groupsCount = 0
    const assignableGroups: number[] = []
    const reusableGroups: ReusableGroup[] = []

    if (groupMode === 'SINGLE') {
      const group = await wiki.models.groups.query().insert({
        name: `Import_${timestamp}`,
        permissions: wiki.data.groups.defaultPermissions,
        pageRules: wiki.data.groups.defaultPageRules
      })
      groupsCount++
      assignableGroups.push(group.id)
    }

    while (await cursor.hasNext()) {
      const user = await cursor.next()
      if (!user) continue
      const userGroups: number[] = []
      if (groupMode === 'MULTI') {
        if (_.some(user.rights, ['role', 'admin'])) {
          userGroups.push(1)
        } else {
          const rights = _.sortBy(_.map(user.rights, rule => _.pick(rule, ['role', 'path', 'exact', 'deny'])), ['role', 'path', 'exact', 'deny'])
          const hash = crypto.createHash('sha1').update(JSON.stringify(rights)).digest('base64')
          const existing = _.find(reusableGroups, ['hash', hash])
          if (existing) {
            userGroups.push(existing.groupId)
          } else {
            const pageRules = buildPageRules(user.rights)
            const permissions = _.chain(pageRules).reject('deny').map('roles').union().flatten().value()
            const group = await wiki.models.groups.query().insert({
              name: `Import_${timestamp}_${groupsCount + 1}`,
              permissions,
              pageRules
            })
            reusableGroups.push({ groupId: group.id, hash })
            groupsCount++
            userGroups.push(group.id)
          }
        }
      }
      try {
        await wiki.models.users.createNewUser({
          providerKey: user.provider,
          email: user.email,
          name: user.name,
          passwordRaw: user.password,
          groups: userGroups.length > 0 ? userGroups : assignableGroups,
          mustChangePassword: false,
          sendWelcomeEmail: false
        })
        usersCount++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ provider: user.provider, email: user.email, error: message })
        wiki.logger.warn(`${user.email}: ${message}`)
      }
    }
    if (groupMode !== 'NONE') {
      await wiki.auth.reloadGroups()
      wiki.events.outbound.emit('reloadGroups')
    }
    return { usersCount, groupsCount, failed }
  } finally {
    await client.close()
  }
}

export default { importUsers }

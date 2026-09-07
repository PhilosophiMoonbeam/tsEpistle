import crypto from 'node:crypto'

import _ from 'lodash'
import { MongoClient, type FindCursor, type MongoClientOptions } from 'mongodb'
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

interface GroupRecord {
  id: number
}
interface GroupQuery {
  insert(data: Record<string, unknown>): Promise<GroupRecord>
}

interface WikiImportOperations {
  version: string
  auth: { reloadGroups(): Promise<unknown> }
  data: { groups: { defaultPermissions: unknown; defaultPageRules: unknown } }
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

const wiki = (): WikiImportOperations => (globalThis as typeof globalThis & { WIKI: unknown }).WIKI as unknown as WikiImportOperations

interface ImportUsersInput {
  mongoDbConnString?: unknown
  groupMode?: unknown
}
interface Dependencies {
  createClient(uri: string, options: MongoClientOptions): MongoClient
}
const CONNECT_TIMEOUT_MS = 10_000
const READ_TIMEOUT_MS = 30_000
export class ImportV1UsersError extends ApplicationError {
  readonly confirmed: boolean

  constructor(confirmed: boolean) {
    super(
      confirmed
        ? 'The legacy database could not be read before any user record was imported.'
        : 'The legacy user import stopped after one or more user records were imported. Its final outcome cannot be retried automatically.',
      { code: confirmed ? 'IMPORT_V1_USERS_CONFIRMED_FAILURE' : 'IMPORT_V1_USERS_UNCERTAIN', status: 502 }
    )
    this.confirmed = confirmed
  }
}
export const isConfirmedImportV1UsersFailure = (error: unknown): error is ImportV1UsersError => error instanceof ImportV1UsersError && error.confirmed

const buildPageRules = (rights: readonly LegacyRight[]) =>
  rights.map(rule => ({
    id: nanoid(),
    roles:
      rule.role === 'write'
        ? [
            'read:pages',
            'read:assets',
            'read:comments',
            'write:comments',
            'write:pages',
            'manage:pages',
            'read:source',
            'read:history',
            'write:assets',
            'manage:assets'
          ]
        : ['read:pages', 'read:assets', 'read:comments', 'write:comments'],
    match: rule.exact ? 'EXACT' : 'START',
    deny: rule.deny,
    path: rule.path.indexOf('/') === 0 ? rule.path.substring(1) : rule.path,
    locales: [] as string[]
  }))

export const createImportV1Operations = ({ createClient = (uri, options) => new MongoClient(uri, options) }: Partial<Dependencies> = {}) => {
  const importUsers = async ({
    mongoDbConnString: connectionValue,
    groupMode: groupModeValue
  }: ImportUsersInput): Promise<{
    usersCount: number
    groupsCount: number
    failed: ImportFailure[]
  }> => {
    if (typeof connectionValue !== 'string' || connectionValue.length <= 10 || connectionValue.trim() !== connectionValue) {
      throw new ApplicationError('MongoDB Connection String is missing or invalid.', { code: 'INVALID_MONGODB_CONNECTION' })
    }
    let connection: URL
    try {
      connection = new URL(connectionValue)
    } catch {
      throw new ApplicationError('MongoDB Connection String is missing or invalid.', { code: 'INVALID_MONGODB_CONNECTION' })
    }
    if (connection.protocol !== 'mongodb:' && connection.protocol !== 'mongodb+srv:') {
      throw new ApplicationError('MongoDB Connection String is missing or invalid.', { code: 'INVALID_MONGODB_CONNECTION' })
    }
    if (groupModeValue !== 'SINGLE' && groupModeValue !== 'MULTI' && groupModeValue !== 'NONE') {
      throw new ApplicationError('Group mode is missing or invalid.', { code: 'INVALID_GROUP_MODE' })
    }

    const clientOptions: MongoClientOptions = {
      appName: `tsEpistle Wiki.js 1.x Migration Tool ${wiki().version}`,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: READ_TIMEOUT_MS,
      timeoutMS: READ_TIMEOUT_MS,
      maxPoolSize: 1,
      minPoolSize: 0,
      retryReads: false
    }
    let client: MongoClient | undefined,
      cursor: FindCursor<LegacyUser> | undefined,
      usersCount = 0,
      groupsCount = 0
    try {
      client = createClient(connectionValue, clientOptions)
      await client.connect()
      cursor = client
        .db()
        .collection<LegacyUser>('users')
        .find({ email: { $ne: 'guest' } }, { timeoutMS: READ_TIMEOUT_MS, timeoutMode: 'cursorLifetime' })
      const timestamp = new Date().toISOString(),
        failed: ImportFailure[] = [],
        groupMode = groupModeValue,
        assignableGroups: number[] = [],
        reusableGroups: ReusableGroup[] = []

      if (groupMode === 'SINGLE') {
        const group = await wiki()
          .models.groups.query()
          .insert({
            name: `Import_${timestamp}`,
            permissions: wiki().data.groups.defaultPermissions,
            pageRules: wiki().data.groups.defaultPageRules
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
            const rights = _.sortBy(
              _.map(user.rights, rule => _.pick(rule, ['role', 'path', 'exact', 'deny'])),
              ['role', 'path', 'exact', 'deny']
            )
            const hash = crypto.createHash('sha1').update(JSON.stringify(rights)).digest('base64')
            const existing = _.find(reusableGroups, ['hash', hash])
            if (existing) {
              userGroups.push(existing.groupId)
            } else {
              const pageRules = buildPageRules(user.rights)
              const permissions = _.chain(pageRules).reject('deny').map('roles').union().flatten().value()
              const group = await wiki()
                .models.groups.query()
                .insert({
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
          await wiki().models.users.createNewUser({
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
          wiki().logger.warn(`${user.email}: ${message}`)
        }
      }
      if (groupMode !== 'NONE') {
        await wiki().auth.reloadGroups()
        wiki().events.outbound.emit('reloadGroups')
      }
      return { usersCount, groupsCount, failed }
    } catch (error) {
      if (error instanceof ImportV1UsersError) throw error
      throw new ImportV1UsersError(usersCount === 0 && groupsCount === 0)
    } finally {
      if (cursor) {
        try {
          await cursor.close({ timeoutMS: CONNECT_TIMEOUT_MS })
        } catch {
          // The MongoClient below closes client-side resources even if the server does not accept cursor cleanup.
        }
      }
      if (client) {
        try {
          await client.close(true)
        } catch {
          // Close is best-effort; its failure must not change a completed import result.
        }
      }
    }
  }
  return { importUsers }
}

const importV1Operations = createImportV1Operations()
export const importUsers = importV1Operations.importUsers
export default importV1Operations

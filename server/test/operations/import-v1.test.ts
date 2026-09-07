import { MongoClient, type FindCursor } from 'mongodb'

import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as ImportV1Operations from '../../operations/import-v1.ts'
let operations: typeof ImportV1Operations
const wiki = {
  version: 'test',
  auth: { reloadGroups: vi.fn(async () => undefined) },
  data: { groups: { defaultPermissions: [], defaultPageRules: [] } },
  events: { outbound: { emit: vi.fn() } },
  logger: { warn: vi.fn() },
  models: {
    groups: { query: () => ({ insert: vi.fn(async () => ({ id: 9 })) }) },
    users: { createNewUser: vi.fn(async () => undefined) }
  }
}
interface LegacyUser {
  provider: string
  email: string
  name: string
  password: string
  rights: []
}

type LegacyCursor = Pick<FindCursor<LegacyUser>, 'hasNext' | 'next' | 'close'>

const user: LegacyUser = {
  provider: 'local',
  email: 'user@example.test',
  name: 'Imported User',
  password: 'password',
  rights: []
}

const legacyClient = (cursor: LegacyCursor) => {
  const close = vi.fn(async () => undefined),
    connect = vi.fn(async () => undefined),
    find = vi.fn(() => cursor)
  return { client: { connect, close, db: () => ({ collection: () => ({ find }) }) }, close, connect, find }
}

beforeEach(async () => {
  vi.resetModules()
  wiki.auth.reloadGroups.mockClear()
  wiki.events.outbound.emit.mockClear()
  wiki.logger.warn.mockClear()
  wiki.models.users.createNewUser.mockClear()
  globalThis.WIKI = wiki as never
  operations = await vi.importFresh('../../operations/import-v1.ts', import.meta.url)
})

describe('Wiki.js 1.x user import', () => {
  it('rejects non-Mongo schemes and invalid driver connection options before creating a user', async () => {
    const createClient = vi.fn(),
      imported = operations.createImportV1Operations({ createClient: createClient as never })
    await expect(imported.importUsers({ mongoDbConnString: 'https://legacy.example.test/wiki', groupMode: 'NONE' })).rejects.toMatchObject({
      name: 'INVALID_MONGODB_CONNECTION'
    })
    expect(createClient).not.toHaveBeenCalled()
    const connect = vi.spyOn(MongoClient.prototype, 'connect')
    try {
      await expect(
        operations.importUsers({ mongoDbConnString: 'mongodb://invalid.example.test/wiki?directConnection=not-a-boolean', groupMode: 'NONE' })
      ).rejects.toMatchObject({
        confirmed: true,
        name: 'IMPORT_V1_USERS_CONFIRMED_FAILURE'
      })
      expect(connect).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
    expect(wiki.models.users.createNewUser).not.toHaveBeenCalled()
  })

  it('uses bounded Mongo connection and cursor lifetimes and closes a refused connection', async () => {
    const rejected = legacyClient({
      hasNext: vi.fn(async () => false),
      next: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    })
    rejected.connect.mockRejectedValueOnce(Error('server selection timed out'))
    const createClient = vi.fn(() => rejected.client),
      imported = operations.createImportV1Operations({ createClient: createClient as never })
    await expect(imported.importUsers({ mongoDbConnString: 'mongodb://legacy.example.test/wiki', groupMode: 'NONE' })).rejects.toMatchObject({
      confirmed: true,
      name: 'IMPORT_V1_USERS_CONFIRMED_FAILURE'
    })
    expect(createClient).toHaveBeenCalledWith(
      'mongodb://legacy.example.test/wiki',
      expect.objectContaining({
        connectTimeoutMS: 10_000,
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 30_000,
        timeoutMS: 30_000,
        maxPoolSize: 1,
        retryReads: false
      })
    )
    expect(rejected.close).toHaveBeenCalledWith(true)
  })

  it('bounds each legacy read and releases the cursor and client after a completed import', async () => {
    const cursor = {
      hasNext: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      next: vi.fn(async () => user),
      close: vi.fn(async () => undefined)
    }
    const connected = legacyClient(cursor),
      createClient = vi.fn(() => connected.client),
      imported = operations.createImportV1Operations({ createClient: createClient as never })
    await expect(imported.importUsers({ mongoDbConnString: 'mongodb+srv://legacy.example.test/wiki', groupMode: 'NONE' })).resolves.toMatchObject({
      usersCount: 1,
      failed: []
    })
    expect(connected.find).toHaveBeenCalledWith({ email: { $ne: 'guest' } }, { timeoutMS: 30_000, timeoutMode: 'cursorLifetime' })
    expect(cursor.close).toHaveBeenCalledWith({ timeoutMS: 10_000 })
    expect(connected.close).toHaveBeenCalledWith(true)
    expect(cursor.hasNext).toHaveBeenCalledTimes(2)
    expect(cursor.next).toHaveBeenCalledTimes(1)
  })

  it('marks a read failure after a durable user effect as uncertain rather than retryable', async () => {
    const cursor = {
      hasNext: vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(Error('network stalled')),
      next: vi.fn(async () => user),
      close: vi.fn(async () => undefined)
    }
    const connected = legacyClient(cursor),
      imported = operations.createImportV1Operations({ createClient: (() => connected.client) as never })
    await expect(imported.importUsers({ mongoDbConnString: 'mongodb://legacy.example.test/wiki', groupMode: 'NONE' })).rejects.toMatchObject({
      confirmed: false,
      name: 'IMPORT_V1_USERS_UNCERTAIN'
    })
    expect(wiki.models.users.createNewUser).toHaveBeenCalledTimes(1)
    expect(cursor.close).toHaveBeenCalledWith({ timeoutMS: 10_000 })
    expect(connected.close).toHaveBeenCalledWith(true)
  })
})

import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as storageMigration } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { up as utilitiesMigration } from '../../db/migrations/tsepistle-000026-utilities-operations.ts'
import { storageConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { runUtilityContentImport } from '../../operations/utility-content-import.ts'
import { createUtilitiesWorkspaceStore, type UtilitiesWorkspaceStore } from '../../operations/utilities-workspace.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_utility_content_import_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip
const requester = { user: { id: 1, authVersion: 0 } } as never
const rawDefinitions = [
  {
    key: 'disk',
    title: 'Disk',
    isAvailable: true,
    supportedModes: ['push'],
    defaultMode: 'push',
    schedule: false,
    props: { path: { type: 'String' }, createDailyBackups: { type: 'Boolean', default: false } },
    actions: [{ handler: 'importAll' }]
  },
  {
    key: 'git',
    title: 'Git',
    isAvailable: true,
    supportedModes: ['sync', 'push'],
    defaultMode: 'sync',
    schedule: 'PT5M',
    props: {
      authType: { type: 'String', default: 'ssh' },
      repoUrl: { type: 'String' },
      branch: { type: 'String', default: 'main' },
      sshPrivateKeyMode: { type: 'String', default: 'contents' },
      sshPrivateKeyPath: { type: 'String' },
      sshPrivateKeyContent: { type: 'String', sensitive: true },
      verifySSL: { type: 'Boolean', default: true },
      basicUsername: { type: 'String' },
      basicPassword: { type: 'String', sensitive: true },
      defaultEmail: { type: 'String', default: 'wiki@example.test' },
      defaultName: { type: 'String', default: 'Wiki' },
      localRepoPath: { type: 'String', default: '/tmp/wiki-git' }
    },
    actions: [{ handler: 'importAll' }]
  }
]

suite('legacy content import storage handoff on PostgreSQL', () => {
  let db: Knex, previousWiki: unknown, utilities: UtilitiesWorkspaceStore
  const effects = { beforeActivation: async () => undefined }
  const executeAction = vi.fn(async () => ({
    targetKey: 'disk',
    handler: 'importAll',
    outcome: 'succeeded',
    total: 1,
    succeeded: 1,
    failed: 0,
    formats: { okf: 1, legacyV1: 0, legacyWiki: 0, plain: 0, invalid: 0 },
    items: [{ kind: 'page', outcome: 'succeeded', format: 'okf', path: 'guide.md', message: null, diagnostics: [] }]
  }))
  const runtime = {
    ROOTPATH: process.cwd(),
    models: {
      knex: undefined as unknown as Knex,
      assets: { flushTempUploads: async () => undefined },
      pages: { query: () => ({ findById: async () => undefined }), renderPage: async () => undefined },
      storage: {
        runtimeTargets: () => [],
        performAdministrativeOperation: async (before: () => Promise<unknown>, after: (targets: unknown[]) => Promise<unknown>) => {
          await effects.beforeActivation()
          await before()
          const rows = await db('storage').orderBy('key')
          return after(rows.map(row => ({ key: row.key, configurationKey: storageConfigurationKey(row), active: true, paused: false })))
        },
        executeAction
      }
    },
    config: { sessionSecret: 'utility-content-import-test-key', telemetry: { isEnabled: false, clientId: 'fixture-client' } },
    telemetry: { enabled: false, generateClientId: () => undefined },
    configSvc: { saveToDb: async () => true },
    data: { storage: rawDefinitions }
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value')
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
    })
    await db.schema.createTable('storage', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.string('mode').notNullable()
      table.string('syncInterval').notNullable()
      table.jsonb('config').notNullable()
      table.jsonb('state').notNullable()
    })
    await db.schema.createTable('locales', table => {
      table.string('code', 35).primary()
      table.string('name', 160).notNullable()
    })
    await storageMigration(db)
    await utilitiesMigration(db)
    runtime.models.knex = db
    previousWiki = Reflect.get(globalThis, 'WIKI')
    Reflect.set(globalThis, 'WIKI', runtime)
    utilities = createUtilitiesWorkspaceStore(db)
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['utilitiesOperations', 'storageOperations', 'storage', 'locales', 'userGroups', 'groups', 'users', 'settings'])
      await db.schema.dropTableIfExists(table)
    await db.destroy()
    Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  beforeEach(async () => {
    executeAction.mockClear()
    for (const table of ['utilitiesOperations', 'storageOperations', 'storage', 'locales', 'userGroups', 'groups', 'users', 'settings'])
      await db(table).delete()
    await db('settings').insert({ key: 'storageAdministration', value: '{}', updatedAt: new Date().toISOString() })
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    effects.beforeActivation = async () => undefined
    await db('groups').insert({ id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'initial' })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await db('locales').insert({ code: 'en', name: 'English' })
    await db('storage').insert([
      {
        key: 'disk',
        isEnabled: false,
        mode: 'push',
        syncInterval: 'P0D',
        config: JSON.stringify({ path: '/old-source', createDailyBackups: true, opaque: 'disk-opaque' }),
        state: JSON.stringify({ status: 'error' })
      },
      {
        key: 'git',
        isEnabled: true,
        mode: 'sync',
        syncInterval: 'P0D',
        config: JSON.stringify({
          authType: 'ssh',
          repoUrl: 'https://old.example.test/repo.git',
          branch: 'main',
          sshPrivateKeyMode: 'contents',
          sshPrivateKeyPath: '',
          sshPrivateKeyContent: 'unselected-private-key',
          verifySSL: true,
          basicUsername: '',
          basicPassword: 'unselected-password',
          defaultEmail: 'old@example.test',
          defaultName: 'Old',
          localRepoPath: '/old/git',
          opaque: 'git-opaque'
        }),
        state: JSON.stringify({ status: 'operational' })
      }
    ])
  })

  const contentRequest = async () => {
    const workspace = await utilities.inspect(requester)
    return {
      id: randomUUID(),
      kind: 'import-v1-content' as const,
      fingerprint: workspace.fingerprint,
      reason: 'Import the approved content source',
      confirmation: 'IMPORT CONTENT',
      payload: { mode: 'disk', path: '/approved-source' }
    }
  }
  const terminalReceipt = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const receipt = await utilities.receipt(requester, id)
      if (receipt.state !== 'running') return receipt
      await Promise.resolve()
    }
    throw Error('Timed out waiting for the content import receipt.')
  }

  it('preserves unselected Git bytes and accepts a second import from unchanged disk storage', async () => {
    const before = await db('storage').where('key', 'git').first()
    const importDisk = () =>
      runUtilityContentImport(requester, { mode: 'disk', path: '/approved-source' }, 'Import the approved content source', async () => undefined)
    await expect(importDisk()).resolves.toMatchObject({ outcome: 'succeeded', counts: { total: 1, succeeded: 1, failed: 0 } })
    expect(await db('storage').where('key', 'git').first()).toEqual(before)
    const afterFirst = await db('settings').where('key', 'storageAdministration').first()
    await expect(importDisk()).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(await db('settings').where('key', 'storageAdministration').first()).toEqual(afterFirst)
    expect(executeAction).toHaveBeenCalledTimes(2)
  })

  it('completes a full Utilities-reviewed import through the default Storage executor after publishing storageAdministration', async () => {
    const input = await contentRequest()
    await utilities.start(requester, input)
    await expect(terminalReceipt(input.id)).resolves.toMatchObject({
      state: 'succeeded',
      result: { processed: 1, succeeded: 1, failed: 0 }
    })
    expect(executeAction).toHaveBeenCalledWith('disk', 'importAll')
  })

  it('refuses a full Utilities-reviewed import if an unrelated setting changes after its storage publication', async () => {
    effects.beforeActivation = async () => {
      await db('settings').insert({ key: 'unrelatedUtilitiesSetting', value: JSON.stringify({ changed: true }), updatedAt: new Date().toISOString() })
    }
    const input = await contentRequest()
    await utilities.start(requester, input)
    await expect(terminalReceipt(input.id)).resolves.toMatchObject({ state: 'uncertain', phase: 'interrupted' })
    expect(executeAction).not.toHaveBeenCalled()
  })
})

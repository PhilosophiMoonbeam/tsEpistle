import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import knexModule, { type Knex } from 'knex'
import * as Objection from 'objection'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as jobsMigration } from '../../db/migrations/2.5.130.ts'
import { up as leaseMigration } from '../../db/migrations/2.5.158.ts'
import { up as storageMigration } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { up as utilitiesMigration } from '../../db/migrations/tsepistle-000026-utilities-operations.ts'
import { up as relocationMigration } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import { up as revisionMigration } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as revisionReasonsMigration } from '../../db/migrations/tsepistle-000069-page-history-reasons.ts'
import { up as reviewRoutingMigration } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as lifecycleMigration } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as importOwnersMigration } from '../../db/migrations/tsepistle-000077-storage-page-import-owners.ts'
import { up as editLocksMigration } from '../../db/migrations/tsepistle-000080-page-edit-locks.ts'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageErrors from '../../helpers/error.ts'
import type StorageModel from '../../models/storage.ts'
import type PageModel from '../../models/pages.ts'
import { openStorageRoot } from '../../modules/storage/local-filesystem.ts'
import { storageConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { runUtilityContentImport, previewUtilityContentImport } from '../../operations/utility-content-import.ts'
import { createUtilitiesWorkspaceStore, type UtilitiesWorkspaceStore } from '../../operations/utilities-workspace.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_utility_content_import_test', import.meta.path)
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
  let Page: typeof PageModel
  let Storage: typeof StorageModel
  let nativeStorageMethods: Pick<typeof StorageModel, 'executeAction' | 'performAdministrativeOperation' | 'runtimeTargets'>
  let sourcePath: string
  const tables = [
    'utilitiesOperations',
    'storagePageImportOwners',
    'pageLifecycleMoveProposals',
    'pageLifecycleNotices',
    'pageLifecycleActionReceipts',
    'pageLifecycleCycles',
    'pageLifecycleBatches',
    'pageLifecycleRulePages',
    'pageLifecyclePreviews',
    'pageLifecycleRules',
    'pageLifecycleCommentEvents',
    'pageLifecycleClocks',
    'pageReviewRoutingAudit',
    'pageReviewEmailAttempts',
    'pageReviewChannelReceipts',
    'pageReviewConsumed',
    'pageReviewCycles',
    'pageReviewRoutingUsers',
    'pageReviewRoutingGroups',
    'pageReviewRouting',
    'pageMutationOutbox',
    'outboxEvents',
    'pageHistoryTags',
    'pageHistory',
    'pageTags',
    'tags',
    'pageLinks',
    'pageTree',
    'assetRelocationEffects',
    'assetRelocationOperations',
    'storageOperations',
    'durableJobs',
    'assets',
    'assetFolders',
    'pages',
    'storage',
    'locales',
    'userGroups',
    'groups',
    'users',
    'settings'
  ]
  const effects = { beforeActivation: async () => undefined }
  const completeImport = async () => {
    const configured = await Storage.query().findById('disk')
    if (!configured) throw new Error('Missing reviewed native disk target.')
    const root = await openStorageRoot(String(configured.config.path))
    try {
      // Providers capture WIKI at evaluation, so load only after installing this native runtime.
      const plugin = (await import('../../modules/storage/disk/storage.ts')).default
      Object.assign(configured, { fn: { ...plugin, root, config: configured.config, mode: 'push', targetKey: 'disk' } })
      Storage.targets = [configured]
      return await nativeStorageMethods.executeAction.call(Storage, 'disk', 'importAll')
    } finally {
      Storage.targets = []
      await root.close()
    }
  }
  const executeAction = vi.fn(completeImport)
  const runtime = {
    ROOTPATH: process.cwd(),
    SERVERPATH: path.resolve(import.meta.dir, '../..'),
    models: {
      knex: undefined as unknown as Knex,
      Objection,
      assets: { flushTempUploads: async () => undefined },
      pages: { query: () => db('pages'), renderPage: async () => undefined },
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
    config: {
      sessionSecret: 'utility-content-import-test-key',
      db: { type: 'postgres' },
      dataPath: 'data',
      uploads: { maxFileSize: 1024 * 1024 },
      lang: { code: 'en', namespacing: false },
      telemetry: { isEnabled: false, clientId: 'fixture-client' }
    },
    telemetry: { enabled: false, generateClientId: () => undefined },
    configSvc: { saveToDb: async () => true },
    lang: {},
    startedAt: {},
    data: { storage: rawDefinitions, reservedPaths: [], editors: [{ key: 'markdown', contentType: 'markdown' }] },
    auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority },
    logger: console,
    events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
    Error: pageErrors,
    scheduler: {
      registerJob: async ({ name }: { name: string }) => {
        if (name !== 'rebuild-tree') throw new Error(`Unexpected native import fixture job: ${name}`)
        return { finished: Promise.resolve() }
      }
    }
  }

  beforeAll(async () => {
    sourcePath = await mkdtemp(path.join(tmpdir(), 'utility-content-import-'))
    await writeFile(path.join(sourcePath, 'guide.md'), '# Guide\n\nReviewed local source.\n')
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    runtime.ROOTPATH = sourcePath
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value')
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
      table.string('name').notNullable()
      table.string('email').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
      table.string('adminRevision').notNullable()
      table.string('name').notNullable()
      table.jsonb('pageRules').notNullable().defaultTo('[]')
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
    await jobsMigration(db)
    await leaseMigration(db)
    await db.raw(`
      CREATE TABLE pages (
        id serial PRIMARY KEY, path text NOT NULL, hash text NOT NULL, "localeCode" text NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL, render text NOT NULL DEFAULT '', toc text NOT NULL DEFAULT '[]',
        "sourceRevision" bigint NOT NULL DEFAULT 1, "renderedSourceRevision" bigint, "localeGroupId" text,
        "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '',
        visibility text NOT NULL, "ownerId" integer, "authorId" integer NOT NULL, "creatorId" integer NOT NULL,
        "contentType" text NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tags (id serial PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageLinks" ("pageId" integer NOT NULL, "localeCode" text NOT NULL, path text NOT NULL);
      CREATE TABLE "pageTree" (id integer PRIMARY KEY, "pageId" integer, title text, "localeCode" text NOT NULL,
        path text NOT NULL, depth integer NOT NULL, "isFolder" boolean NOT NULL, visibility text NOT NULL, "ownerId" integer,
        parent integer, ancestors text NOT NULL);
      CREATE TABLE "pageHistory" (
        id serial PRIMARY KEY, "pageId" integer NOT NULL, "authorId" integer NOT NULL, path text NOT NULL, hash text NOT NULL,
        title text NOT NULL, description text NOT NULL, visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL,
        "publishStartDate" text NOT NULL, "publishEndDate" text NOT NULL, content text NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL,
        extra jsonb NOT NULL, "localeCode" text NOT NULL, action text NOT NULL, "versionDate" timestamptz NOT NULL, "sourceRevision" bigint NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "pageHistoryTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL, "effectKind" text NOT NULL, "effectKey" text NOT NULL,
        "desiredState" text NOT NULL, "payloadSha256" text NOT NULL, payload text NOT NULL, status text NOT NULL, attempts integer NOT NULL,
        "availableAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
      CREATE TABLE "outboxEvents" (id uuid PRIMARY KEY, type text NOT NULL, version integer NOT NULL, "aggregateType" text NOT NULL,
        "aggregateId" text NOT NULL, payload text NOT NULL, "createdAt" timestamptz NOT NULL, "publishedAt" timestamptz);
      CREATE TABLE "assetFolders" (id integer PRIMARY KEY, slug text NOT NULL, "parentId" integer);
      CREATE TABLE assets (id integer PRIMARY KEY, filename text NOT NULL, "folderId" integer, hash text NOT NULL);
    `)
    await relocationMigration(db)
    await revisionMigration(db)
    await revisionReasonsMigration(db)
    await reviewRoutingMigration(db)
    await lifecycleMigration(db)
    await importOwnersMigration(db)
    await editLocksMigration(db)
    runtime.models.knex = db
    previousWiki = Reflect.get(globalThis, 'WIKI')
    Reflect.set(globalThis, 'WIKI', runtime)
    Storage = (await import('../../models/storage.ts')).default
    nativeStorageMethods = {
      executeAction: Storage.executeAction,
      performAdministrativeOperation: Storage.performAdministrativeOperation,
      runtimeTargets: Storage.runtimeTargets
    }
    Object.assign(Storage, runtime.models.storage)
    // Native models capture WIKI when loaded, after the disposable runtime exists.
    Page = (await import('../../models/pages.ts')).default
    const History = (await import('../../models/pageHistory.ts')).default
    const Tag = (await import('../../models/tags.ts')).default
    const User = (await import('../../models/users.ts')).default
    for (const model of [Page, History, Tag, User, Storage]) model.knex(db)
    Object.assign(runtime.models, {
      storage: Storage,
      pages: Page, pageHistory: History, tags: Tag, users: User,
      editors: { getDefaultEditor: async (contentType: string) => contentType }
    })
    utilities = createUtilitiesWorkspaceStore(db)
  })

  afterAll(async () => {
    if (Storage && nativeStorageMethods) Object.assign(Storage, nativeStorageMethods)
    if (sourcePath) await rm(sourcePath, { recursive: true, force: true })
    if (!db) return
    for (const table of tables) await db.schema.dropTableIfExists(table)
    await db.destroy()
    Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  beforeEach(async () => {
    executeAction.mockClear()
    await writeFile(path.join(sourcePath, 'guide.md'), '# Guide\n\nReviewed local source.\n')
    await rm(path.join(sourcePath, 'a.b.md'), { force: true })
    await rm(path.join(sourcePath, 'nested'), { recursive: true, force: true })
    await rm(path.join(sourcePath, 'empty.md'), { force: true })
    for (const table of tables) await db(table).delete()
    await db('settings').insert({ key: 'storageAdministration', value: '{}', updatedAt: new Date().toISOString() })
    await db('users').insert({ id: 1, isActive: true, authVersion: 0, name: 'Import Administrator', email: 'import@example.test' })
    effects.beforeActivation = async () => undefined
    await db('groups').insert({ id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']), adminRevision: 'initial' })
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
          repoUrl: 'git@old.example.test:repo.git',
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
      payload: { mode: 'disk', path: sourcePath }
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

  const expectPublishedDisk = async () => {
    expect(await db('storage').where('key', 'disk').first()).toMatchObject({
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path: sourcePath, createDailyBackups: true, opaque: 'disk-opaque' }
    })
    const metadata = (await db('settings').where('key', 'storageAdministration').first()).value
    expect(metadata.revision).toEqual(expect.stringMatching(/\S/))
    expect(metadata.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: metadata.revision,
          actorId: 1,
          reason: 'Import the approved content source',
          targets: expect.arrayContaining([
            expect.objectContaining({ key: 'disk', fields: expect.arrayContaining(['isEnabled', 'config.path']) })
          ])
        })
      ])
    )
  }

  it('preserves unselected Git bytes and accepts a second import from unchanged disk storage', async () => {
    const before = await db('storage').where('key', 'git').first()
    const importDisk = () =>
      runUtilityContentImport(requester, { mode: 'disk', path: sourcePath }, 'Import the approved content source', async () => undefined)
    expect(await importDisk()).toMatchObject({ outcome: 'succeeded', counts: { total: 1, succeeded: 1, failed: 0 } })
    expect(await db('storage').where('key', 'git').first()).toEqual(before)
    await expectPublishedDisk()
    const afterFirst = await db('settings').where('key', 'storageAdministration').first()
    await expect(importDisk()).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(await db('settings').where('key', 'storageAdministration').first()).toEqual(afterFirst)
    expect(executeAction).toHaveBeenCalledTimes(2)
  })

  it('completes a full Utilities-reviewed import through default coordinator dependencies and controlled Storage runtime after publishing storageAdministration', async () => {
    const input = await contentRequest()
    executeAction.mockImplementationOnce(async () => {
      await expectPublishedDisk()
      return completeImport()
    })
    await utilities.start(requester, input)
    expect(await terminalReceipt(input.id)).toMatchObject({
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
    // Prove the intended interference was reached, not an earlier validation failure.
    expect(await db('settings').where('key', 'unrelatedUtilitiesSetting').first()).toMatchObject({ value: { changed: true } })
    expect(executeAction).not.toHaveBeenCalled()
  })

  const reviewSource = async () => {
    const preview = await previewUtilityContentImport(requester, { mode: 'disk', path: sourcePath })
    return {
      scope: preview.scope,
      snapshot: preview.snapshot,
      mappings: preview.pages.map(page => ({
        sourcePath: page.sourcePath, sourceSha256: page.sourceSha256, locale: page.locale, path: page.path,
        existingPageId: page.existingPageId, expectedSourceRevision: page.expectedSourceRevision
      }))
    }
  }

  it('previews real bounded source bytes and rejects a stale source before configuration, page or asset writes', async () => {
    const before = await db('storage').orderBy('key')
    await mkdir(path.join(sourcePath, 'nested'))
    await writeFile(path.join(sourcePath, 'nested', 'asset.bin'), Buffer.from([1, 2, 3]))
    await writeFile(path.join(sourcePath, 'empty.md'), '')
    const inventory = await previewUtilityContentImport(requester, { mode: 'disk', path: sourcePath })
    expect(inventory.entries.map(entry => entry.sourcePath).sort()).toEqual(['empty.md', 'guide.md', 'nested', 'nested/asset.bin'])
    expect(inventory.entries.find(entry => entry.sourcePath === 'empty.md')).toMatchObject({
      kind: 'file', sourceSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    })
    expect(inventory.entries.find(entry => entry.sourcePath === 'nested')).toMatchObject({ kind: 'directory', sourceSha256: null })
    const review = await reviewSource()
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(await db('pages')).toEqual([])
    expect(await db('assets')).toEqual([])
    expect(executeAction).not.toHaveBeenCalled()
    await writeFile(path.join(sourcePath, 'guide.md'), '# Changed after review\n')
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review exact source bytes', async () => undefined))
      .rejects.toMatchObject({ status: 409 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(await db('pages')).toEqual([])
    expect(await db('assets')).toEqual([])
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('rejects revoked native authority before any configuration or import mutation', async () => {
    const review = await reviewSource()
    const before = await db('storage').orderBy('key')
    await db('groups').where('id', 1).update({ permissions: '[]', adminRevision: 'revoked-after-preview' })
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review exact authority', async () => undefined))
      .rejects.toMatchObject({ status: 403 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('refuses an invalid mapping before publishing storage and accepts a reviewed native destination', async () => {
    await writeFile(path.join(sourcePath, 'a.b.md'), '# Dotted source\n')
    const review = await reviewSource()
    const before = await db('storage').orderBy('key')
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review dotted source mapping', async () => undefined))
      .rejects.toMatchObject({ status: 409 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(executeAction).not.toHaveBeenCalled()
    review.mappings.find(mapping => mapping.sourcePath === 'a.b.md')!.path = 'a-b'
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review dotted source mapping', async () => undefined))
      .resolves.toMatchObject({ outcome: 'succeeded' })
    expect(executeAction).toHaveBeenCalledTimes(1)
  })

  it('rejects concurrent local-source replacement during queued activation before canonical writes', async () => {
    const review = await reviewSource()
    effects.beforeActivation = async () => {
      await writeFile(path.join(sourcePath, 'guide.md'), '# Concurrent activation source\n')
    }
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review queued local source', async () => undefined))
      .rejects.toMatchObject({ status: 409 })
    expect(await db('pages')).toEqual([])
    expect(await db('assets')).toEqual([])
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('binds explicit legacy associations to live PostgreSQL page revisions before settings publication', async () => {
    const original = await Page.createPage({
      path: 'guide', locale: 'en', content: 'Existing authored content must require explicit association.',
      editor: 'markdown', title: 'Authored guide', description: '', visibility: 'public',
      isPublished: true, user: { id: 1, authVersion: 0, name: 'Import Administrator', email: 'import@example.test', permissions: ['manage:system'] },
      skipStorage: true
    })
    const review = await reviewSource()
    expect(review.mappings[0]).toMatchObject({ existingPageId: original.id, expectedSourceRevision: String(original.sourceRevision) })
    const before = await db('storage').orderBy('key')
    const settingsBefore = await db('settings').orderBy('key')
    const changed = await Page.updatePage({
      id: original.id, expectedSourceRevision: String(original.sourceRevision), content: 'A newer authored revision remains authoritative.',
      user: { id: 1, authVersion: 0, name: 'Import Administrator', email: 'import@example.test', permissions: ['manage:system'] }, skipStorage: true
    })
    const nativeBefore = await db('pages').where({ id: original.id }).first()
    const outboxBefore = await db('outboxEvents').orderBy('id')
    const sourceBefore = await readFile(path.join(sourcePath, 'guide.md'))
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review }, 'Review legacy destination revision', async () => undefined))
      .rejects.toMatchObject({ status: 409 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(await db('settings').orderBy('key')).toEqual(settingsBefore)
    expect(await db('pages').where({ id: original.id }).first()).toEqual(nativeBefore)
    expect(await db('outboxEvents').orderBy('id')).toEqual(outboxBefore)
    expect(await db('storagePageImportOwners')).toEqual([])
    expect(await readFile(path.join(sourcePath, 'guide.md'))).toEqual(sourceBefore)
    expect(executeAction).not.toHaveBeenCalled()
    const currentReview = await reviewSource()
    expect(currentReview.mappings[0]).toMatchObject({ existingPageId: original.id, expectedSourceRevision: String(changed.sourceRevision) })
    await expect(runUtilityContentImport(requester, { mode: 'disk', path: sourcePath, review: currentReview }, 'Review current legacy association', async () => undefined))
      .resolves.toMatchObject({ outcome: 'succeeded' })
    const accepted = await db('storagePageImportOwners').where({ pageId: original.id }).first()
    const imported = await db('pages').where({ id: original.id }).first()
    expect(imported).toMatchObject({ path: 'guide', localeCode: 'en', content: sourceBefore.toString('utf8') })
    expect(BigInt(imported.sourceRevision)).toBeGreaterThan(BigInt(changed.sourceRevision))
    expect(accepted).toMatchObject({
      nativeRevision: String(imported.sourceRevision), nativePath: 'guide', nativeLocaleCode: 'en',
      sourcePath: 'guide.md', sourceSha256: createHash('sha256').update(sourceBefore).digest('hex'), status: 'active'
    })
    const rootEvent = await db('outboxEvents').where({ id: accepted.operationId }).first()
    expect(rootEvent).toMatchObject({ type: 'page.updated', aggregateType: 'page', aggregateId: String(original.id) })
    expect(JSON.parse(rootEvent.payload)).toMatchObject({ pageId: original.id, path: 'guide', localeCode: 'en' })
    for (const previous of outboxBefore) expect(await db('outboxEvents').where({ id: previous.id }).first()).toEqual(previous)
    expect(await readFile(path.join(sourcePath, 'guide.md'))).toEqual(sourceBefore)
  })
})

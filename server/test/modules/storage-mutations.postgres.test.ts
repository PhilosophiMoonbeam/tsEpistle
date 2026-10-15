import knexModule, { type Knex } from 'knex'
import * as Objection from 'objection'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { DurableJobDeferral, DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as createAssetRelocation } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import { createAssetRelocationHandler } from '../../jobs/asset-relocation.ts'
import { up as createStorageAdministration } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { createStorageMutationHandler, enqueueAssetStorageMutation, enqueuePageStorageMutation } from '../../jobs/storage-mutations.ts'
import { withGitMutationLock } from '../../modules/storage/git/mutation-lock.ts'
import { openStorageRoot, type StorageRootHandle } from '../../modules/storage/local-filesystem.ts'
import { okfFilePath } from '../../okf/format.ts'
import type StorageModel from '../../models/storage.ts'
import type AssetModel from '../../models/assets.ts'
import { lockSearchIndex } from '../../helpers/search-contract.ts'
import { createStorageConfigurationStore } from '../../operations/storage-configuration.ts'
import { storageModuleDefinition } from '../../repositories/storage-configuration.ts'
import { readModuleDefinition } from '../../models/moduleTypes.ts'
import commonHelper from '../../helpers/common.ts'
import type { StorageModuleDefinition, StorageTargetDraft } from '../../../shared/storage-workspace.ts'

const connection = getPostgresTestConnection('_storage_mutation_test', import.meta.path)
const suite = connection ? describe : describe.skip
const author = { id: 1, name: 'Native Storage Test', email: 'storage@example.test' }
const handlers = { 'storage-mutation@1': createStorageMutationHandler() }

suite('PostgreSQL canonical storage mutations with real Git', () => {
  let db: Knex
  let replica: Knex
  let gitDefinition: StorageModuleDefinition
  let Storage: typeof StorageModel
  let Asset: typeof AssetModel
  let root: StorageRootHandle
  let directory: string
  let repository: string
  const originalWiki = globalThis.WIKI
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 10_000 }).trim()
  const page = (id: number, pagePath: string, content = 'Current canonical source', localeCode = 'en') => ({
    id,
    path: pagePath,
    localeCode,
    content,
    contentType: 'markdown',
    visibility: 'public',
    title: pagePath,
    description: '',
    sourceRevision: 1,
    authorId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    editorKey: 'markdown',
    extra: {},
    isPublished: true
  })
  const mutatePage = async (id: number, patch: Record<string, unknown>) =>
    db.transaction(async transaction => {
      await lockSearchIndex(transaction, false)
      const previous = await transaction('pages').where({ id }).forUpdate().first()
      await transaction('pages').where({ id }).update(patch)
      await enqueuePageStorageMutation(transaction, { pageId: id, previous, author })
    })
  const ready = async () =>
    db('durableJobs')
      .where({ state: 'pending' })
      .update({ nextRunAt: new Date(0) })
  const drain = async (worker = replica) => {
    await ready()
    return runDurableJobBatch(worker, { workerId: 'storage-replica', limit: 100, handlers })
  }
  const activate = async () => {
    // The native provider captures WIKI on load; install the real fixture runtime before importing it.
    const plugin = (await import('../../modules/storage/git/storage.ts')).default
    const target = await Storage.query().findById('git')
    if (!target) throw new Error('Missing native storage fixture target')
    Object.assign(target, {
      runtimeGeneration: 'native-test',
      fn: { ...plugin, root, git: true, repoPath: repository, targetKey: 'git', config: target.config, mode: target.mode }
    })
    Storage.targets = [target]
    Storage.activeTargets = [target]
  }

  const enableDiskTarget = async () => {
    await db('storage').insert({
      key: 'disk',
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path: 'disk-content', createDailyBackups: false },
      state: {}
    })
    globalThis.WIKI.data.storage.push({ key: 'disk', isAvailable: true, schedule: false, internalSchedule: false })
    // Native disk captures WIKI on load; preserve its real loading boundary.
    const disk = (await import('../../modules/storage/disk/storage.ts')).default
    const target = await Storage.query().findById('disk')
    if (!target) throw new Error('Missing native disk target')
    Object.assign(target, { fn: { ...disk, config: target.config, mode: target.mode } })
    await target.fn.init()
    Storage.targets.push(target)
    Storage.activeTargets.push(target)
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    replica = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await createDurableJobs(db)
    await addLeaseToken(db)
    await db.raw(`
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL, state jsonb);
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE settings (key text PRIMARY KEY, value jsonb, "updatedAt" text NOT NULL);
      CREATE TABLE groups (id integer PRIMARY KEY, permissions jsonb NOT NULL, "adminRevision" text NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE pages (id integer PRIMARY KEY, path text NOT NULL, "localeCode" text NOT NULL, content text NOT NULL, "contentType" text NOT NULL,
        visibility text NOT NULL, title text NOT NULL, description text NOT NULL, "sourceRevision" bigint NOT NULL, "authorId" integer NOT NULL,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL, "isPublished" boolean NOT NULL);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "assetFolders" (id integer PRIMARY KEY, slug text NOT NULL, "parentId" integer);
      CREATE TABLE assets (id serial PRIMARY KEY, hash text NOT NULL UNIQUE, filename text NOT NULL, "folderId" integer, "authorId" integer NOT NULL,
        ext text NOT NULL, kind text NOT NULL, mime text NOT NULL, "fileSize" integer NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "assetData" (id integer PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, data bytea NOT NULL);
    `)
    await createStorageAdministration(db)
    await createAssetRelocation(db)
    await db('users').insert(author)
    await db('groups').insert({ id: 1, permissions: '["manage:system"]', adminRevision: 'initial' })
    await db('userGroups').insert({ userId: author.id, groupId: 1 })
    const definitionPath = path.resolve('server/modules/storage/git/definition.yml')
    const definition = readModuleDefinition(yaml.load(await readFile(definitionPath, 'utf8')), definitionPath)
    gitDefinition = storageModuleDefinition({ ...definition, props: commonHelper.parseModuleProps(definition.props) })
  })
  beforeEach(async () => {
    await db('durableJobs').delete()
    await db('assetRelocationOperations').delete()
    await db('pageTags').delete()
    await db('pages').delete()
    await db('assets').delete()
    await db('storage').delete()
    await db('settings').where({ key: 'storageAdministration' }).update({ value: '{}' })
    await db('storage').insert({
      key: 'git',
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: {
        ...Object.fromEntries(gitDefinition.fields.map(field => [field.key, field.default])),
        authType: 'basic',
        alwaysNamespace: false,
        localRepoPath: 'repository',
        repoUrl: 'https://example.invalid/native.git',
        branch: 'main',
        defaultName: author.name,
        defaultEmail: author.email,
        verifySSL: true,
        basicUsername: 'fixed-account',
        basicPassword: 'original-password'
      },
      state: {}
    })
    directory = await mkdtemp(path.join(tmpdir(), 'wiki-storage-mutations-'))
    repository = path.join(directory, 'repository')
    await mkdir(repository)
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', author.name)
    git('config', 'user.email', author.email)
    root = await openStorageRoot(repository)
    const wiki = {
      ROOTPATH: directory,
      SERVERPATH: path.resolve(import.meta.dir, '../..'),
      config: {
        db: { type: 'postgres' },
        dataPath: 'data',
        lang: { code: 'en', namespacing: false },
        uploads: { maxFileSize: 1_048_576, scanSVG: false, forceDownload: false }
      },
      data: { storage: [{ key: 'git', isAvailable: true, schedule: false, internalSchedule: false }], reservedPaths: [] },
      logger: console,
      auth: {
        checkAccess: () => true,
        checkPageAccess: () => true,
        loadPageRuleAuthority: async () => ({ requester: author, permissions: ['manage:system'], groups: [], tagAliases: {} })
      },
      Error: {
        AssetInvalid: Error,
        AssetRenameInvalidExt: Error,
        AssetRenameInvalid: Error,
        AssetRenameCollision: Error,
        AssetRenameForbidden: Error,
        AssetRenameTargetForbidden: Error,
        AssetDeleteForbidden: Error,
        AssetFolderExists: Error
      },
      scheduler: {
        jobs: [],
        registerJob() {
          throw new Error('This fixture disables storage schedules')
        }
      },
      models: { knex: db, Objection, storage: {} as unknown, assets: {} as unknown, assetFolders: {} as unknown }
    }
    // Keep the captured native model/provider runtime object alive across repository restarts.
    if (Storage) Object.assign(globalThis.WIKI, wiki)
    else globalThis.WIKI = wiki as never
    // Native models capture WIKI during loading, so static imports would bind an uninitialized runtime.
    Storage = (await import('../../models/storage.ts')).default
    Asset = (await import('../../models/assets.ts')).default
    const Folder = (await import('../../models/assetFolders.ts')).default
    Storage.knex(db)
    Asset.knex(db)
    Folder.knex(db)
    Object.assign(wiki.models, { storage: Storage, assets: Asset, assetFolders: Folder })
    await activate()
  })
  afterEach(async () => {
    for (const target of Storage.activeTargets) {
      const deactivate = target.fn.deactivated
      if (typeof deactivate === 'function') await deactivate.call(target.fn)
    }
    Storage.activeTargets = []
    Storage.targets = []
    await root?.close()
    await rm(directory, { recursive: true, force: true })
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki
    await Promise.all([db?.destroy(), replica?.destroy()])
  })

  it('rolls back actual upload bytes and canonical rows when durable admission fails', async () => {
    const uploads = path.join(directory, 'data', 'uploads')
    await mkdir(uploads, { recursive: true })
    const source = path.join(uploads, 'source.bin')
    const bytes = Buffer.from('Canonical upload must not commit without its effect')
    await writeFile(source, bytes)
    await db.raw(`ALTER TABLE "durableJobs" ADD CONSTRAINT reject_storage_admission CHECK (type <> 'storage-mutation')`)
    try {
      await expect(
        Asset.upload({
          originalname: 'source.bin',
          assetPath: 'source.bin',
          mimetype: 'application/octet-stream',
          size: bytes.length,
          folderId: null,
          path: source,
          mode: 'upload',
          user: author
        })
      ).rejects.toThrow('reject_storage_admission')
      expect(await db('assets')).toHaveLength(0)
      expect(await db('assetData')).toHaveLength(0)
      expect(await db('durableJobs')).toHaveLength(0)
      expect(await readFile(source)).toEqual(bytes)
      await expect(
        Promise.resolve(
          db.transaction(async transaction => {
            await transaction('pages').insert(page(1, 'rollback'))
            await enqueuePageStorageMutation(transaction, { pageId: 1, author })
          })
        )
      ).rejects.toThrow()
      expect(await db('pages')).toHaveLength(0)
    } finally {
      await db.raw('ALTER TABLE "durableJobs" DROP CONSTRAINT reject_storage_admission')
    }
  })

  it('retains startup and repeated busy failures, then resumes from a new runtime and replica', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'busy'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    Storage.activeTargets = []
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const incumbent = withGitMutationLock(replica, 'git', async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    try {
      for (let attempt = 0; attempt < 7; attempt += 1) await drain()
      const pending = await db('durableJobs').first()
      expect(pending.state).toBe('pending')
      expect(pending.attempts).toBe(0)
      expect(pending.lastError).toContain('busy')
      expect((await db('storage').where({ key: 'git' }).first()).state.status).toBe('error')
    } finally {
      release.resolve()
      await incumbent
    }
    await db('pages').where({ id: 1 }).update({ content: 'Latest canonical source after restart', sourceRevision: 2 })
    // A partially written crash worktree must be replayable without fetching an older remote.
    await root.writeAtomic(okfFilePath('en', 'busy'), 'Interrupted older write')
    await drain(db)
    expect(await db('durableJobs').first()).toMatchObject({ state: 'succeeded', lastError: null })
    expect((await db('durableJobs').first()).payload).not.toContain('Latest canonical source after restart')
    expect(git('show', `HEAD:${okfFilePath('en', 'busy')}`)).toContain('Latest canonical source after restart')
    expect(git('status', '--porcelain')).toBe('')
  })

  it('retains a busy Git target independently while a healthy native disk target converges', async () => {
    await db('storage').insert({
      key: 'disk',
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path: 'disk-content', createDailyBackups: false },
      state: {}
    })
    globalThis.WIKI.data.storage.push({ key: 'disk', isAvailable: true, schedule: false, internalSchedule: false })
    // Native providers capture the fixture runtime and must be loaded after its installation.
    const disk = (await import('../../modules/storage/disk/storage.ts')).default
    const target = await Storage.query().findById('disk')
    if (!target) throw new Error('Missing disk fixture target')
    Object.assign(target, { fn: { ...disk, config: target.config, mode: target.mode } })
    await target.fn.init()
    Storage.targets.push(target)
    Storage.activeTargets.push(target)
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'independent', 'Both enabled targets own this canonical write'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const incumbent = withGitMutationLock(replica, 'git', async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    try {
      await drain()
      const states = Object.fromEntries((await db('durableJobs')).map(job => [JSON.parse(job.payload).targetKey, job.state]))
      expect(states).toEqual({ git: 'pending', disk: 'succeeded' })
      expect(await readFile(path.join(directory, 'disk-content', okfFilePath('en', 'independent')), 'utf8')).toContain('Both enabled targets')
      expect((await db('storage').where({ key: 'git' }).first()).state.status).toBe('error')
      expect((await db('storage').where({ key: 'disk' }).first()).state.status).toBe('operational')
    } finally {
      release.resolve()
      await incumbent
    }
    await drain()
    expect(git('show', `HEAD:${okfFilePath('en', 'independent')}`)).toContain('Both enabled targets')
  })

  it('never inherits a Git turn or exports a page made private before its real replay turn', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'private-turn', 'Source that was public only before the turn'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    const store = new DurableJobStore(db)
    const [job] = await store.claim({ workerId: 'waiting-turn', supportedIdentities: ['storage-mutation@1'] })
    if (!job) throw new Error('Storage job missing')
    await withGitMutationLock(replica, 'git', async () => {
      await expect(handlers['storage-mutation@1'](job, { knex: db, signal: new AbortController().signal })).rejects.toMatchObject({
        name: 'DurableJobDeferral',
        cause: { code: 'STORAGE_GIT_BUSY' }
      })
      await db('pages').where({ id: 1 }).update({ visibility: 'private', content: 'Private current source', sourceRevision: 2 })
    })
    await store.fail(job, new DurableJobDeferral(new Error('busy'), true))
    await drain()
    expect(await store.get(job.id)).toMatchObject({ state: 'succeeded' })
    await expect(readFile(path.join(repository, okfFilePath('en', 'private-turn')))).rejects.toThrow()
    expect(git('status', '--porcelain')).toBe('')
  })

  it('reconciles old/reused paths, locale moves, format conversion and private transitions from current owners', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'old', 'Original body'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    await mutatePage(1, { path: 'new', localeCode: 'fr', content: 'Moved current body', sourceRevision: 2 })
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(2, 'old', 'New imported owner body'))
      await enqueuePageStorageMutation(transaction, { pageId: 2, author, skipStorage: true })
    })
    await drain()
    expect(git('show', `HEAD:${okfFilePath('en', 'old')}`)).toContain('New imported owner body')
    expect(git('show', `HEAD:${okfFilePath('fr', 'new')}`)).toContain('Moved current body')
    await mutatePage(1, { contentType: 'html', editorKey: 'code', content: '<p>Converted</p>', sourceRevision: 3 })
    await drain()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(okfFilePath('fr', 'new'))
    expect(git('show', 'HEAD:new.html')).toContain('<p>Converted</p>')
    await mutatePage(1, { visibility: 'private', content: 'PRIVATE SOURCE MUST NEVER EGRESS', sourceRevision: 4 })
    await drain()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('new.html')
    expect(git('log', '-p', '--all')).not.toContain('PRIVATE SOURCE MUST NEVER EGRESS')
    const commit = git('rev-parse', 'HEAD')
    const latest = await db('durableJobs').orderBy('createdAt', 'desc').first()
    await db('durableJobs')
      .where({ id: latest.id })
      .update({ state: 'pending', completedAt: null, nextRunAt: new Date(0) })
    await drain()
    expect(git('rev-parse', 'HEAD')).toBe(commit)
  })

  it('removes the former native HTML encoding when the same page converts to Markdown, including later privacy and deletion', async () => {
    await db('storage').insert({
      key: 'disk',
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path: 'disk-content', createDailyBackups: false },
      state: {}
    })
    globalThis.WIKI.data.storage.push({ key: 'disk', isAvailable: true, schedule: false, internalSchedule: false })
    // Load the actual provider only after the native test runtime is installed.
    const disk = (await import('../../modules/storage/disk/storage.ts')).default
    const target = await Storage.query().findById('disk')
    if (!target) throw new Error('Missing disk fixture target')
    Object.assign(target, { fn: { ...disk, config: target.config, mode: target.mode } })
    await target.fn.init()
    Storage.targets.push(target)
    Storage.activeTargets.push(target)
    const formerDiskPath = path.join(directory, 'disk-content', 'guide.html')
    await db.transaction(async transaction => {
      await transaction('pages').insert({ ...page(1, 'guide', '<p>Former public HTML source</p>'), contentType: 'html', editorKey: 'code' })
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    expect(git('show', 'HEAD:guide.html')).toContain('Former public HTML source')
    expect(await readFile(formerDiskPath, 'utf8')).toContain('Former public HTML source')
    await mutatePage(1, { contentType: 'markdown', editorKey: 'markdown', content: 'Converted canonical Markdown', sourceRevision: 2 })
    await drain()
    expect(git('show', `HEAD:${okfFilePath('en', 'guide')}`)).toContain('Converted canonical Markdown')
    expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('guide.html')
    await expect(readFile(formerDiskPath)).rejects.toThrow()
    expect(await readFile(path.join(directory, 'disk-content', okfFilePath('en', 'guide')), 'utf8')).toContain('Converted canonical Markdown')
    await mutatePage(1, { visibility: 'private', content: 'Private converted source', sourceRevision: 3 })
    await drain()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('')
    await expect(readFile(formerDiskPath)).rejects.toThrow()
    await expect(readFile(path.join(directory, 'disk-content', okfFilePath('en', 'guide')))).rejects.toThrow()
    await db.transaction(async transaction => {
      await lockSearchIndex(transaction, false)
      const previous = await transaction('pages').where({ id: 1 }).forUpdate().first()
      await transaction('pages').where({ id: 1 }).delete()
      await enqueuePageStorageMutation(transaction, { pageId: 1, previous, author })
    })
    await drain()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('')
  })

  it('rejects an asset upload at the actual nondefault-locale disk filename even when global namespacing is disabled', async () => {
    await enableDiskTarget()
    await db.transaction(async transaction => {
      await transaction('pages').insert({ ...page(1, 'guide', '<p>French disk page owner</p>', 'fr'), contentType: 'html', editorKey: 'code' })
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    const exported = path.join(directory, 'disk-content', 'fr', 'guide.html')
    expect(await readFile(exported, 'utf8')).toContain('French disk page owner')
    await db('assetFolders').insert({ id: 3, slug: 'fr', parentId: null })
    const source = path.join(directory, 'guide.html')
    const bytes = Buffer.from('Must not replace the French disk page')
    await writeFile(source, bytes)
    await expect(
      Asset.upload({
        originalname: 'guide.html',
        assetPath: 'fr/guide.html',
        mimetype: 'text/html',
        size: bytes.length,
        folderId: 3,
        path: source,
        mode: 'import',
        user: author
      })
    ).rejects.toMatchObject({ status: 409, code: 'STORAGE_PATH_COLLISION' })
    expect(await db('assets')).toHaveLength(0)
    expect(await db('assetData')).toHaveLength(0)
    expect(await readFile(exported, 'utf8')).toContain('French disk page owner')
  })

  for (const withdrawal of ['private', 'delete'] as const) {
    it(`withdraws the actual nondefault-locale disk filename on ${withdrawal} with global namespacing disabled`, async () => {
      await enableDiskTarget()
      await db.transaction(async transaction => {
        await transaction('pages').insert({ ...page(1, 'guide', '<p>French source to withdraw</p>', 'fr'), contentType: 'html', editorKey: 'code' })
        await enqueuePageStorageMutation(transaction, { pageId: 1, author })
      })
      await drain()
      const exported = path.join(directory, 'disk-content', 'fr', 'guide.html')
      expect(await readFile(exported, 'utf8')).toContain('French source to withdraw')
      if (withdrawal === 'private') await mutatePage(1, { visibility: 'private', content: 'Private French source', sourceRevision: 2 })
      else
        await db.transaction(async transaction => {
          await lockSearchIndex(transaction, false)
          const previous = await transaction('pages').where({ id: 1 }).forUpdate().first()
          await transaction('pages').where({ id: 1 }).delete()
          await enqueuePageStorageMutation(transaction, { pageId: 1, previous, author })
        })
      await drain()
      expect(await db('durableJobs').whereNot({ state: 'succeeded' })).toHaveLength(0)
      await expect(readFile(exported)).rejects.toThrow()
      expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('')
    })
  }

  it('retains native relocation for an enabled inactive offline target and reconciles real Git after recovery', async () => {
    const source = path.join(directory, 'old.png')
    const bytes = Buffer.from('Canonical relocation bytes')
    await writeFile(source, bytes)
    await Asset.upload({
      originalname: 'old.png',
      assetPath: 'old.png',
      mimetype: 'image/png',
      size: bytes.length,
      folderId: null,
      path: source,
      mode: 'import',
      user: author
    })
    await drain()
    const asset = await db('assets').first()
    // Native operations capture the installed runtime at load, after the real models are bound.
    const operations = (await import('../../operations/assets.ts')).default
    const config = globalThis.WIKI.config
    config.offline = true
    Storage.activeTargets = []
    try {
      const receipt = await operations.relocate({ requester: author, id: asset.id, filename: 'new.png' })
      expect(receipt).toMatchObject({ status: 'pending', effects: [{ targetKey: 'git', status: 'pending' }] })
      expect(await db('assetRelocationEffects').where({ operationId: receipt.id })).toHaveLength(1)
      const relocationHandlers = { 'asset-relocation@1': createAssetRelocationHandler() }
      await runDurableJobBatch(replica, { workerId: 'offline-relocation', handlers: relocationHandlers })
      expect(await operations.relocationStatus({ requester: author, id: receipt.id })).toMatchObject({
        status: 'pending',
        effects: [{ targetKey: 'git', status: 'pending' }]
      })
      config.offline = false
      await ready()
      await runDurableJobBatch(replica, { workerId: 'recovered-relocation', handlers: relocationHandlers })
      expect(await operations.relocationStatus({ requester: author, id: receipt.id })).toMatchObject({
        status: 'succeeded',
        effects: [{ targetKey: 'git', status: 'succeeded' }]
      })
      expect(git('show', 'HEAD:new.png')).toBe(bytes.toString())
      expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('old.png')
    } finally {
      config.offline = false
    }
  })

  it('rejects relocation onto a public page encoding without committing an asset identity or effect ledger', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert({ ...page(1, 'guide', '<p>Canonical page owner</p>'), contentType: 'html', editorKey: 'code' })
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    const source = path.join(directory, 'old.html')
    const bytes = Buffer.from('Canonical asset source')
    await writeFile(source, bytes)
    await Asset.upload({
      originalname: 'old.html',
      assetPath: 'old.html',
      mimetype: 'text/html',
      size: bytes.length,
      folderId: null,
      path: source,
      mode: 'import',
      user: author
    })
    await drain()
    const asset = await db('assets').first()
    // The native operation captures the test runtime after real model installation.
    const operations = (await import('../../operations/assets.ts')).default
    await expect(operations.relocate({ requester: author, id: asset.id, filename: 'guide.html' })).rejects.toMatchObject({
      status: 409,
      code: 'STORAGE_PATH_COLLISION'
    })
    expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({ filename: 'old.html', hash: asset.hash })
    expect(await db('assetRelocationOperations')).toHaveLength(0)
    expect(await db('assetRelocationEffects')).toHaveLength(0)
    expect(git('show', 'HEAD:guide.html')).toContain('Canonical page owner')
    expect(git('show', 'HEAD:old.html')).toBe(bytes.toString())
  })

  const admitRelocation = async () => {
    const source = path.join(directory, 'old.png')
    const bytes = Buffer.from('Existing relocation source and immutable destination')
    await writeFile(source, bytes)
    await Asset.upload({
      originalname: 'old.png',
      assetPath: 'old.png',
      mimetype: 'image/png',
      size: bytes.length,
      folderId: null,
      path: source,
      mode: 'import',
      user: author
    })
    await drain()
    const asset = await db('assets').first()
    const operations = (await import('../../operations/assets.ts')).default
    const receipt = await operations.relocate({ requester: author, id: asset.id, filename: 'new.png' })
    const beforeEffect = await db('assetRelocationEffects').where({ operationId: receipt.id }).first()
    const beforeJob = await db('durableJobs').where({ id: beforeEffect.jobId }).first()
    return { bytes, operations, receipt, beforeEffect, beforeJob, beforePayload: JSON.parse(beforeJob.payload), jobStore: new DurableJobStore(replica) }
  }

  const saveCompatibleRepair = async (repair: 'schedule' | 'password' | 'local-path' | 'remote-url') => {
    const publication = createStorageConfigurationStore({ db, reviewKey: 'relocation-publication-test', definitions: () => [gitDefinition] })
    const administrator = { ...author, authVersion: 0, permissions: ['manage:system'] }
    const workspace = await publication.inspect(administrator)
    const targets: StorageTargetDraft[] = workspace.targets.map(target => ({
      key: target.key,
      isEnabled: target.isEnabled,
      mode: target.mode,
      syncInterval: target.syncInterval,
      config: structuredClone(target.config),
      secrets: Object.fromEntries(Object.keys(target.secrets).map(key => [key, { action: 'keep' as const }]))
    }))
    const target = targets.find(value => value.key === 'git')
    if (!target) throw new Error('Git publication target is unavailable')
    if (repair === 'schedule') target.syncInterval = 'PT10M'
    else if (repair === 'password') target.secrets.basicPassword = { action: 'replace', value: 'repaired-password' }
    else if (repair === 'local-path') target.config.localRepoPath = 'other-repository'
    else target.config.repoUrl = 'https://example.invalid/other-destination.git'
    await publication.save(administrator, { targets, fingerprint: workspace.fingerprint, reason: 'Repair transport without abandoning existing relocation' })
  }

  for (const repair of ['schedule', 'password'] as const) {
    for (const claimedBeforePublication of [false, true]) {
      it(`preserves ${claimedBeforePublication ? 'preclaimed' : 'pending'} relocation through reviewed ${repair} repair and real Git replay`, async () => {
        // Exercise the installed native authority/model boundary rather than constructing ledger rows.
        const { bytes, operations, receipt, beforeEffect, beforeJob, beforePayload, jobStore } = await admitRelocation()
        const [claimed] = claimedBeforePublication
          ? await jobStore.claim({ workerId: 'claimed-before-repair', supportedIdentities: ['asset-relocation@1'] })
          : []
        if (claimedBeforePublication && !claimed) throw new Error('Existing relocation was not claimed')
        const leaseBeforePublication = await db('durableJobs')
          .where({ id: beforeJob.id })
          .first('state', 'attempts', 'maxAttempts', 'leaseOwner', 'leaseToken', 'leaseExpiresAt')
        await saveCompatibleRepair(repair)
        expect(
          await db('durableJobs').where({ id: beforeJob.id }).first('state', 'attempts', 'maxAttempts', 'leaseOwner', 'leaseToken', 'leaseExpiresAt')
        ).toEqual(leaseBeforePublication)
        await Storage.initTargets()
        if (claimed) {
          // Deliberately keep the pre-publication in-memory payload: the worker must reload
          // authorized ledger metadata under its current lease and the native asset fence.
          expect(claimed.payload).toEqual(beforePayload)
          await createAssetRelocationHandler()(claimed, { knex: replica, signal: new AbortController().signal })
          expect(await jobStore.complete(claimed)).toBe(true)
        } else {
          await ready()
          await runDurableJobBatch(replica, { workerId: 'relocation-after-repair', handlers: { 'asset-relocation@1': createAssetRelocationHandler() } })
        }
        expect(await operations.relocationStatus({ requester: author, id: receipt.id })).toMatchObject({
          status: 'succeeded',
          effects: [{ targetKey: 'git', status: 'succeeded' }]
        })
        expect(git('show', 'HEAD:new.png')).toBe(bytes.toString())
        expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('old.png')
        const afterEffect = await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()
        const afterJob = await db('durableJobs').where({ id: beforeEffect.jobId }).first()
        const afterPayload = JSON.parse(afterJob.payload)
        expect(afterEffect.targetConfigurationRevision).not.toBe(beforeEffect.targetConfigurationRevision)
        expect(afterPayload).toEqual({ ...beforePayload, targetConfigurationRevision: afterEffect.targetConfigurationRevision })
        expect(afterJob).toMatchObject({ id: beforeJob.id, maxAttempts: beforeJob.maxAttempts, state: 'succeeded' })
        expect(afterEffect).toMatchObject({
          id: beforeEffect.id,
          operationId: beforeEffect.operationId,
          jobId: beforeEffect.jobId,
          assetId: beforeEffect.assetId,
          sourcePath: beforeEffect.sourcePath,
          destinationPath: beforeEffect.destinationPath,
          contentSha256: beforeEffect.contentSha256
        })
        // Completed receipts are immutable even through another compatible publication.
        await saveCompatibleRepair(repair === 'schedule' ? 'password' : 'schedule')
        expect(await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()).toEqual(afterEffect)
        expect(await db('durableJobs').where({ id: beforeJob.id }).first()).toEqual(afterJob)
      })
    }
  }

  for (const destinationChange of ['local-path', 'remote-url'] as const) {
    it(`rejects ${destinationChange} publication while only native asset relocation remains outstanding`, async () => {
      const { beforeEffect, beforeJob } = await admitRelocation()
      expect(await db('durableJobs').whereNot('state', 'succeeded').select('type', 'version')).toEqual([{ type: 'asset-relocation', version: 1 }])
      const effect = await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()
      const job = await db('durableJobs').where({ id: beforeJob.id }).first()
      const target = await db('storage').where({ key: 'git' }).first()
      await expect(saveCompatibleRepair(destinationChange)).rejects.toMatchObject({
        status: 409,
        name: 'ASSET_RELOCATION_CONFIGURATION_CONFLICT'
      })
      expect(await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()).toEqual(effect)
      expect(await db('durableJobs').where({ id: beforeJob.id }).first()).toEqual(job)
      expect(await db('storage').where({ key: 'git' }).first()).toEqual(target)
    })
  }

  for (const invalidHistory of ['unknown-revision', 'forged-source'] as const) {
    it(`rejects ${invalidHistory} relocation history with an atomic fixed-409 publication failure`, async () => {
      const { beforeEffect, beforeJob, beforePayload } = await admitRelocation()
      if (invalidHistory === 'unknown-revision') {
        await db('assetRelocationEffects').where({ id: beforeEffect.id }).update({ targetConfigurationRevision: 'unknown-prior-configuration' })
        await db('durableJobs')
          .where({ id: beforeJob.id })
          .update({
            payload: JSON.stringify({ ...beforePayload, targetConfigurationRevision: 'unknown-prior-configuration' })
          })
      } else {
        await db('durableJobs')
          .where({ id: beforeJob.id })
          .update({
            payload: JSON.stringify({ ...beforePayload, sourcePath: 'not-the-admitted-source.png' })
          })
      }
      const effect = await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()
      const job = await db('durableJobs').where({ id: beforeJob.id }).first()
      const target = await db('storage').where({ key: 'git' }).first()
      await expect(saveCompatibleRepair('schedule')).rejects.toMatchObject({
        status: 409,
        name: 'ASSET_RELOCATION_CONFIGURATION_CONFLICT'
      })
      expect(await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()).toEqual(effect)
      expect(await db('durableJobs').where({ id: beforeJob.id }).first()).toEqual(job)
      expect(await db('storage').where({ key: 'git' }).first()).toEqual(target)
      expect(git('show', 'HEAD:old.png')).toBe('Existing relocation source and immutable destination')
      expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('new.png')
    })
  }

  for (const invalidLease of ['expired', 'forged-token'] as const) {
    it(`never refreshes a ${invalidLease} preclaim after configuration rebind and recovers its retained work`, async () => {
      const { bytes, beforeEffect, beforeJob, jobStore } = await admitRelocation()
      const [claimed] = await jobStore.claim({ workerId: 'original-relocation-worker', supportedIdentities: ['asset-relocation@1'] })
      if (!claimed) throw new Error('Existing relocation was not claimed')
      await saveCompatibleRepair('schedule')
      await Storage.initTargets()
      if (invalidLease === 'expired') {
        await db('durableJobs')
          .where({ id: claimed.id })
          .update({ leaseExpiresAt: new Date(Date.now() - 1000) })
      }
      const effect = await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()
      const job = await db('durableJobs').where({ id: beforeJob.id }).first()
      const invalidClaim = invalidLease === 'forged-token' ? { ...claimed, leaseToken: crypto.randomUUID() } : claimed
      await expect(createAssetRelocationHandler()(invalidClaim, { knex: replica, signal: new AbortController().signal })).rejects.toThrow()
      expect(await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()).toEqual(effect)
      expect(await db('durableJobs').where({ id: beforeJob.id }).first()).toEqual(job)
      expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('new.png')
      await db('durableJobs')
        .where({ id: claimed.id })
        .update({ leaseExpiresAt: new Date(Date.now() - 1000) })
      await runDurableJobBatch(replica, { workerId: 'reclaimed-relocation-worker', handlers: { 'asset-relocation@1': createAssetRelocationHandler() } })
      expect(await db('assetRelocationEffects').where({ id: beforeEffect.id }).first()).toMatchObject({ status: 'succeeded' })
      expect(git('show', 'HEAD:new.png')).toBe(bytes.toString())
      expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('old.png')
    })
  }

  it('preserves replacement asset bytes when an older delete replays after path reuse', async () => {
    const source = path.join(directory, 'source.bin')
    const upload = async (text: string, skipStorage = false) => {
      const bytes = Buffer.from(text)
      await writeFile(source, bytes)
      await Asset.upload({
        originalname: 'source.bin',
        assetPath: 'source.bin',
        mimetype: 'application/octet-stream',
        size: bytes.length,
        folderId: null,
        path: source,
        mode: 'import',
        user: author,
        skipStorage
      })
    }
    await upload('Old bytes')
    await drain()
    const asset = await db('assets').first()
    await db.transaction(async transaction => {
      await transaction('assets').where({ id: asset.id }).delete()
      await enqueueAssetStorageMutation(transaction, { assetId: asset.id, paths: ['source.bin'], author })
    })
    await upload('Replacement imported bytes', true)
    await drain()
    expect(git('show', 'HEAD:source.bin')).toBe('Replacement imported bytes')
    const commit = git('rev-parse', 'HEAD')
    const effect = await db('durableJobs').orderBy('createdAt', 'desc').first()
    await db('durableJobs')
      .where({ id: effect.id })
      .update({ state: 'pending', nextRunAt: new Date(0), completedAt: null })
    await drain()
    expect(git('rev-parse', 'HEAD')).toBe(commit)
  })

  it('fences an absent path against ordinary asset writes and a skipStorage page import until the real Git effect finishes', async () => {
    const source = path.join(directory, 'new-page.html')
    const oldBytes = Buffer.from('Former asset at the future page path')
    await writeFile(source, oldBytes)
    await Asset.upload({
      originalname: 'new-page.html',
      assetPath: 'new-page.html',
      mimetype: 'text/html',
      size: oldBytes.length,
      folderId: null,
      path: source,
      mode: 'import',
      user: author
    })
    await drain()
    const asset = await db('assets').first()
    await db.transaction(async transaction => {
      await transaction('assets').where({ id: asset.id }).delete()
      await enqueueAssetStorageMutation(transaction, { assetId: asset.id, paths: ['new-page.html'], author })
    })
    const target = Storage.activeTargets[0]
    if (!target?.fn.withMutationTurn) throw new Error('Git mutation boundary is missing')
    const original = target.fn.withMutationTurn
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let removed = false
    // Delegate the real provider effect; this barrier is after the actual fenced absence read.
    target.fn.withMutationTurn = (work, signal) =>
      original.call(
        target.fn,
        dispatch =>
          work({
            ...dispatch,
            removePath: async value => {
              entered.resolve()
              await release.promise
              await dispatch.removePath(value)
              removed = true
            }
          }),
        signal
      )
    const worker = drain()
    let imported: Promise<unknown> | undefined
    try {
      await Promise.race([
        entered.promise,
        worker.then(() => {
          throw new Error('Worker left before the real remove effect')
        })
      ])
      const importedSource = '<p>Imported page source must survive the older delete</p>'
      await writeFile(source, importedSource)
      await expect(
        Asset.upload({
          originalname: 'new-page.html',
          assetPath: 'new-page.html',
          mimetype: 'text/html',
          size: Buffer.byteLength(importedSource),
          folderId: null,
          path: source,
          mode: 'import',
          user: author,
          skipStorage: true
        })
      ).rejects.toMatchObject({ code: 'ASSET_LOCATION_BUSY' })
      expect(await db('assets')).toHaveLength(0)
      expect(await readFile(source, 'utf8')).toBe(importedSource)
      const uploads = path.join(directory, 'data', 'uploads')
      await mkdir(uploads, { recursive: true })
      const ordinarySource = path.join(uploads, 'new-page.html')
      await writeFile(ordinarySource, importedSource)
      await expect(
        Asset.upload({
          originalname: 'new-page.html',
          assetPath: 'new-page.html',
          mimetype: 'text/html',
          size: Buffer.byteLength(importedSource),
          folderId: null,
          path: ordinarySource,
          mode: 'upload',
          user: author
        })
      ).rejects.toMatchObject({ code: 'ASSET_LOCATION_BUSY' })
      const importStarted = Promise.withResolvers<number>()
      imported = replica
        .transaction(async transaction => {
          const result = await transaction.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
          importStarted.resolve(result.rows[0]!.pid)
          // This is the same native canonical fence used by ordinary and skipStorage page producers.
          await lockSearchIndex(transaction, false)
          expect(removed).toBe(true)
          await transaction('pages').insert({ ...page(1, 'new-page', importedSource), contentType: 'html', editorKey: 'code' })
          await enqueuePageStorageMutation(transaction, { pageId: 1, author, skipStorage: true })
        })
        .catch(error => error)
      const pid = await Promise.race([
        importStarted.promise,
        imported.then(result => {
          throw result instanceof Error ? result : new Error('Import left before waiting on the canonical fence')
        })
      ])
      await vi.waitFor(async () => {
        expect(await db('pg_locks').where({ pid, locktype: 'advisory', granted: false }).first('pid')).toBeDefined()
      })
      expect(await db('pages')).toHaveLength(0)
      release.resolve()
      await worker
      expect(await imported).toBeUndefined()
      expect(await db('pages').where({ id: 1 }).first('content')).toMatchObject({ content: importedSource })
    } finally {
      release.resolve()
      await worker
      await imported
      target.fn.withMutationTurn = original
    }
    const effect = await db('durableJobs').first()
    await db('durableJobs')
      .where({ id: effect.id })
      .update({ state: 'pending', completedAt: null, nextRunAt: new Date(0) })
    await drain()
    expect(git('show', 'HEAD:new-page.html')).toContain('Imported page source must survive the older delete')
  })

  it('does not erase a legacy filename reused by a newer page import', async () => {
    const source = path.join(directory, 'legacy.md')
    const bytes = Buffer.from('Former asset bytes')
    await writeFile(source, bytes)
    await Asset.upload({
      originalname: 'legacy.md',
      assetPath: 'legacy.md',
      mimetype: 'text/plain',
      size: bytes.length,
      folderId: null,
      path: source,
      mode: 'import',
      user: author
    })
    await drain()
    const asset = await db('assets').first()
    await db.transaction(async transaction => {
      await transaction('assets').where({ id: asset.id }).delete()
      await enqueueAssetStorageMutation(transaction, { assetId: asset.id, paths: ['legacy.md'], author })
      await transaction('pages').insert(page(1, 'legacy', 'Newer imported page source'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author, skipStorage: true })
    })
    await root.writeAtomic('legacy.md', 'Newer imported page source')
    git('add', '--', 'legacy.md')
    git('commit', '--quiet', '-m', 'Imported source now owns the former asset path')
    const imported = git('rev-parse', 'HEAD')
    await drain()
    expect(git('show', 'HEAD:legacy.md')).toBe('Newer imported page source')
    expect(git('rev-parse', 'HEAD')).toBe(imported)
    expect(await db('durableJobs').whereNot({ state: 'succeeded' })).toHaveLength(0)
  })

  it('reclaims a crashed final-attempt lease and rejects stale-token and forged-identity receipts', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'crash'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    const firstStore = new DurableJobStore(db)
    const secondStore = new DurableJobStore(replica)
    const [old] = await firstStore.claim({ workerId: 'crashed', supportedIdentities: ['storage-mutation@1'] })
    if (!old) throw new Error('Storage job was not claimed')
    await db('durableJobs')
      .where({ id: old.id })
      .update({ attempts: old.maxAttempts, leaseExpiresAt: new Date(0) })
    expect(await firstStore.extendLease(old)).toBe(false)
    expect(await firstStore.complete(old)).toBe(false)
    expect(await firstStore.fail(old, new DurableJobDeferral(new Error('expired')))).toBe(false)
    const [current] = await secondStore.claim({ workerId: 'replacement', supportedIdentities: ['storage-mutation@1'] })
    if (!current) throw new Error('Crashed storage lease was not reclaimed')
    expect(current.attempts).toBe(current.maxAttempts)
    expect(await firstStore.complete(old)).toBe(false)
    expect(await firstStore.fail(old, new DurableJobDeferral(new Error('stale')))).toBe(false)
    expect(await secondStore.fail({ ...current, type: 'other-job' }, new DurableJobDeferral(new Error('forged')))).toBe(false)
    expect(await secondStore.cancel(current.id)).toBe(false)
    const aborted = new AbortController()
    aborted.abort(new Error('Worker shutdown before its real Git turn'))
    let interruption: unknown
    try {
      await handlers['storage-mutation@1'](current, { knex: replica, signal: aborted.signal })
    } catch (error) {
      interruption = error
    }
    expect(interruption).toBeInstanceOf(DurableJobDeferral)
    expect(await secondStore.fail(current, interruption)).toBe(true)
    expect(await secondStore.get(current.id)).toMatchObject({ state: 'pending', attempts: current.maxAttempts, completedAt: null })
    await ready()
    const [resumed] = await secondStore.claim({ workerId: 'resumed', supportedIdentities: ['storage-mutation@1'] })
    if (!resumed) throw new Error('Interrupted ceiling job was not retained')
    await handlers['storage-mutation@1'](resumed, { knex: replica, signal: new AbortController().signal })
    expect(await secondStore.complete(resumed)).toBe(true)
    expect(git('show', `HEAD:${okfFilePath('en', 'crash')}`)).toContain('Current canonical source')
  })

  it('retains an enabled target and its pending privacy withdrawal when its provider module disappears', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'removed-module', 'Public before withdrawal'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    await mutatePage(1, { visibility: 'private', content: 'Never egress this private source', sourceRevision: 2 })
    const pending = await db('durableJobs').where({ state: 'pending' }).first()
    const originalServerPath = globalThis.WIKI.SERVERPATH
    const emptyServerPath = path.join(directory, 'missing-module-server')
    await mkdir(path.join(emptyServerPath, 'modules', 'storage'), { recursive: true })
    globalThis.WIKI.SERVERPATH = emptyServerPath
    try {
      await Storage.refreshTargetsFromDisk()
      expect(await db('storage').where({ key: 'git' }).first()).toMatchObject({
        isEnabled: true,
        state: { status: 'error', message: expect.stringContaining('pending') }
      })
      expect(await db('durableJobs').where({ id: pending.id }).first()).toMatchObject({ state: 'pending', completedAt: null })
      await drain()
      expect(await db('durableJobs').where({ id: pending.id }).first()).toMatchObject({ state: 'pending', completedAt: null })
      expect(git('show', `HEAD:${okfFilePath('en', 'removed-module')}`)).toContain('Public before withdrawal')
    } finally {
      globalThis.WIKI.SERVERPATH = originalServerPath
    }
  })

  it('keeps changed configurations fenced and bounds retained deferrals without changing ordinary job exhaustion', async () => {
    await db.transaction(async transaction => {
      await transaction('pages').insert(page(1, 'configuration'))
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await db('storage')
      .where({ key: 'git' })
      .update({ config: { alwaysNamespace: true } })
    await drain()
    expect(await db('durableJobs').first()).toMatchObject({ state: 'pending', completedAt: null })
    expect(git('status', '--porcelain')).toBe('')
    const store = new DurableJobStore(replica)
    await ready()
    const [job] = await store.claim({ workerId: 'bounded-delay', supportedIdentities: ['storage-mutation@1'] })
    if (!job) throw new Error('Storage job missing')
    const now = new Date()
    await store.fail(job, new DurableJobDeferral(new Error('provider unavailable')), () => Infinity, now)
    const deferred = await store.get(job.id)
    expect(deferred?.nextRunAt.getTime()).toBe(now.getTime() + 1_000)
    await db('durableJobs')
      .where({ id: job.id })
      .update({ attempts: job.maxAttempts, nextRunAt: new Date(0) })
    const [capped] = await store.claim({ workerId: 'capped-busy', supportedIdentities: ['storage-mutation@1'] })
    if (!capped) throw new Error('Storage ceiling job missing')
    await store.fail(capped, new DurableJobDeferral(new Error('busy at retry ceiling'), true))
    expect(await store.get(job.id)).toMatchObject({ state: 'pending', attempts: job.maxAttempts })
    const ordinary = await store.enqueue({ type: 'ordinary-job', version: 1, payload: {}, maxAttempts: 1 })
    const [claimed] = await store.claim({ workerId: 'ordinary', supportedIdentities: ['ordinary-job@1'] })
    if (!claimed) throw new Error('Ordinary job missing')
    await store.fail(claimed, new DurableJobDeferral(new Error('not a storage mutation')))
    expect(await store.get(ordinary.id)).toMatchObject({ state: 'failed', attempts: 1 })
    const malformed = await store.enqueue({ type: 'storage-mutation', version: 1, payload: {}, maxAttempts: 1 })
    await drain()
    expect(await store.get(malformed.id)).toMatchObject({ state: 'failed', attempts: 1 })
  })
})

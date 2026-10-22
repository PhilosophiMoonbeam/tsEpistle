import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
import knexModule, { type Knex } from 'knex'
import * as Objection from 'objection'
import { BlobServiceClient, BlockBlobClient, StorageSharedKeyCredential } from '@azure/storage-blob'
import { S3Client } from '@aws-sdk/client-s3'
import SSH2Promise from 'ssh2-promise'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { DurableJobDeferral, DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as createStorageAdministration } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { up as createAssetRelocation } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import common from '../../helpers/common.ts'
import { lockSearchIndex } from '../../helpers/search-contract.ts'
import { createStorageMutationHandler, enqueuePageStorageMutation } from '../../jobs/storage-mutations.ts'
import { createStorageConfigurationStore } from '../../operations/storage-configuration.ts'
import { storageModuleDefinition } from '../../repositories/storage-configuration.ts'
import { okfFilePath } from '../../okf/format.ts'
import type StorageModel from '../../models/storage.ts'
import type { StorageConfigurationWorkspace, StorageModuleDefinition, StorageTargetDraft } from '../../../shared/storage-workspace.ts'

const connection = getPostgresTestConnection('_storage_destination_test', import.meta.path)
const suite = connection ? describe : describe.skip
const admin = { id: 1, authVersion: 0 } as never
const author = { id: 1, name: 'Storage Destination Test', email: 'destination@example.test' }
const mutationHandler = createStorageMutationHandler()
const handlers = { 'storage-mutation@1': mutationHandler, 'storage-mutation@2': mutationHandler }
const drafts = (workspace: StorageConfigurationWorkspace): StorageTargetDraft[] =>
  workspace.targets.map(target => ({
    key: target.key,
    isEnabled: target.isEnabled,
    mode: target.mode,
    syncInterval: target.syncInterval,
    config: structuredClone(target.config),
    secrets: Object.fromEntries(Object.keys(target.secrets).map(key => [key, { action: 'keep' as const }]))
  }))

suite('Canonical storage intent and reviewed destination publication on PostgreSQL', () => {
  let db: Knex, replica: Knex, Storage: typeof StorageModel
  let definitions: StorageModuleDefinition[]
  let store: ReturnType<typeof createStorageConfigurationStore>
  let directory: string, repository: string
  const originalWiki = globalThis.WIKI
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 10_000 }).trim()
  const body = async () => {
    const workspace = await store.inspect(admin)
    return { targets: drafts(workspace), fingerprint: workspace.fingerprint, reason: 'Repair target without abandoning canonical intent' }
  }
  const drain = async () => {
    await db('durableJobs')
      .where({ state: 'pending' })
      .update({ nextRunAt: new Date(0) })
    await runDurableJobBatch(replica, { workerId: 'destination-replay', handlers })
  }
  const insertPublicPage = async () => {
    await db.transaction(async transaction => {
      await lockSearchIndex(transaction, false)
      await transaction('pages').insert({
        id: 1,
        path: 'withdrawn',
        localeCode: 'en',
        content: 'Previously public canonical source',
        contentType: 'markdown',
        visibility: 'public',
        title: 'Withdrawn',
        description: '',
        sourceRevision: 1,
        authorId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        editorKey: 'markdown',
        extra: {},
        isPublished: true
      })
      await enqueuePageStorageMutation(transaction, { pageId: 1, author })
    })
    await drain()
    expect((await db('durableJobs').first()).state).toBe('succeeded')
    expect(git('show', `HEAD:${okfFilePath('en', 'withdrawn')}`)).toContain('Previously public canonical source')
  }
  const withdraw = async (kind: 'delete' | 'private', transaction?: Knex.Transaction) => {
    const run = async (tx: Knex.Transaction) => {
      await lockSearchIndex(tx, false)
      const previous = await tx('pages').where({ id: 1 }).forUpdate().first()
      if (kind === 'delete') await tx('pages').where({ id: 1 }).delete()
      else await tx('pages').where({ id: 1 }).update({ visibility: 'private', content: 'Private content must never reach storage', sourceRevision: 2 })
      await enqueuePageStorageMutation(tx, { pageId: 1, previous, author })
    }
    if (transaction) await run(transaction)
    else await db.transaction(run)
  }
  const outstanding = () => db('durableJobs').where('type', 'storage-mutation').whereIn('version', [1, 2]).whereNot({ state: 'succeeded' }).first()
  const assertWithdrawn = async () => {
    expect(await outstanding()).toBeUndefined()
    await expect(readFile(path.join(repository, okfFilePath('en', 'withdrawn')))).rejects.toThrow()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(okfFilePath('en', 'withdrawn'))
    expect(git('status', '--porcelain')).toBe('')
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    replica = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await createDurableJobs(db)
    await addLeaseToken(db)
    await db.raw(`
      CREATE TABLE settings (key text PRIMARY KEY, value jsonb, "updatedAt" text NOT NULL);
      CREATE TABLE users (id integer PRIMARY KEY, name text, email text, "isActive" boolean NOT NULL, "authVersion" integer NOT NULL);
      CREATE TABLE groups (id integer PRIMARY KEY, permissions jsonb, "adminRevision" text);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL, state jsonb);
      CREATE TABLE pages (id integer PRIMARY KEY, path text NOT NULL, "localeCode" text NOT NULL, content text NOT NULL, "contentType" text NOT NULL,
        visibility text NOT NULL, title text NOT NULL, description text NOT NULL, "sourceRevision" bigint NOT NULL, "authorId" integer NOT NULL,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL, "isPublished" boolean NOT NULL);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "assetFolders" (id integer PRIMARY KEY, slug text NOT NULL, "parentId" integer);
      CREATE TABLE assets (id integer PRIMARY KEY, hash text, filename text, "folderId" integer, "authorId" integer);
    `)
    await createStorageAdministration(db)
    await createAssetRelocation(db)
    definitions = []
    for (const key of ['git', 'disk', 'azure', 's3', 's3generic', 'digitalocean', 'sftp']) {
      const raw = yaml.load(await readFile(path.resolve('server/modules/storage', key, 'definition.yml'), 'utf8')) as Record<string, unknown> & {
        props: Parameters<typeof common.parseModuleProps>[0]
      }
      raw.props = common.parseModuleProps(raw.props)
      definitions.push(storageModuleDefinition(raw))
    }
  })
  beforeEach(async () => {
    for (const table of [
      'assetRelocationEffects',
      'assetRelocationOperations',
      'durableJobs',
      'storageOperations',
      'storage',
      'settings',
      'pageTags',
      'pages',
      'assets',
      'assetFolders',
      'userGroups',
      'groups',
      'users'
    ])
      await db(table).delete()
    await db('users').insert({ ...author, isActive: true, authVersion: 0 })
    await db('groups').insert({ id: 1, permissions: '["manage:system"]', adminRevision: 'initial' })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    for (const definition of definitions) {
      const config = Object.fromEntries(definition.fields.map(field => [field.key, field.default]))
      if (definition.key === 'git')
        Object.assign(config, {
          authType: 'basic',
          repoUrl: 'https://example.invalid/owner/canonical.git',
          branch: 'main',
          localRepoPath: 'repository',
          basicUsername: 'fixed-account',
          basicPassword: 'expired-password',
          defaultName: author.name,
          defaultEmail: author.email
        })
      await db('storage').insert({ key: definition.key, isEnabled: definition.key === 'git', mode: 'push', syncInterval: 'P0D', config, state: {} })
    }
    directory = await mkdtemp(path.join(tmpdir(), 'wiki-storage-destination-'))
    repository = path.join(directory, 'repository')
    await mkdir(repository)
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', author.name)
    git('config', 'user.email', author.email)
    const wiki = {
      ROOTPATH: directory,
      SERVERPATH: path.resolve(import.meta.dir, '../..'),
      config: { db: { type: 'postgres' }, dataPath: 'data', lang: { code: 'en', namespacing: false }, uploads: { maxFileSize: 1_048_576 } },
      data: { storage: definitions.map(({ key, isAvailable }) => ({ key, isAvailable, schedule: false, internalSchedule: false })), reservedPaths: [] },
      logger: console,
      scheduler: {
        jobs: [],
        registerJob() {
          throw new Error('No scheduled execution belongs in this replay fixture')
        }
      },
      models: { knex: db, Objection, storage: {} as unknown }
    }
    if (Storage) Object.assign(globalThis.WIKI, wiki)
    else globalThis.WIKI = wiki as never
    // Native models capture WIKI at load time; this test exercises that runtime-loading boundary.
    Storage = (await import('../../models/storage.ts')).default
    Storage.knex(db)
    wiki.models.storage = Storage
    Storage.activeTargets = []
    Storage.targets = []
    store = createStorageConfigurationStore({ db, reviewKey: 'destination-review-test-key', definitions: () => definitions })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const target of Storage.activeTargets) {
      const deactivate = target.fn.deactivated
      if (typeof deactivate === 'function') await deactivate.call(target.fn)
    }
    Storage.activeTargets = []
    Storage.targets = []
    await rm(directory, { recursive: true, force: true })
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki
    await Promise.all([db?.destroy(), replica?.destroy()])
  })

  for (const kind of ['delete', 'private'] as const) {
    it(`replays admitted ${kind} intent after reviewed password and schedule repair without changing its captured payload`, async () => {
      await insertPublicPage()
      await withdraw(kind)
      const captured = await outstanding()
      const input = await body(),
        gitDraft = input.targets.find(target => target.key === 'git')!
      gitDraft.syncInterval = 'PT10M'
      gitDraft.secrets.basicPassword = { action: 'replace', value: 'repaired-password' }
      await store.save(admin, input)
      expect((await outstanding()).payload).toBe(captured.payload)
      // Use actual native provider restart to consume the repaired persisted configuration.
      await Storage.initTargets()
      expect(Storage.activeTargets[0]?.fn.config.basicPassword).toBe('repaired-password')
      expect(git('remote', 'get-url', 'origin')).toBe('https://fixed-account:repaired-password@example.invalid/owner/canonical.git')
      await drain()
      await assertWithdrawn()
      const completed = await db('durableJobs').where({ id: captured.id }).first()
      expect(completed.payload).toBe(captured.payload)
      expect(JSON.stringify((await store.inspect(admin)).history)).not.toContain('repaired-password')
      if (kind === 'private') expect((await db('pages').where({ id: 1 }).first()).content).toBe('Private content must never reach storage')
      else expect(await db('pages')).toHaveLength(0)
    })
  }

  for (const change of ['disable', 'repoUrl', 'branch', 'localRepoPath', 'mode', 'alwaysNamespace'] as const) {
    it(`atomically refuses ${change} while privacy withdrawal is outstanding, then drains the original destination`, async () => {
      await insertPublicPage()
      await withdraw('private')
      const captured = await outstanding(),
        before = await db('storage').orderBy('key'),
        input = await body()
      input.targets.find(target => target.key === 'disk')!.config.path = '/must-roll-back-with-git-change'
      const target = input.targets.find(target => target.key === 'git')!
      if (change === 'disable') target.isEnabled = false
      else if (change === 'mode') target.mode = 'pull'
      else if (change === 'alwaysNamespace') target.config.alwaysNamespace = true
      else
        target.config[change] =
          change === 'branch' ? 'other-branch' : change === 'localRepoPath' ? 'other-repository' : 'https://other.invalid/other/account.git'
      await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
      expect(await db('storage').orderBy('key')).toEqual(before)
      expect((await store.inspect(admin)).history).toHaveLength(0)
      expect(await outstanding()).toEqual(captured)
      await drain()
      await assertWithdrawn()
      await expect(readFile(path.join(directory, 'other-repository', okfFilePath('en', 'withdrawn')))).rejects.toThrow()
    })
  }

  it('retains running intent during repairs and refuses retarget even when its worker has not acquired the Git turn', async () => {
    await insertPublicPage()
    await withdraw('delete')
    const jobs = new DurableJobStore(replica),
      [claimed] = await jobs.claim({ workerId: 'claimed-before-publication', supportedIdentities: Object.keys(handlers) })
    if (!claimed) throw new Error('Missing admitted withdrawal')
    const before = await db('durableJobs').where({ id: claimed.id }).first()
    let input = await body()
    input.targets.find(target => target.key === 'git')!.config.repoUrl = 'https://other.invalid/other.git'
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    input = await body()
    input.targets.find(target => target.key === 'git')!.secrets.basicPassword = { action: 'replace', value: 'running-repair' }
    await store.save(admin, input)
    expect(await db('durableJobs').where({ id: claimed.id }).first()).toEqual(before)
    await jobs.fail(claimed, new DurableJobDeferral(new Error('Worker voluntarily releases its retained lease'), true))
    await Storage.initTargets()
    await drain()
    await assertWithdrawn()
  })

  it('serializes publication behind uncommitted canonical admission before inspecting outstanding work', async () => {
    await insertPublicPage()
    const input = await body()
    input.targets.find(target => target.key === 'git')!.config.branch = 'retarget-after-admission'
    const admission = await db.transaction(),
      publication = await replica.transaction()
    try {
      await withdraw('delete', admission)
      await publication.raw("SET LOCAL lock_timeout = '150ms'")
      // Admission must retain a SHARE lock on its captured target until the canonical commit.
      await expect(store.save(admin, input, publication)).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await publication.rollback()
      await admission.commit()
    }
    const captured = await outstanding()
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    expect((await outstanding()).payload).toBe(captured.payload)
    await drain()
    await assertWithdrawn()
  })

  it('does not let admission read through an uncommitted physical publication and capture its former destination', async () => {
    await insertPublicPage()
    const input = await body()
    input.targets.find(target => target.key === 'git')!.config.branch = 'new-reviewed-branch'
    const publication = await db.transaction(),
      admission = await replica.transaction()
    try {
      await store.save(admin, input, publication)
      await admission.raw("SET LOCAL lock_timeout = '150ms'")
      await expect(withdraw('delete', admission)).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await admission.rollback()
      await publication.rollback()
    }
    expect((await db('pages').where({ id: 1 }).first()).visibility).toBe('public')
    expect(await outstanding()).toBeUndefined()
  })

  it('refuses an Azure account retarget even when it is packaged as credential repair', async () => {
    await insertPublicPage()
    const azure = await db('storage').where({ key: 'azure' }).first()
    await db('storage')
      .where({ key: 'azure' })
      .update({
        isEnabled: true,
        config: { ...azure.config, accountName: 'canonical-account', accountKey: 'original-account-key', containerName: 'canonical-container' }
      })
    await withdraw('private')
    const captured = await db('durableJobs').where({ state: 'pending' }).orderBy('id')
    const before = await db('storage').where({ key: 'azure' }).first(),
      input = await body()
    input.targets.find(target => target.key === 'azure')!.secrets.accountKey = { action: 'replace', value: 'unreviewed-account-key' }
    input.targets.find(target => target.key === 'azure')!.config.accountName = 'different-account'
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    expect(await db('storage').where({ key: 'azure' }).first()).toEqual(before)
    expect(await db('durableJobs').where({ state: 'pending' }).orderBy('id')).toEqual(captured)
    expect(captured).toHaveLength(2)
  })

  for (const key of ['azure', 's3', 's3generic', 'digitalocean', 'sftp'] as const) {
    it(`authorizes retained withdrawal through the actual ${key} provider after same-destination credential repair`, async () => {
      await insertPublicPage()
      const saved = await db('storage').where({ key }).first()
      const config = { ...saved.config }
      if (key !== 'sftp') config.pathPrefix = 'canonical-prefix'
      if (key === 'azure')
        Object.assign(config, {
          accountName: 'canonical-account',
          containerName: 'canonical-container',
          accountKey: Buffer.from('expired-fixture-key').toString('base64')
        })
      else if (key === 'sftp')
        Object.assign(config, {
          host: 'sftp.example.invalid',
          port: 22,
          username: 'fixed-account',
          basePath: '/canonical',
          authMode: 'password',
          hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43),
          password: 'expired-fixture-password'
        })
      else {
        Object.assign(config, { region: 'us-east-1', bucket: 'canonical-bucket', accessKeyId: 'fixed-fixture-account', secretAccessKey: 'expired-fixture-key' })
        if (key !== 's3') config.endpoint = 'https://s3.example.invalid'
      }
      await db('storage').where({ key }).update({ isEnabled: true, config })
      await withdraw('private')
      const captured = await db('durableJobs').where({ state: 'pending' }).whereRaw("payload::jsonb ->> 'targetKey' = ?", [key]).first()
      const input = await body(),
        draft = input.targets.find(target => target.key === key)!
      const secret = key === 'azure' ? 'accountKey' : key === 'sftp' ? 'password' : 'secretAccessKey'
      const repaired = key === 'azure' ? Buffer.from('repaired-fixture-key').toString('base64') : 'repaired-fixture-secret'
      draft.secrets[secret] = { action: 'replace', value: repaired }
      if (key === 's3') draft.config.accessKeyId = 'repaired-fixture-access-id'
      await store.save(admin, input)
      expect((await db('durableJobs').where({ id: captured.id }).first()).payload).toBe(captured.payload)

      const target = await Storage.query().findById(key)
      if (!target) throw new Error('Missing configured remote target')
      // Registry-selected native providers capture the installed WIKI fixture.
      const plugin = (await import(`../../modules/storage/${key}/storage.ts`)).default
      const fn = Object.assign(Object.create(Object.getPrototypeOf(plugin)), plugin, { config: target.config, mode: target.mode })
      const boundary = new Error('Native transport boundary reached; no provider request is permitted')
      const relativePath = okfFilePath('en', 'withdrawn')
      let assertDestination: () => void
      if (key === 'azure') {
        const service = new BlobServiceClient(
          `https://${target.config.accountName}.blob.core.windows.net`,
          new StorageSharedKeyCredential(String(target.config.accountName), String(target.config.accountKey))
        )
        fn.client = service
        fn.container = service.getContainerClient(String(target.config.containerName))
        const paths = vi.spyOn(fn.container, 'getBlockBlobClient')
        const transport = vi.spyOn(BlockBlobClient.prototype, 'delete').mockRejectedValue(boundary)
        assertDestination = () => {
          expect(paths).toHaveBeenCalledWith('canonical-prefix/' + relativePath)
          expect(transport).toHaveBeenCalledTimes(1)
          expect(fn.container.url).toBe('https://canonical-account.blob.core.windows.net/canonical-container')
        }
      } else if (key === 'sftp') {
        fn.client = new SSH2Promise(
          {
            host: String(target.config.host),
            port: Number(target.config.port),
            username: String(target.config.username),
            password: String(target.config.password)
          },
          true
        )
        fn.sftp = fn.client.sftp()
        const transport = vi.spyOn(fn.sftp, 'unlink').mockRejectedValue(boundary)
        assertDestination = () => expect(transport).toHaveBeenCalledWith('/canonical/' + relativePath)
      } else {
        fn.bucketName = target.config.bucket
        fn.s3 = new S3Client({
          region: String(target.config.region),
          endpoint: typeof target.config.endpoint === 'string' ? target.config.endpoint : undefined,
          credentials: { accessKeyId: String(target.config.accessKeyId), secretAccessKey: String(target.config.secretAccessKey) }
        })
        const transport = vi.spyOn(fn.s3, 'send').mockRejectedValue(boundary)
        assertDestination = () => {
          expect(transport).toHaveBeenCalledTimes(1)
          expect(transport.mock.calls[0]?.[0]).toMatchObject({ input: { Bucket: 'canonical-bucket', Key: 'canonical-prefix/' + relativePath } })
        }
      }
      Object.assign(target, { fn, runtimeGeneration: 'credential-repair-boundary' })
      Storage.targets.push(target)
      Storage.activeTargets.push(target)
      await drain()
      assertDestination()
      const retained = await db('durableJobs').where({ id: captured.id }).first()
      expect(retained).toMatchObject({ state: 'pending', payload: captured.payload, completedAt: null })
      expect(retained.lastError).toContain(boundary.message)
      expect((await db('storage').where({ key }).first()).config[secret]).toBe(repaired)
      expect((await db('pages').where({ id: 1 }).first()).visibility).toBe('private')
      expect(JSON.stringify((await store.inspect(admin)).history)).not.toContain(repaired)
    })
  }

  for (const change of ['enable', 'namespace'] as const) {
    it(`refuses ${change} publication over an existing canonical page/asset collision without consulting a provider`, async () => {
      const saved = await db('storage').where({ key: 'git' }).first()
      await db('storage')
        .where({ key: 'git' })
        .update({ isEnabled: change !== 'enable', config: { ...saved.config, alwaysNamespace: change === 'namespace' } })
      // These canonical records can coexist while their current physical paths differ
      // or no target is enabled. The proposed target would collapse them onto one path.
      await db('pages').insert({
        id: 1,
        path: 'publication-collision',
        localeCode: 'en',
        content: 'Canonical source must remain unchanged',
        contentType: 'asciidoc',
        visibility: 'public',
        title: 'Private administrative detail',
        description: '',
        sourceRevision: 1,
        authorId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        editorKey: 'asciidoc',
        extra: {},
        isPublished: true
      })
      await db('assets').insert({ id: 9, filename: 'publication-collision.adoc', folderId: null, authorId: 1, hash: 'fixture-asset-identity' })
      const before = await db('storage').orderBy('key'),
        page = await db('pages').first(),
        asset = await db('assets').first()
      const input = await body(),
        target = input.targets.find(row => row.key === 'git')!
      target.isEnabled = true
      target.config.alwaysNamespace = false
      await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409, code: 'STORAGE_PATH_COLLISION' })
      expect(await db('storage').orderBy('key')).toEqual(before)
      expect(await db('pages').first()).toEqual(page)
      expect(await db('assets').first()).toEqual(asset)
      expect(await db('durableJobs')).toHaveLength(0)
      expect((await store.inspect(admin)).history).toHaveLength(0)
      expect(git('rev-list', '--all')).toBe('')
    })
  }

  it('requires authoritative administration for a repair and cannot remove an outstanding target from the reviewed inventory', async () => {
    await insertPublicPage()
    await withdraw('private')
    const captured = await outstanding(),
      input = await body()
    input.targets.find(target => target.key === 'git')!.secrets.basicPassword = { action: 'replace', value: 'unauthorized-repair' }
    await db('groups').where({ id: 1 }).update({ permissions: '[]' })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 403 })
    await db('groups').where({ id: 1 }).update({ permissions: '["manage:system"]' })
    const removal = await body()
    removal.targets = removal.targets.filter(target => target.key !== 'git')
    await expect(store.save(admin, removal)).rejects.toMatchObject({ status: 400 })
    expect(await outstanding()).toEqual(captured)
    expect((await db('storage').where({ key: 'git' }).first()).isEnabled).toBe(true)
    await drain()
    await assertWithdrawn()
  })
})

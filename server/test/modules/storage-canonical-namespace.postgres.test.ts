import knexModule from 'knex'
import type { Knex } from 'knex'
import * as Objection from 'objection'
import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import commonDisk, { collectStorageEntries } from '../../modules/storage/disk/common.ts'
import { openStorageRoot, type StorageRootHandle } from '../../modules/storage/local-filesystem.ts'
import { buildStorageImportPreview, withStorageImportReview, type StorageImportScope } from '../../modules/storage/import-identity.ts'
import { collectGitContentEntries, gitRetainedContentRef, inspectGitPreviousContent, serializeGitContentChoices } from '../../modules/storage/git/content-visibility.ts'
import type { StorageGitContentChoice, StorageImportReview, StorageImportPreview } from '../../../shared/utility-content-import.ts'
import type GitStorageProvider from '../../modules/storage/git/storage.ts'
import { currentGitMutationTurn, withGitMutationLock } from '../../modules/storage/git/mutation-lock.ts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as installPageRevisionTrigger } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as addRevisionReasons } from '../../db/migrations/tsepistle-000069-page-history-reasons.ts'
import { up as addAccountAdministration } from '../../db/migrations/tsepistle-000017-account-administration.ts'
import { up as addGroupAdministration } from '../../db/migrations/tsepistle-000018-group-administration.ts'
import { up as addPageReviewRouting } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as addPageLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as createStoragePageImportOwners } from '../../db/migrations/tsepistle-000077-storage-page-import-owners.ts'
import { requireSystemAuthority } from '../../helpers/system-authority.ts'
import { loadStoragePageImportOwners, recordStoragePageImportOwner, storagePageImportOwnerMatches } from '../../helpers/storage-page-import-owner.ts'
import { withOkfProducer } from '../../okf/mutation-context.ts'
import { createAccountAdministrationStore } from '../../operations/account-administration.ts'
import { createStorageMutationHandler, enqueuePageStorageMutation } from '../../jobs/storage-mutations.ts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { lockSearchIndex } from '../../helpers/search-contract.ts'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageHelper from '../../helpers/page.ts'
import pageErrors from '../../helpers/error.ts'
import { retainPageConversionReview } from '../../helpers/page-conversion-review.ts'
import { OKF_MAX_DOCUMENT_BYTES, okfFilePath, parseOkfDocument } from '../../okf/format.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput, type StoragePageIngestionOptions } from '../../modules/storage/page-document.ts'
import type PageModel from '../../models/pages.ts'
import type StorageModel from '../../models/storage.ts'
import type AssetModel from '../../models/assets.ts'
import type PageHistoryModel from '../../models/pageHistory.ts'
import type AssetFolderModel from '../../models/assetFolders.ts'
import type pageOperations from '../../operations/pages.ts'
import type { OkfMetadata } from '../../okf/format.ts'

const connection = getPostgresTestConnection('_canonical_namespace_test', import.meta.path)
const suite = connection ? describe : describe.skip
const author = { id: 1, authVersion: 0, name: 'Page Administrator', email: 'pages@example.test', permissions: ['manage:system'] }
const assetWriter = { id: 7, name: 'Asset Writer', email: 'assets@example.test', permissions: ['write:assets'] }
const departingAuthor = { id: 9, name: 'Departing Author', email: 'departing@example.test', permissions: ['read:pages', 'write:pages'] }
const protectedTitle = 'Restricted owner title must not be disclosed'
const protectedContent = '<p>Restricted owner source must not be disclosed</p>'
const verifier = '$argon2id$restricted-page-verifier'
const tables = [
  ['pages', 'id'],
  ['storagePageImportOwners', 'pageId'],
  ['assets', 'id'],
  ['assetData', 'id'],
  ['durableJobs', 'id'],
  ['pageHistory', 'id'],
  ['pageHistoryTags', 'pageId'],
  ['pageMutationOutbox', 'id'],
  ['outboxEvents', 'id'],
  ['pageTags', 'pageId'],
  ['pageAccessPasswords', 'pageId'],
  ['pageUnlockGrants', 'id'],
  ['deletedPageRecovery', 'pageId'],
  ['assetRelocationEffects', 'id'],
  ['userAdministrationEvents', 'id'],
  ['userKeys', 'id'],
  ['pageLifecycleClocks', 'pageId'],
  ['pageReviewRouting', 'pageId'],
  ['comments', 'id']
] as const

suite('PostgreSQL canonical page and asset physical namespace admission', () => {
  let db: Knex
  let observer: Knex
  let Page: typeof PageModel
  let Storage: typeof StorageModel
  let Asset: typeof AssetModel
  let History: typeof PageHistoryModel
  let Folder: typeof AssetFolderModel
  let operations: typeof pageOperations
  let directory: string
  let sourceOrdinal = 0
  const originalWiki = globalThis.WIKI
  const lang = { code: 'en', namespacing: false }

  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async ([table, key]) => [table, await db(table).orderBy(key)])))
  const ownerFor = async (pageId: number) => {
    const owners = await loadStoragePageImportOwners(db, { pageIds: [pageId], limit: 1 })
    expect(owners).toHaveLength(1)
    return owners[0]!
  }
  const expectAcceptedOwner = async (pageId: number, eventType: string) => {
    const owner = await ownerFor(pageId)
    const page = await db('pages').where({ id: pageId }).first('*')
    expect(storagePageImportOwnerMatches(owner, page)).toBe(true)
    const event = await db('outboxEvents').where({ id: owner.operationId }).first('*')
    expect(event).toMatchObject({ type: eventType, aggregateType: 'page', aggregateId: String(pageId) })
    expect(JSON.parse(event.payload)).toMatchObject({ pageId, path: owner.nativePath, localeCode: owner.nativeLocaleCode })
    return owner
  }
  const target = async (key = 'git', alwaysNamespace = false) => {
    await db('storage').delete()
    await db('storage').insert({ key, isEnabled: true, mode: 'push', syncInterval: 'P0D', config: { alwaysNamespace } })
  }
  const seedPage = async (
    id: number,
    pagePath = 'guide',
    options: {
      locale?: string
      contentType?: string
      visibility?: 'public' | 'private'
      published?: boolean
    } = {}
  ) => {
    const visibility = options.visibility ?? 'public'
    const contentType = options.contentType ?? 'html'
    await db('pages').insert({
      id,
      path: pagePath,
      localeCode: options.locale ?? 'en',
      contentType,
      editorKey: contentType,
      hash: pageHelper.generateHash({ path: pagePath, locale: options.locale ?? 'en', visibility, ownerId: visibility === 'private' ? author.id : null }),
      visibility,
      ownerId: visibility === 'private' ? author.id : null,
      title: protectedTitle,
      description: '',
      content: protectedContent,
      render: '<p>Rendered conversion source</p>',
      extra: {},
      sourceRevision: 1,
      isPublished: options.published ?? true,
      authorId: author.id,
      creatorId: author.id
    })
  }
  const createPage = (pagePath = 'guide', options: { locale?: string; visibility?: 'public' | 'private'; skipStorage?: boolean } = {}) =>
    Page.createPage({
      path: pagePath,
      locale: options.locale ?? 'en',
      user: author,
      content: '<p>New canonical page</p>',
      editor: 'html',
      description: '',
      visibility: options.visibility ?? 'public',
      isPublished: true,
      title: 'New page',
      skipStorage: options.skipStorage ?? false
    })
  const prepareUpload = async (assetPath: string, skipStorage = false, contents?: Buffer) => {
    const segments = assetPath.split('/')
    const filename = segments.pop()!
    let folderId: number | null = null
    for (const slug of segments) {
      const existing = await db('assetFolders').where({ slug, parentId: folderId }).first('id')
      folderId = existing ? Number(existing.id) : (await Folder.query().insert({ name: slug, slug, parentId: folderId })).id
    }
    const source = path.join(directory, 'data', 'uploads', `source-${++sourceOrdinal}`)
    const bytes = contents ?? Buffer.from('Unprivileged canonical asset bytes')
    await writeFile(source, bytes)
    return {
      source,
      bytes,
      run: () =>
        Asset.upload({
          originalname: filename,
          assetPath,
          mimetype: 'application/octet-stream',
          size: bytes.length,
          folderId,
          path: source,
          mode: skipStorage ? 'import' : 'upload',
          user: assetWriter,
          skipStorage
        })
    }
  }
  const assertConflict = async (work: Promise<unknown>) => {
    const result = await work.then(
      () => ({ admitted: true }),
      error => error
    )
    expect(result).toMatchObject({ status: 409 })
    expect(result).toBeInstanceOf(Error)
    const disclosure = `${result instanceof Error ? result.message : ''} ${JSON.stringify(result)}`
    for (const secret of [protectedTitle, protectedContent, verifier, author.email]) expect(disclosure).not.toContain(secret)
  }

  const withImportSource = async (files: Record<string, string>, work: (root: StorageRootHandle, source: string) => Promise<void>) => {
    const source = path.join(directory, 'import-source')
    await mkdir(source, { recursive: true })
    for (const [relativePath, bytes] of Object.entries(files)) {
      const filename = path.join(source, relativePath)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, bytes)
    }
    const root = await openStorageRoot(source)
    try {
      await work(root, source)
    } finally {
      await root.close()
      commonDisk.clearFolderCache()
    }
  }

  const expectImportSucceeded = (result: unknown): void => {
    if (!Array.isArray(result)) throw new Error('Native Git import did not return per-source results')
    expect(result.every(item => item.ok === true)).toBe(true)
  }

  // The observer session owns real Git serialization; pool-one assertions below
  // bound the canonical writer, not the total connections of the public provider.
  const importGitFromDisk = (root: StorageRootHandle, ingestion: StoragePageIngestionOptions) =>
    withGitMutationLock(observer, 'git', () => commonDisk.importFromDisk({ root, moduleName: 'GIT', ingestion }))

  const withGitContentSource = async (files: Record<string, string>, work: (fixture: {
    root: StorageRootHandle
    source: string
    writer: string
    plugin: typeof GitStorageProvider
    context: Record<string, unknown>
    config: { branch: string; repoUrl: string; localRepoPath: string; dotContentReview?: string }
    git: (cwd: string, ...args: string[]) => string
    preview: () => Promise<StorageImportPreview>
  }) => Promise<void>) => withImportSource(files, async (root, source) => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim()
    const remote = path.join(directory, 'visibility-remote.git')
    const writer = path.join(directory, 'visibility-writer')
    git(source, 'init', '--quiet', '--initial-branch=main')
    git(source, 'config', 'user.name', author.name)
    git(source, 'config', 'user.email', author.email)
    git(source, 'config', 'commit.gpgSign', 'false')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'Initial content visibility sources')
    git(directory, 'clone', '--bare', '--quiet', source, remote)
    git(source, 'remote', 'add', 'origin', remote)
    git(directory, 'clone', '--quiet', remote, writer)
    git(writer, 'config', 'user.name', author.name)
    git(writer, 'config', 'user.email', author.email)
    git(writer, 'config', 'commit.gpgSign', 'false')
    git(writer, 'config', 'push.gpgSign', 'false')
    const config = { branch: 'main', repoUrl: remote, localRepoPath: source }
    // Native storage captures the disposable installed WIKI runtime on load.
    const plugin = (await import('../../modules/storage/git/storage.ts')).default
    const context = { ...plugin, root, repoPath: source, git: true, mode: 'pull', targetKey: 'git', config }
    const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'git', configurationRevision: 'native-dot-content-review' }
    const preview = async () => {
      const admission = await collectGitContentEntries(root, 1_048_576)
      await inspectGitPreviousContent(admission, config)
      return buildStorageImportPreview(admission, config, 'GIT', scope)
    }
    await work({ root, source, writer, plugin, context, config, git, preview })
  })

  const activateExportTarget = async (key: 'disk' | 'git', root: StorageRootHandle, source: string, config: Record<string, unknown>) => {
    await target(key)
    await db('storage').where({ key }).update({ config })
    // Providers capture WIKI when loaded, so static imports cannot bind this disposable native runtime.
    const plugin = key === 'git'
      ? (await import('../../modules/storage/git/storage.ts')).default
      : (await import('../../modules/storage/disk/storage.ts')).default
    const configured = await Storage.query().findById(key)
    if (!configured) throw new Error('Missing native export target')
    Object.assign(configured, {
      fn: { ...plugin, root, repoPath: source, git: true, targetKey: key, config, mode: 'push' }
    })
    Storage.targets = [configured]
    Storage.activeTargets = [configured]
  }

  const exportHandler = createStorageMutationHandler()
  const exportHandlers = { 'storage-mutation@1': exportHandler, 'storage-mutation@2': exportHandler }
  const drainExports = async (worker = observer) => {
    await db('durableJobs').where({ type: 'storage-mutation', state: 'pending' }).update({ nextRunAt: new Date(0) })
    await runDurableJobBatch(worker, { workerId: 'native-export-ack', limit: 100, handlers: exportHandlers })
  }

  const pendingExport = async (pageId: number) => {
    const jobs = await db('durableJobs').where({ type: 'storage-mutation', state: 'pending' })
    const matching = jobs.filter(job => JSON.parse(job.payload).entityId === pageId)
    expect(matching).toHaveLength(1)
    const job = matching[0]!
    const payload = JSON.parse(job.payload)
    const page = await db('pages').where({ id: pageId }).first('sourceRevision')
    const event = await db('outboxEvents').where({ id: payload.sourceOutboxId }).first('*')
    expect(job.version).toBe(2)
    expect(payload).toMatchObject({ entityType: 'page', entityId: pageId, sourceRevision: String(page.sourceRevision) })
    expect(event).toMatchObject({ id: payload.sourceOutboxId, type: 'page.updated', aggregateType: 'page', aggregateId: String(pageId) })
    expect(JSON.parse(event.payload)).toMatchObject({ pageId })
    return { job, payload, event }
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    observer = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await createDurableJobs(db)
    await addLeaseToken(db)
    await db.raw(`
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL, state jsonb);
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false,
        "providerKey" text NOT NULL DEFAULT 'local', "isVerified" boolean NOT NULL DEFAULT true, "tfaIsActive" boolean NOT NULL DEFAULT false,
        "tfaSecret" text, "mustChangePwd" boolean NOT NULL DEFAULT false, location text NOT NULL DEFAULT '', "jobTitle" text NOT NULL DEFAULT '', timezone text NOT NULL DEFAULT 'UTC',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL DEFAULT '[]', "isSystem" boolean NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, "groupId" integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE);
      CREATE TABLE authentication (key text PRIMARY KEY, "displayName" text NOT NULL, "strategyKey" text NOT NULL, "isEnabled" boolean NOT NULL, "order" integer NOT NULL);
      CREATE TABLE "userKeys" (id serial PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id));
      CREATE TABLE locales (code text PRIMARY KEY);
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
      CREATE TABLE comments (
        id serial PRIMARY KEY, "authorId" integer NOT NULL REFERENCES users(id), "pageId" integer REFERENCES pages(id),
        content text NOT NULL, render text NOT NULL DEFAULT '', "replyTo" integer NOT NULL DEFAULT 0,
        name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', ip text NOT NULL DEFAULT '',
        "isHidden" boolean NOT NULL DEFAULT false, "moderationRevision" text NOT NULL DEFAULT '',
        "moderatedBy" integer, "moderatedAt" timestamptz, "moderationReason" text NOT NULL DEFAULT '',
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
      CREATE TABLE "deletedPageRecovery" ("pageId" integer NOT NULL, "deletionVersionId" integer NOT NULL, "deletionRevision" bigint NOT NULL,
        "securityContext" text, "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("pageId", "deletionVersionId"));
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL, "effectKind" text NOT NULL, "effectKey" text NOT NULL,
        "desiredState" text NOT NULL, "payloadSha256" text NOT NULL, payload text NOT NULL, status text NOT NULL, attempts integer NOT NULL,
        "availableAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
      CREATE TABLE "outboxEvents" (id uuid PRIMARY KEY, type text NOT NULL, version integer NOT NULL, "aggregateType" text NOT NULL,
        "aggregateId" text NOT NULL, payload text NOT NULL, "createdAt" timestamptz NOT NULL, "publishedAt" timestamptz);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, "passwordHash" text NOT NULL, version integer NOT NULL,
        "updatedBy" integer NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer NOT NULL, "sessionId" text NOT NULL, "userId" integer NOT NULL,
        "passwordVersion" integer NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE "pageApprovalRequests" (id serial PRIMARY KEY, "pageId" integer, status text);
      CREATE TABLE "assetFolders" (id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL, "parentId" integer);
      CREATE TABLE assets (id serial PRIMARY KEY, hash text NOT NULL UNIQUE, filename text NOT NULL, "folderId" integer, "authorId" integer NOT NULL,
        ext text NOT NULL, kind text NOT NULL, mime text NOT NULL, "fileSize" integer NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "assetData" (id integer PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, data bytea NOT NULL);
      CREATE TABLE "assetRelocationEffects" (id serial PRIMARY KEY, "assetId" integer, status text, "sourcePath" text, "destinationPath" text);
    `)
    await installPageRevisionTrigger(db)
    await addRevisionReasons(db)
    await addAccountAdministration(db)
    await addGroupAdministration(db)
    await addPageReviewRouting(db)
    await addPageLifecycle(db)
    await createStoragePageImportOwners(db)
    await db('users').insert([author, assetWriter].map(({ id, name, email }) => ({ id, name, email })))
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']), pageRules: '[]', isSystem: true },
      { id: 7, name: 'Asset Writers', permissions: JSON.stringify(assetWriter.permissions),
        pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['write:assets'], locales: [] }]), isSystem: false },
      { id: 9, name: 'Departing Writers', permissions: JSON.stringify(departingAuthor.permissions),
        pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: departingAuthor.permissions, locales: [] }]), isSystem: false }
    ])
    await db('userGroups').insert([{ userId: author.id, groupId: 1 }, { userId: assetWriter.id, groupId: 7 }])
    await db('authentication').insert({ key: 'local', displayName: 'Local', strategyKey: 'local', isEnabled: true, order: 0 })
    await db('locales').insert([{ code: 'en' }, { code: 'fr' }])
    const wiki = {
      ROOTPATH: '',
      SERVERPATH: path.resolve(import.meta.dir, '../..'),
      config: { db: { type: 'postgres' }, dataPath: 'data', lang, uploads: { maxFileSize: 1_048_576, scanSVG: false, forceDownload: false } },
      configSvc: {},
      lang: {},
      startedAt: {},
      data: {
        storage: ['git', 'disk'].map(key => ({ key, isAvailable: true, schedule: false, internalSchedule: false })),
        reservedPaths: [],
        editors: [...['html', 'markdown', 'asciidoc', 'text', 'json'].map(contentType => ({ key: contentType, contentType })), { key: 'visual-markdown', contentType: 'markdown' }]
      },
      logger: console,
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      Error: pageErrors,
      auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority },
      // The scheduler adapter acknowledges only the unrelated post-commit tree refresh.
      // Canonical writes, locks, authorization, history, projections and durable admission below are all native.
      scheduler: {
        registerJob: async (definition: { name: string }) => {
          if (definition.name !== 'rebuild-tree') throw new Error(`Unexpected native namespace fixture job: ${definition.name}`)
          return { finished: Promise.resolve() }
        }
      },
      models: { knex: db, Objection, pages: {} as unknown, assets: {} as unknown, assetFolders: {} as unknown, tags: {} as unknown, pageHistory: {} as unknown }
    }
    globalThis.WIKI = wiki as never
    // Native models capture WIKI during evaluation; static imports cannot bind this disposable runtime.
    Page = (await import('../../models/pages.ts')).default
    Asset = (await import('../../models/assets.ts')).default
    History = (await import('../../models/pageHistory.ts')).default
    Folder = (await import('../../models/assetFolders.ts')).default
    const Tag = (await import('../../models/tags.ts')).default
    const User = (await import('../../models/users.ts')).default
    const Comment = (await import('../../models/comments.ts')).default
    Storage = (await import('../../models/storage.ts')).default
    for (const model of [Page, Asset, History, Folder, Tag, User, Comment, Storage]) model.knex(db)
    Object.assign(wiki.models, { pages: Page, assets: Asset, assetFolders: Folder, tags: Tag, pageHistory: History, users: User, comments: Comment, storage: Storage })
    Object.assign(wiki.models, {
      editors: { getDefaultEditor: async (contentType: string) => contentType }
    })
    // Operations import Page at evaluation time; load after the disposable runtime
    // without evicting the shared import-review AsyncLocalStorage or native models.
    operations = (await import('../../operations/pages.ts')).default
  })
  beforeEach(async () => {
    for (const [table] of [...tables].reverse()) await db(table).delete()
    await db('groups').where({ id: 1 }).update({ permissions: JSON.stringify(['manage:system']) })
    await db('users').where({ id: author.id }).update({ isActive: true, authVersion: author.authVersion })
    await db.raw('ALTER SEQUENCE pages_id_seq RESTART WITH 1')
    await db('assetFolders').delete()
    await db('pageLinks').delete()
    await db('pageTree').delete()
    lang.namespacing = false
    sourceOrdinal = 0
    directory = await mkdtemp(path.join(tmpdir(), 'wiki-canonical-namespace-'))
    await mkdir(path.join(directory, 'data', 'uploads'), { recursive: true })
    globalThis.WIKI.ROOTPATH = directory
    await target()
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    Storage.targets = []
    Storage.activeTargets = []
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki
    await Promise.all([db?.destroy(), observer?.destroy()])
  })

  for (const key of ['disk', 'git'] as const) {
    it.each(['body', 'title'] as const)(`accepts the next real ${key} import after a same-path native %s edit is durably exported`, async field => {
      const sourcePath = 'en/roundtrip.md'
      const body = 'Initially imported canonical source.\n'
      const exercise = async (root: StorageRootHandle, source: string, config: StoragePageIngestionOptions) => {
        const importing = () => key === 'git'
          ? importGitFromDisk(root, config)
          : commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion: config })
        if (field === 'title') {
          const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: key, configurationRevision: 'native-export-mapped' }
          const preview = await buildStorageImportPreview(await collectStorageEntries(root), config, key === 'git' ? 'GIT' : 'DISK', scope)
          const review: StorageImportReview = { scope, snapshot: preview.snapshot, mappings: [{
            sourcePath, sourceSha256: createHash('sha256').update(body).digest('hex'),
            locale: 'en', path: 'roundtrip', existingPageId: null, expectedSourceRevision: null
          }] }
          expectImportSucceeded(await withStorageImportReview(review, async () => {}, importing))
        } else expectImportSucceeded(await importing())
        const imported = await db('pages').where({ path: 'roundtrip' }).first('*')
        const accepted = await expectAcceptedOwner(imported.id, 'page.created')
        await activateExportTarget(key, root, source, config)
        await Page.updatePage({
          id: imported.id, user: author, expectedSourceRevision: String(imported.sourceRevision),
          ...(field === 'body' ? { content: 'Native body published through the real provider.\n' } : { title: 'Native TITLE-only publication' })
        })
        const current = await db('pages').where({ id: imported.id }).first('*')
        expect(await ownerFor(imported.id)).toEqual(accepted)
        expect(storagePageImportOwnerMatches(accepted, current)).toBe(false)
        const { job, payload } = await pendingExport(imported.id)
        expect(payload.sourceOutboxId).not.toBe(accepted.operationId)
        // Retention of the actual immutable intent, not liveness of its root row, authorizes replay.
        if (key === 'git' && field === 'title') {
          await db('outboxEvents').where({ id: payload.sourceOutboxId }).delete()
          await db('pageMutationOutbox').where({ pageId: imported.id, sourceRevision: current.sourceRevision }).delete()
        }
        let publicationCount = 0
        const performMutation = Storage.performMutation
        const publication = vi.spyOn(Storage, 'performMutation').mockImplementation((input, work, signal) =>
          performMutation.call(Storage, input, dispatch => work({
            ...dispatch,
            writePage: (page, onWritten) => dispatch.writePage(page, onWritten === undefined ? undefined : async proof => {
              publicationCount += 1
              await onWritten(proof)
            })
          }), signal))
        const single = knexModule({ client: 'pg', connection: connection ?? undefined,
          acquireConnectionTimeout: 1000, pool: { min: 0, max: 1 } })
        try {
          await drainExports(single)
          expect(single.client.pool.numUsed()).toBe(0)
          expect(publicationCount).toBe(1)
          expect(await db('durableJobs').where({ id: job.id }).first('state', 'payload')).toEqual({ state: 'succeeded', payload: job.payload })
        } finally {
          publication.mockRestore()
          await single.destroy()
        }
        const exported = await readFile(path.join(source, sourcePath), 'utf8')
        const document = parseOkfDocument(exported)
        expect(document.body).toBe(current.content)
        expect(document.metadata.title).toBe(current.title)
        if (key === 'git') {
          expect(execFileSync('git', ['show', `HEAD:${sourcePath}`], { cwd: source, encoding: 'utf8' })).toBe(exported)
          expect(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()).toBe('')
        }
        const published = await ownerFor(imported.id)
        expect(storagePageImportOwnerMatches(published, current)).toBe(true)
        expect(published).toMatchObject({
          sourceKey: accepted.sourceKey, locationKey: accepted.locationKey, sourcePath,
          mapped: accepted.mapped, sourceSha256: createHash('sha256').update(exported, 'utf8').digest('hex'),
          nativeRevision: String(current.sourceRevision), operationId: payload.sourceOutboxId, moveBinding: null
        })
        await db('durableJobs').where({ id: job.id }).update({ state: 'pending', completedAt: null, nextRunAt: new Date(0) })
        await drainExports()
        expect(await ownerFor(imported.id)).toEqual(published)
        const noOp = await snapshot()
        expectImportSucceeded(await importing())
        expect(await snapshot()).toEqual(noOp)
        const externalBody = `${document.body}\nA legitimate later external edit.\n`
        await root.writeAtomic(sourcePath, exported.replace(document.body, externalBody))
        if (key === 'git') {
          execFileSync('git', ['add', '--', sourcePath], { cwd: source })
          execFileSync('git', ['commit', '--quiet', '-m', 'Legitimate next external revision'], { cwd: source })
        }
        expectImportSucceeded(await importing())
        const external = await db('pages').where({ id: imported.id }).first('*')
        expect(external.content).toBe(externalBody)
        expect(external.title).toBe(current.title)
        expect(String(external.sourceRevision)).not.toBe(String(current.sourceRevision))
        const nextOwner = await expectAcceptedOwner(imported.id, 'page.updated')
        expect(nextOwner.sourceSha256).toBe(createHash('sha256').update(await readFile(path.join(source, sourcePath))).digest('hex'))
        expect(nextOwner.operationId).not.toBe(payload.sourceOutboxId)
        expect(nextOwner.mapped).toBe(accepted.mapped)
      }
      if (key === 'git') await withGitContentSource({ [sourcePath]: body }, ({ root, source, config }) => exercise(root, source, config))
      else await withImportSource({ [sourcePath]: body }, (root, source) => exercise(root, source, {}))
    })
  }

  it('refuses to acknowledge an ignored untracked Git import until a legitimate retry actually commits the native revision', async () => {
    const sourcePath = 'en/guide.md'
    const original = 'Ignored untracked source accepted by the real full import.\n'
    await withGitContentSource({ 'seed.bin': 'Committed repository seed' }, async ({ root, source, plugin, context, config, git }) => {
      const exclude = path.join(source, '.git', 'info', 'exclude')
      await writeFile(exclude, `${sourcePath}\n`)
      await root.writeAtomic(sourcePath, original)
      expect(git(source, 'check-ignore', '--', sourcePath)).toBe(sourcePath)
      expect(git(source, 'ls-tree', 'HEAD', '--', sourcePath)).toBe('')
      expectImportSucceeded(await plugin.importAll!.call(context as never))
      const imported = await db('pages').where({ path: 'guide' }).first('*')
      const accepted = await expectAcceptedOwner(imported.id, 'page.created')
      await activateExportTarget('git', root, source, config)
      await Page.updatePage({
        id: imported.id, user: author, expectedSourceRevision: String(imported.sourceRevision),
        content: 'Human edit requires a real Git publication, not just worktree bytes.\n'
      })
      const current = await db('pages').where({ id: imported.id }).first('*')
      const { job, payload } = await pendingExport(imported.id)
      const head = git(source, 'rev-parse', 'HEAD')
      let acknowledgements = 0
      const performMutation = Storage.performMutation
      const publication = vi.spyOn(Storage, 'performMutation').mockImplementation((input, work, signal) =>
        performMutation.call(Storage, input, dispatch => work({
          ...dispatch,
          writePage: (page, onWritten) => dispatch.writePage(page, onWritten === undefined ? undefined : async proof => {
            acknowledgements += 1
            await onWritten(proof)
          })
        }), signal))
      try {
        await drainExports()
        expect(acknowledgements).toBe(0)
        expect(await db('durableJobs').where({ id: job.id }).first('state', 'payload', 'lastError')).toEqual({
          state: 'pending', payload: job.payload, lastError: expect.stringMatching(/ignored.*review.*retry/iu)
        })
        expect(await ownerFor(imported.id)).toEqual(accepted)
        expect(storagePageImportOwnerMatches(accepted, current)).toBe(false)
        expect(git(source, 'rev-parse', 'HEAD')).toBe(head)
        expect(git(source, 'ls-tree', 'HEAD', '--', sourcePath)).toBe('')
        const written = await readFile(path.join(source, sourcePath), 'utf8')
        expect(parseOkfDocument(written).body).toBe(current.content)
        const beforeImport = await snapshot()
        await expect(plugin.importAll!.call(context as never)).rejects.toThrow(/ownership|accepted native revision/u)
        expect(await snapshot()).toEqual(beforeImport)

        // Removing the local ignore rule authorizes normal staging, never a force-add or reset.
        await writeFile(exclude, '')
        await drainExports()
        expect(acknowledgements).toBe(1)
        expect(await db('durableJobs').where({ id: job.id }).first('state', 'payload')).toEqual({ state: 'succeeded', payload: job.payload })
        expect(execFileSync('git', ['show', `HEAD:${sourcePath}`], { cwd: source, encoding: 'utf8' })).toBe(written)
        const published = await ownerFor(imported.id)
        expect(storagePageImportOwnerMatches(published, current)).toBe(true)
        expect(published).toMatchObject({
          sourceKey: accepted.sourceKey, locationKey: accepted.locationKey, sourcePath,
          sourceSha256: createHash('sha256').update(written, 'utf8').digest('hex'),
          nativeRevision: String(current.sourceRevision), operationId: payload.sourceOutboxId
        })
        expectImportSucceeded(await plugin.importAll!.call(context as never))
      } finally {
        publication.mockRestore()
      }
    })
  })

  it.each(['foreign-root', 'different-source', 'new-filename'] as const)(
    'does not reassociate a native page when a real disk publication has a %s',
    async boundary => {
      const sourcePath = boundary === 'new-filename' ? 'unclaimed.md' : 'en/unclaimed.md'
      await withImportSource({ [sourcePath]: 'Original accepted source.\n' }, async (root, source) => {
        expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
        const imported = await db('pages').where({ path: 'unclaimed' }).first('*')
        const accepted = await ownerFor(imported.id)
        const foreignPath = path.join(directory, 'foreign-root')
        await mkdir(foreignPath)
        const foreign = await openStorageRoot(foreignPath)
        try {
          await activateExportTarget('disk', boundary === 'foreign-root' ? foreign : root,
            boundary === 'foreign-root' ? foreignPath : source, boundary === 'different-source' ? { path: 'different-configured-source' } : {})
          await Page.updatePage({ id: imported.id, user: author, title: 'Native edit must not grant another source authority',
            expectedSourceRevision: String(imported.sourceRevision) })
          const { job } = await pendingExport(imported.id)
          await drainExports()
          expect(await db('durableJobs').where({ id: job.id }).first('state')).toEqual({ state: boundary === 'foreign-root' ? 'pending' : 'succeeded' })
          const published = await readFile(path.join(boundary === 'foreign-root' ? foreignPath : source, 'en/unclaimed.md'), 'utf8')
          expect(parseOkfDocument(published).metadata.title).toBe('Native edit must not grant another source authority')
          expect(await ownerFor(imported.id)).toEqual(accepted)
          const current = await db('pages').where({ id: imported.id }).first('*')
          expect(storagePageImportOwnerMatches(accepted, current)).toBe(false)
          await root.writeAtomic(sourcePath, 'Legitimate old-source update still needs fresh review.\n')
          const beforeImport = await snapshot()
          await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership|accepted native revision|Ambiguous/u)
          expect(await snapshot()).toEqual(beforeImport)
        } finally { await foreign.close() }
      })
    }
  )

  it.each(['missing-legacy-root', 'forged-in-memory-root', 'different-page-root'] as const)(
    'never invents native publication authority for an actual durable intent with %s',
    async boundary => {
      await withImportSource({ 'en/intent.md': 'Actual imported source.\n' }, async (root, source) => {
        expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
        const imported = await db('pages').where({ path: 'intent' }).first('*')
        const accepted = await ownerFor(imported.id)
        await activateExportTarget('disk', root, source, {})
        await Page.updatePage({ id: imported.id, user: author, title: 'Actual native publication',
          expectedSourceRevision: String(imported.sourceRevision) })
        const { job, payload } = await pendingExport(imported.id)
        if (boundary === 'different-page-root') {
          const other = await createPage('unrelated-root', { skipStorage: true })
          const otherRoot = (await db('outboxEvents').where({ aggregateType: 'page', aggregateId: String(other.id), type: 'page.created' }).first('id')).id
          await db('durableJobs').where({ id: job.id }).update({ payload: JSON.stringify({ ...payload, sourceOutboxId: otherRoot }) })
        } else if (boundary === 'missing-legacy-root') {
          const { sourceOutboxId: _originalRoot, ...legacy } = payload
          await db('durableJobs').where({ id: job.id }).update({ payload: JSON.stringify(legacy) })
        }
        const store = new DurableJobStore(observer)
        const [claimed] = await store.claim({ workerId: 'native-intent-proof', supportedIdentities: Object.keys(exportHandlers) })
        if (!claimed) throw new Error('Missing actual durable native export lease')
        const work = boundary === 'forged-in-memory-root'
          ? { ...claimed, payload: { ...payload, sourceOutboxId: crypto.randomUUID() } }
          : claimed
        const result = await exportHandler(work, { knex: observer, signal: new AbortController().signal }).catch(error => error)
        if (boundary === 'missing-legacy-root') {
          expect(result).toBeUndefined()
          expect(await store.complete(claimed)).toBe(true)
          expect(parseOkfDocument(await readFile(path.join(source, 'en/intent.md'), 'utf8')).metadata.title).toBe('Actual native publication')
        } else expect(result).toBeInstanceOf(Error)
        expect(await ownerFor(imported.id)).toEqual(accepted)
        const before = await snapshot()
        await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership|accepted native revision/u)
        expect(await snapshot()).toEqual(before)
      })
    }
  )

  it.each(['write', 'callback', 'rollback', 'lease', 'configuration', 'deadline', 'physical'] as const)(
    'preserves the accepted ledger when a real Git export loses its %s boundary',
    async boundary => {
      await withGitContentSource({ 'en/failure.md': 'Original accepted native bytes.\n' }, async ({ root, source, config }) => {
        expectImportSucceeded(await importGitFromDisk(root, config))
        const imported = await db('pages').where({ path: 'failure' }).first('*')
        const accepted = await ownerFor(imported.id)
        await activateExportTarget('git', root, source, config)
        await Page.updatePage({ id: imported.id, user: author, content: 'Native bytes awaiting guarded publication.\n',
          expectedSourceRevision: String(imported.sourceRevision) })
        const { job, payload } = await pendingExport(imported.id)
        const store = new DurableJobStore(observer)
        const [claimed] = await store.claim({ workerId: 'native-effect-failure', supportedIdentities: Object.keys(exportHandlers) })
        if (!claimed) throw new Error('Missing native publication lease')
        let effects = 0
        let workerTransaction: Knex.Transaction | undefined
        // Observe the real worker transaction without keeping an outer transaction
        // open across Storage's independent post-commit target-state publication.
        const worker = new Proxy(observer, {
          get(knex, property, receiver) {
            if (property !== 'transaction') return Reflect.get(knex, property, receiver)
            return <T>(work: (transaction: Knex.Transaction) => Promise<T>) => knex.transaction(async transaction => {
              workerTransaction = transaction
              return work(transaction)
            })
          }
        })
        let restoreClock: (() => void) | undefined
        const write = boundary === 'write' ? vi.spyOn(root, 'writeAtomic').mockRejectedValueOnce(new Error('Actual source writer failed')) : undefined
        if (boundary === 'rollback') await db.raw(`
          CREATE FUNCTION reject_native_export_commit() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'controlled native export commit rollback'; END;
          $$ LANGUAGE plpgsql;
          CREATE CONSTRAINT TRIGGER reject_native_export_commit AFTER UPDATE ON "storagePageImportOwners"
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_native_export_commit();
        `)
        const performMutation = Storage.performMutation
        const publication = vi.spyOn(Storage, 'performMutation').mockImplementation((input, work, signal) =>
          performMutation.call(Storage, input, dispatch => work({
            ...dispatch,
            writePage: async (page, onWritten) => {
              await dispatch.writePage(page, onWritten === undefined ? undefined : async proof => {
                effects += 1
                if (!workerTransaction) throw new Error('Missing supplied native worker transaction')
                if (boundary === 'lease') await workerTransaction('durableJobs').where({ id: job.id }).update({ leaseToken: crypto.randomUUID() })
                if (boundary === 'configuration') await workerTransaction('storage').where({ key: 'git' }).update({ config: { ...config, branch: 'changed-after-write' } })
                if (boundary === 'deadline') {
                  const clock = vi.spyOn(Date, 'now').mockReturnValue(currentGitMutationTurn().deadlineAt)
                  restoreClock = () => clock.mockRestore()
                }
                if (boundary === 'physical') {
                  const turn = currentGitMutationTurn()
                  const key = createHash('sha256').update(turn.targetKey).digest().readInt32BE(0) >>> 0
                  const lost = await workerTransaction.raw(
                    "SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted",
                    [0x47495453, key])
                  expect(lost.rows).toEqual([{ terminated: true }])
                }
                await onWritten(proof)
                if (boundary === 'callback') throw new Error('Actual publication callback failed')
              })
            }
          }), signal))
        try {
          await expect(exportHandler(claimed, { knex: worker, signal: new AbortController().signal }))
            .rejects.toThrow(boundary === 'rollback' ? /controlled native export commit rollback/u : /./u)
          expect(effects).toBe(boundary === 'write' ? 0 : 1)
        } finally {
          restoreClock?.()
          write?.mockRestore()
          publication.mockRestore()
          if (boundary === 'rollback') await db.raw('DROP TRIGGER reject_native_export_commit ON "storagePageImportOwners"; DROP FUNCTION reject_native_export_commit()')
        }
        expect(await ownerFor(imported.id)).toEqual(accepted)
        expect((await db('durableJobs').where({ id: job.id }).first('payload')).payload).toBe(job.payload)
        if (boundary !== 'write') {
          const actual = await readFile(path.join(source, 'en/failure.md'), 'utf8')
          expect(parseOkfDocument(actual).body).toBe('Native bytes awaiting guarded publication.\n')
          expect(execFileSync('git', ['show', 'HEAD:en/failure.md'], { cwd: source, encoding: 'utf8' })).toBe(actual)
        }
        const replayRoot = root.closed ? await openStorageRoot(source) : root
        try {
          // A committed filesystem effect cannot grant authority when native acceptance rolled back.
          const beforeImport = await snapshot()
          await expect(importGitFromDisk(replayRoot, config)).rejects.toThrow(/ownership|accepted native revision/u)
          expect(await snapshot()).toEqual(beforeImport)
          expect(await store.fail(claimed, new Error('Retry the retained native publication'))).toBe(true)
          await db('outboxEvents').where({ id: payload.sourceOutboxId }).delete()
          await activateExportTarget('git', replayRoot, source, config)
          await drainExports()
          const current = await db('pages').where({ id: imported.id }).first('*')
          const recovered = await ownerFor(imported.id)
          expect(storagePageImportOwnerMatches(recovered, current)).toBe(true)
          expect(recovered.operationId).toBe(payload.sourceOutboxId)
          expect(recovered.sourceSha256).toBe(createHash('sha256').update(await readFile(path.join(source, 'en/failure.md'))).digest('hex'))
          expectImportSucceeded(await importGitFromDisk(replayRoot, config))
        } finally {
          if (replayRoot !== root) await replayRoot.close()
        }
      })
    }
  )

  it('supersedes a completed actual Git move binding only after publishing a newer same-path native revision', async () => {
    await withGitContentSource({ 'en/before-publication.md': 'The real rename keeps its source association.\n' },
      async ({ root, source, writer, plugin, context, config, git }) => {
        expectImportSucceeded(await importGitFromDisk(root, config))
        const imported = await db('pages').where({ path: 'before-publication' }).first('*')
        git(writer, 'mv', '--', 'en/before-publication.md', 'en/after-publication.md')
        git(writer, 'commit', '--quiet', '-m', 'Complete an actual accepted native source rename')
        git(writer, 'push', '--quiet', 'origin', 'main')
        expectImportSucceeded(await Reflect.apply(plugin.sync!, context, []))
        const moved = await db('pages').where({ id: imported.id }).first('*')
        const completed = await ownerFor(imported.id)
        expect(completed).toMatchObject({
          sourcePath: 'en/after-publication.md', nativePath: 'after-publication',
          moveBinding: { phase: 'completed' }
        })
        await activateExportTarget('git', root, source, config)
        await Page.updatePage({ id: imported.id, user: author, title: 'A newer published native title retires completed operational proof',
          expectedSourceRevision: String(moved.sourceRevision) })
        const { payload } = await pendingExport(imported.id)
        expect(await ownerFor(imported.id)).toEqual(completed)
        await drainExports()
        const current = await db('pages').where({ id: imported.id }).first('*')
        const published = await ownerFor(imported.id)
        expect(storagePageImportOwnerMatches(published, current)).toBe(true)
        expect(published).toMatchObject({
          sourceKey: completed.sourceKey, locationKey: completed.locationKey, mapped: completed.mapped,
          sourcePath: completed.sourcePath, operationId: payload.sourceOutboxId, moveBinding: null
        })
        const exported = await readFile(path.join(source, completed.sourcePath), 'utf8')
        expect(git(source, 'show', `HEAD:${completed.sourcePath}`)).toBe(exported.trimEnd())
        expect(published.sourceSha256).toBe(createHash('sha256').update(exported).digest('hex'))
        await root.writeAtomic(completed.sourcePath, exported.replace(current.content, 'Legitimate external edit after the native publication.\n'))
        git(source, 'add', '--', completed.sourcePath)
        git(source, 'commit', '--quiet', '-m', 'External edit after completed binding supersession')
        expectImportSucceeded(await importGitFromDisk(root, config))
        expect((await db('pages').where({ id: imported.id }).first('content')).content)
          .toBe('Legitimate external edit after the native publication.\n')
      })
  })

  it('does not let an older real page intent acknowledge a newer native writer', async () => {
    await withImportSource({ 'en/newer.md': 'Accepted old source.\n' }, async (root, source) => {
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      const imported = await db('pages').where({ path: 'newer' }).first('*')
      const accepted = await ownerFor(imported.id)
      await activateExportTarget('disk', root, source, {})
      await Page.updatePage({ id: imported.id, user: author, title: 'Queued native title', expectedSourceRevision: String(imported.sourceRevision) })
      const { job } = await pendingExport(imported.id)
      const queued = await db('pages').where({ id: imported.id }).first('*')
      await Page.updatePage({ id: imported.id, user: author, content: 'Newer native writer must remain unexported.\n',
        expectedSourceRevision: String(queued.sourceRevision), skipStorage: true })
      const newer = await db('pages').where({ id: imported.id }).first('*')
      await drainExports()
      expect(await db('durableJobs').where({ id: job.id }).first('state')).toEqual({ state: 'succeeded' })
      expect(await readFile(path.join(source, 'en/newer.md'), 'utf8')).toBe('Accepted old source.\n')
      expect(await ownerFor(imported.id)).toEqual(accepted)
      expect(storagePageImportOwnerMatches(accepted, newer)).toBe(false)
      const before = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership|accepted native revision/u)
      expect(await snapshot()).toEqual(before)
    })
  })

  it.each([
    ['a.b.md', 'ab.md', false],
    ['x.y/a.b.md', 'xy/ab.md', false],
    ['Guide.md', 'guide.md', false],
    ['caf\u00e9.md', 'cafe\u0301.md', false],
    ['guide.md', 'en/guide.md', false],
    ['README.md', 'home.md', true]
  ] as const)('rejects native disk identity ambiguity for %s / %s before canonical writes', async (first, second, mapReadmeToHome) => {
    await withImportSource({
      [first]: 'First source', [second]: 'Second source', '00-sentinel.bin': 'Do not import this asset'
    }, async root => {
      const before = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion: { mapReadmeToHome } }))
        .rejects.toThrow(/Unsupported native page identity|Ambiguous page import/u)
      expect(await snapshot()).toEqual(before)
      expect(await db('assetFolders')).toEqual([])
    })
  })

  it.each([
    ['guide', 'guide.md'],
    ['Guide', 'guide.md'],
    ['caf\u00e9', 'cafe\u0301.md']
  ])('preserves an unrelated existing native owner and its case/Unicode aliases (%s)', async (existing, incoming) => {
    await seedPage(40, existing, { published: false })
    await withImportSource({ [incoming]: 'External source', '00-sentinel.bin': 'No partial asset' }, async root => {
      const before = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
        .rejects.toThrow(/Existing page ownership is unreviewed|Destination spelling conflicts/u)
      expect(await snapshot()).toEqual(before)
      expect(await db('assetFolders')).toEqual([])
    })
  })

  it('associates a reviewed dotted source with an existing native page without renaming, republishing, or replaying its revision', async () => {
    await seedPage(40, 'ab', { published: false })
    const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'disk', configurationRevision: 'native-reviewed-target' }
    const ingestion = { path: 'import-source' }
    await withImportSource({ 'a.b.md': 'Reviewed replacement', '00-sentinel.bin': 'Imported asset' }, async (root, source) => {
      const untouched = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion })).rejects.toThrow('Unsupported native page identity')
      expect(await snapshot()).toEqual(untouched)
      const preview = await buildStorageImportPreview(await collectStorageEntries(root), ingestion, 'DISK', scope)
      const document = preview.pages.find(page => page.sourcePath === 'a.b.md')!
      const existing = await db('pages').where({ id: 40 }).first('sourceRevision')
      const review = {
        scope, snapshot: preview.snapshot,
        mappings: [{
          sourcePath: 'a.b.md', sourceSha256: document.sourceSha256, locale: 'en', path: 'ab',
          existingPageId: 40, expectedSourceRevision: String(existing.sourceRevision)
        }]
      }
      await root.writeAtomic('a.b.md', 'Changed after review')
      const beforeChangedSource = await snapshot()
      await expect(withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion }))).rejects.toThrow('review is stale')
      expect(await snapshot()).toEqual(beforeChangedSource)
      await root.writeAtomic('a.b.md', 'Reviewed replacement')
      const imported = await withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion }))
      expect(imported.every(result => result.ok)).toBe(true)
      const page = await db('pages').where({ id: 40 }).first()
      expect(page).toMatchObject({ path: 'ab', content: 'Reviewed replacement', isPublished: false, visibility: 'public' })
      const accepted = await expectAcceptedOwner(40, 'page.updated')
      expect(accepted).toMatchObject({ sourcePath: 'a.b.md', sourceSha256: document.sourceSha256, mapped: true })
      expect(await db('pages')).toHaveLength(1)
      expect(await db('pageHistory')).toHaveLength(1)
      expect(await db('assets')).toHaveLength(1)
      const revision = String(page.sourceRevision)
      const retried = await commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion })
      expect(retried.find(result => result.kind === 'page')?.ok).toBe(true)
      expect(String((await db('pages').where({ id: 40 }).first('sourceRevision')).sourceRevision)).toBe(revision)
      expect(await db('pageHistory')).toHaveLength(1)
      expect(await ownerFor(40)).toEqual(accepted)
      const beforeStale = await snapshot()
      await expect(withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion }))).rejects.toThrow('review is stale')
      expect(await snapshot()).toEqual(beforeStale)
      expect(await readFile(path.join(source, 'a.b.md'), 'utf8')).toBe('Reviewed replacement')
    })
  })

  it('fences real Git old/new ownership through interrupted rename/delete replay and rejects an invalid full inventory without partial writes', async () => {
    await seedPage(90, 'ab', { published: false })
    await withImportSource({
      'en/old.md': 'Owned rename source', 'remove.md': 'Owned deletion source',
      'a.b.md': 'Reviewed dotted rename', 'dot.folder/old.md': 'Reviewed dotted deletion'
    }, async (root, source) => {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim()
      const remote = path.join(directory, 'remote.git')
      const writer = path.join(directory, 'writer')
      git(source, 'init', '--quiet', '--initial-branch=main')
      git(source, 'config', 'user.name', author.name)
      git(source, 'config', 'user.email', author.email)
      git(source, 'config', 'commit.gpgSign', 'false')
      git(source, 'add', '--', 'en/old.md', 'remove.md', 'a.b.md', 'dot.folder/old.md')
      git(source, 'commit', '--quiet', '-m', 'Initial admitted sources')
      git(directory, 'clone', '--bare', '--quiet', source, remote)
      git(source, 'remote', 'add', 'origin', remote)
      git(directory, 'clone', '--quiet', remote, writer)
      git(writer, 'config', 'user.name', author.name)
      git(writer, 'config', 'user.email', author.email)
      git(writer, 'config', 'commit.gpgSign', 'false')
      git(writer, 'config', 'push.gpgSign', 'false')
      const config = { branch: 'main', repoUrl: remote, localRepoPath: 'import-source' }
      const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'git', configurationRevision: 'native-reviewed-git-target' }
      const preview = await buildStorageImportPreview(await collectStorageEntries(root), config, 'GIT', scope)
      const review = {
        scope, snapshot: preview.snapshot,
        mappings: [
          { sourcePath: 'a.b.md', path: 'reviewed-dotted' },
          { sourcePath: 'dot.folder/old.md', path: 'reviewed-folder' }
        ].map(mapping => ({
          ...mapping, locale: 'en', sourceSha256: preview.pages.find(page => page.sourcePath === mapping.sourcePath)!.sourceSha256,
          existingPageId: null, expectedSourceRevision: null
        }))
      }
      const imported = await withStorageImportReview(review, async () => {}, () => importGitFromDisk(root, config))
      expect(imported.every(result => result.ok)).toBe(true)
      const original = await db('pages').where({ path: 'old', localeCode: 'en' }).first('id', 'path', 'localeCode', 'sourceRevision')
      const originalOwner = await expectAcceptedOwner(original.id, 'page.created')
      const fromGitRevision = git(source, 'rev-parse', 'HEAD')
      const deletedPages = await db('pages').whereIn('path', ['remove', 'reviewed-folder']).select('id')
      await globalThis.WIKI.models.comments.query().insert([
        ...deletedPages.map(page => ({ pageId: page.id, authorId: author.id, content: 'Discussion removed with its owned source' })),
        { pageId: 90, authorId: author.id, content: 'Unrelated discussion must survive Git deletion' }
      ])
      await mkdir(path.join(writer, 'fr'))
      git(writer, 'mv', '--', 'en/old.md', 'fr/new.md')
      git(writer, 'mv', '--', 'a.b.md', 'reviewed-dotted-final.md')
      git(writer, 'rm', '--', 'remove.md', 'dot.folder/old.md')
      git(writer, 'commit', '--quiet', '-m', 'Rename and delete owned sources')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const toGitRevision = git(writer, 'rev-parse', 'HEAD')
      // The provider intentionally captures the installed native WIKI runtime on load.
      const plugin = (await import('../../modules/storage/git/storage.ts')).default
      const context = { ...plugin, root, repoPath: source, git: true, mode: 'pull', targetKey: 'git', config }
      const update = Page.updatePage
      const interruption = vi.spyOn(Page, 'updatePage').mockImplementation(async options => {
        if (options.id === original.id) throw new Error('Interruption after native move')
        return update.call(Page, options)
      })
      try {
        const failed = await plugin.sync!.call(context as never)
        expect(failed).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'fr/new.md', ok: false })]))
      } finally {
        interruption.mockRestore()
        expect(Page.updatePage).toBe(update)
      }
      expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).not.toBe('')
      expect(await db('pages').where({ id: original.id }).first('path', 'localeCode')).toMatchObject({ path: 'new', localeCode: 'fr' })
      const movedOwner = await expectAcceptedOwner(original.id, 'page.moved')
      expect(movedOwner).toMatchObject({
        sourcePath: 'en/old.md', sourceSha256: originalOwner.sourceSha256, nativePath: 'new', nativeLocaleCode: 'fr',
        moveBinding: {
          phase: 'moved', fromGitRevision, toGitRevision, oldSourcePath: 'en/old.md', newSourcePath: 'fr/new.md',
          oldSourceSha256: originalOwner.sourceSha256, newSourceSha256: originalOwner.sourceSha256,
          previousNativeRevision: String(original.sourceRevision), previousNativePath: original.path,
          previousNativeLocaleCode: original.localeCode
        }
      })
      expect(movedOwner.moveBinding!.moveOperationId).toBe(movedOwner.operationId)
      expect(movedOwner.moveBinding!.moveNativeRevision).toBe(movedOwner.nativeRevision)
      const restarted = { ...plugin, root, repoPath: source, git: true, mode: 'pull', targetKey: 'git', config }
      const recovered = await plugin.importAll!.call(restarted as never)
      expect(recovered).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'fr/new.md', ok: true })]))
      const completedOwner = await expectAcceptedOwner(original.id, 'page.updated')
      expect(completedOwner.moveBinding).toEqual({ ...movedOwner.moveBinding, phase: 'completed' })
      expect(completedOwner).toMatchObject({ sourcePath: 'fr/new.md', sourceSha256: originalOwner.sourceSha256 })
      expect(completedOwner.operationId).not.toBe(movedOwner.operationId)
      expect(completedOwner.nativeRevision).not.toBe(movedOwner.nativeRevision)
      for (const deleted of deletedPages) {
        const retired = await ownerFor(deleted.id)
        expect(retired.status).toBe('deleted')
        expect(retired.deletedAt).not.toBeNull()
        expect(await db('outboxEvents').where({ id: retired.operationId }).first('type')).toEqual({ type: 'page.deleted' })
      }
      expect(await db('pages').where({ path: 'remove' })).toEqual([])
      expect(await db('pages').where({ path: 'reviewed-folder' })).toEqual([])
      expect(await db('comments').select('pageId', 'content')).toEqual([
        { pageId: 90, content: 'Unrelated discussion must survive Git deletion' }
      ])
      expect(await db('pageHistory').where({ action: 'deleted' }).orderBy('path').select('path')).toEqual([
        { path: 'remove' }, { path: 'reviewed-folder' }
      ])
      expect(await db('pages').where({ path: 'reviewed-dotted-final' }).first('content')).toMatchObject({ content: 'Reviewed dotted rename' })
      expect(await db('pages').where({ id: original.id }).first('path', 'localeCode', 'content')).toMatchObject({
        path: 'new', localeCode: 'fr', content: 'Owned rename source'
      })
      expect(await db('pages').where({ id: 90 }).first('path', 'content', 'isPublished')).toMatchObject({
        path: 'ab', content: protectedContent, isPublished: false
      })
      expect(() => git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toThrow()
      const completedSnapshot = await snapshot()
      git(source, 'update-ref', 'refs/wiki/pending-import/main', fromGitRevision)
      expectImportSucceeded(await plugin.importAll!.call(restarted as never))
      expect(await snapshot()).toEqual(completedSnapshot)
      expect(await ownerFor(original.id)).toEqual(completedOwner)
      await writeFile(path.join(writer, 'a.b.md'), 'Must not collapse into ab')
      await writeFile(path.join(writer, '00-sentinel.bin'), 'Do not import asset')
      git(writer, 'add', '--', 'a.b.md', '00-sentinel.bin')
      git(writer, 'commit', '--quiet', '-m', 'Unreviewed dotted source')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const before = await snapshot()
      await expect(plugin.sync!.call(context as never)).rejects.toThrow('Unsupported native page identity')
      expect(await snapshot()).toEqual(before)
      await expect(plugin.sync!.call(context as never)).rejects.toThrow('Unsupported native page identity')
      expect(await snapshot()).toEqual(before)
      expect(await db('assets')).toEqual([])
    })
  })

  for (const kind of ['page', 'asset'] as const) {
    for (const [oldHidden, newHidden] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      it(`applies real Git ${kind} ${oldHidden ? 'hidden' : 'visible'}→${newHidden ? 'hidden' : 'visible'} rename visibility, retaining conflicts through pending replay`, async () => {
        const extension = kind === 'page' ? 'md' : 'bin'
        const oldPath = oldHidden ? kind === 'page' ? `.old.${extension}` : `.old/asset.${extension}` : `old.${extension}`
        const newPath = newHidden ? kind === 'page' ? `.new/page.${extension}` : `.new.${extension}` : `new.${extension}`
        const bytes = `Exact ${kind} bytes retained through a native Git rename boundary.`
        await seedPage(90, 'unrelated-protected', { published: false })
        await withGitContentSource({ [oldPath]: bytes }, async ({ root, writer, source, plugin, context, config, git, preview }) => {
          const first = await importGitFromDisk(root, config)
          expect(first.every(result => result.ok)).toBe(true)
          const before = await snapshot()
          expect(await db(kind === 'page' ? 'pages' : 'assets').where(kind === 'page' ? { path: 'old' } : { filename: 'old.bin' }))
            .toHaveLength(oldHidden ? 0 : 1)
          await mkdir(path.dirname(path.join(writer, newPath)), { recursive: true })
          git(writer, 'mv', '--', oldPath, newPath)
          git(writer, 'commit', '--quiet', '-m', 'Cross visibility boundary')
          git(writer, 'push', '--quiet', 'origin', 'main')
          const result = await plugin.sync!.call(context as never)
          if (!oldHidden && newHidden) {
            expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: oldPath, ok: false, outcome: 'conflict' })]))
            expect(await snapshot()).toEqual(before)
            const base = git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')
            expect(base).not.toBe('')
            const retry = await plugin.sync!.call(context as never)
            expect(retry).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: oldPath, ok: false, outcome: 'conflict' })]))
            expect(await snapshot()).toEqual(before)
            expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toBe(base)
            const reviewed = await preview()
            const entry = reviewed.gitContent!.find(entry => entry.sourcePath === oldPath)!
            expect(entry.previous).toBe(true)
            expect(entry.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
            const retain: StorageGitContentChoice = { sourcePath: oldPath, sourceSha256: entry.sourceSha256, sourceRevision: entry.sourceRevision, owner: entry.owner, action: 'retain' }
            config.dotContentReview = serializeGitContentChoices(entry.sourceKey, [retain])
            const retained = await plugin.sync!.call(context as never)
            expectImportSucceeded(retained)
            const retainedSnapshot = await snapshot()
            if (kind === 'page') expect(retainedSnapshot).toEqual(before)
            else {
              const withoutMetadata = (rows: Record<string, unknown>[]) => rows.map(row => ({ ...row, metadata: undefined }))
              expect({ ...retainedSnapshot, assets: withoutMetadata(retainedSnapshot.assets) })
                .toEqual({ ...before, assets: withoutMetadata(before.assets) })
              expect(retainedSnapshot.assets[0].metadata.storage_import).toMatchObject({
                assetId: entry.owner!.id, sourceKey: entry.sourceKey, sourcePath: oldPath, sourceSha256: entry.sourceSha256,
                assetSha256: entry.owner!.sha256
              })
            }
            expect(() => git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toThrow()
            const pinned = await preview()
            const pinnedEntry = pinned.gitContent!.find(entry => entry.sourcePath === oldPath)!
            expect(pinnedEntry).toMatchObject({ sourceRevision: base, sourceAvailable: true })
            config.dotContentReview = serializeGitContentChoices(entry.sourceKey, [{
              sourcePath: oldPath, sourceSha256: pinnedEntry.sourceSha256, sourceRevision: pinnedEntry.sourceRevision,
              sourceAvailable: true, owner: pinnedEntry.owner, action: 'retain'
            }])
            const retainedRef = gitRetainedContentRef(entry.sourceKey, oldPath)
            git(source, 'update-ref', '-d', retainedRef)
            const missingPin = await preview()
            expect(missingPin.gitContent!.find(entry => entry.sourcePath === oldPath)).toMatchObject({ sourceAvailable: false, owner: { sourceOwned: false } })
            await expect(plugin.importAll!.call(context as never)).rejects.toThrow(/stale|ownership changed/)
            expect(await snapshot()).toEqual(retainedSnapshot)
            git(source, 'update-ref', retainedRef, base)
            const removal: StorageImportReview = {
              scope: pinned.scope, snapshot: pinned.snapshot, mappings: [],
              gitContent: [{ sourcePath: oldPath, sourceSha256: pinnedEntry.sourceSha256,
                sourceRevision: pinnedEntry.sourceRevision, owner: pinnedEntry.owner, action: 'remove' }]
            }
            expectImportSucceeded(await withStorageImportReview(removal, async () => {}, () => plugin.importAll!.call(context as never)))
            expect(await db(kind === 'page' ? 'pages' : 'assets').where(kind === 'page' ? { path: 'old' } : { filename: 'old.bin' })).toEqual([])
            await expect(withStorageImportReview(removal, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow(/stale|ownership changed/)
          } else {
            expectImportSucceeded(result)
            if (newHidden) expect(await snapshot()).toEqual(before)
            else {
              const imported = kind === 'page'
                ? await db('pages').where({ path: 'new' }).first('content')
                : await db('assets').where({ filename: 'new.bin' }).first('id')
              expect(imported).toBeDefined()
              if (kind === 'page') expect(imported.content).toBe(bytes)
              else expect(Buffer.from((await db('assetData').where({ id: imported.id }).first('data')).data).toString()).toBe(bytes)
              expect(await db(kind === 'page' ? 'pages' : 'assets').where(kind === 'page' ? { path: 'old' } : { filename: 'old.bin' })).toEqual([])
            }
          }
          expect(await db('pages').where({ id: 90 }).first('path', 'content', 'isPublished')).toMatchObject({
            path: 'unrelated-protected', content: protectedContent, isPublished: false
          })
        })
      })
    }
  }

  it('includes only an exact reviewed legitimate dot asset and keeps ordinary filename spelling unchanged', async () => {
    await withGitContentSource({
      '.legitimate.bin': 'Reviewed compatibility asset',
      '.legitimate/other.bin': 'Must remain excluded',
      'ordinary-file.name.bin': 'Ordinary valid asset'
    }, async ({ plugin, context, preview }) => {
      const initial = await preview()
      const entry = initial.gitContent!.find(entry => entry.sourcePath === '.legitimate.bin')!
      const review: StorageImportReview = { scope: initial.scope, snapshot: initial.snapshot, mappings: [], gitContent: [{
        sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include'
      }] }
      expectImportSucceeded(await withStorageImportReview(review, async () => {}, () => plugin.importAll!.call(context as never)))
      expect(await db('assets').orderBy('filename').select('filename')).toEqual([
        { filename: '.legitimate.bin' }, { filename: 'ordinary-file.name.bin' }
      ])
      expect(await db('assetFolders')).toEqual([])
      const before = await snapshot()
      await expect(withStorageImportReview(review, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow(/stale|ownership changed/)
      expect(await snapshot()).toEqual(before)
    })
  })

  it('inventories imported dot pages, preserves them by default, and uses native revision/authority for reviewed remap and removal', async () => {
    await seedPage(90, 'unrelated-protected', { published: false })
    await withGitContentSource({ '.legacy.md': 'Owned dot-page source' }, async ({ root, plugin, context, config, preview }) => {
      const initial = await preview()
      const entry = initial.gitContent![0]!
      const include: StorageImportReview = {
        scope: initial.scope, snapshot: initial.snapshot,
        mappings: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, locale: 'en', path: 'legacy-hidden', existingPageId: null, expectedSourceRevision: null }],
        gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }]
      }
      const created = await withStorageImportReview(include, async () => {}, () => importGitFromDisk(root, config))
      expect(created.every(result => result.ok)).toBe(true)
      const page = await db('pages').where({ path: 'legacy-hidden' }).first()
      const before = await snapshot()
      expect(await plugin.importAll!.call(context as never)).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: '.legacy.md', ok: false, outcome: 'conflict' })]))
      expect(await snapshot()).toEqual(before)
      const current = await preview()
      const owned = current.gitContent![0]!
      expect(owned.owner).toMatchObject({ id: page.id, sourceOwned: true, revision: String(page.sourceRevision) })
      const remap: StorageImportReview = { scope: current.scope, snapshot: current.snapshot, mappings: [], gitContent: [{
        sourcePath: owned.sourcePath, sourceSha256: owned.sourceSha256, owner: owned.owner, action: 'remap', destinationPath: 'remapped-hidden'
      }] }
      expectImportSucceeded(await withStorageImportReview(remap, async () => {}, () => plugin.importAll!.call(context as never)))
      expect(await db('pages').where({ id: page.id }).first('path')).toEqual({ path: 'remapped-hidden' })
      const remappedOwner = await expectAcceptedOwner(page.id, 'page.moved')
      expect(remappedOwner).toMatchObject({ sourcePath: '.legacy.md', mapped: true, nativePath: 'remapped-hidden' })
      const retained = await preview()
      const retainedEntry = retained.gitContent![0]!
      config.dotContentReview = serializeGitContentChoices(retainedEntry.sourceKey, [{
        sourcePath: retainedEntry.sourcePath, sourceSha256: retainedEntry.sourceSha256, owner: retainedEntry.owner, action: 'retain'
      }])
      expectImportSucceeded(await plugin.importAll!.call(context as never))
      expect(await ownerFor(page.id)).toEqual(remappedOwner)
      config.dotContentReview = ''
      const afterClearingChoices = await preview()
      expect(afterClearingChoices.gitContent![0]!.owner).toMatchObject({
        id: page.id, path: 'remapped-hidden', revision: remappedOwner.nativeRevision, sourceOwned: true
      })
      expect(await ownerFor(page.id)).toEqual(remappedOwner)
      await expect(withStorageImportReview(remap, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow(/stale|ownership changed/)
      const removalPreview = await preview()
      const removalEntry = removalPreview.gitContent![0]!
      const remove: StorageImportReview = { scope: removalPreview.scope, snapshot: removalPreview.snapshot, mappings: [], gitContent: [{
        sourcePath: removalEntry.sourcePath, sourceSha256: removalEntry.sourceSha256, owner: removalEntry.owner, action: 'remove'
      }] }
      const admission = await collectGitContentEntries(root, 1_048_576)
      const denied = await withStorageImportReview(remove, async () => {}, () => withGitMutationLock(observer, 'git', () =>
        plugin.processFiles.call(context as never, { admission, files: [] }, assetWriter)))
      expect(denied).toEqual([expect.objectContaining({ ok: false, outcome: 'conflict' })])
      expect(await db('pages').where({ id: page.id }).first('path')).toEqual({ path: 'remapped-hidden' })
      expectImportSucceeded(await withStorageImportReview(remove, async () => {}, () => plugin.importAll!.call(context as never)))
      expect(await db('pages').where({ id: page.id })).toEqual([])
      expect(await db('pages').where({ id: 90 }).first('content', 'isPublished')).toMatchObject({ content: protectedContent, isPublished: false })
    })
  })

  it('never infers dot-asset ownership from equal bytes, and fences replacement/replay after an interrupted reviewed removal', async () => {
    const upload = await prepareUpload('.legacy.bin', true)
    await upload.run()
    const original = await db('assets').where({ filename: '.legacy.bin' }).first()
    await withGitContentSource({ '.legacy.bin': upload.bytes.toString(), 'ordinary.bin': 'Unrelated ordinary asset' }, async ({ plugin, context, config, preview }) => {
      const initial = await preview()
      const unowned = initial.gitContent!.find(entry => entry.sourcePath === '.legacy.bin')!
      expect(unowned.owner).toMatchObject({ id: original.id, sourceOwned: false })
      const premature: StorageImportReview = { scope: initial.scope, snapshot: initial.snapshot, mappings: [], gitContent: [{
        sourcePath: unowned.sourcePath, sourceSha256: unowned.sourceSha256, owner: { ...unowned.owner!, sourceOwned: true }, action: 'remove'
      }] }
      await expect(withStorageImportReview(premature, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow('requires exact native source ownership')
      const retain: StorageGitContentChoice = { sourcePath: unowned.sourcePath, sourceSha256: unowned.sourceSha256, owner: unowned.owner, action: 'retain' }
      config.dotContentReview = serializeGitContentChoices(unowned.sourceKey, [retain])
      expectImportSucceeded(await plugin.importAll!.call(context as never))
      const retained = await preview()
      expect(retained.gitContent!.find(entry => entry.sourcePath === '.legacy.bin')!.owner?.sourceOwned).toBe(false)
      expect((await db('assets').where({ id: original.id }).first('metadata')).metadata.storage_import).toBeUndefined()
      const kept = retained.gitContent!.find(entry => entry.sourcePath === '.legacy.bin')!
      const accept: StorageImportReview = { scope: retained.scope, snapshot: retained.snapshot, mappings: [], gitContent: [{
        sourcePath: kept.sourcePath, sourceSha256: kept.sourceSha256, owner: kept.owner, action: 'include'
      }] }
      expectImportSucceeded(await withStorageImportReview(accept, async () => {}, () => plugin.importAll!.call(context as never)))
      const reviewed = await preview()
      const entry = reviewed.gitContent!.find(entry => entry.sourcePath === '.legacy.bin')!
      expect(entry.owner?.sourceOwned).toBe(true)
      const removal: StorageImportReview = { scope: reviewed.scope, snapshot: reviewed.snapshot, mappings: [], gitContent: [{
        sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: entry.owner, action: 'remove'
      }] }
      const stable = await snapshot()
      await db('assets').where({ id: original.id }).update({ updatedAt: new Date('2030-01-01T00:00:00Z') })
      const changed = await snapshot()
      await expect(withStorageImportReview(removal, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow(/stale|ownership changed/)
      expect(await snapshot()).toEqual(changed)
      await db('assets').where({ id: original.id }).update({ updatedAt: stable.assets.find((asset: { id: number }) => asset.id === original.id).updatedAt })
      const cacheFailure = vi.spyOn(Asset, 'deleteAssetCaches').mockRejectedValueOnce(new Error('Interrupted after native asset deletion'))
      try {
        const failed = await withStorageImportReview(removal, async () => {}, () => plugin.importAll!.call(context as never))
        expect(failed).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: '.legacy.bin', ok: false, outcome: 'conflict' })]))
      } finally { cacheFailure.mockRestore() }
      expect(await db('assets').where({ id: original.id })).toEqual([])
      const replacement = await prepareUpload('.legacy.bin', true)
      await replacement.run()
      const replaced = await snapshot()
      expect((await db('assets').where({ filename: '.legacy.bin' }).first('id')).id).not.toBe(original.id)
      await expect(withStorageImportReview(removal, async () => {}, () => plugin.importAll!.call(context as never))).rejects.toThrow(/stale|ownership changed/)
      expect(await snapshot()).toEqual(replaced)
    })
  })

  for (const scenario of [
    { name: 'default HTML', contentType: 'html', locale: 'en', namespacing: false, alwaysNamespace: false, physical: 'guide.html' },
    { name: 'nondefault unnamespaced HTML', contentType: 'html', locale: 'fr', namespacing: false, alwaysNamespace: false, physical: 'guide.html' },
    { name: 'nondefault namespaced HTML', contentType: 'html', locale: 'fr', namespacing: true, alwaysNamespace: false, physical: 'fr/guide.html' },
    { name: 'forced default namespace', contentType: 'html', locale: 'en', namespacing: false, alwaysNamespace: true, physical: 'en/guide.html' },
    { name: 'disk default HTML', target: 'disk', contentType: 'html', locale: 'en', namespacing: false, alwaysNamespace: false, physical: 'guide.html' },
    { name: 'disk namespaced HTML', target: 'disk', contentType: 'html', locale: 'fr', namespacing: true, alwaysNamespace: false, physical: 'fr/guide.html' },
    { name: 'AsciiDoc', contentType: 'asciidoc', locale: 'en', namespacing: false, alwaysNamespace: false, physical: 'guide.adoc' },
    { name: 'text', contentType: 'text', locale: 'en', namespacing: false, alwaysNamespace: false, physical: 'guide.txt' },
    { name: 'JSON fallback encoding', contentType: 'json', locale: 'en', namespacing: false, alwaysNamespace: false, physical: 'guide.txt' },
    { name: 'canonical Markdown', contentType: 'markdown', locale: 'fr', namespacing: false, alwaysNamespace: false, physical: okfFilePath('fr', 'guide') }
  ]) {
    it(`atomically rejects an asset-only writer at the actual ${scenario.name} export path`, async () => {
      lang.namespacing = scenario.namespacing
      await target(scenario.target ?? 'git', scenario.alwaysNamespace)
      await seedPage(40, 'guide', { contentType: scenario.contentType, locale: scenario.locale, published: false })
      await db('pageAccessPasswords').insert({ pageId: 40, passwordHash: verifier, version: 1, updatedBy: author.id })
      await db.transaction(transaction => enqueuePageStorageMutation(transaction, { pageId: 40, author }))
      const queued = await db('durableJobs').first('payload')
      // Read the native physical path resolver through real durable admission, not a duplicate path algorithm.
      expect(JSON.parse(queued.payload).paths).toEqual([scenario.physical])
      expect(globalThis.WIKI.auth.checkAccess(assetWriter as never, ['write:pages'])).toBe(false)
      const upload = await prepareUpload(scenario.physical)
      const before = await snapshot()
      await assertConflict(upload.run())
      expect(await snapshot()).toEqual(before)
      expect(await readFile(upload.source)).toEqual(upload.bytes)
    })
  }

  it('does not let skipStorage asset import bypass a public physical owner', async () => {
    await seedPage(40)
    const upload = await prepareUpload('guide.html', true)
    const before = await snapshot()
    await assertConflict(upload.run())
    expect(await snapshot()).toEqual(before)
    expect(await readFile(upload.source)).toEqual(upload.bytes)
  })

  for (const producer of [
    'create',
    'create-import',
    'update-encoding',
    'update-move',
    'history-restore',
    'convert',
    'move',
    'move-import',
    'publish',
    'restore-deleted',
    'locale-migration'
  ]) {
    it(`atomically rejects reverse physical occupancy through native ${producer}`, async () => {
      const destination = producer === 'locale-migration' ? 'fr/guide.html' : 'guide.html'
      if (producer === 'locale-migration') lang.namespacing = true
      const upload = await prepareUpload(destination)
      await upload.run()
      if (!producer.startsWith('create')) {
        await seedPage(40, producer.includes('move') ? 'old' : 'guide', {
          contentType: producer === 'convert' || producer === 'update-encoding' || producer === 'history-restore' ? 'markdown' : 'html',
          visibility: producer === 'publish' ? 'private' : 'public'
        })
      }
      let restoreOptions: Parameters<typeof Page.restoreDeletedPage>[0] | undefined
      if (producer === 'restore-deleted') {
        const deleted = await Page.query().findById(40)
        if (!deleted) throw new Error('Missing native restore source')
        const archived = await History.addVersion({ ...deleted, action: 'deleted', versionDate: deleted.updatedAt })
        await db('pages').where({ id: 40 }).delete()
        const securityContext = {
          version: 1 as const,
          former: { path: 'guide', localeCode: 'en', visibility: 'public' as const, ownerId: null, tags: [] },
          protection: null
        }
        await db('deletedPageRecovery').insert({
          pageId: 40,
          deletionVersionId: archived.id,
          deletionRevision: '2',
          securityContext: JSON.stringify(securityContext)
        })
        restoreOptions = {
          pageId: 40,
          deletionVersionId: archived.id,
          destination: { path: 'guide', localeCode: 'en' },
          recoveringAdminId: author.id,
          securityContext,
          legacyQuarantine: false,
          expectedDeletionRevision: '2',
          user: author
        }
      }
      const before = await snapshot()
      let mutation: Promise<unknown>
      switch (producer) {
        case 'create':
          mutation = createPage()
          break
        case 'create-import':
          mutation = createPage('guide', { skipStorage: true })
          break
        case 'update-encoding':
          mutation = Page.updatePage({ id: 40, user: author, contentType: 'html', editor: 'html', skipStorage: true })
          break
        case 'update-move':
          mutation = Page.updatePage({ id: 40, user: author, path: 'guide', locale: 'en', skipStorage: true })
          break
        case 'history-restore':
          mutation = Page.updatePage({ id: 40, user: author, contentType: 'html', editor: 'html', action: 'restored', okfRestoreRevision: '1' })
          break
        case 'convert':
          mutation = Page.convertPage({ id: 40, user: author, editor: 'html' })
          break
        case 'move':
          mutation = Page.movePage({ id: 40, user: author, destinationPath: 'guide', destinationLocale: 'en' })
          break
        case 'move-import':
          mutation = Page.movePage({ id: 40, user: author, destinationPath: 'guide', destinationLocale: 'en', skipStorage: true })
          break
        case 'publish':
          mutation = Page.changeVisibility({ id: 40, user: author, visibility: 'public', confirmPublication: true, skipStorage: true })
          break
        case 'restore-deleted': {
          if (!restoreOptions) throw new Error('Missing native restore options')
          mutation = Page.restoreDeletedPage(restoreOptions)
          break
        }
        case 'locale-migration':
          mutation = Page.migrateToLocale({ sourceLocale: 'en', targetLocale: 'fr', user: author })
          break
        default:
          throw new Error(`Unknown namespace producer: ${producer}`)
      }
      await assertConflict(mutation)
      expect(await snapshot()).toEqual(before)
    })
  }

  it('keeps a private page out of physical occupancy and rejects only its later public transition', async () => {
    await createPage('guide', { visibility: 'private' })
    const privatePage = await db('pages').first('id')
    const upload = await prepareUpload('guide.html')
    await upload.run()
    expect(await db('assets')).toHaveLength(1)
    expect(await db('durableJobs')).toHaveLength(1)
    const before = await snapshot()
    await assertConflict(Page.changeVisibility({ id: privatePage.id, user: author, visibility: 'public', confirmPublication: true }))
    expect(await snapshot()).toEqual(before)
  })

  it('permits distinct physical locale namespaces and does not reserve legacy Markdown export names', async () => {
    lang.namespacing = true
    await seedPage(40, 'guide', { locale: 'fr' })
    await (await prepareUpload('guide.html')).run()
    await seedPage(41, 'manual', { contentType: 'markdown' })
    await (await prepareUpload(`manual.${pageHelper.getFileExtension('markdown')}`)).run()
    expect(await db('assets')).toHaveLength(2)
    expect(await db('pages')).toHaveLength(2)
  })

  it('fences the absent-path page/asset race before either canonical producer can create dual owners', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = observer.transaction(async transaction => {
      await lockSearchIndex(transaction, true)
      entered.resolve()
      await release.promise
    })
    let pendingPage: Promise<unknown> | undefined
    try {
      await entered.promise
      pendingPage = createPage('racing', { skipStorage: true }).catch(error => error)
      await vi.waitFor(async () => {
        expect(await observer('pg_locks').where({ locktype: 'advisory', granted: false }).first('pid')).toBeDefined()
      })
      // The page has entered its real canonical transaction while the physical location is absent.
      // Holding the existing search fence deterministically pauses it before insertion.
      const upload = await prepareUpload('racing.html')
      const before = await snapshot()
      await assertConflict(upload.run())
      expect(await snapshot()).toEqual(before)
      expect(await readFile(upload.source)).toEqual(upload.bytes)
      release.resolve()
      await holder
      const result = await pendingPage
      expect(result).not.toBeInstanceOf(Error)
      expect(await db('pages').where({ path: 'racing', visibility: 'public' })).toHaveLength(1)
      expect(await db('assets')).toHaveLength(0)
      expect(await db('durableJobs')).toHaveLength(0)
    } finally {
      release.resolve()
      await holder
      await pendingPage
    }
  })

  it.each([false, true])('rejects oversized Markdown creation atomically, including importer suppression=%s', async skipStorage => {
    const before = await snapshot()
    await expect(Page.createPage({
      path: 'oversized-create',
      locale: 'en',
      user: author,
      content: 'é'.repeat(OKF_MAX_DOCUMENT_BYTES / 2),
      editor: 'markdown',
      description: '',
      visibility: 'public',
      isPublished: true,
      title: 'Oversized create',
      tags: ['must-not-persist'],
      skipStorage
    })).rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413, message: expect.stringContaining('Reduce the content or metadata') })
    expect(await snapshot()).toEqual(before)
    expect(await db('tags').where({ tag: 'must-not-persist' })).toHaveLength(0)
  })

  it('admits the exact rendered Markdown boundary and rolls back oversized content and metadata updates', async () => {
    const saved = await Page.createPage({
      path: 'size-boundary', locale: 'en', user: author, content: 'Initial body',
      editor: 'markdown', description: 'A Unicode résumé', visibility: 'public',
      isPublished: true, title: 'Boundary', tags: ['kept'],
      okfMetadata: { type: 'Reference', vendor_extension: { retained: 'metadata counts too' } }
    })
    await db('pages').where({ id: saved.id }).update({ sourceRevision: 9 })
    const canonicalTag = `canonical-${'x'.repeat(120)}`
    const [canonical] = await db('tags').insert({ tag: canonicalTag, title: canonicalTag }).returning('id')
    if (!canonical) throw new Error('Missing canonical tag fixture')
    await db('tags').insert({ tag: 'alias', title: 'Alias', redirectToId: canonical.id })
    const markdown = (input: StoragePageEncodingInput): string => {
      const encoded = encodeStoragePageDocument(input)
      if (typeof encoded !== 'object' || encoded === null || typeof encoded.markdown !== 'string') throw new Error('Expected canonical Markdown')
      return encoded.markdown
    }
    const prefix = `[Linked concept](/en/index)\n${'é'.repeat(128)}\n`
    const expectedInput = { ...saved, sourceRevision: '10', tags: ['kept', canonicalTag], content: prefix }
    const content = prefix + 'a'.repeat(OKF_MAX_DOCUMENT_BYTES - Buffer.byteLength(markdown(expectedInput), 'utf8'))
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(OKF_MAX_DOCUMENT_BYTES)
    const before = await snapshot()
    const tagsBefore = await db('tags').orderBy('id')
    await expect(Page.updatePage({
      id: saved.id, user: author, content: `${content}a`, tags: ['kept', 'alias']
    })).rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413 })
    expect(await snapshot()).toEqual(before)
    expect(await db('tags').orderBy('id')).toEqual(tagsBefore)

    const admitted = await Page.updatePage({ id: saved.id, user: author, content, tags: ['kept', 'alias'] })
    const encoded = markdown(admitted)
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(OKF_MAX_DOCUMENT_BYTES)
    expect(encoded).toContain('/en/index.concept.md')
    expect(encoded).toContain(canonicalTag)
    expect(String(admitted.sourceRevision)).toBe('10')
    expect(await db('durableJobs')).toHaveLength(2)
    const admittedSnapshot = await snapshot()
    await expect(Page.updatePage({ id: saved.id, user: author, title: 'Boundary!' }))
      .rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413 })
    expect(await snapshot()).toEqual(admittedSnapshot)

    // Simulate a pre-admission legacy row without changing or discarding its jobs.
    await db('pages').where({ id: saved.id }).update({ content: `${content}legacy-oversize`, sourceRevision: 11 })
    expect((await Page.getPageFromDb(saved.id))?.content).toBe(`${content}legacy-oversize`)
    const repaired = await Page.updatePage({ id: saved.id, user: author, content: 'Repaired by shrinking' })
    expect(repaired.content).toBe('Repaired by shrinking')
    expect(Buffer.byteLength(markdown(repaired), 'utf8')).toBeLessThan(OKF_MAX_DOCUMENT_BYTES)
    expect(await db('durableJobs')).toHaveLength(3)
  })

  it.each(['html', 'json'])('does not impose the Markdown document cap on canonical %s pages', async editor => {
    const content = editor === 'html' ? `<p>${'a'.repeat(OKF_MAX_DOCUMENT_BYTES)}</p>` : JSON.stringify({ body: 'a'.repeat(OKF_MAX_DOCUMENT_BYTES) })
    const page = await Page.createPage({
      path: `large-${editor}`, locale: 'en', user: author, content,
      editor, description: '', visibility: 'public', isPublished: true, title: `Large ${editor}`
    })
    expect(page.content).toBe(content)
    if (editor === 'html') {
      const sessionId = 'canonical-oversized-conversion'
      // Bypass only the review worker's smaller input budget: this case protects
      // canonical OKF admission against an oversized, genuinely retained candidate.
      const review = retainPageConversionReview({
        pageId: page.id, sourceRevision: String(page.sourceRevision), editor: 'markdown',
        userId: author.id, source: content, sessionBinding: sessionId
      }, {
        candidate: content.slice('<p>'.length, -'</p>'.length),
        report: {
          warnings: ['Oversized candidate fixture for canonical OKF admission.'],
          differences: { text: false, code: false, links: false, tables: false },
          roundtripSource: content, previewHtml: content, renderer: 'canonical OKF admission fixture'
        }
      })
      const before = await snapshot()
      await expect(Page.convertPage({
        id: page.id, user: author, editor: 'markdown', expectedSourceRevision: String(page.sourceRevision),
        reviewToken: review.reviewToken, sessionId
      }))
        .rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413 })
      expect(await snapshot()).toEqual(before)
    }
  })

  it('retains a removed account contribution revision without carrying its reason into replacement attribution or a later save', async () => {
    await db('users').insert({ id: departingAuthor.id, name: departingAuthor.name, email: departingAuthor.email })
    await db('userGroups').insert({ userId: departingAuthor.id, groupId: 9 })
    const content = '# Source authored before account removal\n'
    const page = await Page.createPage({
      path: 'account-revision-reason', locale: 'en', user: departingAuthor, content,
      editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'Account revision reason', changeReason: 'Reason A'
    })
    const accounts = createAccountAdministrationStore({
      db, definitions: () => [{ key: 'local', useForm: true }], enforceTwoFactor: () => false,
      snapshotPage: input => History.addVersion(input)
    })
    const input = {
      fingerprint: (await accounts.inspect(author, departingAuthor.id)).fingerprint,
      reason: 'Replace departing contributor attribution', replaceId: author.id
    }
    const beforeFailure = await snapshot()
    await db.raw(`
      CREATE FUNCTION reject_contributor_removal() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'controlled contributor removal failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_contributor_removal BEFORE DELETE ON users
      FOR EACH ROW WHEN (OLD.id = 9) EXECUTE FUNCTION reject_contributor_removal();
    `)
    try {
      await expect(accounts.remove(author, departingAuthor.id, input)).rejects.toThrow('controlled contributor removal failure')
      expect(await snapshot()).toEqual(beforeFailure)
      expect(await observer('users').where({ id: departingAuthor.id }).first('id')).toEqual({ id: departingAuthor.id })
    } finally {
      await db.raw('DROP TRIGGER reject_contributor_removal ON users; DROP FUNCTION reject_contributor_removal()')
    }
    await accounts.remove(author, departingAuthor.id, input)
    expect(await observer('users').where({ id: departingAuthor.id }).first('id')).toBeUndefined()
    expect(await Page.getPageFromDb(page.id)).toMatchObject({
      content, sourceRevision: '2', authorId: author.id, creatorId: author.id, changeReason: null, visibility: 'public', ownerId: null
    })
    const history = await History.getHistory({ pageId: page.id, requester: author })
    expect(history.trail).toMatchObject([{ sourceRevision: '1', changeReason: 'Reason A', authorId: author.id }])
    expect(await History.getVersion({ pageId: page.id, versionId: history.trail[0]!.versionId, requester: author })).toMatchObject({
      versionId: history.trail[0]!.versionId, content, sourceRevision: '1', changeReason: 'Reason A', authorId: author.id
    })
    await Page.updatePage({ id: page.id, user: author, content: '# A later ordinary save', expectedSourceRevision: '2' })
    expect(await Page.getPageFromDb(page.id)).toMatchObject({ sourceRevision: '3', changeReason: null, content: '# A later ordinary save' })
    expect(await observer('pageHistory').where({ pageId: page.id }).orderBy('sourceRevision').select('sourceRevision', 'changeReason', 'content')).toEqual([
      { sourceRevision: '1', changeReason: 'Reason A', content }, { sourceRevision: '2', changeReason: null, content }
    ])
    const laterJob = (await db('durableJobs')).map(job => JSON.parse(job.payload)).find(job => job.sourceRevision === '3')
    expect(laterJob).toMatchObject({ entityId: page.id, sourceRevision: '3' })
    expect(laterJob).not.toHaveProperty('changeReason')
  })

  it.each(['page features', 'branding', 'authoritative OKF'])('commits changed and cleared reasons despite unchanged %s', async kind => {
    const features = { schemaVersion: 1 as const, linksVisible: true, ratingsAllowed: false, lastEditorVisible: true }
    const content = '# Source retained through metadata-only reason saves\n'
    const page = await Page.createPage({
      path: 'metadata-reasons', locale: 'en', user: author, content,
      editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'Metadata reasons',
      pageFeatures: features, okfMetadata: { type: 'Reference', status: 'stable' }, changeReason: 'Reason A'
    })
    const unchanged = kind === 'page features' ? { pageFeatures: features }
      : kind === 'branding' ? { branding: null }
        : { okfMetadata: page.extra.okf as OkfMetadata, replaceOkfMetadata: true }
    await Page.updatePage({ id: page.id, user: author, ...unchanged, expectedSourceRevision: '1', changeReason: '  Reason B  ' })
    expect(await Page.getPageFromDb(page.id)).toMatchObject({ content, sourceRevision: '2', changeReason: 'Reason B' })
    await Page.updatePage({ id: page.id, user: author, ...unchanged, expectedSourceRevision: '2', changeReason: '   ' })
    expect(await Page.getPageFromDb(page.id)).toMatchObject({ content, sourceRevision: '3', changeReason: null })
    const history = await History.getHistory({ pageId: page.id, requester: author })
    expect(history.trail).toMatchObject([
      { sourceRevision: '2', changeReason: 'Reason B' },
      { sourceRevision: '1', changeReason: 'Reason A' }
    ])
    for (const revision of history.trail) {
      expect(await History.getVersion({ pageId: page.id, versionId: revision.versionId, requester: author })).toMatchObject({
        versionId: revision.versionId, content, sourceRevision: revision.sourceRevision, changeReason: revision.changeReason
      })
    }
    const jobs = (await db('durableJobs')).map(job => JSON.parse(job.payload)).sort((left, right) => Number(left.sourceRevision) - Number(right.sourceRevision))
    expect(jobs.map(job => [job.sourceRevision, job.changeReason])).toEqual([['1', 'Reason A'], ['2', 'Reason B'], ['3', undefined]])
    const beforeNoOp = await snapshot()
    await Page.updatePage({ id: page.id, user: author, ...unchanged, expectedSourceRevision: '3', changeReason: '   ' })
    await Page.updatePage({ id: page.id, user: author, ...unchanged, expectedSourceRevision: '3' })
    expect(await snapshot()).toEqual(beforeNoOp)
  })

  it('archives a reasoned revision even when an editor conversion preserves the source format and bytes', async () => {
    const content = '# Exact Markdown\n\nPreserve these source bytes.\n'
    const page = await Page.createPage({
      path: 'same-format-conversion', locale: 'en', user: author, content,
      editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'Same-format conversion', changeReason: 'Original editor reason'
    })
    await Page.convertPage({ id: page.id, user: author, editor: 'visual-markdown', expectedSourceRevision: '1' })
    expect(await observer('pages').where({ id: page.id }).first('content', 'sourceRevision', 'changeReason', 'editorKey')).toEqual({
      content, sourceRevision: '2', changeReason: null, editorKey: 'visual-markdown'
    })
    const archived = await observer('pageHistory').where({ pageId: page.id, sourceRevision: '1' }).first('id')
    const trail = await History.getHistory({ pageId: page.id, requester: author })
    expect(trail).toMatchObject({
      total: 1, trail: [{ versionId: archived.id, sourceRevision: '1', changeReason: 'Original editor reason' }]
    })
    expect(await History.getVersion({ pageId: page.id, versionId: archived.id, requester: author })).toMatchObject({
      versionId: archived.id, content, sourceRevision: '1', changeReason: 'Original editor reason', editor: 'markdown'
    })
  })

  it('keeps reason-only saves, concurrent CAS, failed admission and restore bound to their committed revisions', async () => {
    const page = await Page.createPage({
      path: 'revision-reasons', locale: 'en', user: author, content: '# Original',
      editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'Revision reasons', changeReason: 'Original reason'
    })
    await Page.updatePage({ id: page.id, user: author, expectedSourceRevision: '1', changeReason: 'Reason-only correction' })
    expect(await observer('pages').where({ id: page.id }).first('content', 'sourceRevision', 'changeReason')).toEqual({
      content: '# Original', sourceRevision: '2', changeReason: 'Reason-only correction'
    })
    const competing = await Promise.allSettled([
      Page.updatePage({ id: page.id, user: author, content: '# Left', expectedSourceRevision: '2', changeReason: 'Left reason' }),
      Page.updatePage({ id: page.id, user: author, content: '# Right', expectedSourceRevision: '2', changeReason: 'Right reason' })
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = competing.find(result => result.status === 'rejected')
    if (rejected?.status !== 'rejected') throw new Error('Expected exactly one stale canonical writer')
    expect(rejected.reason).toMatchObject({ status: 409 })
    const winner = await observer('pages').where({ id: page.id }).first()
    expect(winner.sourceRevision).toBe('3')
    expect(winner.changeReason).toBe(winner.content === '# Left' ? 'Left reason' : 'Right reason')
    const beforeFailure = await snapshot()
    await db.raw(`
      CREATE FUNCTION reject_reason_admission() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'controlled reason admission failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_reason_admission BEFORE INSERT ON "durableJobs"
      FOR EACH ROW EXECUTE FUNCTION reject_reason_admission();
    `)
    try {
      await expect(Page.updatePage({
        id: page.id, user: author, content: '# Failed', expectedSourceRevision: '3', changeReason: 'Must roll back'
      })).rejects.toThrow('controlled reason admission failure')
      expect(await snapshot()).toEqual(beforeFailure)
    } finally {
      await db.raw('DROP TRIGGER reject_reason_admission ON "durableJobs"; DROP FUNCTION reject_reason_admission()')
    }
    await Page.updatePage({ id: page.id, user: author, content: '# Retry', expectedSourceRevision: '3', changeReason: 'Retry reason' })
    const firstVersion = await db('pageHistory').where({ pageId: page.id, sourceRevision: '1' }).first('id')
    await operations.restore({ requester: author, pageId: page.id, versionId: firstVersion.id, expectedSourceRevision: '4' })
    expect(await observer('pages').where({ id: page.id }).first('content', 'sourceRevision', 'changeReason')).toEqual({
      content: '# Original', sourceRevision: '5', changeReason: null
    })
    expect(await db('pageHistory').where({ pageId: page.id }).orderBy('sourceRevision').select('sourceRevision', 'changeReason')).toEqual([
      { sourceRevision: '1', changeReason: 'Original reason' },
      { sourceRevision: '2', changeReason: 'Reason-only correction' },
      { sourceRevision: '3', changeReason: winner.changeReason },
      { sourceRevision: '4', changeReason: 'Retry reason' }
    ])
    const jobs = (await db('durableJobs')).map(job => JSON.parse(job.payload)).sort((left, right) => Number(left.sourceRevision) - Number(right.sourceRevision))
    expect(jobs.map(job => [job.sourceRevision, job.changeReason])).toEqual([
      ['1', 'Original reason'], ['2', 'Reason-only correction'], ['3', winner.changeReason], ['4', 'Retry reason'], ['5', undefined]
    ])
  })

  it('keeps oversized private Markdown repairable but rejects making it public before it is exportable', async () => {
    const page = await Page.createPage({
      path: 'private-size', locale: 'en', user: author, content: 'a'.repeat(OKF_MAX_DOCUMENT_BYTES),
      editor: 'markdown', description: '', visibility: 'private', isPublished: true, title: 'Private size'
    })
    const before = await snapshot()
    await expect(Page.changeVisibility({ id: page.id, user: author, visibility: 'public', confirmPublication: true }))
      .rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413 })
    expect(await snapshot()).toEqual(before)
    await Page.updatePage({ id: page.id, user: author, content: 'Private repair', tags: ['repaired'] })
    const published = await Page.changeVisibility({ id: page.id, user: author, visibility: 'public', confirmPublication: true })
    expect(published.visibility).toBe('public')
    expect(await db('durableJobs')).toHaveLength(1)
  })
  it('rejects equal-byte ordinary Git asset adoption, retains the reviewed old owner, then atomically renames changed bytes on the same native id', async () => {
    const bytes = Array.from({ length: 24 }, (_, index) => `Canonical ordinary source line ${index}.`).join('\n')
    await withGitContentSource({ 'old.bin': bytes }, async ({ root, source, writer, plugin, context, config, git, preview }) => {
      expectImportSucceeded(await importGitFromDisk(root, config))
      const original = await db('assets').where({ filename: 'old.bin' }).first('*')
      expect(original.metadata.storage_import).toMatchObject({ assetId: original.id, sourcePath: 'old.bin' })
      const replacement = await prepareUpload('old.bin', true, Buffer.from(bytes))
      await replacement.run()
      const current = await db('assets').where({ id: original.id }).first('*')
      expect(current.metadata.storage_import).toBeUndefined()
      expect(Buffer.from((await db('assetData').where({ id: current.id }).first('data')).data).toString()).toBe(bytes)
      git(writer, 'mv', '--', 'old.bin', 'new.bin')
      git(writer, 'commit', '--quiet', '-m', 'Rename an unassociated equal-byte native asset')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const untouched = await snapshot()
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await plugin.sync!.call(context as never)
        expect(rejected).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'old.bin', ok: false, outcome: 'conflict' })]))
        expect(await snapshot()).toEqual(untouched)
      }
      const inventory = await preview()
      const old = inventory.gitContent!.find(entry => entry.sourcePath === 'old.bin')!
      expect(old.owner).toMatchObject({ id: original.id, sourceOwned: false, sha256: createHash('sha256').update(bytes).digest('hex') })
      config.dotContentReview = serializeGitContentChoices(old.sourceKey, [{
        sourcePath: old.sourcePath, sourceSha256: old.sourceSha256, sourceRevision: old.sourceRevision,
        sourceAvailable: true, owner: old.owner, action: 'retain'
      }])
      expectImportSucceeded(await plugin.sync!.call(context as never))
      expect((await db('assets').where({ id: original.id }).first('filename')).filename).toBe('old.bin')
      const added = await db('assets').where({ filename: 'new.bin' }).first('*')
      expect(added.id).not.toBe(original.id)
      expect(added.metadata.storage_import).toMatchObject({ assetId: added.id, sourcePath: 'new.bin' })
      const associated = (await preview()).gitContent!.find(entry => entry.sourcePath === 'old.bin')!
      config.dotContentReview = serializeGitContentChoices(associated.sourceKey, [{
        sourcePath: associated.sourcePath, sourceSha256: associated.sourceSha256, sourceRevision: associated.sourceRevision,
        sourceAvailable: true, owner: associated.owner, action: 'retain'
      }])
      const changed = `${bytes}\nIncoming changed bytes remain bound to the native rename.`
      git(writer, 'mv', '--', 'new.bin', 'finished.bin')
      await writeFile(path.join(writer, 'finished.bin'), changed)
      git(writer, 'add', '--all')
      git(writer, 'commit', '--quiet', '-m', 'Rename and change accepted source bytes')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const beforeInterrupted = await snapshot()
      const failUpload = vi.spyOn(Asset, 'upload').mockRejectedValueOnce(new Error('Interrupt before the native rename write'))
      try {
        const interrupted = await plugin.sync!.call(context as never)
        expect(interrupted).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'finished.bin', ok: false, outcome: 'conflict' })]))
        expect(await snapshot()).toEqual(beforeInterrupted)
        expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).not.toBe('')
      } finally { failUpload.mockRestore() }
      expectImportSucceeded(await plugin.importAll!.call(context as never))
      expect(() => git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toThrow()
      const renamed = await db('assets').where({ filename: 'finished.bin' }).first('*')
      expect(renamed.id).toBe(added.id)
      expect(renamed.metadata.storage_import).toMatchObject({
        assetId: added.id, sourcePath: 'finished.bin', sourceSha256: createHash('sha256').update(changed).digest('hex'),
        assetSha256: createHash('sha256').update(changed).digest('hex')
      })
      expect(Buffer.from((await db('assetData').where({ id: renamed.id }).first('data')).data).toString()).toBe(changed)
      expect(await db('assets').where({ filename: 'new.bin' })).toEqual([])
      expect(await readFile(path.join(source, 'finished.bin'), 'utf8')).toBe(changed)
    })
  })

  it('uses one canonical pooled connection plus independent Git serialization through native authority, commit and cache publication', async () => {
    await withGitContentSource({ '.pool/asset.bin': 'Pool-one native source bytes' }, async ({ root, config, preview }) => {
      const inventory = await preview()
      const entry = inventory.gitContent![0]!
      const review: StorageImportReview = { scope: inventory.scope, snapshot: inventory.snapshot, mappings: [],
        gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }] }
      const single = knexModule({ client: 'pg', connection: connection ?? undefined,
        acquireConnectionTimeout: 1000, pool: { min: 0, max: 1 } })
      const originalKnex = globalThis.WIKI.models.knex
      const group = await db('groups').where({ id: 1 }).first('permissions')
      globalThis.WIKI.models.knex = single
      for (const model of [Asset, Folder, Page]) model.knex(single)
      const { promise: enteredTransaction, resolve: entered } = Promise.withResolvers<void>()
      const { promise: continueTransaction, resolve: resume } = Promise.withResolvers<void>()
      const joined = vi.fn(async (transaction: Knex.Transaction) => {
        expect(single.client.pool.numUsed()).toBe(1)
        expect(observer.client.pool.numUsed()).toBe(1)
        expect((await transaction.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBeGreaterThan(0)
        entered()
        await continueTransaction
      })
      const importing = withStorageImportReview(review, async () => { await single.raw('SELECT 1') },
        () => importGitFromDisk(root, config), joined)
      try {
        await Promise.race([enteredTransaction, importing.then(() => { throw new Error('Import did not enter its same-transaction native authority guard') })])
        expect(await observer('assets')).toEqual([])
        expect(await observer('assetFolders')).toEqual([])
        await expect(Promise.resolve(observer.transaction(async transaction => {
          await transaction.raw("SET LOCAL lock_timeout = '50ms'")
          await transaction('groups').where({ id: 1 }).update({ permissions: '[]' })
        }))).rejects.toMatchObject({ code: '55P03' })
        resume()
        expectImportSucceeded(await importing)
        expect(single.client.pool.numUsed()).toBe(0)
        const asset = await single('assets').first('*')
        expect(asset.metadata.storage_import).toMatchObject({ assetId: asset.id, sourcePath: '.pool/asset.bin' })
        expect(await readFile(path.join(directory, 'data', 'cache', `${asset.hash}.dat`), 'utf8')).toBe('Pool-one native source bytes')
        await observer('groups').where({ id: 1 }).update({ permissions: '[]' })
        const fresh = await preview()
        const owned = fresh.gitContent![0]!
        const removal: StorageImportReview = { scope: fresh.scope, snapshot: fresh.snapshot, mappings: [],
          gitContent: [{ sourcePath: owned.sourcePath, sourceSha256: owned.sourceSha256, owner: owned.owner, action: 'remove' }] }
        const beforeDenied = await snapshot()
        const denied = await withStorageImportReview(removal, async () => {},
          () => importGitFromDisk(root, config), joined)
        expect(denied).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: '.pool/asset.bin', ok: false, outcome: 'conflict' })]))
        expect(await snapshot()).toEqual(beforeDenied)
        expect(single.client.pool.numUsed()).toBe(0)
      } finally {
        resume()
        await importing.catch(() => {})
        await observer('groups').where({ id: 1 }).update({ permissions: JSON.stringify(group.permissions) })
        globalThis.WIKI.models.knex = originalKnex
        for (const model of [Asset, Folder, Page]) model.knex(db)
        await single.destroy()
      }
    })
  })

  it('binds actual staged raw SVG bytes and post-sanitization native bytes to the same asset id before deliberate removal', async () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>'
    await withGitContentSource({ '.legitimate.svg': raw }, async ({ root, source, config, preview }) => {
      const sanitizeSvg = (await import('../../jobs/sanitize-svg.ts')).default
      const oldScan = globalThis.WIKI.config.uploads.scanSVG
      const register = globalThis.WIKI.scheduler.registerJob
      globalThis.WIKI.config.uploads.scanSVG = true
      const worker = vi.spyOn(globalThis.WIKI.scheduler, 'registerJob').mockImplementation((async (job: { name: string }, data: { path: string }) => {
        if (job.name === 'sanitize-svg') return { finished: sanitizeSvg(data) }
        return register.call(globalThis.WIKI.scheduler, job, data)
      }) as never)
      try {
        const inventory = await preview()
        const entry = inventory.gitContent![0]!
        const include: StorageImportReview = { scope: inventory.scope, snapshot: inventory.snapshot, mappings: [],
          gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }] }
        expectImportSucceeded(await withStorageImportReview(include, async () => {},
          () => importGitFromDisk(root, config)))
        const asset = await db('assets').first('*')
        const stored = Buffer.from((await db('assetData').where({ id: asset.id }).first('data')).data)
        expect(stored.toString()).not.toMatch(/onload|<script/u)
        expect(stored.toString()).toContain('<rect')
        expect(stored.toString()).not.toBe(raw)
        expect(asset.metadata.storage_import).toMatchObject({
          assetId: asset.id, sourcePath: '.legitimate.svg', sourceSha256: createHash('sha256').update(raw).digest('hex'),
          assetSha256: createHash('sha256').update(stored).digest('hex')
        })
        expect(await readFile(path.join(source, '.legitimate.svg'), 'utf8')).toBe(raw)
        const fresh = await preview()
        const owned = fresh.gitContent![0]!
        expect(owned.owner).toMatchObject({ id: asset.id, sourceOwned: true, sha256: createHash('sha256').update(stored).digest('hex') })
        const removal: StorageImportReview = { scope: fresh.scope, snapshot: fresh.snapshot, mappings: [],
          gitContent: [{ sourcePath: owned.sourcePath, sourceSha256: owned.sourceSha256, owner: owned.owner, action: 'remove' }] }
        expectImportSucceeded(await withStorageImportReview(removal, async () => {},
          () => importGitFromDisk(root, config)))
        expect(await db('assets').where({ id: asset.id })).toEqual([])
        expect(await db('assetData').where({ id: asset.id })).toEqual([])
      } finally {
        worker.mockRestore()
        globalThis.WIKI.config.uploads.scanSVG = oldScan
      }
    })
  })

  it('refuses changed bytes at the actual native staging boundary before ownership checks or canonical writes', async () => {
    const bytes = 'Reviewed asset input remains immutable'
    await withGitContentSource({ '.race/asset.bin': bytes }, async ({ root, source, config, preview }) => {
      const inventory = await preview()
      const entry = inventory.gitContent![0]!
      const review: StorageImportReview = { scope: inventory.scope, snapshot: inventory.snapshot, mappings: [],
        gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }] }
      const substituted = await prepareUpload('.unused.bin', true, Buffer.alloc(Buffer.byteLength(bytes), 120))
      const originalUpload = Asset.upload
      let checkedOwner = false
      const upload = vi.spyOn(Asset, 'upload').mockImplementation(async opts => {
        expect(opts.expectedImportSha256).toBe(entry.sourceSha256)
        const nativeReview = opts.importReview!
        return originalUpload.call(Asset, { ...opts, path: substituted.source, importReview: {
          ...nativeReview, check: async transaction => { checkedOwner = true; return nativeReview.check(transaction) }
        } })
      })
      try {
        const before = await snapshot()
        const rejected = await withStorageImportReview(review, async () => {},
          () => importGitFromDisk(root, config))
        expect(rejected).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: '.race/asset.bin', ok: false, outcome: 'conflict', error: expect.stringContaining('reviewed raw asset source changed') })]))
        expect(checkedOwner).toBe(false)
        expect(await db('assetFolders')).toEqual([])
        expect(commonDisk.assetFolders === null || Object.keys(commonDisk.assetFolders).length === 0).toBe(true)
        expect(await snapshot()).toEqual(before)
        expect(await readFile(path.join(source, '.race/asset.bin'), 'utf8')).toBe(bytes)
      } finally { upload.mockRestore() }
    })
  })

  it('retains without adopting a legacy dot asset, then explicitly imports/remaps the same native id and removes only its fresh exact owner', async () => {
    const upload = await prepareUpload('.legacy.bin', true)
    await upload.run()
    await withGitContentSource({ '.legacy.bin': upload.bytes.toString() }, async ({ root, config, preview }) => {
      const inventory = await preview()
      const entry = inventory.gitContent![0]!
      const retain: StorageImportReview = { scope: inventory.scope, snapshot: inventory.snapshot, mappings: [],
        gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: entry.owner, action: 'retain' }] }
      expectImportSucceeded(await withStorageImportReview(retain, async () => {},
        () => importGitFromDisk(root, config)))
      const unassociated = await preview()
      const kept = unassociated.gitContent![0]!
      expect(kept.owner?.sourceOwned).toBe(false)
      expect((await db('assets').where({ id: kept.owner!.id }).first('metadata')).metadata.storage_import).toBeUndefined()
      const accept: StorageImportReview = { scope: unassociated.scope, snapshot: unassociated.snapshot, mappings: [],
        gitContent: [{ sourcePath: kept.sourcePath, sourceSha256: kept.sourceSha256, owner: kept.owner, action: 'include' }] }
      expectImportSucceeded(await withStorageImportReview(accept, async () => {},
        () => importGitFromDisk(root, config)))
      const associated = await preview()
      const owned = associated.gitContent![0]!
      const remap: StorageImportReview = { scope: associated.scope, snapshot: associated.snapshot, mappings: [],
        gitContent: [{ sourcePath: owned.sourcePath, sourceSha256: owned.sourceSha256, owner: owned.owner, action: 'remap', destinationPath: 'reviewed/legacy.bin' }] }
      if (owned.owner === null) throw new Error('Missing accepted native asset owner')
      const oldHash = createHash('sha1').update(owned.owner.path).digest('hex')
      const destinationHash = createHash('sha1').update('reviewed/legacy.bin').digest('hex')
      const cachePath = path.join(directory, 'data', 'cache')
      await writeFile(path.join(cachePath, `${destinationHash}.dat`), 'Residual bytes from an unrelated former destination')
      expect(await readFile(path.join(cachePath, `${oldHash}.dat`))).toEqual(upload.bytes)
      expectImportSucceeded(await withStorageImportReview(remap, async () => {},
        () => importGitFromDisk(root, config)))
      const asset = await db('assets').where({ id: owned.owner!.id }).first('*')
      expect(asset.filename).toBe('legacy.bin')
      expect((await Folder.getHierarchy(asset.folderId)).map(folder => folder.slug)).toEqual(['reviewed'])
      expect(Buffer.from((await db('assetData').where({ id: asset.id }).first('data')).data)).toEqual(upload.bytes)
      expect(asset.metadata.storage_import).toMatchObject({ assetId: asset.id, sourcePath: '.legacy.bin', mapped: true })
      expect(asset.hash).toBe(destinationHash)
      await expect(readFile(path.join(cachePath, `${oldHash}.dat`))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(path.join(cachePath, `${destinationHash}.dat`))).rejects.toMatchObject({ code: 'ENOENT' })
      const app = express()
      app.get('/reviewed/legacy.bin', (_request, response) => Asset.getAsset('reviewed/legacy.bin', response))
      const server = app.listen(0, '127.0.0.1')
      try {
        await once(server, 'listening')
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('Missing native asset consumer address')
        for (let delivery = 0; delivery < 2; delivery++) {
          const response = await fetch(`http://127.0.0.1:${address.port}/reviewed/legacy.bin`)
          expect(response.status).toBe(200)
          expect(Buffer.from(await response.arrayBuffer())).toEqual(upload.bytes)
        }
        expect(await readFile(path.join(cachePath, `${destinationHash}.dat`))).toEqual(upload.bytes)
      } finally {
        server.closeAllConnections()
        const closed = Promise.withResolvers<void>()
        server.close(error => error ? closed.reject(error) : closed.resolve())
        await closed.promise
      }
      await expect(withStorageImportReview(remap, async () => {},
        () => importGitFromDisk(root, config))).rejects.toThrow(/stale|ownership changed/)
      const fresh = await preview()
      const mapped = fresh.gitContent![0]!
      expect(mapped.owner).toMatchObject({ id: asset.id, path: 'reviewed/legacy.bin', sourceOwned: true })
      const remove: StorageImportReview = { scope: fresh.scope, snapshot: fresh.snapshot, mappings: [],
        gitContent: [{ sourcePath: mapped.sourcePath, sourceSha256: mapped.sourceSha256, owner: mapped.owner, action: 'remove' }] }
      expectImportSucceeded(await withStorageImportReview(remove, async () => {},
        () => importGitFromDisk(root, config)))
      expect(await db('assets').where({ id: asset.id })).toEqual([])
      expect(await db('assetData').where({ id: asset.id })).toEqual([])
    })
  })

  it.each(['body', 'title'] as const)('does not adopt a concurrent native %s revision after its own Git rename commits', async field => {
    const bytes = Array.from({ length: 24 }, (_, index) => `Original canonical source line ${index}.`).join('\n')
    await withGitContentSource({ 'guide.md': bytes }, async ({ root, writer, plugin, context, config, git }) => {
      expectImportSucceeded(await importGitFromDisk(root, config))
      const original = await db('pages').where({ path: 'guide' }).first('*')
      const originalOwner = await expectAcceptedOwner(original.id, 'page.created')
      const originalMove = Page.movePage
      const move = vi.spyOn(Page, 'movePage').mockImplementation(async opts => {
        expect(opts.expectedSourceRevision).toBe(originalOwner.nativeRevision)
        const result = await originalMove.call(Page, opts)
        const moved = await db('pages').where({ path: 'renamed', localeCode: 'en' }).first('*')
        const movedOwner = await expectAcceptedOwner(moved.id, 'page.moved')
        expect(movedOwner.moveBinding).toMatchObject({
          phase: 'moved', previousNativeRevision: originalOwner.nativeRevision, moveNativeRevision: String(moved.sourceRevision)
        })
        await Page.updatePage({
          id: moved.id, user: author, expectedSourceRevision: String(moved.sourceRevision), skipStorage: true,
          ...(field === 'body' ? { content: 'Concurrent native writer owns this revision' } : { title: 'Concurrent native title owns this revision' })
        })
        expect(await ownerFor(moved.id)).toEqual(movedOwner)
        return result
      })
      try {
        git(writer, 'mv', '--', 'guide.md', 'renamed.md')
        await writeFile(path.join(writer, 'renamed.md'), `${bytes}\nIncoming external change must not overwrite the concurrent writer.`)
        git(writer, 'add', '--all')
        git(writer, 'commit', '--quiet', '-m', 'Rename before a concurrent canonical update')
        git(writer, 'push', '--quiet', 'origin', 'main')
        const result = await plugin.sync!.call(context as never)
        expect(move).toHaveBeenCalledTimes(1)
        expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'renamed.md', ok: false })]))
        const changed = await db('pages').where({ path: 'renamed' }).first('*')
        expect(changed).toMatchObject(field === 'body'
          ? { content: 'Concurrent native writer owns this revision' }
          : { content: bytes, title: 'Concurrent native title owns this revision' })
        expect(storagePageImportOwnerMatches(await ownerFor(changed.id), changed)).toBe(false)
        const beforeReplay = await snapshot()
        for (const work of [() => plugin.sync!.call(context as never), () => plugin.importAll!.call(context as never)]) {
          const replay = await work().catch(error => error)
          expect(replay instanceof Error || Array.isArray(replay) && replay.some((item: { ok?: boolean }) => item.ok === false)).toBe(true)
          expect(await snapshot()).toEqual(beforeReplay)
        }
        expect(move).toHaveBeenCalledTimes(1)
      } finally { move.mockRestore() }
    })
  })

  it('does not grant storage source ownership to human or Agent metadata claims through ordinary operations', async () => {
    const forged = { sourceKey: 'a'.repeat(64), sourcePath: 'forged.md', sourceSha256: 'b'.repeat(64), locationKey: 'c'.repeat(64), mapped: true }
    await operations.create({ requester: author, input: {
      path: 'forged', locale: 'en', title: 'Ordinary authored page', description: '', content: 'Human canonical content', editor: 'markdown',
      visibility: 'public', isPublished: true, tags: [], okfProducer: 'import:git', skipStorage: true, storageImportMapping: forged,
      okfMetadata: { type: 'Reference', vendor_extension: { authored: true }, 'x-wiki': { authored: 'human', storage_import: forged } }
    } })
    const created = await db('pages').where({ path: 'forged' }).first('*')
    expect(await loadStoragePageImportOwners(db, { pageIds: [created.id], limit: 1 })).toEqual([])
    expect(created.extra.okf['x-wiki'].storage_import).toBeUndefined()
    expect(created.extra.okf).toMatchObject({
      vendor_extension: { authored: true }, 'x-wiki': { authored: 'human' }, generated: { by: `human:${author.id}` }
    })
    expect(await db('durableJobs').where({ type: 'storage-mutation' }).first('id')).toBeDefined()
    await operations.update(withOkfProducer({ requester: author, input: {
      id: created.id, expectedSourceRevision: String(created.sourceRevision), okfProducer: 'import:disk', skipStorage: true,
      okfMetadata: { type: 'Procedure', vendor_extension: { authored: 'agent' }, 'x-wiki': { authored: 'agent', storage_import: forged } }
    } }, 'agent:native-authority-test'))
    const updated = await db('pages').where({ id: created.id }).first('*')
    expect(await loadStoragePageImportOwners(db, { pageIds: [created.id], limit: 1 })).toEqual([])
    expect(updated.extra.okf['x-wiki'].storage_import).toBeUndefined()
    expect(updated.extra.okf).toMatchObject({
      type: 'Procedure', vendor_extension: { authored: 'agent' }, 'x-wiki': { authored: 'agent' },
      generated: { by: 'agent:native-authority-test' }
    })
    await withImportSource({ 'forged.md': 'External source must not adopt a forged ordinary page' }, async root => {
      const before = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/Existing page ownership is unreviewed/u)
      expect(await snapshot()).toEqual(before)
    })
  })

  it('preserves the accepted native ledger through forged or scrubbed metadata, history restore and untrusted move options', async () => {
    const firstSource = [
      '---', 'type: Reference', 'x-wiki:', '  authored: original', '  storage_import:',
      `    sourceKey: ${'a'.repeat(64)}`, '    sourcePath: foreign.md', `    sourceSha256: ${'b'.repeat(64)}`,
      `    locationKey: ${'c'.repeat(64)}`, '    mapped: true', '---', '', 'First imported canonical body'
    ].join('\n')
    await withImportSource({ 'en/receipt.md': firstSource }, async (root, source) => {
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      const imported = await db('pages').where({ path: 'receipt' }).first('*')
      const originalOwner = await expectAcceptedOwner(imported.id, 'page.created')
      expect(originalOwner).toMatchObject({
        sourcePath: 'en/receipt.md', sourceSha256: createHash('sha256').update(firstSource).digest('hex'), mapped: false
      })
      expect(originalOwner.sourceKey).not.toBe('a'.repeat(64))
      expect(imported.extra.okf['x-wiki'].storage_import).toBeUndefined()
      const forged = {
        sourceKey: 'd'.repeat(64), sourcePath: 'foreign.md', sourceSha256: 'e'.repeat(64),
        locationKey: originalOwner.locationKey, mapped: true
      }
      await operations.update({ requester: author, input: {
        id: imported.id, expectedSourceRevision: String(imported.sourceRevision), okfProducer: 'import:git', skipStorage: true,
        okfMetadata: { type: 'Procedure', vendor_extension: { authored: 'kept' }, 'x-wiki': { authored: 'edited', storage_import: forged } }
      } })
      const edited = await db('pages').where({ id: imported.id }).first('*')
      expect(await ownerFor(imported.id)).toEqual(originalOwner)
      expect(storagePageImportOwnerMatches(originalOwner, edited)).toBe(false)
      expect(edited.extra.okf).toMatchObject({
        type: 'Procedure', vendor_extension: { authored: 'kept' }, 'x-wiki': { authored: 'edited' }
      })
      expect(edited.extra.okf['x-wiki'].storage_import).toBeUndefined()
      await operations.update({ requester: author, input: {
        id: imported.id, expectedSourceRevision: String(edited.sourceRevision),
        okfMetadata: { type: 'Reference', 'x-wiki': { authored: 'replacement-without-receipt' } }
      } })
      const replaced = await db('pages').where({ id: imported.id }).first('*')
      expect(await ownerFor(imported.id)).toEqual(originalOwner)
      expect(replaced.extra.okf['x-wiki'].authored).toBe('replacement-without-receipt')
      expect(replaced.extra.okf.vendor_extension).toBeUndefined()
      const secondSource = firstSource.replace('authored: original', 'authored: second').replace('First imported canonical body', 'Second imported canonical body')
      await writeFile(path.join(source, 'en/receipt.md'), secondSource)
      const beforeConflict = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership|accepted native revision/u)
      expect(await snapshot()).toEqual(beforeConflict)
      const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'disk', configurationRevision: 'native-metadata-replacement' }
      const preview = await buildStorageImportPreview(await collectStorageEntries(root), {}, 'DISK', scope)
      const review: StorageImportReview = { scope, snapshot: preview.snapshot, mappings: [{
        sourcePath: 'en/receipt.md', sourceSha256: createHash('sha256').update(secondSource).digest('hex'),
        locale: 'en', path: 'receipt', existingPageId: imported.id, expectedSourceRevision: String(replaced.sourceRevision)
      }] }
      expectImportSucceeded(await withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK' })))
      const refreshed = await db('pages').where({ id: imported.id }).first('*')
      const currentOwner = await expectAcceptedOwner(imported.id, 'page.updated')
      expect(currentOwner.sourceSha256).toBe(createHash('sha256').update(secondSource).digest('hex'))
      const firstVersion = await db('pageHistory').where({ pageId: imported.id, sourceRevision: imported.sourceRevision }).first('id', 'extra')
      const historyBefore = structuredClone(firstVersion.extra)
      await operations.restore({
        requester: author, pageId: imported.id, versionId: firstVersion.id, expectedSourceRevision: String(refreshed.sourceRevision)
      })
      const restored = await db('pages').where({ id: imported.id }).first('*')
      expect(restored.content).toBe('First imported canonical body')
      expect(restored.extra.okf['x-wiki'].authored).toBe('original')
      expect(await ownerFor(imported.id)).toEqual(currentOwner)
      expect(storagePageImportOwnerMatches(currentOwner, restored)).toBe(false)
      expect((await db('pageHistory').where({ id: firstVersion.id }).first('extra')).extra).toEqual(historyBefore)
      await operations.move({ requester: author, input: {
        id: imported.id, destinationPath: 'moved-receipt', destinationLocale: 'en', expectedSourceRevision: String(restored.sourceRevision),
        okfProducer: 'import:git', skipStorage: true, storageImportMapping: forged
      } })
      const moved = await db('pages').where({ id: imported.id }).first('*')
      expect(moved.path).toBe('moved-receipt')
      expect(await ownerFor(imported.id)).toEqual(currentOwner)
      expect(storagePageImportOwnerMatches(currentOwner, moved)).toBe(false)
    })
  })

  it('exports authored OKF without serializing or mutating forged local claims, native ownership or historical snapshots', async () => {
    const raw = ['---', 'type: Reference', 'vendor_extension:', '  authored: kept', 'x-wiki:', '  authored: kept', '---', '', 'Imported body'].join('\n')
    await withImportSource({ 'en/export-receipt.md': raw }, async root => {
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      const page = await Page.getPageFromDb({ path: 'export-receipt', locale: 'en', visibility: 'public', ownerId: null })
      if (!page) throw new Error('Missing imported canonical export page')
      const owner = await expectAcceptedOwner(page.id, 'page.created')
      await Page.updatePage({ id: page.id, user: author, title: 'Edited title', expectedSourceRevision: String(page.sourceRevision), skipStorage: true })
      const current = await Page.getPageFromDb(page.id)
      if (!current) throw new Error('Missing canonical export revision')
      const before = await snapshot()
      const canonicalBefore = structuredClone(current.extra)
      const encoded = encodeStoragePageDocument(current)
      if (typeof encoded !== 'object' || encoded === null || typeof encoded.markdown !== 'string') throw new Error('Expected encoded native Markdown')
      expect(encoded.markdown).not.toContain('storage_import:')
      expect(encoded).toMatchObject({ metadata: { vendor_extension: { authored: 'kept' }, 'x-wiki': { authored: 'kept' } } })
      for (const claim of [
        { sourceKey: owner.sourceKey, sourcePath: owner.sourcePath, sourceSha256: 'b'.repeat(64), locationKey: owner.locationKey, mapped: owner.mapped },
        { sourceKey: 'forged', sourcePath: 'foreign.md', mapped: true }
      ]) {
        const withClaim = { ...current, extra: { ...current.extra, okf: {
          ...current.extra.okf, type: 'Reference', 'x-wiki': { authored: 'kept', storage_import: claim }
        } } }
        const authoredBefore = structuredClone(withClaim.extra)
        const changedClaim = encodeStoragePageDocument(withClaim)
        if (typeof changedClaim !== 'object' || changedClaim === null || typeof changedClaim.markdown !== 'string') throw new Error('Expected encoded native Markdown')
        expect(changedClaim.markdown).toBe(encoded.markdown)
        expect(changedClaim.sha256).toBe(encoded.sha256)
        expect(changedClaim.metadata).toEqual(encoded.metadata)
        expect(withClaim.extra).toEqual(authoredBefore)
      }
      expect(current.extra).toEqual(canonicalBefore)
      expect(await ownerFor(page.id)).toEqual(owner)
      expect(await snapshot()).toEqual(before)
    })
  })

  it('restores a deleted native page without reviving its retained deleted ledger association', async () => {
    const raw = ['---', 'type: Reference', 'x-wiki:', '  authored: recovered', '---', '', 'Recovered authored body'].join('\n')
    await withImportSource({ 'en/recovery-receipt.md': raw }, async (root, source) => {
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      const imported = await db('pages').where({ path: 'recovery-receipt' }).first('*')
      const owner = await expectAcceptedOwner(imported.id, 'page.created')
      await db('storage').update({ isEnabled: false })
      await Page.deletePage({ id: imported.id, user: author, expectedSourceRevision: String(imported.sourceRevision), skipStorage: true })
      const retired = await ownerFor(imported.id)
      expect(retired).toMatchObject({
        pageId: imported.id, sourceKey: owner.sourceKey, sourcePath: owner.sourcePath, sourceSha256: owner.sourceSha256, status: 'deleted'
      })
      expect(retired.deletedAt).not.toBeNull()
      expect(retired.operationId).not.toBe(owner.operationId)
      expect(await db('outboxEvents').where({ id: retired.operationId }).first('type')).toEqual({ type: 'page.deleted' })
      const deletion = await db('pageHistory').where({ pageId: imported.id, action: 'deleted' }).first('id', 'extra')
      const deletedExtra = structuredClone(deletion.extra)
      const restored = await operations.restoreDeletedPage({
        requester: author, pageId: imported.id, deletionVersionId: deletion.id,
        destination: { path: 'recovery-receipt', localeCode: 'en' }
      })
      const recovered = await db('pages').where({ id: imported.id }).first('*')
      expect(recovered.content).toBe('Recovered authored body')
      expect(recovered.extra.okf['x-wiki'].authored).toBe('recovered')
      expect(await ownerFor(imported.id)).toEqual(retired)
      expect(storagePageImportOwnerMatches(retired, recovered)).toBe(false)
      await operations.restore({
        requester: author, pageId: imported.id, versionId: deletion.id, expectedSourceRevision: restored.sourceRevision
      })
      const replayed = await db('pages').where({ id: imported.id }).first('*')
      expect(replayed.extra.okf['x-wiki'].authored).toBe('recovered')
      expect(await ownerFor(imported.id)).toEqual(retired)
      expect(storagePageImportOwnerMatches(retired, replayed)).toBe(false)
      expect((await db('pageHistory').where({ id: deletion.id }).first('extra')).extra).toEqual(deletedExtra)
      await activateExportTarget('disk', root, source, {})
      await Page.updatePage({ id: imported.id, user: author, title: 'A restored page can publish but cannot revive its deleted source',
        expectedSourceRevision: String(replayed.sourceRevision) })
      const { job } = await pendingExport(imported.id)
      await drainExports()
      expect(await db('durableJobs').where({ id: job.id }).first('state')).toEqual({ state: 'succeeded' })
      expect(parseOkfDocument(await readFile(path.join(source, 'en/recovery-receipt.md'), 'utf8')).metadata.title)
        .toBe('A restored page can publish but cannot revive its deleted source')
      expect(await ownerFor(imported.id)).toEqual(retired)
      const beforeReplay = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership|accepted native revision/u)
      expect(await snapshot()).toEqual(beforeReplay)
    })
  })

  it.each(['body', 'title'] as const)('preserves a human %s edit made while the target was disabled when Git deletes its old source', async field => {
    const bytes = 'The original native import must not authorize deletion of a later human revision.'
    await withGitContentSource({ 'protected.md': bytes }, async ({ root, source, writer, plugin, context, config, git }) => {
      expectImportSucceeded(await importGitFromDisk(root, config))
      const imported = await db('pages').where({ path: 'protected' }).first('*')
      const accepted = await expectAcceptedOwner(imported.id, 'page.created')
      await db('storage').where({ key: 'git' }).update({ isEnabled: false })
      await Page.updatePage({
        id: imported.id, user: author, expectedSourceRevision: String(imported.sourceRevision),
        ...(field === 'body' ? { content: 'Human body written with no active storage target' } : { title: 'Human title written with no active storage target' })
      })
      const human = await db('pages').where({ id: imported.id }).first('*')
      expect(human.content).toBe(field === 'body' ? 'Human body written with no active storage target' : bytes)
      if (field === 'title') expect(human.title).toBe('Human title written with no active storage target')
      expect(await ownerFor(imported.id)).toEqual(accepted)
      expect(storagePageImportOwnerMatches(accepted, human)).toBe(false)
      expect(await db('durableJobs').where({ type: 'storage-mutation' })).toEqual([])
      git(writer, 'rm', '--', 'protected.md')
      git(writer, 'commit', '--quiet', '-m', 'Delete the source after an offline human edit')
      git(writer, 'push', '--quiet', 'origin', 'main')
      await db('storage').where({ key: 'git' }).update({ isEnabled: true })
      const before = await snapshot()
      for (const work of [() => plugin.sync!.call(context as never), () => plugin.importAll!.call(context as never)]) {
        const result = await work().catch(error => error)
        expect(result instanceof Error || Array.isArray(result) && result.some(item => item.ok === false)).toBe(true)
        expect(await snapshot()).toEqual(before)
      }
      expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).not.toBe('')
      expect(await ownerFor(imported.id)).toEqual(accepted)
      expect(await db('pageHistory').where({ pageId: imported.id, action: 'deleted' })).toEqual([])
    })
  })

  it('replays a committed native Git deletion from its positive ledger tombstone after history and root event pruning', async () => {
    await withGitContentSource({ 'retired.md': 'A deleted accepted source identity must remain durable.' }, async ({ root, source, writer, plugin, context, config, git }) => {
      expectImportSucceeded(await importGitFromDisk(root, config))
      const imported = await db('pages').where({ path: 'retired' }).first('*')
      const accepted = await expectAcceptedOwner(imported.id, 'page.created')
      git(writer, 'rm', '--', 'retired.md')
      git(writer, 'commit', '--quiet', '-m', 'Delete an exactly accepted source')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const nativeDelete = Page.deletePage
      const interruption = vi.spyOn(Page, 'deletePage').mockImplementation(async options => {
        const result = await nativeDelete.call(Page, options)
        throw new Error(`Interrupted after committed native deletion ${String(result)}`)
      })
      try {
        const result = await plugin.sync!.call(context as never)
        expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: 'retired.md', ok: false })]))
        expect(interruption).toHaveBeenCalledTimes(1)
      } finally { interruption.mockRestore() }
      expect(await db('pages').where({ id: imported.id })).toEqual([])
      const retired = await ownerFor(imported.id)
      expect(retired).toMatchObject({
        status: 'deleted', sourceKey: accepted.sourceKey, sourcePath: accepted.sourcePath, sourceSha256: accepted.sourceSha256
      })
      expect(retired.deletedAt).not.toBeNull()
      await db('deletedPageRecovery').where({ pageId: imported.id }).delete()
      await db('pageHistory').where({ pageId: imported.id }).delete()
      await db('pageMutationOutbox').where({ pageId: imported.id }).delete()
      await db('outboxEvents').where({ aggregateType: 'page', aggregateId: String(imported.id) }).delete()
      const beforeReplay = await snapshot()
      const restarted = { ...plugin, root, repoPath: source, git: true, mode: 'pull', targetKey: 'git', config }
      expectImportSucceeded(await plugin.importAll!.call(restarted as never))
      expect(await snapshot()).toEqual(beforeReplay)
      expect(await ownerFor(imported.id)).toEqual(retired)
      expect(() => git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toThrow()
    })
  })

  it('requires a fresh exact native replacement to associate equal bytes and never refreshes an accepted no-op', async () => {
    const body = 'Equal bytes are not proof that an external source owns this native page.'
    const page = await Page.createPage({
      path: 'equal', locale: 'en', title: 'equal', content: body, editor: 'markdown', description: '',
      user: author, visibility: 'public', isPublished: true, skipStorage: true
    })
    await withImportSource({ 'equal.md': body }, async root => {
      const untouched = await snapshot()
      await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK' })).rejects.toThrow(/ownership/u)
      expect(await snapshot()).toEqual(untouched)
      expect(await loadStoragePageImportOwners(db, { pageIds: [page.id], limit: 1 })).toEqual([])
      const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'disk', configurationRevision: 'exact-equal-state-replacement' }
      const preview = await buildStorageImportPreview(await collectStorageEntries(root), {}, 'DISK', scope)
      const review: StorageImportReview = { scope, snapshot: preview.snapshot, mappings: [{
        sourcePath: 'equal.md', sourceSha256: createHash('sha256').update(body).digest('hex'),
        locale: 'en', path: 'equal', existingPageId: page.id, expectedSourceRevision: String(page.sourceRevision)
      }] }
      expectImportSucceeded(await withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK' })))
      const accepted = await expectAcceptedOwner(page.id, 'page.updated')
      expect(accepted.nativeRevision).not.toBe(String(page.sourceRevision))
      expect(await db('pageHistory').where({ pageId: page.id })).toHaveLength(1)
      const associated = await snapshot()
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      expect(await snapshot()).toEqual(associated)
      expect(await ownerFor(page.id)).toEqual(accepted)
      await expect(withStorageImportReview(review, async () => {}, () =>
        commonDisk.importFromDisk({ root, moduleName: 'DISK' }))).rejects.toThrow(/stale/u)
      expect(await snapshot()).toEqual(associated)
    })
  })

  it('rolls back the native page, history, root event and ledger together when ownership acceptance fails', async () => {
    await withImportSource({ 'accepted.md': 'Original accepted source' }, async root => {
      expectImportSucceeded(await commonDisk.importFromDisk({ root, moduleName: 'DISK' }))
      const page = await db('pages').where({ path: 'accepted' }).first('*')
      const accepted = await expectAcceptedOwner(page.id, 'page.created')
      const owner = {
        sourceKey: accepted.sourceKey, sourcePath: accepted.sourcePath, sourceSha256: accepted.sourceSha256,
        locationKey: accepted.locationKey, mapped: accepted.mapped
      }
      const before = await snapshot()
      await expect(Page.createPage({
        path: 'duplicate-source', locale: 'en', title: 'Duplicate source must roll back', content: 'No partial native acceptance',
        editor: 'markdown', description: '', visibility: 'public', isPublished: true, user: author, skipStorage: true, okfProducer: 'import:disk',
        canonicalTransactionHook: async (transaction, committed) => {
          await recordStoragePageImportOwner(transaction, {
            owner, pageId: committed.id, sourceRevision: committed.sourceRevision, outboxId: committed.outboxId
          })
        }
      })).rejects.toMatchObject({ code: '23505' })
      expect(await snapshot()).toEqual(before)
      await expect(Page.updatePage({
        id: page.id, user: author, content: 'A rolled-back replacement', expectedSourceRevision: String(page.sourceRevision),
        skipStorage: true, okfProducer: 'import:disk',
        canonicalTransactionHook: async (transaction, committed) => {
          await recordStoragePageImportOwner(transaction, {
            owner: { ...owner, sourceSha256: createHash('sha256').update('A rolled-back replacement').digest('hex') },
            pageId: committed.id, sourceRevision: committed.sourceRevision, outboxId: committed.outboxId
          })
          const inTransaction = await loadStoragePageImportOwners(transaction, { pageIds: [page.id], limit: 1 })
          expect(inTransaction[0]!.nativeRevision).toBe(committed.sourceRevision)
          expect(inTransaction[0]!.operationId).toBe(committed.outboxId)
          expect(await observer('storagePageImportOwners').where({ pageId: page.id }).first('nativeRevision')).toEqual({
            nativeRevision: accepted.nativeRevision
          })
          throw new Error('Abort after same-transaction native ownership acceptance')
        }
      })).rejects.toThrow('Abort after same-transaction native ownership acceptance')
      expect(await snapshot()).toEqual(before)
    })
  })

  it('refuses an unreviewed mapped source rename at the same native location and accepts only a fresh exact native replacement', async () => {
    const bytes = 'A retained native mapping must not turn a source-only rename into a fake native move.'
    await withGitContentSource({ 'a.b.md': bytes }, async ({ root, source, writer, plugin, context, config, git, preview }) => {
      const initial = await preview()
      const include: StorageImportReview = { scope: initial.scope, snapshot: initial.snapshot, mappings: [{
        sourcePath: 'a.b.md', sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        locale: 'en', path: 'retained-mapping', existingPageId: null, expectedSourceRevision: null
      }] }
      expectImportSucceeded(await withStorageImportReview(include, async () => {}, () =>
        importGitFromDisk(root, config)))
      const page = await db('pages').where({ path: 'retained-mapping' }).first('*')
      const accepted = await expectAcceptedOwner(page.id, 'page.created')
      expect(accepted).toMatchObject({ mapped: true, sourcePath: 'a.b.md' })
      git(writer, 'mv', '--', 'a.b.md', 'retained-mapping.md')
      git(writer, 'commit', '--quiet', '-m', 'Rename the source but retain its canonical mapping')
      git(writer, 'push', '--quiet', 'origin', 'main')
      const before = await snapshot()
      for (const work of [() => plugin.sync!.call(context as never), () => plugin.importAll!.call(context as never)]) {
        const result = await work().catch(error => error)
        expect(result instanceof Error || Array.isArray(result) && result.some(item => item.ok === false)).toBe(true)
        expect(await snapshot()).toEqual(before)
        expect(await ownerFor(page.id)).toEqual(accepted)
      }
      expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).not.toBe('')
      const current = await preview()
      const replacement: StorageImportReview = { scope: current.scope, snapshot: current.snapshot, mappings: [{
        sourcePath: 'retained-mapping.md', sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        locale: 'en', path: 'retained-mapping', existingPageId: page.id, expectedSourceRevision: accepted.nativeRevision
      }] }
      expectImportSucceeded(await withStorageImportReview(replacement, async () => {}, () => plugin.importAll!.call(context as never)))
      const reassociated = await expectAcceptedOwner(page.id, 'page.updated')
      expect(reassociated).toMatchObject({
        sourcePath: 'retained-mapping.md', sourceSha256: accepted.sourceSha256, nativePath: accepted.nativePath, nativeLocaleCode: accepted.nativeLocaleCode
      })
      expect(reassociated.nativeRevision).not.toBe(accepted.nativeRevision)
      expect(reassociated.operationId).not.toBe(accepted.operationId)
      expect(reassociated.moveBinding).toBeNull()
      expect(await db('pageHistory').where({ pageId: page.id, action: 'moved' })).toEqual([])
      expect(await db('pages').where({ id: page.id }).first('path', 'content')).toEqual({ path: 'retained-mapping', content: bytes })
      expect(() => git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toThrow()
      const completed = await snapshot()
      expectImportSucceeded(await plugin.importAll!.call(context as never))
      expect(await snapshot()).toEqual(completed)
    })
  })

  it('keeps real page authority, canonical ownership and root acceptance on one PostgreSQL connection through commit', async () => {
    await withImportSource({ 'pool/page.md': 'Pool-one page import must keep native authority and ledger atomic.' }, async root => {
      const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'disk', configurationRevision: 'native-page-pool-one' }
      const review: StorageImportReview = {
        scope, snapshot: (await buildStorageImportPreview(await collectStorageEntries(root), {}, 'DISK', scope)).snapshot, mappings: []
      }
      const single = knexModule({ client: 'pg', connection: connection ?? undefined,
        acquireConnectionTimeout: 1000, pool: { min: 0, max: 1 } })
      const originalKnex = globalThis.WIKI.models.knex
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      let committedRevision: string | undefined
      const guard = async (transaction?: Knex.Transaction) => {
        if (transaction) await requireSystemAuthority(transaction, { user: author }, true)
        else await single.transaction(async current => { await requireSystemAuthority(current, { user: author }, true) })
      }
      globalThis.WIKI.models.knex = single
      for (const model of [Page, History, Asset, Folder, globalThis.WIKI.models.tags]) model.knex(single)
      const importing = withStorageImportReview(review, guard, () => commonDisk.importFromDisk({ root, moduleName: 'DISK' }),
        async transaction => {
          await guard(transaction)
          const pending = await transaction('pages').where({ path: 'pool/page' }).first('sourceRevision')
          committedRevision = String(pending.sourceRevision)
          entered.resolve()
          await resume.promise
        })
      try {
        await Promise.race([entered.promise, importing.then(() => { throw new Error('Native page import did not enter its transaction guard') })])
        expect(await observer('pages')).toEqual([])
        expect(await observer('storagePageImportOwners')).toEqual([])
        expect(await observer('outboxEvents')).toEqual([])
        await expect(Promise.resolve(observer.transaction(async transaction => {
          await transaction.raw("SET LOCAL lock_timeout = '50ms'")
          await transaction('groups').where({ id: 1 }).update({ permissions: '[]' })
        }))).rejects.toMatchObject({ code: '55P03' })
        resume.resolve()
        expectImportSucceeded(await importing)
        const page = await single('pages').where({ path: 'pool/page' }).first('*')
        const owner = await expectAcceptedOwner(page.id, 'page.created')
        expect(owner.nativeRevision).toBe(committedRevision)
        expect(single.client.pool.numUsed()).toBe(0)
      } finally {
        resume.resolve()
        await importing.catch(() => {})
        globalThis.WIKI.models.knex = originalKnex
        for (const model of [Page, History, Asset, Folder, globalThis.WIKI.models.tags]) model.knex(db)
        await single.destroy()
      }
    })
  })

  it('refuses current account revocation in the same native import transaction without granting source ownership', async () => {
    await withImportSource({ 'revoked.md': 'No imported page may outlive its current actor authorization.' }, async root => {
      const scope: StorageImportScope = { actorId: author.id, apiKeyId: null, targetKey: 'disk', configurationRevision: 'native-current-account' }
      const review: StorageImportReview = {
        scope, snapshot: (await buildStorageImportPreview(await collectStorageEntries(root), {}, 'DISK', scope)).snapshot, mappings: []
      }
      const guard = async (transaction?: Knex.Transaction) => {
        if (transaction) await requireSystemAuthority(transaction, { user: author }, true)
        else await db.transaction(async current => { await requireSystemAuthority(current, { user: author }, true) })
      }
      const before = await snapshot()
      const nativeCreate = Page.createPage
      const revoked = vi.spyOn(Page, 'createPage').mockImplementation(async options => {
        await db('users').where({ id: author.id }).update({ authVersion: author.authVersion + 1 })
        return nativeCreate.call(Page, options)
      })
      try {
        const result = await withStorageImportReview(review, guard, () =>
          commonDisk.importFromDisk({ root, moduleName: 'DISK' }), guard)
        expect(result).toEqual([expect.objectContaining({ relPath: 'revoked.md', ok: false, error: expect.stringMatching(/session|account/u) })])
        expect(revoked).toHaveBeenCalledTimes(1)
        expect(await snapshot()).toEqual(before)
      } finally {
        revoked.mockRestore()
        await db('users').where({ id: author.id }).update({ authVersion: author.authVersion })
      }
    })
  })

  it.each(['body', 'title'] as const)('preserves a newer human %s revision when a completed pure Git rename is replayed after restart', async field => {
    const bytes = 'An accepted pure rename is not authority over a later native writer.'
    await withGitContentSource({ 'before.md': bytes }, async ({ root, source, writer, plugin, context, config, git }) => {
      expectImportSucceeded(await importGitFromDisk(root, config))
      const original = await db('pages').where({ path: 'before' }).first('*')
      const fromGitRevision = git(source, 'rev-parse', 'HEAD')
      git(writer, 'mv', '--', 'before.md', 'after.md')
      git(writer, 'commit', '--quiet', '-m', 'Complete a native pure rename')
      git(writer, 'push', '--quiet', 'origin', 'main')
      expectImportSucceeded(await plugin.sync!.call(context as never))
      const completed = await expectAcceptedOwner(original.id, 'page.updated')
      expect(completed).toMatchObject({ sourcePath: 'after.md', nativePath: 'after', moveBinding: { phase: 'completed' } })
      const moved = await db('pages').where({ id: original.id }).first('*')
      await Page.updatePage({
        id: original.id, user: author, expectedSourceRevision: String(moved.sourceRevision), skipStorage: true,
        ...(field === 'body' ? { content: 'Newer human body after completed rename' } : { title: 'Newer human title after completed rename' })
      })
      const current = await db('pages').where({ id: original.id }).first('*')
      expect(current.content).toBe(field === 'body' ? 'Newer human body after completed rename' : bytes)
      expect(await ownerFor(original.id)).toEqual(completed)
      expect(storagePageImportOwnerMatches(completed, current)).toBe(false)
      git(source, 'update-ref', 'refs/wiki/pending-import/main', fromGitRevision)
      const beforeReplay = await snapshot()
      const restarted = { ...plugin, root, repoPath: source, git: true, mode: 'pull', targetKey: 'git', config }
      for (const work of [() => plugin.sync!.call(restarted as never), () => plugin.importAll!.call(restarted as never)]) {
        const result = await work().catch(error => error)
        expect(result instanceof Error || Array.isArray(result) && result.some(item => item.ok === false)).toBe(true)
        expect(await snapshot()).toEqual(beforeReplay)
      }
      expect(await ownerFor(original.id)).toEqual(completed)
      expect(git(source, 'rev-parse', '--verify', 'refs/wiki/pending-import/main')).toBe(fromGitRevision)
    })
  })

  for (const deletion of ['reviewed', 'ordinary'] as const) {
    it.each(['actor', 'configuration', 'operation', 'deadline', 'physical'] as const)(
      `rolls back ${deletion} Git deletion when current %s authority is lost inside the actual canonical transaction`,
      async lost => {
        const sourcePath = deletion === 'reviewed' ? '.delete.md' : 'delete.md'
        const bytes = 'Deletion authority must survive through the actual native tombstone and commit.'
        await withGitContentSource({ [sourcePath]: bytes }, async ({ root, source, context, config, git, preview }) => {
          if (deletion === 'reviewed') {
            const initial = await preview()
            const entry = initial.gitContent?.find(item => item.sourcePath === sourcePath)
            if (entry === undefined) throw new Error('Missing reviewed Git deletion source')
            const include: StorageImportReview = { scope: initial.scope, snapshot: initial.snapshot,
              mappings: [{ sourcePath, sourceSha256: entry.sourceSha256, locale: 'en', path: 'delete',
                existingPageId: null, expectedSourceRevision: null }],
              gitContent: [{ sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }] }
            expectImportSucceeded(await withStorageImportReview(include, async () => {}, () => importGitFromDisk(root, config)))
          } else {
            expectImportSucceeded(await importGitFromDisk(root, config))
            const base = git(source, 'rev-parse', 'HEAD')
            git(source, 'rm', '--', sourcePath)
            git(source, 'commit', '--quiet', '-m', 'Delete the exactly accepted native source')
            git(source, 'update-ref', 'refs/wiki/pending-import/main', base)
          }
          const inventory = await preview()
          const entry = inventory.gitContent?.find(item => item.sourcePath === sourcePath)
          if (entry?.owner?.kind !== 'page') throw new Error('Missing positively accepted native deletion owner')
          const pageId = entry.owner.id
          const review: StorageImportReview = { scope: inventory.scope, snapshot: inventory.snapshot, mappings: [],
            ...(deletion === 'reviewed' ? { gitContent: [{ sourcePath, sourceSha256: entry.sourceSha256,
              owner: entry.owner, action: 'remove' }] } : {}) }
          const jobs = new DurableJobStore(db)
          const admitted = await jobs.enqueue({ type: 'storage-action', version: 1, payload: {}, maxAttempts: 1 })
          const [job] = await jobs.claim({ workerId: 'native-delete-review', supportedIdentities: ['storage-action@1'] })
          if (job === undefined || job.id !== admitted.id) throw new Error('Missing actual claimed storage operation')
          const guardTransaction = async (transaction: Knex.Transaction) => {
            await requireSystemAuthority(transaction, { user: author }, true)
            const target = await transaction('storage').where({ key: 'git' }).forShare().first('isEnabled')
            if (target?.isEnabled !== true) throw new Error('Reviewed storage configuration changed')
            const lease = await transaction('durableJobs').where({ id: job.id }).forUpdate().first('*')
            if (lease?.state !== 'running' || lease.leaseOwner !== job.leaseOwner || lease.leaseToken !== job.leaseToken ||
                new Date(lease.leaseExpiresAt).getTime() <= Date.now()) throw new Error('Reviewed storage operation lost its lease')
          }
          const guard = async () => { await db.transaction(guardTransaction) }
          const before = await snapshot()
          const nativeDelete = Page.deletePage
          let enteredCanonicalTransaction = false
          const deleting = vi.spyOn(Page, 'deletePage').mockImplementation(async options => {
            const hook = options.canonicalTransactionHook
            if (hook === undefined) throw new Error('Git deletion did not supply its canonical transaction fence')
            return nativeDelete.call(Page, { ...options, canonicalTransactionHook: async (transaction, committed) => {
              enteredCanonicalTransaction = true
              expect(await transaction('pages').where({ id: pageId })).toEqual([])
              expect(await observer('pages').where({ id: pageId }).first('id')).toEqual({ id: pageId })
              if (lost === 'actor') await transaction('users').where({ id: author.id }).update({ authVersion: author.authVersion + 1 })
              else if (lost === 'configuration') await transaction('storage').where({ key: 'git' }).update({ isEnabled: false })
              else if (lost === 'operation') await transaction('durableJobs').where({ id: job.id }).update({ leaseToken: null })
              else return loseGitTurnAtCommit(transaction, lost, () => hook(transaction, committed))
              await hook(transaction, committed)
            } })
          })
          try {
            const importAll = context.importAll
            if (typeof importAll !== 'function') throw new Error('Missing native Git full-import consumer')
            const result = await withStorageImportReview(review, guard, () => importAll.call(context), guardTransaction).catch(error => error)
            expect(enteredCanonicalTransaction).toBe(true)
            if (result instanceof Error) expect(result.message).toMatch(/serialization|deadline/u)
            else expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: sourcePath, ok: false })]))
            expect(await snapshot()).toEqual(before)
            expect(await db('storage').where({ key: 'git' }).first('isEnabled')).toEqual({ isEnabled: true })
            expect(await db('users').where({ id: author.id }).first('authVersion')).toEqual({ authVersion: author.authVersion })
          } finally { deleting.mockRestore() }
        })
      }
    )
  }

  const loseGitTurnAtCommit = async (transaction: Knex.Transaction, loss: 'deadline' | 'physical', accept: () => Promise<void>) => {
    const turn = currentGitMutationTurn()
    if (loss === 'deadline') {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(turn.deadlineAt)
      try { await accept() } finally { clock.mockRestore() }
    } else {
      const key = createHash('sha256').update(turn.targetKey).digest().readInt32BE(0) >>> 0
      const lost = await transaction.raw(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype = 'advisory' AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted",
        [0x47495453, key]
      )
      expect(lost.rows).toEqual([{ terminated: true }])
      await accept()
    }
  }

  it.each(['deadline', 'physical'] as const)('rejects native page acceptance when its actual Git turn is lost at the %s commit boundary', async loss => {
    const bytes = 'No page, root event or native ownership may survive a lost Git turn.'
    await withGitContentSource({ 'fenced.md': bytes }, async ({ root, source, config }) => {
      const before = await snapshot()
      const nativeCreate = Page.createPage
      let enteredCanonicalTransaction = false
      const creating = vi.spyOn(Page, 'createPage').mockImplementation(async options => {
        const hook = options.canonicalTransactionHook
        if (hook === undefined) throw new Error('Missing native page acceptance hook')
        return nativeCreate.call(Page, { ...options, canonicalTransactionHook: async (transaction, committed) => {
          enteredCanonicalTransaction = true
          expect(await transaction('pages').where({ id: committed.id }).first('content')).toEqual({ content: bytes })
          await loseGitTurnAtCommit(transaction, loss, () => hook(transaction, committed))
        } })
      })
      try {
        const result = await importGitFromDisk(root, config).catch(error => error)
        expect(enteredCanonicalTransaction).toBe(true)
        expect(result instanceof Error || Array.isArray(result) && result.some(item => item.ok === false)).toBe(true)
        expect(await snapshot()).toEqual(before)
        expect(await readFile(path.join(source, 'fenced.md'), 'utf8')).toBe(bytes)
      } finally { creating.mockRestore() }
    })
  })

  it.each(['deadline', 'physical'] as const)('rejects native asset bytes, owner and cache when its actual Git turn is lost at the %s final commit boundary', async loss => {
    const bytes = 'No asset data or delivery cache may survive a lost Git turn.'
    await withGitContentSource({ 'fenced.bin': bytes }, async ({ root, source, config }) => {
      const before = await snapshot()
      const nativeUpload = Asset.upload
      let enteredCanonicalTransaction = false
      const uploading = vi.spyOn(Asset, 'upload').mockImplementation(async options => {
        const review = options.importReview
        if (review === undefined) throw new Error('Missing native asset acceptance review')
        return nativeUpload.call(Asset, { ...options, importReview: { ...review, beforeCommit: async transaction => {
          enteredCanonicalTransaction = true
          const pending = await transaction('assets').where({ filename: 'fenced.bin' }).first('id', 'metadata')
          if (pending === undefined) throw new Error('Native asset did not write its pending canonical identity')
          expect(pending.metadata.storage_import).toMatchObject({ assetId: pending.id, sourcePath: 'fenced.bin' })
          expect(Buffer.from((await transaction('assetData').where({ id: pending.id }).first('data')).data).toString()).toBe(bytes)
          expect(await observer('assets')).toEqual([])
          await loseGitTurnAtCommit(transaction, loss, () => review.beforeCommit(transaction))
        } } })
      })
      try {
        const result = await importGitFromDisk(root, config).catch(error => error)
        expect(enteredCanonicalTransaction).toBe(true)
        expect(result instanceof Error || Array.isArray(result) && result.some(item => item.ok === false)).toBe(true)
        expect(await snapshot()).toEqual(before)
        const hash = createHash('sha1').update('fenced.bin').digest('hex')
        await expect(readFile(path.join(directory, 'data', 'cache', `${hash}.dat`))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(path.join(source, 'fenced.bin'), 'utf8')).toBe(bytes)
      } finally { uploading.mockRestore() }
    })
  })
})

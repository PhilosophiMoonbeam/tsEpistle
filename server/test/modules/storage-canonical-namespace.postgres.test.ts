import knexModule from 'knex'
import type { Knex } from 'knex'
import * as Objection from 'objection'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as installPageRevisionTrigger } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { enqueuePageStorageMutation } from '../../jobs/storage-mutations.ts'
import { lockSearchIndex } from '../../helpers/search-contract.ts'
import { evaluateGroupAccess } from '../../helpers/group-access.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'
import pageHelper from '../../helpers/page.ts'
import { OKF_MAX_DOCUMENT_BYTES, okfFilePath } from '../../okf/format.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../../modules/storage/page-document.ts'
import type PageModel from '../../models/pages.ts'
import type AssetModel from '../../models/assets.ts'
import type PageHistoryModel from '../../models/pageHistory.ts'
import type AssetFolderModel from '../../models/assetFolders.ts'

const connection = getPostgresTestConnection('_canonical_namespace_test', import.meta.path)
const suite = connection ? describe : describe.skip
const author = { id: 1, name: 'Page Administrator', email: 'pages@example.test', permissions: ['manage:system'] }
const assetWriter = { id: 7, name: 'Asset Writer', email: 'assets@example.test', permissions: ['write:assets'] }
const protectedTitle = 'Restricted owner title must not be disclosed'
const protectedContent = '<p>Restricted owner source must not be disclosed</p>'
const verifier = '$argon2id$restricted-page-verifier'
const tables = [
  ['pages', 'id'],
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
  ['assetRelocationEffects', 'id']
] as const

suite('PostgreSQL canonical page and asset physical namespace admission', () => {
  let db: Knex
  let observer: Knex
  let Page: typeof PageModel
  let Asset: typeof AssetModel
  let History: typeof PageHistoryModel
  let Folder: typeof AssetFolderModel
  let directory: string
  let sourceOrdinal = 0
  const originalWiki = globalThis.WIKI
  const lang = { code: 'en', namespacing: false }

  const authorityFor = (requester: unknown): PageRuleAuthority => ({
    requester,
    permissions: requester === author ? author.permissions : requester === assetWriter ? assetWriter.permissions : [],
    groups: [{ id: 1, pageRules: [{ match: 'START', path: '', deny: false, roles: ['write:assets'], locales: [] }] }],
    tagAliases: {}
  })
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async ([table, key]) => [table, await db(table).orderBy(key)])))
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
  const prepareUpload = async (assetPath: string, skipStorage = false) => {
    const segments = assetPath.split('/')
    const filename = segments.pop()!
    let folderId: number | null = null
    for (const slug of segments) {
      const existing = await db('assetFolders').where({ slug, parentId: folderId }).first('id')
      folderId = existing ? Number(existing.id) : (await Folder.query().insert({ name: slug, slug, parentId: folderId })).id
    }
    const source = path.join(directory, 'data', 'uploads', `source-${++sourceOrdinal}`)
    const bytes = Buffer.from('Unprivileged canonical asset bytes')
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

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    observer = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await createDurableJobs(db)
    await addLeaseToken(db)
    await db.raw(`
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL);
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false);
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
    await db('users').insert([author, assetWriter].map(({ id, name, email }) => ({ id, name, email })))
    await db('locales').insert([{ code: 'en' }, { code: 'fr' }])
    const wiki = {
      ROOTPATH: '',
      SERVERPATH: path.resolve(import.meta.dir, '../..'),
      config: { db: { type: 'postgres' }, dataPath: 'data', lang, uploads: { maxFileSize: 1_048_576, scanSVG: false, forceDownload: false } },
      data: { reservedPaths: [], editors: ['html', 'markdown', 'asciidoc', 'text', 'json'].map(contentType => ({ key: contentType, contentType })) },
      logger: console,
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      Error: {
        PageNotFound: class PageNotFound extends Error {},
        PageIllegalPath: class PageIllegalPath extends Error {},
        PageDuplicateCreate: class PageDuplicateCreate extends Error {},
        PageEmptyContent: class PageEmptyContent extends Error {},
        PageUpdateForbidden: class PageUpdateForbidden extends Error {},
        PageMoveForbidden: class PageMoveForbidden extends Error {},
        PagePathCollision: class PagePathCollision extends Error {}
      },
      auth: {
        loadPageRuleAuthority: async (requester: unknown) => authorityFor(requester),
        checkAccess: (requester: unknown, requested: string[]) => requested.some(permission => authorityFor(requester).permissions.includes(permission)),
        checkPageAccess: (requester: unknown, requested: string[], context: { path: string }, authority: PageRuleAuthority) =>
          authority.requester === requester &&
          evaluateGroupAccess(authority.permissions, requested, authority.groups, context, authority.tagAliases, false).allowed
      },
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
    for (const model of [Page, Asset, History, Folder, Tag, User]) model.knex(db)
    Object.assign(wiki.models, { pages: Page, assets: Asset, assetFolders: Folder, tags: Tag, pageHistory: History })
  })
  beforeEach(async () => {
    for (const [table] of [...tables].reverse()) await db(table).delete()
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
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki
    await Promise.all([db?.destroy(), observer?.destroy()])
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
      const before = await snapshot()
      await expect(Page.convertPage({ id: page.id, user: author, editor: 'markdown' }))
        .rejects.toMatchObject({ name: 'OKF_DOCUMENT_TOO_LARGE', status: 413 })
      expect(await snapshot()).toEqual(before)
    }
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
})

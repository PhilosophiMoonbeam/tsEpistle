import { EventEmitter } from 'node:events'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import type PageModel from '../models/pages.ts'
import type PageHistoryModel from '../models/pageHistory.ts'

const writeOutboxEvent = vi.fn(async (_knex: unknown, _event: unknown) => undefined)
const redactProtectedPageForSearch = vi.fn((page: unknown) => page)
const syncProtectedPageAssets = vi.fn(async (_knex: unknown, _pageId: number, _content: string, _render: string) => undefined)
const protectedAssetRequiresUnlock = vi.fn(async () => false)

vi.mockModule('../core/outbox.ts', import.meta.url, () => ({ writeOutboxEvent }))
vi.mockModule('../operations/page-protection.ts', import.meta.url, () => ({
  redactProtectedPageForSearch,
  syncProtectedPageAssets,
  pageRequiresUnlock: vi.fn(async () => false),
  protectedAssetRequiresUnlock
}))

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
const admin = { id: 11, name: 'Recovery Admin', email: 'admin@example.com', permissions: ['manage:system'] } as Express.User & {
  id: number
  name: string
  email: string
}
const formerOwner = { id: 7, name: 'Former Owner', email: 'owner@example.com' }
const protectedVerifier = {
  passwordHash: '$argon2id$stored-verifier',
  version: 3,
  updatedBy: 7,
  updatedAt: '2025-01-02T03:04:05.000Z'
}
const pageFeatures = { schemaVersion: 1 as const, linksVisible: true, ratingsAllowed: false, lastEditorVisible: true }
let db: Knex
let Page: typeof PageModel
let PageHistory: typeof PageHistoryModel
let pageChanged: ReturnType<typeof vi.fn>
let pageEvent: ReturnType<typeof vi.fn>
let outboundEmit: ReturnType<typeof vi.fn>

const installSchema = async (): Promise<void> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.text('email').notNullable()
    table.boolean('isActive').notNullable()
    table.boolean('isSystem').notNullable().defaultTo(false)
  })
  await db.schema.createTable('locales', table => {
    table.text('code').primary()
  })
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.text('path').notNullable()
    table.text('hash').notNullable()
    table.text('title').notNullable()
    table.text('description').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.boolean('isSearchable').notNullable()
    table.text('publishStartDate').notNullable()
    table.text('publishEndDate').notNullable()
    table.text('content').notNullable()
    table.text('render').nullable()
    table.text('toc').notNullable()
    table.text('contentType').notNullable()
    table.text('createdAt').notNullable()
    table.text('updatedAt').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.bigInteger('renderedSourceRevision').nullable()
    table.text('editorKey').notNullable()
    table.text('localeCode').notNullable()
    table.text('localeGroupId').nullable()
    table.integer('authorId').notNullable()
    table.integer('creatorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.integer('authorId').notNullable()
    table.text('path').notNullable()
    table.text('hash').notNullable()
    table.text('title').notNullable()
    table.text('description').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.boolean('isSearchable').notNullable()
    table.text('publishStartDate').notNullable()
    table.text('publishEndDate').notNullable()
    table.text('content').notNullable()
    table.text('contentType').notNullable()
    table.text('editorKey').notNullable()
    table.text('extra').notNullable()
    table.text('localeCode').notNullable()
    table.text('action').notNullable()
    table.text('versionDate').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.text('createdAt').notNullable()
  })
  await db.schema.createTable('deletedPageRecovery', table => {
    table.integer('pageId').notNullable()
    table.integer('deletionVersionId').notNullable()
    table.bigInteger('deletionRevision').notNullable()
    table.text('securityContext').nullable()
    table.text('createdAt').notNullable()
    table.primary(['pageId', 'deletionVersionId'])
  })
  await db.schema.createTable('pageMutationOutbox', table => {
    table.string('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable()
    table.integer('attempts').notNullable()
    table.string('leaseOwner').nullable()
    table.string('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('pageHistoryTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('tags', table => {
    table.increments('id').primary()
    table.text('tag').notNullable()
    table.text('title').notNullable()
  })
  await db.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').primary()
    table.text('passwordHash').notNullable()
    table.integer('version').notNullable()
    table.integer('updatedBy').notNullable()
    table.text('updatedAt').notNullable()
  })
  await db.schema.createTable('pageUnlockGrants', table => {
    table.string('id').primary()
    table.integer('pageId').notNullable()
    table.string('sessionId').notNullable()
    table.integer('userId').notNullable()
    table.integer('passwordVersion').notNullable()
    table.text('expiresAt').notNullable()
  })
  await db.schema.createTable('assetFolders', table => {
    table.increments('id').primary()
    table.text('slug').notNullable()
    table.integer('parentId').nullable()
  })
  await db.schema.createTable('assets', table => {
    table.increments('id').primary()
    table.text('filename').notNullable()
    table.integer('folderId').nullable()
  })
  await db.schema.createTable('assetRelocationEffects', table => {
    table.increments('id').primary()
    table.integer('assetId').nullable()
    table.string('status').nullable()
    table.text('sourcePath').nullable()
    table.text('destinationPath').nullable()
  })
}

const insertDeletedSnapshot = async (options: {
  readonly visibility?: 'public' | 'private'
  readonly ownerId?: number | null
  readonly securityContext?: unknown
  readonly withRecoveryRow?: boolean
} = {}): Promise<void> => {
  const visibility = options.visibility ?? 'private'
  const ownerId = options.ownerId === undefined ? (visibility === 'private' ? formerOwner.id : null) : options.ownerId
  await db('pageHistory').insert({
    id: 700,
    pageId: 41,
    authorId: formerOwner.id,
    path: 'guides/identity',
    hash: 'deleted-page-hash',
    title: 'Historical identity guide',
    description: 'Saved before deletion',
    visibility,
    ownerId,
    isPublished: true,
    isSearchable: true,
    publishStartDate: '',
    publishEndDate: '',
    content: '# Historical identity guide\n',
    contentType: 'markdown',
    editorKey: 'markdown',
    extra: JSON.stringify({ css: '', js: '', pageFeatures }),
    localeCode: 'en',
    action: 'deleted',
    versionDate: '2025-01-02T03:04:05.000Z',
    sourceRevision: '6',
    createdAt: '2025-01-02T03:04:05.000Z'
  })
  if (options.withRecoveryRow === false) return
  const securityContext = options.securityContext === undefined
    ? {
        version: 1,
        former: { path: 'guides/identity', localeCode: 'en', visibility, ownerId, tags: [] },
        protection: protectedVerifier
      }
    : options.securityContext
  await db('deletedPageRecovery').insert({
    pageId: 41,
    deletionVersionId: 700,
    deletionRevision: '7',
    securityContext: securityContext === null ? null : JSON.stringify(securityContext),
    createdAt: '2025-01-02T03:04:06.000Z'
  })
}

const seedPreviousEffect = async (sourceRevision = '8'): Promise<void> => {
  await db('pageMutationOutbox').insert({
    id: 'prior-effect',
    pageId: 41,
    sourceRevision,
    effectKind: 'render',
    effectKey: 'page:41:render',
    desiredState: 'absent',
    payloadSha256: 'prior-payload-hash',
    payload: '{}',
    status: 'succeeded',
    attempts: 1,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    availableAt: '2025-01-02T03:04:05.000Z',
    result: null,
    postcondition: null,
    createdAt: '2025-01-02T03:04:05.000Z',
    updatedAt: '2025-01-02T03:04:05.000Z'
  })
}

const makeExistingPage = (id: number, path: string, visibility: 'public' | 'private', ownerId: number | null) => ({
  id,
  path,
  hash: `hash-${id}`,
  title: `Existing ${id}`,
  description: '',
  visibility,
  ownerId,
  isPublished: false,
  isSearchable: true,
  publishStartDate: '',
  publishEndDate: '',
  content: 'occupied',
  render: '',
  toc: '[]',
  contentType: 'markdown',
  createdAt: '2025-01-02T03:04:05.000Z',
  updatedAt: '2025-01-02T03:04:05.000Z',
  sourceRevision: '1',
  renderedSourceRevision: null,
  editorKey: 'markdown',
  localeCode: 'en',
  localeGroupId: null,
  authorId: 11,
  creatorId: 11,
  extra: JSON.stringify({})
})

const restoreOptions = (overrides: Record<string, unknown> = {}) => ({
  pageId: 41,
  deletionVersionId: 700,
  destination: { path: 'restored/identity', localeCode: 'en' },
  recoveringAdminId: admin.id,
  securityContext: {
    version: 1,
    former: { path: 'guides/identity', localeCode: 'en', visibility: 'private', ownerId: formerOwner.id, tags: [] },
    protection: protectedVerifier
  },
  legacyQuarantine: false,
  expectedDeletionRevision: '7',
  user: admin,
  ...overrides
})

const snapshot = async (): Promise<Record<string, unknown[]>> => ({
  pages: await db('pages').orderBy('id'),
  pageHistory: await db('pageHistory').orderBy('id'),
  pageAccessPasswords: await db('pageAccessPasswords').orderBy('pageId'),
  pageUnlockGrants: await db('pageUnlockGrants').orderBy('id'),
  pageMutationOutbox: await db('pageMutationOutbox').orderBy('id'),
  deletedPageRecovery: await db('deletedPageRecovery').orderBy('pageId')
})

beforeEach(async () => {
  vi.resetModules()
  writeOutboxEvent.mockReset()
  writeOutboxEvent.mockResolvedValue(undefined)
  redactProtectedPageForSearch.mockClear()
  syncProtectedPageAssets.mockClear()
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await installSchema()
  pageChanged = vi.fn(async () => undefined)
  pageEvent = vi.fn(async () => undefined)
  outboundEmit = vi.fn(() => undefined)
  const checkAccess = vi.fn().mockReturnValue(true)
  const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
  wikiGlobal.WIKI = {
    Error: { PageNotFound: class extends Error {} },
    auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
    collaboration: { pageChanged },
    config: { dataPath: 'data', db: { type: 'sqlite' }, lang: { code: 'en' } },
    data: { editors: [{ key: 'markdown', contentType: 'markdown' }] },
    events: { inbound: new EventEmitter(), outbound: { emit: outboundEmit } },
    logger: { error: vi.fn(), warn: vi.fn() },
    models: {
      knex: db,
      pages: {},
      pageHistory: {},
      tags: { associateTags: vi.fn(async ({ page }: { page: { tags?: unknown[] } }) => { page.tags = [] }) },
      storage: { pageEvent }
    }
  }
  Page = (await vi.importFresh('../models/pages.ts', import.meta.url)).default
  PageHistory = (await vi.importFresh('../models/pageHistory.ts', import.meta.url)).default
  Page.knex(db)
  PageHistory.knex(db)
  const models = wikiGlobal.WIKI.models as Record<string, unknown>
  models.pages = Page
  models.pageHistory = PageHistory
  vi.spyOn(Page, 'getPageFromDb').mockImplementation(async input => {
    const query = typeof input === 'number'
      ? db('pages').where({ id: input })
      : db('pages').where({ path: input.path, localeCode: input.locale, visibility: input.visibility, ownerId: input.ownerId })
    const row = await query.first()
    if (!row) return undefined
    const extra = typeof row.extra === 'string' ? JSON.parse(row.extra) : row.extra
    return { ...row, extra, tags: [] } as never
  })
  vi.spyOn(Page, 'renderPage').mockResolvedValue(undefined as never)
  vi.spyOn(Page, 'deletePageFromCache').mockResolvedValue(undefined)
  vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.destroy()
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('deleted page restore writer', () => {
  it('rejects a stale deletion fence without changing page, history, protection, grant, or effect state', async () => {
    await insertDeletedSnapshot()
    await seedPreviousEffect()
    await db('pageAccessPasswords').insert({ pageId: 41, passwordHash: 'old-hash', version: 1, updatedBy: 7, updatedAt: '2025-01-02T03:04:05.000Z' })
    await db('pageUnlockGrants').insert({ id: 'stale-grant', pageId: 41, sessionId: 'old-session', userId: 7, passwordVersion: 1, expiresAt: '2025-01-03T03:04:05.000Z' })
    await db('users').insert([
      { id: admin.id, email: admin.email, isActive: true, isSystem: false },
      { id: formerOwner.id, email: formerOwner.email, isActive: true, isSystem: false }
    ])
    await db('locales').insert({ code: 'en' })
    const before = await snapshot()

    await expect(Page.restoreDeletedPage(restoreOptions({ expectedDeletionRevision: '6' }) as never)).rejects.toMatchObject({
      status: 409,
      name: 'PAGE_RECOVERY_CONFLICT'
    })

    expect(await snapshot()).toEqual(before)
  })

  it('rejects an occupied page identity without making any recovery writes', async () => {
    await insertDeletedSnapshot()
    await seedPreviousEffect()
    await db('users').insert([
      { id: admin.id, email: admin.email, isActive: true, isSystem: false },
      { id: formerOwner.id, email: formerOwner.email, isActive: true, isSystem: false }
    ])
    await db('locales').insert({ code: 'en' })
    await db('pages').insert(makeExistingPage(99, 'restored/identity', 'private', formerOwner.id))
    const before = await snapshot()

    await expect(Page.restoreDeletedPage(restoreOptions() as never)).rejects.toMatchObject({
      status: 409,
      name: 'PAGE_RECOVERY_COLLISION'
    })

    expect(await snapshot()).toEqual(before)
  })

  it('rejects a destination that collides with an asset without making recovery writes', async () => {
    await insertDeletedSnapshot({ visibility: 'public', ownerId: null })
    await seedPreviousEffect()
    await db('deletedPageRecovery').where({ pageId: 41, deletionVersionId: 700 }).update({
      securityContext: JSON.stringify({
        version: 1,
        former: { path: 'guides/identity', localeCode: 'en', visibility: 'public', ownerId: null, tags: [] },
        protection: null
      })
    })
    await db('users').insert({ id: admin.id, email: admin.email, isActive: true, isSystem: false })
    await db('locales').insert({ code: 'en' })
    await db('assetFolders').insert([
      { id: 1, slug: 'en', parentId: null },
      { id: 2, slug: 'restored', parentId: 1 }
    ])
    await db('assets').insert({ filename: 'identity.md', folderId: 2 })
    const before = await snapshot()

    await expect(Page.restoreDeletedPage(restoreOptions({
      destination: { path: 'restored/identity', localeCode: 'en' },
      securityContext: {
        version: 1,
        former: { path: 'guides/identity', localeCode: 'en', visibility: 'public', ownerId: null, tags: [] },
        protection: null
      }
    }) as never)).rejects.toMatchObject({
      status: 409,
      name: 'PAGE_RECOVERY_COLLISION'
    })

    expect(await snapshot()).toEqual(before)
  })

  it('restores the original ID and history, fences projections above prior effects, and restores only the protected verifier', async () => {
    await insertDeletedSnapshot()
    await seedPreviousEffect()
    await db('users').insert([
      { id: admin.id, email: admin.email, isActive: true, isSystem: false },
      { id: formerOwner.id, email: formerOwner.email, isActive: true, isSystem: false }
    ])
    await db('locales').insert({ code: 'en' })
    await db('pageAccessPasswords').insert({
      pageId: 41,
      passwordHash: 'stale-verifier',
      version: 1,
      updatedBy: 7,
      updatedAt: '2025-01-02T03:04:05.000Z'
    })
    await db('pageUnlockGrants').insert({ id: 'stale-grant', pageId: 41, sessionId: 'old-session', userId: 7, passwordVersion: 1, expiresAt: '2025-01-03T03:04:05.000Z' })

    await expect(Page.restoreDeletedPage(restoreOptions() as never)).resolves.toEqual({ pageId: 41, sourceRevision: '9', quarantined: false })

    const restoredPage = await db('pages').where({ id: 41 }).first()
    expect(restoredPage).toMatchObject({
      id: 41,
      path: 'restored/identity',
      localeCode: 'en',
      visibility: 'private',
      ownerId: formerOwner.id,
      isPublished: 0,
      sourceRevision: 9
    })
    const restoredExtra = typeof restoredPage.extra === 'string' ? JSON.parse(restoredPage.extra) : restoredPage.extra
    expect(restoredExtra.pageFeatures).toEqual(pageFeatures)
    const history = await db('pageHistory').where({ pageId: 41 }).orderBy('id')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ id: 700, action: 'deleted', sourceRevision: 6 })
    expect(history[1]).toMatchObject({ pageId: 41, action: 'restored', sourceRevision: 9, path: 'restored/identity' })
    expect(await db('pageAccessPasswords').where({ pageId: 41 }).first()).toMatchObject({
      passwordHash: protectedVerifier.passwordHash,
      version: 4,
      updatedBy: admin.id
    })
    expect(await db('pageUnlockGrants').where({ pageId: 41 })).toEqual([])
    const effects = await db('pageMutationOutbox').where({ pageId: 41, sourceRevision: 9 }).orderBy('effectKind')
    expect(effects.map(effect => effect.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    expect(effects.map(effect => JSON.parse(effect.payload))).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceRevision: '9', desiredState: 'present', location: { locale: 'en', path: 'restored/identity', visibility: 'private', ownerId: formerOwner.id } })])
    )
    expect(pageEvent).not.toHaveBeenCalled()
    expect(pageChanged).toHaveBeenCalledWith(41, true)
  })

  it('quarantines a legacy snapshot as private and unpublished under the recovering administrator', async () => {
    await insertDeletedSnapshot({ visibility: 'public', ownerId: null, withRecoveryRow: false })
    await seedPreviousEffect()
    await db('users').insert({ id: admin.id, email: admin.email, isActive: true, isSystem: false })
    await db('locales').insert({ code: 'en' })

    await expect(Page.restoreDeletedPage(restoreOptions({
      securityContext: null,
      legacyQuarantine: true,
      expectedDeletionRevision: '8'
    }) as never)).resolves.toEqual({ pageId: 41, sourceRevision: '9', quarantined: true })

    const restoredPage = await db('pages').where({ id: 41 }).first()
    expect(restoredPage).toMatchObject({ id: 41, visibility: 'private', ownerId: admin.id, isPublished: 0, sourceRevision: 9 })
    expect(await db('pageHistory').where({ pageId: 41 }).orderBy('id', 'desc').first()).toMatchObject({
      action: 'recovered-quarantined',
      sourceRevision: 9
    })
    expect(await db('pageAccessPasswords').where({ pageId: 41 })).toEqual([])
  })
})

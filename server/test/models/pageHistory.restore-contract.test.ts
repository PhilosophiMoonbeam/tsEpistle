import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let db: Knex
let PageHistory: typeof import('../../models/pageHistory.ts').default
interface TestHistoricalAuth {
  checkAccess(user: unknown, permissions: readonly string[]): unknown
  checkPageAccess(
    user: unknown,
    permissions: readonly string[],
    context: { path: string; locale?: string; tags?: readonly { tag: string }[] },
    authority: unknown
  ): unknown
  loadPageRuleAuthority(requester: unknown): Promise<unknown>
}

const createSchema = async (): Promise<void> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('name').notNullable()
  })
  await db.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag').notNullable()
    table.string('title').notNullable()
    table.string('createdAt').notNullable()
    table.string('updatedAt').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.integer('authorId').notNullable()
    table.string('path').notNullable()
    table.string('hash').notNullable()
    table.string('title').notNullable()
    table.string('description').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.boolean('isSearchable').notNullable().defaultTo(true)
    table.string('publishStartDate').notNullable()
    table.string('publishEndDate').notNullable()
    table.text('content').notNullable()
    table.string('contentType').notNullable()
    table.json('extra').nullable()
    table.string('editorKey').notNullable()
    table.string('localeCode').notNullable()
    table.string('action').notNullable()
    table.string('versionDate').notNullable()
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
    table.string('createdAt').notNullable()
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('pageHistoryTags', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
}
const insertHistoryRow = async (overrides: Record<string, unknown> = {}): Promise<number> => {
  await db('pageHistory').insert({
    pageId: 42,
    authorId: 7,
    path: 'release',
    hash: 'public:en:release',
    title: 'Release',
    description: 'Release notes',
    visibility: 'public',
    ownerId: null,
    isPublished: true,
    isSearchable: true,
    publishStartDate: '',
    publishEndDate: '',
    content: '# Release\n',
    contentType: 'markdown',
    extra: null,
    editorKey: 'markdown',
    localeCode: 'en',
    action: 'updated',
    versionDate: '2026-08-15T00:00:00.000Z',
    sourceRevision: 1,
    createdAt: '2026-08-15T00:00:00.000Z',
    ...overrides
  })
  const row = (await db('pageHistory').orderBy('id', 'desc').first('id')) as { id: number }
  return row.id
}

const addHistoryTags = async (historyId: number, tagIds: readonly number[]): Promise<void> => {
  if (tagIds.length > 0) await db('pageHistoryTags').insert(tagIds.map(tagId => ({ pageId: historyId, tagId })))
}

describe('page history restore metadata contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await createSchema()
    await db('users').insert({ id: 7, name: 'Owner' })
    await db('tags').insert([
      { id: 2, tag: 'release', title: 'Release', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' },
      { id: 3, tag: 'docs', title: 'Docs', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' }
    ])
    await db('pageTags').insert([
      { pageId: 42, tagId: 2 },
      { pageId: 42, tagId: 3 }
    ])

    wikiGlobal.WIKI = {
      auth: {
        checkAccess: vi.fn().mockReturnValue(true),
        checkPageAccess: vi.fn().mockReturnValue(true),
        loadPageRuleAuthority: vi.fn(async requester => ({
          requester,
          permissions: ['manage:system'],
          groups: [],
          tagAliases: {}
        }))
      },
      models: { knex: db, pageHistory: undefined }
    }
    PageHistory = (await vi.importFresh('../../models/pageHistory.ts', import.meta.url)).default
    PageHistory.knex(db)
    const Tag = (await import('../../models/tags.ts')).default
    Tag.knex(db)
    ;(wikiGlobal.WIKI as { models: Record<string, unknown> }).models.pageHistory = PageHistory
  })

  afterEach(async () => {
    await db.destroy()
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('snapshots tag relations and returns canonical editor metadata for restore', async () => {
    const extra = {
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:7', at: '2026-08-15T00:00:00.000Z' }
      }
    }
    await PageHistory.addVersion({
      id: 42,
      authorId: 7,
      content: '# Release\n',
      contentType: 'markdown',
      extra,
      description: 'Release notes',
      editorKey: 'visual-markdown',
      hash: 'public:en:release',
      visibility: 'public',
      ownerId: null,
      isPublished: true,
      localeCode: 'en',
      path: 'release',
      publishEndDate: '',
      publishStartDate: '',
      title: 'Release',
      action: 'updated',
      versionDate: '2026-08-15T00:00:00.000Z'
    })
    const version = await db('pageHistory').where({ pageId: 42 }).first('id')

    expect(await db('pageHistoryTags').where({ pageId: version.id }).orderBy('tagId')).toEqual([
      expect.objectContaining({ pageId: version.id, tagId: 2 }),
      expect.objectContaining({ pageId: version.id, tagId: 3 })
    ])

    const restored = await PageHistory.getVersion({
      pageId: 42,
      versionId: version.id,
      requester: { id: 7, permissions: ['manage:system'] } as Express.User
    })
    expect(restored).toMatchObject({
      versionId: version.id,
      pageId: 42,
      content: '# Release\n',
      contentType: 'markdown',
      editor: 'visual-markdown',
      locale: 'en',
      extra,
      tags: ['release', 'docs'],
      visibility: 'public'
    })
  })
  it('filters historical rows by their own path, locale and tags before pagination and move labels', async () => {
    const requester = { id: 8, permissions: ['read:history'] } as Express.User
    const authority = { requester, permissions: requester.permissions, groups: [], tagAliases: {} }
    const testWiki = wikiGlobal.WIKI as unknown as { auth: TestHistoricalAuth }
    testWiki.auth.checkAccess = vi.fn((_user: unknown, permissions: readonly string[]) => permissions.includes('manage:system') && _user === requester)
    testWiki.auth.checkPageAccess = vi.fn(
      (
        _user: unknown,
        permissions: readonly string[],
        context: { path: string; locale?: string; tags?: readonly { tag: string }[] },
        suppliedAuthority: unknown
      ) =>
        suppliedAuthority === authority &&
        permissions.includes('read:history') &&
        context.locale === 'en' &&
        context.path !== 'restricted/path' &&
        context.tags?.some(tag => tag.tag === 'release') === true
    )

    const oldestId = await insertHistoryRow({
      path: 'old/path',
      title: 'Old',
      content: '# Old\n',
      versionDate: '2026-08-15T00:00:00.000Z'
    })
    await addHistoryTags(oldestId, [2])
    const hiddenId = await insertHistoryRow({
      path: 'restricted/path',
      localeCode: 'fr',
      title: 'Hidden',
      content: '# Hidden\n',
      versionDate: '2026-08-15T00:00:01.000Z'
    })
    await addHistoryTags(hiddenId, [3])
    const latestId = await insertHistoryRow({
      path: 'new/path',
      title: 'New',
      content: '# New\n',
      versionDate: '2026-08-15T00:00:02.000Z'
    })
    await addHistoryTags(latestId, [2])

    const firstPage = await PageHistory.getHistory({ pageId: 42, offsetPage: 0, offsetSize: 1, requester, authority })
    expect(firstPage).toEqual({
      total: 2,
      trail: [
        {
          versionId: latestId,
          authorId: 7,
          authorName: 'Owner',
          actionType: 'move',
          valueBefore: 'old/path',
          sourceRevision: 1,
          isSearchable: true,
          valueAfter: 'new/path',
          versionDate: '2026-08-15T00:00:02.000Z'
        }
      ]
    })
    const secondPage = await PageHistory.getHistory({ pageId: 42, offsetPage: 1, offsetSize: 1, requester, authority })
    expect(secondPage.trail[0]).toMatchObject({
      versionId: oldestId,
      actionType: 'initial',
      valueBefore: null,
      valueAfter: null
    })
    expect(await PageHistory.getVersion({ pageId: 42, versionId: hiddenId, requester, authority })).toBeNull()
    expect(await PageHistory.getVersion({ pageId: 42, versionId: latestId, requester, authority })).toMatchObject({
      content: '# New\n',
      path: 'new/path',
      locale: 'en',
      tags: ['release']
    })
  })

  it('keeps private historical rows limited to their owner or system manager', async () => {
    const owner = { id: 7, permissions: [] } as Express.User
    const stranger = { id: 8, permissions: ['read:history'] } as Express.User
    const system = { id: 1, permissions: ['manage:system'] } as Express.User
    const ownerAuthority = { requester: owner, permissions: owner.permissions, groups: [], tagAliases: {} }
    const strangerAuthority = { requester: stranger, permissions: stranger.permissions, groups: [], tagAliases: {} }
    const systemAuthority = { requester: system, permissions: system.permissions, groups: [], tagAliases: {} }
    const testWiki = wikiGlobal.WIKI as unknown as { auth: TestHistoricalAuth }
    testWiki.auth.checkAccess = vi.fn((user: unknown, permissions: readonly string[]) => user === system && permissions.includes('manage:system'))
    testWiki.auth.checkPageAccess = vi.fn().mockReturnValue(false)
    testWiki.auth.loadPageRuleAuthority = vi.fn(async (user: unknown) =>
      user === owner ? ownerAuthority : user === system ? systemAuthority : strangerAuthority
    )
    const privateId = await insertHistoryRow({
      path: 'private/history',
      visibility: 'private',
      ownerId: 7,
      content: '# Private\n'
    })
    await addHistoryTags(privateId, [2])

    expect(await PageHistory.getVersion({ pageId: 42, versionId: privateId, requester: owner, authority: ownerAuthority })).toMatchObject({
      content: '# Private\n',
      visibility: 'private',
      ownerId: 7
    })
    expect(await PageHistory.getVersion({ pageId: 42, versionId: privateId, requester: stranger, authority: strangerAuthority })).toBeNull()
    expect(await PageHistory.getVersion({ pageId: 42, versionId: privateId, requester: system, authority: systemAuthority })).toMatchObject({
      content: '# Private\n',
      visibility: 'private',
      ownerId: 7
    })
  })
})

/// <reference types="bun" />

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'

const connection = getPostgresTestConnection('_tag_browse_test', import.meta.path)

const suite = connection ? describe : describe.skip

interface ListedPage {
  id: number
  path: string
  tags: string[]
}
interface RecentPageEvidence {
  id: number
  locale: string
  path: string
  title: string
  contentType: string
  sourceRevision: string
  updatedAt: string
  content: string
  sourceContentCharacters: number
  contentTruncated: boolean
  citation: { evidenceId: string; label: string; href: string }
}
interface RecentPageEvidenceResult {
  kind: 'recent-page-evidence'
  requestedLimit: number
  exhausted: boolean
  pages: RecentPageEvidence[]
}
interface PageTagOperations {
  listTags(input: { requester?: Express.User; agentScope?: { kind: 'selected'; pageIds: number[] } }): Promise<Array<{ tag: string }>>
  list(input: {
    requester?: Express.User
    tags?: string[]
    creatorId?: number
    authorId?: number
    locale?: string
    limit?: number
    offset?: number
  }): Promise<ListedPage[]>
  listRecent(input: { requester?: Express.User; locale?: string; limit?: number }): Promise<RecentPageEvidenceResult>
  searchTags(input: { requester?: Express.User; query: string; limit?: number; agentScope?: { kind: 'selected'; pageIds: number[] } }): Promise<string[]>
}

suite('PostgreSQL page tag authorization candidates', () => {
  let db: Knex
  let operations: PageTagOperations
  let boundedRecentContentPrefix: (source: string, maximumBytes?: number) => string
  const originalWiki = globalThis.WIKI
  const requester = { id: 7 } as Express.User
  const tagIds: Record<string, number> = {
    topic: 1,
    'old-topic': 2,
    'deny-access': 3,
    'allow-access': 4,
    'topic-alpha': 5,
    'topic-zulu': 6,
    other: 7
  }
  const accessCalls: Array<{ path: string; tags: string[]; allowed: boolean }> = []
  const now = '2026-09-01T00:00:00.000Z'

  const seedPage = async (
    page: {
      id: number
      path: string
      localeCode?: string
      visibility?: 'public' | 'private'
      ownerId?: number | null
      creatorId?: number
      authorId?: number
      updatedAt?: string
    },
    tags: string[]
  ): Promise<void> => {
    await db('pages').insert({
      id: page.id,
      path: page.path,
      localeCode: page.localeCode ?? 'en',
      title: page.path,
      description: `${page.path} description`,
      content: `# ${page.path}\n\nSynthetic source for recent evidence.`,
      sourceRevision: 1,
      isPublished: true,
      isSearchable: true,
      publishStartDate: null,
      publishEndDate: null,
      visibility: page.visibility ?? 'public',
      ownerId: page.ownerId ?? null,
      creatorId: page.creatorId ?? 100,
      authorId: page.authorId ?? 200,
      contentType: 'markdown',
      createdAt: now,
      updatedAt: page.updatedAt ?? now
    })
    await db('pageTags').insert(tags.map(tag => ({ pageId: page.id, tagId: tagIds[tag] })))
  }

  const assignTags = async (pageId: number, names: string[]): Promise<void> => {
    const maximum = await db('tags').max<{ maximum: number | null }>('id as maximum').first()
    const tags = names.map((tag, index) => ({ id: (maximum?.maximum ?? 0) + index + 1, tag }))
    await db('tags').insert(tags)
    await db('pageTags').insert(tags.map(tag => ({ pageId, tagId: tag.id })))
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection, pool: { min: 0, max: 8 } })
    await db.raw('DROP TABLE IF EXISTS "pageUnlockGrants", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
    await db.raw(`
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        path text NOT NULL,
        "localeCode" text NOT NULL,
        title text NOT NULL,
        description text,
        content text NOT NULL,
        "sourceRevision" integer NOT NULL,
        "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL,
        "publishStartDate" timestamptz,
        "publishEndDate" timestamptz,
        visibility text NOT NULL,
        "ownerId" integer,
        "creatorId" integer NOT NULL,
        "authorId" integer NOT NULL,
        "contentType" text NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL UNIQUE,
        title text,
        "redirectToId" integer,
        "isArchived" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY,
        version integer NOT NULL
      );
      CREATE TABLE "pageUnlockGrants" (
        "pageId" integer NOT NULL,
        "sessionId" text NOT NULL,
        "userId" integer NOT NULL,
        "passwordVersion" integer NOT NULL,
        "expiresAt" timestamptz NOT NULL
      );
    `)

    const checkAccess = (candidate: unknown, permissions: readonly string[], context: Record<string, unknown> = {}) => {
      if (permissions.includes('manage:system')) {
        return (
          candidate !== null &&
          typeof candidate === 'object' &&
          Array.isArray(Reflect.get(candidate, 'permissions')) &&
          Reflect.get(candidate, 'permissions').includes('manage:system')
        )
      }
      if (!permissions.includes('read:pages')) return false
      const path = typeof context.path === 'string' ? context.path : ''
      const names = Array.isArray(context.tags)
        ? context.tags
            .map(tag => (typeof tag === 'string' ? tag : tag !== null && typeof tag === 'object' ? Reflect.get(tag, 'tag') : undefined))
            .filter((tag): tag is string => typeof tag === 'string')
        : []
      const allowed =
        path === 'docs/topic-denied'
          ? names.includes('topic') && !names.includes('deny-access')
          : path === 'docs/topic-allow-needed'
            ? names.includes('allow-access')
            : names.includes('topic') || names.includes('allow-access')
      accessCalls.push({ path, tags: names, allowed })
      return allowed
    }
    const loadPageRuleAuthority = async (requester: unknown) => {
      const tags = await db('tags').select('id', 'tag', 'redirectToId', 'isArchived')
      const byId = new Map(tags.map(tag => [tag.id, tag]))
      const tagAliases = Object.fromEntries(tags.map(tag => [tag.tag, tag.redirectToId === null ? tag.tag : (byId.get(tag.redirectToId)?.tag ?? null)]))
      return { requester, permissions: [], groups: [], tagAliases }
    }
    const wiki = {
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      models: { knex: db, pages: {} as unknown }
    }
    globalThis.WIKI = wiki as never

    const [{ default: Page }, { default: Tag }] = await Promise.all([import('../models/pages.ts'), import('../models/tags.ts')])
    Page.knex(db)
    Tag.knex(db)
    wiki.models.pages = Page
    const pageOperationsModule = (await vi.importFresh('../operations/pages.ts', import.meta.url)) as {
      default: PageTagOperations
      boundedRecentContentPrefix: (source: string, maximumBytes?: number) => string
    }
    operations = pageOperationsModule.default
    boundedRecentContentPrefix = pageOperationsModule.boundedRecentContentPrefix
  })

  beforeEach(async () => {
    accessCalls.length = 0
    await db('pageTags').delete()
    await db('pages').delete()
    await db('tags').delete()
    await db('tags').insert([
      { id: tagIds.topic, tag: 'topic', title: 'Topic', redirectToId: null, isArchived: false },
      { id: tagIds['old-topic'], tag: 'old-topic', title: 'Old topic', redirectToId: tagIds.topic, isArchived: false },
      { id: tagIds['deny-access'], tag: 'deny-access', title: 'Deny access', redirectToId: null, isArchived: false },
      { id: tagIds['allow-access'], tag: 'allow-access', title: 'Allow access', redirectToId: null, isArchived: false },
      { id: tagIds['topic-alpha'], tag: 'topic-alpha', title: 'Topic alpha', redirectToId: null, isArchived: false },
      { id: tagIds['topic-zulu'], tag: 'topic-zulu', title: 'Topic zulu', redirectToId: null, isArchived: false },
      { id: tagIds.other, tag: 'other', title: 'Other', redirectToId: null, isArchived: false }
    ])

    await seedPage({ id: 1, path: 'docs/topic-denied', creatorId: 10, authorId: 11, updatedAt: '2026-09-01T12:00:00.000Z' }, ['topic', 'deny-access'])
    await seedPage({ id: 2, path: 'docs/topic-allow-needed', creatorId: 12, authorId: 13, updatedAt: '2026-09-01T11:00:00.000Z' }, [
      'topic',
      'allow-access',
      'topic-zulu'
    ])
    await seedPage({ id: 3, path: 'docs/topic-other', creatorId: 14, authorId: 15, updatedAt: '2026-09-01T10:00:00.000Z' }, [
      'topic',
      'allow-access',
      'topic-alpha'
    ])
    await seedPage({ id: 4, path: 'docs/unrelated', updatedAt: '2026-09-01T09:00:00.000Z' }, ['allow-access'])
    await seedPage({ id: 5, path: 'private/owned', visibility: 'private', ownerId: 7, updatedAt: '2026-09-01T08:00:00.000Z' }, ['topic', 'allow-access'])
    await seedPage({ id: 6, path: 'private/other', visibility: 'private', ownerId: 8, authorId: 20, updatedAt: '2026-09-01T07:00:00.000Z' }, [
      'topic',
      'allow-access'
    ])
    await seedPage({ id: 7, path: 'scope/creator', creatorId: 31, authorId: 99, updatedAt: '2026-09-01T06:00:00.000Z' }, ['topic', 'allow-access'])
    await seedPage({ id: 8, path: 'scope/author', creatorId: 99, authorId: 32, updatedAt: '2026-09-01T05:00:00.000Z' }, ['topic', 'allow-access'])
    await seedPage({ id: 9, path: 'scope/foreign-locale', localeCode: 'fr', creatorId: 99, authorId: 32, updatedAt: '2026-09-01T04:00:00.000Z' }, [
      'topic',
      'allow-access'
    ])
    await seedPage({ id: 10, path: 'scope/foreign-no-tag', creatorId: 99, authorId: 32, updatedAt: '2026-09-01T03:00:00.000Z' }, ['allow-access'])
    await seedPage({ id: 11, path: 'scope/recent-last', updatedAt: '2026-09-01T02:00:00.000Z' }, ['allow-access'])
  })

  afterAll(async () => {
    globalThis.WIKI = originalWiki as never
    if (db) {
      await db.raw('DROP TABLE IF EXISTS "pageUnlockGrants", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
      await db.destroy()
    }
  })

  it('keeps the complete tag relation for ACL checks while resolving aliases and enforcing AND matches', async () => {
    const rows = await operations.list({ requester, tags: ['old-topic'] })

    const paths = rows.map(row => row.path)
    expect(paths).not.toContain('docs/topic-denied')
    expect(paths).toContain('docs/topic-allow-needed')
    expect(paths).toContain('docs/topic-other')
    expect(paths).toContain('private/owned')
    expect(paths).not.toContain('private/other')
    expect(new Set(rows.find(row => row.path === 'docs/topic-allow-needed')?.tags)).toEqual(new Set(['topic', 'allow-access', 'topic-zulu']))
    expect(accessCalls.find(call => call.path === 'docs/topic-denied')).toMatchObject({
      path: 'docs/topic-denied',
      allowed: false,
      tags: expect.arrayContaining(['topic', 'deny-access'])
    })
    expect(accessCalls.find(call => call.path === 'docs/topic-allow-needed')).toMatchObject({
      path: 'docs/topic-allow-needed',
      allowed: true,
      tags: expect.arrayContaining(['topic', 'allow-access'])
    })

    const andRows = await operations.list({ requester, tags: ['old-topic', 'topic-zulu'] })
    expect(andRows.map(row => row.path)).toEqual(['docs/topic-allow-needed'])
  })
  it('paginates all-tag matches without letting an earlier public partial match consume the limit or offset', async () => {
    await db('pageTags').where({ pageId: 1, tagId: tagIds['deny-access'] }).delete()
    const tags = ['topic', 'allow-access']

    const matchingRows = await operations.list({ requester, tags })
    expect(matchingRows.map(row => row.id)).toEqual([2, 3, 5, 7, 8, 9])

    const firstRows = await operations.list({ requester, tags, limit: 1 })
    expect(firstRows.map(row => row.id)).toEqual([2])
    const offsetRows = await operations.list({ requester, tags, limit: 1, offset: 1 })
    expect(offsetRows.map(row => row.id)).toEqual([3])
  })

  it('paginates authorized tag matches without letting an earlier denied row consume the limit or offset', async () => {
    const firstRows = await operations.list({ requester, tags: ['old-topic'], limit: 1 })
    expect(firstRows.map(row => row.id)).toEqual([2])
    expect(new Set(firstRows[0]?.tags)).toEqual(new Set(['topic', 'allow-access', 'topic-zulu']))

    const offsetRows = await operations.list({ requester, tags: ['old-topic'], limit: 2, offset: 1 })
    expect(offsetRows.map(row => row.id)).toEqual([3, 5])
    expect(new Set(offsetRows[0]?.tags)).toEqual(new Set(['topic', 'allow-access', 'topic-alpha']))
  })

  it('filters denied recent pages after fetching their complete tag relation', async () => {
    const recent = await operations.listRecent({ requester, limit: 10 })
    const paths = recent.pages.map(row => row.path)

    expect(paths).not.toContain('docs/topic-denied')
    expect(paths).toContain('scope/foreign-no-tag')
    expect(paths).toContain('scope/recent-last')
    expect(recent.kind).toBe('recent-page-evidence')
    expect(recent.requestedLimit).toBe(10)
    expect(recent.exhausted).toBe(true)
    expect(accessCalls.find(call => call.path === 'docs/topic-denied')).toMatchObject({
      path: 'docs/topic-denied',
      allowed: false,
      tags: expect.arrayContaining(['topic', 'deny-access'])
    })
  })
  it('bounds exact Unicode and escaped recent prefixes without normalizing source text', () => {
    const source = `${'😀<'.repeat(2_000)}tail`
    const content = boundedRecentContentPrefix(source)
    const encoded = JSON.stringify(JSON.stringify(content)).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(2_048)
    expect(content).toBe(source.slice(0, content.length))
    expect(content).toContain('😀<')
    expect(content).not.toContain('…')
    expect(content.length).toBeLessThan(source.length)
    expect(content.at(-1)).not.toBe('\ud83d')
  })
  it('orders by stable updatedAt/id keys, backfills denied candidates, and reports continuation', async () => {
    await db('pages').where('id', 3).update({ updatedAt: '2026-09-01T11:00:00.000Z' })
    const recent = await operations.listRecent({ requester, locale: 'en', limit: 2 })
    expect(recent.pages.map(page => page.path)).toEqual(['docs/topic-allow-needed', 'docs/topic-other'])
    expect(recent.requestedLimit).toBe(2)
    expect(recent.exhausted).toBe(false)
    expect(recent.pages[0]).toMatchObject({
      sourceRevision: '1',
      content: '# docs/topic-allow-needed\n\nSynthetic source for recent evidence.',
      citation: { evidenceId: 'page:2:revision:1', href: '/en/docs/topic-allow-needed' }
    })
    expect(recent.pages.some(page => page.path.startsWith('private/'))).toBe(false)
  })

  it('filters locale before satisfying the recent limit and marks a short traversal exhausted', async () => {
    const recent = await operations.listRecent({ requester, locale: 'fr', limit: 2 })
    expect(recent.pages.map(page => page.path)).toEqual(['scope/foreign-locale'])
    expect(recent.exhausted).toBe(true)
  })

  it('authorizes tag suggestions against full assignments, returns only matches, and preserves ordering and limits', async () => {
    const suggestions = await operations.searchTags({ requester, query: 'ToPiC', limit: 2 })

    expect(suggestions).toEqual(['topic', 'topic-alpha'])
    expect(suggestions).not.toContain('allow-access')
    expect(suggestions).not.toContain('deny-access')
    expect(accessCalls.find(call => call.path === 'docs/topic-denied')).toMatchObject({
      path: 'docs/topic-denied',
      allowed: false,
      tags: expect.arrayContaining(['topic', 'deny-access'])
    })
    expect(accessCalls.find(call => call.path === 'docs/topic-allow-needed')).toMatchObject({
      path: 'docs/topic-allow-needed',
      allowed: true,
      tags: expect.arrayContaining(['topic', 'allow-access'])
    })
    const observedPaths = accessCalls.map(call => call.path)
    expect(observedPaths).toEqual(expect.arrayContaining(['docs/topic-denied', 'docs/topic-allow-needed']))
    expect(observedPaths).not.toContain('docs/unrelated')
  })

  it('returns selected-page taxonomy from real joined rows without admitting sibling or denied tags', async () => {
    const agentScope = { kind: 'selected' as const, pageIds: [2] }
    expect(await operations.searchTags({ requester, query: 'topic', limit: 20, agentScope })).toEqual(['topic', 'topic-zulu'])
    expect((await operations.listTags({ requester, agentScope })).map(tag => tag.tag)).toEqual(['allow-access', 'topic', 'topic-zulu'])
    expect(await operations.searchTags({ requester, query: 'topic', agentScope: { kind: 'selected', pageIds: [1] } })).toEqual([])
    expect(await operations.listTags({ requester, agentScope: { kind: 'selected', pageIds: [1] } })).toEqual([])
    expect(await operations.searchTags({ requester, query: 'topic', agentScope: { kind: 'selected', pageIds: [] } })).toEqual([])
  })

  it('includes another owner private taxonomy only for a system manager and still enforces selected IDs', async () => {
    await assignTags(6, ['manager-only'])
    expect(await operations.searchTags({ requester, query: 'manager-only' })).toEqual([])
    expect((await operations.listTags({ requester })).map(tag => tag.tag)).not.toContain('manager-only')
    const manager = { id: 1, permissions: ['manage:system'] } as Express.User
    expect(await operations.searchTags({ requester: manager, query: 'manager-only' })).toEqual(['manager-only'])
    expect((await operations.listTags({ requester: manager })).map(tag => tag.tag)).toContain('manager-only')
    expect((await operations.list({ requester, tags: ['manager-only'] })).map(row => row.id)).toEqual([])
    expect((await operations.list({ requester: manager, tags: ['manager-only'] })).map(row => row.id)).toEqual([6])
    const agentScope = { kind: 'selected' as const, pageIds: [5] }
    expect(await operations.searchTags({ requester: manager, query: 'manager-only', agentScope })).toEqual([])
    expect((await operations.listTags({ requester: manager, agentScope })).map(tag => tag.tag)).not.toContain('manager-only')
  })

  it('excludes public drafts and closed windows while applying current private ownership and searchability policy', async () => {
    const states = [{ isPublished: false }, { publishStartDate: '2099-01-01T00:00:00.000Z' }, { publishEndDate: '2000-01-01T00:00:00.000Z' }]
    for (const [index, state] of states.entries()) {
      const publicId = 20 + index
      const privateId = 30 + index
      await seedPage({ id: publicId, path: `docs/publication-${index}` }, ['allow-access'])
      await seedPage({ id: privateId, path: `private/publication-${index}`, visibility: 'private', ownerId: 7 }, ['allow-access'])
      await db('pages').whereIn('id', [publicId, privateId]).update(state)
      await assignTags(publicId, [`publication-public-${index}`])
      await assignTags(privateId, [`publication-private-${index}`])
    }
    await seedPage({ id: 40, path: 'docs/publication-live' }, ['allow-access'])
    await assignTags(40, ['publication-live'])
    await db('pages').where('id', 40).update({
      publishStartDate: '2000-01-01T00:00:00.000Z',
      publishEndDate: '2099-01-01T00:00:00.000Z'
    })
    const expected = ['publication-live', 'publication-private-0', 'publication-private-1', 'publication-private-2']
    expect(await operations.searchTags({ requester, query: 'publication-', limit: 20 })).toEqual(expected)
    expect((await operations.listTags({ requester })).map(tag => tag.tag).filter(tag => tag.startsWith('publication-'))).toEqual(expected)

    await db('pages').where('id', 30).update({ ownerId: 8 })
    await db('pages').where('id', 31).update({ isSearchable: false })
    const current = ['publication-live', 'publication-private-2']
    expect(await operations.searchTags({ requester, query: 'publication-', limit: 20 })).toEqual(current)
    expect((await operations.listTags({ requester })).map(tag => tag.tag).filter(tag => tag.startsWith('publication-'))).toEqual(current)
    const manager = { id: 1, permissions: ['manage:system'] } as Express.User
    const managerExpected = ['publication-live', 'publication-private-0', 'publication-private-2']
    expect(await operations.searchTags({ requester: manager, query: 'publication-', limit: 20 })).toEqual(managerExpected)
    expect((await operations.listTags({ requester: manager })).map(tag => tag.tag).filter(tag => tag.startsWith('publication-'))).toEqual(managerExpected)
  })

  it('matches backslashes, trailing backslashes, percent and underscore literally in PostgreSQL candidates', async () => {
    const literalTags = ['ops\\runbook', 'ops\\', 'ops%rate', 'ops_rate']
    for (const [index, tag] of literalTags.entries()) {
      const id = 50 + index
      await seedPage({ id, path: `docs/literal-${index}` }, ['allow-access'])
      await assignTags(id, [tag])
    }
    await seedPage({ id: 60, path: 'docs/literal-decoy' }, ['allow-access'])
    await assignTags(60, ['opsrunbook', 'opsXrate'])
    const searches = [
      { query: 'ops\\runbook', expected: ['ops\\runbook'] },
      { query: 'ops\\', expected: ['ops\\', 'ops\\runbook'] },
      { query: '%', expected: ['ops%rate'] },
      { query: '_', expected: ['ops_rate'] }
    ]
    for (const { query, expected } of searches) {
      accessCalls.length = 0
      expect(await operations.searchTags({ requester, query, limit: 20 })).toEqual(expected)
      expect(accessCalls.map(call => call.path)).not.toContain('docs/literal-decoy')
    }
  })

  it('keeps creator and author alternatives inside locale, ownership, and tag scope', async () => {
    const rows = await operations.list({
      requester,
      creatorId: 31,
      authorId: 32,
      locale: 'en',
      tags: ['old-topic']
    })

    expect(rows.map(row => row.path).sort()).toEqual(['scope/author', 'scope/creator'])
  })
})

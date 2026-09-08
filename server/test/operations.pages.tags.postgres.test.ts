/// <reference types="bun" />

import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_tag_browse_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        database,
        password
      }
    : null

const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('operations.pages.tags.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error(
    'Explicit page tag PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _tag_browse_test and a PostgreSQL password or WIKI_TEST_POSTGRES_PASSWORD_FILE.'
  )
}

const suite = connection ? describe : describe.skip

interface ListedPage {
  path: string
  tags: string[]
}
interface RecentPage {
  path: string
  visibility: string
}
interface PageTagOperations {
  list(input: {
    requester?: Express.User
    tags?: string[]
    creatorId?: number
    authorId?: number
    locale?: string
    limit?: number
    offset?: number
  }): Promise<ListedPage[]>
  listRecent(requester?: Express.User): Promise<RecentPage[]>
  searchTags(input: { requester?: Express.User; query: string; limit?: number }): Promise<string[]>
}

suite('PostgreSQL page tag authorization candidates', () => {
  let db: Knex
  let operations: PageTagOperations
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
      isPublished: true,
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

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection, pool: { min: 0, max: 8 } })
    await db.raw('DROP TABLE IF EXISTS "pageTags", tags, pages CASCADE')
    await db.raw(`
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        path text NOT NULL,
        "localeCode" text NOT NULL,
        title text NOT NULL,
        description text,
        "isPublished" boolean NOT NULL,
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
    `)

    const wiki = {
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      auth: {
        checkAccess: (candidate: unknown, permissions: readonly string[], context: Record<string, unknown> = {}) => {
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
      },
      models: { knex: db, pages: {} as unknown }
    }
    globalThis.WIKI = wiki as never

    const [{ default: Page }, { default: Tag }] = await Promise.all([import('../models/pages.ts'), import('../models/tags.ts')])
    Page.knex(db)
    Tag.knex(db)
    wiki.models.pages = Page
    operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default as unknown as PageTagOperations
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
      await db.raw('DROP TABLE IF EXISTS "pageTags", tags, pages CASCADE')
      await db.destroy()
    }
  })

  it('keeps the complete tag relation for ACL checks while resolving aliases and enforcing AND matches', async () => {
    const sql: string[] = []
    const queryListener = ({ sql: statement }: { sql: string }) => sql.push(statement)
    db.on('query', queryListener)
    let rows: ListedPage[]
    try {
      rows = await operations.list({ requester, tags: ['old-topic'] })
    } finally {
      db.removeListener('query', queryListener)
    }

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
    expect(sql.filter(statement => /from "pages"/iu.test(statement))).toHaveLength(1)

    const andRows = await operations.list({ requester, tags: ['old-topic', 'topic-zulu'] })
    expect(andRows.map(row => row.path)).toEqual(['docs/topic-allow-needed'])
  })
  it('applies root limits and offsets without truncating tags needed for later authorization', async () => {
    expect(await operations.list({ requester, tags: ['old-topic'], limit: 1 })).toEqual([])

    const offsetRows = await operations.list({ requester, tags: ['old-topic'], limit: 1, offset: 1 })
    expect(offsetRows.map(row => row.path)).toEqual(['docs/topic-allow-needed'])
    expect(new Set(offsetRows[0]?.tags)).toEqual(new Set(['topic', 'allow-access', 'topic-zulu']))
  })

  it('filters denied recent pages after fetching their complete tag relation', async () => {
    const recent = await operations.listRecent(requester)
    const paths = recent.map(row => row.path)

    expect(paths).not.toContain('docs/topic-denied')
    expect(paths).toContain('scope/foreign-no-tag')
    expect(paths).toContain('scope/recent-last')
    expect(accessCalls.find(call => call.path === 'docs/topic-denied')).toMatchObject({
      path: 'docs/topic-denied',
      allowed: false,
      tags: expect.arrayContaining(['topic', 'deny-access'])
    })
  })

  it('authorizes tag suggestions against full assignments, returns only matches, and preserves ordering and limits', async () => {
    const sql: string[] = []
    const queryListener = ({ sql: statement }: { sql: string }) => sql.push(statement)
    db.on('query', queryListener)
    let suggestions: string[]
    try {
      suggestions = await operations.searchTags({ requester, query: 'ToPiC', limit: 2 })
    } finally {
      db.removeListener('query', queryListener)
    }

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
    expect(sql.filter(statement => /from "pages"/iu.test(statement))).toHaveLength(1)
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

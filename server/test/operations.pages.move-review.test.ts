/// <reference types="bun" />

import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { evaluateGroupAccess, type PageRuleAuthority } from '../helpers/group-access.ts'
import { verifyPageMoveReviewToken } from '../helpers/page-move-review-token.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = database.endsWith('_move_review_test') && password
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      database,
      password
    }
  : null
const directlyInvoked = !String(process.env.npm_lifecycle_event ?? '').startsWith('test') &&
  process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('operations.pages.move-review.test.ts'))
if ((directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1') && !connection) {
  throw new Error('Explicit move review PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _move_review_test and a PostgreSQL password or WIKI_TEST_POSTGRES_PASSWORD_FILE.')
}
const suite = connection ? describe : describe.skip

interface ReviewItem {
  id: number
  title: string
  path: string
  eligible: boolean
  changes: Array<{ before: string; after: string }>
}
interface MoveReview {
  items: ReviewItem[]
  nextCursor: string | null
  reviewToken?: string
}
interface MoveOperations {
  reviewMoveLinks(input: { requester?: Express.User; sessionId?: string; input: Record<string, unknown> }): Promise<MoveReview>
}

suite('PostgreSQL reviewed page move authorization', () => {
  let db: Knex
  let operations: MoveOperations
  const originalWiki = globalThis.WIKI
  const secret = 'move-review-test-secret'
  const reviewer = { id: 7, permissions: ['read:pages', 'write:pages'] } as Express.User
  const reader = { id: 8, permissions: ['read:pages'] } as Express.User
  const readable = new Set(['docs/old', 'docs/new', 'docs/editable', 'docs/read-only', 'docs/draft'])
  const writable = new Set(['docs/old', 'docs/new', 'docs/editable'])
  const now = '2026-09-01T00:00:00.000Z'

  const authorityFor = (requester: Express.User | undefined): PageRuleAuthority => ({
    requester,
    permissions: requester === reviewer ? ['read:pages', 'write:pages'] : requester === reader ? ['read:pages'] : [],
    groups: [{
      id: 1,
      pageRules: [
        ...[...readable].map(path => ({ match: 'EXACT' as const, path, deny: false, roles: ['read:pages'], locales: ['en'] })),
        ...[...writable].map(path => ({ match: 'EXACT' as const, path, deny: false, roles: ['write:pages'], locales: ['en'] }))
      ]
    }],
    tagAliases: {}
  })
  const seedPage = async (id: number, path: string, options: {
    content?: string
    isPublished?: boolean
    visibility?: 'public' | 'private'
    ownerId?: number | null
  } = {}): Promise<void> => {
    await db('pages').insert({
      id,
      path,
      hash: `page-${id}`,
      localeCode: 'en',
      title: `Title ${id}`,
      description: '',
      content: options.content ?? '[Old](/docs/old)',
      render: '',
      toc: '[]',
      sourceRevision: 1,
      renderedSourceRevision: null,
      isPublished: options.isPublished ?? true,
      isSearchable: true,
      publishStartDate: null,
      publishEndDate: null,
      visibility: options.visibility ?? 'public',
      ownerId: options.ownerId ?? null,
      authorId: 7,
      creatorId: 7,
      contentType: 'markdown',
      editorKey: 'markdown',
      extra: {},
      createdAt: now,
      updatedAt: now
    })
    await db('pageLinks').insert({ pageId: id, localeCode: 'en', path: 'docs/old' })
    await db('pageMutationOutbox').insert({ pageId: id, sourceRevision: 1, effectKind: 'links', desiredState: 'present', status: 'succeeded' })
  }
  const review = (selectedPageIds?: number[], requester: Express.User = reviewer, sessionId = 'reviewer-session') =>
    operations.reviewMoveLinks({
      requester,
      sessionId,
      input: {
        id: 1,
        expectedSourceRevision: '1',
        destinationLocale: 'en',
        destinationPath: 'docs/new',
        ...(selectedPageIds === undefined ? {} : { selectedPageIds })
      }
    })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection, pool: { min: 0, max: 8 } })
    await db.raw('DROP TABLE IF EXISTS "pageCollaborationRooms", "pageUnlockGrants", "pageAccessPasswords", "pageApprovalRequests", "pageMutationOutbox", "pageLinks", "pageTags", tags, pages, users CASCADE')
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL);
      CREATE TABLE pages (
        id integer PRIMARY KEY, path text NOT NULL, hash text NOT NULL, "localeCode" text NOT NULL,
        title text NOT NULL, description text, content text NOT NULL, render text, toc text,
        "sourceRevision" integer NOT NULL, "renderedSourceRevision" integer,
        "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL,
        "publishStartDate" timestamptz, "publishEndDate" timestamptz,
        visibility text NOT NULL, "ownerId" integer, "authorId" integer NOT NULL,
        "creatorId" integer NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL,
        extra jsonb NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL, title text);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageLinks" ("pageId" integer NOT NULL, "localeCode" text NOT NULL, path text NOT NULL);
      CREATE TABLE "pageMutationOutbox" (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "pageId" integer NOT NULL,
        "sourceRevision" integer NOT NULL, "effectKind" text NOT NULL,
        "desiredState" text NOT NULL, status text NOT NULL
      );
      CREATE TABLE "pageApprovalRequests" (id integer PRIMARY KEY, "pageId" integer, status text);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, version integer NOT NULL);
      CREATE TABLE "pageUnlockGrants" (
        "pageId" integer, "sessionId" text, "userId" integer, "passwordVersion" integer, "expiresAt" timestamptz
      );
      CREATE TABLE "pageCollaborationRooms" ("pageId" integer PRIMARY KEY);
    `)
    await db('users').insert({ id: 7, name: 'Reviewer', email: 'reviewer@example.test' })
    const wiki = {
      config: { db: { type: 'postgres' }, lang: { code: 'en', namespacing: false }, sessionSecret: secret },
      Error: { PageMoveForbidden: class PageMoveForbidden extends Error {} },
      logger: { warn: () => {} },
      auth: {
        checkAccess: (requester: Express.User | undefined, permissions: string[]) =>
          permissions.some(permission => authorityFor(requester).permissions.includes(permission)),
        checkPageAccess: (requester: Express.User | undefined, permissions: string[], context: { path: string; locale: string; tags: Array<{ tag: string }> }, authority: PageRuleAuthority) =>
          authority.requester === requester && evaluateGroupAccess(authority.permissions, permissions, authority.groups, context, authority.tagAliases, false).allowed,
        loadPageRuleAuthority: async (requester: Express.User | undefined) => authorityFor(requester)
      },
      models: { knex: db, pages: {} as unknown }
    }
    globalThis.WIKI = wiki as never
    // Page and Tag capture WIKI at module initialization; load only after installing this isolated database.
    const [{ default: Page }, { default: Tag }] = await Promise.all([import('../models/pages.ts'), import('../models/tags.ts')])
    Page.knex(db)
    Tag.knex(db)
    wiki.models.pages = Page
    operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default as MoveOperations
  })
  beforeEach(async () => {
    for (const table of ['pageCollaborationRooms', 'pageUnlockGrants', 'pageAccessPasswords', 'pageApprovalRequests', 'pageMutationOutbox', 'pageLinks', 'pageTags', 'pages']) {
      await db(table).delete()
    }
    readable.clear()
    writable.clear()
    for (const path of ['docs/old', 'docs/new', 'docs/editable', 'docs/read-only', 'docs/draft']) readable.add(path)
    for (const path of ['docs/old', 'docs/new', 'docs/editable']) writable.add(path)
    await seedPage(1, 'docs/old', { content: '# Moved page' })
  })
  afterAll(async () => {
    globalThis.WIKI = originalWiki as never
    if (db) {
      await db.raw('DROP TABLE IF EXISTS "pageCollaborationRooms", "pageUnlockGrants", "pageAccessPasswords", "pageApprovalRequests", "pageMutationOutbox", "pageLinks", "pageTags", tags, pages, users CASCADE')
      await db.destroy()
    }
  })

  it('requires an interactive reviewer allowed to edit both the original and destination', async () => {
    await seedPage(2, 'docs/editable')
    await expect(review(undefined, reader)).rejects.toMatchObject({ status: 404, name: 'MOVE_REVIEW_UNAVAILABLE' })
    await expect(review(undefined, reviewer, '')).rejects.toMatchObject({ status: 403, name: 'MOVE_REVIEW_UNAVAILABLE' })
    writable.delete('docs/new')
    await expect(review()).rejects.toBeInstanceOf(globalThis.WIKI.Error.PageMoveForbidden)
    writable.add('docs/new')
    expect((await review()).items.map(item => item.id)).toEqual([2])
  })

  it('does not disclose draft source or metadata to a reader who cannot edit unpublished referrers', async () => {
    await seedPage(2, 'docs/editable')
    await seedPage(3, 'docs/draft', { isPublished: false, content: '[Secret title](/docs/old)' })
    await seedPage(4, 'docs/read-only', { visibility: 'private', ownerId: 8, content: '[Private](/docs/old)' })
    const result = await review()
    expect(result.items.map(item => item.id)).toEqual([2])
    expect(JSON.stringify(result)).not.toContain('Secret title')
    expect(JSON.stringify(result)).not.toContain('docs/draft')
    expect(JSON.stringify(result)).not.toContain('Title 3')
    expect(JSON.stringify(result)).not.toContain('Private')
    await expect(review([3])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_STALE' })
    await expect(review([4])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_STALE' })
  })

  it('shows readable published referrers but refuses repair without write access or current index receipt', async () => {
    await seedPage(2, 'docs/editable')
    await seedPage(3, 'docs/read-only')
    await seedPage(4, 'docs/editable-stale')
    readable.add('docs/editable-stale')
    writable.add('docs/editable-stale')
    await db('pageMutationOutbox').where({ pageId: 4 }).delete()
    const items = (await review()).items
    expect(items.find(item => item.id === 2)).toMatchObject({ eligible: true, changes: [{ before: '/docs/old', after: '/docs/new' }] })
    expect(items.find(item => item.id === 3)).toMatchObject({ eligible: false, changes: [{ before: '/docs/old', after: '/docs/new' }] })
    expect(items.find(item => item.id === 4)).toMatchObject({ eligible: false, changes: [] })
    await expect(review([3])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_INELIGIBLE' })
    await expect(review([4])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_INELIGIBLE' })
  })

  it('binds an issued selection to its reviewer and current persisted page revision', async () => {
    await seedPage(2, 'docs/editable')
    const selected = await review([2])
    const token = selected.reviewToken
    expect(typeof token).toBe('string')
    const verified = verifyPageMoveReviewToken({ token, secret, requesterId: 7, sessionId: 'reviewer-session' })
    expect(verified).toMatchObject({ targetId: 1, expectedSourceRevision: '1', selected: [{ id: 2, sourceRevision: '1' }] })
    expect(verifyPageMoveReviewToken({ token, secret, requesterId: 8, sessionId: 'reviewer-session' })).toBeNull()
    expect(verifyPageMoveReviewToken({ token, secret, requesterId: 7, sessionId: 'other-session' })).toBeNull()
    expect(verifyPageMoveReviewToken({ token, secret, requesterId: 7, sessionId: 'reviewer-session', now: verified!.expiresAt })).toBeNull()
    await db('pages').where({ id: 2 }).update({ sourceRevision: 2, content: '[Updated](/docs/old)' })
    await expect(review([2])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_INELIGIBLE' })
    await db('pageMutationOutbox').where({ pageId: 2 }).update({ sourceRevision: 2 })
    const refreshed = verifyPageMoveReviewToken({ token: (await review([2])).reviewToken, secret, requesterId: 7, sessionId: 'reviewer-session' })
    expect(refreshed?.selected[0]?.sourceRevision).toBe('2')
    expect(refreshed?.selected[0]?.beforeDigest).not.toBe(verified?.selected[0]?.beforeDigest)
    await db('pageLinks').where({ pageId: 2 }).delete()
    await expect(review([2])).rejects.toMatchObject({ status: 409, name: 'MOVE_REVIEW_STALE' })
  })
})

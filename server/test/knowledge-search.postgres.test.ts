/// <reference types="bun" />

import fs from 'node:fs'

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from './bun-test.mts'
import { up as createKnowledgeProjectionStore } from '../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearchStore } from '../db/migrations/tsepistle-000027-knowledge-search.ts'
import { PageKnowledgeRepository } from '../knowledge/lifecycle.ts'
import { knowledgeSearchText, projectPageKnowledge } from '../knowledge/projection.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'

interface TestRequester {
  readonly id: number
  readonly permissions?: readonly string[]
  readonly canReadPublic?: boolean
}

interface PageFixture {
  readonly id: number
  readonly sourceRevision: number
  readonly path: string
  readonly title: string
  readonly visibility?: 'public' | 'private'
  readonly ownerId?: number | null
  readonly isPublished?: boolean
  readonly publishStartDate?: string | null
  readonly publishEndDate?: string | null
}

const pageRuleAuthority = (requester: unknown): PageRuleAuthority => ({
  requester,
  permissions: ['read:pages'],
  groups: [],
  tagAliases: {}
})

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_knowledge_search_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('knowledge-search.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error(
    'Explicit knowledge-search PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _knowledge_search_test and a PostgreSQL password.'
  )
}

const suite = connection ? describe : describe.skip

suite('PostgreSQL knowledge projection search', () => {
  let db: Knex
  const wikiRuntime = globalThis as typeof globalThis & { WIKI: unknown }
  let originalWiki: unknown

  const fixture = (overrides: Partial<PageFixture>): PageFixture => ({
    id: 1,
    sourceRevision: 1,
    path: 'knowledge/default',
    title: 'Signal Boundary',
    visibility: 'public',
    ownerId: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    ...overrides
  })

  const offsetDate = (time: number, offsetMinutes: number): string => {
    const local = new Date(time + offsetMinutes * 60_000).toISOString().slice(0, -1)
    const absoluteOffset = Math.abs(offsetMinutes)
    const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0')
    const minutes = String(absoluteOffset % 60).padStart(2, '0')
    return `${local}${offsetMinutes >= 0 ? '+' : '-'}${hours}:${minutes}`
  }

  const persistProjection = async (page: PageFixture, storedRevision = page.sourceRevision): Promise<void> => {
    const content = `# ${page.title}\n\n${page.title} source content.`
    const source = {
      pageId: page.id,
      sourceRevision: String(storedRevision),
      locale: 'en',
      path: page.path,
      visibility: page.visibility ?? 'public',
      contentType: 'markdown',
      content,
      title: page.title,
      description: null,
      tags: [],
      updatedAt: '2026-09-09T00:00:00.000Z',
      authorId: 1
    }
    const projection = projectPageKnowledge(source)
    const searchText = knowledgeSearchText(projection)
    await db('pageKnowledgeProjections').insert({
      pageId: page.id,
      sourceRevision: projection.source.sourceRevision,
      sourceSha256: projection.source.sha256,
      schemaVersion: projection.version,
      deterministicVersion: projection.provenance.deterministicVersion,
      state: projection.completeness.state,
      enrichmentState: 'not-needed',
      conceptType: projection.concept.type,
      summary: projection.concept.summary,
      searchText,
      searchDictionary: 'english',
      searchTokens: db.raw('to_tsvector(?::regconfig, ?)', ['english', searchText]),
      lifecycleStatus: projection.lifecycle.status,
      trustTier: projection.lifecycle.trustTier,
      verification: projection.lifecycle.verification,
      staleAfter: projection.lifecycle.staleAfter,
      utilityProfileVersionId: null,
      utilityModel: null,
      utilityInputSha256: null,
      utilityOutputSha256: null,
      utilityGeneratedAt: null,
      projection: JSON.stringify(projection),
      lastError: null,
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z'
    })
  }

  const insertPage = async (page: PageFixture): Promise<void> => {
    const content = `# ${page.title}\n\n${page.title} source content.`
    await db('pages').insert({
      id: page.id,
      sourceRevision: page.sourceRevision,
      path: page.path,
      localeCode: 'en',
      title: page.title,
      description: null,
      content,
      contentType: 'markdown',
      authorId: 1,
      ownerId: page.ownerId ?? null,
      extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } }),
      updatedAt: '2026-09-09T00:00:00.000Z',
      visibility: page.visibility ?? 'public',
      isPublished: page.isPublished ?? true,
      publishStartDate: page.publishStartDate ?? null,
      publishEndDate: page.publishEndDate ?? null
    })
    await persistProjection(page)
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      DROP TABLE IF EXISTS "pageKnowledgeProjections", "pageAccessPasswords", "pageTags", tags, pages CASCADE;
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        path text NOT NULL,
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text,
        content text NOT NULL,
        "contentType" text NOT NULL,
        "authorId" integer NOT NULL,
        "ownerId" integer,
        extra jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        visibility text NOT NULL,
        "isPublished" boolean NOT NULL,
        "publishStartDate" text,
        "publishEndDate" text
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL,
        "tagId" integer NOT NULL
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY
      );
    `)
    await createKnowledgeProjectionStore(db)
    await createKnowledgeSearchStore(db)

    originalWiki = wikiRuntime.WIKI
    wikiRuntime.WIKI = {
      auth: {
        checkAccess: (requester: TestRequester | undefined, permissions: readonly string[], context?: { path?: string }) => {
          if (permissions.includes('manage:system')) return requester?.permissions?.includes('manage:system') ?? false
          return requester?.canReadPublic === true && context?.path !== 'knowledge/denied'
        },
        checkPageAccess: (requester: TestRequester | undefined, permissions: readonly string[], context?: { path?: string }) => {
          if (permissions.includes('manage:system')) return requester?.permissions?.includes('manage:system') ?? false
          return requester?.canReadPublic === true && context?.path !== 'knowledge/denied'
        }
      },
      data: { searchEngine: { config: { dictLanguage: 'english' } } }
    } as never
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE TABLE "pageKnowledgeProjections", "pageAccessPasswords", "pageTags", tags, pages RESTART IDENTITY CASCADE')
  })

  afterAll(async () => {
    if (db) {
      await db.raw('DROP TABLE IF EXISTS "pageKnowledgeProjections", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
      await db.destroy()
    }
    wikiRuntime.WIKI = originalWiki
  })

  it('prefilters selected public IDs before its bounded PostgreSQL candidate scan', async () => {
    for (let id = 1; id <= 11; id += 1) {
      await insertPage(fixture({ id, sourceRevision: id, path: `knowledge/selected-${id}`, title: `Signal Candidate ${id}` }))
    }

    const requester = { id: 9, canReadPublic: true } as never
    const authority = pageRuleAuthority(requester)
    const candidates = await new PageKnowledgeRepository(db).searchVisible({
      query: 'signal',
      requester,
      authority,
      pageIds: [11],
      authorizedPageIds: [11],
      limit: 1
    })

    expect(candidates).toEqual([expect.objectContaining({ id: 11, sourceRevision: '11' })])
  })

  it('enforces publication, password, access, ownership, and current-revision boundaries in PostgreSQL', async () => {
    const visible = fixture({ id: 1, path: 'knowledge/visible', title: 'Visible Boundary' })
    const unpublished = fixture({ id: 2, sourceRevision: 2, path: 'knowledge/unpublished', title: 'Unpublished Boundary', isPublished: false })
    const future = fixture({ id: 3, sourceRevision: 3, path: 'knowledge/future', title: 'Future Boundary', publishStartDate: '2030-01-01T00:00:00.000Z' })
    const protectedPage = fixture({ id: 4, sourceRevision: 4, path: 'knowledge/protected', title: 'Protected Boundary' })
    const denied = fixture({ id: 5, sourceRevision: 5, path: 'knowledge/denied', title: 'Denied Boundary' })
    const ownerPrivate = fixture({ id: 6, sourceRevision: 6, path: 'knowledge/owner', title: 'Owner Boundary', visibility: 'private', ownerId: 7 })
    const stale = fixture({ id: 7, sourceRevision: 2, path: 'knowledge/stale', title: 'Stale Boundary' })
    for (const page of [visible, unpublished, future, protectedPage, denied, ownerPrivate, stale]) await insertPage(page)
    await db('pageAccessPasswords').insert({ pageId: protectedPage.id })
    await db('pageKnowledgeProjections').where({ pageId: stale.id, sourceRevision: stale.sourceRevision }).delete()
    await persistProjection(stale, 1)

    const repository = new PageKnowledgeRepository(db)
    const reader = { id: 9, canReadPublic: true } as never
    const readerAuthority = pageRuleAuthority(reader)
    const publicCandidates = await repository.searchVisible({
      query: 'boundary',
      requester: reader,
      authority: readerAuthority,
      authorizedPageIds: [1, 2, 3, 4, 5, 7],
      limit: 20
    })
    expect(publicCandidates.map(candidate => candidate.id)).toEqual([1])

    const owner = { id: 7, canReadPublic: false } as never
    const ownerCandidates = await repository.searchVisible({ query: 'boundary', requester: owner, authority: pageRuleAuthority(owner), limit: 20 })
    expect(ownerCandidates).toContainEqual(expect.objectContaining({ id: 6, sourceRevision: '6' }))
    const manager = { id: 8, permissions: ['manage:system'], canReadPublic: false } as never
    const managerCandidates = await repository.searchVisible({
      query: 'boundary',
      requester: manager,
      authority: pageRuleAuthority(manager),
      limit: 20
    })
    expect(managerCandidates).toContainEqual(expect.objectContaining({ id: 6, sourceRevision: '6' }))
    expect(
      await repository.filterVisibleCurrentIds({
        requester: reader,
        authority: readerAuthority,
        pageIds: [1, 2, 3, 4, 5, 6, 7],
        authorizedPageIds: [1, 2, 3, 4, 5, 7]
      })
    ).toEqual([1])
    expect(await repository.filterVisibleCurrentIds({ requester: owner, authority: pageRuleAuthority(owner) })).toEqual([6])
  })

  it('filters empty, offset, and invalid publication windows beyond 500 excluded matches before result caps', async () => {
    const now = Date.now()
    for (let id = 1; id <= 501; id += 1) {
      await insertPage(
        fixture({
          id,
          sourceRevision: id,
          path: `knowledge/expired-${id}`,
          title: `Signal Expired ${id}`,
          publishEndDate: '2000-01-01T00:00:00+00:00'
        })
      )
    }
    await insertPage(
      fixture({
        id: 502,
        sourceRevision: 502,
        path: 'knowledge/empty-window',
        title: 'Signal Empty Window',
        publishStartDate: '',
        publishEndDate: ''
      })
    )
    await insertPage(
      fixture({
        id: 503,
        sourceRevision: 503,
        path: 'knowledge/offset-window',
        title: 'Signal Offset Window',
        publishStartDate: offsetDate(now - 3_600_000, 600),
        publishEndDate: offsetDate(now + 3_600_000, -600)
      })
    )
    await insertPage(
      fixture({
        id: 504,
        sourceRevision: 504,
        path: 'knowledge/invalid-window',
        title: 'Signal Invalid Window',
        publishEndDate: 'not-a-date'
      })
    )

    const repository = new PageKnowledgeRepository(db)
    const requester = { id: 9, canReadPublic: true } as never
    const authority = pageRuleAuthority(requester)
    expect((await repository.searchVisible({ query: 'signal', requester, authority, limit: 2 })).map(candidate => candidate.id)).toEqual([502, 503])
    expect(
      await repository.filterVisibleCurrentIds({
        requester,
        authority,
        pageIds: Array.from({ length: 504 }, (_, index) => index + 1),
        authorizedPageIds: Array.from({ length: 504 }, (_, index) => index + 1)
      })
    ).toEqual([502, 503])
  })

  it('returns generated deterministic terms for ordinary searches and preserves structured-query authority', async () => {
    await insertPage(fixture({ id: 42, sourceRevision: 42, path: 'knowledge/amber-falcon', title: 'Amber Falcon Runbook' }))
    const repository = new PageKnowledgeRepository(db)
    const requester = { id: 9, canReadPublic: true } as never
    const authority = pageRuleAuthority(requester)

    expect(await repository.searchVisible({ query: 'AFR', requester, authority, limit: 5 })).toEqual([expect.objectContaining({ id: 42, sourceRevision: '42' })])
    expect(await repository.searchVisible({ query: '"AFR"', requester, authority, limit: 5 })).toEqual([])
  })
})

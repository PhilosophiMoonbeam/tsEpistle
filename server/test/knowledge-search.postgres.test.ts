/// <reference types="bun" />

import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { up as createKnowledgeProjectionStore } from '../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearchStore } from '../db/migrations/tsepistle-000027-knowledge-search.ts'
import { up as createKnowledgeMaintenanceStore } from '../db/migrations/tsfranki-000006-knowledge-maintenance.ts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import { lockSearchIndex } from '../helpers/search-contract.ts'
import { PageKnowledgeLifecycle, PageKnowledgeRepository } from '../knowledge/lifecycle.ts'
import { knowledgeSearchText, projectPageKnowledge } from '../knowledge/projection.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import type PageModel from '../models/pages.ts'

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
  readonly tags?: readonly string[]
  readonly visibility?: 'public' | 'private'
  readonly ownerId?: number | null
  readonly isPublished?: boolean
  readonly isSearchable?: boolean
  readonly publishStartDate?: string | null
  readonly publishEndDate?: string | null
}

const pageRuleAuthority = (requester: unknown): PageRuleAuthority => ({
  requester,
  permissions: ['read:pages'],
  groups: [],
  tagAliases: {}
})

const connection = getPostgresTestConnection('_knowledge_search_test', import.meta.path)
const AUDIT_COOLDOWN_MILLISECONDS = 10 * 60 * 1_000
const advanceToNextAudit = (): void => vi.setSystemTime(new Date(Date.now() + AUDIT_COOLDOWN_MILLISECONDS))

const suite = connection ? describe : describe.skip

suite('PostgreSQL knowledge projection search', () => {
  let db: Knex
  const wikiRuntime = globalThis as typeof globalThis & { WIKI: unknown }
  let originalWiki: unknown
  let operations: {
    search(input: { query: string; requester: Express.User; knowledge?: { trustTier: 'unverified' } }): Promise<{ results: Array<{ id: number; sourceRevision: string }> }>
  }

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
      tags: [...(page.tags ?? [])].sort(),
      updatedAt: '2026-09-09T00:00:00.000Z',
      authorId: 1,
      metadata: { type: 'Procedure', status: 'stable' }
    }
    const projection = projectPageKnowledge(source)
    const searchText = knowledgeSearchText(projection)
    const dictionary = String((await db('pagesSearchMetadata').where({ contractId: 1 }).first('dictionary')).dictionary)
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
      searchDictionary: dictionary,
      searchTokens: db.raw('to_tsvector(?::regconfig, ?)', [dictionary, searchText]),
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
      render: `<article>${page.title} source content.</article>`,
      renderedSourceRevision: page.sourceRevision,
      visibility: page.visibility ?? 'public',
      isPublished: page.isPublished ?? true,
      ...(page.isSearchable === undefined ? {} : { isSearchable: page.isSearchable }),
      publishStartDate: page.publishStartDate ?? null,
      publishEndDate: page.publishEndDate ?? null
    })
    for (const tag of [...new Set(page.tags ?? [])].sort()) {
      await db('tags').insert({ tag }).onConflict('tag').ignore()
      const stored = await db('tags').where({ tag }).first('id')
      await db('pageTags').insert({ pageId: page.id, tagId: stored.id })
    }
    await persistProjection(page)
  }

  const enableUtilityEnrichment = async (): Promise<void> => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
  }

  const enqueueKnowledge = async (page: PageFixture): Promise<void> => {
    const source = await db('pages').where({ id: page.id }).first('content')
    await enqueuePageMutationEffects(db, {
      pageId: page.id,
      sourceRevision: String(page.sourceRevision),
      desiredState: 'present',
      action: 'create',
      source: String(source.content),
      location: { locale: 'en', path: page.path, visibility: page.visibility ?? 'public', ownerId: page.ownerId ?? null },
      effects: ['knowledge']
    })
  }

  const utilityResult = (searchTerm: string) => ({
    value: { type: null, summary: null, tags: ['utility-tag'], entities: [], relationships: [], openQuestions: [], searchTerms: [searchTerm] },
    model: 'utility-small',
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    inputTokens: 1,
    outputTokens: 1
  })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      DROP TABLE IF EXISTS "pageKnowledgeMaintenance", "pageKnowledgeProjections", "pageMutationOutbox", "pagesSearchMetadata", "agentProviderProfiles", "agentProviderProfileVersions", "pageAccessPasswords", "pageTags", tags, pages CASCADE;
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        path text NOT NULL,
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text,
        content text NOT NULL,
        render text NOT NULL,
        "renderedSourceRevision" bigint,
        "contentType" text NOT NULL,
        "authorId" integer NOT NULL,
        "ownerId" integer,
        extra jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        visibility text NOT NULL,
        "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" varchar(255),
        "publishEndDate" varchar(255)
      );
      CREATE TABLE tags (
        id serial PRIMARY KEY,
        tag text NOT NULL UNIQUE
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL,
        "tagId" integer NOT NULL
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY
      );
      CREATE TABLE "pagesSearchMetadata" (
        "contractId" smallint PRIMARY KEY,
        "schemaVersion" integer NOT NULL,
        dictionary text NOT NULL
      );
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY,
        "pageId" integer NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "effectKind" text NOT NULL,
        "effectKey" text NOT NULL,
        "desiredState" text NOT NULL,
        "payloadSha256" text NOT NULL,
        payload text NOT NULL,
        status text NOT NULL,
        attempts integer NOT NULL,
        "leaseOwner" text,
        "leaseToken" uuid,
        "leaseExpiresAt" timestamptz,
        "availableAt" timestamptz NOT NULL,
        result text,
        postcondition text,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
      CREATE TABLE "agentProviderProfileVersions" (id uuid PRIMARY KEY, conformed boolean NOT NULL);
      CREATE TABLE "agentProviderProfiles" (
        id uuid PRIMARY KEY,
        status text NOT NULL,
        "isGlobalDefault" boolean NOT NULL,
        conformed boolean NOT NULL,
        "currentVersionId" uuid,
        "deletedAt" timestamptz
      );
    `)
    await createKnowledgeProjectionStore(db)
    await createKnowledgeSearchStore(db)
    await createKnowledgeMaintenanceStore(db)

    originalWiki = wikiRuntime.WIKI
    wikiRuntime.WIKI = {
      config: { db: { type: 'postgres' }, search: { maxHits: 100 }, lang: { code: 'en' } },
      models: { knex: db, pages: undefined as unknown, tags: undefined as unknown },
      auth: {
        checkAccess: (requester: TestRequester | undefined, permissions: readonly string[], context?: { path?: string }) => {
          if (permissions.includes('manage:system')) return requester?.permissions?.includes('manage:system') ?? false
          return requester?.canReadPublic === true && context?.path !== 'knowledge/denied'
        },
        checkPageAccess: (requester: TestRequester | undefined, permissions: readonly string[], context?: { path?: string }) => {
          if (permissions.includes('manage:system')) return requester?.permissions?.includes('manage:system') ?? false
          return requester?.canReadPublic === true && context?.path !== 'knowledge/denied'
        },
        loadPageRuleAuthority: async (requester: Express.User) => pageRuleAuthority(requester)
      },
      data: { searchEngine: { config: { dictLanguage: 'english' } } }
    } as never
    // These modules capture WIKI at evaluation, so bind the isolated runtime before loading them.
    const [{ default: Page }, { default: Tag }] = await Promise.all([import('../models/pages.ts'), import('../models/tags.ts')])
    Page.knex(db)
    Tag.knex(db)
    const models = Reflect.get(wikiRuntime.WIKI as object, 'models') as { pages: typeof PageModel; tags: unknown }
    models.pages = Page
    models.tags = Tag
    operations = (await import('../operations/pages.ts')).default as unknown as typeof operations
  })

  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    await db.raw('TRUNCATE TABLE "pageKnowledgeMaintenance", "pageKnowledgeProjections", "pageMutationOutbox", "agentProviderProfiles", "agentProviderProfileVersions", "pageAccessPasswords", "pageTags", tags, pages RESTART IDENTITY CASCADE')
    await db('pageKnowledgeMaintenance').insert({ id: 1 })
    await db('pagesSearchMetadata').insert({ contractId: 1, schemaVersion: 2, dictionary: 'english' }).onConflict('contractId').merge()
    const data = Reflect.get(wikiRuntime.WIKI as object, 'data') as { searchEngine: { config: { dictLanguage: string } } | undefined }
    data.searchEngine = { config: { dictLanguage: 'english' } }
  })
  afterEach(() => vi.setSystemTime())


  afterAll(async () => {
    if (db) {
      await db.raw('DROP TABLE IF EXISTS "pageKnowledgeMaintenance", "pageKnowledgeProjections", "pageMutationOutbox", "pagesSearchMetadata", "agentProviderProfiles", "agentProviderProfileVersions", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
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

  it('enforces publication, password, access, ownership, searchability, and current-revision boundaries in PostgreSQL', async () => {
    const visible = fixture({ id: 1, path: 'knowledge/visible', title: 'Visible Boundary' })
    const unpublished = fixture({ id: 2, sourceRevision: 2, path: 'knowledge/unpublished', title: 'Unpublished Boundary', isPublished: false })
    const future = fixture({ id: 3, sourceRevision: 3, path: 'knowledge/future', title: 'Future Boundary', publishStartDate: '2030-01-01T00:00:00.000Z' })
    const protectedPage = fixture({ id: 4, sourceRevision: 4, path: 'knowledge/protected', title: 'Protected Boundary' })
    const denied = fixture({ id: 5, sourceRevision: 5, path: 'knowledge/denied', title: 'Denied Boundary' })
    const ownerPrivate = fixture({ id: 6, sourceRevision: 6, path: 'knowledge/owner', title: 'Owner Boundary', visibility: 'private', ownerId: 7 })
    const stale = fixture({ id: 7, sourceRevision: 2, path: 'knowledge/stale', title: 'Stale Boundary' })
    const unsearchable = fixture({ id: 8, sourceRevision: 8, path: 'knowledge/unsearchable', title: 'Unsearchable Boundary', isSearchable: false })
    const privateUnsearchable = fixture({
      id: 9,
      sourceRevision: 9,
      path: 'knowledge/private-unsearchable',
      title: 'Private Unsearchable Boundary',
      visibility: 'private',
      ownerId: 7,
      isPublished: false,
      isSearchable: false
    })
    for (const page of [visible, unpublished, future, protectedPage, denied, ownerPrivate, stale, unsearchable, privateUnsearchable]) await insertPage(page)
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
      authorizedPageIds: [1, 2, 3, 4, 5, 7, 8],
      limit: 20
    })
    expect(publicCandidates.map(candidate => candidate.id)).toEqual([1])

    const owner = { id: 7, canReadPublic: false } as never
    const ownerCandidates = await repository.searchVisible({ query: 'boundary', requester: owner, authority: pageRuleAuthority(owner), limit: 20 })
    expect(ownerCandidates).toContainEqual(expect.objectContaining({ id: 6, sourceRevision: '6' }))
    expect(ownerCandidates).not.toContainEqual(expect.objectContaining({ id: privateUnsearchable.id }))
    const manager = { id: 8, permissions: ['manage:system'], canReadPublic: false } as never
    const managerCandidates = await repository.searchVisible({
      query: 'boundary',
      requester: manager,
      authority: pageRuleAuthority(manager),
      limit: 20
    })
    expect(managerCandidates).toContainEqual(expect.objectContaining({ id: 6, sourceRevision: '6' }))
    expect(managerCandidates).not.toContainEqual(expect.objectContaining({ id: privateUnsearchable.id }))
    expect(
      await repository.filterVisibleCurrentIds({
        requester: reader,
        authority: readerAuthority,
        pageIds: [1, 2, 3, 4, 5, 6, 7, 8],
        authorizedPageIds: [1, 2, 3, 4, 5, 7, 8]
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

    expect(await repository.searchVisible({ query: 'AFR', requester, authority, limit: 5 })).toEqual([
      expect.objectContaining({ id: 42, sourceRevision: '42' })
    ])
    expect(await repository.searchVisible({ query: '"AFR"', requester, authority, limit: 5 })).toEqual([])
  })

  it('excludes self-consistent corrupted source digests from current reads, filters, and generated search', async () => {
    await insertPage(fixture({ id: 42, path: 'knowledge/source-digest', title: 'Signal Boundary', tags: ['canonical-source-tag'] }))
    const repository = new PageKnowledgeRepository(db)
    const requester = { id: 9, canReadPublic: true } as never
    const authority = pageRuleAuthority(requester)
    expect(await repository.searchVisible({ query: 'signal', requester, authority, limit: 1 })).toHaveLength(1)
    const stored = await db('pageKnowledgeProjections').where({ pageId: 42 }).first('projection')
    const projection = JSON.parse(String(stored.projection))
    projection.source.sha256 = '0'.repeat(64)
    await db('pageKnowledgeProjections').where({ pageId: 42 }).update({
      sourceSha256: projection.source.sha256,
      projection: JSON.stringify(projection)
    })

    await expect(repository.getCurrent(42)).resolves.toBeNull()
    expect((await repository.getCurrentMany([42])).has(42)).toBe(false)
    expect(await repository.filterVisibleCurrentIds({ requester, authority, pageIds: [42], authorizedPageIds: [42] })).toEqual([])
    expect(await repository.searchVisible({ query: 'signal', requester, authority, limit: 1 })).toEqual([])
  })

  it('shares a completed audit cooldown across restarted PostgreSQL replicas and admits one repair at expiry', async () => {
    await enableUtilityEnrichment()
    const current = fixture({ id: 42, path: 'knowledge/replica-cooldown', title: 'Opaque' })
    await insertPage(current)
    await db('pageKnowledgeProjections').where({ pageId: 42 }).delete()
    await enqueueKnowledge(current)
    const enrichKnowledge = vi.fn(async () => utilityResult('replicarepairtoken'))
    const original = new PageKnowledgeLifecycle(db, 'cooldown-original', { enrichKnowledge })
    await original.runOnce()
    const completed = await db('pageKnowledgeMaintenance').first()
    expect(completed).toMatchObject({ status: 'complete' })
    expect(Number(completed.scanned)).toBe(1)
    const due = new Date(completed.completedAt).valueOf() + AUDIT_COOLDOWN_MILLISECONDS
    const paidColumns = ['projection', 'sourceSha256', 'enrichmentState', 'utilityProfileVersionId', 'utilityModel', 'utilityInputSha256', 'utilityOutputSha256', 'utilityGeneratedAt']
    const paid = await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)
    await db('pageKnowledgeProjections').where({ pageId: 42 }).update({ searchTokens: null, searchText: '' })
    const secondDb = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    const replica = new PageKnowledgeLifecycle(secondDb, 'cooldown-replica', { enrichKnowledge })
    const restarted = new PageKnowledgeLifecycle(db, 'cooldown-restarted', { enrichKnowledge })
    try {
      vi.setSystemTime(new Date(due - 1))
      for (const lifecycle of [replica, restarted, original]) {
        await expect(lifecycle.runOnce()).resolves.toEqual({ backfilled: 0, requeued: 0, processed: 0 })
        expect(await db('pageKnowledgeMaintenance').first()).toEqual(completed)
        expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first('searchTokens', 'searchText')).toEqual({
          searchTokens: null,
          searchText: ''
        })
      }

      vi.setSystemTime(new Date(due))
      const results = await Promise.all([replica.runOnce(), restarted.runOnce()])
      expect(results.reduce((total, result) => total + result.backfilled, 0)).toBe(1)
      expect(results.every(result => result.processed === 0 && result.requeued === 0)).toBe(true)
      const next = await db('pageKnowledgeMaintenance').first('status', 'epochId', 'scanned')
      expect(next.status).toBe('complete')
      expect(Number(next.epochId)).toBe(Number(completed.epochId) + 1)
      expect(Number(next.scanned)).toBe(1)
      const requester = { id: 9, canReadPublic: true } as never
      expect(await new PageKnowledgeRepository(secondDb).searchVisible({
        query: 'replicarepairtoken', requester, authority: pageRuleAuthority(requester), limit: 1
      })).toEqual([expect.objectContaining({ id: 42, sourceRevision: '1' })])
      expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)).toEqual(paid)
      expect(enrichKnowledge).toHaveBeenCalledOnce()
    } finally {
      await secondDb.destroy()
    }
  })

  it('restores null PostgreSQL tokens and corrupted filters from paid projection JSON without another utility call', async () => {
    await enableUtilityEnrichment()
    const current = fixture({ id: 42, path: 'knowledge/paid-repair', title: 'Opaque', tags: ['canonical-source-tag'] })
    await insertPage(current)
    await db('pageKnowledgeProjections').where({ pageId: 42 }).delete()
    await enqueueKnowledge(current)
    const enrichKnowledge = vi.fn(async () => utilityResult('quasarrepairtoken'))
    const lifecycle = new PageKnowledgeLifecycle(db, 'native-derived-repair-worker', { enrichKnowledge })
    await lifecycle.runOnce()
    const columns = ['schemaVersion', 'state', 'conceptType', 'summary', 'searchText', 'searchDictionary', 'lifecycleStatus', 'trustTier', 'verification', 'staleAfter']
    const healthy = await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...columns)
    const paidColumns = ['projection', 'sourceSha256', 'enrichmentState', 'utilityProfileVersionId', 'utilityModel', 'utilityInputSha256', 'utilityOutputSha256', 'utilityGeneratedAt']
    const paid = await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)
    const immutableEffect = await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('id', 'payload', 'payloadSha256', 'attempts')
    await db('pageKnowledgeProjections').where({ pageId: 42 }).update({ searchTokens: null })
    advanceToNextAudit()
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ backfilled: 1, requeued: 0, processed: 0 })
    const restoredNullTokens = await db.raw<{ rows: Array<{ matches: boolean }> }>(
      `SELECT "searchTokens" @@ websearch_to_tsquery('english', 'quasarrepairtoken') AS matches FROM "pageKnowledgeProjections" WHERE "pageId" = 42`
    )
    expect(restoredNullTokens.rows[0]?.matches).toBe(true)
    expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)).toEqual(paid)
    expect(enrichKnowledge).toHaveBeenCalledOnce()
    await db('pageKnowledgeProjections').where({ pageId: 42 }).update({
      searchTokens: db.raw("to_tsvector('english', 'corruptedtoken')"),
      searchText: '',
      schemaVersion: 1,
      state: 'partial',
      conceptType: 'CorruptedType',
      summary: 'Corrupted summary',
      lifecycleStatus: 'deprecated',
      trustTier: 'human-reviewed',
      verification: 'current',
      staleAfter: '2000-01-01T00:00:00.000Z'
    })

    advanceToNextAudit()
    await expect(lifecycle.runOnce()).resolves.toMatchObject({ requeued: 0, processed: 0 })
    expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...columns)).toEqual(healthy)
    expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)).toEqual(paid)
    expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge' }).first('id', 'payload', 'payloadSha256', 'attempts')).toEqual(immutableEffect)
    expect(enrichKnowledge).toHaveBeenCalledOnce()
    const tokens = await db.raw<{ rows: Array<{ matches: boolean }> }>(
      `SELECT "searchTokens" @@ websearch_to_tsquery('english', 'quasarrepairtoken') AS matches FROM "pageKnowledgeProjections" WHERE "pageId" = 42`
    )
    expect(tokens.rows[0]?.matches).toBe(true)
    const requester = { id: 9, canReadPublic: true } as never
    expect(await new PageKnowledgeRepository(db).searchVisible({
      query: 'quasarrepairtoken', requester, authority: pageRuleAuthority(requester),
      filter: { trustTier: 'unverified', conceptType: 'Procedure' }, limit: 1
    })).toEqual([expect.objectContaining({ id: 42, sourceRevision: '1' })])
  })

  it('keeps two instances on the committed dictionary after a cutover without regenerating paid utility output', async () => {
    await enableUtilityEnrichment()
    const current = fixture({ id: 42, path: 'knowledge/dictionary-cutover', title: 'Opaque', tags: ['canonical-source-tag'] })
    await insertPage(current)
    await db('pageKnowledgeProjections').where({ pageId: 42 }).delete()
    await enqueueKnowledge(current)
    const secondDb = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    const enrichKnowledge = vi.fn(async () => utilityResult('journaux'))
    const firstLifecycle = new PageKnowledgeLifecycle(db, 'instance-a', { enrichKnowledge })
    const secondLifecycle = new PageKnowledgeLifecycle(secondDb, 'instance-b', { enrichKnowledge })
    const firstRepository = new PageKnowledgeRepository(db)
    const secondRepository = new PageKnowledgeRepository(secondDb)
    const data = Reflect.get(wikiRuntime.WIKI as object, 'data') as { searchEngine: { config: { dictLanguage: string } } }
    const requester = { id: 9, canReadPublic: true } as never
    const searchInput = { query: 'journal', requester, authority: pageRuleAuthority(requester), limit: 1 }
    try {
      await firstLifecycle.runOnce()
      const paidColumns = ['projection', 'sourceSha256', 'enrichmentState', 'utilityProfileVersionId', 'utilityModel', 'utilityInputSha256', 'utilityOutputSha256', 'utilityGeneratedAt']
      const paid = await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)
      await secondDb.transaction(async transaction => {
        await lockSearchIndex(transaction, true)
        await transaction('pagesSearchMetadata').where({ contractId: 1 }).update({ dictionary: 'french' })
      })
      data.searchEngine.config.dictLanguage = 'french'
      advanceToNextAudit()
      await expect(secondLifecycle.runOnce()).resolves.toMatchObject({ requeued: 0, processed: 0 })
      expect(await secondRepository.searchVisible(searchInput)).toEqual([expect.objectContaining({ id: 42 })])

      // Instance A retains its old process configuration, but its shared index contract has changed.
      data.searchEngine.config.dictLanguage = 'english'
      expect(await firstRepository.getCurrent(42)).toMatchObject({ sourceRevision: '1' })
      expect(await firstRepository.searchVisible(searchInput)).toEqual([expect.objectContaining({ id: 42 })])
      expect(await firstRepository.filterVisibleCurrentIds({
        requester, authority: pageRuleAuthority(requester), pageIds: [42], authorizedPageIds: [42], filter: { conceptType: 'Procedure' }
      })).toEqual([42])
      await expect(firstLifecycle.runOnce()).resolves.toMatchObject({ requeued: 0, processed: 0 })
      expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first('searchDictionary')).toEqual({ searchDictionary: 'french' })
      expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)).toEqual(paid)
      expect(enrichKnowledge).toHaveBeenCalledOnce()

      const next = fixture({ id: 43, path: 'knowledge/stale-instance-write', title: 'Opaque', tags: ['canonical-source-tag'] })
      await insertPage(next)
      await db('pageKnowledgeProjections').where({ pageId: 43 }).delete()
      await enqueueKnowledge(next)
      await expect(firstLifecycle.runOnce()).resolves.toMatchObject({ processed: 1 })
      expect(await db('pageKnowledgeProjections').where({ pageId: 43 }).first('searchDictionary')).toEqual({ searchDictionary: 'french' })
      expect(await secondRepository.searchVisible({ ...searchInput, pageIds: [43], authorizedPageIds: [43] })).toEqual([
        expect.objectContaining({ id: 43 })
      ])
      expect(await db('pageKnowledgeProjections').where({ pageId: 42 }).first(...paidColumns)).toEqual(paid)
      expect(enrichKnowledge).toHaveBeenCalledTimes(2)
    } finally {
      await secondDb.destroy()
    }
  })

  it('does not let malformed first-fifty private projections starve the valid fifty-first lexical result', async () => {
    for (let id = 1; id <= 51; id += 1) {
      await insertPage(fixture({
        id, path: `knowledge/private-${id}`, title: `Signal ${String(id).padStart(3, '0')}`, visibility: 'private', ownerId: 7, isPublished: false
      }))
    }
    await db('pageKnowledgeProjections').where('pageId', '<=', 50).update({ projection: '{' })
    const requester = { id: 7, canReadPublic: false } as Express.User
    const repository = new PageKnowledgeRepository(db)
    expect(await repository.filterVisibleCurrentIds({
      requester, authority: pageRuleAuthority(requester), filter: { trustTier: 'unverified' }
    })).toEqual([51])
    const data = Reflect.get(wikiRuntime.WIKI as object, 'data') as { searchEngine: unknown }
    const configuredEngine = data.searchEngine
    data.searchEngine = undefined
    try {
      const unfiltered = await operations.search({ query: '"signal"', requester })
      expect(unfiltered.results).toHaveLength(50)
      expect(unfiltered.results.map(result => result.id)).not.toContain(51)
      const filtered = await operations.search({ query: '"signal"', requester, knowledge: { trustTier: 'unverified' } })
      expect(filtered.results).toEqual([expect.objectContaining({ id: 51, sourceRevision: '1' })])
    } finally {
      data.searchEngine = configuredEngine
    }
  })
})

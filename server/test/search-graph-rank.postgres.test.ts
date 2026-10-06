/// <reference types="bun" />

import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'

interface SearchResultEntry {
  id: number
  matchedFields: string[]
  score: number
}

interface PostgreSqlSearchEngine {
  config: { dictLanguage: string }
  init(): Promise<void>
  rebuild(): Promise<void>
  reconcilePage(pageId: number): Promise<void>
  query(query: string, options: { pageIds?: number[]; pageRevisions?: Record<string, string>; limit?: number }): Promise<{ results: SearchResultEntry[] }>
}

const connection = getPostgresTestConnection('_search_graph_rank_test', import.meta.path)

const suite = connection ? describe : describe.skip

suite('PostgreSQL graph rank privacy boundary', () => {
  let db: Knex
  let engine: PostgreSqlSearchEngine
  const wikiRuntime = globalThis as typeof globalThis & { WIKI: unknown }
  let originalWiki: unknown
  const graphPageIds = [69, 70, 71, 72, 73, 74, 75]

  const insertPage = async ({
    id,
    path,
    title,
    sourceRevision = id,
    render = `<article>${title}</article>`,
    tagId = 1
  }: {
    id: number
    path: string
    title: string
    sourceRevision?: number
    render?: string
    tagId?: number
  }): Promise<void> => {
    await db('pages').insert({
      id,
      sourceRevision,
      renderedSourceRevision: sourceRevision,
      path,
      localeCode: 'en',
      title,
      description: '',
      render,
      visibility: 'public',
      isPublished: true,
      publishStartDate: '',
      publishEndDate: ''
    })
    await db('pageTags').insert({ pageId: id, tagId })
  }

  const graphResults = async (): Promise<SearchResultEntry[]> => {
    const result = await engine.query('graphprobe', { pageIds: graphPageIds, limit: 20 })
    return result.results
      .filter(candidate => candidate.id !== 70)
      .map(candidate => ({ id: candidate.id, score: candidate.score, matchedFields: candidate.matchedFields }))
      .sort((left, right) => left.id - right.id)
  }

  const promotionPageIds = [80, 81, 82, 83, 84]
  const insertPromotionPages = async (manualBody = 'Routine procedures'): Promise<void> => {
    await db('tags').insert([
      { id: 2, tag: 'falcon', title: 'falcon' },
      { id: 3, tag: 'falcon manual', title: 'falcon manual' }
    ])
    await insertPage({ id: 80, path: 'promotion/reference', title: 'Zulu reference', render: '<article>Reference notes</article>', tagId: 2 })
    await insertPage({ id: 81, path: 'promotion/manual', title: 'Falcon manual', render: `<article>${manualBody}</article>`, tagId: 3 })
    for (const [index, label] of ['One', 'Two', 'Three'].entries()) {
      await insertPage({
        id: 82 + index,
        path: `promotion/relay-${index}`,
        title: `Falcon Relay ${label}`,
        render: '<article>Routine relay notes</article>',
        tagId: 3
      })
    }
    await db('pageMutationOutbox').insert(
      promotionPageIds.map(pageId => ({ pageId, sourceRevision: pageId, effectKind: 'links', desiredState: 'present', status: 'succeeded' }))
    )
    await engine.rebuild()
  }

  const linkPromotionPages = async (): Promise<void> => {
    await db('pageLinks').insert([82, 83, 84].map(pageId => ({ pageId, localeCode: 'en', path: 'promotion/manual' })))
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      DROP TABLE IF EXISTS "searchEngines", "pagesSearchMetadata", "pagesWords", "pagesVector", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages CASCADE;
      CREATE TABLE "searchEngines" (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, config jsonb NOT NULL);
      INSERT INTO "searchEngines" VALUES ('postgres', true, '{"dictLanguage":"english"}'::jsonb);
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        "renderedSourceRevision" bigint,
        path text NOT NULL,
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text,
        render text NOT NULL DEFAULT '',
        visibility text NOT NULL,
        "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" varchar(255),
        "publishEndDate" varchar(255)
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL,
        title text NOT NULL
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageLinks" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "localeCode" varchar(35) NOT NULL,
        path text NOT NULL,
        PRIMARY KEY ("pageId", "localeCode", path)
      );
      CREATE TABLE "pageMutationOutbox" (
        "pageId" integer NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "effectKind" varchar(64) NOT NULL,
        "desiredState" varchar(32) NOT NULL,
        status varchar(24) NOT NULL,
        "leaseOwner" text,
        "leaseToken" text,
        "leaseExpiresAt" timestamptz,
        PRIMARY KEY ("pageId", "sourceRevision", "effectKind")
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
      );
    `)

    originalWiki = wikiRuntime.WIKI
    wikiRuntime.WIKI = {
      config: { db: { type: 'postgres' }, search: { maxHits: 100 } },
      data: {},
      Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
      logger: { info: () => undefined, warn: () => undefined },
      models: {
        knex: db,
        pages: { cleanHTML: (html: string) => html }
      }
    } as never

    // The engine captures the disposable WIKI runtime at module evaluation.
    engine = Object.assign((await import('../modules/search/postgres/engine.ts')).default, {
      config: { dictLanguage: 'english' }
    }) as unknown as PostgreSqlSearchEngine
    await engine.init()
  })

  beforeEach(async () => {
    await db.raw(
      'TRUNCATE TABLE "pagesWords", "pagesVector", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages RESTART IDENTITY CASCADE'
    )
    await db('tags').insert({ id: 1, tag: 'graphprobe', title: 'Graph Probe' })
    await insertPage({ id: 69, path: 'graph/tail-69', title: 'Tail69', render: '<article>Tail69 classifiedbridgecipher</article>' })
    await insertPage({
      id: 70,
      path: 'graph/protected-70',
      title: 'ProtectedTitle',
      render: '<article>ProtectedTitle classifiedbridgecipher <a class="is-internal-link" href="/en/graph/tail-69">Tail69</a></article>'
    })
    await insertPage({ id: 71, path: 'graph/seed-71', title: 'Seed71' })
    await insertPage({ id: 72, path: 'graph/public-relay-72', title: 'Public Relay72' })
    await insertPage({ id: 73, path: 'graph/stale-73', title: 'Stale Relay73' })
    await insertPage({ id: 74, path: 'graph/private-74', title: 'Private Relay74' })
    await insertPage({ id: 75, path: 'graph/unpublished-75', title: 'Unpublished Relay75' })
    await db('pageAccessPasswords').insert({ pageId: 70 })
    await db('pageLinks').insert([
      { pageId: 70, localeCode: 'en', path: 'graph/tail-69' },
      { pageId: 71, localeCode: 'en', path: 'graph/public-relay-72' },
      { pageId: 72, localeCode: 'en', path: 'graph/tail-69' }
    ])
    await db('pageMutationOutbox').insert([
      { pageId: 70, sourceRevision: 70, effectKind: 'links', desiredState: 'present', status: 'succeeded' },
      { pageId: 71, sourceRevision: 71, effectKind: 'links', desiredState: 'present', status: 'succeeded' },
      { pageId: 72, sourceRevision: 72, effectKind: 'links', desiredState: 'present', status: 'succeeded' }
    ])
    await engine.rebuild()
  })

  afterAll(async () => {
    if (db) {
      await db.raw(
        'DROP TABLE IF EXISTS "pagesSearchMetadata", "pagesWords", "pagesVector", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages CASCADE'
      )
      await db.destroy()
    }
    wikiRuntime.WIKI = originalWiki
  })

  it('keeps protected metadata searchable while excluding protected body content and graph bridges', async () => {
    const protectedTitle = await engine.query('protectedtitle', { pageIds: [70], limit: 10 })
    const protectedCandidate = protectedTitle.results.find(candidate => candidate.id === 70)
    expect(protectedCandidate?.matchedFields).toContain('title')
    expect(protectedCandidate?.matchedFields).not.toContain('content')
    expect(protectedCandidate?.matchedFields).not.toContain('graph')

    const bodyQuery = '"classifiedbridgecipher"'
    expect((await engine.query(bodyQuery, { pageIds: [69], limit: 10 })).results).toContainEqual(
      expect.objectContaining({ id: 69, matchedFields: expect.arrayContaining(['content']) })
    )
    expect((await engine.query(bodyQuery, { pageIds: [70], limit: 10 })).results).toEqual([])

    const publicBaseline = await graphResults()
    expect(publicBaseline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 69, matchedFields: expect.arrayContaining(['graph']) }),
        expect.objectContaining({ id: 71, matchedFields: expect.arrayContaining(['graph']) }),
        expect.objectContaining({ id: 72, matchedFields: expect.arrayContaining(['graph']) })
      ])
    )

    await db('pageLinks').insert([{ pageId: 71, localeCode: 'en', path: 'graph/protected-70' }])
    expect(await graphResults()).toEqual(publicBaseline)
  })

  for (const boundary of [
    { label: 'stale', id: 73, path: 'graph/stale-73', update: { sourceRevision: 173 }, receiptRevision: 173 },
    { label: 'private', id: 74, path: 'graph/private-74', update: { visibility: 'private' }, receiptRevision: 74 },
    { label: 'unpublished', id: 75, path: 'graph/unpublished-75', update: { isPublished: false }, receiptRevision: 75 }
  ]) {
    it(`excludes a ${boundary.label} graph bridge even with a current succeeded links receipt`, async () => {
      const publicBaseline = await graphResults()
      await db('pageMutationOutbox').insert({
        pageId: boundary.id,
        sourceRevision: boundary.id,
        effectKind: 'links',
        desiredState: 'present',
        status: 'succeeded'
      })
      await db('pageLinks').insert([
        { pageId: 71, localeCode: 'en', path: boundary.path },
        { pageId: boundary.id, localeCode: 'en', path: 'graph/tail-69' }
      ])
      const admittedTail = (await graphResults()).find(candidate => candidate.id === 69)
      const baselineTail = publicBaseline.find(candidate => candidate.id === 69)
      expect(admittedTail).toBeDefined()
      expect(baselineTail).toBeDefined()
      expect(admittedTail!.score).toBeGreaterThan(baselineTail!.score)

      await db('pages').where({ id: boundary.id }).update(boundary.update)
      await db('pageMutationOutbox').where({ pageId: boundary.id, effectKind: 'links' }).update({ sourceRevision: boundary.receiptRevision })
      const afterWithdrawal = await graphResults()
      expect(afterWithdrawal.find(candidate => candidate.id === 69)?.score).toBe(baselineTail!.score)
      if (boundary.label !== 'stale') expect(afterWithdrawal.some(candidate => candidate.id === boundary.id)).toBe(false)
    })
  }

  it('excludes stale links until the current links receipt succeeds after a redaction update', async () => {
    const publicBaseline = await graphResults()

    await db('pages').where({ id: 70 }).update({
      sourceRevision: 2,
      renderedSourceRevision: 2,
      render: '<article>ProtectedTitle</article>'
    })
    await db('pageAccessPasswords').where({ pageId: 70 }).delete()
    await db('pageMutationOutbox').insert({
      pageId: 70,
      sourceRevision: 2,
      effectKind: 'links',
      desiredState: 'present',
      status: 'running',
      leaseOwner: 'stalled-links-worker',
      leaseToken: 'stalled-links-lease',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    await engine.reconcilePage(70)

    const pendingGraph = await graphResults()
    expect(pendingGraph).toEqual(publicBaseline)

    await db('pageMutationOutbox')
      .where({ pageId: 70, sourceRevision: 2, effectKind: 'links' })
      .update({ status: 'succeeded', leaseOwner: null, leaseToken: null, leaseExpiresAt: null })

    const completedGraph = await graphResults()
    const pendingTail = pendingGraph.find(candidate => candidate.id === 69)
    const completedTail = completedGraph.find(candidate => candidate.id === 69)
    expect(pendingTail).toBeDefined()
    expect(completedTail).toBeDefined()
    expect(Number.isFinite(pendingTail?.score)).toBe(true)
    expect(Number.isFinite(completedTail?.score)).toBe(true)
    expect(completedTail!.score).toBeGreaterThan(pendingTail!.score)
    expect(completedTail?.matchedFields).toContain('graph')
  })

  it('keeps an isolated exact tag strictly ahead of a lower-scoring prefix match after graph promotion and a numeric resort', async () => {
    await insertPromotionPages()
    const baseline = (await engine.query('falcon', { pageIds: promotionPageIds, limit: 5 })).results
    expect(baseline.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(promotionPageIds)
    const exactBefore = baseline.find(candidate => candidate.id === 80)!
    const manualBefore = baseline.find(candidate => candidate.id === 81)!
    expect(exactBefore.matchedFields).toContain('tag')
    expect(exactBefore.matchedFields).not.toContain('graph')
    expect(manualBefore.matchedFields).not.toContain('graph')
    expect(exactBefore.score).toBeGreaterThan(manualBefore.score)
    // The existing 1.25 graph bonus crosses this preliminary gap without a numeric ceiling.
    expect(exactBefore.score - manualBefore.score).toBeLessThan(1.25)

    await linkPromotionPages()
    const linked = (await engine.query('falcon', { pageIds: promotionPageIds, limit: 5 })).results
    expect(linked.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(promotionPageIds)
    const exactAfter = linked.find(candidate => candidate.id === 80)!
    const manualAfter = linked.find(candidate => candidate.id === 81)!
    expect(exactAfter.score).toBe(exactBefore.score)
    expect(exactAfter.matchedFields).not.toContain('graph')
    expect(manualAfter.matchedFields).toContain('graph')
    expect(manualAfter.score).toBeGreaterThan(manualBefore.score)
    expect(exactAfter.score).toBeGreaterThan(manualAfter.score)
    // Shared search preserves engine scores and resorts its union numerically, without match classes.
    const numericOrder = [...linked]
      .reverse()
      .sort((left, right) => right.score - left.score)
      .map(candidate => candidate.id)
    expect(numericOrder.indexOf(80)).toBeLessThan(numericOrder.indexOf(81))
  })

  it('keeps a graph-supported exact title below a strictly stronger exact title while allowing exact baseline ties to settle', async () => {
    const pageIds = [90, 91, 92, 93, 94, 95]
    await insertPage({
      id: 90,
      path: 'exact-ceiling/stronger',
      title: 'Falcon',
      render: '<article>Falcon routine reference notes</article>'
    })
    await insertPage({ id: 91, path: 'exact-ceiling/peer', title: 'Falcon', render: '<article>Routine reference notes</article>' })
    await insertPage({ id: 92, path: 'exact-ceiling/weaker', title: 'Falcon', render: '<article>Routine reference notes</article>' })
    for (const [index, label] of ['One', 'Two', 'Three'].entries()) {
      await insertPage({
        id: 93 + index,
        path: `exact-ceiling/relay-${index}`,
        title: `Falcon Relay ${label}`,
        render: '<article>Routine relay notes</article>'
      })
    }
    await db('pageMutationOutbox').insert(
      pageIds.map(pageId => ({ pageId, sourceRevision: pageId, effectKind: 'links', desiredState: 'present', status: 'succeeded' }))
    )
    await engine.rebuild()

    const baseline = (await engine.query('falcon', { pageIds, limit: pageIds.length })).results
    expect(baseline.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(pageIds)
    const strongerBefore = baseline.find(candidate => candidate.id === 90)!
    const peerBefore = baseline.find(candidate => candidate.id === 91)!
    const weakerBefore = baseline.find(candidate => candidate.id === 92)!
    for (const candidate of [strongerBefore, peerBefore, weakerBefore]) {
      expect(candidate.matchedFields).toContain('title')
      expect(candidate.matchedFields).not.toContain('graph')
    }
    expect(strongerBefore.matchedFields).toContain('content')
    expect(weakerBefore.matchedFields).not.toContain('content')
    expect(peerBefore.score).toBe(weakerBefore.score)
    expect(strongerBefore.score - weakerBefore.score).toBeGreaterThan(0.000001)
    expect(strongerBefore.score - weakerBefore.score).toBeLessThan(1.25)
    expect(baseline.indexOf(strongerBefore)).toBeLessThan(baseline.indexOf(weakerBefore))

    await db('pageLinks').insert([93, 94, 95].map(pageId => ({ pageId, localeCode: 'en', path: 'exact-ceiling/weaker' })))
    const linked = (await engine.query('falcon', { pageIds, limit: pageIds.length })).results
    expect(linked.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(pageIds)
    const strongerAfter = linked.find(candidate => candidate.id === 90)!
    const peerAfter = linked.find(candidate => candidate.id === 91)!
    const weakerAfter = linked.find(candidate => candidate.id === 92)!
    expect(strongerAfter.score).toBe(strongerBefore.score)
    expect(peerAfter.score).toBe(peerBefore.score)
    expect(strongerAfter.matchedFields).not.toContain('graph')
    expect(peerAfter.matchedFields).not.toContain('graph')
    expect(weakerAfter.matchedFields).toContain('graph')
    expect(weakerAfter.score).toBeGreaterThan(weakerBefore.score)
    expect(weakerAfter.score).toBeLessThan(strongerBefore.score)
    expect(strongerAfter.score).toBeGreaterThan(weakerAfter.score)
    expect(weakerAfter.score).toBeGreaterThan(peerAfter.score)
    expect(linked.indexOf(strongerAfter)).toBeLessThan(linked.indexOf(weakerAfter))
    expect(linked.indexOf(weakerAfter)).toBeLessThan(linked.indexOf(peerAfter))
    const numericOrder = [...linked]
      .reverse()
      .sort((left, right) => right.score - left.score)
      .map(candidate => candidate.id)
    expect(numericOrder.indexOf(90)).toBeLessThan(numericOrder.indexOf(92))
    expect(numericOrder.indexOf(92)).toBeLessThan(numericOrder.indexOf(91))
  })

  it('does not demote an already-superior preliminary prefix match when graph promotion is clamped', async () => {
    await insertPromotionPages(Array.from({ length: 100 }, () => 'falcon').join(' '))
    const baseline = (await engine.query('falcon', { pageIds: promotionPageIds, limit: 5 })).results
    expect(baseline.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(promotionPageIds)
    const exactBefore = baseline.find(candidate => candidate.id === 80)!
    const manualBefore = baseline.find(candidate => candidate.id === 81)!
    expect(manualBefore.matchedFields).not.toContain('graph')
    expect(manualBefore.score).toBeGreaterThan(exactBefore.score)

    await linkPromotionPages()
    const linked = (await engine.query('falcon', { pageIds: promotionPageIds, limit: 5 })).results
    expect(linked.map(candidate => candidate.id).sort((left, right) => left - right)).toEqual(promotionPageIds)
    const exactAfter = linked.find(candidate => candidate.id === 80)!
    const manualAfter = linked.find(candidate => candidate.id === 81)!
    expect(exactAfter.score).toBe(exactBefore.score)
    expect(manualAfter.matchedFields).toContain('graph')
    expect(manualAfter.score).toBeGreaterThan(manualBefore.score)
    expect(manualAfter.score).toBeGreaterThan(exactAfter.score)
    const numericOrder = [...linked]
      .reverse()
      .sort((left, right) => right.score - left.score)
      .map(candidate => candidate.id)
    expect(numericOrder.indexOf(81)).toBeLessThan(numericOrder.indexOf(80))
  })
})

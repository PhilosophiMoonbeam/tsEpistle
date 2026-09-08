/// <reference types="bun" />

import fs from 'node:fs'

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from './bun-test.mts'

interface SearchResultEntry {
  id: number
  matchedFields: string[]
  score: number
}

interface PostgreSqlSearchEngine {
  config: { dictLanguage: string }
  init(): Promise<void>
  rebuild(): Promise<void>
  query(query: string, options: { pageIds?: number[]; pageRevisions?: Record<string, string>; limit?: number }): Promise<{ results: SearchResultEntry[] }>
}

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_search_graph_rank_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('search-graph-rank.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error('Explicit graph-rank PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _search_graph_rank_test and a PostgreSQL password.')
}

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
    render = `<article>${title}</article>`
  }: {
    id: number
    path: string
    title: string
    sourceRevision?: number
    render?: string
  }): Promise<void> => {
    await db('pages').insert({
      id,
      sourceRevision,
      path,
      localeCode: 'en',
      title,
      description: '',
      render,
      visibility: 'public',
      isPublished: true
    })
    await db('pageTags').insert({ pageId: id, tagId: 1 })
  }

  const graphResults = async (): Promise<SearchResultEntry[]> => {
    const result = await engine.query('graphprobe', { pageIds: graphPageIds, limit: 20 })
    return result.results
      .filter(candidate => candidate.id !== 70)
      .map(candidate => ({ id: candidate.id, score: candidate.score, matchedFields: candidate.matchedFields }))
      .sort((left, right) => left.id - right.id)
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      DROP TABLE IF EXISTS "pagesSearchMetadata", "pagesWords", "pagesVector", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages CASCADE;
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        path text NOT NULL,
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text,
        render text NOT NULL DEFAULT '',
        visibility text NOT NULL,
        "isPublished" boolean NOT NULL
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
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
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
      'TRUNCATE TABLE "pagesSearchMetadata", "pagesWords", "pagesVector", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages RESTART IDENTITY CASCADE'
    )
    await db('tags').insert({ id: 1, tag: 'graphprobe', title: 'Graph Probe' })
    await insertPage({ id: 69, path: 'graph/tail-69', title: 'Tail69' })
    await insertPage({
      id: 70,
      path: 'graph/protected-70',
      title: 'ProtectedTitle',
      render: '<article>ProtectedTitle <a class="is-internal-link" href="/en/graph/tail-69">Tail69</a></article>'
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

  it('keeps protected metadata searchable while excluding protected, stale, private, and unpublished graph bridges', async () => {
    const protectedTitle = await engine.query('protectedtitle', { pageIds: [70], limit: 10 })
    const protectedCandidate = protectedTitle.results.find(candidate => candidate.id === 70)
    expect(protectedCandidate?.matchedFields).toContain('title')
    expect(protectedCandidate?.matchedFields).not.toContain('content')
    expect(protectedCandidate?.matchedFields).not.toContain('graph')

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

    await db('pages').where({ id: 73 }).update({ sourceRevision: 173 })
    await db('pages').where({ id: 74 }).update({ visibility: 'private' })
    await db('pages').where({ id: 75 }).update({ isPublished: false })
    await db('pageLinks').insert([
      { pageId: 71, localeCode: 'en', path: 'graph/stale-73' },
      { pageId: 73, localeCode: 'en', path: 'graph/tail-69' },
      { pageId: 71, localeCode: 'en', path: 'graph/private-74' },
      { pageId: 74, localeCode: 'en', path: 'graph/tail-69' },
      { pageId: 71, localeCode: 'en', path: 'graph/unpublished-75' },
      { pageId: 75, localeCode: 'en', path: 'graph/tail-69' }
    ])
    expect(await graphResults()).toEqual(publicBaseline)
  })

  it('excludes stale links until the current links receipt succeeds after a redaction update', async () => {
    const publicBaseline = await graphResults()

    await db('pages').where({ id: 70 }).update({
      sourceRevision: 2,
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
    expect(completedTail?.score).toBeGreaterThan(pendingTail?.score ?? Number.NEGATIVE_INFINITY)
    expect(completedTail?.matchedFields).toContain('graph')
  })
})

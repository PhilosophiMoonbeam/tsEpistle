/// <reference types="bun" />

import fs from 'node:fs'

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from './bun-test.mts'
import { knowledgeSearchText, mergeKnowledgeUtilityResult, projectPageKnowledge } from '../knowledge/projection.ts'
import { up as createKnowledgeProjectionSchema } from '../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearchIndex } from '../db/migrations/tsepistle-000027-knowledge-search.ts'
import type PageModel from '../models/pages.ts'

interface SearchSummary {
  id: number
  sourceRevision: string
  matchedFields: string[]
}

interface SearchResponse {
  results: SearchSummary[]
}

interface SearchOperations {
  search(input: { query: string; requester?: Express.User; locale?: string; path?: string; pageIds?: number[]; limit?: number }): Promise<SearchResponse>
  listLinks(input: { locale: string; requester?: Express.User }): Promise<Array<{ id: number; links: string[] }>>
  listRelated(input: {
    pageId: number
    limit: number
    requester?: Express.User
  }): Promise<{ pages: Array<{ id: number; distance: number }>; nextOffset: number | null }>
}

interface PostgreSqlSearchEngine {
  config: { dictLanguage: string }
  init(): Promise<void>
  rebuild(): Promise<void>
}

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_search_foundation_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('search-foundation.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error(
    'Explicit search-foundation PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _search_foundation_test and a PostgreSQL password.'
  )
}

const suite = connection ? describe : describe.skip

suite('PostgreSQL shared search foundation', () => {
  let db: Knex
  let Page: typeof PageModel
  let operations: SearchOperations
  const wikiRuntime = globalThis as typeof globalThis & { WIKI: unknown }
  let originalWiki: unknown

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      DROP TABLE IF EXISTS "pageKnowledgeProjections", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages, users CASCADE;
      CREATE TABLE users (
        id integer PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL
      );
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        path text NOT NULL,
        hash text NOT NULL DEFAULT '',
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text,
        content text NOT NULL DEFAULT '',
        render text NOT NULL DEFAULT '',
        toc jsonb NOT NULL DEFAULT '[]'::jsonb,
        "contentType" text NOT NULL DEFAULT 'markdown',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "editorKey" text NOT NULL DEFAULT '',
        "authorId" integer NOT NULL DEFAULT 1,
        "creatorId" integer NOT NULL DEFAULT 1,
        "ownerId" integer,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        visibility text NOT NULL,
        "isPublished" boolean NOT NULL,
        "publishStartDate" timestamptz,
        "publishEndDate" timestamptz
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL UNIQUE,
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
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
      );
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY,
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "sourceRevision" bigint NOT NULL,
        "effectKind" text NOT NULL,
        "effectKey" text NOT NULL,
        "desiredState" text NOT NULL,
        "payloadSha256" text NOT NULL DEFAULT '',
        payload text NOT NULL DEFAULT '{}',
        status text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        "leaseOwner" text,
        "leaseToken" uuid,
        "leaseExpiresAt" timestamptz,
        "availableAt" timestamptz NOT NULL DEFAULT now(),
        result text,
        postcondition text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
    `)
    await createKnowledgeProjectionSchema(db)
    await createKnowledgeSearchIndex(db)

    originalWiki = wikiRuntime.WIKI
    const wiki = {
      auth: {
        checkAccess: (requester: unknown, permissions: readonly string[], context: Record<string, unknown> = {}) => {
          if (permissions.includes('manage:system')) {
            return (
              typeof requester === 'object' &&
              requester !== null &&
              Array.isArray(Reflect.get(requester, 'permissions')) &&
              Reflect.get(requester, 'permissions').includes('manage:system')
            )
          }
          const tags = Array.isArray(context.tags) ? context.tags : []
          return !tags.some(
            tag => (typeof tag === 'string' ? tag : tag !== null && typeof tag === 'object' ? Reflect.get(tag, 'tag') : undefined) === 'graph-denied'
          )
        }
      },
      config: { db: { type: 'postgres' }, search: { maxHits: 100 }, lang: { code: 'en' } },
      data: { searchEngine: undefined as unknown },
      Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      models: { knex: db, pages: {} as unknown, tags: {} as unknown }
    }
    wikiRuntime.WIKI = wiki as never

    // Page, engine, and operations capture WIKI during evaluation, so this harness loads them only after binding the disposable PostgreSQL runtime.
    const [{ default: PageModel }, { default: TagModel }] = await Promise.all([import('../models/pages.ts'), import('../models/tags.ts')])
    Page = PageModel
    Page.knex(db)
    TagModel.knex(db)
    wiki.models.pages = Page
    wiki.models.tags = TagModel

    const engineModule = await import('../modules/search/postgres/engine.ts')
    const engine = Object.assign(engineModule.default, { config: { dictLanguage: 'english' } }) as unknown as PostgreSqlSearchEngine
    wiki.data.searchEngine = engine
    await engine.init()
    operations = (await import('../operations/pages.ts')).default as SearchOperations

    const pages = [
      {
        id: 42,
        sourceRevision: 42,
        path: 'knowledge/topic-42/page-42',
        localeCode: 'en',
        title: 'Amber Falcon Runbook',
        description: 'Incident drill',
        content: '# Amber Falcon\n\nultraviolet marmot checksum recovery procedure',
        render: '<article><h1>Amber Falcon</h1><p>ultraviolet marmot checksum recovery procedure</p></article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 43,
        sourceRevision: 43,
        path: 'knowledge/topic-43/phrase-distractor',
        localeCode: 'en',
        title: 'Phrase Distractor',
        description: 'Separated terms',
        content: '# Phrase distractor\n\nultraviolet registry for marmot calibration retains a checksum',
        render: '<article>ultraviolet registry for marmot calibration retains a checksum</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 314,
        sourceRevision: 314,
        path: 'knowledge/topic-14/page-314',
        localeCode: 'en',
        title: 'Celestial Harbor Handbook',
        description: 'Harbor procedures',
        content: '# Celestial Harbor',
        render: '<article>Celestial Harbor</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 19000,
        sourceRevision: 19000,
        path: 'knowledge/topic-0/page-19000',
        localeCode: 'fr',
        title: 'Selected Tail',
        description: 'Selected page beyond ordinary cap',
        content: '# Selected Tail',
        render: '<article>Selected Tail</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 19004,
        sourceRevision: 19004,
        path: 'knowledge/topic-4/page-19004',
        localeCode: 'fr',
        title: 'Withheld Distractor',
        description: 'common platform withheld',
        content: '# Withheld',
        render: '<article>Withheld</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 700,
        sourceRevision: 700,
        path: 'knowledge/unpublished',
        localeCode: 'en',
        title: 'Unpublished Projection',
        description: '',
        content: '# Unpublished',
        render: '<article>Unpublished</article>',
        visibility: 'public',
        isPublished: false
      },
      {
        id: 701,
        sourceRevision: 701,
        path: 'knowledge/protected',
        localeCode: 'en',
        title: 'Protected Projection',
        description: '',
        content: '# Protected\n\nConfidential body',
        render: '<article>Confidential body</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 702,
        sourceRevision: 702,
        path: 'knowledge/private-owner',
        localeCode: 'en',
        title: 'Owner Projection',
        description: '',
        content: '# Owner Projection',
        render: '<article>Owner Projection</article>',
        visibility: 'private',
        ownerId: 7,
        isPublished: false
      },
      {
        id: 703,
        sourceRevision: 7,
        path: 'knowledge/stale',
        localeCode: 'en',
        title: 'Current Revision',
        description: '',
        content: '# Current Revision',
        render: '<article>Current Revision</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 801,
        sourceRevision: 801,
        path: 'search-audit/literal-negative-title',
        localeCode: 'en',
        title: 'Amber - Falcon',
        description: 'Literal negative syntax fixture',
        content: '# Amber - Falcon\n\nliteral title syntax',
        render: '<article>Amber - Falcon</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 802,
        sourceRevision: 802,
        path: 'search-audit/amber-beacon',
        localeCode: 'en',
        title: 'Amber Beacon',
        description: 'Spaced negation control',
        content: '# Amber Beacon\n\nbeacon control',
        render: '<article>Amber Beacon</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 803,
        sourceRevision: 803,
        path: 'search-audit/stopword-title',
        localeCode: 'en',
        title: 'The',
        description: 'All-stopword title control',
        content: '# Stopword\n\nexact title control',
        render: '<article>Stopword</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 804,
        sourceRevision: 804,
        path: 'search-audit/public-falcon-relay',
        localeCode: 'en',
        title: 'Falcon Relay Public',
        description: 'Public mixed-query control',
        content: '# Falcon Relay\n\npublic control',
        render: '<article>Falcon Relay</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 805,
        sourceRevision: 805,
        path: 'search-audit/private-falcon-relay',
        localeCode: 'en',
        title: 'Falcon Relay Private',
        description: 'Private mixed-query control',
        content: '# Falcon Relay\n\nprivate control',
        render: '<article>Falcon Relay</article>',
        visibility: 'private',
        ownerId: 7,
        isPublished: false
      },
      {
        id: 806,
        sourceRevision: 806,
        path: 'search-audit/negative-boundary',
        localeCode: 'en',
        title: 'Negative Boundary',
        description: 'Bounded negative-only control',
        content: '# Negative Boundary\n\nneutral result',
        render: '<article>Negative Boundary</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 807,
        sourceRevision: 807,
        path: 'search-audit/reversed-evidence',
        localeCode: 'en',
        title: 'Falcon Amber',
        description: 'Reversed title metadata',
        content: '# Body Evidence\n\nAmber Falcon',
        render: '<article>Amber Falcon</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 65,
        sourceRevision: 65,
        path: 'graph/denied-target',
        localeCode: 'en',
        title: 'Denied Graph Target',
        description: '',
        content: '# Denied target',
        render: '<article>Denied target</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 66,
        sourceRevision: 66,
        path: 'graph/denied-source',
        localeCode: 'en',
        title: 'Denied Graph Source',
        description: '',
        content: '# Denied source',
        render: '<article>Denied source</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 67,
        sourceRevision: 67,
        path: 'graph/unpublished-source',
        localeCode: 'en',
        title: 'Unpublished Graph Source',
        description: '',
        content: '# Unpublished source',
        render: '<article>Unpublished source</article>',
        visibility: 'public',
        isPublished: false
      },
      {
        id: 68,
        sourceRevision: 68,
        path: 'graph/direct',
        localeCode: 'en',
        title: 'Direct Graph Target',
        description: '',
        content: '# Direct target',
        render: '<article>Direct target</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 69,
        sourceRevision: 69,
        path: 'graph/tail',
        localeCode: 'en',
        title: 'Graph Tail',
        description: '',
        content: '# Tail',
        render: '<article>Tail</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 70,
        sourceRevision: 70,
        path: 'graph/protected-bridge',
        localeCode: 'en',
        title: 'Protected Graph Bridge',
        description: '',
        content: '# Protected bridge\n\nHidden relationship',
        render: '<article>Hidden relationship</article>',
        visibility: 'public',
        isPublished: true
      },
      {
        id: 71,
        sourceRevision: 71,
        path: 'graph/seed',
        localeCode: 'en',
        title: 'Graph Seed',
        description: '',
        content: '# Seed',
        render: '<article>Seed</article>',
        visibility: 'public',
        isPublished: true
      },
      ...Array.from({ length: 101 }, (_, index) => ({
        id: 1_000 + index,
        sourceRevision: 1_000 + index,
        path: `knowledge/common/${index}`,
        localeCode: 'en',
        title: `Cap Candidate ${String(index).padStart(3, '0')}`,
        description: 'Common platform candidate',
        content: '# Cap Candidate',
        render: '<article>Cap Candidate</article>',
        visibility: 'public',
        isPublished: true
      }))
    ]
    await db('users').insert([{ id: 1, name: 'Search Fixture Author', email: 'search-fixture@example.test' }])
    await db('pages').insert(pages)
    await db('tags').insert([
      { id: 1, tag: 'common-platform', title: 'Common Platform' },
      { id: 2, tag: 'incident', title: 'Incident' },
      { id: 3, tag: 'harbor', title: 'Harbor' },
      { id: 4, tag: 'graph-denied', title: 'Graph Denied' }
    ])
    await db('pageTags').insert([
      { pageId: 42, tagId: 2 },
      { pageId: 314, tagId: 3 },
      { pageId: 19000, tagId: 1 },
      { pageId: 19004, tagId: 1 },
      { pageId: 65, tagId: 4 },
      { pageId: 66, tagId: 4 },
      ...Array.from({ length: 101 }, (_, index) => ({ pageId: 1_000 + index, tagId: 1 }))
    ])
    await db('pageAccessPasswords').insert([{ pageId: 70 }, { pageId: 701 }])
    await db('pageLinks').insert([
      { pageId: 71, localeCode: 'en', path: 'graph/protected-bridge' },
      { pageId: 70, localeCode: 'en', path: 'graph/tail' },
      { pageId: 71, localeCode: 'en', path: 'graph/direct' },
      { pageId: 67, localeCode: 'en', path: 'graph/direct' },
      { pageId: 66, localeCode: 'en', path: 'graph/direct' },
      { pageId: 68, localeCode: 'en', path: 'graph/denied-target' }
    ])
    await db('pageMutationOutbox').insert([
      {
        id: '00000000-0000-4000-8000-000000000071',
        pageId: 71,
        sourceRevision: 71,
        effectKind: 'links',
        effectKey: 'page:71:links',
        desiredState: 'present',
        status: 'succeeded'
      },
      {
        id: '00000000-0000-4000-8000-000000000070',
        pageId: 70,
        sourceRevision: 70,
        effectKind: 'links',
        effectKey: 'page:70:links',
        desiredState: 'present',
        status: 'succeeded'
      },
      {
        id: '00000000-0000-4000-8000-000000000067',
        pageId: 67,
        sourceRevision: 67,
        effectKind: 'links',
        effectKey: 'page:67:links',
        desiredState: 'present',
        status: 'succeeded'
      },
      {
        id: '00000000-0000-4000-8000-000000000066',
        pageId: 66,
        sourceRevision: 66,
        effectKind: 'links',
        effectKey: 'page:66:links',
        desiredState: 'present',
        status: 'succeeded'
      },
      {
        id: '00000000-0000-4000-8000-000000000068',
        pageId: 68,
        sourceRevision: 68,
        effectKind: 'links',
        effectKey: 'page:68:links',
        desiredState: 'present',
        status: 'succeeded'
      }
    ])
    await engine.rebuild()

    const sourceRows = await db('pages').select(
      'id',
      'sourceRevision',
      'path',
      'localeCode',
      'visibility',
      'contentType',
      'content',
      'title',
      'description',
      'updatedAt',
      'authorId'
    )
    const sourceById = new Map(sourceRows.map(row => [Number(row.id), row]))
    const tags = await db('pageTags').join('tags', 'tags.id', 'pageTags.tagId').select('pageTags.pageId', 'tags.tag')
    const tagsByPage = new Map<number, string[]>()
    for (const tag of tags) tagsByPage.set(Number(tag.pageId), [...(tagsByPage.get(Number(tag.pageId)) ?? []), String(tag.tag)])
    const persistProjection = async (pageId: number, searchTerms: readonly string[], sourceRevision?: number): Promise<void> => {
      const source = sourceById.get(pageId)
      if (!source) throw new Error(`Missing projection source ${pageId}`)
      const revision = sourceRevision ?? Number(source.sourceRevision)
      const generatedAt = '2026-09-07T00:00:00.000Z'
      const projection = mergeKnowledgeUtilityResult(
        projectPageKnowledge({
          pageId,
          sourceRevision: revision,
          locale: String(source.localeCode),
          path: String(source.path),
          visibility: source.visibility as 'public' | 'private',
          contentType: String(source.contentType),
          content: String(source.content),
          title: String(source.title),
          description: typeof source.description === 'string' ? source.description : null,
          tags: tagsByPage.get(pageId) ?? [],
          updatedAt: source.updatedAt as Date,
          authorId: Number(source.authorId)
        }),
        {
          type: null,
          summary: null,
          tags: [],
          entities: [],
          relationships: [],
          openQuestions: [],
          searchTerms: [...searchTerms]
        },
        {
          profileVersionId: '22222222-2222-4222-8222-222222222222',
          model: 'fixture-generated-search-terms',
          inputSha256: 'c'.repeat(64),
          outputSha256: 'd'.repeat(64),
          generatedAt
        }
      )
      const searchText = knowledgeSearchText(projection)
      const dictionary = engine.config.dictLanguage
      await db('pageKnowledgeProjections').insert({
        pageId: projection.source.pageId,
        sourceRevision: projection.source.sourceRevision,
        sourceSha256: projection.source.sha256,
        schemaVersion: projection.version,
        deterministicVersion: projection.provenance.deterministicVersion,
        state: projection.completeness.state,
        enrichmentState: 'fixture-generated',
        conceptType: projection.concept.type,
        summary: projection.concept.summary,
        searchText,
        searchDictionary: dictionary,
        searchTokens: db.raw('to_tsvector(?::regconfig, ?)', [dictionary, searchText]),
        lifecycleStatus: projection.lifecycle.status,
        trustTier: projection.lifecycle.trustTier,
        verification: projection.lifecycle.verification,
        staleAfter: projection.lifecycle.staleAfter,
        utilityProfileVersionId: projection.provenance.utility?.profileVersionId ?? null,
        utilityModel: projection.provenance.utility?.model ?? null,
        utilityInputSha256: projection.provenance.utility?.inputSha256 ?? null,
        utilityOutputSha256: projection.provenance.utility?.outputSha256 ?? null,
        utilityGeneratedAt: projection.provenance.utility?.generatedAt ?? null,
        projection: JSON.stringify(projection),
        lastError: null,
        createdAt: generatedAt,
        updatedAt: generatedAt
      })
    }
    await persistProjection(42, ['restore the ultraviolet verification code'])
    await persistProjection(700, ['unpublished projection boundary'])
    await persistProjection(701, ['protected projection boundary'])
    await persistProjection(702, ['owner private projection boundary'])
    await persistProjection(703, ['obsolete revision boundary'], 6)
  })

  afterAll(async () => {
    if (db) {
      await db.raw(
        'DROP TABLE IF EXISTS "pageKnowledgeProjections", "pageMutationOutbox", "pageAccessPasswords", "pageLinks", "pageTags", tags, pages, users CASCADE;'
      )
      await db.destroy()
    }
    wikiRuntime.WIKI = originalWiki
  })

  it('retrieves current revisioned deterministic and fixture-generated search terms through shared operations', async () => {
    const acronym = await operations.search({ query: 'AFR' })
    expect(acronym.results).toContainEqual(expect.objectContaining({ id: 42, sourceRevision: '42', matchedFields: expect.arrayContaining(['knowledge']) }))

    const paraphrase = await operations.search({ query: 'restore the ultraviolet verification code' })
    expect(paraphrase.results).toContainEqual(expect.objectContaining({ id: 42, sourceRevision: '42', matchedFields: expect.arrayContaining(['knowledge']) }))

    const structured = await operations.search({ query: '"restore the ultraviolet verification code"' })
    expect(structured.results.map(result => result.id)).not.toContain(42)
  })

  it('enforces phrase, disjunction, negation, empty-input, and selected-scope precision through PostgreSQL', async () => {
    const phrase = await operations.search({ query: '"ultraviolet marmot checksum"' })
    expect(phrase.results.map(result => result.id)).toContain(42)
    expect(phrase.results.map(result => result.id)).not.toContain(43)

    const disjunction = await operations.search({ query: 'Amber OR Celestial' })
    expect(disjunction.results.map(result => result.id)).toEqual(expect.arrayContaining([42, 314]))

    const negation = await operations.search({ query: 'common-platform -withheld', pageIds: [19000, 19004], limit: 5 })
    expect(negation.results.map(result => result.id)).toEqual([19000])

    expect((await operations.search({ query: '   ' })).results).toEqual([])
  })

  it('treats spaced negation as exclusion without treating a hyphenated positive term as negation', async () => {
    const scope = [801, 802]

    const spacedNegation = await operations.search({ query: 'Amber - Falcon', pageIds: scope, limit: 5 })
    expect(spacedNegation.results.map(result => result.id)).toEqual([802])

    const hyphenatedPositiveTerms = await operations.search({ query: 'Amber- Falcon', pageIds: scope, limit: 5 })
    expect(hyphenatedPositiveTerms.results.map(result => result.id)).toEqual([801])
  })

  it('finds an ordinary exact title made entirely of stopwords', async () => {
    const exactStopwordTitle = await operations.search({ query: 'The', pageIds: [803], limit: 5 })

    expect(exactStopwordTitle.results).toEqual([expect.objectContaining({ id: 803, sourceRevision: '803', matchedFields: ['title'] })])
  })

  it('keeps mixed disjunction and negation results consistent across public and owner-private scopes', async () => {
    const query = 'falcon OR -marmot'
    const publicResult = await operations.search({ query, pageIds: [804], limit: 5 })
    const ownerPrivateResult = await operations.search({ query, requester: { id: 7 } as Express.User, pageIds: [805], limit: 5 })

    expect(publicResult.results.map(result => result.id)).toEqual([804])
    expect(ownerPrivateResult.results.map(result => result.id)).toEqual([805])
    expect((await operations.search({ query, requester: { id: 8 } as Express.User, pageIds: [805], limit: 5 })).results).toEqual([])
  })

  it('does not infer positive matched fields for a bounded negative-only result', async () => {
    const negativeOnly = await operations.search({ query: '-marmot', pageIds: [806], limit: 1 })

    expect(negativeOnly.results).toEqual([expect.objectContaining({ id: 806, sourceRevision: '806', matchedFields: [] })])
  })

  it('reports body-only evidence for a quoted phrase when title metadata has its terms reversed', async () => {
    const quotedPhrase = await operations.search({ query: '"Amber Falcon"', pageIds: [807], limit: 5 })

    expect(quotedPhrase.results).toEqual([expect.objectContaining({ id: 807, sourceRevision: '807', matchedFields: ['content'] })])
  })

  it('prefilters selected scope before the engine cap and returns the selected tail', async () => {
    const ordinary = await operations.search({ query: 'common-platform', limit: 100 })
    expect(ordinary.results).toHaveLength(100)
    expect(ordinary.results.map(result => result.id)).not.toContain(19000)

    const selected = await operations.search({ query: 'common-platform', pageIds: [19000], limit: 5 })
    expect(selected.results).toEqual([expect.objectContaining({ id: 19000, sourceRevision: '19000' })])
  })

  it('excludes unpublished, protected, stale, and foreign-private projection candidates while retaining the owner private result', async () => {
    const publicBoundaryQueries = [
      ['unpublished projection boundary', 700],
      ['protected projection boundary', 701],
      ['obsolete revision boundary', 703]
    ] as const
    for (const [query, excludedId] of publicBoundaryQueries) {
      expect((await operations.search({ query })).results.map(result => result.id)).not.toContain(excludedId)
    }

    const owner = await operations.search({ query: 'owner private projection boundary', requester: { id: 7 } as Express.User })
    expect(owner.results).toContainEqual(expect.objectContaining({ id: 702, sourceRevision: '702' }))

    const otherOwner = await operations.search({ query: 'owner private projection boundary', requester: { id: 8 } as Express.User })
    expect(otherOwner.results.map(result => result.id)).not.toContain(702)
  })

  it('pins PostgreSQL lexical candidates to the authorized metadata revision', async () => {
    await db('pages').where({ id: 42 }).update({ sourceRevision: 43 })
    try {
      const result = await operations.search({ query: 'AFR', pageIds: [42], limit: 5 })
      expect(result.results.map(candidate => candidate.id)).not.toContain(42)
    } finally {
      await db('pages').where({ id: 42 }).update({ sourceRevision: 42 })
    }
  })

  it('keeps protected, unpublished, and tag-denied pages out of shared graph traversal and link listings', async () => {
    const related = await operations.listRelated({ pageId: 71, limit: 20 })
    expect(related.pages).toEqual([expect.objectContaining({ id: 68, distance: 1 })])
    expect(related.pages.map(page => page.id)).not.toEqual(expect.arrayContaining([69, 70]))

    const links = await operations.listLinks({ locale: 'en' })
    expect(links).toContainEqual(expect.objectContaining({ id: 71, links: ['en/graph/direct'] }))
    expect(links).toContainEqual(expect.objectContaining({ id: 68, links: [] }))
    expect(links.map(page => page.id)).not.toEqual(expect.arrayContaining([66, 67, 70]))
  })
  it('withholds a stale graph edge while the current links receipt is pending or running', async () => {
    const staleLink = { pageId: 70, localeCode: 'en', path: 'graph/tail' }
    const receipt = {
      id: '00000000-0000-4000-8000-000000000072',
      pageId: 70,
      sourceRevision: 71,
      effectKind: 'links',
      effectKey: 'page:70:links:71',
      desiredState: 'present',
      status: 'pending'
    }
    await db('pages').where({ id: 70 }).update({
      sourceRevision: 71,
      content: '# No outgoing references',
      render: '<article>No outgoing references</article>'
    })
    await db('pageAccessPasswords').where({ pageId: 70 }).delete()
    await db('pageMutationOutbox').insert(receipt)
    try {
      const pendingLinks = await operations.listLinks({ locale: 'en' })
      expect(pendingLinks.find(page => page.id === 70)).toEqual(expect.objectContaining({ links: [] }))
      const pendingRelated = await operations.listRelated({ pageId: 71, limit: 20 })
      expect(pendingRelated.pages.map(page => page.id)).not.toContain(69)
      expect(pendingRelated.pages.map(page => page.id)).toContain(70)

      await db('pageMutationOutbox').where({ id: receipt.id }).update({ status: 'running' })
      const runningLinks = await operations.listLinks({ locale: 'en' })
      expect(runningLinks.find(page => page.id === 70)).toEqual(expect.objectContaining({ links: [] }))
      const runningRelated = await operations.listRelated({ pageId: 71, limit: 20 })
      expect(runningRelated.pages.map(page => page.id)).not.toContain(69)

      await db('pageLinks').where(staleLink).delete()
      await db('pageMutationOutbox').where({ id: receipt.id }).update({ status: 'succeeded' })
      const completedLinks = await operations.listLinks({ locale: 'en' })
      expect(completedLinks.find(page => page.id === 70)).toEqual(expect.objectContaining({ links: [] }))
      const completedRelated = await operations.listRelated({ pageId: 71, limit: 20 })
      expect(completedRelated.pages.map(page => page.id)).not.toContain(69)
    } finally {
      await db('pageMutationOutbox').where({ id: receipt.id }).delete()
      await db('pageLinks').where(staleLink).delete()
      await db('pageLinks').insert(staleLink)
      await db('pageAccessPasswords').insert({ pageId: 70 })
      await db('pages').where({ id: 70 }).update({
        sourceRevision: 70,
        content: '# Protected bridge\n\nHidden relationship',
        render: '<article>Hidden relationship</article>'
      })
    }
  })
})

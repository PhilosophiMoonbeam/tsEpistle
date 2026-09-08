import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import {
  POSTGRES_SEARCH_CORPUS,
  POSTGRES_SEARCH_DEFAULT_THRESHOLDS,
  POSTGRES_SEARCH_SCHEMA_VERSION,
  createPostgresSearchBenchmarkReport,
  percentile,
  publishPostgresSearchBenchmarkReport
} from '../../scripts/benchmark-postgres-search.ts'
import type {
  AtomicReportFileSystem,
  PostgresSearchBenchmarkInput,
  PostgresSearchQueryKind,
  PostgresSearchRelevanceEvidence
} from '../../scripts/benchmark-postgres-search.ts'
import {
  evaluateSearchRelevance,
  SEARCH_AUGMENTED_RELEVANCE_CASES,
  SEARCH_RELEVANCE_ACCEPTANCE_CASES,
  SEARCH_RELEVANCE_CASES,
  type RelevanceCase
} from '../../scripts/search-relevance.ts'

const temporaryDirectories: string[] = []
const querySamples = (sample: number): Record<PostgresSearchQueryKind, number[]> => ({
  exactTitleContent: [sample, sample + 1, sample + 2, sample + 3, sample + 4],
  typoFuzzy: [sample + 1, sample + 2, sample + 3, sample + 4, sample + 5],
  multiTermDescription: [sample + 2, sample + 3, sample + 4, sample + 5, sample + 6],
  commonTag: [sample + 3, sample + 4, sample + 5, sample + 6, sample + 7]
})

const passingEvaluation = (provenance: string, fixtures: readonly RelevanceCase[]) => {
  const required = fixtures.filter(fixture => fixture.acceptance === 'required')
  return {
    corpus: 'seeded fixture',
    provenance,
    cases: required.map(fixture => ({
      name: fixture.name,
      query: fixture.query,
      expected: fixture.expected,
      excluded: fixture.excluded ?? [],
      top5: [...fixture.expected],
      returned: [...fixture.expected],
      samples: Array.from({ length: 5 }, () => ({ top5: [...fixture.expected], returned: [...fixture.expected] })),
      missingExpected: [],
      unexpectedExcluded: [],
      scopeViolations: [],
      unexpectedResults: [],
      passed: true,
      recallAt5: 1,
      reciprocalRankAt5: 1,
      ndcgAt5: 1,
      zeroResults: false,
      p95Milliseconds: 1
    })),
    recallAt5: 1,
    meanReciprocalRankAt5: 1,
    meanNdcgAt5: 1,
    zeroResultRate: 0,
    requiredCases: required.length,
    failedCases: []
  }
}

const passingRelevance = (): PostgresSearchRelevanceEvidence => ({
  lexicalBaseline: passingEvaluation('lexical baseline', SEARCH_RELEVANCE_CASES),
  lexicalAcceptance: passingEvaluation('lexical acceptance', SEARCH_RELEVANCE_ACCEPTANCE_CASES),
  augmentedFixture: passingEvaluation('current revisioned projection fixture; not shared operations.search evidence', SEARCH_AUGMENTED_RELEVANCE_CASES)
})

const input = (overrides: Partial<PostgresSearchBenchmarkInput> = {}): PostgresSearchBenchmarkInput => ({
  postgresVersion: '17.6',
  postgresMajorVersion: 17,
  pgTrgmVersion: '1.6',
  observedCorpus: {
    pages: POSTGRES_SEARCH_CORPUS.pages,
    renderedPages: POSTGRES_SEARCH_CORPUS.renderedPages,
    links: POSTGRES_SEARCH_CORPUS.links,
    distinctTags: POSTGRES_SEARCH_CORPUS.distinctTags,
    tagAssignments: POSTGRES_SEARCH_CORPUS.tagAssignments,
    locales: { ...POSTGRES_SEARCH_CORPUS.locales }
  },
  derivedSearch: { vectors: POSTGRES_SEARCH_CORPUS.pages, suggestionTerms: 80_000, revisionMismatches: 0, orphanVectors: 0 },
  searchSchemaVersion: POSTGRES_SEARCH_SCHEMA_VERSION,
  dictionary: 'english',
  iterations: 5,
  warmupsPerDistribution: 2,
  thresholds: { ...POSTGRES_SEARCH_DEFAULT_THRESHOLDS },
  rebuildMilliseconds: 2_500,
  querySamples: querySamples(10),
  representativeChecks: [{ name: 'seeded result', passed: true, expected: 'page 42', observed: 'page 42' }],
  relevance: passingRelevance(),
  ...overrides
})

const reportPath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-postgres-search-benchmark-'))
  temporaryDirectories.push(directory)
  return join(directory, 'report.json')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('PostgreSQL search benchmark evidence', () => {
  it('constructs a self-describing report with deterministic metadata', () => {
    const first = createPostgresSearchBenchmarkReport(input())
    const second = createPostgresSearchBenchmarkReport(input())

    expect(second).toEqual(first)
    expect(first.status).toBe('passed')
    expect(POSTGRES_SEARCH_DEFAULT_THRESHOLDS.maxQueryP95Milliseconds).toBe(200)
    expect(first.thresholds).toEqual(POSTGRES_SEARCH_DEFAULT_THRESHOLDS)
    expect(first.corpus).toEqual({
      seed: POSTGRES_SEARCH_CORPUS.seed,
      expected: input().observedCorpus,
      observed: input().observedCorpus
    })
    expect(first.searchSchema).toEqual({ version: POSTGRES_SEARCH_SCHEMA_VERSION, dictionary: 'english' })
    expect(first.derivedSearch).toEqual({
      vectors: POSTGRES_SEARCH_CORPUS.pages,
      suggestionTerms: 80_000,
      revisionMismatches: 0,
      orphanVectors: 0
    })
    expect(first.environment).toEqual({ postgresVersion: '17.6', postgresMajorVersion: 17, pgTrgmVersion: '1.6' })
    expect(first.iterations).toBe(5)
    expect(first.warmupsPerDistribution).toBe(2)
    expect(first.queryDistributions.map(distribution => distribution.kind)).toEqual(['exactTitleContent', 'typoFuzzy', 'multiTermDescription', 'commonTag'])
    expect(first.reportVersion).toBe(2)
    expect(first.relevance.augmentedFixture.provenance).toContain('not shared operations.search evidence')
    expect(first.relevance.augmentedFixture.cases.map(result => result.name)).toEqual(SEARCH_RELEVANCE_CASES.map(fixture => fixture.name))
  })

  it('uses nearest-rank percentiles and records threshold and correctness violations', () => {
    expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30)
    expect(percentile([50, 10, 40, 20, 30], 0.95)).toBe(50)

    const report = createPostgresSearchBenchmarkReport(
      input({
        rebuildMilliseconds: 10_001,
        thresholds: { maxRebuildMilliseconds: 10_000, maxQueryP95Milliseconds: 14 },
        representativeChecks: [{ name: 'seeded result', passed: false, expected: 'page 42', observed: '<none>' }]
      })
    )

    expect(report.status).toBe('failed')
    expect(report.queryDistributions[0]).toMatchObject({ p50Milliseconds: 12, p95Milliseconds: 14, p99Milliseconds: 14 })
    expect(report.thresholdViolations).toEqual([
      {
        scope: 'rebuild',
        invariant: 'rebuildMilliseconds <= thresholds.maxRebuildMilliseconds',
        measured: 10_001,
        threshold: 10_000
      },
      {
        scope: 'typoFuzzy',
        invariant: 'p95Milliseconds <= thresholds.maxQueryP95Milliseconds',
        measured: 15,
        threshold: 14
      },
      {
        scope: 'multiTermDescription',
        invariant: 'p95Milliseconds <= thresholds.maxQueryP95Milliseconds',
        measured: 16,
        threshold: 14
      },
      {
        scope: 'commonTag',
        invariant: 'p95Milliseconds <= thresholds.maxQueryP95Milliseconds',
        measured: 17,
        threshold: 14
      },
      {
        scope: 'correctness',
        invariant: 'all representative result checks pass',
        measured: 1,
        threshold: 0
      }
    ])
  })

  it('records an iteration-count invariant instead of silently accepting incomplete distributions', () => {
    const incomplete = querySamples(10)
    incomplete.commonTag.pop()

    const report = createPostgresSearchBenchmarkReport(input({ querySamples: incomplete }))

    expect(report.status).toBe('failed')
    expect(report.thresholdViolations).toContainEqual({
      scope: 'commonTag',
      invariant: 'distribution.samples === iterations',
      measured: 4,
      threshold: 5
    })
  })

  it('fails before passed status with complete diagnostics when required relevance and exclusion acceptance fails', async () => {
    const failedEvaluation = await evaluateSearchRelevance(
      async query => ({
        results:
          query === '"ultraviolet marmot checksum"'
            ? [{ id: 43 }]
            : query === 'common-platform -withheld'
              ? [{ id: 19000 }]
              : query === 'Amber OR Celestial'
                ? [{ id: 42 }, { id: 314 }]
                : []
      }),
      {
        corpus: 'controlled relevance failure',
        provenance: 'test executor',
        cases: SEARCH_RELEVANCE_ACCEPTANCE_CASES
      }
    )
    const relevance = passingRelevance()
    relevance.lexicalAcceptance = failedEvaluation

    const report = createPostgresSearchBenchmarkReport(input({ relevance }))

    expect(report.status).toBe('failed')
    expect(report.thresholdViolations).toContainEqual({
      scope: 'relevance',
      invariant: 'lexicalAcceptance.quoted phrase returns the contiguous seeded content passes',
      measured:
        'query="\\"ultraviolet marmot checksum\\"" top5=[43] returned=[43] samples=[top5=[43] returned=[43];top5=[43] returned=[43];top5=[43] returned=[43];top5=[43] returned=[43];top5=[43] returned=[43]] missing=[42] excluded=[43] scope=[] unexpected=[]',
      threshold: 'expected=[42] excluded=[43]'
    })
    expect(failedEvaluation.failedCases).toHaveLength(1)
  })

  it('rejects missing named relevance evidence instead of trusting aggregate status fields', () => {
    const relevance = passingRelevance()
    relevance.lexicalAcceptance = { ...relevance.lexicalAcceptance, cases: [], requiredCases: 0, failedCases: [] }

    const report = createPostgresSearchBenchmarkReport(input({ relevance }))

    expect(report.status).toBe('failed')
    expect(report.thresholdViolations).toContainEqual({
      scope: 'relevance',
      invariant: 'lexicalAcceptance.quoted phrase returns the contiguous seeded content produces required evidence',
      measured: 'missing',
      threshold: 'query="\\"ultraviolet marmot checksum\\"" expected=[42]'
    })
  })

  it('preserves all repeated samples and gates a locale or path scope violation from any sample', async () => {
    let calls = 0
    const evaluation = await evaluateSearchRelevance(
      async () => {
        calls += 1
        if (calls === 2) return { results: [{ id: 42, locale: 'fr', path: 'outside' }] }
        if (calls === 4) return { results: [] }
        return { results: [{ id: 42, locale: 'en', path: 'knowledge/runbook' }] }
      },
      {
        corpus: 'sample stability fixture',
        provenance: 'test executor',
        cases: [{ name: 'scoped result', query: 'runbook', expected: [42], acceptance: 'required', options: { locale: 'en', path: 'knowledge' } }]
      }
    )

    expect(evaluation.cases[0]).toMatchObject({
      samples: [
        { top5: [42], returned: [42] },
        { top5: [42], returned: [42] },
        { top5: [42], returned: [42] },
        { top5: [], returned: [] },
        { top5: [42], returned: [42] }
      ],
      missingExpected: [42],
      scopeViolations: [42],
      passed: false
    })
    expect(evaluation.failedCases).toHaveLength(1)
  })
  it('preserves the previous report and removes temporary output when atomic publication fails', async () => {
    const outputPath = await reportPath()
    await writeFile(outputPath, '{"previous":true}\n')
    const fileSystem: AtomicReportFileSystem = {
      writeFile,
      rename: async () => {
        throw new Error('injected rename failure')
      },
      rm
    }

    await expect(publishPostgresSearchBenchmarkReport(createPostgresSearchBenchmarkReport(input()), outputPath, fileSystem)).rejects.toThrow(
      'injected rename failure'
    )

    expect(await readFile(outputPath, 'utf8')).toBe('{"previous":true}\n')
    expect(await readdir(dirname(outputPath))).toEqual(['report.json'])
  })

  it('publishes threshold evidence atomically before returning a failing exit path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const outputPath = await reportPath()
    const report = createPostgresSearchBenchmarkReport(input({ thresholds: { maxRebuildMilliseconds: 1, maxQueryP95Milliseconds: 100 } }))

    await expect(publishPostgresSearchBenchmarkReport(report, outputPath)).rejects.toThrow('PostgreSQL search benchmark failed')

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(report)
    expect(await readdir(dirname(outputPath))).toEqual(['report.json'])
  })
})

export interface SearchScopeOptions {
  locale?: string
  path?: string
  pageIds?: number[]
  limit?: number
}

export interface SearchRelevanceResult {
  id: number
  locale?: string
  path?: string
}

export interface SearchRelevanceSample {
  top5: number[]
  returned: number[]
}

export interface RelevanceCase {
  name: string
  query: string
  expected: readonly number[]
  excluded?: readonly number[]
  expectNoResults?: boolean
  acceptance: 'required' | 'diagnostic'
  options?: SearchScopeOptions
}

export interface SearchRelevanceCaseResult extends RelevanceMetrics {
  name: string
  query: string
  expected: readonly number[]
  excluded: readonly number[]
  top5: number[]
  returned: number[]
  samples: SearchRelevanceSample[]
  missingExpected: number[]
  unexpectedExcluded: number[]
  scopeViolations: number[]
  unexpectedResults: number[]
  passed: boolean
  p95Milliseconds: number
}

export interface SearchRelevanceEvaluation {
  corpus: string
  provenance: string
  cases: SearchRelevanceCaseResult[]
  recallAt5: number
  meanReciprocalRankAt5: number
  meanNdcgAt5: number
  zeroResultRate: number
  requiredCases: number
  failedCases: SearchRelevanceCaseResult[]
}

export interface SearchRelevanceEvaluationInput {
  corpus: string
  provenance: string
  cases: readonly RelevanceCase[]
}

export type SearchRelevanceExecutor = (query: string, options: SearchScopeOptions) => Promise<{ results: SearchRelevanceResult[] }>

export const SEARCH_RELEVANCE_CASES: readonly RelevanceCase[] = [
  { name: 'exact title', query: 'Amber Falcon Runbook', expected: [42], acceptance: 'required' },
  { name: 'content terms', query: 'ultraviolet marmot checksum', expected: [42], acceptance: 'required' },
  { name: 'typo', query: 'celestal harbor handbook', expected: [314], acceptance: 'required' },
  { name: 'path', query: 'knowledge/topic-42/page-42', expected: [42], acceptance: 'required' },
  { name: 'description', query: 'deterministic actuator calibration', expected: [2718], acceptance: 'required' },
  { name: 'related concepts', query: 'checksum recovery', expected: [42], acceptance: 'required' },
  {
    name: 'abbreviation requires augmentation',
    query: 'AFR',
    expected: [42],
    acceptance: 'diagnostic'
  },
  {
    name: 'paraphrase requires generated search terms',
    query: 'restore the ultraviolet verification code',
    expected: [42],
    acceptance: 'diagnostic'
  },
  { name: 'selected page and tag', query: 'common-platform', expected: [19000], acceptance: 'required', options: { pageIds: [19000] } },
  {
    name: 'locale and section',
    query: 'common-platform',
    expected: [19000],
    acceptance: 'required',
    options: { locale: 'fr', path: 'knowledge/topic-0/page-19000' }
  },
  {
    name: 'authorized tail beyond ordinary cap',
    query: 'common-platform',
    expected: [19000],
    acceptance: 'required',
    options: { pageIds: [19000], limit: 5 }
  }
]

export const SEARCH_RELEVANCE_ACCEPTANCE_CASES: readonly RelevanceCase[] = [
  {
    name: 'quoted phrase returns the contiguous seeded content',
    query: '"ultraviolet marmot checksum"',
    expected: [42],
    excluded: [43],
    acceptance: 'required'
  },
  {
    name: 'negation excludes the selected common-tag distractor',
    query: 'common-platform -withheld',
    expected: [19000],
    excluded: [19004],
    acceptance: 'required',
    options: { pageIds: [19000, 19004] }
  },
  {
    name: 'disjunction retains both seeded branches',
    query: 'Amber OR Celestial',
    expected: [42, 314],
    acceptance: 'required'
  },
  {
    name: 'empty query returns no results',
    query: '   ',
    expected: [],
    expectNoResults: true,
    acceptance: 'required'
  }
]

export const SEARCH_AUGMENTED_RELEVANCE_CASES: readonly RelevanceCase[] = SEARCH_RELEVANCE_CASES.map(fixture => ({
  ...fixture,
  acceptance: 'required'
}))

export interface RelevanceMetrics {
  recallAt5: number
  reciprocalRankAt5: number
  ndcgAt5: number
  zeroResults: boolean
}

export const relevanceMetrics = (resultIds: readonly number[], expected: readonly number[], k = 5): RelevanceMetrics => {
  const expectedIds = new Set(expected)
  const top = [...new Set(resultIds)].slice(0, k)
  const hits = top.filter(id => expectedIds.has(id)).length
  const first = top.findIndex(id => expectedIds.has(id))
  const dcg = top.reduce((sum, id, index) => sum + (expectedIds.has(id) ? 1 / Math.log2(index + 2) : 0), 0)
  const ideal = Array.from({ length: Math.min(expectedIds.size, k) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0)
  return {
    recallAt5: expectedIds.size ? hits / expectedIds.size : 1,
    reciprocalRankAt5: first < 0 ? 0 : 1 / (first + 1),
    ndcgAt5: ideal ? dcg / ideal : 1,
    zeroResults: resultIds.length === 0
  }
}

export const evaluateSearchRelevance = async (search: SearchRelevanceExecutor, input: SearchRelevanceEvaluationInput): Promise<SearchRelevanceEvaluation> => {
  const cases: SearchRelevanceCaseResult[] = []
  for (const fixture of input.cases) {
    const durations: number[] = []
    const samples: SearchRelevanceSample[] = []
    const scopedRows: SearchRelevanceResult[] = []
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now()
      const rows = (await search(fixture.query, fixture.options ?? {})).results
      const returned = [...new Set(rows.map(row => row.id))]
      samples.push({ top5: returned.slice(0, 5), returned })
      scopedRows.push(...rows)
      durations.push(performance.now() - start)
    }
    const returned = [...new Set(samples.flatMap(sample => sample.returned))]
    const top5 = samples[0]?.top5 ?? []
    const missingExpected = fixture.expected.filter(id => samples.some(sample => !sample.top5.includes(id)))
    const unexpectedExcluded = (fixture.excluded ?? []).filter(id => samples.some(sample => sample.returned.includes(id)))
    const scopeViolations = [
      ...new Set(
        scopedRows
          .filter(row => {
            const options = fixture.options
            if (!options) return false
            if (options.pageIds && !options.pageIds.includes(row.id)) return true
            if (options.locale && row.locale !== options.locale) return true
            return Boolean(options.path && row.path !== options.path && !row.path?.startsWith(`${options.path}/`))
          })
          .map(row => row.id)
      )
    ]
    const unexpectedResults = fixture.expectNoResults ? returned : []
    const passed = missingExpected.length === 0 && unexpectedExcluded.length === 0 && scopeViolations.length === 0 && unexpectedResults.length === 0
    const metrics = samples.map(sample => relevanceMetrics(sample.returned, fixture.expected))
    const average = (field: keyof RelevanceMetrics): number => metrics.reduce((sum, metric) => sum + Number(metric[field]), 0) / metrics.length
    cases.push({
      name: fixture.name,
      query: fixture.query,
      expected: fixture.expected,
      excluded: fixture.excluded ?? [],
      top5,
      returned,
      samples,
      missingExpected,
      unexpectedExcluded,
      scopeViolations,
      unexpectedResults,
      passed,
      recallAt5: average('recallAt5'),
      reciprocalRankAt5: average('reciprocalRankAt5'),
      ndcgAt5: average('ndcgAt5'),
      zeroResults: metrics.some(metric => metric.zeroResults),
      p95Milliseconds: Math.max(...durations)
    })
  }
  const mean = (field: 'recallAt5' | 'reciprocalRankAt5' | 'ndcgAt5') => cases.reduce((sum, row) => sum + row[field], 0) / cases.length
  const failedCases = cases.filter(row => row.passed === false && input.cases.find(fixture => fixture.name === row.name)?.acceptance === 'required')
  return {
    corpus: input.corpus,
    provenance: input.provenance,
    cases,
    recallAt5: mean('recallAt5'),
    meanReciprocalRankAt5: mean('reciprocalRankAt5'),
    meanNdcgAt5: mean('ndcgAt5'),
    zeroResultRate: cases.filter(row => row.zeroResults).length / cases.length,
    requiredCases: input.cases.filter(fixture => fixture.acceptance === 'required').length,
    failedCases
  }
}

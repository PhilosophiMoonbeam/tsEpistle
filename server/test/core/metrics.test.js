import { register } from 'prom-client'

const scrapeSamples = output => output.split('\n')
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line)
    if (!sample) throw new Error(`Invalid Prometheus sample: ${line}`)
    const labels = Object.fromEntries(Array.from((sample[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=("(?:\\.|[^"\\])*")/g), match => [match[1], JSON.parse(match[2])]))
    return { name: sample[1], labels, value: Number(sample[3]) }
  })

const samplesFor = (samples, name) => samples.filter(sample => sample.name === name)
const expectSample = (samples, name, value, labels = {}) => {
  expect(samplesFor(samples, name)).toContainEqual({ name, value, labels: { ...labels, WIKI_INSTANCE: 'test-instance' } })
}

const makeCountModel = (total) => ({
  query: () => ({
    count: () => ({
      first: async () => ({ total })
    })
  })
})

const missingTableError = () => Object.assign(new Error('relation does not exist'), { code: '42P01' })

const makeKnex = (fixture = {}) => {
  const knex = vi.fn(table => {
    const builder = {
      select: vi.fn(() => builder),
      count: vi.fn(() => builder),
      sum: vi.fn(() => builder),
      groupBy: vi.fn(async () => {
        if (fixture.missingTables) throw missingTableError()
        return fixture.agentRows?.[table] ?? []
      }),
      first: vi.fn(async () => {
        if (fixture.missingTables) throw missingTableError()
        return fixture.agentRows?.[table] ?? { total: 0 }
      })
    }
    return builder
  })
  knex.raw = vi.fn(async sql => {
    if (fixture.missingTables) {
      if (sql.includes("WHERE visibility = 'public'")) return { rows: [{ total: fixture.eligiblePages ?? 0 }] }
      throw missingTableError()
    }
    if (sql.includes('GROUP BY "effectKind", status')) return { rows: fixture.effects ?? [] }
    if (sql.includes('FROM "pageKnowledgeMaintenance"')) {
      if (sql.includes('GROUP BY status')) return { rows: fixture.maintenanceStatuses ?? [] }
      if (sql.includes('SELECT status')) return { rows: fixture.maintenanceStatuses?.slice(0, 1).map(row => ({ status: row.status })) ?? [] }
      return { rows: fixture.maintenanceProgress ?? [] }
    }
    if (sql.includes('MIN("availableAt")')) return { rows: fixture.ages ?? [] }
    if (sql.includes("status = 'running'")) return { rows: [{ total: fixture.expiredLeases ?? 0 }] }
    if (sql.includes('LEFT JOIN "pageKnowledgeProjections"')) {
      if (sql.includes('COALESCE(projection."enrichmentState"')) return { rows: fixture.knowledgeStates ?? [] }
      return { rows: [{ total: fixture.knowledgeGaps ?? 0 }] }
    }
    if (sql.includes('LEFT JOIN pages page')) {
      return {
        rows: [{
          revisionMismatch: fixture.revisionMismatches ?? 0,
          orphan: fixture.vectorOrphans ?? 0
        }]
      }
    }
    if (sql.includes('FROM "pagesVector"')) return { rows: [{ total: fixture.indexedVectors ?? 0 }] }
    if (sql.includes('FROM pages')) return { rows: [{ total: fixture.eligiblePages ?? 0 }] }
    throw new Error(`Unexpected metrics query: ${sql}`)
  })
  return knex
}

const makeResponse = () => ({
  contentType: vi.fn(),
  send: vi.fn(),
  status: vi.fn(() => ({ end: vi.fn() }))
})

describe('core/metrics', () => {
  let previousWiki

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    register.clear()
    previousWiki = global.WIKI
    global.WIKI = {
      INSTANCE_ID: 'test-instance',
      config: {
        metrics: {
          isEnabled: true
        }
      },
      logger: {
        info: vi.fn()
      },
      models: {
        groups: makeCountModel(2),
        pages: makeCountModel(5),
        tags: makeCountModel(3),
        users: makeCountModel(7)
      },
      readiness: {
        fail: vi.fn(),
        set: vi.fn()
      }
    }
  })

  afterEach(() => {
    register.clear()
    global.WIKI = previousWiki
  })

  it('collects and renders wiki metrics when enabled', async () => {
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    expect(res.contentType).toHaveBeenCalledWith('text/plain; version=0.0.4; charset=utf-8')
    const samples = scrapeSamples(res.send.mock.calls[0][0])
    const processStart = samplesFor(samples, 'process_start_time_seconds')
    expect(processStart).toEqual([{
      name: 'process_start_time_seconds',
      labels: { WIKI_INSTANCE: 'test-instance' },
      value: expect.any(Number)
    }])
    expect(processStart[0].value).toBeGreaterThan(0)
    expect(processStart[0].value).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000))
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
    expectSample(samples, 'wiki_groups_total', 2)
    expectSample(samples, 'wiki_pages_total', 5)
    expectSample(samples, 'wiki_tags_total', 3)
    expectSample(samples, 'wiki_users_total', 7)
  })

  it('exports fixed label domains and healthy, stale, failed, and maintenance values', async () => {
    global.WIKI.models.knex = makeKnex({
      effects: [
        { effect: 'render', status: 'succeeded', total: '8' },
        { effect: 'links', status: 'failed', total: '2' },
        { effect: 'search', status: 'pending', total: '4' },
        { effect: 'knowledge', status: 'retry', total: '3' },
        { effect: 'unsupported', status: 'failed', total: '999' }
      ],
      ages: [
        { status: 'pending', ageSeconds: '125.5' },
        { status: 'retry', ageSeconds: '45' }
      ],
      expiredLeases: '2',
      eligiblePages: '10',
      indexedVectors: '11',
      revisionMismatches: '3',
      vectorOrphans: '1',
      knowledgeGaps: '4',
      maintenanceStatuses: [{ status: 'running', total: '1' }],
      maintenanceProgress: [{ epochId: '2', highWaterPageId: '10', cursorPageId: '5', scanned: '5', repaired: '1', requeued: '0' }],
      knowledgeStates: [{ state: 'valid', enrichment: 'pending', total: '2' }]
    })
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    const samples = scrapeSamples(res.send.mock.calls[0][0])
    const effectSamples = samplesFor(samples, 'wiki_page_mutation_effects')
    expect(effectSamples).toHaveLength(20)
    expect(samplesFor(samples, 'wiki_page_mutation_oldest_eligible_age_seconds')).toHaveLength(2)
    expect(samplesFor(samples, 'wiki_page_search_documents')).toHaveLength(2)
    expect(samplesFor(samples, 'wiki_page_search_vector_anomalies')).toHaveLength(2)
    expectSample(samples, 'wiki_page_mutation_effects', 8, { effect: 'render', status: 'succeeded' })
    expectSample(samples, 'wiki_page_mutation_effects', 2, { effect: 'links', status: 'failed' })
    expectSample(samples, 'wiki_page_mutation_effects', 4, { effect: 'search', status: 'pending' })
    expectSample(samples, 'wiki_page_mutation_effects', 3, { effect: 'knowledge', status: 'retry' })
    expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'render', status: 'pending' })
    expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'links', status: 'retry' })
    expectSample(samples, 'wiki_page_knowledge_projection_states', 2, { state: 'valid', enrichment: 'pending' })
    expectSample(samples, 'wiki_page_knowledge_maintenance', 1, { status: 'running' })
    expectSample(samples, 'wiki_page_knowledge_maintenance_progress', 5, { kind: 'cursor' })
    expectSample(samples, 'wiki_page_knowledge_maintenance_readiness', 1, { state: 'running' })
    expect(samples.some(sample => Object.values(sample.labels).includes('unsupported'))).toBe(false)
    expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 125.5, { status: 'pending' })
    expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 45, { status: 'retry' })
    expectSample(samples, 'wiki_page_mutation_expired_running_leases', 2)
    expectSample(samples, 'wiki_page_search_documents', 10, { kind: 'eligible_pages' })
    expectSample(samples, 'wiki_page_search_documents', 11, { kind: 'indexed_vectors' })
    expectSample(samples, 'wiki_page_search_vector_anomalies', 3, { kind: 'revision_mismatch' })
    expectSample(samples, 'wiki_page_search_vector_anomalies', 1, { kind: 'orphan' })
    expectSample(samples, 'wiki_page_knowledge_projection_gaps', 4)
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
  })

  it('keeps available aggregates and exports safe zeroes while metric tables are absent', async () => {
    global.WIKI.models.knex = makeKnex({ missingTables: true, eligiblePages: '6' })
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    const samples = scrapeSamples(res.send.mock.calls[0][0])
    expect(res.status).not.toHaveBeenCalled()
    expect(samplesFor(samples, 'wiki_page_mutation_effects')).toHaveLength(20)
    expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'render', status: 'pending' })
    expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'retry' })
    expectSample(samples, 'wiki_page_mutation_expired_running_leases', 0)
    expectSample(samples, 'wiki_page_search_documents', 6, { kind: 'eligible_pages' })
    expectSample(samples, 'wiki_page_search_documents', 0, { kind: 'indexed_vectors' })
    expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'revision_mismatch' })
    expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'orphan' })
    expectSample(samples, 'wiki_page_knowledge_projection_gaps', 0)
    expectSample(samples, 'wiki_page_knowledge_projection_states', 0, { state: 'missing', enrichment: 'unavailable' })
    expectSample(samples, 'wiki_page_knowledge_maintenance', 0, { status: 'pending' })
    expectSample(samples, 'wiki_page_knowledge_maintenance_progress', 0, { kind: 'cursor' })
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
  })

  it('clears collectors when disabled', async () => {
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)

    await metrics.init()

    const enabledResponse = makeResponse()
    await metrics.render(enabledResponse)
    const enabledSamples = scrapeSamples(enabledResponse.send.mock.calls[0][0])
    expectSample(enabledSamples, 'wiki_pages_total', 5)
    expect(samplesFor(enabledSamples, 'process_start_time_seconds')).toEqual([{
      name: 'process_start_time_seconds',
      labels: { WIKI_INSTANCE: 'test-instance' },
      value: expect.any(Number)
    }])

    global.WIKI.config.metrics.isEnabled = false
    await metrics.init()
    const disabledResponse = makeResponse()
    await metrics.render(disabledResponse)
    expect(disabledResponse.status).not.toHaveBeenCalled()
    const disabledSamples = scrapeSamples(disabledResponse.send.mock.calls[0][0])
    expect(samplesFor(disabledSamples, 'wiki_pages_total')).toEqual([])
    expect(samplesFor(disabledSamples, 'process_start_time_seconds')).toEqual([])
  })
})

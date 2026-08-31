vi.mockModule('prom-client', import.meta.url, () => {
  const gauges = []
  const register = {
    contentType: 'text/plain',
    setDefaultLabels: vi.fn(),
    clear: vi.fn(() => {
      gauges.length = 0
    }),
    metrics: vi.fn(async () => {
      const values = []
      for (const gauge of gauges) {
        await gauge.collect.call({
          reset: vi.fn(),
          set: (...args) => {
            const labels = args.length === 2 ? args[0] : undefined
            const value = args.length === 2 ? args[1] : args[0]
            const suffix = labels
              ? `{${gauge.labelNames.map(name => `${name}="${labels[name]}"`).join(',')}}`
              : ''
            values.push(`${gauge.name}${suffix} ${value}`)
          }
        })
      }
      return values.join('\n')
    })
  }

  class Gauge {
    constructor (opts) {
      this.name = opts.name
      this.labelNames = opts.labelNames ?? []
      this.collect = opts.collect
      gauges.push(this)
    }
  }

  return {
    collectDefaultMetrics: vi.fn(),
    register,
    Gauge
  }
})

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
    if (sql.includes('MIN("availableAt")')) return { rows: fixture.ages ?? [] }
    if (sql.includes("status = 'running'")) return { rows: [{ total: fixture.expiredLeases ?? 0 }] }
    if (sql.includes('LEFT JOIN "pageKnowledgeProjections"')) return { rows: [{ total: fixture.knowledgeGaps ?? 0 }] }
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
    global.WIKI = previousWiki
  })

  it('collects and renders wiki metrics when enabled', async () => {
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const promClient = await import('prom-client')
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    expect(promClient.collectDefaultMetrics).toHaveBeenCalled()
    expect(promClient.register.setDefaultLabels).toHaveBeenCalledWith({
      WIKI_INSTANCE: 'test-instance'
    })
    expect(res.contentType).toHaveBeenCalledWith('text/plain')
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_groups_total 2'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_pages_total 5'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_tags_total 3'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_users_total 7'))
  })

  it('exports fixed label domains and healthy, stale, and failed aggregate values', async () => {
    global.WIKI.models.knex = makeKnex({
      effects: [
        { effect: 'render', status: 'succeeded', total: '8' },
        { effect: 'links', status: 'failed', total: '2' },
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
      knowledgeGaps: '4'
    })
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    const output = res.send.mock.calls[0][0]
    const effectLines = output.split('\n').filter(line => line.startsWith('wiki_page_mutation_effects{'))
    expect(effectLines).toHaveLength(15)
    expect(output.split('\n').filter(line => line.startsWith('wiki_page_mutation_oldest_eligible_age_seconds{'))).toHaveLength(2)
    expect(output.split('\n').filter(line => line.startsWith('wiki_page_search_documents{'))).toHaveLength(2)
    expect(output.split('\n').filter(line => line.startsWith('wiki_page_search_vector_anomalies{'))).toHaveLength(2)
    expect(effectLines).toContain('wiki_page_mutation_effects{effect="render",status="succeeded"} 8')
    expect(effectLines).toContain('wiki_page_mutation_effects{effect="links",status="failed"} 2')
    expect(effectLines).toContain('wiki_page_mutation_effects{effect="knowledge",status="retry"} 3')
    expect(effectLines).toContain('wiki_page_mutation_effects{effect="render",status="pending"} 0')
    expect(output).not.toContain('unsupported')
    expect(output).toContain('wiki_page_mutation_oldest_eligible_age_seconds{status="pending"} 125.5')
    expect(output).toContain('wiki_page_mutation_oldest_eligible_age_seconds{status="retry"} 45')
    expect(output).toContain('wiki_page_mutation_expired_running_leases 2')
    expect(output).toContain('wiki_page_search_documents{kind="eligible_pages"} 10')
    expect(output).toContain('wiki_page_search_documents{kind="indexed_vectors"} 11')
    expect(output).toContain('wiki_page_search_vector_anomalies{kind="revision_mismatch"} 3')
    expect(output).toContain('wiki_page_search_vector_anomalies{kind="orphan"} 1')
    expect(output).toContain('wiki_page_knowledge_projection_gaps 4')
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
  })

  it('keeps available aggregates and exports safe zeroes while metric tables are absent', async () => {
    global.WIKI.models.knex = makeKnex({ missingTables: true, eligiblePages: '6' })
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const res = makeResponse()

    await metrics.init()
    await metrics.render(res)

    const output = res.send.mock.calls[0][0]
    expect(res.status).not.toHaveBeenCalled()
    expect(output.split('\n').filter(line => line.startsWith('wiki_page_mutation_effects{'))).toHaveLength(15)
    expect(output).toContain('wiki_page_mutation_effects{effect="render",status="pending"} 0')
    expect(output).toContain('wiki_page_mutation_oldest_eligible_age_seconds{status="retry"} 0')
    expect(output).toContain('wiki_page_mutation_expired_running_leases 0')
    expect(output).toContain('wiki_page_search_documents{kind="eligible_pages"} 6')
    expect(output).toContain('wiki_page_search_documents{kind="indexed_vectors"} 0')
    expect(output).toContain('wiki_page_search_vector_anomalies{kind="revision_mismatch"} 0')
    expect(output).toContain('wiki_page_search_vector_anomalies{kind="orphan"} 0')
    expect(output).toContain('wiki_page_knowledge_projection_gaps 0')
    expect(global.WIKI.readiness.fail).not.toHaveBeenCalled()
    expect(global.WIKI.readiness.set).not.toHaveBeenCalled()
  })

  it('clears collectors when disabled', async () => {
    global.WIKI.config.metrics.isEnabled = false
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    const promClient = await import('prom-client')

    await metrics.init()

    expect(promClient.register.clear).toHaveBeenCalled()
  })
})

import createKnex from 'knex'
import { afterAll, beforeAll } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { claimPageMutationEffects, enqueuePageMutationEffects, supersedeStalePageRenderEffects } from '../../core/page-mutation-outbox.ts'
import { register } from 'prom-client'

const connection = getPostgresTestConnection('_metrics_test', import.meta.path)

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
        { effect: 'render', status: 'superseded', total: '1' },
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
    expect(effectSamples).toHaveLength(24)
    expect(samplesFor(samples, 'wiki_page_mutation_oldest_eligible_age_seconds')).toHaveLength(2)
    expect(samplesFor(samples, 'wiki_page_search_documents')).toHaveLength(2)
    expect(samplesFor(samples, 'wiki_page_search_vector_anomalies')).toHaveLength(2)
    expectSample(samples, 'wiki_page_mutation_effects', 8, { effect: 'render', status: 'succeeded' })
    expectSample(samples, 'wiki_page_mutation_effects', 1, { effect: 'render', status: 'superseded' })
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
    expect(samplesFor(samples, 'wiki_page_mutation_effects')).toHaveLength(24)
    expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'render', status: 'pending' })
    expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'render', status: 'superseded' })
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

  const postgresSuite = connection ? describe : describe.skip
  postgresSuite('native PostgreSQL lifecycle metrics', () => {
    let db

    beforeAll(async () => {
      db = createKnex({ client: 'pg', connection })
      await db.raw(`
        CREATE TABLE pages (
          id integer PRIMARY KEY,
          "sourceRevision" bigint NOT NULL,
          "renderedSourceRevision" bigint,
          visibility text NOT NULL DEFAULT 'public',
          "isPublished" boolean NOT NULL DEFAULT true,
          "isSearchable" boolean NOT NULL DEFAULT true,
          "publishStartDate" varchar(255),
          "publishEndDate" varchar(255),
          content text NOT NULL DEFAULT '',
          render text NOT NULL DEFAULT '',
          "localeCode" text NOT NULL DEFAULT 'en',
          path text NOT NULL DEFAULT 'docs/metrics',
          "ownerId" integer
        );
        CREATE TABLE "pagesVector" (
          "pageId" integer PRIMARY KEY,
          "sourceRevision" bigint NOT NULL
        );
        CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY);
        CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL);
        CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
        CREATE TABLE "pageMutationOutbox" (
          id uuid PRIMARY KEY,
          "pageId" integer NOT NULL,
          "sourceRevision" bigint NOT NULL,
          "effectKind" text NOT NULL,
          "effectKey" text NOT NULL,
          "desiredState" text NOT NULL,
          "payloadSha256" text NOT NULL,
          payload text NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          attempts integer NOT NULL DEFAULT 0,
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
      `)
    })

    afterAll(async () => {
      await db?.destroy()
    })

    beforeEach(async () => {
      await db.raw('TRUNCATE "pageMutationOutbox", "pagesVector", "pageTags", tags, "pageAccessPasswords", pages')
      global.WIKI.models.knex = db
    })

    const scrape = async () => {
      const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
      const res = makeResponse()
      await metrics.init()
      await metrics.render(res)
      expect(res.status).not.toHaveBeenCalled()
      return scrapeSamples(res.send.mock.calls[0][0])
    }

    const enqueuePresent = (pageId, sourceRevision, effects) => enqueuePageMutationEffects(db, {
      pageId,
      sourceRevision,
      desiredState: 'present',
      action: 'update',
      source: 'Metrics source that must never become a label',
      location: { locale: 'en', path: 'docs/private-metrics-fixture', visibility: 'public', ownerId: null },
      effects
    })

    it('counts opted-out vectors as orphaned even when their source revision matches', async () => {
      await db('pages').insert({ id: 1, sourceRevision: 8, isSearchable: false })
      await db('pagesVector').insert({ pageId: 1, sourceRevision: 8 })
      let samples = await scrape()
      expectSample(samples, 'wiki_page_search_documents', 0, { kind: 'eligible_pages' })
      expectSample(samples, 'wiki_page_search_documents', 1, { kind: 'indexed_vectors' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'revision_mismatch' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 1, { kind: 'orphan' })

      await db('pagesVector').where({ pageId: 1 }).update({ sourceRevision: 7 })
      samples = await scrape()
      expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'revision_mismatch' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 1, { kind: 'orphan' })

      await db('pages').where({ id: 1 }).update({ isSearchable: true })
      samples = await scrape()
      expectSample(samples, 'wiki_page_search_documents', 1, { kind: 'eligible_pages' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 1, { kind: 'revision_mismatch' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'orphan' })
    })

    it('counts scheduled and expired vectors as orphaned and accepts empty and offset windows', async () => {
      await db('pages').insert([
        { id: 1, sourceRevision: 8, publishStartDate: '2999-01-01T00:00:00.000Z' },
        { id: 2, sourceRevision: 8, publishEndDate: '2000-01-01T00:00:00.000Z' },
        { id: 3, sourceRevision: 8, publishStartDate: '', publishEndDate: '' },
        {
          id: 4, sourceRevision: 8,
          publishStartDate: '2000-01-01T10:00:00.000+10:00',
          publishEndDate: '2998-12-31T14:00:00.000-10:00'
        }
      ])
      await db('pagesVector').insert([1, 2, 3, 4].map(pageId => ({ pageId, sourceRevision: 7 })))
      let samples = await scrape()
      expectSample(samples, 'wiki_page_search_documents', 2, { kind: 'eligible_pages' })
      expectSample(samples, 'wiki_page_search_documents', 4, { kind: 'indexed_vectors' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 2, { kind: 'revision_mismatch' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 2, { kind: 'orphan' })

      await db('pages').where({ id: 1 }).update({ publishStartDate: '' })
      await db('pages').where({ id: 2 }).update({ publishEndDate: '' })
      samples = await scrape()
      expectSample(samples, 'wiki_page_search_documents', 4, { kind: 'eligible_pages' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 4, { kind: 'revision_mismatch' })
      expectSample(samples, 'wiki_page_search_vector_anomalies', 0, { kind: 'orphan' })
    })

    it('keeps a currently active offset window behind its render dependency', async () => {
      const now = Date.now()
      await db('pages').insert({
        id: 1, sourceRevision: 8,
        publishStartDate: new Date(now + 9 * 3_600_000).toISOString().replace('Z', '+10:00'),
        publishEndDate: new Date(now - 9 * 3_600_000).toISOString().replace('Z', '-10:00')
      })
      await enqueuePresent(1, '8', ['render', 'search'])
      await db('pageMutationOutbox').where({ effectKind: 'render' }).update({
        status: 'failed', availableAt: new Date(now + 3_600_000).toISOString()
      })
      await db('pageMutationOutbox').where({ effectKind: 'search' }).update({
        availableAt: new Date(now - 3_600_000).toISOString()
      })
      const samples = await scrape()
      expectSample(samples, 'wiki_page_search_documents', 1, { kind: 'eligible_pages' })
      expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'pending' })
      expect(await claimPageMutationEffects(db, { leaseOwner: 'metrics-offset-window', effects: ['search'] })).toEqual([])
    })

    it('ages current links and body-search only after exact render certification and success', async () => {
      await db('pages').insert({ id: 1, sourceRevision: 8, renderedSourceRevision: 8 })
      await enqueuePresent(1, '8', ['render', 'links', 'search'])
      await db('pageMutationOutbox').whereIn('effectKind', ['links', 'search']).update({
        availableAt: new Date(Date.now() - 3_600_000).toISOString()
      })
      // Only dependents contribute age, even when render work is pending/retry.
      await db('pageMutationOutbox').where({ effectKind: 'render' }).update({
        availableAt: new Date(Date.now() + 3_600_000).toISOString()
      })

      for (const status of ['failed', 'running', 'retry', 'pending']) {
        await db('pageMutationOutbox').where({ effectKind: 'render' }).update({ status })
        const samples = await scrape()
        expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'pending' })
        expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'retry' })
        expect(await claimPageMutationEffects(db, { leaseOwner: 'metrics-blocked', effects: ['links', 'search'] })).toEqual([])
      }
      await db('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
      await db('pages').where({ id: 1 }).update({ renderedSourceRevision: 7 })
      const uncertified = await scrape()
      expectSample(uncertified, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'pending' })
      expect(await claimPageMutationEffects(db, { leaseOwner: 'metrics-uncertified', effects: ['links', 'search'] })).toEqual([])

      await db('pages').where({ id: 1 }).update({ renderedSourceRevision: 8 })
      let samples = await scrape()
      const age = samplesFor(samples, 'wiki_page_mutation_oldest_eligible_age_seconds').find(sample => sample.labels.status === 'pending')
      expect(age.value).toBeGreaterThanOrEqual(3_599)
      const claims = await claimPageMutationEffects(db, { leaseOwner: 'metrics-certified', effects: ['links', 'search'] })
      expect(claims.map(claim => claim.payload.effectKind).sort()).toEqual(['links', 'search'])
      await db('pageMutationOutbox').whereIn('effectKind', ['links', 'search']).update({
        status: 'pending', leaseOwner: null, leaseToken: null, leaseExpiresAt: null
      })
      await db('pageMutationOutbox').where({ effectKind: 'render' }).delete()
      samples = await scrape()
      expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: 'pending' })
      expect(await claimPageMutationEffects(db, { leaseOwner: 'metrics-missing-render', effects: ['links', 'search'] })).toEqual([])
    })

    it.each([
      ['stale revision', { sourceRevision: 9 }, 'present', 'pending'],
      ['missing page', null, 'present', 'retry'],
      ['absent intent', { sourceRevision: 8 }, 'absent', 'pending'],
      ['opted-out page', { sourceRevision: 8, isSearchable: false }, 'present', 'retry'],
      ['private page', { sourceRevision: 8, visibility: 'private' }, 'present', 'pending'],
      ['unpublished page', { sourceRevision: 8, isPublished: false }, 'present', 'retry'],
      ['future publication', { sourceRevision: 8, publishStartDate: '2999-01-01T00:00:00.000Z' }, 'present', 'pending'],
      ['expired publication', { sourceRevision: 8, publishEndDate: '2000-01-01T00:00:00.000Z' }, 'present', 'retry'],
      ['protected metadata', { sourceRevision: 8 }, 'protected', 'pending']
    ])('keeps %s search cleanup eligible despite failed render', async (_name, page, desiredState, status) => {
      if (page) await db('pages').insert({ id: 1, ...page })
      if (desiredState === 'protected') await db('pageAccessPasswords').insert({ pageId: 1 })
      if (desiredState === 'absent') {
        await enqueuePageMutationEffects(db, { pageId: 1, sourceRevision: '8', desiredState: 'absent', action: 'delete', effects: ['search', 'render'] })
      } else {
        await enqueuePresent(1, '8', ['search', 'render'])
      }
      await db('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'failed' })
      await db('pageMutationOutbox').where({ effectKind: 'search' }).update({
        status, availableAt: new Date(Date.now() - 3_600_000).toISOString()
      })
      const samples = await scrape()
      const age = samplesFor(samples, 'wiki_page_mutation_oldest_eligible_age_seconds').find(sample => sample.labels.status === status)
      expect(age.value).toBeGreaterThanOrEqual(3_599)
      expectSample(samples, 'wiki_page_mutation_oldest_eligible_age_seconds', 0, { status: status === 'pending' ? 'retry' : 'pending' })
      const claims = await claimPageMutationEffects(db, { leaseOwner: 'metrics-cleanup', effects: ['search'] })
      expect(claims).toHaveLength(1)
      expect(claims[0].payload).toMatchObject({ effectKind: 'search', pageId: 1, sourceRevision: '8' })
    })

    it('exports a retained superseded render receipt without exposing source or identity labels', async () => {
      await db('pages').insert({ id: 1, sourceRevision: 9 })
      const [olderId] = await enqueuePresent(1, '8', ['render'])
      await enqueuePresent(1, '9', ['render'])
      const original = await db('pageMutationOutbox').where({ id: olderId }).first()
      await db.transaction(transaction => supersedeStalePageRenderEffects(transaction, { pageId: 1, sourceRevision: '9' }))
      const receipt = await db('pageMutationOutbox').where({ id: olderId }).first()
      expect(receipt).toMatchObject({
        status: 'superseded',
        payload: original.payload,
        payloadSha256: original.payloadSha256,
        sourceRevision: original.sourceRevision
      })

      const samples = await scrape()
      const effects = samplesFor(samples, 'wiki_page_mutation_effects')
      expect(effects).toHaveLength(24)
      expectSample(samples, 'wiki_page_mutation_effects', 1, { effect: 'render', status: 'superseded' })
      expectSample(samples, 'wiki_page_mutation_effects', 0, { effect: 'render', status: 'succeeded' })
      expectSample(samples, 'wiki_page_mutation_effects', 1, { effect: 'render', status: 'pending' })
      for (const sample of effects) expect(Object.keys(sample.labels).sort()).toEqual(['WIKI_INSTANCE', 'effect', 'status'])
      expect(samples.some(sample => Object.values(sample.labels).some(value =>
        value.includes('private-metrics-fixture') || value.includes('Metrics source') || value === olderId
      ))).toBe(false)
    })
  })
})

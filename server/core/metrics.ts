import _ from 'lodash'
import { collectDefaultMetrics, Gauge, register } from 'prom-client'
import type { Response } from 'express'
import type { Knex } from 'knex'

interface Query {
  count(expression: string): Query
  first(): Promise<{ total: unknown }>
}
interface WikiContext {
  INSTANCE_ID: string
  config: { metrics: { isEnabled: boolean } }
  logger: { info(message: string): void }
  models: Record<'groups' | 'pages' | 'tags' | 'users', { query(): Query }> & { knex?: Knex }
}
const wiki = WIKI as unknown as WikiContext

const RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'recovery_required'] as const
const PROPOSAL_STATUSES = ['pending', 'approved', 'denied', 'applying', 'applied', 'expired', 'cancelled', 'failed', 'recovery_required'] as const
const PAGE_EFFECTS = ['render', 'links', 'knowledge'] as const
const PAGE_EFFECT_STATUSES = ['pending', 'retry', 'running', 'succeeded', 'failed'] as const
const ELIGIBLE_EFFECT_STATUSES = ['pending', 'retry'] as const
const SEARCH_DOCUMENT_KINDS = ['eligible_pages', 'indexed_vectors'] as const
const SEARCH_VECTOR_ANOMALIES = ['revision_mismatch', 'orphan'] as const
const numeric = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

const withMissingTableFallback = async <T>(work: () => PromiseLike<T>, fallback: T): Promise<T> => {
  try {
    return await work()
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === '42P01') return fallback
    throw error
  }
}

const rawRows = async <T>(knex: Knex, sql: string): Promise<T[]> => {
  const result = await withMissingTableFallback(() => knex.raw(sql) as unknown as PromiseLike<{ rows?: T[] }>, { rows: [] as T[] })
  return Array.isArray(result.rows) ? result.rows : []
}

const registerAgentMetrics = (knex: Knex, target: Record<string, Gauge<string>>): void => {
  target.agentRuns = new Gauge({
    name: 'wiki_agent_runs',
    help: 'Durable agent runs by bounded lifecycle status',
    labelNames: ['status'],
    async collect() {
      this.reset()
      const rows = await withMissingTableFallback(
        () => knex('agentRuns').select('status').count('* as total').groupBy('status') as unknown as PromiseLike<{ status: string; total: unknown }[]>,
        []
      )
      const totals = new Map(rows.map(row => [row.status, numeric(row.total)]))
      for (const status of RUN_STATUSES) this.set({ status }, totals.get(status) ?? 0)
    }
  })
  target.agentProposals = new Gauge({
    name: 'wiki_agent_proposals',
    help: 'Immutable agent proposals by bounded lifecycle status',
    labelNames: ['status'],
    async collect() {
      this.reset()
      const rows = await withMissingTableFallback(
        () => knex('agentProposals').select('status').count('* as total').groupBy('status') as unknown as PromiseLike<{ status: string; total: unknown }[]>,
        []
      )
      const totals = new Map(rows.map(row => [row.status, numeric(row.total)]))
      for (const status of PROPOSAL_STATUSES) this.set({ status }, totals.get(status) ?? 0)
    }
  })
  target.agentArtifacts = new Gauge({
    name: 'wiki_agent_artifacts_total',
    help: 'Retained agent artifacts without content-derived labels',
    async collect() {
      const row = await withMissingTableFallback(
        () => knex('agentArtifacts').count('* as total').first() as unknown as PromiseLike<{ total?: unknown } | undefined>,
        undefined
      )
      this.set(numeric(row?.total))
    }
  })
  target.agentUsage = new Gauge({
    name: 'wiki_agent_usage_total',
    help: 'Persisted agent token and estimated cost usage',
    labelNames: ['kind'],
    async collect() {
      this.reset()
      const row = await withMissingTableFallback(
        () =>
          knex('agentUsageLedger')
            .sum({
              input_tokens: 'inputTokens',
              output_tokens: 'outputTokens',
              estimated_cost_micros: 'estimatedCostMicros'
            })
            .first() as unknown as PromiseLike<Record<string, unknown> | undefined>,
        undefined
      )
      for (const kind of ['input_tokens', 'output_tokens', 'estimated_cost_micros'] as const) this.set({ kind }, numeric(row?.[kind]))
    }
  })
}

const registerPageProjectionMetrics = (knex: Knex, target: Record<string, Gauge<string>>): void => {
  target.pageMutationEffects = new Gauge({
    name: 'wiki_page_mutation_effects',
    help: 'Durable page-mutation effects by bounded projection kind and lifecycle status',
    labelNames: ['effect', 'status'],
    async collect() {
      this.reset()
      const rows = await rawRows<{ effect: string; status: string; total: unknown }>(
        knex,
        `
        SELECT "effectKind" AS effect, status, COUNT(*) AS total
        FROM "pageMutationOutbox"
        WHERE "effectKind" IN ('render', 'links', 'knowledge')
          AND status IN ('pending', 'retry', 'running', 'succeeded', 'failed')
        GROUP BY "effectKind", status
      `
      )
      const totals = new Map(rows.map(row => [`${row.effect}:${row.status}`, numeric(row.total)]))
      for (const effect of PAGE_EFFECTS) {
        for (const status of PAGE_EFFECT_STATUSES) this.set({ effect, status }, totals.get(`${effect}:${status}`) ?? 0)
      }
    }
  })
  target.pageMutationOldestEligibleAge = new Gauge({
    name: 'wiki_page_mutation_oldest_eligible_age_seconds',
    help: 'Age in seconds of the oldest currently eligible pending or retry page-mutation effect',
    labelNames: ['status'],
    async collect() {
      this.reset()
      const rows = await rawRows<{ status: string; ageSeconds: unknown }>(
        knex,
        `
        SELECT
          status,
          GREATEST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("availableAt"))), 0) AS "ageSeconds"
        FROM "pageMutationOutbox"
        WHERE status IN ('pending', 'retry')
          AND "availableAt" <= CURRENT_TIMESTAMP
          AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= CURRENT_TIMESTAMP)
        GROUP BY status
      `
      )
      const ages = new Map(rows.map(row => [row.status, numeric(row.ageSeconds)]))
      for (const status of ELIGIBLE_EFFECT_STATUSES) this.set({ status }, ages.get(status) ?? 0)
    }
  })
  target.pageMutationExpiredRunningLeases = new Gauge({
    name: 'wiki_page_mutation_expired_running_leases',
    help: 'Running page-mutation effects whose lease has expired',
    async collect() {
      const rows = await rawRows<{ total: unknown }>(
        knex,
        `
        SELECT COUNT(*) AS total
        FROM "pageMutationOutbox"
        WHERE status = 'running'
          AND "leaseExpiresAt" <= CURRENT_TIMESTAMP
      `
      )
      this.set(numeric(rows[0]?.total))
    }
  })
  target.pageSearchDocuments = new Gauge({
    name: 'wiki_page_search_documents',
    help: 'Authoritative published-public pages and derived search vectors',
    labelNames: ['kind'],
    async collect() {
      this.reset()
      const eligible = await rawRows<{ total: unknown }>(
        knex,
        `
        SELECT COUNT(*) AS total
        FROM pages
        WHERE visibility = 'public'
          AND "isPublished" = true
      `
      )
      const indexed = await rawRows<{ total: unknown }>(
        knex,
        `
        SELECT COUNT(*) AS total
        FROM "pagesVector"
      `
      )
      const totals: Record<(typeof SEARCH_DOCUMENT_KINDS)[number], number> = {
        eligible_pages: numeric(eligible[0]?.total),
        indexed_vectors: numeric(indexed[0]?.total)
      }
      for (const kind of SEARCH_DOCUMENT_KINDS) this.set({ kind }, totals[kind])
    }
  })
  target.pageSearchVectorAnomalies = new Gauge({
    name: 'wiki_page_search_vector_anomalies',
    help: 'Derived search vectors that mismatch an eligible source revision or have no eligible authoritative page',
    labelNames: ['kind'],
    async collect() {
      this.reset()
      const rows = await rawRows<{ revisionMismatch: unknown; orphan: unknown }>(
        knex,
        `
        SELECT
          COUNT(*) FILTER (
            WHERE page.id IS NOT NULL
              AND page.visibility = 'public'
              AND page."isPublished" = true
              AND vector."sourceRevision" IS DISTINCT FROM page."sourceRevision"
          ) AS "revisionMismatch",
          COUNT(*) FILTER (
            WHERE page.id IS NULL
              OR page.visibility IS DISTINCT FROM 'public'
              OR page."isPublished" IS DISTINCT FROM true
          ) AS orphan
        FROM "pagesVector" vector
        LEFT JOIN pages page ON page.id = vector."pageId"
      `
      )
      const values: Record<(typeof SEARCH_VECTOR_ANOMALIES)[number], number> = {
        revision_mismatch: numeric(rows[0]?.revisionMismatch),
        orphan: numeric(rows[0]?.orphan)
      }
      for (const kind of SEARCH_VECTOR_ANOMALIES) this.set({ kind }, values[kind])
    }
  })
  target.pageKnowledgeProjectionGaps = new Gauge({
    name: 'wiki_page_knowledge_projection_gaps',
    help: 'Authoritative pages without a knowledge projection for their current source revision',
    async collect() {
      const rows = await rawRows<{ total: unknown }>(
        knex,
        `
        SELECT COUNT(*) AS total
        FROM pages page
        LEFT JOIN "pageKnowledgeProjections" projection
          ON projection."pageId" = page.id
          AND projection."sourceRevision" = page."sourceRevision"
        WHERE projection.id IS NULL
      `
      )
      this.set(numeric(rows[0]?.total))
    }
  })
}

const metrics = {
  customMetrics: {} as Record<string, Gauge<string>>,
  async init() {
    if (wiki.config.metrics.isEnabled) {
      wiki.logger.info('Initializing metrics...')
      register.clear()
      register.setDefaultLabels({ WIKI_INSTANCE: wiki.INSTANCE_ID })
      collectDefaultMetrics({ register })
      for (const name of ['groups', 'pages', 'tags', 'users'] as const) {
        this.customMetrics[`${name}Total`] = new Gauge({
          name: `wiki_${name}_total`,
          help: `Total number of ${name}`,
          async collect() {
            const total = await wiki.models[name].query().count('* as total').first()
            this.set(_.toSafeInteger(total.total))
          }
        })
      }
      if (wiki.models.knex) {
        registerAgentMetrics(wiki.models.knex, this.customMetrics)
        registerPageProjectionMetrics(wiki.models.knex, this.customMetrics)
      }
      wiki.logger.info('Metrics ready [ OK ]')
    } else {
      this.customMetrics = {}
      register.clear()
    }
    return this
  },
  async render(res: Response) {
    try {
      res.contentType(register.contentType)
      res.send(await register.metrics())
    } catch (error) {
      res.status(500).end(error instanceof Error ? error.message : String(error))
    }
  }
}

export default metrics

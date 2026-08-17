import _ from 'lodash'
import { collectDefaultMetrics, Gauge, register } from 'prom-client'
import type { Response } from 'express'
import type { Knex } from 'knex'

interface Query { count(expression: string): Query; first(): Promise<{ total: unknown }> }
interface WikiContext {
  INSTANCE_ID: string
  config: { metrics: { isEnabled: boolean } }
  logger: { info(message: string): void }
  models: Record<'groups' | 'pages' | 'tags' | 'users', { query(): Query }> & { knex?: Knex }
}
const wiki = WIKI as unknown as WikiContext

const RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'recovery_required'] as const
const PROPOSAL_STATUSES = ['pending', 'approved', 'denied', 'applying', 'applied', 'expired', 'cancelled', 'failed', 'recovery_required'] as const

const numeric = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

const registerAgentMetrics = (knex: Knex, target: Record<string, Gauge<string>>): void => {
  target.agentRuns = new Gauge({
    name: 'wiki_agent_runs',
    help: 'Durable agent runs by bounded lifecycle status',
    labelNames: ['status'],
    async collect() {
      this.reset()
      const rows = await knex('agentRuns').select('status').count('* as total').groupBy('status') as { status: string; total: unknown }[]
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
      const rows = await knex('agentProposals').select('status').count('* as total').groupBy('status') as { status: string; total: unknown }[]
      const totals = new Map(rows.map(row => [row.status, numeric(row.total)]))
      for (const status of PROPOSAL_STATUSES) this.set({ status }, totals.get(status) ?? 0)
    }
  })
  target.agentArtifacts = new Gauge({
    name: 'wiki_agent_artifacts_total',
    help: 'Retained agent artifacts without content-derived labels',
    async collect() {
      const row = await knex('agentArtifacts').count('* as total').first() as { total?: unknown } | undefined
      this.set(numeric(row?.total))
    }
  })
  target.agentUsage = new Gauge({
    name: 'wiki_agent_usage_total',
    help: 'Persisted agent token and estimated cost usage',
    labelNames: ['kind'],
    async collect() {
      this.reset()
      const row = await knex('agentUsageLedger').sum({
        input_tokens: 'inputTokens',
        output_tokens: 'outputTokens',
        estimated_cost_micros: 'estimatedCostMicros'
      }).first() as Record<string, unknown> | undefined
      for (const kind of ['input_tokens', 'output_tokens', 'estimated_cost_micros'] as const) this.set({ kind }, numeric(row?.[kind]))
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
      if (wiki.models.knex) registerAgentMetrics(wiki.models.knex, this.customMetrics)
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

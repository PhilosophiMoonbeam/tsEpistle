import type { Knex } from 'knex'
import { DurableJobStore, runDurableJobBatch } from '../core/durable-jobs.ts'
import { durableJobHandlers } from './durable-job-handlers.ts'

interface WikiContext {
  INSTANCE_ID: string
  models: { knex: Knex }
}

const wiki = WIKI as unknown as WikiContext

export default async function runDurableJobs (): Promise<void> {
  const store = new DurableJobStore(wiki.models.knex)
  const day = new Date().toISOString().slice(0, 10)
  await store.enqueue({
    type: 'cleanup-durable-jobs',
    version: 1,
    payload: {},
    maxAttempts: 3,
    deduplicationKey: `cleanup-durable-jobs:${day}`
  })
  await runDurableJobBatch(wiki.models.knex, {
    workerId: wiki.INSTANCE_ID,
    limit: 10,
    leaseMs: 30_000,
    handlers: durableJobHandlers
  })
}

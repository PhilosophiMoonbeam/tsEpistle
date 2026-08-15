import { type DurableJobHandler } from '../core/durable-jobs.ts'

const cleanupRetentionMs = 30 * 24 * 60 * 60 * 1_000

export const cleanupDurableJobs: DurableJobHandler = async (_job, { knex }) => {
  const before = new Date(Date.now() - cleanupRetentionMs)
  await knex('durableJobs')
    .whereIn('state', ['succeeded', 'failed', 'cancelled'])
    .where('completedAt', '<', before)
    .delete()
}

export const durableJobHandlers = Object.freeze({
  'cleanup-durable-jobs@1': cleanupDurableJobs
})

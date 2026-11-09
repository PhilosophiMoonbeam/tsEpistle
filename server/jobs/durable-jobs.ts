import type { Knex } from 'knex'
import { DurableJobStore, runDurableJobBatch } from '../core/durable-jobs.ts'
import type { ContentExtensionRerenderContext } from '../content-extensions/rerender.ts'
import { publishOutboxEvents } from '../core/outbox.ts'
import { createDurableJobHandlers } from './durable-job-handlers.ts'
import { failExhaustedSiteLogoJobs } from './site-logo-process.ts'
import { failExhaustedAssetRelocationEffects } from './asset-relocation.ts'
import type { PageWatchWikiContext } from './page-watch-notification.ts'
import { scanPageReviewReminders } from './page-review-reminders.ts'
import { scanPageLifecycleRules } from './page-lifecycle.ts'
import { recoverGovernedNotificationHandoffs } from './governed-notifications.ts'
import { recoverPageReviewHandoffs } from './page-review-reminders.ts'

type WikiContext = PageWatchWikiContext &
  ContentExtensionRerenderContext & {
    config: PageWatchWikiContext['config'] & { sessionSecret: string }
    INSTANCE_ID: string
    models: PageWatchWikiContext['models'] & ContentExtensionRerenderContext['models'] & { knex: Knex }
  }

const wiki = WIKI as unknown as WikiContext
let cleanupEnqueuedDay: string | undefined
let governanceEnqueuedMinute: string | undefined

export default async function runDurableJobs(): Promise<void> {
  let enqueueFailed = false
  let enqueueError: unknown
  try {
    const day = new Date().toISOString().slice(0, 10)
    const minute = new Date().toISOString().slice(0, 16)
    if (governanceEnqueuedMinute !== minute) {
      governanceEnqueuedMinute = minute
      const results = await Promise.allSettled([scanPageReviewReminders(wiki.models.knex), scanPageLifecycleRules(wiki.models.knex)])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Governance producer scan failed')
    }
    if (cleanupEnqueuedDay !== day) {
      const store = new DurableJobStore(wiki.models.knex)
      await store.enqueue({
        type: 'cleanup-durable-jobs',
        version: 1,
        payload: {},
        maxAttempts: 3,
        deduplicationKey: `cleanup-durable-jobs:${day}`
      })
      await store.enqueue({
        type: 'cleanup-site-logo',
        version: 1,
        payload: {},
        maxAttempts: 3,
        deduplicationKey: `cleanup-site-logo:${day}`
      })
      cleanupEnqueuedDay = day
    }
  } catch (error) {
    enqueueFailed = true
    enqueueError = error
  }
  // Claims, publication, and exhausted-job recovery must not wait for daily cleanup scheduling.
  try {
    await publishOutboxEvents(wiki.models.knex)
    const now = new Date()
    await failExhaustedSiteLogoJobs(wiki.models.knex, now)
    await failExhaustedAssetRelocationEffects(wiki.models.knex, now)
    await recoverGovernedNotificationHandoffs(wiki.models.knex)
    await recoverPageReviewHandoffs(wiki.models.knex)
    await runDurableJobBatch(wiki.models.knex, {
      workerId: wiki.INSTANCE_ID,
      limit: 2,
      leaseMs: 30_000,
      now,
      handlers: createDurableJobHandlers(wiki.config.sessionSecret, wiki)
    })
  } catch (error) {
    if (enqueueFailed) throw new AggregateError([enqueueError, error], 'Durable cleanup scheduling and tick processing both failed')
    throw error
  }
  if (enqueueFailed) throw enqueueError
}

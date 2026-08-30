import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { DurableJobStore } from './durable-jobs.ts'

interface OutboxEventRow {
  id: string
  type: string
  version: number
  aggregateType: string
  aggregateId: string
  payload: string
  createdAt: Date | string | number
  publishedAt: Date | string | number | null
}

interface WebhookRow {
  id: string
  events: string
  isEnabled: boolean | number
}

export interface OutboxEventInput {
  type: string
  version: number
  aggregateType: string
  aggregateId: string | number
  payload: Record<string, unknown>
  id?: string
  createdAt?: Date
}

export interface PublishOutboxOptions {
  limit?: number
  now?: Date
}

const validEventType = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/

const eventSubscriptions = (value: string): string[] => {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every(event => typeof event === 'string')) {
    throw new TypeError('Webhook subscriptions are invalid')
  }
  return parsed
}

const eventIsNewer = (candidate: OutboxEventRow, current: Pick<OutboxEventRow, 'id' | 'createdAt'>): boolean => {
  const candidateTime = candidate.createdAt instanceof Date ? candidate.createdAt.getTime() : new Date(candidate.createdAt).getTime()
  const currentTime = current.createdAt instanceof Date ? current.createdAt.getTime() : new Date(current.createdAt).getTime()
  return candidateTime > currentTime || (candidateTime === currentTime && candidate.id > current.id)
}

export const writeOutboxEvent = async (knex: Knex | Knex.Transaction, input: OutboxEventInput): Promise<string> => {
  if (!validEventType.test(input.type)) throw new TypeError(`Invalid outbox event type: ${input.type}`)
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError('Outbox event version must be a positive integer')
  if (!input.aggregateType || !input.aggregateId) throw new TypeError('Outbox event aggregate identity is required')
  const id = input.id ?? randomUUID()
  await knex<OutboxEventRow>('outboxEvents').insert({
    id,
    type: input.type,
    version: input.version,
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    payload: JSON.stringify(input.payload),
    createdAt: input.createdAt ?? new Date(),
    publishedAt: null
  })
  return id
}

export const publishOutboxEvents = async (knex: Knex, options: PublishOutboxOptions = {}): Promise<number> => {
  const limit = options.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Outbox publish limit must be an integer from 1 through 500')
  const now = options.now ?? new Date()
  let published = 0

  while (published < limit) {
    const didPublish = await knex.transaction(async transaction => {
      const eventQuery = transaction<OutboxEventRow>('outboxEvents')
        .whereNull('publishedAt')
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
      if (transaction.client.config.client === 'pg') eventQuery.forUpdate().skipLocked()
      const event = await eventQuery.first()
      if (!event) return false

      const payload: unknown = JSON.parse(event.payload)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError(`Outbox event ${event.id} payload must be an object`)
      }

      const hooks = await transaction<WebhookRow>('webhooks').where('isEnabled', true)
      const durableJobs = new DurableJobStore(transaction)
      for (const hook of hooks) {
        const subscriptions = eventSubscriptions(hook.events)
        if (!subscriptions.includes('*') && !subscriptions.includes(event.type)) continue
        const generatedDeliveryId = randomUUID()
        const job = await durableJobs.enqueue({
          type: 'deliver-webhook',
          version: 1,
          payload: {
            deliveryId: generatedDeliveryId,
            eventId: event.id,
            webhookId: hook.id
          },
          maxAttempts: 8,
          deduplicationKey: `webhook:${hook.id}:${event.id}`
        })
        const deliveryId = String(job.payload.deliveryId)
        await transaction('webhookDeliveries')
          .insert({
            id: deliveryId,
            webhookId: hook.id,
            eventId: event.id,
            jobId: job.id,
            statusCode: null,
            responseSnippet: null,
            createdAt: now,
            deliveredAt: null
          })
          .onConflict(['webhookId', 'eventId'])
          .ignore()
      }

      const pageId = Reflect.get(payload, 'pageId')
      const actorId = Reflect.get(payload, 'actorId')
      if (event.type.startsWith('page.') && typeof pageId === 'number' && Number.isSafeInteger(pageId) && pageId > 0) {
        const actorName = Reflect.get(payload, 'actorName')
        const title = Reflect.get(payload, 'title')
        const path = Reflect.get(payload, 'path')
        const localeCode = Reflect.get(payload, 'localeCode')
        const visibility = Reflect.get(payload, 'visibility')
        const watchers = await transaction<{ userId: number; emailEnabled: boolean | number; inAppEnabled: boolean | number }>('pageWatchers')
          .where('pageId', pageId)
          .select('userId', 'emailEnabled', 'inAppEnabled')
        if (watchers.length > 0 && [actorName, title, path, localeCode, visibility].some(value => typeof value !== 'string')) {
          throw new TypeError(`Page event ${event.id} notification fields are invalid`)
        }
        const isAggregatedUpdate = event.type === 'page.updated'
        const aggregationMs = 2 * 60 * 1_000
        const bucketStart = new Date(Math.floor(now.valueOf() / aggregationMs) * aggregationMs)
        const bucketEnd = new Date(bucketStart.valueOf() + aggregationMs + 5_000)
        for (const watcher of watchers) {
          if (watcher.userId === actorId) continue
          if (!watcher.emailEnabled && !watcher.inAppEnabled) continue
          const generatedDeliveryId = randomUUID()
          const job = await durableJobs.enqueue({
            type: 'notify-page-watcher',
            version: 1,
            payload: {
              deliveryId: generatedDeliveryId,
              eventId: event.id,
              userId: watcher.userId,
              emailEnabled: Boolean(watcher.emailEnabled),
              inAppEnabled: Boolean(watcher.inAppEnabled)
            },
            maxAttempts: 5,
            ...(isAggregatedUpdate ? { nextRunAt: bucketEnd } : {}),
            deduplicationKey: isAggregatedUpdate
              ? `page-watch-update:${watcher.userId}:${pageId}:${bucketStart.toISOString()}`
              : `page-watch:${watcher.userId}:${event.id}`
          })

          let selectedEventId = event.id
          let deliveryId = String(job.payload.deliveryId)
          if (isAggregatedUpdate) {
            const lockedJob = await transaction<{ payload: string; state: string }>('durableJobs')
              .where('id', job.id)
              .forUpdate()
              .first()
            if (!lockedJob) throw new Error(`Durable job ${job.id} disappeared while aggregating page events`)
            const lockedPayload: unknown = JSON.parse(lockedJob.payload)
            if (!lockedPayload || typeof lockedPayload !== 'object' || Array.isArray(lockedPayload)) {
              throw new TypeError(`Durable job ${job.id} payload must be an object`)
            }
            const currentEventId = Reflect.get(lockedPayload, 'eventId')
            const currentDeliveryId = Reflect.get(lockedPayload, 'deliveryId')
            if (typeof currentEventId !== 'string' || typeof currentDeliveryId !== 'string') {
              throw new TypeError(`Durable job ${job.id} page notification payload is invalid`)
            }
            selectedEventId = currentEventId
            deliveryId = currentDeliveryId
            if (currentEventId !== event.id) {
              const currentEvent = await transaction<Pick<OutboxEventRow, 'id' | 'createdAt'>>('outboxEvents')
                .select('id', 'createdAt')
                .where('id', currentEventId)
                .first()
              if (!currentEvent) throw new Error(`Aggregated outbox event ${currentEventId} does not exist`)
              if (lockedJob.state === 'pending' && eventIsNewer(event, currentEvent)) {
                await transaction('durableJobs').where({ id: job.id, state: 'pending' }).update({
                  payload: JSON.stringify({
                    deliveryId,
                    eventId: event.id,
                    userId: watcher.userId,
                    emailEnabled: Boolean(watcher.emailEnabled),
                    inAppEnabled: Boolean(watcher.inAppEnabled)
                  }),
                  updatedAt: now
                })
                selectedEventId = event.id
              }
            }
          }

          await transaction('pageWatchDeliveries')
            .insert({
              id: deliveryId,
              eventId: selectedEventId,
              userId: watcher.userId,
              jobId: job.id,
              createdAt: now,
              deliveredAt: null,
              lastError: null
            })
            .onConflict('id')
            .merge({ eventId: selectedEventId })
        }
        if (event.type === 'page.deleted') await transaction('pageWatchers').where('pageId', pageId).delete()
      }
      await transaction<OutboxEventRow>('outboxEvents').where('id', event.id).whereNull('publishedAt').update({ publishedAt: now })
      return true
    })

    if (!didPublish) break
    published += 1
  }
  return published
}

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
  const events = await knex<OutboxEventRow>('outboxEvents')
    .whereNull('publishedAt')
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
  if (events.length === 0) return 0

  const hooks = await knex<WebhookRow>('webhooks').where('isEnabled', true)
  const durableJobs = new DurableJobStore(knex)
  for (const event of events) {
    const payload: unknown = JSON.parse(event.payload)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError(`Outbox event ${event.id} payload must be an object`)
    }
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
      try {
        await knex('webhookDeliveries').insert({
          id: deliveryId,
          webhookId: hook.id,
          eventId: event.id,
          jobId: job.id,
          statusCode: null,
          responseSnippet: null,
          createdAt: now,
          deliveredAt: null
        })
      } catch (error) {
        const existing = await knex('webhookDeliveries').where({ webhookId: hook.id, eventId: event.id }).first()
        if (!existing) throw error
      }
    }
    const pageId = Reflect.get(payload, 'pageId')
    const actorId = Reflect.get(payload, 'actorId')
    if (event.type.startsWith('page.') && typeof pageId === 'number' && Number.isSafeInteger(pageId) && pageId > 0) {
      const actorName = Reflect.get(payload, 'actorName')
      const title = Reflect.get(payload, 'title')
      const path = Reflect.get(payload, 'path')
      const localeCode = Reflect.get(payload, 'localeCode')
      const visibility = Reflect.get(payload, 'visibility')
      const watchers = await knex<{ userId: number; emailEnabled: boolean | number; inAppEnabled: boolean | number }>('pageWatchers')
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
        if (!Boolean(watcher.emailEnabled) && !Boolean(watcher.inAppEnabled)) continue
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
        const deliveryId = String(job.payload.deliveryId)
        if (isAggregatedUpdate && job.payload.eventId !== event.id) {
          await knex('durableJobs').where({ id: job.id, state: 'pending' }).update({
            payload: JSON.stringify({
              deliveryId,
              eventId: event.id,
              userId: watcher.userId,
              emailEnabled: Boolean(watcher.emailEnabled),
              inAppEnabled: Boolean(watcher.inAppEnabled)
            }),
            updatedAt: now
          })
          await knex('pageWatchDeliveries').where('id', deliveryId).update({ eventId: event.id })
        } else {
          try {
            await knex('pageWatchDeliveries').insert({
              id: deliveryId,
              eventId: event.id,
              userId: watcher.userId,
              jobId: job.id,
              createdAt: now,
              deliveredAt: null,
              lastError: null
            })
          } catch (error) {
            const existing = await knex('pageWatchDeliveries').where({ eventId: event.id, userId: watcher.userId }).first()
            if (!existing) throw error
          }
        }
      }
      if (event.type === 'page.deleted') await knex('pageWatchers').where('pageId', pageId).delete()
    }
    await knex<OutboxEventRow>('outboxEvents').where({ id: event.id, publishedAt: null }).update({ publishedAt: now })
  }
  return events.length
}

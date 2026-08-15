import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { DurableJobStore } from '../core/durable-jobs.ts'
import {
  encryptWebhookSecret,
  generateWebhookSecret,
  resolveWebhookUrl
} from '../core/webhooks.ts'

interface WikiContext {
  config: { sessionSecret: string }
  models: { knex: Knex }
}

const wiki = WIKI as unknown as WikiContext
const validEventType = /^(\*|[a-z][a-z0-9]*(?:\.[a-z0-9]+)*)$/

const requiredString = (value: unknown, label: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maxLength) {
    throw new TypeError(`${label} must contain 1 through ${maxLength} characters`)
  }
  return value.trim()
}

const eventList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 ||
    !value.every(event => typeof event === 'string' && validEventType.test(event))) {
    throw new TypeError('events must contain 1 through 50 valid event names')
  }
  return [...new Set(value as string[])]
}

const webhookResult = (row: Record<string, unknown>) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  events: JSON.parse(String(row.events)),
  isEnabled: Boolean(row.isEnabled),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

const list = async () => {
  const rows = await wiki.models.knex('webhooks').orderBy('name', 'asc')
  return rows.map(webhookResult)
}

const create = async (input: Record<string, unknown>) => {
  const name = requiredString(input.name, 'name', 128)
  const url = requiredString(input.url, 'url', 2_048)
  const events = eventList(input.events)
  await resolveWebhookUrl(url)
  const id = randomUUID()
  const secret = generateWebhookSecret()
  const now = new Date()
  await wiki.models.knex('webhooks').insert({
    id,
    name,
    url,
    events: JSON.stringify(events),
    secretCiphertext: encryptWebhookSecret(secret, wiki.config.sessionSecret),
    isEnabled: input.isEnabled === undefined ? true : Boolean(input.isEnabled),
    createdAt: now,
    updatedAt: now
  })
  return { id, secret }
}

const update = async (id: string, input: Record<string, unknown>): Promise<void> => {
  const existing = await wiki.models.knex('webhooks').where('id', id).first()
  if (!existing) throw Object.assign(new Error('Webhook not found'), { status: 404 })
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) patch.name = requiredString(input.name, 'name', 128)
  if (input.url !== undefined) {
    const url = requiredString(input.url, 'url', 2_048)
    await resolveWebhookUrl(url)
    patch.url = url
  }
  if (input.events !== undefined) patch.events = JSON.stringify(eventList(input.events))
  if (input.isEnabled !== undefined) {
    if (typeof input.isEnabled !== 'boolean') throw new TypeError('isEnabled must be a boolean')
    patch.isEnabled = input.isEnabled
  }
  await wiki.models.knex('webhooks').where('id', id).update(patch)
}

const remove = async (id: string): Promise<void> => {
  const deleted = await wiki.models.knex('webhooks').where('id', id).delete()
  if (deleted !== 1) throw Object.assign(new Error('Webhook not found'), { status: 404 })
}

const rotateSecret = async (id: string): Promise<string> => {
  const secret = generateWebhookSecret()
  const updated = await wiki.models.knex('webhooks').where('id', id).update({
    secretCiphertext: encryptWebhookSecret(secret, wiki.config.sessionSecret),
    updatedAt: new Date()
  })
  if (updated !== 1) throw Object.assign(new Error('Webhook not found'), { status: 404 })
  return secret
}

const listDeliveries = async (webhookId: string) => wiki.models.knex('webhookDeliveries as delivery')
  .leftJoin('durableJobs as job', 'job.id', 'delivery.jobId')
  .leftJoin('outboxEvents as event', 'event.id', 'delivery.eventId')
  .where('delivery.webhookId', webhookId)
  .orderBy('delivery.createdAt', 'desc')
  .limit(100)
  .select([
    'delivery.id', 'delivery.eventId', 'delivery.jobId', 'delivery.statusCode',
    'delivery.responseSnippet', 'delivery.createdAt', 'delivery.deliveredAt',
    'job.state', 'job.attempts', 'job.maxAttempts', 'job.nextRunAt', 'job.lastError',
    'event.type as eventType', 'event.version as eventVersion'
  ])

const changeDelivery = async (deliveryId: string, action: 'retry' | 'cancel'): Promise<void> => {
  const delivery = await wiki.models.knex('webhookDeliveries').where('id', deliveryId).first()
  if (!delivery) throw Object.assign(new Error('Webhook delivery not found'), { status: 404 })
  const store = new DurableJobStore(wiki.models.knex)
  const changed = action === 'retry'
    ? await store.retry(String(delivery.jobId))
    : await store.cancel(String(delivery.jobId))
  if (!changed) throw Object.assign(new Error(`Webhook delivery cannot be ${action === 'retry' ? 'retried' : 'cancelled'} from its current state`), { status: 409 })
}

export default {
  changeDelivery,
  create,
  list,
  listDeliveries,
  remove,
  rotateSecret,
  update
}

import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { queueWebhookTest } from '../../core/webhook-test.ts'
import { publishOutboxEvents } from '../../core/outbox.ts'
import { WEBHOOK_EVENTS, isWebhookEventName } from '../../../shared/webhook-events.ts'
import { up as upJobs } from '../../db/migrations/2.5.130.ts'
import { up as upLease } from '../../db/migrations/2.5.158.ts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'
import { DurableJobStore } from '../../core/durable-jobs.ts'
let knex: Knex
beforeEach(async () => {
  knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
  await upJobs(knex); await upLease(knex); await upOutbox(knex)
  await knex('webhooks').insert(['one', 'two'].map(id => ({ id, name: id, url: 'https://example.test/hook', events: '["*"]', secretCiphertext: 'fixture', isEnabled: true, createdAt: new Date(), updatedAt: new Date() })))
})
afterEach(async () => { await knex.destroy() })
describe('targeted webhook tests', () => {
  it('queues one targeted durable delivery with synthetic data and prevents outbox fanout', async () => {
    const id = await queueWebhookTest(knex, 'one')
    const deliveries = await knex('webhookDeliveries')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ id, webhookId: 'one', deliveredAt: null })
    const event = await knex('outboxEvents').first()
    expect(event.type).toBe('webhook.test')
    expect(event.publishedAt).not.toBeNull()
    expect(JSON.parse(event.payload)).toEqual({ test: true, message: expect.any(String) })
    const job = await new DurableJobStore(knex).get(deliveries[0].jobId)
    expect(job).toMatchObject({ type: 'deliver-webhook', maxAttempts: 1, state: 'pending', payload: { deliveryId: id, eventId: event.id, webhookId: 'one' } })
    await expect(publishOutboxEvents(knex)).resolves.toBe(0)
    expect(await knex('webhookDeliveries')).toEqual([
      expect.objectContaining({ id, webhookId: 'one', eventId: event.id, jobId: deliveries[0].jobId, deliveredAt: null })
    ])
  })
  it('rejects duplicate active tests and allows a fresh test after cancellation', async () => {
    const firstId = await queueWebhookTest(knex, 'one')
    await expect(queueWebhookTest(knex, 'one')).rejects.toMatchObject({ status: 409 })
    expect(await knex('outboxEvents')).toHaveLength(1)
    const delivery = await knex('webhookDeliveries').where('id', firstId).first()
    const store = new DurableJobStore(knex)
    await store.cancel(delivery.jobId)
    const freshId = await queueWebhookTest(knex, 'one')
    expect(freshId).not.toBe(firstId)
    const freshDelivery = await knex('webhookDeliveries').where('id', freshId).first()
    expect(freshDelivery).toMatchObject({ id: freshId, webhookId: 'one', deliveredAt: null })
    expect(freshDelivery.eventId).not.toBe(delivery.eventId)
    expect(freshDelivery.jobId).not.toBe(delivery.jobId)
    expect(await store.get(freshDelivery.jobId)).toMatchObject({
      state: 'pending',
      payload: { deliveryId: freshId, eventId: freshDelivery.eventId, webhookId: 'one' }
    })
    expect(await store.get(delivery.jobId)).toMatchObject({ state: 'cancelled' })
    expect(await knex('webhookDeliveries')).toHaveLength(2)
  })
  it('does not enqueue for missing or disabled endpoints', async () => {
    await expect(queueWebhookTest(knex, 'missing')).rejects.toMatchObject({ status: 404 })
    await knex('webhooks').where('id', 'one').update({ isEnabled: false })
    await expect(queueWebhookTest(knex, 'one')).rejects.toMatchObject({ status: 409 })
    expect(await knex('outboxEvents')).toHaveLength(0)
    expect(await knex('durableJobs')).toHaveLength(0)
  })
  it('accepts all actual catalog events including hyphens and rejects malformed names', () => {
    expect(WEBHOOK_EVENTS.every(event => isWebhookEventName(event.name))).toBe(true)
    expect(isWebhookEventName('page.visibility-changed')).toBe(true)
    expect(isWebhookEventName('page.ownership-transferred')).toBe(true)
    expect(isWebhookEventName('*')).toBe(true)
    for (const name of ['page..created', 'Page.created', '.created', 'page.-created', 'page.*', 'a'.repeat(129)]) expect(isWebhookEventName(name)).toBe(false)
  })
})

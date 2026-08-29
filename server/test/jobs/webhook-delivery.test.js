
import createKnex from 'knex'

const { decryptMock, resolveMock, sendMock, DeliveryError } = vi.hoisted(() => {
  class DeliveryError extends Error {
    constructor(message, statusCode, responseSnippet = '') {
      super(message)
      this.statusCode = statusCode
      this.responseSnippet = responseSnippet
    }
  }
  return {
    decryptMock: vi.fn().mockReturnValue('delivery-secret'),
    resolveMock: vi.fn().mockResolvedValue({
      url: new URL('https://hooks.example.test/wiki'),
      address: '203.0.114.10',
      family: 4
    }),
    sendMock: vi.fn(),
    DeliveryError
  }
})
vi.mockModule('../../core/webhooks.ts', import.meta.url, () => ({
  decryptWebhookSecret: decryptMock,
  resolveWebhookUrl: resolveMock,
  sendSignedWebhook: sendMock,
  WebhookDeliveryError: DeliveryError
}))

const { up: upDurableJobs } = await import('../../db/migrations/2.5.130.ts')
const { up: upOutbox } = await import('../../db/migrations/2.5.131.ts')
const { DurableJobStore } = await import('../../core/durable-jobs.ts')
const { createWebhookDeliveryHandler } = await import('../../jobs/durable-job-handlers.ts')

let knex
let job
let handler

beforeEach(async () => {
  vi.clearAllMocks()
  decryptMock.mockReturnValue('delivery-secret')
  resolveMock.mockResolvedValue({
    url: new URL('https://hooks.example.test/wiki'),
    address: '203.0.114.10',
    family: 4
  })
  sendMock.mockResolvedValue({ statusCode: 204, responseSnippet: '' })
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await upDurableJobs(knex)
  await upOutbox(knex)
  const now = new Date('2026-08-14T12:00:00.000Z')
  await knex('webhooks').insert({
    id: 'hook-1', name: 'Hook', url: 'https://hooks.example.test/wiki',
    events: '["page.created"]', secretCiphertext: 'encrypted', isEnabled: true,
    createdAt: now, updatedAt: now
  })
  await knex('outboxEvents').insert({
    id: 'event-1', type: 'page.created', version: 1, aggregateType: 'page', aggregateId: '7',
    payload: '{"pageId":7}', createdAt: now, publishedAt: now
  })
  const store = new DurableJobStore(knex)
  const pending = await store.enqueue({
    type: 'deliver-webhook', version: 1,
    payload: { deliveryId: 'delivery-1', eventId: 'event-1', webhookId: 'hook-1' }
  })
  await knex('webhookDeliveries').insert({
    id: 'delivery-1', webhookId: 'hook-1', eventId: 'event-1', jobId: pending.id,
    statusCode: null, responseSnippet: null, createdAt: now, deliveredAt: null
  })
  ;[job] = await store.claim({ workerId: 'instance-a' })
  handler = createWebhookDeliveryHandler('session-secret')
})

afterEach(async () => {
  await knex.destroy()
})

describe('webhook delivery durable handler', () => {
  it('records a signed delivery once', async () => {
    await handler(job, { knex })
    await handler(job, { knex })

    expect(sendMock).toHaveBeenCalledOnce()
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-1',
      eventId: 'event-1',
      eventType: 'page.created',
      eventVersion: 1,
      payload: { pageId: 7 },
      secret: 'delivery-secret'
    }))
    expect(await knex('webhookDeliveries').where('id', 'delivery-1').first()).toMatchObject({
      statusCode: 204,
      deliveredAt: expect.anything()
    })
  })

  it('records retryable HTTP failures without marking delivery complete', async () => {
    sendMock.mockRejectedValue(new DeliveryError('HTTP 503', 503, 'try later'))

    await expect(Promise.resolve(handler(job, { knex }))).rejects.toThrow('HTTP 503')

    expect(await knex('webhookDeliveries').where('id', 'delivery-1').first()).toMatchObject({
      statusCode: 503,
      responseSnippet: 'try later',
      deliveredAt: null
    })
  })
})

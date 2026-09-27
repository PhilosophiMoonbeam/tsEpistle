
import { EventEmitter } from 'node:events'
import { createHmac } from 'node:crypto'
import createKnex from 'knex'
import { publishOutboxEvents, writeOutboxEvent } from '../../core/outbox.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'

const { lookupMock, requestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn()
}))
vi.mockModule('node:dns/promises', import.meta.url, () => ({ lookup: lookupMock }))
vi.mockModule('node:https', import.meta.url, () => ({ request: requestMock }))

const {
  decryptWebhookSecret,
  encryptWebhookSecret,
  resolveWebhookUrl,
  sendSignedWebhook
} = await import('../../core/webhooks.ts')

describe('webhook transport security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('encrypts stored signing secrets with authenticated encryption', () => {
    const encrypted = encryptWebhookSecret('delivery-secret', 'session-secret')

    expect(encrypted).not.toContain('delivery-secret')
    expect(decryptWebhookSecret(encrypted, 'session-secret')).toBe('delivery-secret')
    expect(() => decryptWebhookSecret(`${encrypted}tampered`, 'session-secret')).toThrow()
  })

  it('rejects non-HTTPS and private-network destinations', async () => {
    await expect(Promise.resolve(resolveWebhookUrl('http://example.com/hook'))).rejects.toThrow('must use HTTPS')
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    await expect(Promise.resolve(resolveWebhookUrl('https://localhost/hook'))).rejects.toThrow('public network address')
  })

  it('pins validated DNS and signs the exact request body', async () => {
    let sentBody = ''
    requestMock.mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter()
      req.end = body => {
        sentBody = body
        const response = new EventEmitter()
        response.statusCode = 204
        queueMicrotask(() => {
          callback(response)
          response.emit('end')
        })
      }
      return req
    })
    const timestamp = new Date('2026-08-14T12:00:00.000Z')

    const result = await sendSignedWebhook({
      deliveryId: 'delivery-1',
      eventId: 'event-1',
      eventType: 'page.created',
      eventVersion: 1,
      eventCreatedAt: new Date('2026-08-14T11:59:00.000Z'),
      payload: { pageId: 7 },
      secret: 'delivery-secret',
      target: {
        url: new URL('https://hooks.example.test/wiki'),
        address: '203.0.114.10',
        family: 4
      },
      signal: new AbortController().signal,
      timestamp
    })

    expect(result.statusCode).toBe(204)
    const options = requestMock.mock.calls[0][1]
    expect(options.headers['x-wiki-delivery']).toBe('delivery-1')
    expect(options.headers['x-wiki-event']).toBe('page.created')
    expect(options.headers['x-wiki-timestamp']).toBe(timestamp.toISOString())
    expect(options.headers['x-wiki-signature']).toBe(
      `sha256=${createHmac('sha256', 'delivery-secret').update(`${timestamp.toISOString()}.${sentBody}`).digest('hex')}`
    )

    const lookupResult = await new Promise((resolve, reject) => {
      options.lookup('hooks.example.test', {}, (error, address, family) => {
        if (error) reject(error)
        else resolve({ address, family })
      })
    })
    expect(lookupResult).toEqual({ address: '203.0.114.10', family: 4 })
  })

  it('does not dispatch an already-aborted delivery', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Webhook lease lost', 'AbortError'))

    await expect(sendSignedWebhook({
      deliveryId: 'delivery-1',
      eventId: 'event-1',
      eventType: 'page.created',
      eventVersion: 1,
      eventCreatedAt: new Date('2026-08-14T11:59:00.000Z'),
      payload: { pageId: 7 },
      secret: 'delivery-secret',
      target: {
        url: new URL('https://hooks.example.test/wiki'),
        address: '203.0.114.10',
        family: 4
      },
      signal: controller.signal
    })).rejects.toBe(controller.signal.reason)

    expect(requestMock).not.toHaveBeenCalled()
  })

  it('suppresses comment deliveries without a current eligibility grant', async () => {
    const commentEligibility = vi.fn().mockResolvedValue(false)

    const result = await sendSignedWebhook({
      deliveryId: 'delivery-comment',
      eventId: 'event-comment',
      eventType: 'comment.updated',
      eventVersion: 1,
      eventCreatedAt: new Date('2026-08-14T11:59:00.000Z'),
      payload: { pageId: 7, commentId: 19, action: 'updated' },
      commentEligibility,
      secret: 'delivery-secret',
      target: {
        url: new URL('https://hooks.example.test/wiki'),
        address: '203.0.114.10',
        family: 4
      }
    })

    expect(commentEligibility).toHaveBeenCalledOnce()
    expect(result).toEqual({ statusCode: 204, responseSnippet: 'Comment is no longer anonymously visible' })
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('fails closed when comment eligibility is not supplied', async () => {
    await expect(sendSignedWebhook({
      deliveryId: 'delivery-comment',
      eventId: 'event-comment',
      eventType: 'comment.deleted',
      eventVersion: 1,
      eventCreatedAt: new Date('2026-08-14T11:59:00.000Z'),
      payload: { pageId: 7, commentId: 19, action: 'deleted' },
      secret: 'delivery-secret',
      target: {
        url: new URL('https://hooks.example.test/wiki'),
        address: '203.0.114.10',
        family: 4
      }
    })).rejects.toThrow()

    expect(requestMock).not.toHaveBeenCalled()
  })

  it('sends only the minimal comment event DTO', async () => {
    let sentBody = ''
    requestMock.mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter()
      req.end = body => {
        sentBody = body
        const response = new EventEmitter()
        response.statusCode = 204
        queueMicrotask(() => {
          callback(response)
          response.emit('end')
        })
      }
      return req
    })

    await sendSignedWebhook({
      deliveryId: 'delivery-comment',
      eventId: 'event-comment',
      eventType: 'comment.created',
      eventVersion: 1,
      eventCreatedAt: new Date('2026-08-14T11:59:00.000Z'),
      payload: {
        pageId: 7,
        commentId: 19,
        action: 'created',
        content: 'private comment body',
        render: '<p>private comment body</p>',
        guestName: 'Guest',
        email: 'guest@example.test',
        ip: '203.0.113.7',
        token: 'private'
      },
      commentEligibility: async () => true,
      secret: 'delivery-secret',
      target: {
        url: new URL('https://hooks.example.test/wiki'),
        address: '203.0.114.10',
        family: 4
      }
    })

    expect(JSON.parse(sentBody).data).toEqual({ pageId: 7, commentId: 19, action: 'created' })
  })
})

let subscriptionKnex

describe('comment webhook subscription admission', () => {
  beforeEach(async () => {
    subscriptionKnex = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await upDurableJobs(subscriptionKnex)
    await addDurableJobLeaseToken(subscriptionKnex)
    await upOutbox(subscriptionKnex)
    const now = new Date('2026-08-14T12:00:00.000Z')
    await subscriptionKnex('webhooks').insert([
      {
        id: '00000000-0000-4000-8000-000000000010',
        name: 'Legacy wildcard',
        url: 'https://hooks.example.test/wildcard',
        events: JSON.stringify(['*']),
        secretCiphertext: 'encrypted',
        isEnabled: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: '00000000-0000-4000-8000-000000000011',
        name: 'Explicit comments',
        url: 'https://hooks.example.test/comments',
        events: JSON.stringify(['comment.created']),
        secretCiphertext: 'encrypted',
        isEnabled: true,
        createdAt: now,
        updatedAt: now
      }
    ])
  })

  afterEach(async () => {
    await subscriptionKnex.destroy()
  })

  it('requires literal comment subscriptions without changing wildcard delivery for other events', async () => {
    await writeOutboxEvent(subscriptionKnex, {
      type: 'comment.created',
      version: 1,
      aggregateType: 'comment',
      aggregateId: 19,
      payload: { pageId: 7, commentId: 19, action: 'created' }
    })

    await expect(publishOutboxEvents(subscriptionKnex)).resolves.toBe(1)
    const commentDeliveries = await subscriptionKnex('webhookDeliveries').select('webhookId')
    expect(commentDeliveries).toEqual([{ webhookId: '00000000-0000-4000-8000-000000000011' }])

    await writeOutboxEvent(subscriptionKnex, {
      type: 'approval.submitted',
      version: 1,
      aggregateType: 'approval',
      aggregateId: 23,
      payload: { pageId: 7, revisionId: 23 }
    })

    await expect(publishOutboxEvents(subscriptionKnex)).resolves.toBe(1)
    const approvalDeliveries = await subscriptionKnex('webhookDeliveries')
      .join('outboxEvents', 'outboxEvents.id', 'webhookDeliveries.eventId')
      .where('outboxEvents.type', 'approval.submitted')
      .select('webhookDeliveries.webhookId')
    expect(approvalDeliveries).toEqual([{ webhookId: '00000000-0000-4000-8000-000000000010' }])
  })
})

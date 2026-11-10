
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
  projectApprovalWebhookPayload,
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
    lookupMock.mockResolvedValue([{ address: '203.0.114.10', family: 4 }])
    await expect(Promise.resolve(resolveWebhookUrl('http://example.com/hook'))).rejects.toBeInstanceOf(TypeError)
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    await expect(Promise.resolve(resolveWebhookUrl('https://localhost/hook'))).rejects.toBeInstanceOf(TypeError)
  })

  it('admits public IPv4 and IPv6 while filtering mixed-family private and mapped DNS answers', async () => {
    const publicV4 = { address: '8.8.8.8', family: 4 }
    const publicV6 = { address: '2606:4700:4700::1111', family: 6 }
    const blocked = [
      { address: '10.0.0.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '192.168.1.1', family: 4 },
      { address: '::1', family: 6 },
      { address: 'fd00::1', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '::ffff:7f00:1', family: 6 },
      { address: '::ffff:10.0.0.1', family: 6 }
    ]
    for (const candidate of blocked) {
      lookupMock.mockResolvedValueOnce([candidate])
      await expect(resolveWebhookUrl('https://hooks.example.test/wiki')).rejects.toThrow('public network address')
    }
    for (const candidate of [publicV4, publicV6]) {
      lookupMock.mockResolvedValueOnce([...blocked, candidate])
      await expect(resolveWebhookUrl('https://hooks.example.test/wiki')).resolves.toEqual({
        url: new URL('https://hooks.example.test/wiki'), ...candidate
      })
    }
    expect(requestMock).not.toHaveBeenCalled()
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

    expect(commentEligibility).toHaveBeenCalled()
    expect(result.statusCode).toBe(204)
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

  it('projects every approval transition with exact string revisions and rejects legacy or ambiguous lineage', () => {
    const base = {
      requestId: '00000000-0000-4000-8000-000000000023', pageId: 7,
      reviewedSourceRevision: '9007199254740993', publishedSourceRevision: null,
      source: 'private source', email: 'reviewer@example.test', actorId: 8, comment: 'private review'
    }
    for (const [eventType, status] of [
      ['approval.submitted', 'submitted'], ['approval.resubmit', 'submitted'],
      ['approval.approve', 'approved'], ['approval.requestchanges', 'changes-requested'],
      ['approval.reject', 'rejected'], ['approval.cancel', 'cancelled'],
      ['approval.publish', 'published'], ['approval.reassign', 'submitted']
    ]) {
      const resultRevision = status === 'published' ? '9007199254740994' : null
      expect(projectApprovalWebhookPayload(eventType, { ...base, status, publishedSourceRevision: resultRevision })).toEqual({
        requestId: base.requestId, pageId: 7, status,
        reviewedSourceRevision: base.reviewedSourceRevision, publishedSourceRevision: resultRevision
      })
    }
    for (const invalid of [
      { reviewedSourceRevision: null }, { reviewedSourceRevision: undefined },
      { reviewedSourceRevision: 9007199254740992 }, { reviewedSourceRevision: '01' },
      { requestId: 23 }, { requestId: '' }, { pageId: '7' }, { status: ['submitted'] },
      { publishedSourceRevision: undefined }, { publishedSourceRevision: '3' }
    ]) {
      expect(projectApprovalWebhookPayload('approval.reassign', { ...base, status: 'submitted', ...invalid })).toBeNull()
    }
    expect(projectApprovalWebhookPayload('approval.publish', { ...base, status: 'approved' })).toBeNull()
  })

  it('suppresses a legacy approval payload without ever invoking transport or replaying its raw fields', async () => {
    const approvalEligibility = vi.fn().mockResolvedValue(true)
    const result = await sendSignedWebhook({
      deliveryId: 'delivery-approval', eventId: 'event-approval', eventType: 'approval.submitted',
      eventVersion: 1, eventCreatedAt: new Date(), payload: {
        requestId: '00000000-0000-4000-8000-000000000023', pageId: 7,
        revisionId: 23, status: 'submitted', source: 'private source', comment: 'private review'
      },
      approvalEligibility, secret: 'delivery-secret',
      target: { url: new URL('https://hooks.example.test/wiki'), address: '203.0.114.10', family: 4 }
    })
    expect(result).toEqual({ statusCode: null, responseSnippet: expect.stringContaining('suppressed without delivery') })
    expect(approvalEligibility).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
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

  it('requires literal discussion and approval subscriptions without changing wildcard delivery for page events', async () => {
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

    await subscriptionKnex('webhooks').where('id', '00000000-0000-4000-8000-000000000011').update({ events: '["approval.submitted"]' })
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
    expect(approvalDeliveries).toEqual([{ webhookId: '00000000-0000-4000-8000-000000000011' }])
    await writeOutboxEvent(subscriptionKnex, {
      type: 'page.created', version: 1, aggregateType: 'page', aggregateId: 7, payload: {}
    })
    await publishOutboxEvents(subscriptionKnex)
    const pageDeliveries = await subscriptionKnex('webhookDeliveries')
      .join('outboxEvents', 'outboxEvents.id', 'webhookDeliveries.eventId')
      .where('outboxEvents.type', 'page.created')
      .select('webhookDeliveries.webhookId')
    expect(pageDeliveries).toEqual([{ webhookId: '00000000-0000-4000-8000-000000000010' }])
  })
})

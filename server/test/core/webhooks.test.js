
import { EventEmitter } from 'node:events'
import { createHmac } from 'node:crypto'

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
})

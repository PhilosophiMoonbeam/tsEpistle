import { describe, expect, it } from '../bun-test.mts'
import { BrowserEnvelopeVerifier, BrowserProtocolError, signBrowserEnvelope } from '../../agents/browser/protocol.ts'

const now = new Date('2026-08-17T12:00:00.000Z')
const secret = Buffer.alloc(32, 7)
const unsigned = {
  keyId: 'current', runId: '00000000-0000-4000-8000-000000000001', ownerId: 7, leaseToken: 'lease-token-value-1', contextId: 'context-value-0001', actionCallId: 'action-call-00001', sequence: 1,
  limits: { contextTtlMilliseconds: 60_000, maximumActions: 20, maximumNavigations: 5, maximumResponseBytes: 1_000_000 },
  action: { kind: 'navigate' as const, url: 'https://example.com/docs', attestedUrls: ['https://example.com/docs'] }
}

const expectProtocolError = (verify: () => unknown, code: string): void => {
  let error: unknown
  try { verify() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(BrowserProtocolError)
  expect(error).toMatchObject({ code, status: 401 })
}

describe('browser worker signed envelopes', () => {
  it('authenticates one fresh request and rejects replay', () => {
    const envelope = signBrowserEnvelope(unsigned, secret, now)
    const verifier = new BrowserEnvelopeVerifier(new Map([['current', secret]]), { now: () => now.getTime() })
    expect(verifier.verify(envelope)).toEqual(envelope)
    expectProtocolError(() => verifier.verify(envelope), 'BROWSER_NONCE_REPLAYED')
  })

  it('rejects tampering, unknown keys and expired requests', () => {
    const envelope = signBrowserEnvelope(unsigned, secret, now)
    expectProtocolError(() => new BrowserEnvelopeVerifier(new Map([['current', secret]]), { now: () => now.getTime() }).verify({ ...envelope, ownerId: 8 }), 'BROWSER_SIGNATURE_INVALID')
    expectProtocolError(() => new BrowserEnvelopeVerifier(new Map(), { now: () => now.getTime() }).verify(envelope), 'BROWSER_KEY_UNKNOWN')
    expectProtocolError(() => new BrowserEnvelopeVerifier(new Map([['current', secret]]), { now: () => now.getTime() + 31_000 }).verify(envelope), 'BROWSER_ENVELOPE_EXPIRED')
  })
})

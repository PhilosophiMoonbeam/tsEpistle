import { describe, expect, it, vi } from '../bun-test.mts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'

const invoke = (input: Record<string, unknown>) => {
  const next = vi.fn()
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  createOriginMiddleware(() => 'https://wiki.example.test')(input as never, response as never, next)
  return { next, response }
}

describe('cookie request origin policy', () => {
  it('rejects unsafe internal requests without the exact Origin header', () => {
    const { next, response } = invoke({ method: 'POST', path: '/_api/users/profile', get: vi.fn(() => undefined) })

    expect(next).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.json).toHaveBeenCalledWith({ error: 'A same-origin request is required.' })
  })
  it('requires an exact Origin for logout POSTs and rejects missing, cross-site, and null origins', () => {
    for (const origin of [undefined, 'https://foreign.example.test', 'null']) {
      const get = vi.fn((name: string) => name === 'origin' ? origin : undefined)
      const { next, response } = invoke({ method: 'POST', path: '/logout', get })

      expect(next).not.toHaveBeenCalled()
      expect(response.status).toHaveBeenCalledWith(403)
      expect(response.json).toHaveBeenCalledWith({ error: 'A same-origin request is required.' })
    }

    const get = vi.fn((name: string) => name === 'origin' ? 'https://wiki.example.test' : undefined)
    const { next, response } = invoke({ method: 'POST', path: '/logout', get })

    expect(next).toHaveBeenCalledTimes(1)
    expect(response.status).not.toHaveBeenCalled()
  })

  it('allows safe GraphQL navigation without Origin but protects unsafe operations', () => {
    const safe = invoke({ method: 'GET', path: '/graphql', get: vi.fn(() => undefined) })
    expect(safe.next).toHaveBeenCalledTimes(1)
    expect(safe.response.status).not.toHaveBeenCalled()

    const unsafe = invoke({ method: 'POST', path: '/graphql', get: vi.fn(() => undefined) })
    expect(unsafe.next).not.toHaveBeenCalled()
    expect(unsafe.response.status).toHaveBeenCalledWith(403)
  })


  it('admits exact-origin cookie requests and protects uploads', () => {
    const get = vi.fn((name: string) => name === 'origin' ? 'https://wiki.example.test' : undefined)
    const { next, response } = invoke({ method: 'POST', path: '/u', get })

    expect(next).toHaveBeenCalledTimes(1)
    expect(response.status).not.toHaveBeenCalled()
  })

  it('exempts independently authenticated API-key transports from browser Origin checks', () => {
    const get = vi.fn(() => 'https://foreign.example.test')
    const { next, response } = invoke({
      method: 'POST',
      path: '/api/v1/pages',
      get,
      authContext: { kind: 'apiKey' }
    })

    expect(next).toHaveBeenCalledTimes(1)
    expect(response.status).not.toHaveBeenCalled()
  })
  it('only exempts protocol callbacks when complete correlation data is present', () => {
    for (const request of [
      { method: 'GET', path: '/login/google/callback', query: {} },
      { method: 'GET', path: '/login/google/callback', query: { state: 'state-only' } },
      { method: 'GET', path: '/login/google/callback', query: { state: 'state-a', code: ['code-a'] } },
      { method: 'POST', path: '/login/google/callback', body: {} }
    ]) {
      const unsolicited = invoke({ ...request, get: vi.fn(() => undefined) })
      expect(unsolicited.next).not.toHaveBeenCalled()
      expect(unsolicited.response.status).toHaveBeenCalledWith(403)
    }

    for (const request of [
      { method: 'GET', query: { state: 'state-a', code: 'code-a' } },
      { method: 'GET', query: { state: 'state-a', error: 'access_denied' } },
      { method: 'GET', query: { state: 'state-a', ticket: 'ST-123' } },
      { method: 'POST', body: { SAMLResponse: 'response', RelayState: 'relay-state' } }
    ]) {
      const correlated = invoke({ ...request, path: '/login/google/callback', get: vi.fn(() => undefined) })
      expect(correlated.next).toHaveBeenCalledTimes(1)
      expect(correlated.response.status).not.toHaveBeenCalled()
    }

    const exactOrigin = invoke({
      method: 'GET',
      path: '/login/google/callback',
      query: { state: 'state-only' },
      get: vi.fn((name: string) => name === 'origin' ? 'https://wiki.example.test' : undefined)
    })
    expect(exactOrigin.next).toHaveBeenCalledTimes(1)
    expect(exactOrigin.response.status).not.toHaveBeenCalled()
  })
})

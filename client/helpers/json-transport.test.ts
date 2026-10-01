import { describe, expect, it, vi } from '../../server/test/bun-test.mts'

describe('same-origin JSON transport', () => {
  it('returns the original response without consuming its body', async () => {
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })

    const returned = await sameOriginJsonFetch(async () => response, '/_api/binary', { credentials: 'same-origin' })

    expect(returned).toBe(response)
    expect(response.bodyUsed).toBe(false)
  })

  it('does not inspect or persist legacy renewal headers', async () => {
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const token = [
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      btoa(JSON.stringify({ sub: 7, authVersion: 0, iat: 1800000000, exp: 2100000000 })).replace(/=+$/, ''),
      'c2lnbmF0dXJl'
    ].join('.')
    const response = new Response(null, { headers: { 'new-jwt': token } })
    const originalCookie = Object.getOwnPropertyDescriptor(document, 'cookie')
    const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    const cookieWrites = vi.fn((_value: string) => {})

    try {
      const getHeader = vi.spyOn(response.headers, 'get')
      const hasHeader = vi.spyOn(response.headers, 'has')
      const storageWrites = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
      Object.defineProperty(document, 'cookie', { ...cookieDescriptor, configurable: true, set: cookieWrites })

      await expect(sameOriginJsonFetch(async () => response, '/_api/example', { credentials: 'same-origin' })).resolves.toBe(response)

      expect(getHeader.mock.calls.filter(([name]) => name.toLowerCase() === 'new-jwt')).toEqual([])
      expect(hasHeader.mock.calls.filter(([name]) => name.toLowerCase() === 'new-jwt')).toEqual([])
      expect(cookieWrites).not.toHaveBeenCalled()
      expect(storageWrites).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      if (originalCookie) Object.defineProperty(document, 'cookie', originalCookie)
      else Reflect.deleteProperty(document, 'cookie')
    }
  })
})

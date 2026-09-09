import { describe, expect, it } from '../../server/test/bun-test.mts'

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
    const response = new Response(null, { headers: { 'new-jwt': 'legacy-token' } })

    await expect(sameOriginJsonFetch(async () => response, '/_api/example', { credentials: 'same-origin' })).resolves.toBe(response)
  })
})

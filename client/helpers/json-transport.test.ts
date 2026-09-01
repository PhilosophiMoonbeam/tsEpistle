import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type * as WikiStoreModule from '../store/index.ts'

const cookies = new Map<string, string>()
const cookieApi = {
  get: vi.fn((name: string) => cookies.get(name)),
  set: vi.fn((name: string, value: string) => {
    cookies.set(name, value)
  }),
  remove: vi.fn((name: string) => {
    cookies.delete(name)
  })
}

const tokenFor = (payload: Record<string, unknown>): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

const installWindow = (): void => {
  vi.stubGlobal('window', {
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    location: { protocol: 'https:', pathname: '/' },
    siteConfig: {
      company: '',
      contentLicense: '',
      footerOverride: '',
      banner: {},
      darkMode: false,
      tocPosition: 'left',
      title: 'Test',
      logoUrl: '',
      product: { name: 'Test', version: '1.0.0' }
    }
  })
}

describe('same-origin JSON transport', () => {
  afterEach(() => {
    cookies.clear()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('persists and hydrates a renewed JWT before the transport promise resolves', async () => {
    installWindow()
    vi.mockModule('js-cookie', import.meta.url, () => ({ default: cookieApi }))
    const { wikiStore } = await vi.importFresh<typeof WikiStoreModule>('../store/index.ts', import.meta.url)
    // Import after the fresh store so this test exercises the refresh callback registered during store initialization.
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const expiration = Math.floor(Date.now() / 1000) + 3_600
    const renewedToken = tokenFor({ id: 42, name: 'Renewed User', permissions: ['manage:system'], iat: expiration - 1_800, exp: expiration })
    const fetcher = vi.fn(async () => Response.json({ ok: true }, { headers: { 'new-jwt': renewedToken } }))

    const response = await sameOriginJsonFetch(fetcher, '/_api/example', { credentials: 'same-origin' }).then(response => {
      expect(cookies.get('jwt')).toBe(renewedToken)
      expect(cookieApi.set).toHaveBeenCalledWith('jwt', renewedToken, {
        expires: 365,
        secure: true
      })
      expect(wikiStore.user.id).toBe(42)
      expect(wikiStore.user.name).toBe('Renewed User')
      expect(wikiStore.user.permissions).toEqual(['manage:system'])
      expect(wikiStore.user.exp).toBe(expiration)
      expect(wikiStore.user.authenticated).toBe(true)
      return response
    })
    expect(await response.json()).toEqual({ ok: true })
  })

  it('ignores legacy header readers unless they explicitly expose a renewal header', async () => {
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const response = { headers: { get: () => 'application/json' } }

    await expect(sameOriginJsonFetch(async () => response, '/_api/example', { credentials: 'same-origin' })).resolves.toBe(response)
  })

  it('rejects a malformed explicitly present renewal header without persisting it', async () => {
    vi.mockModule('js-cookie', import.meta.url, () => ({ default: cookieApi }))
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const response = new Response(null, { headers: { 'new-jwt': 'not-a-jwt' } })

    await expect(sameOriginJsonFetch(async () => response, '/_api/example', { credentials: 'same-origin' })).rejects.toThrow('JWT payload is missing.')
    expect(cookies.get('jwt')).toBeUndefined()
    expect(cookieApi.set).not.toHaveBeenCalled()
  })

  it('rejects an expired explicitly present renewal header without persisting it', async () => {
    vi.mockModule('js-cookie', import.meta.url, () => ({ default: cookieApi }))
    installWindow()
    await vi.importFresh<typeof WikiStoreModule>('../store/index.ts', import.meta.url)
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const expiredToken = tokenFor({ exp: Math.floor(Date.now() / 1000) - 1 })
    const response = new Response(null, { headers: { 'new-jwt': expiredToken } })

    await expect(sameOriginJsonFetch(async () => response, '/_api/example', { credentials: 'same-origin' })).rejects.toThrow('Renewed JWT is expired.')
    expect(cookies.get('jwt')).toBeUndefined()
    expect(cookieApi.set).not.toHaveBeenCalled()
  })

  it('returns the original response without consuming its body', async () => {
    // Runtime import keeps the cookie module mock installable before the renewal-path module load.
    const { sameOriginJsonFetch } = await import('./json-transport.ts')
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })

    const returned = await sameOriginJsonFetch(async () => response, '/_api/binary', { credentials: 'same-origin' })

    expect(returned).toBe(response)
    expect(response.bodyUsed).toBe(false)
  })
})

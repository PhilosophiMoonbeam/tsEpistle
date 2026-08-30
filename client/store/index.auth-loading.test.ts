import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type * as WikiStoreModule from './index.ts'

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

const encodeToken = (payload: Record<string, unknown>): string => {
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

describe('root authentication and loading ownership', () => {
  afterEach(() => {
    cookies.clear()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('hydrates an expired cookie as a guest and clears stale authority', async () => {
    installWindow()
    vi.mockModule('js-cookie', import.meta.url, () => ({ default: cookieApi }))
    cookies.set('jwt', encodeToken({ id: 7, permissions: ['manage:system'], exp: Math.floor(Date.now() / 1000) - 1 }))
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.permissions = ['manage:system']

    store.refreshAuth()

    expect(store.user.authenticated).toBe(false)
    expect(store.user.permissions).toEqual([])
    expect(store.user.id).toBe(0)
    expect(cookieApi.remove).toHaveBeenCalledWith('jwt')
  })

  it('keeps a same-key load active until every owner releases it', async () => {
    installWindow()
    vi.mockModule('js-cookie', import.meta.url, () => ({ default: cookieApi }))
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    store.startLoading('profile')
    store.startLoading('profile')
    store.stopLoading('profile')

    expect(store.isLoading).toBe(true)
    expect(store.loadingCounts.profile).toBe(1)

    store.stopLoading('profile')
    expect(store.isLoading).toBe(false)
    expect(store.loadingCounts.profile).toBeUndefined()
  })
})

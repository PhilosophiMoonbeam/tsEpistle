import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { SITE_LOGO_PNG_BYTE_LIMIT } from '../../shared/site-logo.ts'
import { cachedOfflineLogo, offlineLogoPath, rememberOfflineLogo, OFFLINE_BRANDING_CACHE_NAME, OFFLINE_DEFAULT_LOGO_PATH } from '../helpers/offline-branding.ts'

const origin = 'https://wiki.example.test'
const png = (suffix = 1): Uint8Array<ArrayBuffer> => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, suffix])
const pathFor = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
  return `/_site-logo/${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}/logo.png`
}
const image = (bytes = png(), headers: Record<string, string> = {}): Response =>
  new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': 'image/png', ...headers } })

function installCache() {
  const entries = new Map<string, Response>()
  const opened: string[] = []
  vi.stubGlobal('caches', { open: async (name: string) => {
    opened.push(name)
    return {
      match: async (url: string) => entries.get(url)?.clone(),
      put: async (url: string, response: Response) => { entries.set(url, response.clone()) }
    }
  } })
  return { entries, opened }
}
afterEach(() => vi.unstubAllGlobals())

describe('optional public offline branding', () => {
  it('admits only exact same-origin managed PNG paths and the bundled logo', async () => {
    const path = await pathFor(png())
    expect(offlineLogoPath(path, origin)).toBe(path)
    expect(offlineLogoPath(`${origin}${path}`, origin)).toBe(path)
    expect(offlineLogoPath(OFFLINE_DEFAULT_LOGO_PATH, origin)).toBe(OFFLINE_DEFAULT_LOGO_PATH)
    for (const value of [`https://other.test${path}`, `//wiki.example.test${path}`, `${path}?token=x`, `${path}#fragment`,
      `/en/..${path}`, path.replace('/logo.png', '/effect.png'), '/uploads/logo.png', '/_assets/svg/other.svg',
      path.replace('/_site-logo/', '/%5fsite-logo/'), 'data:image/png;base64,abc', null]) {
      expect(offlineLogoPath(value, origin)).toBeNull()
    }
  })

  it('warms without credentials, verifies the hash, and keeps one slot across logo changes', async () => {
    const cache = installCache()
    const first = await pathFor(png())
    let requests = 0
    const fetchLogo = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests += 1
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return image()
    }
    expect(await rememberOfflineLogo(first, origin, fetchLogo)).toBe(true)
    expect(await rememberOfflineLogo(first, origin, fetchLogo)).toBe(true)
    expect(requests).toBe(1)
    expect(new Uint8Array(await (await cachedOfflineLogo(first, origin))!.arrayBuffer())).toEqual(png())
    const second = await pathFor(png(2))
    expect(await rememberOfflineLogo(second, origin, async () => image(png(2)))).toBe(true)
    expect(cache.entries.size).toBe(1)
    expect(await cachedOfflineLogo(first, origin)).toBeUndefined()
    expect(await cachedOfflineLogo(second, origin)).toBeDefined()
    expect(new Set(cache.opened)).toEqual(new Set([OFFLINE_BRANDING_CACHE_NAME]))
  })

  it('rejects wrong hashes, non-PNG responses, redirects and oversized streams without replacing a valid logo', async () => {
    const cache = installCache()
    const first = await pathFor(png())
    await rememberOfflineLogo(first, origin, async () => image())
    const next = await pathFor(png(2))
    const redirected = image(png(2))
    Object.defineProperty(redirected, 'redirected', { value: true })
    for (const response of [image(), image(png(2), { 'Content-Type': 'text/html' }), redirected,
      image(png(2), { 'Content-Length': String(SITE_LOGO_PNG_BYTE_LIMIT + 1) })]) {
      expect(await rememberOfflineLogo(next, origin, async () => response)).toBe(false)
    }
    let cancelled = false
    const excessive = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(SITE_LOGO_PNG_BYTE_LIMIT + 1)) },
      cancel() { cancelled = true }
    }), { headers: { 'Content-Type': 'image/png' } })
    expect(await rememberOfflineLogo(next, origin, async () => excessive)).toBe(false)
    expect(cancelled).toBe(true)
    expect(cache.entries.size).toBe(1)
    expect(await cachedOfflineLogo(first, origin)).toBeDefined()
  })

  it('does not serve corrupted cache bytes or populate private or arbitrary asset URLs', async () => {
    const cache = installCache()
    const path = await pathFor(png())
    await rememberOfflineLogo(path, origin, async () => image())
    const slot = [...cache.entries.keys()][0]!
    cache.entries.set(slot, image(png(2), { 'X-Tsepistle-Logo-Path': path }))
    expect(await cachedOfflineLogo(path, origin)).toBeUndefined()
    const unexpectedFetch = async () => { throw new Error('This URL must never be fetched') }
    for (const value of ['/uploads/private.png', '/_private/en/secret', 'https://other.test/logo.png', OFFLINE_DEFAULT_LOGO_PATH]) {
      expect(await rememberOfflineLogo(value, origin, unexpectedFetch)).toBe(false)
    }
  })

  it('fences late logo downloads after a different presentation has been selected', async () => {
    installCache()
    const first = await pathFor(png())
    const second = await pathFor(png(2))
    let finish = (_response: Response): void => {}
    let started = false
    const pending = rememberOfflineLogo(first, origin, () => new Promise(resolve => { finish = resolve; started = true }))
    await vi.waitFor(() => expect(started).toBe(true))
    expect(await rememberOfflineLogo(second, origin, async () => image(png(2)))).toBe(true)
    finish(image())
    expect(await pending).toBe(false)
    expect(await cachedOfflineLogo(first, origin)).toBeUndefined()
    expect(await cachedOfflineLogo(second, origin)).toBeDefined()
  })

  it('treats denied cache storage and failed logo requests as optional', async () => {
    vi.stubGlobal('caches', { open: async () => { throw new Error('Denied') } })
    const path = await pathFor(png())
    expect(await rememberOfflineLogo(path, origin, async () => image())).toBe(false)
    expect(await cachedOfflineLogo(path, origin)).toBeUndefined()
  })
})

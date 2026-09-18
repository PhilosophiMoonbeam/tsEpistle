import { describe, expect, test } from '../../server/test/bun-test.mts'
import {
  OFFLINE_DOCUMENT_PATH,
  PRECACHE_CACHE_PREFIX,
  acceptsHTML,
  isAllowlistedNavigation,
  isNetworkOnlyPath,
  isOwnedPrecacheCacheName,
  type PwaRequestLike
} from '../helpers/pwa-route-policy.ts'

const ORIGIN = 'https://wiki.example.test'

type RequestOptions = Omit<Partial<PwaRequestLike>, 'headers'>

const request = (options: RequestOptions = {}, accept = 'text/html'): PwaRequestLike => ({
  method: 'GET',
  mode: 'navigate',
  url: `${ORIGIN}/en/guide`,
  headers: { get: name => (name.toLowerCase() === 'accept' ? accept : null) },
  ...options
})
const RESERVED_ROUTE_FAMILIES = [
  '/_api',
  '/api',
  '/graphql',
  '/mcp',
  '/login',
  '/logout',
  '/register',
  '/auth',
  '/session',
  '/unlock',
  '/_unlock',
  '/verify',
  '/login-reset',
  '/u',
  '/upload',
  '/uploads',
  '/setup',
  '/admin',
  '/a',
  '/p',
  '/profile',
  '/_admin',
  '/_private',
  '/_userav',
  '/d',
  '/e',
  '/h',
  '/s',
  '/i',
  '/t',
  '/sw.js',
  '/service-worker.js',
  '/sw-tombstone.js',
  '/health',
  '/healthz',
  '/metrics',
  '/robots.txt',
  '/manifest',
  '/manifest.json',
  '/manifest.webmanifest',
  OFFLINE_DOCUMENT_PATH,
  '/_assets'
] as const

describe('PWA route policy', () => {
  test('recognizes HTML negotiation without allocating a header token list', () => {
    expect(acceptsHTML(request({}, 'text/html'))).toBe(true)
    expect(acceptsHTML(request({}, 'application/xhtml+xml, text/html; q=0.9'))).toBe(true)
    expect(acceptsHTML(request({}, 'text/html; q=0'))).toBe(false)
    expect(acceptsHTML(request({}, 'text/htmlish'))).toBe(false)
  })

  test('keeps every reserved route family and static resource out of the fallback allowlist', () => {
    for (const root of RESERVED_ROUTE_FAMILIES) {
      expect(isNetworkOnlyPath(root)).toBe(true)
      expect(isNetworkOnlyPath(`${root}/nested`)).toBe(true)
      expect(isNetworkOnlyPath(root.toUpperCase())).toBe(true)
      expect(isNetworkOnlyPath(encodeURIComponent(root))).toBe(true)
      expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${root}` }), ORIGIN)).toBe(false)
    }

    for (const path of ['/download.zip', '/en/guide.js', '/en/guide%2Ejson']) {
      expect(isNetworkOnlyPath(path)).toBe(true)
      expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${path}` }), ORIGIN)).toBe(false)
    }

    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/%5Fapi/pages/7` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/%5Fassets/js/app.js` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/docs/../_api/pages/7` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/docs/../_assets/js/app.js` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/docs/../guide` }), ORIGIN)).toBe(true)

    expect(isNetworkOnlyPath('/_privateer/en/notes')).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/_privateer/en/notes` }), ORIGIN)).toBe(true)
  })

  test('rejects mutations, cross-origin requests, modules, non-HTML, and the shell itself', () => {
    expect(isAllowlistedNavigation(request({ method: 'POST' }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: 'https://other.example.test/en/guide' }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ mode: 'cors', url: `${ORIGIN}/en/guide.js`, destination: 'script' }, 'text/javascript'), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({}, 'application/json'), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({}, 'text/html; q=0'), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${OFFLINE_DOCUMENT_PATH}` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/download.zip` }), ORIGIN)).toBe(false)
  })

  test('allows only same-origin extensionless HTML document navigations', () => {
    expect(isAllowlistedNavigation(request(), ORIGIN)).toBe(true)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/` }), ORIGIN)).toBe(true)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/en/guide?section=intro#start` }), ORIGIN)).toBe(true)
  })

  test('allows only the exact device settings document within protected profile routes', () => {
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/p/offline` }), ORIGIN)).toBe(true)
    for (const path of ['/p/profile', '/p/offline/nested', '/p/offline?token=x', '/p/%6fffline']) {
      expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${path}` }), ORIGIN)).toBe(false)
    }
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/p/offline`, mode: 'cors' }), ORIGIN)).toBe(false)
  })

  test('matches only exact owned precache cache names', () => {
    const ownedName = `${PRECACHE_CACHE_PREFIX}0123456789abcdef`
    expect(isOwnedPrecacheCacheName(ownedName)).toBe(true)
    for (const name of [
      `${PRECACHE_CACHE_PREFIX}0123456789abcde`,
      `${PRECACHE_CACHE_PREFIX}0123456789abcdef0`,
      `${PRECACHE_CACHE_PREFIX}0123456789ABCDEf`,
      `${ownedName}-stale`,
      `other-${ownedName}`,
      'tsepistle-pwa-precache-v2-0123456789abcdef'
    ]) {
      expect(isOwnedPrecacheCacheName(name)).toBe(false)
    }
  })
})

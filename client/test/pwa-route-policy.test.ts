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

describe('PWA route policy', () => {
  test('recognizes HTML negotiation without allocating a header token list', () => {
    expect(acceptsHTML(request({}, 'text/html'))).toBe(true)
    expect(acceptsHTML(request({}, 'application/xhtml+xml, text/html; q=0.9'))).toBe(true)
    expect(acceptsHTML(request({}, 'application/json, text/plain'))).toBe(false)
    expect(acceptsHTML(request({}, 'text/htmlish'))).toBe(false)
  })

  test('keeps sensitive and non-document routes out of the fallback allowlist', () => {
    const networkOnlyPaths = [
      '/_api/pages/7',
      '/api/v1/pages/7',
      '/graphql',
      '/mcp/sessions',
      '/login',
      '/auth/callback',
      '/admin/workspace',
      '/_admin/users',
      '/setup',
      '/_private/en/notes',
      '/_assets/js/app.js'
    ]
    for (const path of networkOnlyPaths) {
      expect(isNetworkOnlyPath(path)).toBe(true)
      expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${path}` }), ORIGIN)).toBe(false)
    }

    expect(isNetworkOnlyPath('/_privateer/en/notes')).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/_privateer/en/notes` }), ORIGIN)).toBe(true)
  })

  test('rejects mutations, cross-origin requests, modules, non-HTML, and the shell itself', () => {
    expect(isAllowlistedNavigation(request({ method: 'POST' }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: 'https://other.example.test/en/guide' }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ mode: 'cors', url: `${ORIGIN}/en/guide.js`, destination: 'script' }, 'text/javascript'), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({}, 'application/json'), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}${OFFLINE_DOCUMENT_PATH}` }), ORIGIN)).toBe(false)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/download.zip` }), ORIGIN)).toBe(false)
  })

  test('allows only same-origin extensionless HTML document navigations', () => {
    expect(isAllowlistedNavigation(request(), ORIGIN)).toBe(true)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/` }), ORIGIN)).toBe(true)
    expect(isAllowlistedNavigation(request({ url: `${ORIGIN}/en/guide?section=intro#start` }), ORIGIN)).toBe(true)
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

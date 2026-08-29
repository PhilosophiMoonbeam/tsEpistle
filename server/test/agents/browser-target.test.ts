import { describe, expect, it } from '../bun-test.mts'
import { BrowserTargetError, parseCanonicalBrowserTarget } from '../../agents/browser/target.ts'

describe('canonical browser targets', () => {
  it('accepts only an exact WHATWG canonical serialization', () => {
    expect(parseCanonicalBrowserTarget('https://example.com/docs?a=one&b=two')).toEqual({ canonicalUrl: 'https://example.com/docs?a=one&b=two', scheme: 'https:', hostname: 'example.com', port: '', pathAndQuery: '/docs?a=one&b=two' })
  })

  it.each([
    'https://EXAMPLE.com/docs',
    'https://example.com:443/docs',
    'https://example.com./docs',
    'https://example.com',
    'https://user@example.com/docs',
    'https://example.com/docs#fragment',
    'https://example.com/a/../docs',
    'https://example.com/%2e%2e/secret',
    'https://example.com/a%2fb',
    'https://example.com/docs?a=1&a=2',
    'https://example.com/docs?q=%7e',
    'https:\\example.com\\docs',
    'ftp://example.com/docs'
  ])('rejects a noncanonical or unsafe target: %s', input => {
    expect(() => parseCanonicalBrowserTarget(input)).toThrow(BrowserTargetError)
  })
})

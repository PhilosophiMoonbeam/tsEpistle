import { describe, expect, it } from '../../server/test/bun-test.mts'
import { resolveLoginReturn, safeLoginReturn } from './login-return.ts'

describe('login return cookie boundary', () => {
  it('retains the canonical page, query and fragment for both login consumers', () => {
    const target = '/en/owned-ratings?view=source&term=hello%20world#section-two'
    expect(safeLoginReturn(target)).toBe(target)
    expect(resolveLoginReturn(target, '/en/home')).toBe(target)
    expect(resolveLoginReturn('/', '/en/home')).toBe('/en/home')
  })
  it.each([
    '/en/page?filter=100%25',
    '/en/page?reference=https%3A%2F%2Fexample.com',
    '/en/page?reference=https://example.com',
    '/en/page?path=%252f%255c#https%3A%2F%2Fexample.com',
    '/en/page?term=%E7%99%BE%E5%88%86%E6%AF%94#100%25'
  ])('preserves inert query and fragment bytes without changing navigation authority: %s', target => {
    expect(safeLoginReturn(target)).toBe(target)
    expect(resolveLoginReturn(target, '/en/home')).toBe(target)
  })
  for (const target of ['https://outside.test', '//outside.test', '/\\outside.test', '/%2foutside.test', '/%5coutside.test', '/%252foutside.test', '/bad%', '/%E0%A4', '/%0d%0aLocation:outside', '/\noutside', ' /en/page', '/a/..//outside.test']) {
    it(`refuses unsafe target ${JSON.stringify(target)} at producer and consumer`, () => {
      expect(safeLoginReturn(target)).toBeNull()
      expect(resolveLoginReturn(target, 'https://outside.test')).toBe('/')
    })
  }
  it('does not allow an invalid fallback to override a safe root', () => {
    expect(resolveLoginReturn('/', '//outside.test')).toBe('/')
    expect(resolveLoginReturn(undefined, '/en/home')).toBe('/en/home')
  })
})

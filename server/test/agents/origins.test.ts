import { describe, expect, it } from 'vitest'
import { canonicalMcpResource, requestOriginMatches } from '../../agents/origins.ts'

describe('Wiki origin policy', () => {
  it('derives the MCP resource from the canonical Wiki origin', () => {
    expect(canonicalMcpResource('https://wiki.example.test').href).toBe('https://wiki.example.test/mcp')
    expect(canonicalMcpResource('http://127.0.0.1:3000').href).toBe('http://127.0.0.1:3000/mcp')
  })

  it.each([
    'https://wiki.example.test/path',
    'https://wiki.example.test?query=1',
    'https://user@wiki.example.test',
    'http://wiki.example.test',
    'https://WIKI.example.test'
  ])('rejects a noncanonical or unsafe Wiki origin: %s', wikiPublicOrigin => {
    expect(() => canonicalMcpResource(wikiPublicOrigin)).toThrow()
  })

  it('accepts only the canonical same-origin request header', () => {
    expect(requestOriginMatches('https://wiki.example.test', 'https://wiki.example.test')).toBe(true)
    expect(requestOriginMatches('https://WIKI.example.test', 'https://wiki.example.test')).toBe(false)
    expect(requestOriginMatches('https://wiki.example.test/', 'https://wiki.example.test')).toBe(false)
    expect(requestOriginMatches(undefined, 'https://wiki.example.test')).toBe(false)
  })
})

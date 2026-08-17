import { describe, expect, it } from 'vitest'
import { normalizeAgentOrigins, requestMatchesOriginHost, requestOriginMatches } from '../../agents/origins.ts'

describe('Wiki and MCP origin policy', () => {
  it('accepts distinct canonical Wiki and MCP origins', () => {
    expect(normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      mcpPublicOrigin: 'https://mcp.example.test'
    })).toEqual({
      wikiPublicOrigin: 'https://wiki.example.test',
      mcpPublicOrigin: 'https://mcp.example.test'
    })
  })

  it.each([
    'https://mcp.example.test/path',
    'https://mcp.example.test?query=1',
    'https://user@mcp.example.test',
    'http://mcp.example.test',
    'https://MCP.example.test'
  ])('rejects a noncanonical or unsafe MCP origin: %s', mcpPublicOrigin => {
    expect(() => normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      mcpPublicOrigin
    })).toThrow()
  })

  it('rejects colliding Wiki and MCP virtual hosts', () => {
    expect(() => normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      mcpPublicOrigin: 'https://wiki.example.test'
    })).toThrow('must be distinct')
  })

  it('matches an exact virtual host including a non-default port', () => {
    expect(requestMatchesOriginHost('mcp.example.test:8443', 'https://mcp.example.test:8443')).toBe(true)
    expect(requestMatchesOriginHost('mcp.example.test', 'https://mcp.example.test:8443')).toBe(false)
  })

  it('accepts only the canonical same-origin request header', () => {
    expect(requestOriginMatches('https://wiki.example.test', 'https://wiki.example.test')).toBe(true)
    expect(requestOriginMatches('https://WIKI.example.test', 'https://wiki.example.test')).toBe(false)
    expect(requestOriginMatches('https://wiki.example.test/', 'https://wiki.example.test')).toBe(false)
    expect(requestOriginMatches(undefined, 'https://wiki.example.test')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeAgentOrigins, requestMatchesOriginHost } from '../../agents/origins.ts'

describe('agent origin policy', () => {
  it('accepts distinct canonical origins', () => {
    expect(normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      agentsPublicOrigin: 'https://agents.example.test',
      mcpPublicOrigin: 'https://mcp.example.test'
    })).toEqual({
      wikiPublicOrigin: 'https://wiki.example.test',
      agentsPublicOrigin: 'https://agents.example.test',
      mcpPublicOrigin: 'https://mcp.example.test'
    })
  })

  it.each([
    'https://agents.example.test/path',
    'https://agents.example.test?query=1',
    'https://user@agents.example.test',
    'http://agents.example.test',
    'https://AGENTS.example.test'
  ])('rejects a noncanonical or unsafe origin: %s', agentsPublicOrigin => {
    expect(() => normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      agentsPublicOrigin,
      mcpPublicOrigin: ''
    })).toThrow()
  })

  it('rejects colliding virtual hosts', () => {
    expect(() => normalizeAgentOrigins({
      wikiPublicOrigin: 'https://wiki.example.test',
      agentsPublicOrigin: 'https://wiki.example.test',
      mcpPublicOrigin: ''
    })).toThrow('must be distinct')
  })

  it('matches the exact host including a non-default port', () => {
    expect(requestMatchesOriginHost('agents.example.test:8443', 'https://agents.example.test:8443')).toBe(true)
    expect(requestMatchesOriginHost('agents.example.test', 'https://agents.example.test:8443')).toBe(false)
  })
})

import { describe, expect, it } from '../bun-test.mts'
import { loadWikiAgentSoul, WIKI_AGENT_SOUL } from '../../agents/soul.ts'

describe('Wiki Agent soul', () => {
  it('ships one concise, distinctive identity', () => {
    expect(WIKI_AGENT_SOUL).toMatch(/^# Identity\n\nYou are Wiki:/u)
    expect(WIKI_AGENT_SOUL).toContain('Stay quietly curious')
    expect(WIKI_AGENT_SOUL).toContain('Match the moment')
    expect(WIKI_AGENT_SOUL).toContain('Let warmth show through attention, not flattery.')
    expect(Buffer.byteLength(WIKI_AGENT_SOUL, 'utf8')).toBeLessThan(1_024)
  })

  it('normalizes ordinary text files without rewriting their voice', () => {
    expect(loadWikiAgentSoul('\uFEFF# Identity\r\n\r\nDirect and warm.\r\n')).toBe('# Identity\n\nDirect and warm.')
  })

  it.each([
    ['', 'must not be empty'],
    ['x'.repeat(4_097), 'exceeds 4096 bytes'],
    ['Calm\u0000voice', 'unsafe control text'],
    ['</system>', 'unsafe control text']
  ])('rejects an invalid soul', (source, message) => {
    expect(() => loadWikiAgentSoul(source)).toThrow(message)
  })
})

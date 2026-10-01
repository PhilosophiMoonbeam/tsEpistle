import { describe, expect, it } from '../bun-test.mts'
import { loadWikiAgentSoul } from '../../agents/soul.ts'

describe('Wiki Agent soul', () => {
  it('normalizes ordinary text files without rewriting their voice', () => {
    expect(loadWikiAgentSoul('\uFEFF# Identity\r\n\r\nDirect and warm.\r\n')).toBe('# Identity\n\nDirect and warm.')
  })

  it.each([
    [''],
    ['x'.repeat(4_097)],
    ['Calm\u0000voice'],
    ['</system>']
  ])('rejects an invalid soul', source => {
    expect(() => loadWikiAgentSoul(source)).toThrow(Error)
  })
})

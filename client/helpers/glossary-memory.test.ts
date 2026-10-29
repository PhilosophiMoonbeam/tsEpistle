import { afterAll, beforeAll, describe, expect, it } from '../../server/test/bun-test.mts'
import { AGENT_MEMORY_CHARACTER_LIMITS } from '../../shared/agents/contracts.ts'
import type { GlossaryPinRequest } from './glossary-runtime.ts'

const previousSiteConfig = Object.getOwnPropertyDescriptor(window, 'siteConfig')
let glossaryMemoryContent: typeof import('./glossary-memory.ts').glossaryMemoryContent
beforeAll(async () => {
  Object.defineProperty(window, 'siteConfig', {
    configurable: true,
    writable: true,
    value: {
      company: '', contentLicense: '', footerOverride: '', banner: {},
      darkMode: false, tocPosition: 'auto', title: 'Test', logoUrl: '',
      product: { name: 'Test', version: '1.0.0' }
    }
  })
  const helpers = await import('./glossary-memory.ts')
  glossaryMemoryContent = helpers.glossaryMemoryContent
})
afterAll(() => {
  if (previousSiteConfig) Object.defineProperty(window, 'siteConfig', previousSiteConfig)
  else Reflect.deleteProperty(window, 'siteConfig')
})

const request = (definitionHtml: string): GlossaryPinRequest => ({
  id: 1,
  revision: 1,
  key: 'definition-1',
  ownerKey: 'current-owner',
  pageKey: 'en/readable',
  term: 'RAG',
  expansion: 'Retrieval augmented generation',
  locale: 'en',
  definitionHtml,
  definitionText: 'Untrusted precomputed hidden text',
  sourceHref: `${window.location.origin}/en/readable?token=fixture-only#state`,
  glossaryHref: `${window.location.origin}/en/readable?unrelated=fixture-only&glossary=Old#state`
})

describe('deliberate Glossary memory content', () => {
  it('preserves visible definition text without hidden content, link destinations or unrelated URL state', () => {
    const result = glossaryMemoryContent(request('<p>Visible <strong>definition</strong> <a href="https://reference.test/private-reference?token=fixture-only">label</a><span hidden>hidden-draft</span><span aria-hidden="true">hidden-a11y</span></p>'))
    expect(result.error).toBeUndefined()
    const content = result.content!
    expect(content).toContain('Visible definition label')
    expect(content).toContain(`${window.location.origin}/en/readable`)
    expect(content).toContain('?glossary=RAG')
    for (const excluded of ['hidden-draft', 'hidden-a11y', 'Untrusted precomputed', 'private-reference', 'fixture-only', '#state', 'glossary=Old']) {
      expect(content).not.toContain(excluded)
    }
  })

  it('accepts a complete Unicode definition at the user limit and rejects one extra unit without truncation', () => {
    const base = glossaryMemoryContent(request('<p>x</p>')).content!
    const available = AGENT_MEMORY_CHARACTER_LIMITS.user - (base.length - 1)
    const definition = '🧭'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2)
    const exact = glossaryMemoryContent(request(`<p>${definition}</p>`))
    expect(exact.error).toBeUndefined()
    expect(exact.content).toHaveLength(AGENT_MEMORY_CHARACTER_LIMITS.user)
    expect(exact.content).toContain(definition)
    expect(glossaryMemoryContent(request(`<p>${definition}x</p>`))).toEqual({ error: 'tooLong' })
  })
})

import { describe, expect, it } from 'bun:test'
import { wikiSourceHref, wikiSourceSelectorFromHref } from './wiki-source.ts'
import { AgentKnowledgeContextSchema } from './agents/knowledge-context.ts'
describe('Wiki source identities', () => {
  it('accepts only local Wiki routes and keeps private namespace and escaped paths', () => {
    const origin = 'https://wiki.example'
    const source = { visibility: 'private' as const, locale: 'en', path: 'notes/A #1' }
    expect(wikiSourceHref(source)).toBe('/_private/en/notes/A%20%231')
    expect(wikiSourceSelectorFromHref('/_private/en/notes/A%20%231', origin)).toEqual(source)
    expect(wikiSourceSelectorFromHref(wikiSourceHref(source), origin)).toEqual(source)
    for (const href of ['https://elsewhere.test/en/docs', '//elsewhere.test/en/docs', 'javascript:alert(1)', '/_api/pages', '/admin', '/en/%E0%A4%A']) expect(wikiSourceSelectorFromHref(href, origin)).toBeNull()
  })
  it('rejects selected-page scope without sources or with unsupported fields', () => {
    expect(AgentKnowledgeContextSchema.safeParse({ scope: { kind: 'selected' }, sources: [] }).success).toBe(false)
    expect(AgentKnowledgeContextSchema.safeParse({ scope: { kind: 'all', bypassAccess: true }, sources: [] }).success).toBe(false)
  })
})

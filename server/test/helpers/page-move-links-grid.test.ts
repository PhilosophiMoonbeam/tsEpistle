import { describe, expect, it } from '../bun-test.mts'
import { rewriteMovedPageLinks, type PageMoveLinkRewriteInput } from '../../helpers/page-move-link-rewrite.ts'

const body = '{"key":"links-grid","version":1,"props":{"cards":[{"title":"Old","url":"/en/old?view=full#part","description":"Keep /en/old unchanged","tags":["unchanged"]},{"title":"Other locale","url":"/fr/old"},{"title":"Other page","url":"/en/other"}]}}'
const source = `Before /en/old\n\n\`\`\`wiki-extension\n${body}\n\`\`\`\n\nAfter\n`
const input = (overrides: Partial<PageMoveLinkRewriteInput> = {}): PageMoveLinkRewriteInput => ({
  source, editor: 'markdown', oldTarget: { locale: 'en', path: 'old' }, newTarget: { locale: 'fr', path: 'new' },
  sourcePage: { locale: 'en', path: 'reference' }, defaultLocale: 'en', namespaced: true,
  absoluteLinks: false, markdownAllowHTML: true, wikiLinksEnabled: false, linksGridEnabled: true, ...overrides
})

describe('reviewed canonical links-grid source repair', () => {
  it('changes only the matching card URL token, preserving other cards, fields, prose and suffixes', () => {
    const result = rewriteMovedPageLinks(input())
    expect(result.source).toBe(source.replace('"url":"/en/old?view=full#part"', '"url":"/fr/new?view=full#part"'))
    expect(result.changes).toEqual([{ before: '"/en/old?view=full#part"', after: '"/fr/new?view=full#part"' }])
    expect(result.unsupported).toBe(0)
  })

  it('keeps private page routes distinct rather than treating their path as a public target', () => {
    const privateSource = source.replace('/en/old?view=full#part', '/private/en/old?view=full#part')
    expect(rewriteMovedPageLinks(input({ source: privateSource })).source).toBe(privateSource)
  })

  it('retains exact identities for later and repeated cards even when titles resemble JSON properties', () => {
    const cards = [
      { title: '\"url\":\"/en/old\"', url: '/en/other', description: '/en/old' },
      { title: 'Second', url: '/en/old#second' },
      { title: 'Third', url: '/en/old#third' }
    ]
    const repeated = `\`\`\`wiki-extension\n${JSON.stringify({ key: 'links-grid', version: 1, props: { cards } })}\n\`\`\`\n`
    const result = rewriteMovedPageLinks(input({ source: repeated }))
    expect(result.source).toBe(repeated.replace('\"url\":\"/en/old#second\"', '\"url\":\"/fr/new#second\"').replace('\"url\":\"/en/old#third\"', '\"url\":\"/fr/new#third\"'))
    expect(result.changes).toHaveLength(2)
  })

  it('fails closed when disabled, malformed, noncanonical, or nested source has no exact offsets', () => {
    const cases = [
      input({ linksGridEnabled: false }),
      input({ source: source.replace('"version":1', '"version":2') }),
      input({ source: source.replace('"cards":', '"cards": ') }),
      input({ source: source.split('\n').map(line => `> ${line}`).join('\n') })
    ]
    for (const candidate of cases) {
      const result = rewriteMovedPageLinks(candidate)
      expect(result.source).toBe(candidate.source)
      expect(result.changes).toEqual([])
      expect(result.unsupported).toBeGreaterThan(0)
    }
  })

  it('does not repair arbitrary JSON fences', () => {
    const example = source.replace('wiki-extension', 'json')
    expect(rewriteMovedPageLinks(input({ source: example })).source).toBe(example)
  })
})

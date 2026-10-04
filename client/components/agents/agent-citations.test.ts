import { describe, expect, it } from '../../../server/test/bun-test.mts'

import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { createAgentCitationResolver, formatAgentCitationMarkers } from './agent-citations.ts'

const citations: readonly AgentCitation[] = [
  { evidenceId: 'page:42:section:2', kind: 'page', label: 'Guide › Installation', href: '/en/guide#installation' },
  { evidenceId: 'page:43', kind: 'page', label: 'Operations', href: '/en/operations' }
]

describe('Agent answer citations', () => {
  it('places numbered deep links beside the supported answer text', () => {
    const formatted = formatAgentCitationMarkers('Install the package.[[cite:page:42:section:2]] Then verify it.[[cite:page:43]]', citations)
    const rendered = renderSafeMarkdown(formatted)

    expect(rendered).toContain('href="/en/guide#installation"')
    expect(rendered).toContain('title="Citation 1: Guide › Installation"')
    expect(rendered).toContain('>1</a>')
    expect(rendered).toContain('href="/en/operations"')
    expect(rendered).toContain('title="Citation 2: Operations"')
  })

  it('removes unverified markers and reuses a source number for repeated evidence', () => {
    const formatted = formatAgentCitationMarkers('One.[[cite:page:42:section:2]] Two.[[cite:unknown]] Three.[[cite:page:42:section:2]]', citations)

    expect(formatted.match(/Citation 1:/g)).toHaveLength(2)
    expect(formatted).not.toContain('unknown')
    expect(formatted).not.toContain('[[cite:')
  })

  it('rejects the same unsafe citation links in displayed and copied answers without renumbering sources', () => {
    const unsafeHrefs = ['/en/"quoted', "/en/'quoted", '//outside.example/guide', 'javascript:alert(1)', '/en/guide\u0000']
    const sources: readonly AgentCitation[] = [
      ...unsafeHrefs.map((href, index) => ({ evidenceId: `unsafe:${index}`, kind: 'page' as const, label: `Unsafe ${index}`, href })),
      { evidenceId: 'safe', kind: 'page', label: 'Safe guide', href: '/en/guide_(install)#setup' },
      { evidenceId: 'safe', kind: 'page', label: 'Duplicate', href: 'javascript:alert(2)' }
    ]
    const content = sources
      .slice(0, -1)
      .map(source => `[[cite:${source.evidenceId}]]`)
      .join(' ')
    const resolver = createAgentCitationResolver(sources)
    const displayed = renderSafeMarkdown(content, { resolveCitation: resolver })
    const copied = formatAgentCitationMarkers(content, resolver)

    for (const [index, href] of unsafeHrefs.entries()) {
      expect(resolver(`unsafe:${index}`)?.href).toBeNull()
      expect(displayed).toContain(`>[${index + 1}]</strong>`)
      expect(copied).toContain(`**[${index + 1}]**`)
      // Custom resolvers must not bypass the renderer's independent safety fence.
      const custom = () => ({ number: index + 1, label: 'Unsafe', href })
      expect(renderSafeMarkdown('[[cite:custom]]', { resolveCitation: custom })).not.toContain('<a ')
      expect(formatAgentCitationMarkers('[[cite:custom]]', custom)).toBe(`**[${index + 1}]**`)
    }
    expect(displayed.match(/<a /g)).toHaveLength(1)
    expect(displayed).toContain('href="/en/guide_(install)#setup"')
    expect(displayed).toContain('>6</a>')
    expect(copied).toContain('[6](/en/guide_%28install%29#setup')
    expect(resolver('safe')?.label).toBe('Safe guide')
  })
})

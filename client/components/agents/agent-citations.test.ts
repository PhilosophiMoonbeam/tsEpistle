import { describe, expect, it } from '../../../server/test/bun-test.mts'

import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { formatAgentCitationMarkers } from './agent-citations.ts'

const citations: readonly AgentCitation[] = [
  { evidenceId: 'page:42:section:2', kind: 'page', label: 'Guide › Installation', href: '/en/guide#installation' },
  { evidenceId: 'page:43', kind: 'page', label: 'Operations', href: '/en/operations' }
]

describe('Agent answer citations', () => {
  it('places numbered deep links beside the supported answer text', () => {
    const formatted = formatAgentCitationMarkers(
      'Install the package.[[cite:page:42:section:2]] Then verify it.[[cite:page:43]]',
      citations
    )
    const rendered = renderSafeMarkdown(formatted)

    expect(rendered).toContain('href="/en/guide#installation"')
    expect(rendered).toContain('title="Citation 1: Guide › Installation"')
    expect(rendered).toContain('>1</a>')
    expect(rendered).toContain('href="/en/operations"')
    expect(rendered).toContain('title="Citation 2: Operations"')
  })

  it('removes unverified markers and reuses a source number for repeated evidence', () => {
    const formatted = formatAgentCitationMarkers(
      'One.[[cite:page:42:section:2]] Two.[[cite:unknown]] Three.[[cite:page:42:section:2]]',
      citations
    )

    expect(formatted.match(/Citation 1:/g)).toHaveLength(2)
    expect(formatted).not.toContain('unknown')
    expect(formatted).not.toContain('[[cite:')
  })
})

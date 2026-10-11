import { describe, expect, it } from '../../server/test/bun-test.mts'

import { renderSafeMarkdown } from './safe-markdown.ts'
import { parseSourceDocument } from '../../server/agents/providers/source-document.ts'
import { renderWikiSynthesisAnswer } from '../../server/agents/providers/wiki-synthesis.ts'

describe('safe markdown rendering', () => {
  it('renders markdown links with isolated new-tab behavior', () => {
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown('Read the [status page](https://status.example.com).')
    const link = container.querySelector('a')

    expect(link?.getAttribute('href')).toBe('https://status.example.com')
    expect(link?.textContent).toBe('status page')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.relList.contains('noopener')).toBe(true)
    expect(link?.relList.contains('noreferrer')).toBe(true)
  })

  it('does not render raw HTML or unsafe link protocols', () => {
    const rawHtml = '<img src=x onerror=alert(1)>'
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(`${rawHtml} [run](javascript:alert(1))`)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.textContent).toContain(rawHtml)
  })

  it('retains quoted source identities and conditions without activating author punctuation', () => {
    const original = parseSourceDocument('# \\!\\[Catalog](https://example.invalid/catalog.png)\n\n- \\!\\[Alpha](https://example.invalid/alpha.png)\n\nOnly after \\!\\[Approval](https://example.invalid/approval.png), using `Prepared base`.\n', { representation: 'markdown', truncated: false })
    const subject = original.contexts.find(context => context.kind === 'heading' && context.parentId === null)!.normalizedLabel
    const entry = original.units.find(unit => unit.kind === 'list-item')!
    const note = original.units.find(unit => unit.normalizedText.startsWith('Only after'))!
    const evidenceId = 'page:75:revision:3'
    const container = document.createElement('div')
    const statements = [`${subject}: ${entry.normalizedText}`, note.normalizedText]
    container.innerHTML = renderSafeMarkdown(renderWikiSynthesisAnswer({
      claims: [
        { evidenceId, sourceRevision: '3', unitId: entry.id, statement: statements[0]! },
        { evidenceId, sourceRevision: '3', unitId: note.id, statement: statements[1]! }
      ],
      observations: [], unresolvedFacets: []
    }, new Set(statements)), { resolveCitation: id => id === evidenceId ? { evidenceId, number: 1, label: 'Catalog source', href: '/en/catalog' } : null })
    expect(container.textContent).toContain(subject)
    expect(container.textContent).toContain(entry.normalizedText)
    expect(container.textContent).toContain(note.normalizedText)
    expect(container.querySelector('img')).toBeNull()
    expect([...container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual(['/en/catalog', '/en/catalog'])
  })

  it('preserves exact quoted glyphs without disabling validated generated Markdown', () => {
    const quoted = 'Name: _Alpha_ | Condition: ![approval](/approval)'
    const evidenceId = 'page:75:revision:3'
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(renderWikiSynthesisAnswer({
      claims: [
        { evidenceId, sourceRevision: '3', unitId: 'unit:quoted', statement: quoted },
        { evidenceId, sourceRevision: '3', unitId: 'unit:generated', statement: 'Additional *context*.' }
      ],
      observations: [], unresolvedFacets: []
    }, new Set([quoted])))
    expect(container.textContent).toContain(quoted)
    expect(container.querySelector('img')).toBeNull()
    expect([...container.querySelectorAll('em')].map(element => element.textContent)).toEqual(['context'])
  })
})

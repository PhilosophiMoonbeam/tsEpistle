import { describe, expect, it } from '../../server/test/bun-test.mts'

import { renderSafeMarkdown } from './safe-markdown.ts'
import { parseSourceDocument } from '../../server/agents/providers/source-document.ts'
import { escapeWikiSourceText, renderWikiSynthesisAnswer } from '../../server/agents/providers/wiki-synthesis.ts'

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

  it('displays CommonMark source escapes as literal text during streaming and after completion', () => {
    const source = '# Recipe ! " $ % & \' ( ) * + , - . / : ; < = > ? @ [ \\ ] ^ _ ` { | } ~\n[run](javascript:alert(1)) <img src=x onerror=alert(1)> [[cite:source]] \\A'
    for (const streaming of [true, false]) {
      const container = document.createElement('div')
      container.innerHTML = renderSafeMarkdown(`${escapeWikiSourceText(source)}\n\n[[cite:verified]]`, {
        streaming,
        resolveCitation: evidenceId => ({ evidenceId, number: 1, label: 'Verified source', href: '/en/catalog' })
      })

      expect(container.textContent?.replaceAll('\n', '')).toContain(source.replaceAll('\n', ''))
      expect(container.querySelector('h1, em, strong, code, img')).toBeNull()
      expect([...container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual(['/en/catalog'])
      expect(container.querySelectorAll('[data-agent-citation]').length).toBe(1)
    }
  })

  it('keeps backslashes and citation-like text verbatim inside code while streaming', () => {
    const inline = String.raw`\*literal\* \\ [[cite:inline]]`
    const fenced = String.raw`\# literal \\ [[cite:fenced]]`
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(`\`${inline}\`\n\n\`\`\`text\n${fenced}\n\`\`\`\n\nPending [[cite:partial`, {
      streaming: true,
      resolveCitation: evidenceId => ({ evidenceId, number: 1, label: 'Source', href: '/en/catalog' })
    })

    expect([...container.querySelectorAll('code')].map(element => element.textContent)).toEqual([inline, `${fenced}\n`])
    expect(container.querySelector('[data-agent-citation]')).toBeNull()
    expect(container.textContent).toContain('Pending ')
    expect(container.textContent).not.toContain('[[cite:partial')
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

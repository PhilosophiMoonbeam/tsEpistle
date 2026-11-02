import { describe, expect, it } from '../../server/test/bun-test.mts'

import { renderSafeMarkdown } from './safe-markdown.ts'

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
    const source = '# Recipe [run](javascript:alert(1)) <img src=x onerror=alert(1)> [[cite:source]] \\A'
    const escapedSource = String.raw`\# Recipe \[run\]\(javascript:alert\(1\)\) \<img src=x onerror=alert\(1\)\> \[\[cite:source\]\] \\A`
    for (const streaming of [true, false]) {
      const container = document.createElement('div')
      container.innerHTML = renderSafeMarkdown(`${escapedSource}\n\n[[cite:verified]]`, {
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

  it('preserves explicit literal glyphs without disabling generated Markdown', () => {
    const quoted = 'Name: _Alpha_ | Condition: ![approval](/approval)'
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(String.raw`Name: \_Alpha\_ | Condition: \!\[approval\]\(/approval\)

Additional *context*.`)
    expect(container.textContent).toContain(quoted)
    expect(container.querySelector('img')).toBeNull()
    expect([...container.querySelectorAll('em')].map(element => element.textContent)).toEqual(['context'])
  })

  it('keeps detached citation paragraphs intact unless the Agent explicitly opts in', () => {
    const content = 'Supported answer.\n\n[[cite:verified]]'
    const resolveCitation = (evidenceId: string) => (evidenceId === 'verified' ? { evidenceId, number: 1, label: 'Verified source', href: '/en/guide' } : null)
    for (const options of [undefined, { resolveCitation }, { normalizeCitationParagraphs: true }]) {
      const container = document.createElement('div')
      container.innerHTML = renderSafeMarkdown(content, options)
      expect(container.querySelectorAll(':scope > p')).toHaveLength(2)
      expect(container.querySelector('p')?.textContent).toBe('Supported answer.')
    }
  })

  it('attaches resolved citation-only paragraphs to adjacent Agent prose without reordering sources', () => {
    const resolveCitation = (evidenceId: string) => ({
      evidenceId,
      number: evidenceId === 'first' ? 1 : 2,
      label: evidenceId,
      href: `/en/${evidenceId}`
    })
    for (const streaming of [false, true]) {
      for (const content of [
        'Answer.\n\n[[cite:first]]\n[[cite:second]]',
        '[[cite:first]] [[cite:second]]\n\nAnswer.',
        '# Answer.\n\n[[cite:first]]\n\n[[cite:second]]'
      ]) {
        const container = document.createElement('div')
        container.innerHTML = renderSafeMarkdown(content, { resolveCitation, streaming, normalizeCitationParagraphs: true })
        expect(container.children).toHaveLength(1)
        expect(container.firstElementChild?.textContent).toBe('Answer.12')
        expect([...container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual(['/en/first', '/en/second'])
      }
    }
  })

  it('preserves authored link labels containing resolved citation markers with and without Agent normalization', () => {
    const resolveCitation = (evidenceId: string) => ({ evidenceId, number: 1, label: 'Guide', href: '/en/guide' })
    for (const normalizeCitationParagraphs of [false, true]) {
      for (const authoredLink of ['[[[cite:verified]]](/en/authored)', '[[[cite:verified]]][authored]\n\n[authored]: /en/authored']) {
        const container = document.createElement('div')
        container.innerHTML = renderSafeMarkdown(`Answer.\n\n${authoredLink}`, { resolveCitation, normalizeCitationParagraphs })

        expect(container.querySelectorAll(':scope > p')).toHaveLength(2)
        expect(container.querySelector('p')?.textContent).toBe('Answer.')
        expect(container.querySelectorAll('a')).toHaveLength(1)
        const anchor = container.querySelector('a')
        expect(anchor?.getAttribute('href')).toBe('/en/authored')
        expect(anchor?.textContent).toBe('[[cite:verified]]')
        expect(container.querySelector('[data-agent-citation]')).toBeNull()
      }
    }
  })

  it('does not relocate unresolved, escaped, authored-link or structured citation content', () => {
    const resolveCitation = (evidenceId: string) => (evidenceId === 'verified' ? { evidenceId, number: 1, label: 'Guide', href: '/en/guide' } : null)
    const cases = [
      { content: 'Answer.\n\n[[cite:missing]] [[cite:verified]]', selector: ':scope > p:last-child', text: '[[cite:missing]] 1' },
      {
        content: String.raw`Answer.

\[\[cite:verified\]\]`,
        selector: ':scope > p:last-child',
        text: '[[cite:verified]]'
      },
      { content: 'Answer.\n\n`[[cite:verified]]`', selector: 'code', text: '[[cite:verified]]' },
      { content: 'Answer.\n\n```\n[[cite:verified]]\n```', selector: 'pre code', text: '[[cite:verified]]\n' },
      { content: 'Answer.\n\n- [[cite:verified]]', selector: 'li', text: '1' },
      { content: 'Answer.\n\n> [[cite:verified]]', selector: 'blockquote p', text: '1' },
      { content: 'Answer.\n\n| Source |\n| --- |\n| [[cite:verified]] |', selector: 'td', text: '1' },
      { content: 'Answer.\n\n[1](/en/guide)', selector: ':scope > p:last-child', text: '1' },
      { content: 'Answer.\n\n[[[cite:verified]]](/en/authored)', selector: ':scope > p:last-child', text: '[[cite:verified]]' },
      { content: 'Answer.\n\nExplanation [[cite:verified]]', selector: ':scope > p:last-child', text: 'Explanation 1' }
    ]
    for (const { content, selector, text } of cases) {
      const container = document.createElement('div')
      container.innerHTML = renderSafeMarkdown(content, { resolveCitation, normalizeCitationParagraphs: true })
      expect(container.firstElementChild?.textContent).toBe('Answer.')
      expect(container.querySelector(selector)?.textContent).toBe(text)
      expect(container.children.length).toBeGreaterThan(1)
    }
  })
})

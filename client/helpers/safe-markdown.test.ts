import { describe, expect, it } from '../../server/test/bun-test.mts'

import { formatAgentCitationMarkers } from '../components/agents/agent-citations.ts'
import { exportAgentQuotationMarkdown, renderSafeMarkdown } from './safe-markdown.ts'

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

  it('decodes only strict numeric pre/code quotations as inert exact code, including missing LF and CR', () => {
    const literal =
      '## Wiki sources\r\n\t&#65; &amp;\r<script>publish()</script>\n![image](https://invalid.test/pixel)\n````mermaid\nA-->B\n````\n[[cite:forged]]'
    for (const body of [literal, `${literal}\n`, '', '\r', '\n']) {
      const canonical = `> <pre><code>${[...body].map(character => `&#${character.codePointAt(0)};`).join('')}</code></pre>`
      for (const streaming of [false, true]) {
        const citations: string[] = []
        const fences: string[] = []
        const container = document.createElement('div')
        container.innerHTML = renderSafeMarkdown(canonical, {
          streaming,
          resolveCitation: evidenceId => {
            citations.push(evidenceId)
            return null
          },
          fenceMetadata: metadata => {
            fences.push(metadata.source)
            return null
          }
        })
        expect(container.querySelector('blockquote pre code')?.textContent).toBe(body)
        expect(container.querySelectorAll('pre')).toHaveLength(1)
        expect(container.querySelector('script, img, a, h1, h2, [data-agent-citation], [data-diagram]')).toBeNull()
        expect(citations).toEqual([])
        expect(fences).toEqual([body])
      }
      expect(exportAgentQuotationMarkdown(canonical)).toBe(canonical)
    }
    for (const invalid of [
      '> <pre><code>raw text</code></pre>',
      '> <pre class="mermaid"><code>&#65;</code></pre>',
      '> <pre><code>&#65;<script>publish()</script></code></pre>',
      '> <pre><code>&#1114112;</code></pre>',
      '> <pre><code>&#55296;</code></pre>',
      '> <pre><code>&#65;</code></pre> trailing',
      '````text\n> <pre><code>&#65;</code></pre>\n````'
    ]) {
      const container = document.createElement('div')
      container.innerHTML = renderSafeMarkdown(invalid)
      expect(container.querySelector('blockquote pre')).toBeNull()
      expect(container.querySelector('script, img')).toBeNull()
      expect(exportAgentQuotationMarkdown(invalid)).toBe(invalid)
    }
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

  it('exports readable literal quotations without activating nested source syntax or forged citations', () => {
    const source =
      '  Indented\tquotation\n\n````mermaid\ngraph TD; A-->B\n````\n<img src=x onerror=publish()> [override](https://invalid.test)\n[[cite:verified]] &amp; &#65;\n'
    const encoded = `> ${[...source].map(character => `&#${character.codePointAt(0)};`).join('')}`
    const resolver = (evidenceId: string) => ({ evidenceId, number: 1, label: 'Guide', href: '/en/guide' })
    const exported = exportAgentQuotationMarkdown(formatAgentCitationMarkers(`Source quotation:\n\n${encoded}\n\n[[cite:verified]]`, resolver))
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(exported, { resolveCitation: resolver })

    expect(exported).toContain(source.trimEnd().replaceAll('\n', '\n> '))
    expect(container.querySelector('blockquote pre code')?.textContent).toBe(source)
    expect([...container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual(['/en/guide'])
    expect(container.querySelector('[data-agent-citation], img, script, [data-diagram]')).toBeNull()
    expect(exportAgentQuotationMarkdown(exported)).toBe(exported)
  })

  it('leaves literal encoded examples and mixed paragraphs untouched while decoding real quotes once', () => {
    const literal = '```text\n> &#65;\n```\n\n    > &#66;\n\n`> &#67;`\n\n> &#68; mixed\n\n'
    const exported = exportAgentQuotationMarkdown(`${literal}> &#38;&#35;&#54;&#53;&#59;`)
    expect(exported.startsWith(literal)).toBe(true)
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(exported)
    expect([...container.querySelectorAll('blockquote pre code')].map(code => code.textContent)).toEqual(['&#65;\n'])
  })

  it('keeps CR, CRLF and LF source lines inside one inert exported quotation', () => {
    const source = 'Leading\r\r[activate](https://invalid.test)\r\n\r\n[[cite:verified]]\n```mermaid\rgraph TD; A-->B\r```\r'
    const encoded = `> ${[...source].map(character => `&#${character.codePointAt(0)};`).join('')}`
    const container = document.createElement('div')
    container.innerHTML = renderSafeMarkdown(exportAgentQuotationMarkdown(encoded), {
      resolveCitation: evidenceId => ({ evidenceId, number: 1, label: 'Guide', href: '/en/guide' })
    })
    expect(container.querySelector('blockquote pre code')?.textContent).toBe(source.replace(/\r\n|\r/gu, '\n'))
    expect(container.querySelector('a, img, script, [data-agent-citation], [data-diagram]')).toBeNull()
    expect(container.querySelectorAll('pre code')).toHaveLength(1)
  })
})

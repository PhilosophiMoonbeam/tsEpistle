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
})

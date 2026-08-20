import { describe, expect, it } from 'vitest'

import { renderSafeMarkdown } from './safe-markdown.ts'

describe('safe markdown rendering', () => {
  it('renders markdown links with isolated new-tab behavior', () => {
    expect(renderSafeMarkdown('Read the [status page](https://status.example.com).')).toContain(
      '<a href="https://status.example.com" rel="noopener noreferrer" target="_blank">status page</a>'
    )
  })

  it('does not render raw HTML or unsafe link protocols', () => {
    const rendered = renderSafeMarkdown('<img src=x onerror=alert(1)> [run](javascript:alert(1))')

    expect(rendered).not.toContain('<img ')
    expect(rendered).not.toContain('href=')
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

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
})

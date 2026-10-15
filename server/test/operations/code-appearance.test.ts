import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../bun-test.mts'
import { applyCodeTheme, renderCodeThemePreview } from '../../../client/helpers/code-appearance.ts'
import { themePolicyFromConfiguration } from '../../../shared/theme-policy.ts'

describe('native Prism code appearance', () => {
  it('normalizes legacy configuration and scopes a draft without mutating the published theme or installing styles', () => {
    const dom = new JSDOM('<html><head></head><body><section class="preview" data-unrelated="retained"></section></body></html>')
    try {
      const doc = dom.window.document
      const root = doc.documentElement
      const preview = doc.querySelector<HTMLElement>('.preview')!
      applyCodeTheme('midnight', root)
      applyCodeTheme('paper', preview)
      expect(root.getAttribute('data-wiki-code-theme')).toBe('midnight')
      expect(preview.getAttribute('data-wiki-code-theme')).toBe('paper')
      applyCodeTheme('https://example.invalid/style.css', preview)
      expect(preview.getAttribute('data-wiki-code-theme')).toBe('native')
      expect(preview.getAttribute('data-unrelated')).toBe('retained')
      expect(root.getAttribute('data-wiki-code-theme')).toBe('midnight')
      expect(doc.querySelectorAll('style, link')).toHaveLength(0)
      expect(themePolicyFromConfiguration({}).codeTheme).toBe('native')
      expect(themePolicyFromConfiguration({ theming: { codeTheme: 'unknown' } }).codeTheme).toBe('native')
    } finally {
      dom.window.close()
    }
  })

  it('renders real JavaScript tokens and withholds cancelled lazy results', async () => {
    const cancelled = new AbortController()
    const pending = renderCodeThemePreview(cancelled.signal)
    cancelled.abort()
    expect(await pending).toBeNull()
    const html = await renderCodeThemePreview(new AbortController().signal)
    const dom = new JSDOM(`<pre><code>${html}</code></pre>`)
    try {
      const code = dom.window.document.querySelector('code')!
      expect(code.querySelector('.token.keyword')?.textContent).toBe('const')
      expect(code.querySelector('.token.number')?.textContent).toBe('42')
      expect(code.querySelector('.token.function')?.textContent).toBe('describePage')
      expect(code.textContent).toContain('console.log(describePage(page));')
      expect(code.textContent).toContain(`\${current.title}`)
      expect(code.querySelector('script, style, link')).toBeNull()
    } finally {
      dom.window.close()
    }
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    expect(await renderCodeThemePreview(alreadyCancelled.signal)).toBeNull()
  })
})

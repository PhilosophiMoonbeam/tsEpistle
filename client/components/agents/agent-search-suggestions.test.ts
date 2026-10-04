import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { resetBody } from '../../test/browser-dom.mts'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { translateEnglish } from '../../test/english-translate.mts'

resetBody()

// Vuetify snapshots browser capabilities, so it must load after resetBody.
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
Bun.plugin({
  name: 'agent-search-suggestions-real-sfc',
  setup(builder) {
    builder.onLoad({ filter: /agent-search-suggestions\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'agent-search-suggestions-security',
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
// The test SFC loader must be installed before importing this component.
const AgentSearchSuggestions = (await import('./agent-search-suggestions.vue')).default

const renderSuggestions = async (suggestions: readonly string[]): Promise<string> => {
  const app = Vue.createSSRApp(AgentSearchSuggestions, { suggestions })
  app.use(createVuetify({ components: vuetifyComponents, ssr: true }))
  app.config.globalProperties.$t = translateEnglish
  return renderToString(app)
}

describe('Google Search suggestion isolation', () => {
  it('keeps provider HTML in a scriptless opaque-origin frame with a restrictive CSP', async () => {
    const providerHtml = '<a href="https://google.example/search?q=safe">Search</a><script>globalThis.pwned = true</script>'
    const rendered = await renderSuggestions([providerHtml])
    const document = new JSDOM(rendered).window.document
    const frame = document.querySelector('iframe')
    if (!frame) throw new Error('Search suggestion frame was not rendered')

    const sandbox = frame.getAttribute('sandbox') ?? ''
    expect(new Set(sandbox.trim().split(/\s+/))).toEqual(new Set(['allow-popups', 'allow-popups-to-escape-sandbox']))
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(document.querySelector('script')).toBeNull()

    const isolatedDocument = frame.getAttribute('srcdoc') ?? ''
    const isolatedDom = new JSDOM(isolatedDocument)
    const isolated = isolatedDom.window.document
    const policy = isolated.head.querySelector('meta[http-equiv="Content-Security-Policy" i]')
    if (!policy) throw new Error('The suggestion document is missing an effective head CSP meta')
    const directives = new Map<string, string[]>()
    for (const directive of (policy.getAttribute('content') ?? '').split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      // Browsers honor the first occurrence of each directive, not a later replacement.
      if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources)
    }
    for (const directive of ['default-src', 'script-src', 'connect-src', 'form-action', 'base-uri']) {
      expect(directives.get(directive)).toEqual(["'none'"])
    }
    for (const selector of ['a[href="https://google.example/search?q=safe"]', 'script']) {
      const providerContent = isolated.querySelector(selector)
      if (!providerContent) throw new Error(`Provider content is missing from the isolated document: ${selector}`)
      expect(policy.compareDocumentPosition(providerContent) & isolatedDom.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    }
    expect(document.querySelector('a[href="https://google.example/search?q=safe"]')).toBeNull()
    isolatedDom.window.close()
    expect(isolatedDocument).toContain(providerHtml)
  })
})

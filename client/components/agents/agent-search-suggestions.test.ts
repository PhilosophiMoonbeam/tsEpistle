import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/agents/agent-search-suggestions.vue')
const source = readFileSync(componentPath, 'utf8')
const descriptor = parse(source, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('Search suggestions component is incomplete')
const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'agent-search-suggestions-security',
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length) throw new Error(`Search suggestions template failed to compile: ${compiledTemplate.errors.join(', ')}`)
const render = new Function('Vue', compiledTemplate.code)(Vue) as Vue.RenderFunction
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const evaluate = new Function('computed', 'useId', 'defineProps', `${executableScript}\nreturn { headingId, isolatedDocument, frameHeight }`) as (
  ...dependencies: unknown[]
) => Record<string, unknown>

const renderSuggestions = async (suggestions: readonly string[]): Promise<string> => {
  const component = Vue.defineComponent({
    props: { suggestions: { type: Array, required: true } },
    setup: props => evaluate(Vue.computed, Vue.useId, () => props),
    render
  })
  const app = Vue.createSSRApp(component, { suggestions })
  app.component('v-icon', Vue.defineComponent({ render: () => null }))
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
    expect(sandbox.split(/\s+/)).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox'])
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(document.querySelector('script')).toBeNull()

    const isolatedDocument = frame.getAttribute('srcdoc') ?? ''
    expect(isolatedDocument.indexOf('Content-Security-Policy')).toBeLessThan(isolatedDocument.indexOf(providerHtml))
    expect(isolatedDocument).toContain("default-src 'none'")
    expect(isolatedDocument).toContain("script-src 'none'")
    expect(isolatedDocument).toContain("connect-src 'none'")
    expect(isolatedDocument).toContain("form-action 'none'")
    expect(isolatedDocument).toContain("base-uri 'none'")
    expect(isolatedDocument).toContain(providerHtml)
  })
})

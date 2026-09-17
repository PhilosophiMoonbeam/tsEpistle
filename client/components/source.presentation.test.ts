import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { ComponentOptions, RenderFunction } from 'vue'
import { decodeBase64Json, decodeBase64Text } from '../helpers/base64'

const filename = path.join(process.cwd(), 'client/components/source.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse source.vue: ${errors}`)

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://wiki.test/en/source'
})
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

// Vue's runtime-dom captures the document during module evaluation.
const Vue = await import('vue')
const compiled = compileTemplate({
  filename,
  id: 'source-presentation-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile source.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const evaluate = new Function('defineComponent', 'getPageDownloadPath', 'wikiStore', 'decodeBase64Json', 'decodeBase64Text', script) as (
  ...dependencies: unknown[]
) => ComponentOptions

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

let app: { unmount: () => void } | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  dom.window.document.body.replaceChildren()
})

const settle = async () => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}

describe('View Source presentation', () => {
  it('renders the decoded source inertly and reports exact copy success or failure', async () => {
    const content = '\n  # Heading {value}\n\t<safe>&\nΔ終\n'
    const notifications: Record<string, unknown>[] = []
    const writeText = vi.fn(async (_value: string) => undefined)
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    const wikiStore = {
      page: {},
      showNotification: (notification: Record<string, unknown>) => notifications.push(notification)
    }
    const options = evaluate(
      Vue.defineComponent,
      vi.fn(() => '/download'),
      wikiStore,
      decodeBase64Json,
      decodeBase64Text
    )
    app = Vue.createApp(
      {
        ...options,
        render
      },
      {
        pageId: 7,
        locale: 'en',
        path: 'source',
        visibility: 'public',
        versionId: 0,
        versionDate: '',
        effectivePermissions: '',
        contentBase64: Buffer.from(content, 'utf8').toString('base64')
      }
    )
    for (const name of [
      'v-app',
      'nav-header',
      'v-main',
      'v-toolbar',
      'v-spacer',
      'v-icon',
      'v-container',
      'nav-footer',
      'notify',
      'search-results',
      'i18next'
    ]) {
      app.component(name, passthrough())
    }
    app.component('v-btn', passthrough('button'))
    app.config.globalProperties.$vuetify = { display: { mdAndUp: true, smAndDown: false } }
    app.config.globalProperties.$helpers = { formatMoment: (value: string) => value }
    app.config.globalProperties.$t = (key: string) => key

    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    app.mount(host)
    await settle()

    const code = host.querySelector('pre > code')
    expect(code?.textContent).toBe(content)
    expect(code?.querySelector('safe')).toBeNull()

    const copyButton = host.querySelector<HTMLButtonElement>('button[aria-label="common:actions.copy"]')
    expect(copyButton).toBeTruthy()
    copyButton?.click()
    await settle()
    expect(writeText).toHaveBeenCalledWith(content)
    expect(notifications.at(-1)).toEqual({
      style: 'success',
      message: 'Source copied to clipboard.',
      icon: 'content-copy'
    })

    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    copyButton?.click()
    await settle()
    expect(notifications.at(-1)).toEqual({
      style: 'red',
      message: 'Copy failed. Select the source text and copy it manually.',
      icon: 'alert'
    })
  })
})

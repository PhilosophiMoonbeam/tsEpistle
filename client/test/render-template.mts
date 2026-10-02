import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'

/**
 * Renders a component template (including Pug) against a plain context object,
 * with every resolved child component replaced by a transparent stub. Used to
 * check template wiring without mounting Vuetify or the component script.
 */
export type TemplateRender = {
  html: string
  document: Document
  teleports: Record<string, string>
}

type CompiledRender = (ctx: Record<string, unknown>, cache: unknown[]) => Vue.VNode

const compiled = new Map<string, { render: CompiledRender; components: string[]; directives: string[] }>()

const compile = (relativePath: string) => {
  const cached = compiled.get(relativePath)
  if (cached) return cached
  const filename = path.join(process.cwd(), relativePath)
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  if (errors.length > 0 || !descriptor.template) throw new Error(`Could not parse ${relativePath}`)
  const result = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: `template-${compiled.size}`,
    preprocessLang: descriptor.template.lang,
    preprocessOptions: { doctype: 'html' },
    transformAssetUrls: false,
    compilerOptions: { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }
  })
  if (result.errors.length > 0) throw new Error(`Could not compile ${relativePath}: ${result.errors.join(', ')}`)
  const render = new Function('Vue', result.code)(Vue) as CompiledRender
  const components = [...new Set([...result.code.matchAll(/_resolveComponent\("([^"]+)"/g)].map(match => match[1]!))]
  const directives = [...new Set([...result.code.matchAll(/_resolveDirective\("([^"]+)"/g)].map(match => match[1]!))]
  const entry = { render, components, directives }
  compiled.set(relativePath, entry)
  return entry
}

const slotArgs = { props: {}, item: {}, isActive: false }

const stub = (name: string) =>
  Vue.defineComponent({
    name: `Stub_${name}`,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => {
        // Dialogs only render while open; everything else renders all slots.
        if (name === 'v-dialog' && attrs.modelValue !== true) return null
        const children = Object.entries(slots).flatMap(([slotName, slot]) => {
          const content = slot?.(slotArgs) ?? []
          return slotName === 'default' ? content : [Vue.h('template-slot', { 'data-slot': slotName }, content)]
        })
        const forwarded = Object.fromEntries(Object.entries(attrs).filter(([key, value]) => !key.startsWith('on') && typeof value !== 'function' && typeof value !== 'object'))
        return Vue.h('stub-el', { 'data-stub': name, ...forwarded }, children)
      }
    }
  })

export const renderTemplate = async (relativePath: string, state: Record<string, unknown>): Promise<TemplateRender> => {
  const { render, components, directives } = compile(relativePath)
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key === 'string' && key in target) return target[key]
      return undefined
    }
  })
  const root = Vue.defineComponent({
    components: Object.fromEntries(components.map(name => [name, stub(name)])),
    directives: Object.fromEntries(directives.map(name => [name, {}])),
    render: () => render(ctx, [])
  })
  const app = Vue.createSSRApp(root)
  app.config.warnHandler = () => {}
  const ssrContext: { teleports?: Record<string, string> } = {}
  const html = await renderToString(app, ssrContext)
  const teleports = ssrContext.teleports ?? {}
  const dom = new JSDOM(`<body>${html}${Object.entries(teleports).map(([target, markup]) => `<section data-teleport="${target}">${markup}</section>`).join('')}</body>`)
  return { html, document: dom.window.document, teleports }
}

/** Translation stub: returns the key, plus interpolation values in a stable form. */
export const keyTranslator = (key: string, options?: Record<string, unknown>): string => {
  if (!options) return key
  const values = Object.entries(options).filter(([name]) => name !== 'interpolation' && name !== 'defaultValue')
  return values.length === 0 ? key : `${key}(${values.map(([name, value]) => `${name}=${String(value)}`).join(',')})`
}

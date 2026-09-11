import fs from 'node:fs'
import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import type { Component } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/agent-memory'
})
const browserWindow = dom.window
Object.defineProperty(browserWindow, 'fetch', { configurable: true, writable: true, value: () => Promise.resolve() })
Object.defineProperty(browserWindow.Element.prototype, 'scrollIntoView', { configurable: true, value(): void {} })
const browserGlobals: Record<string, unknown> = {
  document: browserWindow.document,
  window: browserWindow,
  navigator: browserWindow.navigator,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text,
  cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  fetch: browserWindow.fetch,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow)
}
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver })
Object.defineProperty(browserWindow, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver })
Object.defineProperty(browserWindow, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (media: string) => ({
    matches: false,
    media,
    addEventListener(): void {},
    removeEventListener(): void {}
  })
})

// Vue and Vuetify must load after the JSDOM globals so runtime-dom captures this document.
const VueRuntime = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0 || !parsed.descriptor.scriptSetup || !parsed.descriptor.template) {
  throw new Error(`Could not parse ${componentPath}: ${parsed.errors.join(', ')}`)
}

const componentId = 'agent-memory-manager-contract'
const compiledScript = compileScript(parsed.descriptor, {
  id: componentId,
  inlineTemplate: true
})

const bundledSfc = await Bun.build({
  entrypoints: ['virtual:agent-memory-manager.vue'],
  external: ['vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'agent-memory-manager-contract-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:agent-memory-manager\.vue$/ }, args => ({
          namespace: 'agent-memory-manager-sfc',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-sfc' }, () => ({
          contents: compiledScript.content,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
        build.onResolve({ filter: /agent-panel-header\.vue$/ }, () => ({
          namespace: 'agent-memory-manager-header',
          path: 'agent-panel-header.ts'
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-header' }, () => ({
          contents: `
            import { h } from 'vue'
            export default {
              props: { title: String, closeLabel: String, headingId: String, busy: Boolean },
              emits: ['close'],
              setup(props, { slots, emit }) {
                return () => h('header', { class: 'agent-panel-header' }, [
                  h('h2', { id: props.headingId }, props.title),
                  slots.default?.(),
                  h('button', { type: 'button', 'aria-label': props.closeLabel, disabled: props.busy, onClick: () => emit('close') })
                ])
              }
            }
          `,
          loader: 'ts'
        }))
        build.onResolve({ filter: /agents-api\.ts$/ }, () => ({
          namespace: 'agent-memory-manager-api',
          path: 'agents-api.ts'
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-api' }, () => ({
          contents: `
            export const getAgentMemories = async () => ({
              agent: { entries: [], characters: 0, limit: 2200 },
              user: { entries: [], characters: 0, limit: 1375 }
            })
            export const clearAgentMemories = async () => undefined
            export const createAgentMemory = async () => undefined
            export const removeAgentMemory = async () => ({ characters: 0, limit: 1375 })
            export const updateAgentMemory = async () => undefined
          `,
          loader: 'ts'
        }))
        build.onResolve({ filter: /modal-focus-scope/ }, () => ({
          namespace: 'agent-memory-manager-focus',
          path: 'modal-focus-scope.ts'
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-focus' }, () => ({
          contents: 'export const createModalFocusScope = () => ({ deactivate() {} })',
          loader: 'ts'
        }))
      }
    }
  ],
  target: 'bun'
})
if (!bundledSfc.success || bundledSfc.outputs.length !== 1) {
  throw new Error(`Could not bundle ${componentPath}: ${bundledSfc.logs.map(log => log.message).join(', ')}`)
}

const bundledModuleCode = await bundledSfc.outputs[0]!.text()
const moduleWrapperStart = bundledModuleCode.indexOf('(function(')
if (moduleWrapperStart < 0) throw new Error(`Compiled ${componentPath} did not produce a CommonJS module`)
const createCompiledModule = new Function(`return ${bundledModuleCode.slice(moduleWrapperStart)}`)() as (
  exports: { default?: Component },
  require: (specifier: string) => unknown,
  module: { exports: { default?: Component } },
  filename: string,
  dirname: string
) => void
const compiledModule: { exports: { default?: Component } } = { exports: {} }
createCompiledModule(
  compiledModule.exports,
  specifier => {
    if (specifier === 'vue') return VueRuntime
    throw new Error(`Unexpected import in compiled ${componentPath}: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)
const AgentMemoryManager = compiledModule.exports.default
if (!AgentMemoryManager) throw new Error(`${componentPath} did not export a component`)
;(AgentMemoryManager as Component & { __scopeId?: string }).__scopeId = `data-v-${componentId}`

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve()
    await VueRuntime.nextTick()
  }
}

const mountManager = async () => {
  const host = browserWindow.document.createElement('div')
  host.style.setProperty('--wiki-control-height', '44px')
  host.style.setProperty('--wiki-control-radius', '8px')
  host.style.setProperty('--wiki-space-2', '8px')
  browserWindow.document.body.append(host)

  const open = VueRuntime.ref(true)
  const root = VueRuntime.defineComponent({
    name: 'AgentMemoryManagerContractHarness',
    setup: () => () =>
      VueRuntime.h(AgentMemoryManager, {
        modelValue: open.value,
        'onUpdate:modelValue': (value: boolean) => {
          open.value = value
        },
        csrfToken: 'csrf-token',
        headingId: 'agent-memory-title',
        descriptionId: 'agent-memory-description'
      })
  })
  const app = VueRuntime.createApp(root)
  app.use(createVuetify({ components: vuetifyComponents }))
  app.mount(host)
  await settle()
  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })

  const addMemory = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Add memory'))
  if (!addMemory) throw new Error('The mounted memory manager did not expose its add action')
  addMemory.click()
  await settle()
  return { host }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
})

describe('Agent memory manager rendered contract', () => {
  it('keeps both target choices selectable while exposing the target-specific editor label', async () => {
    const { host } = await mountManager()
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-memory__target .v-btn'))
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['You', 'Agent'])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.classList.contains('v-btn--active')).toBe(true)

    const editorLabel = () => host.querySelector('.agent-memory__editor .v-field-label')?.textContent?.trim()
    expect(editorLabel()).toBe('Personal detail')

    buttons[1]?.click()
    await settle()

    expect(buttons[1]?.classList.contains('v-btn--active')).toBe(true)
    expect(buttons[0]?.classList.contains('v-btn--active')).toBe(false)
    expect(editorLabel()).toBe('Project or workflow fact')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import type { Component } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'

resetBody()

// Vue and Vuetify must load after the shared DOM globals so runtime-dom captures the singleton document.
const VueRuntime = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')


const memoryWrites: Array<{ id: string; version: number; target: string; content: string; createdAt: string; updatedAt: string }> = []
;(globalThis as typeof globalThis & { __memoryContractWrites: typeof memoryWrites }).__memoryContractWrites = memoryWrites
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
        build.onResolve({ filter: /^@\// }, args => ({ path: path.join(process.cwd(), 'client', args.path.slice(2)) }))
        build.onResolve({ filter: /shared\/agents\/contracts\.ts$/ }, () => ({
          path: path.join(process.cwd(), 'shared/agents/contracts.ts')
        }))
        build.onResolve({ filter: /^virtual:agent-memory-manager\.vue$/ }, args => ({
          namespace: 'agent-memory-manager-sfc',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-sfc' }, () => ({
          contents: compiledScript.content.replace("from '../../helpers/use-translate.ts'", "from '@/helpers/use-translate.ts'"),
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
                  slots.actions?.(),
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
              agent: { entries: globalThis.__memoryContractWrites.filter(entry => entry.target === 'agent'), characters: 0, limit: 2200 },
              user: { entries: globalThis.__memoryContractWrites.filter(entry => entry.target === 'user'), characters: 0, limit: 1375 }
            })
            export const clearAgentMemories = async () => undefined
            export const createAgentMemory = async (_fetcher, _csrfToken, input) => {
              const entries = globalThis.__memoryContractWrites
              entries.push({ id: String(entries.length + 1), version: 1, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...input })
              return { changed: true, receipt: {
                schemaVersion: 1, origin: 'manual', ownerId: 1, sessionId: input.context.sessionId,
                runId: null, attempt: null, snapshotId: null, entryId: String(entries.length), entryVersion: 1,
                operation: 'add', changed: true,
                targets: [{ target: input.target, characters: input.content.length, limit: input.target === 'agent' ? 2200 : 1375, snapshotId: 'a'.repeat(64) }]
              } }
            }
            export const removeAgentMemory = async () => ({ characters: 0, limit: 1375 })
            export const updateAgentMemory = async () => ({ changed: false, receipt: null })
          `,
          loader: 'ts'
        }))
        build.onResolve({ filter: /store\/agents\.ts$/ }, () => ({
          namespace: 'agent-memory-manager-store', path: 'agents.ts'
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-memory-manager-store' }, () => ({
          contents: `export const useAgentsStore = () => ({
            captureMemoryMutationContext: () => null,
            isMemoryMutationContextCurrent: () => false,
            consumeManualMemoryReceipt: () => false
          })`,
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
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  await settle()
  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })

  const addMemory = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Add detail'))
  if (!addMemory) throw new Error('The mounted memory manager did not expose its add action')
  return { host, addMemory }
}

afterEach(() => {
  memoryWrites.length = 0
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
})

describe('Agent memory manager rendered contract', () => {
  it('does not offer destructive Clear while both memory stores are empty', async () => {
    const { host, addMemory } = await mountManager()
    // Add is enabled after loading; with nothing saved, the destructive Clear action is not offered at all.
    expect(addMemory.disabled).toBe(false)
    expect(host.querySelector('.agent-memory__clear')).toBeNull()
    expect(browserWindow.document.querySelector('.agent-memory__dialog')).toBeNull()
  })

  it('returns focus to a surviving control when Escape cancels an unsaved editor', async () => {
    const { host, addMemory } = await mountManager()
    const close = host.querySelector<HTMLButtonElement>('.agent-panel-header button')
    if (!close) throw new Error('The memory manager has no close control')
    addMemory.click()
    await settle()
    const textarea = host.querySelector<HTMLTextAreaElement>('.agent-memory__editor textarea')
    if (!textarea) throw new Error('The memory editor did not render its textarea')
    textarea.value = 'Keep this unsaved detail out of memory'
    textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    textarea.focus()
    textarea.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(browserWindow.document.activeElement).toBe(close)
    expect(memoryWrites).toEqual([])
  })

  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    it(`saves with ${modifier}+Enter and prevents the key action without bypassing empty-draft guards`, async () => {
      const { host, addMemory } = await mountManager()
      addMemory.click()
      await settle()
      const textarea = host.querySelector<HTMLTextAreaElement>('.agent-memory__editor textarea')
      if (!textarea) throw new Error('The memory editor did not render its textarea')
      const guarded = new browserWindow.KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true })
      textarea.dispatchEvent(guarded)
      await settle()
      expect(guarded.defaultPrevented).toBe(true)
      expect(memoryWrites).toEqual([])
      textarea.value = 'Keep a local fixture detail'
      textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await settle()
      const submit = new browserWindow.KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true })
      textarea.dispatchEvent(submit)
      await settle()
      expect(submit.defaultPrevented).toBe(true)
      expect([...host.querySelectorAll('.agent-memory__entry-content p')].map(entry => entry.textContent)).toEqual(['Keep a local fixture detail'])
    })
  }
})

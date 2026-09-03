import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { AgentTaskView } from '../../../shared/agents/contracts.ts'
import type { Component } from 'vue'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const browserWindow = dom.window
const globalValues: Record<string, unknown> = {
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLDetailsElement: browserWindow.HTMLDetailsElement,
  HTMLElement: browserWindow.HTMLElement,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  document: browserWindow.document,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
  window: browserWindow
}
for (const [name, value] of Object.entries(globalValues)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}

// Vue and Vuetify stay dynamic so runtime-dom captures the JSDOM document initialized above.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VIcon } = await import('vuetify/components')

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-task-progress.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const parsedSfc = parse(source, { filename: componentPath })
if (parsedSfc.errors.length > 0) throw new Error(`Could not parse agent-task-progress.vue: ${parsedSfc.errors.join(', ')}`)
if (!parsedSfc.descriptor.scriptSetup || !parsedSfc.descriptor.template) {
  throw new Error('agent-task-progress.vue template or script block was not found')
}

const compiledSfc = compileScript(parsedSfc.descriptor, {
  id: 'agent-task-progress-interaction-test',
  inlineTemplate: true
})
const bundledSfc = await Bun.build({
  entrypoints: ['virtual:agent-task-progress.vue'],
  external: ['vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'agent-task-progress-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:agent-task-progress\.vue$/ }, args => ({
          namespace: 'agent-task-progress-sfc',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-task-progress-sfc' }, () => ({
          contents: compiledSfc.content,
          loader: 'ts'
        }))
      }
    }
  ],
  target: 'bun'
})
if (!bundledSfc.success || bundledSfc.outputs.length !== 1) {
  throw new Error(`Could not bundle agent-task-progress.vue: ${bundledSfc.logs.map(log => log.message).join(', ')}`)
}

const bundledModuleCode = await bundledSfc.outputs[0].text()
const moduleWrapperStart = bundledModuleCode.indexOf('(function(')
if (moduleWrapperStart < 0) throw new Error('Compiled agent-task-progress.vue did not produce a CommonJS module')

interface CompiledModule {
  exports: { default?: Component }
}
type CompiledModuleFactory = (
  exports: CompiledModule['exports'],
  require: (specifier: string) => unknown,
  module: CompiledModule,
  filename: string,
  dirname: string
) => void
const createCompiledModule = new Function(`return ${bundledModuleCode.slice(moduleWrapperStart)}`)() as CompiledModuleFactory
const compiledModule: CompiledModule = { exports: {} }
createCompiledModule(
  compiledModule.exports,
  specifier => {
    if (specifier === 'vue') return Vue
    throw new Error(`Unexpected import in compiled agent-task-progress.vue: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)
const taskProgress = compiledModule.exports.default
if (!taskProgress) throw new Error('Compiled agent-task-progress.vue did not export a component')

const makeTask = (overrides: Partial<AgentTaskView> = {}): AgentTaskView => ({
  id: 'task-1',
  runId: 'run-1',
  kind: 'source_scout',
  title: 'Review sources',
  question: 'Which sources support the release?',
  sourceScope: [],
  requiredEvidenceCount: 1,
  status: 'running',
  subagentRunId: 'subagent-1',
  attempt: 1,
  outcome: null,
  evidenceCount: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-09-03T10:00:00.000Z',
  startedAt: '2026-09-03T10:00:01.000Z',
  completedAt: null,
  ...overrides
})

interface MountedTaskProgress {
  details: HTMLDetailsElement
  summary: HTMLElement
  setTasks: (tasks: readonly AgentTaskView[]) => Promise<void>
}

const mountedApps: Array<() => void> = []

const mountTasks = async (initialTasks: readonly AgentTaskView[]): Promise<MountedTaskProgress> => {
  const tasks = Vue.shallowRef(initialTasks)
  const root = Vue.defineComponent({
    name: 'AgentTaskProgressInteractionHarness',
    setup: () => () => Vue.h(taskProgress, { tasks: tasks.value })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp(root)
  app.use(createVuetify({ components: { VIcon } }))
  app.mount(host)

  const details = host.querySelector<HTMLDetailsElement>('details.agent-tasks')
  const summary = details?.querySelector<HTMLElement>(':scope > summary')
  if (!details || !summary) throw new Error('Rendered agent task disclosure was not found')
  if (details.open) await once(details, 'toggle')
  await Vue.nextTick()

  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })
  return {
    details,
    summary,
    setTasks: async value => {
      const previousOpen = details.open
      tasks.value = value
      await Vue.nextTick()
      if (details.open !== previousOpen) await once(details, 'toggle')
      await Vue.nextTick()
    }
  }
}

const cleanCompletion = makeTask({
  status: 'completed',
  outcome: 'completed',
  evidenceCount: 1,
  completedAt: '2026-09-03T10:00:10.000Z'
})

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('Agent task progress disclosure', () => {
  it('ignores native toggles caused by reactive open-state updates', async () => {
    const mounted = await mountTasks([makeTask()])

    expect(mounted.details.open).toBe(true)
    await mounted.setTasks([cleanCompletion])
    expect(mounted.details.open).toBe(false)
  })

  it('keeps a user-closed running plan closed across default-state changes', async () => {
    const mounted = await mountTasks([makeTask()])
    expect(mounted.details.open).toBe(true)

    const toggled = once(mounted.details, 'toggle')
    mounted.summary.click()
    await toggled
    await Vue.nextTick()
    expect(mounted.details.open).toBe(false)

    await mounted.setTasks([cleanCompletion])
    expect(mounted.details.open).toBe(false)

    await mounted.setTasks([makeTask(), makeTask({ id: 'task-2', title: 'Review release notes' })])
    expect(mounted.details.open).toBe(false)
  })

  it('keeps a user-opened clean plan open across default-state changes', async () => {
    const mounted = await mountTasks([cleanCompletion])
    expect(mounted.details.open).toBe(false)

    expect(mounted.summary.tabIndex).toBe(0)
    mounted.summary.focus()
    const toggled = once(mounted.details, 'toggle')
    mounted.summary.click()
    await toggled
    await Vue.nextTick()
    expect(mounted.details.open).toBe(true)

    await mounted.setTasks([makeTask()])
    expect(mounted.details.open).toBe(true)

    await mounted.setTasks([cleanCompletion, { ...cleanCompletion, id: 'task-2', title: 'Review release notes' }])
    expect(mounted.details.open).toBe(true)
  })
})

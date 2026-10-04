import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import i18next from 'i18next'

import { compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentTaskView } from '../../../shared/agents/contracts.ts'
import type { Component } from 'vue'
import type { Translate } from '../../helpers/use-translate.ts'

import { browserWindow, resetBody } from '../../test/browser-dom.mts'

import { translateEnglish } from '../../test/english-translate.mts'
globalThis.useTranslate = () => translateEnglish
resetBody()

const taskLocale = i18next.createInstance()
await taskLocale.init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  initAsync: false,
  resources: { en: JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')) }
})

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
  external: ['vue', 'i18next'],
  format: 'cjs',
  plugins: [
    {
      name: 'alias-at',
      setup(build) {
        build.onResolve({ filter: /^@\// }, args => ({ path: path.join(process.cwd(), 'client', args.path.slice(2)) }))
      }
    },
    {
      name: 'agent-task-progress-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:agent-task-progress\.vue$/ }, args => ({
          namespace: 'agent-task-progress-sfc',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'agent-task-progress-sfc' }, () => ({
          contents: compiledSfc.content.replace("from '../../helpers/use-translate.ts'", "from '@/helpers/use-translate.ts'"),
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
    if (specifier === 'i18next') return taskLocale
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
  liveStatus: HTMLElement
  setTasks: (tasks: readonly AgentTaskView[]) => Promise<void>
}

const mountedApps: Array<() => void> = []

const mountTasks = async (initialTasks: readonly AgentTaskView[], translate: Translate = translateEnglish): Promise<MountedTaskProgress> => {
  const tasks = Vue.shallowRef(initialTasks)
  const root = Vue.defineComponent({
    name: 'AgentTaskProgressInteractionHarness',
    setup: () => () => Vue.h(taskProgress, { tasks: tasks.value })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp(root)
  app.config.globalProperties.$t = translate
  app.use(createVuetify({ components: { VIcon } }))
  app.mount(host)

  const details = host.querySelector<HTMLDetailsElement>('details.agent-tasks')
  const summary = details?.querySelector<HTMLElement>(':scope > summary')
  if (!details || !summary) throw new Error('Rendered agent task disclosure was not found')
  const liveStatus = host.querySelector<HTMLElement>('[role="status"]')
  if (!liveStatus) throw new Error('Rendered task live status was not found')
  if (details.open) await once(details, 'toggle')
  await Vue.nextTick()

  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })
  return {
    details,
    summary,
    liveStatus,
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

afterEach(async () => {
  for (const unmount of mountedApps.splice(0)) unmount()
  await taskLocale.changeLanguage('en')
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Agent task progress disclosure', () => {
  it('updates visible durations without repeating the live plan summary, then announces a changed outcome', async () => {
    let now = new Date('2026-09-03T10:00:31.000Z').valueOf()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let refreshDuration = (): void => {
      throw new Error('The active task duration clock did not start')
    }
    vi.spyOn(browserWindow, 'setInterval').mockImplementation(handler => {
      if (typeof handler !== 'function') throw new Error('Expected a duration timer callback')
      refreshDuration = () => {
        handler()
      }
      return 1
    })
    const clearInterval = vi.spyOn(browserWindow, 'clearInterval').mockImplementation(() => undefined)
    const mounted = await mountTasks([makeTask()])
    const initialAnnouncement = mounted.liveStatus.textContent
    const metadata = mounted.details.querySelector('.agent-tasks__meta')!
    expect(metadata.textContent).toContain('Running 30 sec')

    now += 90_000
    refreshDuration()
    await Vue.nextTick()
    expect(metadata.textContent).toContain('Running 2 min')
    expect(mounted.liveStatus.textContent).toBe(initialAnnouncement)

    await mounted.setTasks([makeTask({ status: 'failed', outcome: 'failed', completedAt: '2026-09-03T10:02:01.000Z' })])
    expect(mounted.liveStatus.textContent).not.toBe(initialAnnouncement)
    expect(mounted.liveStatus.textContent).toContain('need attention')
    expect(clearInterval).toHaveBeenCalledWith(1)
  })

  it('refreshes labels, evidence numbers and recorded times when the app language changes without remounting', async () => {
    taskLocale.addResourceBundle(
      'de',
      'common',
      {
        agentTaskProgress: {
          partial: 'Teilweise',
          factCheck: 'Faktenprüfung',
          partialEvidenceReturned: 'Teilweise Belege geliefert',
          sourcesCount_one: '{{count, number}} Quelle',
          sourcesCount_other: '{{count, number}} Quellen',
          onlyRequiredFound_one: 'Nur {{evidenceCount}} von {{requiredEvidenceCount}} erforderlicher Quelle wurde gefunden.',
          onlyRequiredFound_other: 'Nur {{evidenceCount}} von {{requiredEvidenceCount}} erforderlichen Quellen wurden gefunden.',
          researchPlanResolved: 'Rechercheplan abgeschlossen'
        }
      },
      true,
      true
    )
    const mounted = await mountTasks(
      [
        makeTask({
          kind: 'fact_check',
          status: 'completed',
          outcome: 'partial',
          evidenceCount: 1_200,
          requiredEvidenceCount: 1_234,
          completedAt: '2026-09-03T10:00:10.000Z'
        })
      ],
      (key, options = {}) => String(taskLocale.t(key, options))
    )
    const timestamp = mounted.details.querySelector('time')!
    const englishTimestamp = timestamp.textContent
    expect(mounted.details.querySelector('.agent-tasks__meta')?.textContent).toContain('1,200/1,234 sources')
    const liveStatus = mounted.liveStatus

    await taskLocale.changeLanguage('de')
    await Vue.nextTick()
    expect(mounted.liveStatus).toBe(liveStatus)
    expect(mounted.details.querySelector('.agent-tasks__status')?.textContent).toBe('Teilweise')
    expect(mounted.summary.textContent).toContain('Rechercheplan abgeschlossen')
    expect(mounted.details.querySelector('.agent-tasks__meta')?.textContent).toContain('Faktenprüfung')
    expect(mounted.details.querySelector('.agent-tasks__meta')?.textContent).toContain('1.200/1.234 Quellen')
    expect(mounted.details.querySelector('.agent-tasks__note')?.textContent).toContain('1.200 von 1.234')
    expect(mounted.details.querySelector('.agent-task-record__facts')?.textContent).toContain('Teilweise Belege geliefert')
    expect(timestamp.textContent).not.toBe(englishTimestamp)
    expect(timestamp.textContent).toBe(new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp.dateTime)))
  })

  it('shows attempt metadata and its separator only for retries', async () => {
    const mounted = await mountTasks([makeTask()])
    const metadata = mounted.details.querySelector('.agent-tasks__meta')!

    expect(metadata.textContent).not.toContain('Attempt')
    expect(metadata.querySelectorAll('[aria-hidden="true"]').length).toBe(2)

    await mounted.setTasks([makeTask({ attempt: 3 })])
    expect(metadata.textContent).toContain('Attempt 3')
    expect(metadata.textContent).toContain('retried 2')
    expect(metadata.querySelectorAll('[aria-hidden="true"]').length).toBe(3)
  })

  it('renders hour remainders with a single translated minute count', async () => {
    const mounted = await mountTasks([
      makeTask({
        status: 'completed',
        outcome: 'completed',
        evidenceCount: 1,
        startedAt: '2026-09-03T10:00:00.000Z',
        completedAt: '2026-09-03T11:07:00.000Z'
      })
    ])

    expect(mounted.details.querySelector('.agent-tasks__meta')?.textContent).toContain('Duration 1 hr 7 min')
    expect(mounted.details.querySelector('.agent-tasks__meta')?.textContent).not.toContain('7 7 min')
  })

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

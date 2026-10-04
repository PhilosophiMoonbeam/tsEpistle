import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compileScript, parse } from '@vue/compiler-sfc'
import type { Component } from 'vue'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'

import { translateEnglish } from '../../test/english-translate.mts'
;globalThis.useTranslate = () => translateEnglish
resetBody()
// Load Vue/Vuetify after the shared DOM globals; runtime-dom captures its document at module initialization.
const VueRuntime = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')

interface DragHarness {
  canDragSession: (session: AgentSessionSummary) => boolean
  hasRenderedDropDestination: (session: AgentSessionSummary) => boolean
}

const actionsPath = join(process.cwd(), 'client/components/agents/agent-history-session-actions.vue')
const parsedActions = parse(readFileSync(actionsPath, 'utf8'), { filename: actionsPath })
if (parsedActions.errors.length || !parsedActions.descriptor.scriptSetup || !parsedActions.descriptor.template) {
  throw new Error(`Could not parse ${actionsPath}: ${parsedActions.errors.join(', ')}`)
}
const compiledActions = compileScript(parsedActions.descriptor, { id: 'agent-history-session-actions-test', inlineTemplate: true })
const bundledActions = await Bun.build({
  entrypoints: ['virtual:agent-history-session-actions.vue'],
  external: ['vue'],
  format: 'cjs',
  target: 'bun',
  plugins: [{
    name: 'agent-history-session-actions-test-sfc',
    setup(build) {
      build.onResolve({ filter: /^virtual:agent-history-session-actions\.vue$/ }, args => ({
        namespace: 'agent-history-session-actions-sfc', path: args.path
      }))
      build.onLoad({ filter: /.*/, namespace: 'agent-history-session-actions-sfc' }, () => ({
        contents: compiledActions.content, loader: 'ts', resolveDir: join(process.cwd(), 'client/components/agents')
      }))
    }
  }]
})
if (!bundledActions.success || bundledActions.outputs.length !== 1) {
  throw new Error(`Could not bundle ${actionsPath}: ${bundledActions.logs.map(log => log.message).join(', ')}`)
}
const bundledCode = await bundledActions.outputs[0]!.text()
const wrapperStart = bundledCode.indexOf('(function(')
if (wrapperStart < 0) throw new Error('Compiled session actions did not produce a CommonJS module')
const createCompiledModule = new Function(`return ${bundledCode.slice(wrapperStart)}`)() as (
  exports: { default?: Component },
  require: (specifier: string) => unknown,
  module: { exports: { default?: Component } },
  filename: string,
  dirname: string
) => void
const compiledModule: { exports: { default?: Component } } = { exports: {} }
createCompiledModule(compiledModule.exports, specifier => {
  if (specifier === 'vue') return VueRuntime
  throw new Error(`Unexpected session-actions import: ${specifier}`)
}, compiledModule, actionsPath, join(process.cwd(), 'client/components/agents'))
const SessionActions = compiledModule.exports.default
if (!SessionActions) throw new Error('Compiled session actions did not export a component')
const panelPath = join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const panelScript = readFileSync(panelPath, 'utf8').match(/<script setup lang=["']ts["']>([\s\S]*?)<\/script>/)?.[1] ?? ''
const dragHelpersScript = panelScript.match(/const hasRenderedDropDestination[\s\S]*?(?=const dropTargetKey)/)?.[0] ?? ''
const executableDragHelpersScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(dragHelpersScript)

const makeSession = (overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Release planning',
  retention: 'temporary',
  folderId: null,
  executionMode: 'agent',
  version: 1,
  providerProfileId: null,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
  lastActivityAt: '2026-08-31T10:00:00.000Z',
  expiresAt: '2026-11-29T10:00:00.000Z',
  deletedAt: null,
  ...overrides
})

const makeFolder = (id = '10000000-0000-4000-8000-000000000001', name = 'Roadmap'): AgentConversationFolderView => ({
  id,
  name,
  version: 1,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z'
})

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve()
    await VueRuntime.nextTick()
  }
}
const menuItem = (menu: Element, title: string): HTMLElement => {
  const item = Array.from(menu.querySelectorAll<HTMLElement>('.v-list-item'))
    .find(candidate => candidate.querySelector('.v-list-item-title')?.textContent?.trim() === title)
  if (!item) throw new Error(`The mounted actions menu did not expose ${title}`)
  return item
}
const mountMoveMenu = async (session: AgentSessionSummary, folders: AgentConversationFolderView[]) => {
  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const move = vi.fn()
  const newFolder = vi.fn()
  const app = VueRuntime.createApp({
    setup: () => () => VueRuntime.h(SessionActions, { session, folders, onMove: move, 'onNew-folder': newFolder })
  })
  app.use(createVuetify({ components: vuetifyComponents, defaults: { VMenu: { transition: false } } }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  await settle()
  const trigger = host.querySelector<HTMLButtonElement>('.agent-history-session-actions__trigger')
  if (!trigger) throw new Error('The mounted session actions did not expose its activator')
  trigger.click()
  await settle()
  const actionsMenu = browserWindow.document.querySelector(`[aria-label="Actions for ${session.title}"]`)
  if (!actionsMenu) throw new Error('The conversation actions menu did not open')
  menuItem(actionsMenu, 'Move').click()
  await settle()
  const menu = browserWindow.document.querySelector(`[aria-label="Move ${session.title}"]`)
  if (!menu) throw new Error('The conversation Move menu did not open')
  return { menu, trigger, move, newFolder, unmount }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
})

const loadDragHelpers = (visibleFolderIds: readonly string[], busySessionIds: readonly string[] = [], mutationBusy = false, search = ''): DragHarness => {
  const evaluate = new Function(
    'visibleFolderGroups',
    'sessionBusy',
    'sessionMutationBusy',
    'normalizedSearch',
    'networkBlocked',
    `${executableDragHelpersScript}\nreturn { hasRenderedDropDestination, canDragSession }`
  ) as (...dependencies: unknown[]) => DragHarness
  return evaluate(
    { value: visibleFolderIds.map(id => ({ folder: { id } })) },
    (sessionId: string) => busySessionIds.includes(sessionId),
    { value: mutationBusy },
    { value: search },
    { value: false }
  )
}

describe('Agent history folder actions', () => {
  it('offers New folder in Move even when no saved folder exists', async () => {
    const session = makeSession()
    const actions = await mountMoveMenu(session, [])
    menuItem(actions.menu, 'New folder…').click()
    await settle()

    expect(actions.newFolder).toHaveBeenCalledTimes(1)
    expect(actions.newFolder.mock.calls[0]?.[0]).toEqual(session)
    expect(actions.move).not.toHaveBeenCalled()
  })

  it('keeps the current folder out of destinations while retaining Recent and New folder', async () => {
    const current = makeFolder()
    const other = makeFolder('10000000-0000-4000-8000-000000000002', 'Launch notes')
    const session = makeSession({ folderId: current.id, retention: 'saved' })
    const actions = await mountMoveMenu(session, [current, other])
    expect(Array.from(actions.menu.querySelectorAll('.v-list-item-title')).map(item => item.textContent?.trim()))
      .not.toContain(current.name)
    menuItem(actions.menu, other.name).click()
    await settle()
    expect(actions.move).toHaveBeenCalledTimes(1)
    expect(actions.move).toHaveBeenCalledWith(other.id)
    actions.unmount()

    const recent = await mountMoveMenu(session, [current, other])
    menuItem(recent.menu, 'Recent').click()
    await settle()
    expect(recent.move).toHaveBeenCalledTimes(1)
    expect(recent.move).toHaveBeenCalledWith(null)
    recent.unmount()

    const create = await mountMoveMenu(session, [current, other])
    menuItem(create.menu, 'New folder…').click()
    await settle()
    expect(create.newFolder).toHaveBeenCalledTimes(1)
    expect(create.newFolder.mock.calls[0]?.[0]).toEqual(session)
  })

  it('enables dragging to the zero-folder empty destination without enabling filtered empties', () => {
    const recentSession = makeSession()
    const folder = makeFolder()

    expect(loadDragHelpers([]).hasRenderedDropDestination(recentSession)).toBe(true)
    expect(loadDragHelpers([]).canDragSession(recentSession)).toBe(true)
    expect(loadDragHelpers([], [], false, 'filtered').hasRenderedDropDestination(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(recentSession)).toBe(true)
    expect(loadDragHelpers([folder.id], [recentSession.id]).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id], [], true).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(makeSession({ folderId: folder.id, retention: 'saved' }))).toBe(true)
  })
})

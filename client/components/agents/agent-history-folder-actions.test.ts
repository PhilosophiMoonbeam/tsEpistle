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
interface PanelStore {
  folders: AgentConversationFolderView[]
  sessions: AgentSessionSummary[]
  loading: boolean
  sessionMutationBusy: boolean
  sessionsLoadMoreError: string
  sessionsLoadingMore: boolean
  sessionsNextCursor: null
  sessionsReloading: boolean
  thread: null
  error: string
  reloadSessions: () => Promise<{ current: boolean; accepted: boolean }>
  reloadFolders: () => Promise<{ current: boolean; accepted: boolean }>
  cancelSessionReadTransition: () => void
}
let panelStore: PanelStore
const panelPath = join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const bundledPanel = await Bun.build({
  entrypoints: [panelPath],
  external: ['vue', 'pinia', 'test:agents-store', 'test:translate'],
  format: 'cjs',
  target: 'bun',
  plugins: [{
    name: 'agent-history-real-panel-test',
    setup(build) {
      build.onResolve({ filter: /store\/agents\.ts$/ }, () => ({ path: 'test:agents-store', external: true }))
      build.onResolve({ filter: /helpers\/use-translate\.ts$/ }, () => ({ path: 'test:translate', external: true }))
      build.onLoad({ filter: /\.vue$/ }, ({ path: filename }) => {
        const parsed = parse(readFileSync(filename, 'utf8'), { filename })
        if (parsed.errors.length) throw parsed.errors[0]
        const script = compileScript(parsed.descriptor, {
          id: `history-test-${join(filename).replace(/\W/g, '-')}`,
          inlineTemplate: true
        })
        return { contents: script.content, loader: 'ts', resolveDir: join(filename, '..') }
      })
    }
  }]
})
if (!bundledPanel.success || bundledPanel.outputs.length !== 1) {
  throw new Error(`Could not bundle history panel: ${bundledPanel.logs.map(log => log.message).join(', ')}`)
}
const panelCode = await bundledPanel.outputs[0]!.text()
const panelWrapperStart = panelCode.indexOf('(function(')
if (panelWrapperStart < 0) throw new Error('Compiled history panel did not produce a CommonJS module')
const createPanelModule = new Function(`return ${panelCode.slice(panelWrapperStart)}`)() as typeof createCompiledModule
const panelModule: { exports: { default?: Component } } = { exports: {} }
createPanelModule(panelModule.exports, specifier => {
  if (specifier === 'vue') return VueRuntime
  if (specifier === 'pinia') return { storeToRefs: () => VueRuntime.toRefs(panelStore) }
  if (specifier === 'test:agents-store') return { useAgentsStore: () => panelStore }
  if (specifier === 'test:translate') return { useTranslate: () => translateEnglish }
  throw new Error(`Unexpected history-panel import: ${specifier}`)
}, panelModule, panelPath, join(process.cwd(), 'client/components/agents'))
const HistoryPanel = panelModule.exports.default
if (!HistoryPanel) throw new Error('Compiled history panel did not export a component')

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
  const trigger = host.querySelector<HTMLButtonElement>('.agent-history-session-actions__move')
  if (!trigger) throw new Error('The mounted session actions did not expose its visible Move button')
  expect(trigger.textContent).toContain('Move')
  expect(trigger.getAttribute('aria-label')).toBe(`Move ${session.title}`)
  trigger.focus()
  trigger.click()
  await settle()
  const menu = browserWindow.document.querySelector(`.agent-history-session-actions__destinations[aria-label="Move ${session.title}"]`)
  if (!menu) throw new Error('The conversation Move menu did not open')
  return { menu, trigger, move, newFolder, unmount }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
})


const mountHistoryPanel = async (session: AgentSessionSummary, folders: AgentConversationFolderView[]) => {
  panelStore = VueRuntime.reactive({
    folders, sessions: [session], loading: false, sessionMutationBusy: false,
    sessionsLoadMoreError: '', sessionsLoadingMore: false, sessionsNextCursor: null,
    sessionsReloading: false, thread: null, error: '',
    reloadSessions: vi.fn().mockResolvedValue({ current: true, accepted: true }),
    reloadFolders: vi.fn().mockResolvedValue({ current: true, accepted: true }),
    cancelSessionReadTransition: vi.fn()
  })
  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const app = VueRuntime.createApp({
    setup: () => () => VueRuntime.h(HistoryPanel, { headingId: 'history-title', descriptionId: 'history-description' })
  })
  app.use(createVuetify({ components: vuetifyComponents, defaults: { VMenu: { transition: false } } }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mountedApps.push(() => { app.unmount(); host.remove() })
  await settle()
  const row = () => {
    const element = host.querySelector<HTMLElement>('.agent-history__list .v-list-item')
    if (!element) throw new Error('History did not render the conversation row')
    return element
  }
  const drag = () => {
    const event = new browserWindow.Event('dragstart', { bubbles: true, cancelable: true })
    const setData = vi.fn()
    Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } })
    row().dispatchEvent(event)
    return { event, setData }
  }
  return { host, row, drag, store: panelStore }
}
describe('Agent history folder actions', () => {

  it('keeps the current folder out of destinations while retaining Recent and New folder', async () => {
    const current = makeFolder()
    const other = makeFolder('10000000-0000-4000-8000-000000000002', 'Launch notes')
    const session = makeSession({ folderId: current.id, retention: 'saved' })
    const actions = await mountMoveMenu(session, [current, other])
    expect(Array.from(actions.menu.querySelectorAll('.v-list-item-title')).map(item => item.textContent?.trim()))
      .not.toContain(current.name)

    expect(menuItem(actions.menu, 'Recent')).not.toBeNull()
    expect(menuItem(actions.menu, 'New folder…')).not.toBeNull()
    actions.unmount()
  })
  it('restores focus to the visible Move button after cancelling New folder', async () => {
    const panel = await mountHistoryPanel(makeSession(), [])
    const trigger = panel.host.querySelector<HTMLButtonElement>('.agent-history-session-actions__move')
    if (!trigger) throw new Error('The conversation Move button did not render')
    // JSDOM has no layout; supply visibility at the browser geometry boundary.
    const rectangle = new browserWindow.DOMRect(0, 0, 1, 1)
    vi.spyOn(trigger, 'getClientRects').mockReturnValue(Object.assign([rectangle], {
      item: (index: number) => index === 0 ? rectangle : null
    }))
    trigger.focus()
    trigger.click()
    await settle()
    const menu = browserWindow.document.querySelector('.agent-history-session-actions__destinations')
    if (!menu) throw new Error('The Move destinations did not open')
    const newFolder = menuItem(menu, 'New folder…')
    newFolder.focus()
    newFolder.click()
    await settle()
    const dialog = browserWindow.document.querySelector('.v-dialog.v-overlay--active')
    if (!dialog) throw new Error('New folder did not open its dialog')
    const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Cancel')
    if (!cancel) throw new Error('New folder did not expose Cancel')
    cancel.click()
    await settle()
    expect(browserWindow.document.activeElement).toBe(trigger)
  })

  it('only exposes native dragging when a rendered destination exists and history is idle', async () => {
    const panel = await mountHistoryPanel(makeSession(), [])
    expect(panel.row().getAttribute('draggable')).toBe('true')
    const allowed = panel.drag()
    expect(allowed.event.defaultPrevented).toBe(false)
    expect(allowed.setData).toHaveBeenCalledWith('text/plain', makeSession().id)
    panel.row().dispatchEvent(new browserWindow.Event('dragend', { bubbles: true }))

    const search = panel.host.querySelector<HTMLInputElement>('input')
    if (!search) throw new Error('History search did not render')
    search.value = 'Release'
    search.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    expect(panel.row().getAttribute('draggable')).toBe('false')
    const filtered = panel.drag()
    expect(filtered.event.defaultPrevented).toBe(true)
    expect(filtered.setData).not.toHaveBeenCalled()

    search.value = ''
    search.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    panel.store.sessionMutationBusy = true
    await settle()
    expect(panel.row().getAttribute('draggable')).toBe('false')
    expect(panel.drag().event.defaultPrevented).toBe(true)
    panel.store.sessionMutationBusy = false
    panel.store.sessionsReloading = true
    await settle()
    expect(panel.row().getAttribute('draggable')).toBe('false')
    expect(panel.drag().event.defaultPrevented).toBe(true)
    panel.store.sessionsReloading = false
    await settle()

    const recentOnly = Array.from(panel.host.querySelectorAll<HTMLButtonElement>('.agent-history__scope-controls button'))
      .find(button => button.textContent?.trim() === 'Recent')
    if (!recentOnly) throw new Error('Recent directory scope did not render')
    recentOnly.click()
    await settle()
    expect(panel.row().getAttribute('draggable')).toBe('false')
    expect(panel.drag().event.defaultPrevented).toBe(true)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { fetchSearchEngines, inspectSearchIndex, rebuildSearchIndex, saveSearchEngines } from '../../helpers/search-api.ts'
import { getErrorMessage, loadingStart, loadingStop, pushGraphError, showNotification } from '../../helpers/root-ui-store.ts'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { afterEach } from '../../../server/test/bun-test.mts'
import { compileTemplate } from '@vue/compiler-sfc'

const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const mounted = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() }
})
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Vue.nextTick() }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/admin/admin-search.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('admin-search.vue TypeScript script block is unavailable')

const directRootUiCommit =
  /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))
const instantiate = new Function(
  'AdminSearchEvaluate',
  'inspectSearchIndex',
  'fetchSearchEngines',
  'rebuildSearchIndex',
  'saveSearchEngines',
  'wikiStore',
  'getErrorMessage',
  'loadingStart',
  'loadingStop',
  'showNotification',
  'pushGraphError',
  'window',
  executable
)

const jsonResponse = (payload, ok = true) => ({
  ok,
  headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => payload
})

const engineRow = (key, { isEnabled = false, isAvailable = true, value = 'initial' } = {}) => ({
  isEnabled,
  key,
  title: key,
  description: `${key} search`,
  logo: '',
  website: '',
  isAvailable,
  config: [{ key: 'mode', value: JSON.stringify({ type: 'string', value }) }]
})

function createHarness(fetchImpl) {
  const loadingEvents = []
  const notifications = []
  const notificationState = []
  const errors = []
  let instance
  const wikiStore = {
    startLoading: key => loadingEvents.push(['start', key]),
    stopLoading: key => loadingEvents.push(['stop', key]),
    showNotification: notification => {
      notifications.push(notification)
      const selected = instance?.engines.find(engine => engine.key === instance.selectedEngine)
      notificationState.push(selected?.config[0]?.value.value)
    },
    showError: error => errors.push(error)
  }
  const component = instantiate(
    {},
    inspectSearchIndex,
    fetchSearchEngines,
    rebuildSearchIndex,
    saveSearchEngines,
    wikiStore,
    getErrorMessage,
    loadingStart,
    loadingStop,
    showNotification,
    pushGraphError,
    { fetch: fetchImpl, location: browserWindow.location, history: browserWindow.history, addEventListener() {}, removeEventListener() {} }
  )
  instance = { ...component.data(), $t: key => key }
  for (const [key, method] of Object.entries(component.methods)) {
    if (typeof method === 'function') instance[key] = method.bind(instance)
  }
  for (const [key, getter] of Object.entries(component.computed)) {
    if (typeof getter === 'function') Object.defineProperty(instance, key, { get: () => getter.call(instance) })
  }
  return { component, instance, loadingEvents, notifications, notificationState, errors }
}

const template = compileTemplate({
  source: source.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
  filename: 'admin-search.vue',
  id: 'search-administration-contract',
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue)
const mountSearch = harness => {
  const { component, instance } = harness
  const data = Object.fromEntries(Object.keys(component.data()).map(key => [key, instance[key]]))
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    ...component, data: () => data, render,
    // The method harness already loaded this snapshot; these cases own controls and dialogs, not startup.
    created: undefined, mounted: undefined
  })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives, defaults: { VDialog: { transition: false }, VWindow: { transition: false } } }))
  app.component('AdminHero', { render: () => null })
  app.config.globalProperties.$t = key => key
  const vm = app.mount(host)
  mounted.push({ app, host })
  return { vm, host }
}

describe('admin-search REST and root UI facade contracts', () => {
  it('renders named engine choices and review dialogs without unsupported runtime dependencies', async () => {
    expect(script).not.toMatch(directRootUiCommit)
    expect(script).not.toMatch(/this\.\$apollo/)
    const harness = createHarness(vi.fn(async () => jsonResponse([
      engineRow('postgres', { isEnabled: true }), engineRow('external'), engineRow('offline', { isAvailable: false })
    ])))
    await harness.instance.loadEngines()
    const { vm, host } = mountSearch(harness)
    await settle()
    const group = host.querySelector('[role="radiogroup"]')
    expect(group).not.toBeNull()
    const labelId = group.getAttribute('aria-labelledby')
    expect(document.getElementById(labelId)?.textContent.trim()).toBeTruthy()
    const radio = value => host.querySelector(`input[type="radio"][value="${value}"]`)
    radio('external').click()
    await settle()
    expect(vm.selectedEngine).toBe('external')
    expect(radio('offline').disabled).toBe(true)
    radio('offline').click()
    await settle()
    expect(vm.selectedEngine).toBe('external')
    for (const busy of ['saving', 'rebuilding']) {
      vm[busy] = true
      await settle()
      expect(radio('postgres').disabled).toBe(true)
      expect(radio('external').disabled).toBe(true)
      radio('postgres').click()
      expect(vm.selectedEngine).toBe('external')
      vm[busy] = false
      await settle()
    }
    vm.resetDraft()
    vm.tab = 'index'
    await settle()
    const rebuildButton = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Rebuild index'))
    rebuildButton.click()
    await settle()
    const assertNamedDialog = category => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(element =>
        document.getElementById(element.getAttribute('aria-labelledby'))?.textContent.match(category))
      expect(dialog).not.toBeNull()
      const title = document.getElementById(dialog.getAttribute('aria-labelledby'))
      expect(title).not.toBeNull()
      expect(title.textContent.trim()).toBeTruthy()
      return dialog
    }
    const rebuildDialog = assertNamedDialog(/rebuild/i)
    expect(rebuildDialog.contains(document.getElementById(rebuildDialog.getAttribute('aria-labelledby')))).toBe(true)
    vm.rebuildConfirm = false
    await settle()
    vm.engine.config[0].value.value = 'unsaved'
    const leave = harness.component.beforeRouteLeave.call(vm)
    await settle()
    const leaveDialog = assertNamedDialog(/discard/i)
    expect(leaveDialog.contains(document.getElementById(leaveDialog.getAttribute('aria-labelledby')))).toBe(true)
    const keepEditing = [...leaveDialog.querySelectorAll('button')].find(button => button.textContent.includes('Keep editing'))
    keepEditing.click()
    expect(await leave).toBe(false)
    expect(vm.dirty).toBe(true)
  })

  it('selects an available engine and announces refresh only after the refreshed data is committed', async () => {
    const responses = [
      [engineRow('postgres'), engineRow('first-available'), engineRow('selected', { isEnabled: true })],
      [engineRow('selected', { isEnabled: true, value: 'reloaded' })]
    ]
    const requests = []
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options })
      return jsonResponse(responses.shift())
    })
    const harness = createHarness(fetchImpl)
    const { instance } = harness

    expect(await instance.loadEngines()).toBe(true)
    expect(instance.selectedEngine).toBe('selected')
    expect(instance.canSave).toBe(false)
    await instance.refresh()

    expect(instance.engines[0].config[0].value.value).toBe('reloaded')
    expect(harness.notifications).toEqual([
      {
        message: 'admin:search.listRefreshSuccess',
        style: 'success',
        icon: 'cached'
      }
    ])
    expect(harness.notificationState).toEqual(['reloaded'])
    expect(requests.map(({ url }) => url)).toEqual(['/_api/search/engines', '/_api/search/engines'])
    expect(requests.every(({ options }) => options.credentials === 'same-origin' && options.signal instanceof AbortSignal)).toBe(true)
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh']
    ])
  })

  it('falls back to available Postgres, then the first available engine, or no engine', async () => {
    const scenarios = [
      {
        engines: [engineRow('enabled-offline', { isEnabled: true, isAvailable: false }), engineRow('postgres')],
        selected: 'postgres',
        dirty: true,
        canSave: true
      },
      {
        engines: [engineRow('postgres', { isAvailable: false }), engineRow('fallback')],
        selected: 'fallback',
        dirty: true,
        canSave: true
      },
      {
        engines: [engineRow('offline', { isAvailable: false })],
        selected: '',
        dirty: false,
        canSave: false
      }
    ]

    for (const scenario of scenarios) {
      const harness = createHarness(vi.fn(async () => jsonResponse(scenario.engines)))
      await harness.instance.loadEngines()
      expect(harness.instance.selectedEngine).toBe(scenario.selected)
      if (!scenario.selected) expect(harness.instance.engine.key).toBe('')
      expect(harness.instance.dirty).toBe(scenario.dirty)
      expect(harness.instance.canSave).toBe(scenario.canSave)
    }
  })

  it('requires the selected engine to be available before enabling Apply', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([engineRow('online', { isEnabled: true }), engineRow('offline', { isAvailable: false })]))
    const { instance } = createHarness(fetchImpl)

    await instance.loadEngines()
    const requestCount = fetchImpl.mock.calls.length
    for (const busyState of ['saving', 'rebuilding', 'enginesLoading']) {
      instance[busyState] = true
      await instance.refresh()
      instance[busyState] = false
    }
    expect(fetchImpl).toHaveBeenCalledTimes(requestCount)
    instance.engines.find(engine => engine.key === 'online').config[0].value.value = 'changed'
    expect(instance.canSave).toBe(true)
    for (const busyState of ['saving', 'rebuilding', 'enginesLoading']) {
      instance[busyState] = true
      expect(instance.canSave).toBe(false)
      instance[busyState] = false
    }
    instance.selectedEngine = 'offline'
    expect(instance.dirty).toBe(true)
    expect(instance.canSave).toBe(false)
  })

  it('balances loading and reports a failed refresh without announcing success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Search settings unavailable' }, false))
    const harness = createHarness(fetchImpl)

    await harness.instance.refresh()

    expect(harness.instance.engines).toEqual([])
    expect(harness.instance.enginesLoaded).toBe(false)
    expect(harness.instance.enginesLoadError).toBe(true)
    expect(harness.instance.enginesLoading).toBe(false)
    expect(harness.notifications).toEqual([
      {
        message: 'Search settings unavailable',
        style: 'error',
        icon: 'alert'
      }
    ])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh']
    ])
  })

  it('does not commit or announce a refresh superseded by component unmount', async () => {
    let pendingSignal
    let resolvePending
    let requests = 0
    const fetchImpl = vi.fn((_, options) => {
      requests++
      if (requests === 1) return Promise.resolve(jsonResponse([engineRow('postgres', { isEnabled: true })]))
      pendingSignal = options.signal
      return new Promise(resolve => {
        resolvePending = resolve
      })
    })
    const harness = createHarness(fetchImpl)
    await harness.instance.loadEngines()
    const previouslyLoaded = structuredClone(harness.instance.engines)

    const refresh = harness.instance.refresh()
    expect(await harness.instance.loadEngines()).toBe(false)
    await harness.instance.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(pendingSignal).toBeInstanceOf(AbortSignal)
    harness.component.beforeUnmount.call(harness.instance)
    expect(pendingSignal.aborted).toBe(true)
    resolvePending(jsonResponse([engineRow('postgres', { isEnabled: true, value: 'stale' })]))
    await refresh

    expect(harness.instance.engines).toEqual(previouslyLoaded)
    expect(harness.notifications).toEqual([])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh']
    ])
  })

  it('aborts in-flight save and rebuild requests on unmount without surfacing stale effects', async () => {
    const exerciseAbort = async (operation, loadingKey) => {
      let requestSignal
      let rejectInFlight
      const fetchImpl = vi.fn((_, options) => {
        if (!options.method) return Promise.resolve(jsonResponse([engineRow('postgres', { isEnabled: true })]))
        requestSignal = options.signal
        return new Promise((_, reject) => {
          rejectInFlight = reject
          requestSignal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
        })
      })
      const harness = createHarness(fetchImpl)
      await harness.instance.loadEngines()
      if (operation === 'save') harness.instance.engine.config[0].value.value = 'edited'
      else harness.instance.rebuildConfirm = true

      const pending = harness.instance[operation]()
      await harness.instance[operation]()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      harness.component.beforeUnmount.call(harness.instance)
      if (!requestSignal?.aborted) rejectInFlight(new Error('request was not aborted'))
      await pending

      expect(requestSignal).toBeInstanceOf(AbortSignal)
      expect(requestSignal.aborted).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(harness.notifications).toEqual([])
      expect(harness.errors).toEqual([])
      expect(harness.loadingEvents).toEqual([
        ['start', 'admin-search-refresh'],
        ['stop', 'admin-search-refresh'],
        ['start', loadingKey],
        ['stop', loadingKey]
      ])
    }

    await exerciseAbort('save', 'admin-search-saveengines')
    await exerciseAbort('rebuild', 'admin-search-rebuildindex')
  })

  it('does not announce a save as successful when its post-save reload fails', async () => {
    let engineLoads = 0
    const fetchImpl = vi.fn(async (_, options) => {
      if (options.method === 'POST') return jsonResponse({ message: 'Search engines saved' })
      engineLoads++
      return engineLoads === 1
        ? jsonResponse([engineRow('postgres', { isEnabled: true, value: 'initial' })])
        : jsonResponse({ error: 'Reload unavailable' }, false)
    })
    const harness = createHarness(fetchImpl)
    await harness.instance.loadEngines()
    harness.instance.engine.config[0].value.value = 'edited'

    await harness.instance.save()

    expect(harness.instance.operationError).toContain('Configuration was saved, but could not be reloaded.')
    expect(harness.instance.operationError).toContain('Reload unavailable')
    expect(harness.instance.saving).toBe(false)
    expect(harness.notifications).toEqual([])
    expect(harness.errors.map(error => error.message)).toEqual(['Reload unavailable'])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-saveengines'],
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['stop', 'admin-search-saveengines']
    ])
  })

  it('saves every engine with the current selection and announces only after the silent reload', async () => {
    const initial = [engineRow('postgres', { isEnabled: true, value: 'old-postgres' }), engineRow('external', { value: 'old-external' })]
    const saved = [engineRow('postgres', { value: 'old-postgres' }), engineRow('external', { isEnabled: true, value: 'server-normalized' })]
    const requests = []
    let engineLoads = 0
    const readback = deferred()
    const readbackStarted = deferred()
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options })
      if (options.method === 'POST') return jsonResponse({ message: 'Search engines saved' })
      engineLoads++
      if (engineLoads === 1) return jsonResponse(initial)
      readbackStarted.resolve()
      return readback.promise
    })
    const harness = createHarness(fetchImpl)
    const { instance } = harness
    await instance.loadEngines()
    instance.selectedEngine = 'external'
    instance.engine.config[0].value.value = 'edited'

    expect(instance.canSave).toBe(true)
    const saving = instance.save()
    await readbackStarted.promise
    expect(instance.saving).toBe(true)
    expect(instance.engine.config[0].value.value).toBe('edited')
    expect(harness.notifications).toEqual([])
    expect(harness.notificationState).toEqual([])
    readback.resolve(jsonResponse(saved))
    await saving

    expect(JSON.parse(requests[1].options.body)).toEqual({
      engines: [
        { isEnabled: false, key: 'postgres', config: [{ key: 'mode', value: '{"v":"old-postgres"}' }] },
        { isEnabled: true, key: 'external', config: [{ key: 'mode', value: '{"v":"edited"}' }] }
      ]
    })
    expect(requests.map(({ url }) => url)).toEqual(['/_api/search/engines', '/_api/search/engines', '/_api/search/engines'])
    expect(requests[1].options.method).toBe('POST')
    expect(instance.dirty).toBe(false)
    expect(instance.saving).toBe(false)
    expect(harness.notifications).toEqual([
      {
        message: 'admin:search.configSaveSuccess',
        style: 'success',
        icon: 'check'
      }
    ])
    expect(instance.engine.config[0].value.value).toBe('server-normalized')
    expect(harness.notificationState).toEqual(['server-normalized'])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-saveengines'],
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['stop', 'admin-search-saveengines']
    ])
  })

  it('announces rebuild completion only after the same-origin operation succeeds', async () => {
    const requests = []
    const response = deferred()
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options })
      return options.method === 'POST' ? response.promise : jsonResponse([engineRow('postgres', { isEnabled: true })])
    })
    const harness = createHarness(fetchImpl)
    const { instance } = harness
    instance.rebuildConfirm = true
    await instance.rebuild()
    expect(fetchImpl).toHaveBeenCalledTimes(0)

    await instance.loadEngines()
    instance.engine.config[0].value.value = 'unsaved'
    await instance.rebuild()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    instance.engine.config[0].value.value = 'initial'
    instance.rebuildConfirm = true

    const { vm, host } = mountSearch(harness)
    vm.tab = 'index'
    const rebuilding = vm.rebuild()
    await settle()
    expect(vm.rebuilding).toBe(true)
    expect(harness.notifications).toEqual([])
    const pendingStatus = host.querySelector('.search-index [role="status"]')
    expect(pendingStatus).not.toBeNull()
    expect(pendingStatus.textContent).toMatch(/waiting|rebuilding/i)
    expect(pendingStatus.textContent).not.toMatch(/completed/i)
    response.resolve(jsonResponse({ message: 'Index rebuilt successfully' }))
    await rebuilding
    await settle()

    expect(requests.map(({ url }) => url)).toEqual(['/_api/search/engines', '/_api/search/rebuild-index'])
    expect(requests[1].options).toMatchObject({
      method: 'POST',
      credentials: 'same-origin'
    })
    const completedStatus = host.querySelector('.search-index [role="status"]')
    expect(completedStatus).not.toBeNull()
    expect(completedStatus.textContent).toMatch(/\bserver\b.*\bconfirm(?:ed|ation)\b/i)
    expect(completedStatus.textContent).toMatch(/\bcomplet(?:e|ed|ion)\b/i)
    expect(completedStatus.textContent).not.toMatch(/\bwithout\b.*\bconfirmation\b/i)
    expect(vm.rebuilding).toBe(false)
    expect(harness.notifications).toEqual([
      {
        message: 'admin:search.indexRebuildSuccess',
        style: 'success',
        icon: 'check'
      }
    ])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-rebuildindex'],
      ['stop', 'admin-search-rebuildindex']
    ])
  })

  it('reports an unconfirmed rebuild failure and releases busy state', async () => {
    const fetchImpl = vi.fn(async (_, options) =>
      options.method === 'POST' ? jsonResponse({ error: 'Index rebuild failed' }, false) : jsonResponse([engineRow('postgres', { isEnabled: true })])
    )
    const harness = createHarness(fetchImpl)
    await harness.instance.loadEngines()

    await harness.instance.rebuild()

    expect(harness.instance.rebuildMessage).toBe('The request ended without completion confirmation. Inspect the index before retrying.')
    expect(harness.instance.operationError).toBe('Index rebuild failed')
    expect(harness.instance.rebuilding).toBe(false)
    expect(harness.notifications).toEqual([])
    expect(harness.errors.map(error => error.message)).toEqual(['Index rebuild failed'])
    expect(harness.loadingEvents).toEqual([
      ['start', 'admin-search-refresh'],
      ['stop', 'admin-search-refresh'],
      ['start', 'admin-search-rebuildindex'],
      ['stop', 'admin-search-rebuildindex']
    ])
  })
})

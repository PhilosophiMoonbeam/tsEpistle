import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { fetchSearchEngines, inspectSearchIndex, rebuildSearchIndex, saveSearchEngines } from '../../helpers/search-api.ts'
import { getErrorMessage, loadingStart, loadingStop, pushGraphError, showNotification } from '../../helpers/root-ui-store.ts'

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
    { fetch: fetchImpl, addEventListener() {}, removeEventListener() {} }
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

describe('admin-search REST and root UI facade contracts', () => {
  it('retains REST, typed root-store, lifecycle, and accessibility boundaries', () => {
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSearchEngines\b)(?=[^}]*\brebuildSearchIndex\b)(?=[^}]*\bsaveSearchEngines\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/search-api['"]/
    )
    expect(script).not.toMatch(directRootUiCommit)
    expect(script).not.toMatch(/this\.\$apollo|search-mutation-(?:save-engines|rebuild-index)\.gql|engines(?:Save|Rebuild)Mutation/)
    expect(source).toContain('aria-labelledby="rebuild-confirm-title"')
    expect(source).toContain('aria-labelledby="search-discard-title"')
    expect(source).toMatch(
      /<v-radio-group\b(?=[^>]*\bv-model="selectedEngine")(?=[^>]*\blabel="Choose an engine")(?=[^>]*:disabled="saving \|\| rebuilding")[^>]*>/
    )
    expect(source).toMatch(/<v-radio\b(?=[^>]*:value="eng\.key")(?=[^>]*:disabled="!eng\.isAvailable")[^>]*>/)
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
    const saved = [engineRow('postgres', { value: 'old-postgres' }), engineRow('external', { isEnabled: true, value: 'edited' })]
    const requests = []
    let engineLoads = 0
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options })
      if (options.method === 'POST') return jsonResponse({ message: 'Search engines saved' })
      engineLoads++
      return jsonResponse(engineLoads === 1 ? initial : saved)
    })
    const harness = createHarness(fetchImpl)
    const { instance } = harness
    await instance.loadEngines()
    instance.selectedEngine = 'external'
    instance.engine.config[0].value.value = 'edited'

    expect(instance.canSave).toBe(true)
    await instance.save()

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
    expect(harness.notificationState).toEqual(['edited'])
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
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options })
      return options.method === 'POST' ? jsonResponse({ message: 'Index rebuilt successfully' }) : jsonResponse([engineRow('postgres', { isEnabled: true })])
    })
    const harness = createHarness(fetchImpl)
    const { component, instance } = harness
    instance.rebuildConfirm = true
    await instance.rebuild()
    expect(fetchImpl).toHaveBeenCalledTimes(0)

    await instance.loadEngines()
    instance.engine.config[0].value.value = 'unsaved'
    await instance.rebuild()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    instance.engine.config[0].value.value = 'initial'
    instance.rebuildConfirm = true

    await instance.rebuild()

    expect(requests.map(({ url }) => url)).toEqual(['/_api/search/engines', '/_api/search/rebuild-index'])
    expect(requests[1].options).toMatchObject({
      method: 'POST',
      credentials: 'same-origin'
    })
    expect(harness.instance.rebuildMessage).toBe('The server confirmed that the index rebuild completed.')
    expect(harness.instance.rebuilding).toBe(false)
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

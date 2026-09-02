import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sourcePath = path.join(__dirname, 'admin-auth.vue')
const source = fs.readFileSync(sourcePath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]

const extractMethod = name => {
  const start = script.search(new RegExp(`    async ${name}\\s*\\(`))
  expect(start).toBeGreaterThan(-1)

  const parametersStart = script.indexOf('(', start)
  let parametersDepth = 0
  let bodyStart = -1
  for (let index = parametersStart; index < script.length; index++) {
    if (script[index] === '(') {
      parametersDepth++
    } else if (script[index] === ')') {
      parametersDepth--
      if (parametersDepth === 0) {
        bodyStart = script.indexOf('{', index + 1)
        break
      }
    }
  }

  let bodyDepth = 0
  for (let index = bodyStart; index < script.length; index++) {
    if (script[index] === '{') {
      bodyDepth++
    } else if (script[index] === '}') {
      bodyDepth--
      if (bodyDepth === 0) {
        return script.slice(start, index + 1)
      }
    }
  }

  throw new Error(`Could not extract ${name}`)
}

const compileMethod = (name, dependencies) => {
  const method = extractMethod(name).replaceAll(': FetchImpl', '').replaceAll(': AbortSignal', '').replace(': { notifyError?: boolean }', '')
  return Function(...Object.keys(dependencies), `return ({ ${method} }).${name}`)(...Object.values(dependencies))
}

describe('admin-auth strategies REST facade', () => {
  const loadStrategies = extractMethod('loadStrategies')
  const loadActiveStrategies = extractMethod('loadActiveStrategies')
  const loadInitial = extractMethod('loadInitial')
  const refresh = extractMethod('refresh')
  const save = extractMethod('save')

  test('imports REST auth helpers, uses raw fallback state, and removes Apollo query surface', () => {
    expect(script).toContain('fetchAdminAuthStrategies')
    expect(script).toContain('fetchAdminAuthActiveStrategies')
    expect(script).toContain('updateAdminAuthStrategies')
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { markRaw } from 'vue'")
    expect(script).toContain('const EMPTY_STRATEGY = markRaw(createEmptyStrategy())')
    expect(script).toContain("return _.find(this.activeStrategies, ['key', this.selectedStrategy]) || EMPTY_STRATEGY")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('apollo: {')
    expect(script).not.toContain('authentication {')
    expect(script).not.toContain('this.$apollo.queries')
  })

  test('uses native list semantics for selectable strategy rows with independent reorder controls', () => {
    expect(source).toContain('v-list(lines="two", density="compact", :aria-label=')
    expect(source).toContain("v-for='(str, idx) in activeStrategies'")
    expect(source).not.toMatch(/\brole=(['"])(?:listbox|option)\1/)
    expect(source).not.toContain(':aria-selected=')
    expect(source).toContain(":aria-current='selectedStrategy === str.key ? `true` : undefined'")
    expect(source).toContain("                  link\n                  @click='selectedStrategy = str.key'")
    expect(source).toMatch(/:aria-label=['"]`Move \$\{str\.displayName\} \(position \$\{idx \+ 1\}\)`['"]/)
    expect(source).toMatch(/:aria-label=['"]`Move \$\{str\.displayName\} up`['"]/)
    expect(source).toContain("@click.stop='moveStrategy(idx, -1)'")
    expect(source).toMatch(/:aria-label=['"]`Move \$\{str\.displayName\} down`['"]/)
    expect(source).toContain("@click.stop='moveStrategy(idx, 1)'")
  })

  test('uses strict boolean model updates for strategy configuration', () => {
    expect(source).toContain(":model-value='cfg.value.value === true'")
    expect(source).toContain("@update:model-value='cfg.value.value = $event === true'")
  })

  test('loads strategy definitions and active strategies through the owned abortable REST facade', () => {
    expect(loadStrategies).toContain("wikiStore.startLoading('admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain("fetchAdminAuthStrategies(fetchImpl, 'Authentication strategies response is invalid')")
    expect(loadStrategies).toContain('if (!signal.aborted && !this.isUnmounted) {')
    expect(loadStrategies).toContain("wikiStore.stopLoading('admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain('wikiStore.showNotification({')

    expect(loadActiveStrategies).toContain("wikiStore.startLoading('admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain("fetchAdminAuthActiveStrategies(fetchImpl, 'Active authentication strategies response is invalid')")
    expect(loadActiveStrategies).toContain('if (!signal.aborted && !this.isUnmounted) {')
    expect(loadActiveStrategies).toContain("wikiStore.stopLoading('admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain('wikiStore.showNotification({')
  })

  test('refresh confirms dirty state and reloads the complete initial contract before notifying success', async () => {
    expect(refresh).toContain("if (this.dirty && !window.confirm('Discard unsaved authentication changes and refresh?')) return")
    expect(refresh).toContain('await this.loadInitial()')
    expect(refresh).toContain('if (!this.isUnmounted && this.loaded) {')
    expect(refresh).toContain('wikiStore.showNotification({')
    expect(refresh).toContain("message: this.$t('admin:auth.refreshSuccess')")

    const notifications = []
    let loadCount = 0
    let allowRefresh = false
    const refreshMethod = compileMethod('refresh', {
      window: { confirm: () => allowRefresh },
      wikiStore: { showNotification: notification => notifications.push(notification) }
    })
    const context = {
      dirty: true,
      loaded: true,
      initialLoading: false,
      saving: false,
      isUnmounted: false,
      loadInitial: async () => {
        loadCount++
      },
      $t: key => key
    }

    await refreshMethod.call(context)
    expect(loadCount).toBe(0)
    expect(notifications).toEqual([])

    allowRefresh = true
    await refreshMethod.call(context)
    expect(loadCount).toBe(1)
    expect(notifications).toEqual([
      {
        message: 'admin:auth.refreshSuccess',
        style: 'success',
        icon: 'cached'
      }
    ])
  })

  test.each([
    ['strategies', 'admin-auth-strategies-refresh'],
    ['active strategies', 'admin-auth-activestrategies-refresh'],
    ['host', 'admin-auth-host-refresh']
  ])('refresh settles after one owned %s error and balances every loading owner', async (failingResource, failingLoadingKey) => {
    const resourceOrder = ['groups', 'host', 'strategies', 'active strategies']
    const loadingKeys = ['admin-auth-groups-refresh', 'admin-auth-host-refresh', 'admin-auth-strategies-refresh', 'admin-auth-activestrategies-refresh']
    const calls = []
    const resourceFetches = []
    const loadingStarts = []
    const loadingStops = []
    const notifications = []
    const failure = new Error(`${failingResource} failed`)
    const fetchResource = (resource, result) => async fetchImpl => {
      calls.push(resource)
      resourceFetches.push(fetchImpl)
      if (resource === failingResource) {
        throw failure
      }
      return result
    }
    const wikiStore = {
      startLoading: key => loadingStarts.push(key),
      stopLoading: key => loadingStops.push(key),
      showNotification: notification => notifications.push(notification)
    }
    const fetchWindow = { fetch() {}, confirm: () => true }
    let ownedSignal
    let ownedFetch
    const createAbortableFetch = signal => {
      ownedSignal = signal
      ownedFetch = (input, init) => fetchWindow.fetch(input, { ...init, signal })
      return ownedFetch
    }
    const dependencies = {
      wikiStore,
      fetchGroupOptions: fetchResource('groups', []),
      fetchSystemHost: fetchResource('host', { host: 'https://example.test' }),
      fetchAdminAuthStrategies: fetchResource('strategies', []),
      fetchAdminAuthActiveStrategies: fetchResource('active strategies', []),
      window: fetchWindow,
      getErrorMessage: err => err.message
    }
    const context = {
      groups: [],
      strategies: [],
      activeStrategies: [],
      persistedStrategies: [],
      selectedStrategy: '',
      host: '',
      initialLoading: false,
      loaded: true,
      isUnmounted: false,
      loadController: null,
      dirty: false,
      loadGroups: compileMethod('loadGroups', dependencies),
      loadHost: compileMethod('loadHost', dependencies),
      loadStrategies: compileMethod('loadStrategies', dependencies),
      loadActiveStrategies: compileMethod('loadActiveStrategies', dependencies),
      $t: key => key
    }
    context.loadInitial = compileMethod('loadInitial', {
      _: { cloneDeep: value => structuredClone(value) },
      AbortController,
      createAbortableFetch
    })
    const refreshMethod = compileMethod('refresh', dependencies)

    await expect(refreshMethod.call(context)).resolves.toBeUndefined()

    expect(calls).toEqual(resourceOrder)
    expect(resourceFetches).toHaveLength(resourceOrder.length)
    expect(resourceFetches.every(fetchImpl => fetchImpl === ownedFetch)).toBe(true)
    expect(ownedSignal.aborted).toBe(true)
    expect(loadingStarts).toEqual(loadingKeys)
    expect(loadingStops).toEqual(loadingKeys)
    expect(loadingStarts).toContain(failingLoadingKey)
    expect(context.loaded).toBe(false)
    expect(context.initialLoading).toBe(false)
    expect(context.loadController).toBeNull()
    expect(notifications).toEqual([
      {
        style: 'red',
        message: failure.message,
        icon: 'alert'
      }
    ])
  })

  test('created hook owns the complete abortable REST load and snapshots a successfully loaded strategy state', () => {
    expect(loadInitial).toContain('this.loadController?.abort()')
    expect(loadInitial).toContain('const controller = new AbortController()')
    expect(loadInitial).toContain('this.loadController = controller')
    expect(loadInitial).toContain('const fetchImpl = createAbortableFetch(controller.signal)')
    expect(loadInitial).toContain('this.loaded = false')
    expect(loadInitial).toContain('this.loadGroups(fetchImpl, controller.signal)')
    expect(loadInitial).toContain('this.loadHost(fetchImpl, controller.signal)')
    expect(loadInitial).toContain('this.loadStrategies(fetchImpl, controller.signal)')
    expect(loadInitial).toContain('this.loadActiveStrategies(fetchImpl, controller.signal)')
    expect(loadInitial).toContain('this.persistedStrategies = _.cloneDeep(this.activeStrategies)')
    expect(loadInitial).toContain('if (this.loadController === controller) {')
    expect(loadInitial).toContain('this.loaded = true')
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*void this\.loadInitial\(\)\s*\}/)
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{[\s\S]*?this\.isUnmounted\s*=\s*true[\s\S]*?this\.loadController\?\.abort\(\)[\s\S]*?this\.saveController\?\.abort\(\)/
    )
  })

  test('save uses an owned abortable REST request and preserves payload mapping and UI behavior', () => {
    expect(save).toContain("wikiStore.startLoading('admin-auth-savestrategies')")
    expect(save).toContain('const controller = new AbortController()')
    expect(save).toContain('this.saveController = controller')
    expect(save).toContain('await updateAdminAuthStrategies(createAbortableFetch(controller.signal), this.activeStrategies.map((str, idx) => ({')
    expect(save).toContain('strategyKey: str.strategy.key')
    expect(save).toContain('order: idx')
    expect(save).toContain('config: str.config.map(cfg => ({ ...cfg, value: JSON.stringify({ v: cfg.value.value }) }))')
    expect(save).toContain('domainWhitelist: str.domainWhitelist')
    expect(save).toContain('autoEnrollGroups: str.autoEnrollGroups')
    expect(save).toContain('if (controller.signal.aborted || this.isUnmounted) {')
    expect(save).toContain('wikiStore.showNotification({')
    expect(save).toContain("message: this.$t('admin:auth.saveSuccess')")
    expect(save).toContain('if (!controller.signal.aborted && !this.isUnmounted) {')
    expect(save).toContain('wikiStore.showError(err)')
    expect(save).toContain('if (this.saveController === controller) {')
    expect(save).toContain("wikiStore.stopLoading('admin-auth-savestrategies')")
    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('updateStrategies')
    expect(save).not.toContain('responseResult')
  })
})

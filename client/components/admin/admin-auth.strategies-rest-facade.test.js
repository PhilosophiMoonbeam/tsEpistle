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
  const method = extractMethod(name).replace(': { notifyError?: boolean }', '')
  return Function(...Object.keys(dependencies), `return ({ ${method} }).${name}`)(...Object.values(dependencies))
}

describe('admin-auth strategies REST facade', () => {
  const loadStrategies = extractMethod('loadStrategies')
  const loadActiveStrategies = extractMethod('loadActiveStrategies')
  const loadInitial = extractMethod('loadInitial')
  const refresh = extractMethod('refresh')
  const save = extractMethod('save')

  test('imports REST auth helpers and removes Apollo query surface', () => {
    expect(script).toContain('fetchAdminAuthStrategies')
    expect(script).toContain('fetchAdminAuthActiveStrategies')
    expect(script).toContain('updateAdminAuthStrategies')
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
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

  test('loads strategy definitions and active strategies through REST helpers', () => {
    expect(loadStrategies).toContain("wikiStore.startLoading('admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain("fetchAdminAuthStrategies(window.fetch.bind(window), 'Authentication strategies response is invalid')")
    expect(loadStrategies).toContain("wikiStore.stopLoading('admin-auth-strategies-refresh')")
    expect(loadStrategies).toContain('wikiStore.showNotification({')

    expect(loadActiveStrategies).toContain("wikiStore.startLoading('admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain("fetchAdminAuthActiveStrategies(window.fetch.bind(window), 'Active authentication strategies response is invalid')")
    expect(loadActiveStrategies).toContain("wikiStore.stopLoading('admin-auth-activestrategies-refresh')")
    expect(loadActiveStrategies).toContain('wikiStore.showNotification({')
  })

  test('refresh confirms dirty state and reloads the complete initial contract before notifying success', async () => {
    expect(refresh).toContain("if (this.dirty && !window.confirm('Discard unsaved authentication changes and refresh?')) return")
    expect(refresh).toContain('await this.loadInitial()')
    expect(refresh).toContain('if (this.loaded) {')
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
    const loadingStarts = []
    const loadingStops = []
    const notifications = []
    const failure = new Error(`${failingResource} failed`)
    const fetchResource = (resource, result) => async () => {
      calls.push(resource)
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
    const dependencies = {
      wikiStore,
      fetchGroupOptions: fetchResource('groups', []),
      fetchSystemHost: fetchResource('host', { host: 'https://example.test' }),
      fetchAdminAuthStrategies: fetchResource('strategies', []),
      fetchAdminAuthActiveStrategies: fetchResource('active strategies', []),
      window: { fetch() {}, confirm: () => true },
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
      dirty: false,
      loadGroups: compileMethod('loadGroups', dependencies),
      loadHost: compileMethod('loadHost', dependencies),
      loadStrategies: compileMethod('loadStrategies', dependencies),
      loadActiveStrategies: compileMethod('loadActiveStrategies', dependencies),
      $t: key => key
    }
    context.loadInitial = compileMethod('loadInitial', {
      _: { cloneDeep: value => structuredClone(value) }
    })
    const refreshMethod = compileMethod('refresh', dependencies)

    await expect(refreshMethod.call(context)).resolves.toBeUndefined()

    expect(calls).toEqual(resourceOrder)
    expect(loadingStarts).toEqual(loadingKeys)
    expect(loadingStops).toEqual(loadingKeys)
    expect(loadingStarts).toContain(failingLoadingKey)
    expect(context.loaded).toBe(false)
    expect(context.initialLoading).toBe(false)
    expect(notifications).toEqual([
      {
        style: 'red',
        message: failure.message,
        icon: 'alert'
      }
    ])
  })

  test('created hook starts the complete REST load and snapshots a successfully loaded strategy state', () => {
    expect(loadInitial).toContain('this.loaded = false')
    expect(loadInitial).toContain('this.loadGroups()')
    expect(loadInitial).toContain('this.loadHost()')
    expect(loadInitial).toContain('this.loadStrategies()')
    expect(loadInitial).toContain('this.loadActiveStrategies()')
    expect(loadInitial).toContain('this.persistedStrategies = _.cloneDeep(this.activeStrategies)')
    expect(loadInitial).toContain('this.loaded = true')
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*void this\.loadInitial\(\)\s*\}/)
  })

  test('save uses REST helper and preserves payload mapping and UI behavior', () => {
    expect(save).toContain("wikiStore.startLoading('admin-auth-savestrategies')")
    expect(save).toContain('await updateAdminAuthStrategies(window.fetch.bind(window), this.activeStrategies.map((str, idx) => ({')
    expect(save).toContain('strategyKey: str.strategy.key')
    expect(save).toContain('order: idx')
    expect(save).toContain('config: str.config.map(cfg => ({ ...cfg, value: JSON.stringify({ v: cfg.value.value }) }))')
    expect(save).toContain('domainWhitelist: str.domainWhitelist')
    expect(save).toContain('autoEnrollGroups: str.autoEnrollGroups')
    expect(save).toContain('wikiStore.showNotification({')
    expect(save).toContain("message: this.$t('admin:auth.saveSuccess')")
    expect(save).toContain('wikiStore.showError(err)')
    expect(save).toContain("wikiStore.stopLoading('admin-auth-savestrategies')")
    expect(save).not.toContain('this.$apollo.mutate')
    expect(save).not.toContain('updateStrategies')
    expect(save).not.toContain('responseResult')
  })
})

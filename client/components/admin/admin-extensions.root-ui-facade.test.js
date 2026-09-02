import fs from 'node:fs'
import path from 'node:path'

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(`))
  if (methodStart === -1) return null

  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) return script.slice(methodStart, idx + 1)
    }
  }
  return null
}

const compileMethod = (method, dependencies) => {
  const executable = method.replace(/^async\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, 'async function () {')
  return new Function(...Object.keys(dependencies), `return (${executable})`)(...Object.values(dependencies))
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createRootUi = () => {
  const loadingEvents = []
  const errors = []
  return {
    loadingEvents,
    errors,
    loadingStart: (_store, key) => loadingEvents.push(['start', key]),
    loadingStop: (_store, key) => loadingEvents.push(['stop', key]),
    pushGraphError: (_store, error) => errors.push(error)
  }
}

const createViewModel = loadExtensions => ({
  extensions: [{ key: 'previous' }],
  loadState: 'success',
  isUnmounted: false,
  loadExtensions
})

describe('admin-extensions root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-extensions.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]
  const loadExtensionsSource = extractMethod(script, 'loadExtensions')
  const wikiStore = {}
  const windowStub = { fetch: jest.fn() }

  test('uses typed REST and root UI facades with the current expansion-panel contract', () => {
    expect(loadExtensionsSource).not.toBeNull()
    expect(script).toContain("import { fetchSystemExtensions, type SystemExtension } from '../../helpers/system-api'")
    expect(script).toContain("import { loadingStart, loadingStop, pushGraphError } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/\$store\.commit|this\.\$apollo|mutation\s*:\s*gql`/)
    expect(source).toMatch(
      /v-expansion-panels\.admin-extensions-exp\((?=[^\n)]*\bv-else-if=['"]extensions\.length['"])(?=[^\n)]*\bvariant=["']popout["'])[^\n)]*\)/
    )
  })

  test('owns refresh loading and publishes the raw extension response only after it resolves', async () => {
    const request = deferred()
    const rootUi = createRootUi()
    const response = [{ key: 'search', title: 'Search' }]
    const markRaw = jest.fn(value => value)
    const fetchSystemExtensions = jest.fn(() => request.promise)
    const loadExtensions = compileMethod(loadExtensionsSource, {
      fetchSystemExtensions,
      loadingStart: rootUi.loadingStart,
      loadingStop: rootUi.loadingStop,
      pushGraphError: rootUi.pushGraphError,
      markRaw,
      wikiStore,
      window: windowStub
    })
    const viewModel = createViewModel(loadExtensions)

    const loading = loadExtensions.call(viewModel)
    expect(viewModel.loadState).toBe('loading')
    expect(viewModel.extensions).toEqual([])
    expect(rootUi.loadingEvents).toEqual([['start', 'admin-extensions-refresh']])

    request.resolve(response)
    expect(await loading).toBe(true)
    expect(viewModel.extensions).toBe(response)
    expect(viewModel.loadState).toBe('success')
    expect(markRaw).toHaveBeenCalledWith(response)
    expect(fetchSystemExtensions).toHaveBeenCalledWith(expect.any(Function), 'System extensions response is invalid')
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-extensions-refresh'],
      ['stop', 'admin-extensions-refresh']
    ])
  })

  test('surfaces the active request error and always releases refresh loading', async () => {
    const failure = new Error('extension request failed')
    const rootUi = createRootUi()
    const loadExtensions = compileMethod(loadExtensionsSource, {
      fetchSystemExtensions: async () => {
        throw failure
      },
      loadingStart: rootUi.loadingStart,
      loadingStop: rootUi.loadingStop,
      pushGraphError: rootUi.pushGraphError,
      markRaw: value => value,
      wikiStore,
      window: windowStub
    })
    const viewModel = createViewModel(loadExtensions)

    expect(await loadExtensions.call(viewModel)).toBe(false)
    expect(viewModel.extensions).toEqual([])
    expect(viewModel.loadState).toBe('error')
    expect(rootUi.errors).toEqual([failure])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-extensions-refresh'],
      ['stop', 'admin-extensions-refresh']
    ])
  })

  test('does not publish a response or error after unmount', async () => {
    const request = deferred()
    const rootUi = createRootUi()
    const fetchSystemExtensions = jest.fn(() => request.promise)
    const loadExtensions = compileMethod(loadExtensionsSource, {
      fetchSystemExtensions,
      loadingStart: rootUi.loadingStart,
      loadingStop: rootUi.loadingStop,
      pushGraphError: rootUi.pushGraphError,
      markRaw: value => value,
      wikiStore,
      window: windowStub
    })
    const viewModel = createViewModel(loadExtensions)

    const loading = loadExtensions.call(viewModel)
    viewModel.isUnmounted = true
    request.resolve([{ key: 'stale' }])

    expect(await loading).toBe(false)
    expect(viewModel.extensions).toEqual([])
    expect(viewModel.loadState).toBe('loading')
    expect(rootUi.errors).toEqual([])
    expect(rootUi.loadingEvents).toEqual([
      ['start', 'admin-extensions-refresh'],
      ['stop', 'admin-extensions-refresh']
    ])

    const alreadyUnmounted = createViewModel(loadExtensions)
    alreadyUnmounted.isUnmounted = true
    expect(await loadExtensions.call(alreadyUnmounted)).toBe(false)
    expect(fetchSystemExtensions).toHaveBeenCalledTimes(1)
    expect(rootUi.loadingEvents).toHaveLength(2)
  })
})

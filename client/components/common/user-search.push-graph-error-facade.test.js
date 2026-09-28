import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { searchUsers } from '../../helpers/users-api.ts'
import { getErrorMessage, pushGraphError } from '../../helpers/root-ui-store.ts'

const componentPath = join(process.cwd(), 'client/components/common/user-search.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
if (errors.length || !descriptor.script) throw new Error(`Cannot parse user-search.vue: ${errors}`)
const script = descriptor.script.content
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'return'))
const results = source.slice(source.indexOf('v-list.user-search__results'), source.indexOf('v-card-chin'))

const wikiStore = { showError: vi.fn() }
const component = new Function('defineComponent', 'useId', 'AsyncState', 'searchUsers', 'getErrorMessage', 'pushGraphError', 'wikiStore', executable)(
  options => options,
  () => 'test-id',
  {},
  searchUsers,
  getErrorMessage,
  pushGraphError,
  wikiStore
)

const makeContext = () => {
  let context
  context = {
    ...component.data(),
    modelValue: true,
    $refs: {
      searchIpt: { focus: vi.fn() },
      resultsList: { focus: vi.fn() }
    },
    $emit: vi.fn((event, value) => {
      if (event === 'update:modelValue') context.modelValue = value
    }),
    $t: vi.fn(key => key)
  }

  for (const key of ['dialogOpen', 'searchStatus']) {
    Object.defineProperty(context, key, { get: () => component.computed[key].call(context) })
  }
  for (const [name, method] of Object.entries(component.methods)) {
    context[name] = (...args) => method.apply(context, args)
  }
  return context
}

const makeResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const setup = () => {
  vi.clearAllMocks()
  const browserWindow = {
    fetch: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn()
  }
  vi.stubGlobal('window', browserWindow)
  return browserWindow
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('user-search root UI facade migration guard', () => {
  test('keeps REST search and error reporting behind the root UI boundary', () => {
    expect(script).toContain("import { searchUsers, type UserSearchRow } from '../../helpers/users-api'")
    expect(script).toMatch(/import\s+\{[^}]*\bgetErrorMessage\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).not.toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)
  })

  test('debounces the current query and publishes the returned user rows', async () => {
    const browserWindow = setup()
    let runSearch
    browserWindow.setTimeout.mockImplementation((callback, delay) => {
      expect(delay).toBe(300)
      runSearch = callback
      return 23
    })
    browserWindow.fetch.mockResolvedValue(makeResponse([{ id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' }]))
    const context = makeContext()
    context.search = 'alice'
    let request
    const loadUsers = context.loadUsers
    context.loadUsers = vi.fn((...args) => {
      request = loadUsers(...args)
      return request
    })

    component.methods.queueSearch.call(context)

    expect(context.searchRequestId).toBe(1)
    expect(context.searchLoading).toBe(true)
    expect(browserWindow.fetch).not.toHaveBeenCalled()
    runSearch()
    await request

    expect(browserWindow.fetch).toHaveBeenCalledWith('/_api/users/search?query=alice', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(context.items).toEqual([{ id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' }])
    expect(context.searchLoading).toBe(false)
  })

  test('ignores an older successful response after a newer query completes', async () => {
    const browserWindow = setup()
    const searchTimers = []
    browserWindow.setTimeout.mockImplementation(callback => {
      searchTimers.push(callback)
      return searchTimers.length
    })
    const pendingResponses = []
    browserWindow.fetch.mockImplementation(
      () =>
        new Promise(resolve => {
          pendingResponses.push(resolve)
        })
    )
    const context = makeContext()
    const requests = []
    const loadUsers = context.loadUsers
    context.loadUsers = (...args) => {
      const request = loadUsers(...args)
      requests.push(request)
      return request
    }

    context.search = 'older'
    context.queueSearch()
    searchTimers[0]()
    context.search = 'newer'
    context.queueSearch()
    searchTimers[1]()

    expect(browserWindow.fetch).toHaveBeenCalledTimes(2)
    expect(context.searchLoading).toBe(true)

    const newerUser = { id: 42, name: 'Newer result', email: 'newer@example.com', providerKey: 'local' }
    pendingResponses[1](makeResponse([newerUser]))
    await requests[1]

    expect(context.items).toEqual([newerUser])
    expect(context.searchLoading).toBe(false)
    const currentStatus = context.searchStatus

    const olderUser = { id: 41, name: 'Older result', email: 'older@example.com', providerKey: 'local' }
    pendingResponses[0](makeResponse([olderUser]))
    await requests[0]

    expect(context.items).toEqual([newerUser])
    expect(context.searchLoading).toBe(false)
    expect(context.searchStatus).toBe(currentStatus)
  })

  test('clears a short query without scheduling or retaining an earlier request', () => {
    const browserWindow = setup()
    const context = makeContext()
    const controller = new AbortController()
    context.search = ' a '
    context.items = [{ id: 1, name: 'Old result', email: 'old@example.com', providerKey: 'local' }]
    context.searchError = 'Old error'
    context.searchTimer = 17
    context.searchAbortController = controller
    context.searchRequestId = 6
    context.searchAttempted = true
    context.searchLoading = true

    component.methods.queueSearch.call(context)

    expect(browserWindow.clearTimeout).toHaveBeenCalledWith(17)
    expect(controller.signal.aborted).toBe(true)
    expect(context.searchTimer).toBeNull()
    expect(context.searchRequestId).toBe(7)
    expect(context.searchAttempted).toBe(false)
    expect(context.searchLoading).toBe(false)
    expect(context.searchError).toBe('')
    expect(context.items).toEqual([])
    expect(browserWindow.setTimeout).not.toHaveBeenCalled()
    expect(browserWindow.fetch).not.toHaveBeenCalled()
  })

  test('reports only the current request failure in the dialog and root store', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockResolvedValue(makeResponse({ error: 'Search permission denied.' }, 403))
    const context = makeContext()
    context.search = 'alice'
    context.searchRequestId = 7
    context.searchLoading = true

    await expect(component.methods.loadUsers.call(context, 'alice', 7)).resolves.toEqual([])

    expect(context.items).toEqual([])
    expect(context.searchError).toBe('Search permission denied.')
    expect(context.searchLoading).toBe(false)
    expect(wikiStore.showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Search permission denied.' }))
    expect(wikiStore.showError).toHaveBeenCalledTimes(1)
  })

  test('ignores a late failed response after unmount cancels its generation', async () => {
    const browserWindow = setup()
    let resolveResponse
    browserWindow.fetch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveResponse = resolve
        })
    )
    const context = makeContext()
    context.search = 'alice'
    context.searchRequestId = 4
    context.searchLoading = true

    const request = component.methods.loadUsers.call(context, 'alice', 4)
    const signal = browserWindow.fetch.mock.calls[0][1].signal
    component.beforeUnmount.call(context)

    expect(signal.aborted).toBe(true)
    resolveResponse(makeResponse({ error: 'Late failure.' }, 500))
    await expect(request).resolves.toEqual([])

    expect(context.items).toEqual([])
    expect(context.searchError).toBe('')
    expect(context.searchLoading).toBe(false)
    expect(wikiStore.showError).not.toHaveBeenCalled()
  })

  test('cancels pending searches when the dialog closes and focuses on dialog entry', () => {
    const browserWindow = setup()
    const context = makeContext()
    const controller = new AbortController()
    context.searchTimer = 12
    context.searchAbortController = controller
    context.searchLoading = true
    context.searchRequestId = 3

    component.watch.modelValue.call(context, false, true)

    expect(browserWindow.clearTimeout).toHaveBeenCalledWith(12)
    expect(controller.signal.aborted).toBe(true)
    expect(context.searchTimer).toBeNull()
    expect(context.searchRequestId).toBe(4)
    expect(context.searchLoading).toBe(false)

    context.modelValue = true
    component.methods.focusSearch.call(context)
    expect(context.$refs.searchIpt.focus).toHaveBeenCalledTimes(1)
    context.modelValue = false
    component.methods.focusSearch.call(context)
    expect(context.$refs.searchIpt.focus).toHaveBeenCalledTimes(1)
  })

  test('supports keyboard focus and selects the stable user value before closing', () => {
    setup()
    const context = makeContext()
    const user = { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' }
    context.items = [user]
    const event = { preventDefault: vi.fn() }

    component.methods.focusResult.call(context, event, 'first')
    component.methods.setUser.call(context, user)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(context.$refs.resultsList.focus).toHaveBeenCalledWith('first')
    expect(context.$emit.mock.calls).toEqual([
      ['select', user],
      ['update:modelValue', false]
    ])
    expect(context.modelValue).toBe(false)
  })

  test('keeps transition retry and accessible listbox wiring', () => {
    expect(source).toContain("@after-enter='focusSearch'")
    expect(source).toContain("@retry='retrySearch'")
    expect(source).toContain("role='combobox'")
    expect(source).toContain("aria-autocomplete='list'")
    expect(results).toContain('activatable')
    expect(results).toContain(":aria-label='$t(`common:user.search`)'")
    expect(results).toContain("template(v-for='(usr, idx) in items', :key='usr.id')")
    expect(results).toMatch(/v-list-item\(\s*:value=['"]usr\.id['"]\s*,\s*@click=['"]setUser\(usr\)['"]\s*\)/)
  })
})

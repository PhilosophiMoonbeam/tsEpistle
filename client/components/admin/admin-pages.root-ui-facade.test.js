import fs from 'node:fs'
import path from 'node:path'
import { compile } from 'vue'

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp('async\\s+' + name + '\\s*\\('))
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

const createWikiStore = () => {
  const loadingEvents = []
  const notifications = []
  const errors = []
  return {
    loadingEvents,
    notifications,
    errors,
    store: {
      startLoading: id => loadingEvents.push(['start', id]),
      stopLoading: id => loadingEvents.push(['stop', id]),
      showNotification: notification => notifications.push(notification),
      showError: error => errors.push(error)
    }
  }
}

const createViewModel = loadPages => ({
  pages: [],
  errorMessage: '',
  loading: false,
  loadRequestId: 0,
  loadPages
})

describe('admin-pages root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]
  const loadPagesSource = extractMethod(script, 'loadPages')
  const checkboxTemplate = source.match(/<input type="checkbox"[^\n]*\/>/)[0]
  const renderCheckbox = compile(checkboxTemplate)
  const refreshSource = extractMethod(script, 'refresh')
  const windowStub = { fetch: () => {} }

  const createComponentOptions = ({ fetchPageList, wikiStore }) => {
    const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))

    return new Function(
      'AsyncState',
      'AdminPagesPublication',
      'StatusIndicator',
      'getErrorMessage',
      'fetchPageList',
      'publicationState',
      'wikiStore',
      'window',
      executableScript
    )(
      {},
      {},
      {},
      error => (error instanceof Error ? error.message : String(error)),
      fetchPageList,
      () => 'Published',
      wikiStore,
      windowStub
    )
  }

  test('uses the typed REST page-list helper and wiki store UI facade', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { fetchPageList, type PageListRow } from '../../helpers/pages-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/\$store\.commit/)
    expect(script).not.toMatch(/pages-query-list\.gql|apollo\s*:|this\.\$apollo|pagesQuery/)
    expect(source).toMatch(/:to="`\/pages\/\$\{page.id\}`"/)
  })

  test('offers explicit sorting and publication review', () => {
    expect(source).toContain('label="Order pages"')
    expect(source).toContain('aria-label="Pages pagination"')
    expect(source).toContain('Review publication')
    expect(source).toContain('outside these filters')
  })

  test('limits page selection to 25 pages and disables only unselected checkboxes at capacity', () => {
    const options = createComponentOptions({ fetchPageList: async () => [], wikiStore: {} })
    const pages = Array.from({ length: 27 }, (_, index) => ({ id: index + 1 }))
    const viewModel = { ...options.data(), visiblePages: pages }
    const renderPageCheckbox = id =>
      renderCheckbox(
        {
          page: pages[id - 1],
          selectedIds: viewModel.selectedIds,
          bulkOpen: false,
          toggleSelected: selectedId => options.methods.toggleSelected.call(viewModel, selectedId)
        },
        []
      )

    options.methods.selectVisible.call(viewModel)
    expect(viewModel.selectedIds).toEqual(pages.slice(0, 25).map(page => page.id))
    expect(renderPageCheckbox(26).props.disabled).toBe(true)

    options.methods.toggleSelected.call(viewModel, 26)
    expect(viewModel.selectedIds).toEqual(pages.slice(0, 25).map(page => page.id))

    const selectedCheckbox = renderPageCheckbox(25)
    expect(selectedCheckbox.props.disabled).toBe(false)
    selectedCheckbox.props.onChange()
    expect(viewModel.selectedIds).toEqual(pages.slice(0, 24).map(page => page.id))
  })

  test('applies only the latest page-list response and balances loading for superseded requests', async () => {
    const firstRequest = deferred()
    const secondRequest = deferred()
    const requests = [firstRequest, secondRequest]
    const wiki = createWikiStore()
    const loadPages = compileMethod(loadPagesSource, {
      fetchPageList: () => requests.shift().promise,
      getErrorMessage: error => error.message,
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = createViewModel(loadPages)

    const firstLoad = loadPages.call(viewModel)
    const secondLoad = loadPages.call(viewModel)
    const latestPages = [{ id: 2, title: 'Latest' }]
    secondRequest.resolve(latestPages)
    expect(await secondLoad).toBe(true)
    expect(viewModel.pages).toBe(latestPages)
    expect(viewModel.loading).toBe(false)

    firstRequest.resolve([{ id: 1, title: 'Stale' }])
    expect(await firstLoad).toBe(false)
    expect(viewModel.pages).toBe(latestPages)
    expect(viewModel.errorMessage).toBe('')
    expect(viewModel.loading).toBe(false)
    expect(wiki.errors).toEqual([])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])
  })

  test('ignores superseded page-list errors without hiding the current request loading state', async () => {
    const staleRequest = deferred()
    const currentRequest = deferred()
    const requests = [staleRequest, currentRequest]
    const wiki = createWikiStore()
    const loadPages = compileMethod(loadPagesSource, {
      fetchPageList: () => requests.shift().promise,
      getErrorMessage: error => error.message,
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = createViewModel(loadPages)

    const staleLoad = loadPages.call(viewModel)
    const currentLoad = loadPages.call(viewModel)
    staleRequest.reject(new Error('stale failure'))
    expect(await staleLoad).toBe(false)
    expect(viewModel.loading).toBe(true)
    expect(viewModel.errorMessage).toBe('')
    expect(wiki.errors).toEqual([])

    currentRequest.resolve([{ id: 3, title: 'Current' }])
    expect(await currentLoad).toBe(true)
    expect(viewModel.loading).toBe(false)
  })

  test('surfaces the current REST error and releases page-list loading', async () => {
    const failure = new Error('page list failed')
    const wiki = createWikiStore()
    const loadPages = compileMethod(loadPagesSource, {
      fetchPageList: async () => {
        throw failure
      },
      getErrorMessage: error => `Message: ${error.message}`,
      wikiStore: wiki.store,
      window: windowStub
    })
    const viewModel = createViewModel(loadPages)

    expect(await loadPages.call(viewModel)).toBe(false)
    expect(viewModel.pages).toEqual([])
    expect(viewModel.errorMessage).toBe('Message: page list failed')
    expect(viewModel.loading).toBe(false)
    expect(wiki.errors).toEqual([failure])
    expect(wiki.loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])
  })

  test('refresh notifies only after a successful page-list load and invalidates requests on unmount', async () => {
    const wiki = createWikiStore()
    const refresh = compileMethod(refreshSource, { wikiStore: wiki.store })
    const viewModel = { loadPages: async () => false }

    await refresh.call(viewModel)
    expect(wiki.notifications).toEqual([])

    viewModel.loadPages = async () => true
    await refresh.call(viewModel)
    expect(wiki.notifications).toEqual([
      {
        message: 'Page list has been refreshed.',
        style: 'success',
        icon: 'cached'
      }
    ])
    const pendingRequest = deferred()
    const options = createComponentOptions({
      fetchPageList: () => pendingRequest.promise,
      wikiStore: wiki.store
    })
    const unmountedViewModel = options.data()
    const pendingLoad = options.methods.loadPages.call(unmountedViewModel)
    options.beforeUnmount.call(unmountedViewModel)
    pendingRequest.resolve([{ id: 4, title: 'Unmounted' }])
    expect(await pendingLoad).toBe(false)
    expect(unmountedViewModel.pages).toEqual([])
    expect(wiki.loadingEvents.slice(-2)).toEqual([
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])
  })
})

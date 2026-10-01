import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createComponentOptions = ({ fetchPage, deletePageById, wikiStore }) => {
  const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))

  return new Function(
    '_',
    'AsyncState',
    'getErrorMessage',
    'AdminPagePublicationSettings',
    'AdminPageAccess',
    'pageHref',
    'publicationState',
    'deletePageById',
    'fetchPage',
    'wikiStore',
    'window',
    executableScript
  )(
    { toSafeInteger: Number },
    {},
    err => (err instanceof Error ? err.message : String(err)),
    {},
    {},
    () => '/',
    () => 'Published',
    deletePageById,
    fetchPage,
    wikiStore,
    { fetch: async () => {}, removeEventListener() {} }
  )
}

const createViewModel = options => {
  const viewModel = {
    ...options.data(),
    $route: { params: { id: '1' } },
    $router: { replace: () => {} },
    $t: () => 'Unexpected error'
  }
  viewModel.loadPage = options.methods.loadPage.bind(viewModel)
  viewModel.deletePage = options.methods.deletePage.bind(viewModel)
  return viewModel
}

const loadRoutedPage = (options, viewModel) => {
  const routeWatcher = options.watch['$route.params.id']
  const handler = typeof routeWatcher === 'function' ? routeWatcher : routeWatcher.handler
  return handler.call(viewModel)
}

describe('admin pages edit REST delete facade', () => {
  it('notifies and navigates after deleting the current page', async () => {
    const page = {
      id: 1,
      sourceRevision: '8',
      pageFeatures: { schemaVersion: 1, linksVisible: false, ratingsAllowed: true, lastEditorVisible: false }
    }
    const deletion = deferred()
    const calls = []
    const loadingEvents = []
    const notifications = []
    const errors = []
    const redirects = []
    const options = createComponentOptions({
      fetchPage: async () => page,
      deletePageById: (_fetch, pageId, sourceRevision) => {
        calls.push({ pageId, sourceRevision })
        return deletion.promise
      },
      wikiStore: {
        startLoading: loadingId => loadingEvents.push(['start', loadingId]),
        stopLoading: loadingId => loadingEvents.push(['stop', loadingId]),
        showError: error => errors.push(error),
        showNotification: notification => notifications.push(notification)
      }
    })
    const viewModel = createViewModel(options)
    viewModel.$router.replace = route => redirects.push(route)
    await viewModel.loadPage()
    viewModel.deletePageDialog = true

    const pendingDelete = viewModel.deletePage()
    expect(calls).toEqual([{ pageId: 1, sourceRevision: '8' }])
    expect(viewModel.loading).toBe(true)
    expect(notifications).toEqual([])
    expect(redirects).toEqual([])

    deletion.resolve()
    await pendingDelete

    expect(viewModel.loading).toBe(false)
    expect(viewModel.deletePageDialog).toBe(false)
    expect(viewModel.mutationError).toBe('')
    expect(notifications).toHaveLength(1)
    expect(['green', 'success']).toContain(notifications[0].style.toLowerCase())
    expect(errors).toEqual([])
    expect(redirects).toEqual(['/pages'])
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['start', 'page-delete'],
      ['stop', 'page-delete']
    ])
  })

  it('surfaces a current delete failure without navigating or notifying', async () => {
    const failure = new Error('Page changed since review')
    const loadingEvents = []
    const notifications = []
    const errors = []
    const redirects = []
    const options = createComponentOptions({
      fetchPage: async (_fetch, pageId) => ({
        id: pageId,
        sourceRevision: '8',
        pageFeatures: { schemaVersion: 1, linksVisible: false, ratingsAllowed: true, lastEditorVisible: false }
      }),
      deletePageById: async () => {
        throw failure
      },
      wikiStore: {
        startLoading: loadingId => loadingEvents.push(['start', loadingId]),
        stopLoading: loadingId => loadingEvents.push(['stop', loadingId]),
        showError: error => errors.push(error),
        showNotification: notification => notifications.push(notification)
      }
    })
    const viewModel = createViewModel(options)
    viewModel.$router.replace = route => redirects.push(route)
    await viewModel.loadPage()
    viewModel.deletePageDialog = true

    await viewModel.deletePage()

    expect(viewModel.mutationError).toBe('Page changed since review')
    expect(viewModel.deletePageDialog).toBe(true)
    expect(viewModel.loading).toBe(false)
    expect(errors).toEqual([failure])
    expect(notifications).toEqual([])
    expect(redirects).toEqual([])
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['start', 'page-delete'],
      ['stop', 'page-delete']
    ])
  })

  it('deletes only the current route page after routed responses resolve in reverse', async () => {
    const page1 = deferred()
    const page2 = deferred()
    const deleteCalls = []
    const options = createComponentOptions({
      fetchPage: (fetchImplementation, pageId) => (pageId === 1 ? page1.promise : page2.promise),
      deletePageById: (fetchImplementation, pageId, sourceRevision) => {
        deleteCalls.push({ pageId, sourceRevision })
      },
      wikiStore: {
        startLoading: () => {},
        stopLoading: () => {},
        showError: () => {},
        showNotification: () => {}
      }
    })
    const viewModel = createViewModel(options)

    const firstLoad = viewModel.loadPage()
    viewModel.$route.params.id = '2'
    const secondLoad = loadRoutedPage(options, viewModel)
    const latestPage = { id: 2, sourceRevision: 22, title: 'Page 2' }
    page2.resolve(latestPage)
    await secondLoad
    page1.resolve({ id: 1, sourceRevision: 11, title: 'Page 1' })
    await firstLoad

    expect(viewModel.page).toBe(latestPage)
    await viewModel.deletePage()
    expect(deleteCalls).toEqual([{ pageId: 2, sourceRevision: 22 }])

    viewModel.$route.params.id = '3'
    await viewModel.deletePage()
    expect(deleteCalls).toEqual([{ pageId: 2, sourceRevision: 22 }])
  })

  it('does not apply a superseded page delete success to the newly routed page', async () => {
    const deletion = deferred()
    const deleteCalls = []
    const notifications = []
    const errors = []
    const redirects = []
    const stoppedLoads = []
    const options = createComponentOptions({
      fetchPage: async (fetchImplementation, pageId) => ({
        id: pageId,
        sourceRevision: pageId * 10,
        title: `Page ${pageId}`
      }),
      deletePageById: (fetchImplementation, pageId, sourceRevision) => {
        deleteCalls.push({ pageId, sourceRevision })
        return deletion.promise
      },
      wikiStore: {
        startLoading: () => {},
        stopLoading: loadingId => stoppedLoads.push(loadingId),
        showError: error => errors.push(error),
        showNotification: notification => notifications.push(notification)
      }
    })
    const viewModel = createViewModel(options)
    viewModel.$router.replace = route => redirects.push(route)
    viewModel.$route.params.id = '2'
    await viewModel.loadPage()

    const pendingDelete = viewModel.deletePage()
    viewModel.$route.params.id = '3'
    await loadRoutedPage(options, viewModel)
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'admin-pages-refresh'])
    viewModel.deletePageDialog = true
    viewModel.loading = true

    deletion.resolve()
    await pendingDelete

    expect(deleteCalls).toEqual([{ pageId: 2, sourceRevision: 20 }])
    expect(viewModel.page).toEqual({ id: 3, sourceRevision: 30, title: 'Page 3' })
    expect(viewModel.deletePageDialog).toBe(true)
    expect(viewModel.loading).toBe(true)
    expect(notifications).toEqual([])
    expect(errors).toEqual([])
    expect(redirects).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'admin-pages-refresh', 'page-delete'])
  })

  it('does not apply a superseded page delete failure to the newly routed page', async () => {
    const deletion = deferred()
    const errors = []
    const redirects = []
    const stoppedLoads = []
    const options = createComponentOptions({
      fetchPage: async (fetchImplementation, pageId) => ({
        id: pageId,
        sourceRevision: pageId * 10,
        title: `Page ${pageId}`
      }),
      deletePageById: () => deletion.promise,
      wikiStore: {
        startLoading: () => {},
        stopLoading: loadingId => stoppedLoads.push(loadingId),
        showError: error => errors.push(error),
        showNotification: () => {
          throw new Error('A stale delete must not notify')
        }
      }
    })
    const viewModel = createViewModel(options)
    viewModel.$router.replace = route => redirects.push(route)
    viewModel.$route.params.id = '2'
    await viewModel.loadPage()

    const pendingDelete = viewModel.deletePage()
    viewModel.$route.params.id = '3'
    await loadRoutedPage(options, viewModel)
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'admin-pages-refresh'])
    viewModel.deletePageDialog = true
    viewModel.loading = true
    viewModel.mutationError = 'Current page review failed'

    deletion.reject(new Error('Page 2 delete failed'))
    await pendingDelete

    expect(viewModel.page).toEqual({ id: 3, sourceRevision: 30, title: 'Page 3' })
    expect(viewModel.mutationError).toBe('Current page review failed')
    expect(viewModel.deletePageDialog).toBe(true)
    expect(viewModel.loading).toBe(true)
    expect(errors).toEqual([])
    expect(redirects).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'admin-pages-refresh', 'page-delete'])
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { document } from '../../test/browser-dom.mts'

const Vue = await import('vue')

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

const createComponentOptions = ({ fetchPage, wikiStore }) => {
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
    async () => {},
    fetchPage,
    wikiStore,
    { fetch: async () => {}, addEventListener() {}, removeEventListener() {} }
  )
}

const createViewModel = options => {
  const viewModel = {
    ...options.data(),
    $route: { params: { id: '1' } },
    $t: () => 'Unexpected error'
  }
  viewModel.loadPage = options.methods.loadPage.bind(viewModel)
  return viewModel
}

const loadRoutedPage = (options, viewModel) => {
  const routeWatcher = options.watch['$route.params.id']
  const handler = typeof routeWatcher === 'function' ? routeWatcher : routeWatcher.handler
  return handler.call(viewModel)
}

describe('admin pages edit REST single facade', () => {
  it('keeps page administration independent of Apollo', () => {
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
  })

  it('loads the initial route automatically, surfaces detail errors and releases loading', async () => {
    const failure = new Error('Page details failed')
    const details = deferred()
    const requestedPageIds = []
    const errors = []
    const loadingEvents = []
    const options = createComponentOptions({
      fetchPage: (_fetch, pageId) => {
        requestedPageIds.push(pageId)
        return details.promise
      },
      wikiStore: {
        startLoading: loadingId => loadingEvents.push(['start', loadingId]),
        stopLoading: loadingId => loadingEvents.push(['stop', loadingId]),
        showError: error => errors.push(error)
      }
    })
    const app = Vue.createApp({ ...options, render: () => null })
    app.config.globalProperties.$route = { params: { id: '1' }, hash: '' }
    app.config.globalProperties.$t = () => 'Unexpected error'
    const host = document.createElement('div')
    document.body.append(host)

    try {
      const viewModel = app.mount(host)
      expect(requestedPageIds).toEqual([1])
      expect(viewModel.loading).toBe(true)

      details.reject(failure)
      await details.promise.catch(() => {})
      await Vue.nextTick()

      expect(viewModel.errorMessage).toBe('Page details failed')
      expect(viewModel.loading).toBe(false)
      expect(errors).toEqual([failure])
      expect(loadingEvents).toEqual([
        ['start', 'admin-pages-refresh'],
        ['stop', 'admin-pages-refresh']
      ])
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('keeps only the latest routed page response after a late success while releasing every loading owner', async () => {
    const page1 = deferred()
    const page2 = deferred()
    const errors = []
    const stoppedLoads = []
    const options = createComponentOptions({
      fetchPage: (fetchImplementation, pageId) => (pageId === 1 ? page1.promise : page2.promise),
      wikiStore: {
        startLoading: () => {},
        stopLoading: loadingId => stoppedLoads.push(loadingId),
        showError: error => errors.push(error)
      }
    })
    const viewModel = createViewModel(options)

    const firstLoad = viewModel.loadPage()
    viewModel.deletePageDialog = true
    viewModel.$route.params.id = '2'
    const secondLoad = loadRoutedPage(options, viewModel)
    expect(viewModel.deletePageDialog).toBe(false)

    const latestPage = { id: 2, title: 'Page 2' }
    page2.resolve(latestPage)
    await secondLoad
    expect(viewModel.page).toBe(latestPage)
    expect(viewModel.loading).toBe(false)
    expect(stoppedLoads).toEqual(['admin-pages-refresh'])

    page1.resolve({ id: 1, title: 'Page 1' })
    await firstLoad
    expect(viewModel.page).toBe(latestPage)
    expect(viewModel.loading).toBe(false)
    expect(errors).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'admin-pages-refresh'])
  })

  it('does not surface an error from a superseded route request', async () => {
    const page1 = deferred()
    const page2 = deferred()
    const errors = []
    const options = createComponentOptions({
      fetchPage: (fetchImplementation, pageId) => (pageId === 1 ? page1.promise : page2.promise),
      wikiStore: {
        startLoading: () => {},
        stopLoading: () => {},
        showError: error => errors.push(error)
      }
    })
    const viewModel = createViewModel(options)

    const firstLoad = viewModel.loadPage()
    viewModel.$route.params.id = '2'
    const secondLoad = loadRoutedPage(options, viewModel)
    page2.resolve({ id: 2, title: 'Page 2' })
    await secondLoad

    page1.reject(new Error('Page 1 failed'))
    await firstLoad
    expect(errors).toEqual([])
    expect(viewModel.page).toEqual({ id: 2, title: 'Page 2' })
    expect(viewModel.errorMessage).toBe('')
    expect(viewModel.loading).toBe(false)
  })
})

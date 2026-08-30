import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const loadPageStart = script.indexOf('async loadPage () {')
const loadPageEnd = script.indexOf('    async deletePage', loadPageStart)
const loadPageBody = script.slice(loadPageStart, loadPageEnd)

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
  const executableScript = script
    .replace(/^import .*$/gm, '')
    .replace('export default', 'return')
    .replace(/ as (?:PageDetails \| null|number \| null)/g, '')

  return new Function('_', 'StatusIndicator', 'deletePageById', 'fetchPage', 'wikiStore', 'window', executableScript)(
    { toSafeInteger: Number },
    {},
    async () => {},
    fetchPage,
    wikiStore,
    { fetch: async () => {} }
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

describe('admin pages edit REST single facade', () => {
  it('loads page details through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'")
    expect(script).not.toContain('pages-query-single.gql')
    expect(script).not.toContain('pageQuery')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    expect(loadPageBody).toContain('await fetchPage(')
    expect(loadPageBody).toContain('window.fetch.bind(window)')
    expect(loadPageBody).toContain('const routePageId = _.toSafeInteger(this.$route.params.id)')
    expect(loadPageBody).toContain('routePageId,')
  })

  it('preserves page detail loading and graph error behavior', () => {
    expect(loadPageBody).toContain('this.loading = true')
    expect(loadPageBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPageBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")
    expect(loadPageBody).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPage\(\)\s*\}/)
  })

  it('keeps only the latest routed page response, error, and loading completion', async () => {
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
    expect(viewModel.loadGeneration).toBe(1)
    viewModel.deletePageDialog = true
    viewModel.$route.params.id = '2'
    const secondLoad = options.watch['$route.params.id'].call(viewModel)
    expect(viewModel.loadGeneration).toBe(2)
    expect(viewModel.deletePageDialog).toBe(false)

    const latestPage = { id: 2, title: 'Page 2' }
    page2.resolve(latestPage)
    await secondLoad
    expect(viewModel.page).toBe(latestPage)
    expect(viewModel.resolvedPageRouteId).toBe(2)
    expect(viewModel.loading).toBe(false)

    page1.resolve({ id: 1, title: 'Page 1' })
    await firstLoad
    expect(viewModel.page).toBe(latestPage)
    expect(viewModel.resolvedPageRouteId).toBe(2)
    expect(viewModel.loading).toBe(false)
    expect(errors).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh'])
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
    const secondLoad = options.watch['$route.params.id'].call(viewModel)
    page2.resolve({ id: 2, title: 'Page 2' })
    await secondLoad

    page1.reject(new Error('Page 1 failed'))
    await firstLoad
    expect(errors).toEqual([])
    expect(viewModel.page).toEqual({ id: 2, title: 'Page 2' })
  })
})

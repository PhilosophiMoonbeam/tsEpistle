import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const deletePageStart = script.indexOf('async deletePage() {')
const deletePageEnd = script.indexOf('    async rerenderPage', deletePageStart)
const deletePageBody = script.slice(deletePageStart, deletePageEnd)

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
  const executableScript = script
    .replace(/^import .*$/gm, '')
    .replace('export default', 'return')
    .replace(/ as (?:PageDetails \| null|number \| null)/g, '')

  return new Function('_', 'StatusIndicator', 'deletePageById', 'fetchPage', 'wikiStore', 'window', executableScript)(
    { toSafeInteger: Number },
    {},
    deletePageById,
    fetchPage,
    wikiStore,
    { fetch: async () => {} }
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

describe('admin pages edit REST delete facade', () => {
  it('routes page deletes through the pages REST helper instead of the common GraphQL mutation', () => {
    expect(script).toContain("import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'")
    expect(script).not.toContain('common-pages-mutation-delete.gql')
    expect(script).not.toContain('deletePageMutation')
    expect(deletePageBody).toContain('await deletePageById(')
    expect(deletePageBody).toContain('window.fetch.bind(window)')
    expect(deletePageBody).toContain('page.id')
    expect(deletePageBody).not.toContain('this.$apollo.mutate')
    expect(deletePageBody).not.toContain('data.pages.delete.responseResult')
  })

  it('preserves page delete loading, notification, navigation, and graph error behavior', () => {
    expect(deletePageBody).toContain('this.loading = true')
    expect(deletePageBody).toContain('this.loading = false')
    expect(deletePageBody).toContain('this.deletePageDialog = false')
    expect(deletePageBody).toContain("wikiStore.startLoading('page-delete')")
    expect(deletePageBody).toContain("wikiStore.stopLoading('page-delete')")
    expect(deletePageBody).toContain("style: 'green'")
    expect(deletePageBody).toContain('message: `Page deleted successfully.`')
    expect(deletePageBody).toContain("icon: 'check'")
    expect(deletePageBody).toContain("this.$router.replace('/pages')")
    expect(deletePageBody).toContain('wikiStore.showError(err)')
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
    const secondLoad = options.watch['$route.params.id'].call(viewModel)
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
    await options.watch['$route.params.id'].call(viewModel)
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'page-delete', 'admin-pages-refresh'])
    viewModel.deletePageDialog = true
    viewModel.loading = true

    deletion.resolve()
    await pendingDelete

    expect(deleteCalls).toEqual([{ pageId: 2, sourceRevision: 20 }])
    expect(viewModel.page).toEqual({ id: 3, sourceRevision: 30, title: 'Page 3' })
    expect(viewModel.resolvedPageRouteId).toBe(3)
    expect(viewModel.deletePageDialog).toBe(true)
    expect(viewModel.loading).toBe(true)
    expect(notifications).toEqual([])
    expect(errors).toEqual([])
    expect(redirects).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'page-delete', 'admin-pages-refresh'])
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
    await options.watch['$route.params.id'].call(viewModel)
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'page-delete', 'admin-pages-refresh'])
    viewModel.deletePageDialog = true
    viewModel.loading = true

    deletion.reject(new Error('Page 2 delete failed'))
    await pendingDelete

    expect(viewModel.page).toEqual({ id: 3, sourceRevision: 30, title: 'Page 3' })
    expect(viewModel.resolvedPageRouteId).toBe(3)
    expect(viewModel.deletePageDialog).toBe(true)
    expect(viewModel.loading).toBe(true)
    expect(errors).toEqual([])
    expect(redirects).toEqual([])
    expect(stoppedLoads).toEqual(['admin-pages-refresh', 'page-delete', 'admin-pages-refresh'])
  })
})

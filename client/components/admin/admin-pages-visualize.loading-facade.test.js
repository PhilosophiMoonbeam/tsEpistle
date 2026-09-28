import fs from 'node:fs'
import path from 'node:path'

describe('admin-pages-visualize stale locale loading behavior', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
  const loadPagesStart = script.indexOf('async loadPages (): Promise<void> {')
  const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
  const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const executeLoadPages = new AsyncFunction(
    'fetchPageLinks',
    'wikiStore',
    'markRaw',
    'getErrorMessage',
    'window',
    loadPagesBody.slice(loadPagesBody.indexOf('{') + 1, loadPagesBody.lastIndexOf('}'))
  )

  test('only the latest locale request presents errors while every request releases refresh loading', async () => {
    const pendingRequests = new Map()
    const fetchPageLinks = (_fetch, locale) =>
      new Promise((resolve, reject) => {
        pendingRequests.set(locale, { resolve, reject })
      })
    const loadingEvents = []
    const errors = []
    const markedDatasets = []
    const markRaw = pages => {
      markedDatasets.push(pages)
      return pages
    }
    const getErrorMessage = err => err.message
    const wikiStore = {
      startLoading(key) {
        loadingEvents.push(['start', key])
      },
      stopLoading(key) {
        loadingEvents.push(['stop', key])
      },
      showError(err) {
        errors.push(err)
      }
    }
    const browserWindow = { fetch() {} }
    const state = {
      currentLocale: 'A',
      pageLoadRequestId: 0,
      pages: [],
      loading: false,
      errorMessage: ''
    }

    const localeARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    state.currentLocale = 'B'
    const localeBRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)

    const staleError = new Error('stale locale A failure')
    pendingRequests.get('A').reject(staleError)
    await localeARequest
    expect(errors).toEqual([])
    expect(state.errorMessage).toBe('')
    expect(state.loading).toBe(true)
    expect(markedDatasets).toEqual([])
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])

    const localeBPages = [{ id: 2, path: 'b', title: 'Locale B', links: [] }]
    pendingRequests.get('B').resolve(localeBPages)
    await localeBRequest
    expect(state.pages).toBe(localeBPages)
    expect(markedDatasets).toHaveLength(1)
    expect(markedDatasets[0]).toBe(localeBPages)
    expect(state.loading).toBe(false)
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])

    state.currentLocale = 'C'
    const localeCRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    const currentError = new Error('current locale C failure')
    pendingRequests.get('C').reject(currentError)
    await localeCRequest
    expect(errors).toEqual([currentError])
    expect(state.errorMessage).toBe('current locale C failure')
    expect(state.loading).toBe(false)
    expect(loadingEvents).toEqual([
      ['start', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh'],
      ['start', 'admin-pages-refresh'],
      ['stop', 'admin-pages-refresh']
    ])
  })
})

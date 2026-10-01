import fs from 'node:fs'
import path from 'node:path'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { afterEach, vi } from '../../../server/test/bun-test.mts'
import { compileTemplate } from '@vue/compiler-sfc'
import { fetchPageList as realFetchPageList } from '../../helpers/pages-api.ts'
import { applyPublication, inspectPublication, publicationState } from '../../helpers/admin-pages.ts'

const Vue = await import('vue')
const { compile } = Vue
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const { createRouter, createMemoryHistory } = await import('vue-router')
const mounted = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() }
  vi.restoreAllMocks()
})
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await Vue.nextTick() }

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

  const createComponentOptions = ({ fetchPageList, wikiStore, window = windowStub, publication = () => 'Published' }) => {
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
      publication,
      wikiStore,
      window
    )
  }

  const template = compileTemplate({
    source: source.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
    filename: componentPath,
    id: 'pages-register-contract',
    compilerOptions: { mode: 'function' }
  })
  if (template.errors.length) throw template.errors[0]
  const render = new Function('Vue', template.code)(Vue)
  const row = (id, title, pagePath) => ({
    id, title, path: pagePath, locale: 'en', description: null, tags: [], isPublished: true,
    visibility: 'public', ownerId: null, contentType: 'markdown',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z'
  })
  const publicationSource = fs.readFileSync(path.join(process.cwd(), 'client/components/admin/admin-pages-publication.vue'), 'utf8')
  const publicationScript = publicationSource.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
  const publicationExecutable = new Bun.Transpiler({ loader: 'ts' }).transformSync(publicationScript.replace(/^import .*$/gm, '').replace('export default', 'return'))
  const publicationTemplate = compileTemplate({
    source: publicationSource.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
    filename: 'admin-pages-publication.vue', id: 'publication-review-contract',
    compilerOptions: { mode: 'function' }
  })
  if (publicationTemplate.errors.length) throw publicationTemplate.errors[0]
  const publicationOptions = new Function('defineComponent', 'applyPublication', 'inspectPublication', 'publicationState', publicationExecutable)(
    Vue.defineComponent, applyPublication, inspectPublication, publicationState
  )
  publicationOptions.render = new Function('Vue', publicationTemplate.code)(Vue)
  const mountRegister = async rows => {
    const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(async url => ({
      ok: url === '/_api/pages', headers: { get: () => 'application/json' },
      json: async () => url === '/_api/pages' ? rows : { error: 'Review snapshot unavailable' }
    }))
    const wiki = createWikiStore()
    wiki.store.user = { permissions: [] }
    const options = createComponentOptions({
      fetchPageList: realFetchPageList, wikiStore: wiki.store, window: browserWindow, publication: publicationState
    })
    options.components.AdminPagesPublication = publicationOptions
    const router = createRouter({
      history: createMemoryHistory('/a'),
      routes: [{ path: '/pages/:id?', component: { render: () => null } }]
    })
    await router.push('/pages')
    await router.isReady()
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({ ...options, render })
    app.use(router)
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives, defaults: { VDialog: { transition: false } } }))
    app.component('admin-hero', { render: () => null })
    const vm = app.mount(host)
    mounted.push({ app, host })
    await settle()
    return { vm, host, fetch }
  }

  test('loads the REST register and renders returned records linked to their administration destinations', async () => {
    expect(script).not.toMatch(/\$store\.commit/)
    expect(script).not.toMatch(/apollo\s*:|this\.\$apollo/)
    const page = row(7, 'Returned record', 'docs/returned')
    const { host, fetch } = await mountRegister([page])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/_api/pages'])
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { Accept: 'application/json' } })
    const record = host.querySelector('article.pages-record')
    expect(record.textContent).toContain('Returned record')
    expect(record.querySelector('a').getAttribute('href')).toBe('/a/pages/7')
  })

  test('sorts and paginates records and reviews selections retained outside the active filter', async () => {
    const rows = [row(1, 'Zulu', 'a-first'), row(2, 'Alpha', 'z-last'),
      ...Array.from({ length: 14 }, (_, index) => row(index + 3, `Middle ${String(index).padStart(2, '0')}`, `middle-${index}`))]
    const { vm, host, fetch } = await mountRegister(rows)
    const titles = () => [...host.querySelectorAll('.pages-record a')].map(link => link.textContent)
    const selectSort = async value => {
      const control = [...host.querySelectorAll('.v-select')].find(element => element.querySelector('label')?.textContent === 'Order pages')
      control.querySelector('[role="combobox"]').dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await settle()
      const title = vm.sortOptions.find(option => option.value === value).title
      const option = [...document.querySelectorAll('[role="option"]')].find(element => element.textContent.includes(title))
      expect(option).toBeDefined()
      option.click()
      await settle()
    }
    await selectSort('title')
    expect(titles()[0]).toBe('Alpha')
    expect(titles()).not.toContain('Zulu')
    const pagination = host.querySelector('nav[aria-label]')
    expect(pagination).not.toBeNull()
    const secondPage = pagination.querySelector('[aria-label="Go to page 2"]')
    expect(secondPage).not.toBeNull()
    secondPage.click()
    await settle()
    expect(titles()).toEqual(['Zulu'])
    await selectSort('path')
    expect(titles()[0]).toBe('Zulu')
    const checkbox = host.querySelector('.pages-record input[type="checkbox"]')
    checkbox.click()
    await settle()
    const search = host.querySelector('.pages-search input:not([role="combobox"])')
    search.value = 'Alpha'
    search.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    expect(titles()).toEqual(['Alpha'])
    expect(vm.hiddenSelected).toBe(1)
    const selection = host.querySelector('[role="region"][aria-label]')
    expect(selection.textContent).toMatch(/1 selected.*1 outside/s)
    const reviewButton = [...selection.querySelectorAll('button')].find(button => button.textContent.includes('Review'))
    reviewButton.click()
    await settle()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect([...dialog.querySelectorAll('.publication-review-list article strong')].map(title => title.textContent)).toEqual(['Zulu'])
    expect(vm.selectedPages).toEqual([rows[0]])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/_api/pages', '/_api/pages/1'])
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
    expect(wiki.notifications).toHaveLength(1)
    expect(wiki.notifications[0]).toMatchObject({ style: 'success' })
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { fetchPages } from '../../helpers/pages-api.ts'
import { getErrorMessage, showNotification, setLoading } from '../../helpers/root-ui-store.ts'

const componentPath = join(process.cwd(), 'client/components/profile/pages.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
if (errors.length || !descriptor.script) throw new Error(`Cannot parse profile pages.vue: ${errors}`)
const script = descriptor.script.content
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'return'))

const wikiStore = {
  user: { id: 73 },
  startLoading: vi.fn(),
  stopLoading: vi.fn(),
  showNotification: vi.fn(),
  showError: vi.fn()
}
const component = new Function('AsyncState', 'fetchPages', 'getErrorMessage', 'showNotification', 'setLoading', 'wikiStore', executable)(
  {},
  fetchPages,
  getErrorMessage,
  showNotification,
  setLoading,
  wikiStore
)

const pageRow = {
  id: 10,
  locale: 'en',
  path: 'docs/alpha',
  title: null,
  description: null,
  visibility: 'public',
  ownerId: null,
  contentType: 'markdown',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  tags: ['alpha', 'docs']
}

const makeContext = () => {
  const context = {
    ...component.data(),
    get normalizedSearch() {
      return component.computed.normalizedSearch.call(this)
    },
    get filteredPages() {
      return component.computed.filteredPages.call(this)
    },
    get pageTotal() {
      return component.computed.pageTotal.call(this)
    },
    $t: vi.fn(key => `translated:${key}`)
  }
  context.loadPages = (...args) => component.methods.loadPages.apply(context, args)
  return context
}

const makeResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const setup = () => {
  vi.clearAllMocks()
  wikiStore.user.id = 73
  const browserWindow = { fetch: vi.fn() }
  vi.stubGlobal('window', browserWindow)
  return browserWindow
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('profile pages root UI facade contract', () => {
  test('keeps the REST list and root store migration boundaries', () => {
    expect(script).toContain("import { fetchPages, type PageListRow } from '../../helpers/pages-api'")
    expect(script).toContain("import { getErrorMessage, showNotification, setLoading } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).not.toMatch(/graphql-tag|\$apollo|this\.\$store\.commit/)
  })

  test('loads pages for the current user and announces a successful refresh', async () => {
    const browserWindow = setup()
    let resolveResponse
    browserWindow.fetch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveResponse = resolve
        })
    )
    const context = makeContext()
    context.pages = Array.from({ length: 31 }, (_, index) => ({
      ...pageRow,
      id: index + 1,
      path: `docs/page-${index + 1}`
    }))
    context.pagination = 3
    expect(context.pageTotal).toBe(3)

    const refresh = component.methods.refresh.call(context)

    expect(context.loading).toBe(true)
    expect(wikiStore.startLoading).toHaveBeenCalledWith('profile-pages-refresh')
    expect(wikiStore.startLoading).toHaveBeenCalledTimes(1)
    const [url, init] = browserWindow.fetch.mock.calls[0]
    expect(url).toBe('/_api/pages?creatorId=73&authorId=73')
    expect(init).toMatchObject({
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })

    resolveResponse(makeResponse([pageRow]))
    await refresh

    expect(context.pages).toEqual([pageRow])
    expect(context.pageTotal).toBe(1)
    expect(context.pagination).toBe(1)
    expect(context.loading).toBe(false)
    expect(wikiStore.stopLoading).toHaveBeenCalledWith('profile-pages-refresh')
    expect(wikiStore.stopLoading).toHaveBeenCalledTimes(1)
    expect(wikiStore.showNotification).toHaveBeenCalledWith({
      message: 'translated:profile:pages.refreshSuccess',
      style: 'success',
      icon: 'cached'
    })
  })

  test('surfaces page load failures without success feedback and always clears loading', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockRejectedValue(new Error('Page access denied.'))
    const context = makeContext()

    await component.methods.refresh.call(context)

    expect(context.errorMessage).toBe('Page access denied.')
    expect(context.loading).toBe(false)
    expect(wikiStore.showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Page access denied.' }))
    expect(wikiStore.showError).toHaveBeenCalledTimes(1)
    expect(wikiStore.startLoading).toHaveBeenCalledWith('profile-pages-refresh')
    expect(wikiStore.startLoading).toHaveBeenCalledTimes(1)
    expect(wikiStore.showNotification).not.toHaveBeenCalled()
    expect(wikiStore.stopLoading).toHaveBeenCalledWith('profile-pages-refresh')
    expect(wikiStore.stopLoading).toHaveBeenCalledTimes(1)
  })
})

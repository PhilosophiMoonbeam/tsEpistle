import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { convertPage } from '../../helpers/pages-api.ts'

const componentPath = join(process.cwd(), 'client/components/common/page-convert.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
if (errors.length || !descriptor.script) throw new Error(`Cannot parse page-convert.vue: ${errors}`)
const script = descriptor.script.content
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'return'))

const wikiStore = {
  page: {},
  startLoading: vi.fn(),
  stopLoading: vi.fn(),
  showError: vi.fn()
}
const component = new Function('defineComponent', 'markRaw', 'wikiStore', 'convertPage', executable)(
  options => options,
  value => value,
  wikiStore,
  convertPage
)

const makeContext = () => {
  let context
  context = {
    ...component.data(),
    modelValue: true,
    $refs: { editorSelect: { focus: vi.fn() } },
    $emit: vi.fn((event, value) => {
      if (event === 'update:modelValue') context.modelValue = value
    }),
    $nextTick: vi.fn(async () => {})
  }

  Object.defineProperty(context, 'isShown', {
    get: () => component.computed.isShown.get.call(context),
    set: value => component.computed.isShown.set.call(context, value)
  })
  for (const key of ['pageTitle', 'pagePath', 'pageLocale', 'pageVisibility', 'pageId', 'pageEditor', 'pageSourceRevision', 'canConvert']) {
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
  wikiStore.page = {
    id: 73,
    title: 'Guide',
    path: 'guide/start',
    locale: 'en',
    visibility: 'private',
    editor: 'markdown',
    sourceRevision: 'revision-before-dialog'
  }
  const browserWindow = { fetch: vi.fn(), location: { assign: vi.fn() } }
  vi.stubGlobal('window', browserWindow)
  return browserWindow
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('page-convert root UI facade contract', () => {
  test('submits the current source revision once and redirects private pages after success', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockResolvedValue(makeResponse({}))
    const context = makeContext()
    context.newEditor = context.pageEditor
    await component.methods.convertPage.call(context)
    expect(browserWindow.fetch).not.toHaveBeenCalled()
    context.newEditor = 'visual-markdown'
    context.returnFocusTarget = {}
    wikiStore.page.sourceRevision = 'revision-at-submit'

    const conversion = component.methods.convertPage.call(context)
    await component.methods.convertPage.call(context)

    expect(context.loading).toBe(true)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = browserWindow.fetch.mock.calls[0]
    expect(url).toBe('/_api/pages/73/convert')
    expect(JSON.parse(init.body)).toEqual({
      editor: 'visual-markdown',
      expectedSourceRevision: 'revision-at-submit'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(wikiStore.startLoading).toHaveBeenCalledWith('page-convert')
    expect(wikiStore.startLoading).toHaveBeenCalledTimes(1)

    await conversion

    expect(context.modelValue).toBe(false)
    expect(context.returnFocusTarget).toBeNull()
    expect(browserWindow.location.assign).toHaveBeenCalledWith('/e/_private/en/guide/start')
    expect(wikiStore.stopLoading).toHaveBeenCalledWith('page-convert')
    expect(wikiStore.stopLoading).toHaveBeenCalledTimes(1)
    expect(wikiStore.showError).not.toHaveBeenCalled()
  })

  test('does not redirect or report an error when unmount aborts the in-flight request', async () => {
    const browserWindow = setup()
    let resolveResponse
    browserWindow.fetch.mockImplementation((_url, init) => {
      return new Promise(resolve => {
        resolveResponse = resolve
      })
    })
    const context = makeContext()
    context.newEditor = 'visual-markdown'

    const conversion = component.methods.convertPage.call(context)
    const signal = browserWindow.fetch.mock.calls[0][1].signal
    component.beforeUnmount.call(context)

    expect(signal.aborted).toBe(true)
    resolveResponse(makeResponse({}))
    await conversion

    expect(browserWindow.location.assign).not.toHaveBeenCalled()
    expect(wikiStore.showError).not.toHaveBeenCalled()
    expect(wikiStore.startLoading).toHaveBeenCalledTimes(1)
    expect(wikiStore.stopLoading).toHaveBeenCalledWith('page-convert')
    expect(wikiStore.stopLoading).toHaveBeenCalledTimes(1)
  })

  test('reports a current request failure and returns the editor focus to the dialog', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockResolvedValue(makeResponse({ error: 'The page changed.' }, 409))
    const context = makeContext()
    context.newEditor = 'visual-markdown'

    await component.methods.convertPage.call(context)

    expect(context.loading).toBe(false)
    expect(context.modelValue).toBe(true)
    expect(context.$refs.editorSelect.focus).toHaveBeenCalledTimes(1)
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
    expect(wikiStore.showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'The page changed.' }))
    expect(wikiStore.showError).toHaveBeenCalledTimes(1)
    expect(wikiStore.startLoading).toHaveBeenCalledWith('page-convert')
    expect(wikiStore.startLoading).toHaveBeenCalledTimes(1)
    expect(wikiStore.stopLoading).toHaveBeenCalledWith('page-convert')
    expect(wikiStore.stopLoading).toHaveBeenCalledTimes(1)
  })
})

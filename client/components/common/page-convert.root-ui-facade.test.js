import { basename } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow as domWindow, document, setLocation } from '../../test/browser-dom.mts'

const previousGlobals = ['siteConfig', 'siteLangs'].flatMap(name => [globalThis, domWindow].map(target => ({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })))
const installBrowserConfig = () => {
  for (const target of [globalThis, domWindow]) {
    Object.defineProperty(target, 'siteConfig', { configurable: true, writable: true, value: { title: 'Conversion test', lang: 'en', product: { name: 'tsEpistle', version: '0.1.0-test' }, agentCsrfToken: 'conversion-session-csrf' } })
    Object.defineProperty(target, 'siteLangs', { configurable: true, writable: true, value: [{ code: 'en', name: 'English' }] })
  }
}
// Application/store modules must see the same browser bootstrap as the mounted UI.
installBrowserConfig()
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
Bun.plugin({ name: 'conversion-mounted-native-sfc', setup(builder) {
  builder.onLoad({ filter: /(?:page-convert|v-card-chin)\.vue$/ }, async ({ path: filename }) => {
    const parsed = parse(await Bun.file(filename).text(), { filename })
    if (parsed.errors.length) throw parsed.errors[0]
    const id = basename(filename, '.vue')
    const script = parsed.descriptor.script?.content.trim() || parsed.descriptor.scriptSetup?.content.trim()
      ? compileScript(parsed.descriptor, { id, genDefaultAs: '__component' })
      : { content: 'const __component = {};', bindings: {} }
    const template = compileTemplate({ source: parsed.descriptor.template.content, filename, id, preprocessLang: parsed.descriptor.template.lang, preprocessOptions: { doctype: 'html' }, compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } })
    if (template.errors.length) throw template.errors[0]
    return { loader: 'ts', contents: `${script.content}\n${template.code}\n__component.render = render;\nexport default __component;` }
  })
} })
const { default: component } = await import('./page-convert.vue')
const { default: CardChin } = await import('./v-card-chin.vue')
const { wikiStore, pinia } = await import('../../store/index.ts')
const { translateEnglish } = await import('../../test/english-translate.mts')
const previousPage = { ...wikiStore.page }, previousUser = { ...wikiStore.user }
const previousAuth = { authRefreshSettled: wikiStore.authRefreshSettled, authRefreshPending: wikiStore.authRefreshPending, authRefreshOutcome: wikiStore.authRefreshOutcome }
const previousNotification = { ...wikiStore.notification }
const previousFetch = domWindow.fetch
const cleanups = []

const makeContext = () => {
  let context
  context = {
    ...component.data(), modelValue: true,
    $refs: { editorSelect: { focus: vi.fn() } },
    $emit: vi.fn((event, value) => { if (event === 'update:modelValue') context.modelValue = value }),
    $nextTick: vi.fn(async () => {})
  }
  Object.defineProperty(context, 'isShown', {
    get: () => component.computed.isShown.get.call(context),
    set: value => component.computed.isShown.set.call(context, value)
  })
  for (const key of ['pageTitle', 'pagePath', 'pageLocale', 'pageVisibility', 'pageId', 'pageEditor', 'pageSourceRevision', 'authorityKey', 'needsReview', 'canConvert', 'differenceSummary']) {
    Object.defineProperty(context, key, { get: () => component.computed[key].call(context) })
  }
  for (const [name, method] of Object.entries(component.methods)) context[name] = (...args) => method.apply(context, args)
  return context
}
const makeResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
const reviewPayload = (overrides = {}) => ({
  pageId: 73, sourceRevision: '21', editor: 'markdown',
  originalSource: '<pre><code>&lt;x&gt;\\\\</code></pre>\r\n<script>window.conversionPreviewExecuted = true</script>',
  candidate: '```\n<x>\\\\\n```', candidateDigest: 'a'.repeat(64), reviewToken: 'r'.repeat(43),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  report: { warnings: ['Not certified lossless.'], differences: { text: false, code: false, links: false, tables: false }, previewHtml: '<script>window.conversionPreviewExecuted = true</script>', roundtripSource: '```\n<x>\\\\\n```', renderer: 'native markdownCore' },
  ...overrides
})
const setup = ({ mounted = false, html = false } = {}) => {
  vi.clearAllMocks()
  installBrowserConfig()
  setLocation('/en/guide/start')
  Object.assign(wikiStore.page, { id: 73, title: 'Guide', path: 'guide/start', locale: 'en', visibility: 'private', editor: html ? 'ckeditor' : 'markdown', sourceRevision: '21' })
  Object.assign(wikiStore.user, { id: 5, authenticated: true, authVersion: 4, permissions: ['write:pages'] })
  Object.assign(wikiStore, { authRefreshSettled: true, authRefreshPending: false, authRefreshOutcome: 'authenticated' })
  Object.assign(wikiStore.notification, { isActive: false, message: '' })
  if (mounted) return domWindow
  const browserWindow = { fetch: vi.fn(), siteConfig: domWindow.siteConfig, location: { href: domWindow.location.href, origin: domWindow.location.origin, assign: vi.fn() } }
  vi.stubGlobal('window', browserWindow)
  return browserWindow
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  domWindow.fetch = previousFetch
  Object.assign(wikiStore.page, previousPage)
  Object.assign(wikiStore.user, previousUser)
  Object.assign(wikiStore, previousAuth)
  Object.assign(wikiStore.notification, previousNotification)
  for (const { target, name, descriptor } of previousGlobals) {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
  delete domWindow.conversionPreviewExecuted
  setLocation('/')
})
const settle = async () => { for (let count = 0; count < 16; count++) { await Promise.resolve(); await Vue.nextTick() } }
const mountDialog = async transport => {
  setup({ mounted: true, html: true })
  const fetch = vi.fn(transport)
  domWindow.fetch = (input, init) => fetch(String(input), init)
  const props = Vue.reactive({ modelValue: true })
  const host = document.createElement('div'); document.body.append(host)
  const app = Vue.createApp({ render: () => Vue.h(component, { ...props, 'onUpdate:modelValue': value => { props.modelValue = value } }) })
  app.use(pinia)
  app.use(createVuetify({ components: vuetifyComponents }))
  app.component('v-card-chin', CardChin)
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  await settle()
  const select = document.querySelector('[role="combobox"]')
  if (!select) throw new Error('Missing editor selector')
  select.focus()
  select.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  await settle()
  const markdown = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent.includes(translateEnglish('common:pageConvert.editorMarkdown')))
  if (!markdown) throw new Error('Missing Markdown editor option')
  markdown.click(); await settle()
  return { fetch, props }
}
const button = label => {
  const result = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label)
  if (!result) throw new Error(`Missing action ${label}`)
  return result
}
const textarea = label => {
  const field = [...document.querySelectorAll('.v-input')].find(item => [...item.querySelectorAll('label')].some(node => node.textContent === label))?.querySelector('textarea')
  if (!field) throw new Error(`Missing review field ${label}`)
  return field
}
const acceptReview = async () => {
  const checkbox = document.querySelector('input[type="checkbox"]')
  if (!checkbox) throw new Error('Missing explicit review acceptance')
  checkbox.click(); await settle()
}

describe('page-convert root UI facade contract', () => {
  test('keeps submission single-flight and redirects private pages after success', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockResolvedValue(makeResponse({}))
    const context = makeContext()
    context.newEditor = context.pageEditor
    await context.convertPage()
    expect(browserWindow.fetch).not.toHaveBeenCalled()
    context.newEditor = 'visual-markdown'
    context.returnFocusTarget = {}
    wikiStore.page.sourceRevision = '22'
    const conversion = context.convertPage()
    await context.convertPage()
    expect(context.loading).toBe(true)
    expect(browserWindow.fetch).toHaveBeenCalledTimes(1)
    await conversion
    expect(context.modelValue).toBe(false)
    expect(context.returnFocusTarget).toBeNull()
    expect(browserWindow.location.assign).toHaveBeenCalledWith('/e/_private/en/guide/start')
    expect(wikiStore.notification.isActive).toBe(false)
  })

  test('unmount cancels candidate generation without reporting a conversion result', async () => {
    const browserWindow = setup({ html: true })
    let resolveResponse
    browserWindow.fetch.mockImplementation(() => new Promise(resolve => { resolveResponse = resolve }))
    const context = makeContext(); context.newEditor = 'markdown'
    const conversion = context.convertPage()
    const signal = browserWindow.fetch.mock.calls[0][1].signal
    component.beforeUnmount.call(context)
    expect(signal.aborted).toBe(true)
    resolveResponse(makeResponse(reviewPayload())); await conversion
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
    expect(wikiStore.notification.isActive).toBe(false)
  })

  test('navigation after confirmation does not abort its submitted request or redirect back on completion', async () => {
    const browserWindow = setup({ html: true })
    let resolveCommit
    browserWindow.fetch.mockResolvedValueOnce(makeResponse(reviewPayload()))
      .mockImplementationOnce(() => new Promise(resolve => { resolveCommit = resolve }))
    const context = makeContext(); context.newEditor = 'markdown'
    await context.convertPage()
    context.reviewAccepted = true
    const conversion = context.convertPage()
    context.discard()
    expect(context.modelValue).toBe(true)
    expect(context.committing).toBe(true)
    const signal = browserWindow.fetch.mock.calls[1][1].signal
    component.beforeUnmount.call(context)
    expect(signal.aborted).toBe(false)
    expect(context.review).toBeNull()
    resolveCommit(makeResponse({})); await conversion
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
    expect(wikiStore.notification).toMatchObject({ isActive: true, style: 'success' })
  })

  test('a lost confirmation response reports an uncertain outcome, not a source-preserving cancellation', async () => {
    const browserWindow = setup({ html: true })
    browserWindow.fetch.mockResolvedValueOnce(makeResponse(reviewPayload()))
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
    const context = makeContext(); context.newEditor = 'markdown'
    await context.convertPage()
    context.reviewAccepted = true
    await context.convertPage()
    expect(context.modelValue).toBe(true)
    expect(context.review).toBeNull()
    expect(context.commitMessage).toContain('may have completed')
    expect(wikiStore.notification.message).toBe(context.commitMessage)
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
  })

  test('reports a current request failure and returns editor focus to the dialog', async () => {
    const browserWindow = setup()
    browserWindow.fetch.mockResolvedValue(makeResponse({ error: 'The page changed.' }, 409))
    const context = makeContext(); context.newEditor = 'visual-markdown'
    await context.convertPage()
    expect(context.loading).toBe(false)
    expect(context.modelValue).toBe(true)
    expect(context.$refs.editorSelect.focus).toHaveBeenCalledTimes(1)
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
    expect(wikiStore.notification).toMatchObject({ isActive: true, message: 'The page changed.' })
  })

  test('invalid review tokens take the visible error path, never acceptance or commit', async () => {
    const browserWindow = setup({ html: true })
    browserWindow.fetch.mockResolvedValue(makeResponse(reviewPayload({ reviewToken: 'opaque-server-review' })))
    const context = makeContext(); context.newEditor = 'markdown'
    await context.convertPage()
    expect(browserWindow.fetch).toHaveBeenCalledTimes(1)
    expect(context.review).toBeNull()
    expect(context.reviewAccepted).toBe(false)
    expect(wikiStore.notification).toMatchObject({ isActive: true, message: 'Page conversion review failed' })
    expect(browserWindow.location.assign).not.toHaveBeenCalled()
  })

  test('mounted review shows inert exact source and permits no commit before checkbox acceptance', async () => {
    const review = reviewPayload()
    let resolveCommit
    const { fetch, props } = await mountDialog(url => url.endsWith('/review') ? Promise.resolve(makeResponse(review)) : new Promise(resolve => { resolveCommit = resolve }))
    expect(fetch).not.toHaveBeenCalled()
    button('Review conversion candidate').click(); await settle()
    expect(wikiStore.notification.isActive).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(textarea('Exact original HTML').value).toBe(review.originalSource.replace(/\r\n?/gu, '\n'))
    expect(textarea('Candidate Markdown').value).toBe(review.candidate)
    expect(textarea('Native render HTML (inert source; never executed in this dialog)').value).toBe(review.report.previewHtml)
    expect(document.querySelector('[aria-label="Conversion review"] script')).toBeNull()
    expect(domWindow.conversionPreviewExecuted).toBeUndefined()
    let downloadedOriginal
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { downloadedOriginal = blob; return 'blob:conversion-original' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(domWindow.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    button('Download exact original HTML').click()
    expect(await downloadedOriginal.text()).toBe(review.originalSource)
    expect(button('Confirm reviewed conversion').disabled).toBe(true)
    button('Confirm reviewed conversion').click(); await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    await acceptReview()
    expect(button('Confirm reviewed conversion').disabled).toBe(false)
    button('Confirm reviewed conversion').click(); await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect([...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Cancel conversion')).toBe(false)
    const signal = fetch.mock.calls[1][1].signal
    document.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(props.modelValue).toBe(true)
    expect(signal.aborted).toBe(false)
    expect(button('Confirming conversion').disabled).toBe(true)
    resolveCommit(makeResponse({ error: 'The page changed.' }, 409)); await settle()
    expect(wikiStore.notification).toMatchObject({ isActive: true, message: 'The page changed.' })
    expect(document.querySelector('[aria-label="Conversion review"]')).toBeNull()
  })

  test.each(['source', 'account', 'pending-auth'])('%s retirement removes private review data without aborting a submitted confirmation', async change => {
    let resolveCommit
    const { fetch } = await mountDialog(url => url.endsWith('/review')
      ? Promise.resolve(makeResponse(reviewPayload()))
      : new Promise(resolve => { resolveCommit = resolve }))
    button('Review conversion candidate').click(); await settle(); await acceptReview()
    button('Confirm reviewed conversion').click(); await settle()
    const signal = fetch.mock.calls[1][1].signal
    if (change === 'source') wikiStore.page.sourceRevision = '22'
    if (change === 'account') wikiStore.user.id = 6
    if (change === 'pending-auth') wikiStore.authRefreshPending = true
    await settle()
    expect(signal.aborted).toBe(false)
    expect(document.querySelector('[aria-label="Conversion review"]')).toBeNull()
    resolveCommit(makeResponse({})); await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    if (change !== 'source') {
      expect(wikiStore.notification.isActive).toBe(false)
      expect(document.querySelector('[role="status"]').textContent).toContain('may have completed')
    }
  })

  test('an empty valid candidate still requires visible explicit acceptance', async () => {
    const { fetch } = await mountDialog(() => Promise.resolve(makeResponse(reviewPayload({ candidate: '' }))))
    button('Review conversion candidate').click(); await settle()
    expect(textarea('Candidate Markdown').value).toBe('')
    expect(button('Confirm reviewed conversion').disabled).toBe(true)
    button(translateEnglish('common:actions.cancel')).click(); await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Conversion review"]')).toBeNull()
    expect(wikiStore.page.editor).toBe('ckeditor')
  })

  test.each(['source', 'account', 'session', 'pending-auth'])('%s changes discard an accepted review without a commit', async change => {
    const { fetch } = await mountDialog(() => Promise.resolve(makeResponse(reviewPayload())))
    button('Review conversion candidate').click(); await settle(); await acceptReview()
    if (change === 'source') wikiStore.page.sourceRevision = '22'
    if (change === 'account') wikiStore.user.id = 6
    if (change === 'pending-auth') wikiStore.authRefreshPending = true
    if (change === 'session') {
      domWindow.siteConfig.agentCsrfToken = 'replacement-session-csrf'
      button('Confirm reviewed conversion').click()
    }
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Conversion review"]')).toBeNull()
    expect(wikiStore.page.editor).toBe('ckeditor')
    if (change === 'session') expect(wikiStore.notification.message).toContain('browser session changed')
  })

  test.each(['source', 'account', 'session', 'cancel'])('%s change fences a late review response', async change => {
    let resolveReview
    const { fetch } = await mountDialog(() => new Promise(resolve => { resolveReview = resolve }))
    button('Review conversion candidate').click(); await settle()
    if (change === 'source') wikiStore.page.sourceRevision = '22'
    if (change === 'account') wikiStore.user.id = 6
    if (change === 'session') domWindow.siteConfig.agentCsrfToken = 'replacement-session-csrf'
    if (change === 'cancel') button('Cancel conversion').click()
    await settle()
    if (change !== 'session') expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    resolveReview(makeResponse(reviewPayload())); await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Conversion review"]')).toBeNull()
    expect(wikiStore.page.editor).toBe('ckeditor')
  })
})

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { babelParse, compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { translateEnglish as t } from '../../test/english-translate.mts'
import type { App, Component, ComponentOptions } from 'vue'
import type { PageDetails, PageListRow } from '../../helpers/pages-api.ts'
import type { DiscussionPage, DiscussionWorkspace, ModerationInspection, ModerationInventory } from '../../../shared/discussion-policy.ts'
import type { AdminApiBootstrap } from '../../helpers/auth-api.ts'
import type { UserPresentationDefaults } from '../../../shared/user-presentation.ts'
import moment from 'moment-timezone'
import { applyUserPresentation } from '../../helpers/index.ts'
import { getActivePinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

const previousGlobals = ['siteConfig', 'siteLangs'].flatMap(name => [globalThis, browserWindow].map(target => ({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })))
function installBrowserConfig() {
  for (const target of [globalThis, browserWindow]) {
    Object.defineProperty(target, 'siteConfig', { configurable: true, writable: true, value: { title: 'Admin presentation fixture', lang: 'en', product: { name: 'tsEpistle', version: '0.1.0-test' }, agentCsrfToken: 'admin-presentation-fixture-csrf' } })
    Object.defineProperty(target, 'siteLangs', { configurable: true, writable: true, value: [{ code: 'en', name: 'English' }] })
  }
}
installBrowserConfig()
const { pinia, wikiStore } = await import('../../store/index.ts')

// These module-loading boundaries follow the real-control test convention:
// browser-dom must install the window before Vue/Vuetify detect the platform.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')

// Compile complete production SFCs, including their children and setup macros.
// Only the HTTP boundary is supplied by the test; formatters, stores and controls
// are the real imports. Import declarations are removed by AST spans, not by
// extracting methods or replacing the consumer's template.
const loaded = new Map<string, Component>()
async function consumer(relativePath: string): Promise<Component> {
  const filename = resolve(relativePath)
  const cached = loaded.get(filename)
  if (cached) return cached
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  if (errors.length || !descriptor.template) throw new Error(`Cannot parse ${filename}: ${errors}`)
  const script = compileScript(descriptor, { id: filename, genDefaultAs: 'component' })
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.content)
  const imports = babelParse(javascript, { sourceType: 'module' }).program.body.filter(node => node.type === 'ImportDeclaration')
  const names: string[] = []
  const values: unknown[] = []
  let body = ''
  let offset = 0
  for (const declaration of imports) {
    if (declaration.start == null || declaration.end == null) throw new Error(`Missing import span in ${filename}`)
    body += javascript.slice(offset, declaration.start)
    offset = declaration.end
    const source = declaration.source.value
    const target = source.startsWith('@/') ? resolve('client', source.slice(2)) : source.startsWith('.') ? resolve(dirname(filename), source) : source
    const module: Record<string, unknown> = target.endsWith('.vue')
      ? { default: await consumer(target) }
      : await import(target.startsWith('/') ? pathToFileURL(target).href : target)
    for (const specifier of declaration.specifiers) {
      names.push(specifier.local.name)
      values.push(specifier.type === 'ImportNamespaceSpecifier' ? module : module[specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value])
    }
  }
  body += javascript.slice(offset)
  const component: ComponentOptions = new Function(...names, `${body}\nreturn component`)(...values)
  const template = compileTemplate({
    filename,
    id: filename,
    source: descriptor.template.content,
    preprocessLang: descriptor.template.lang,
    preprocessOptions: { doctype: 'html' },
    compilerOptions: { mode: 'function', bindingMetadata: script.bindings, expressionPlugins: ['typescript'] }
  })
  if (template.errors.length) throw new Error(`Cannot compile ${filename}: ${template.errors}`)
  const renderFactory = new Bun.Transpiler({ loader: 'ts' }).transformSync(`function renderTemplate(Vue) {\n${template.code}\n}`)
  component.render = new Function('Vue', `${renderFactory}\nreturn renderTemplate(Vue)`)(Vue)
  loaded.set(filename, component)
  return component
}

const [Discussion, Publication, Credentials, Schedule, AdminHero] = await Promise.all([
  consumer('client/components/admin/admin-comments.vue'),
  consumer('client/components/admin/admin-pages-publication.vue'),
  consumer('client/components/admin/admin-api.vue'),
  consumer('client/components/admin/admin-page-publication-settings.vue'),
  consumer('client/components/common/admin-hero.vue')
])

const beforeDst = '2024-03-10T06:30:45.123Z'
const afterDst = '2024-03-10T07:30:59.456Z'
const crossDate = '2024-03-10T00:30:00.000Z'
const page = (id: number, publishStartDate: string | null = beforeDst, publishEndDate: string | null = afterDst): PageDetails => ({
  id, title: `Page ${id}`, description: null, locale: 'en', path: `records/${id}`, hash: `hash-${id}`,
  visibility: 'public', ownerId: null, contentType: 'markdown', isPublished: true,
  publishStartDate, publishEndDate, createdAt: crossDate, updatedAt: afterDst, sourceRevision: '17',
  capabilities: { viewStewardContacts: true },
  accuracy: { sourceRevision: '17', updatedAt: afterDst, author: null, latestAttestation: null, canVerify: false, asOf: afterDst, status: 'needs-verification' },
  okf: { authority: { state: 'invalid', metadata: null, trust: null }, projection: { state: 'pending', value: null } },
  pageFeatures: { schemaVersion: 1, linksVisible: true, ratingsAllowed: true, lastEditorVisible: true }
})
const discussionPage: DiscussionPage = { id: 1, title: 'Calendar', locale: 'en', path: 'calendar', visibility: 'public' }
const inventory: ModerationInventory = {
  items: [beforeDst, afterDst, crossDate, 'invalid', ''].map((createdAt, index) => ({
    id: index + 1, authorId: 7, authorName: `Reader ${index + 1}`, excerpt: 'Calendar discussion',
    createdAt, updatedAt: createdAt, isHidden: false, page: discussionPage
  })), total: 5, limit: 30, offset: 0
}
const inspection: ModerationInspection = {
  id: 1, authorId: 7, authorName: 'Reader 1', excerpt: 'Calendar discussion',
  createdAt: beforeDst, updatedAt: beforeDst, isHidden: false, page: discussionPage,
  content: 'Which side of the clock change?', authorEmail: '', authorIP: '', moderationReason: '',
  moderatedAt: null, moderatedBy: null, fingerprint: 'comment-1',
  history: [{ id: 1, action: 'restore', actorId: 7, createdAt: afterDst, reason: 'Relevant contribution' }]
}
const workspace: DiscussionWorkspace = {
  enabled: true, pageRatingsEnabled: false, pageRatingsMode: 'thumbs', fingerprint: 'workspace-1',
  providers: [{ key: 'default', title: 'Built-in discussions', description: '', website: 'https://example.invalid', isAvailable: true, isEnabled: true, external: false, config: { minDelay: 0 }, props: { minDelay: { type: 'number' } } }],
  counts: { comments: 5, visible: 5, hidden: 0, pages: 1, closedPages: 0 },
  runtime: { provider: 'default', antiSpam: { state: 'off', checkedAt: null } }
}
const bootstrap: AdminApiBootstrap = {
  enabled: true, createFullAccess: true, assignableGroups: [], canManagePersonalMcpKeys: false, personalMcpKeys: [],
  keys: [beforeDst, afterDst, crossDate, 'invalid'].map((instant, index) => ({
    id: index + 1, name: `Credential ${index + 1}`, keyShort: '...[redacted]', grant: { groupId: 1 },
    canRevoke: true, isRevoked: false, expiration: instant, createdAt: instant, updatedAt: instant
  }))
}

const apps: App[] = []
const errors: unknown[] = []
const unexpectedRequests: string[] = []
const requests: Array<{ url: string; init: RequestInit }> = []
let restore: (() => void) | undefined
beforeEach(() => {
  installBrowserConfig()
  const originalFetch = browserWindow.fetch
  const originalActivePinia = getActivePinia()
  const originalUser = wikiStore.user
  const originalLoading = wikiStore.loadingCounts
  const originalNotification = wikiStore.notification
  const originalOutcome = wikiStore.authRefreshOutcome
  const originalLocale = moment.locale()
  const originalZone = moment().tz()
  const formats = moment.localeData('en')
  const originalFormats = { L: formats.longDateFormat('L'), LT: formats.longDateFormat('LT'), LTS: formats.longDateFormat('LTS'), LL: formats.longDateFormat('LL'), LLL: formats.longDateFormat('LLL'), LLLL: formats.longDateFormat('LLLL') }
  const originalTimezone = process.env.TZ
  const bodyNodes = new Set(document.body.childNodes)
  const headNodes = new Set(document.head.childNodes)
  restore = () => {
    browserWindow.fetch = originalFetch
    wikiStore.user = originalUser
    wikiStore.loadingCounts = originalLoading
    wikiStore.notification = originalNotification
    wikiStore.authRefreshOutcome = originalOutcome
    setActivePinia(originalActivePinia)
    moment.locale('en')
    applyUserPresentation({ timezone: originalZone ?? '', dateFormat: '', timeFormat: 'locale' })
    moment.updateLocale('en', { longDateFormat: originalFormats })
    moment.locale(originalLocale)
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
    for (const node of [...document.body.childNodes]) if (!bodyNodes.has(node)) node.remove()
    for (const node of [...document.head.childNodes]) if (!headNodes.has(node)) node.remove()
    for (const { target, name, descriptor } of previousGlobals) {
      if (descriptor) Object.defineProperty(target, name, descriptor)
      else Reflect.deleteProperty(target, name)
    }
  }
  process.env.TZ = 'UTC'
  moment.locale('en')
  wikiStore.user = { ...originalUser, id: 7, authenticated: true, dateFormat: '', timeFormat: 'locale', timezone: '' }
  wikiStore.loadingCounts = {}
  wikiStore.notification = { ...originalNotification }
  wikiStore.authRefreshOutcome = 'authenticated'
  requests.length = 0
  unexpectedRequests.length = 0
  errors.length = 0
})
afterEach(() => {
  try {
    for (const app of apps.splice(0).reverse()) app.unmount()
  } finally {
    restore?.()
    restore = undefined
  }
  expect(errors).toEqual([])
  expect(unexpectedRequests).toEqual([])
})

const settle = async () => { for (let index = 0; index < 12; index++) { await Promise.resolve(); await Vue.nextTick() } }
async function mount(component: Component, props: Record<string, unknown> = {}, hash = '') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component }] })
  await router.push({ path: '/', hash })
  await router.isReady()
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp(component, props)
  app.use(pinia)
  app.use(router)
  app.use(createVuetify({ components, directives, defaults: { VDialog: { transition: false }, VTooltip: { disabled: true }, VSelect: { menuProps: { transition: false } } } }))
  app.component('AdminHero', AdminHero)
  app.config.globalProperties.$t = t
  app.config.errorHandler = error => errors.push(error)
  apps.push(app)
  app.mount(host)
  await settle()
  return host
}
function serve(pages: PageDetails[]) {
  browserWindow.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, browserWindow.location.href).pathname
    if (init.method === 'PATCH' && /^\/_api\/pages\/\d+\/publication$/.test(path)) {
      requests.push({ url: path, init })
      return Response.json({})
    }
    if (path === '/_api/comments/workspace') return Response.json(workspace)
    if (path === '/_api/comments/moderation') return Response.json(inventory)
    if (path === '/_api/comments/moderation/1') return Response.json(inspection)
    if (path === '/_api/auth/api') return Response.json(bootstrap)
    if (path === '/_api/auth/api/connections') return Response.json({ groups: [] })
    const found = pages.find(row => path === `/_api/pages/${row.id}`)
    if (found) return Response.json(found)
    unexpectedRequests.push(`${init.method ?? 'GET'} ${path}`)
    throw new Error(`Unexpected request: ${path}`)
  }
}
async function present(presentation: UserPresentationDefaults) {
  wikiStore.$patch({ user: presentation })
  applyUserPresentation(wikiStore.user)
  await Vue.nextTick()
}
function required<E extends Element>(root: ParentNode, selector: string): E {
  const node = root.querySelector<E>(selector)
  if (!node) throw new Error(`Missing rendered consumer element: ${selector}`)
  return node
}
function click(root: ParentNode, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!button) throw new Error(`Missing rendered control: ${label}`)
  button.click()
}
const text = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map(node => node.textContent?.trim())
const ownText = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map(node => [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent).join('').trim())
const discussionLabels = (host: HTMLElement) => text(host, '.discussion-author small')
const publicationLabels = () => text(document, '.publication-review-list article small:last-child')
const credentialLabels = (host: HTMLElement) => ownText(host, '#api-panel-credentials .api-key-expiry')

async function mountConsumers(pages: PageDetails[]) {
  serve(pages)
  const discussion = await mount(Discussion, {}, '#moderation')
  const credentials = await mount(Credentials)
  const selected: PageListRow[] = pages.map(row => ({ ...row, tags: [] }))
  await mount(Publication, { modelValue: true, selected })
  return { discussion, credentials }
}

describe('production administrative timestamp consumers', () => {
  test('rerenders real discussion, publication and credential labels across account ordering, clocks and DST', async () => {
    await present({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', timezone: 'America/New_York' })
    const { discussion, credentials } = await mountConsumers([page(1), page(2, crossDate, null)])
    expect(discussionLabels(discussion)).toEqual(['2024-03-10 1:30 AM · #1', '2024-03-10 3:30 AM · #2', '2024-03-09 7:30 PM · #3', 'Date unavailable · #4', 'Date unavailable · #5'])
    expect(publicationLabels()).toEqual(['Window: 2024-03-10 1:30 AM → 2024-03-10 3:30 AM', 'Window: 2024-03-09 7:30 PM → No boundary'])
    expect(credentialLabels(credentials)).toEqual(['2024-03-10', '2024-03-10', '2024-03-09', 'Unknown'])
    expect(text(credentials, '#api-panel-credentials .api-key-detail dl > div:nth-child(2) dd')).toEqual(['2024-03-10', '2024-03-10', '2024-03-09', 'Unknown'])
    required<HTMLButtonElement>(discussion, '.discussion-comment-row').click()
    await settle()
    expect(required(document, '.discussion-detail-heading p').textContent).toContain('2024-03-10 1:30 AM')
    expect(required(document, '.discussion-history small').textContent).toBe('2024-03-10 3:30 AM · Account #7')

    await present({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'UTC' })
    expect(discussionLabels(discussion)).toEqual(['10/03/2024 06:30 · #1', '10/03/2024 07:30 · #2', '10/03/2024 00:30 · #3', 'Date unavailable · #4', 'Date unavailable · #5'])
    expect(publicationLabels()).toEqual(['Window: 10/03/2024 06:30 → 10/03/2024 07:30', 'Window: 10/03/2024 00:30 → No boundary'])
    expect(credentialLabels(credentials)).toEqual(['10/03/2024', '10/03/2024', '10/03/2024', 'Unknown'])
    expect(text(credentials, '#api-panel-credentials .api-key-detail dl > div:nth-child(2) dd')).toEqual(['10/03/2024', '10/03/2024', '10/03/2024', 'Unknown'])
    expect(required(document, '.discussion-detail-heading p').textContent).toContain('10/03/2024 06:30')
    expect(required(document, '.discussion-history small').textContent).toBe('10/03/2024 07:30 · Account #7')

    await present({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'America/New_York' })
    expect(discussionLabels(discussion).slice(0, 3)).toEqual(['10/03/2024 01:30 · #1', '10/03/2024 03:30 · #2', '09/03/2024 19:30 · #3'])
    await present({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: '' })
    expect(discussionLabels(discussion).slice(0, 3)).toEqual(['10/03/2024 06:30 · #1', '10/03/2024 07:30 · #2', '10/03/2024 00:30 · #3'])
    expect(publicationLabels()).toEqual(['Window: 10/03/2024 06:30 → 10/03/2024 07:30', 'Window: 10/03/2024 00:30 → No boundary'])
    expect(credentialLabels(credentials)).toEqual(['10/03/2024', '10/03/2024', '10/03/2024', 'Unknown'])

    // An unavailable account with no saved formats uses locale/browser defaults.
    wikiStore.authRefreshOutcome = 'unavailable'
    await present({ dateFormat: '', timeFormat: 'locale', timezone: '' })
    expect(discussionLabels(discussion)).toEqual(['03/10/2024 6:30 AM · #1', '03/10/2024 7:30 AM · #2', '03/10/2024 12:30 AM · #3', 'Date unavailable · #4', 'Date unavailable · #5'])
    expect(publicationLabels()).toEqual(['Window: 03/10/2024 6:30 AM → 03/10/2024 7:30 AM', 'Window: 03/10/2024 12:30 AM → No boundary'])
    expect(credentialLabels(credentials)).toEqual(['03/10/2024', '03/10/2024', '03/10/2024', 'Unknown'])
  })


  test('keeps actual schedule inputs in browser time and sends canonical ISO despite changing account labels', async () => {
    await present({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', timezone: 'America/New_York' })
    const savedPage = page(1)
    serve([savedPage])
    await mount(Publication, { modelValue: true, selected: [{ ...savedPage, tags: [] }] })
    const form = await mount(Schedule, { page: savedPage, now: Date.parse('2024-03-09T00:00:00.000Z') })
    const start = required<HTMLInputElement>(form, 'input[type="datetime-local"]')
    const end = [...form.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')][1]
    if (!end) throw new Error('Missing publication end input')
    expect([start.type, start.value, end.type, end.value]).toEqual(['datetime-local', '2024-03-10T06:30', 'datetime-local', '2024-03-10T07:30'])
    expect(publicationLabels()).toEqual(['Window: 2024-03-10 1:30 AM → 2024-03-10 3:30 AM'])

    await present({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'UTC' })
    expect(publicationLabels()).toEqual(['Window: 10/03/2024 06:30 → 10/03/2024 07:30'])
    expect([start.value, end.value]).toEqual(['2024-03-10T06:30', '2024-03-10T07:30'])
    required<HTMLInputElement>(form, 'input[type="checkbox"]').click()
    await Vue.nextTick()
    click(form, 'Save publication')
    await settle()
    expect(requests.map(request => ({ url: request.url, method: request.init.method, payload: JSON.parse(String(request.init.body)) }))).toEqual([{
      url: '/_api/pages/1/publication', method: 'PATCH',
      payload: { isPublished: false, publishStartDate: beforeDst, publishEndDate: afterDst, expectedSourceRevision: '17' }
    }])

    start.value = '2024-03-10T06:45'
    start.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await Vue.nextTick()
    await present({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', timezone: 'America/New_York' })
    expect([start.value, end.value]).toEqual(['2024-03-10T06:45', '2024-03-10T07:30'])
    expect(publicationLabels()).toEqual(['Window: 2024-03-10 1:30 AM → 2024-03-10 3:30 AM'])
    click(form, 'Save publication')
    await settle()
    expect(requests.map(request => ({ url: request.url, method: request.init.method, payload: JSON.parse(String(request.init.body)) }))).toEqual([
      { url: '/_api/pages/1/publication', method: 'PATCH', payload: { isPublished: false, publishStartDate: beforeDst, publishEndDate: afterDst, expectedSourceRevision: '17' } },
      { url: '/_api/pages/1/publication', method: 'PATCH', payload: { isPublished: false, publishStartDate: '2024-03-10T06:45:00.000Z', publishEndDate: afterDst, expectedSourceRevision: '17' } }
    ])
  })
})

import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { pageHref } from '../../helpers/admin-pages.ts'
import type { RenderFunction } from 'vue'
import type { PageApprovalInboxItem, PageWatchNotification } from '../../../shared/site-notifications.ts'

const componentPath = path.join(process.cwd(), 'client/components/common/account-notifications.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
const descriptor = parsed.descriptor
if (parsed.errors.length > 0 || !descriptor.template || !descriptor.scriptSetup) {
  throw new Error(`Could not parse account-notifications.vue: ${parsed.errors.join(', ')}`)
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://wiki.test/en/home'
})
const browserWindow = dom.window
for (const [name, value] of Object.entries({
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  MouseEvent: browserWindow.MouseEvent,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  window: browserWindow
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}

// Vue is loaded after JSDOM so runtime-dom captures the test document.
const Vue = await import('vue')
const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'account-notifications-interaction-test',
  preprocessLang: descriptor.template.lang,
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw new Error(`Could not compile account-notifications.vue: ${compiledTemplate.errors.join(', ')}`)
const renderNotifications = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction
const translations: Record<string, string> = {
  'common:accountNotifications.title': 'Localized notifications',
  'common:accountNotifications.pageChanges': 'Localized page changes',
  'common:accountNotifications.recentPageChanges': 'Localized recent page changes',
  'common:accountNotifications.loadingPageChanges': 'Loading recent page changes…',
  'common:accountNotifications.checkingPageChanges': 'Page changes are still being checked.',
  'common:accountNotifications.noRecentPageChanges': 'No recent page changes.',
  'common:accountNotifications.morePageChangesMayBeAvailable': 'No page changes in this window yet. More changes may be available.',
  'common:accountNotifications.checkMorePageChanges': 'Check more page changes',
  'common:accountNotifications.loadMorePageChanges': 'Load more page changes',
  'common:accountNotifications.refreshPageChanges': 'Refresh page changes',
  'common:accountNotifications.unread': 'Unread',
  'common:accountNotifications.approvals': 'Approvals',
  'common:accountNotifications.loadingApprovals': 'Loading approvals…',
  'common:accountNotifications.approvalStatusUnknown': 'Approval status is not yet known.',
  'common:accountNotifications.noActiveApprovals': 'No active approvals.',
  'common:accountNotifications.moreApprovalsMayBeAvailable': 'No approvals in this page yet. Check more to continue.',
  'common:accountNotifications.checkMoreApprovals': 'Check more approvals',
  'common:accountNotifications.loadMoreApprovals': 'Load more approvals',
  'common:accountNotifications.refreshApprovals': 'Refresh approvals',
  'common:accountNotifications.someone': 'Someone',
  'common:accountNotifications.recently': 'Recently',
  'common:accountNotifications.watchAriaLabel': '{{action}} — {{title}}',
  'common:accountNotifications.unreadWatchAriaLabel': '{{action}} — {{title}} ({{unread}})',
  'common:page.watchEventUpdated': '{{actor}} localized updated this page',
  'common:page.watchEventRestored': '{{actor}} localized restored this page',
  'common:page.watchEventMoved': '{{actor}} localized moved this page',
  'common:page.watchEventDeleted': '{{actor}} localized deleted this page',
  'common:page.watchEventVisibilityChanged': '{{actor}} localized changed visibility for this page',
  'common:page.watchEventOwnershipTransferred': '{{actor}} localized transferred ownership of this page',
  'common:page.watchEventChanged': '{{actor}} localized changed this page',
  'common:page.approvalStatus.submitted': 'Submitted',
  'common:page.approvalStatus.approved': 'Approved',
  'common:page.approvalStatus.changes-requested': 'Changes Requested',
  'common:page.approvalStatus.rejected': 'Rejected',
  'common:page.approvalStatus.cancelled': 'Cancelled',
  'common:page.approvalStatus.published': 'Published',
  'common:page.submittedRevisionStale': 'Submitted revision is stale',
  'common:page.tryAgain': 'Try again',
  'common:actions.refresh': 'Refresh'
}
const translate = (key: string, options: Record<string, unknown> = {}): string => {
  const value = translations[key] ?? key
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
}

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const evaluateNotifications = new Function(
  'useSiteNotificationsStore',
  'pageHref',
  'navigateToWikiPage',
  `${executableScript}
return { store, notificationIdentityReady, retryWatches, watchErrorAction, loadMoreWatches, retryApprovals, loadMoreApprovals, pageUrl, isUnread, watchAction, watchSummary, watchAriaLabel, approvalSummary, isOrdinaryActivation, openWatchPage, openApprovalPage }`
) as (useStore: () => NotificationStore, href: typeof pageHref, navigate: (value: string) => void) => Record<string, unknown>

type NotificationStore = {
  ownerId: number | null
  watches: PageWatchNotification[]
  watchesNextCursor: string | null
  watchesUnreadComplete: boolean
  approvals: PageApprovalInboxItem[]
  watchesLoading: boolean
  approvalsLoading: boolean
  watchesError: string
  approvalsError: string
  identityStale: boolean
  approvalsNextCursor: string | null
  refreshWatches: () => Promise<void>
  loadMoreWatches: () => Promise<void>
  refreshApprovals: () => Promise<void>
  loadMoreApprovals: () => Promise<void>
  markWatchRead: (id: string) => Promise<boolean>
}

type StoreOverrides = Partial<NotificationStore>

const makeWatch = (overrides: Partial<PageWatchNotification> = {}): PageWatchNotification => ({
  id: 'watch-1',
  pageId: 12,
  eventType: 'page.updated',
  actorName: 'Editor',
  title: 'Docs',
  path: 'docs/start',
  localeCode: 'en',
  visibility: 'public',
  createdAt: '2026-09-11T10:00:00.000Z',
  readAt: null,
  ...overrides
})

const makeApproval = (overrides: Partial<PageApprovalInboxItem> = {}): PageApprovalInboxItem => ({
  id: 'approval-1',
  pageId: 12,
  submitterId: 17,
  assigneeId: 7,
  status: 'submitted',
  revisionId: 4,
  revisionUpdatedAt: '2026-09-11T10:00:00.000Z',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
  closedAt: null,
  stale: false,
  canReview: true,
  title: 'Release notes',
  path: 'docs/release-notes',
  localeCode: 'en',
  visibility: 'public',
  ...overrides
})

const makeStore = (overrides: StoreOverrides = {}): NotificationStore =>
  Vue.reactive({
    ownerId: 7,
    watches: [],
    watchesNextCursor: null,
    watchesUnreadComplete: false,
    approvals: [],
    watchesLoading: false,
    approvalsLoading: false,
    watchesError: '',
    approvalsError: '',
    identityStale: false,
    approvalsNextCursor: null,
    refreshWatches: vi.fn(async () => {}),
    loadMoreWatches: vi.fn(async () => {}),
    refreshApprovals: vi.fn(async () => {}),
    loadMoreApprovals: vi.fn(async () => {}),
    markWatchRead: vi.fn(async () => true),
    ...overrides
  }) as unknown as NotificationStore

const passthrough = (tag: string, options: Record<string, unknown> = {}) =>
  Vue.defineComponent({
    inheritAttrs: false,
    ...options,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

const VList = passthrough('ul')
const VDivider = passthrough('hr')
const VListItemTitle = passthrough('div')
const VListItemSubtitle = passthrough('div')
const VListItem = Vue.defineComponent({
  inheritAttrs: false,
  props: { href: { type: String, default: '' } },
  setup(props, { attrs, slots }) {
    return () =>
      Vue.h('a', { ...attrs, href: props.href }, [
        slots.prepend?.({}),
        Vue.h('span', { class: 'notification-item-content' }, slots.default?.({})),
        slots.append?.({})
      ])
  }
})
const VBtn = Vue.defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean },
  setup(props, { attrs, slots }) {
    return () => Vue.h('button', { ...attrs, type: 'button', disabled: props.disabled }, slots.default?.())
  }
})

let mountedApp: ReturnType<typeof Vue.createApp> | null = null

afterEach(() => {
  mountedApp?.unmount()
  mountedApp = null
  dom.window.document.body.replaceChildren()
  vi.clearAllMocks()
})

const mountNotifications = (store: NotificationStore, navigate = vi.fn()) => {
  const bindings = evaluateNotifications(() => store, pageHref, navigate)
  const component = Vue.defineComponent({
    setup: () => bindings,
    render: renderNotifications
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.append(host)
  mountedApp = Vue.createApp(component)
  mountedApp.component('v-list', VList)
  mountedApp.component('v-list-item', VListItem)
  mountedApp.component('v-list-item-title', VListItemTitle)
  mountedApp.component('v-list-item-subtitle', VListItemSubtitle)
  mountedApp.component('v-btn', VBtn)
  mountedApp.component('v-divider', VDivider)
  mountedApp.config.globalProperties.$t = translate
  mountedApp.mount(host)
  return { host, navigate }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('account notifications interaction', () => {
  it('renders the hierarchy, event meaning, actor/date secondary, and unread state', () => {
    const store = makeStore({
      watches: [makeWatch({ eventType: 'page.moved' })],
      approvals: [makeApproval()]
    })
    const { host } = mountNotifications(store)

    expect(host.querySelector('h2')?.textContent).toBe('Localized notifications')
    expect([...host.querySelectorAll('h3')].map(node => node.textContent)).toEqual(['Localized page changes', 'Approvals'])
    expect(host.textContent).toContain('Localized recent page changes')
    expect(host.textContent).toContain('Editor localized moved this page · Docs')
    expect(host.textContent).toContain('Editor')
    expect(host.textContent).toContain('Unread')
    expect(host.querySelector('.account-notifications__unread-marker')).not.toBeNull()
    expect(host.querySelector('a')?.getAttribute('aria-label')).toBe('Editor localized moved this page — Docs (Unread)')
    expect(host.querySelector('.account-notifications__scroll')).toBeNull()
  })

  it('marks an ordinary unread watch once, keeps failure feedback, and navigates for the same owner', async () => {
    const read = deferred<boolean>()
    const item = makeWatch()
    const store = makeStore({ watches: [item], markWatchRead: vi.fn(() => read.promise) })
    const { host, navigate } = mountNotifications(store)
    const anchor = host.querySelector('a')!
    const event = new browserWindow.MouseEvent('click', { bubbles: true, button: 0, cancelable: true })

    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(store.markWatchRead).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()

    store.watchesError = 'Read failed. The notification remains unread.'
    read.resolve(false)
    await settle()

    expect(navigate).toHaveBeenCalledWith(pageHref({ visibility: item.visibility, locale: item.localeCode, path: item.path }))
    expect(item.readAt).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Read failed')
    expect(host.textContent).toContain('Unread')
  })

  it('does not navigate after an unread read completes for a stale owner', async () => {
    const read = deferred<boolean>()
    const item = makeWatch()
    const store = makeStore({ watches: [item], markWatchRead: vi.fn(() => read.promise) })
    const { host, navigate } = mountNotifications(store)

    host.querySelector('a')!.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true, button: 0 }))
    store.ownerId = 8
    read.resolve(true)
    await settle()

    expect(store.markWatchRead).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('keeps modified watch clicks native and separates approval navigation from read marking', () => {
    const store = makeStore({ watches: [makeWatch()], approvals: [makeApproval()] })
    const { host, navigate } = mountNotifications(store)
    const links = [...host.querySelectorAll('a')]
    const watchLink = links.find(link => link.getAttribute('href')?.includes('docs/start'))!
    const approvalLink = links.find(link => link.getAttribute('href')?.includes('docs/release-notes'))!
    const modifiedEvent = new browserWindow.MouseEvent('click', { bubbles: true, button: 0, metaKey: true })

    watchLink.dispatchEvent(modifiedEvent)
    expect(modifiedEvent.defaultPrevented).toBe(false)
    expect(store.markWatchRead).not.toHaveBeenCalled()

    approvalLink.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true, button: 0 }))
    expect(store.markWatchRead).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith(pageHref({ visibility: makeApproval().visibility, locale: makeApproval().localeCode, path: makeApproval().path }))
  })

  it('shows watch continuation controls and truthful empty partial coverage', async () => {
    const loadMoreWatches = vi.fn(async () => {})
    const store = makeStore({
      watches: [makeWatch()],
      watchesNextCursor: 'cursor-1',
      watchesUnreadComplete: true,
      loadMoreWatches
    })
    const { host } = mountNotifications(store)

    expect(host.textContent).toContain('Load more page changes')
    const loadButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Load more page changes'))!
    expect(loadButton.getAttribute('aria-label')).toBe('Load more page changes')
    loadButton.click()
    expect(loadMoreWatches).toHaveBeenCalledTimes(1)

    store.watches = []
    await Vue.nextTick()

    expect(host.textContent).toContain('No page changes in this window yet. More changes may be available.')
    expect(host.textContent).not.toContain('No recent page changes.')
    const checkButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Check more page changes'))!
    expect(checkButton.getAttribute('aria-label')).toBe('Check more page changes')
    checkButton.click()
    expect(loadMoreWatches).toHaveBeenCalledTimes(2)
  })

  it('retains watch items and exposes refresh after cursor expiry or capacity errors', async () => {
    const refreshWatches = vi.fn(async () => {})
    const store = makeStore({
      watches: [makeWatch()],
      watchesNextCursor: 'cursor-1',
      watchesUnreadComplete: false,
      watchesError: 'Page watch notification cursor expired',
      refreshWatches
    })
    const { host } = mountNotifications(store)

    expect(host.textContent).toContain('Docs')
    expect(host.textContent).toContain('Refresh page changes')
    const refreshButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Refresh page changes'))!
    refreshButton.click()
    expect(refreshWatches).toHaveBeenCalledTimes(1)

    store.watchesError = 'Page watch notification cursor capacity exhausted'
    await Vue.nextTick()
    expect(host.textContent).toContain('Docs')
    expect(host.textContent).toContain('Refresh page changes')
  })

  it('navigates a read watch directly without marking it read', () => {
    const item = makeWatch({ readAt: '2026-09-11T10:01:00.000Z' })
    const store = makeStore({ watches: [item] })
    const { host, navigate } = mountNotifications(store)

    const event = new browserWindow.MouseEvent('click', { bubbles: true, button: 0, cancelable: true })
    host.querySelector('a')!.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(store.markWatchRead).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith(pageHref({ visibility: item.visibility, locale: item.localeCode, path: item.path }))
  })

  it('exposes explicit continuation, refresh, and unknown approval states without false empty messaging', async () => {
    const loadMoreApprovals = vi.fn(async () => {})
    const refreshApprovals = vi.fn(async () => {})
    const store = makeStore({ approvalsNextCursor: 'cursor-1', loadMoreApprovals, refreshApprovals })
    const { host } = mountNotifications(store)

    expect(host.textContent).toContain('Check more approvals')
    expect(host.textContent).not.toContain('No active approvals')
    host.querySelector('button')!.click()
    expect(loadMoreApprovals).toHaveBeenCalledTimes(1)

    store.approvals = [makeApproval()]
    store.approvalsError = 'Approval cursor expired'
    await Vue.nextTick()
    expect(host.textContent).toContain('Refresh approvals')
    expect(host.textContent).toContain('Release notes')
    const refreshButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Refresh approvals'))!
    refreshButton.click()
    expect(refreshApprovals).toHaveBeenCalledTimes(1)

    store.ownerId = null
    store.approvals = []
    store.approvalsError = ''
    store.approvalsNextCursor = null
    await Vue.nextTick()
    expect(host.textContent).toContain('Approval status is not yet known.')
    expect(host.textContent).not.toContain('No active approvals')
  })

  it('loads and reveals a populated approval continuation', async () => {
    const first = makeApproval()
    const second = makeApproval({ id: 'approval-2', title: 'Appendix' })
    const loadMoreApprovals = vi.fn(async () => {})
    const store = makeStore({
      approvals: [first],
      approvalsNextCursor: 'cursor-2',
      loadMoreApprovals
    })
    loadMoreApprovals.mockImplementation(async () => {
      store.approvals = [first, second]
      store.approvalsNextCursor = null
    })
    const { host } = mountNotifications(store)

    const loadButton = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Load more approvals'))
    expect(loadButton?.getAttribute('aria-label')).toBe('Load more approvals')
    loadButton?.click()
    await settle()

    expect(loadMoreApprovals).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Appendix')
    expect(host.querySelectorAll('a')).toHaveLength(2)
  })
})

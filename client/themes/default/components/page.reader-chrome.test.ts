import fs from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { manualReviewerId } from '../../../helpers/approval-reviewer-search.ts'
import { brandingDuplicatesSiteLogo } from '../../../helpers/page-branding.ts'
import { UTILITY_TOOLTIP_GAP, UTILITY_TOOLTIP_MAX_WIDTH } from '../../../helpers/utility-tooltip-placement.ts'
import { buildOutlineTree, filterOutlineTree, getInitialExpandedAnchors } from '../../../helpers/page-outline.ts'
import { revealContentExtensionTarget } from '../../../helpers/content-extension-runtime.ts'
import { browserWindow, document as browserDocument, resetBody } from '../../../test/browser-dom.mts'
import { keyTranslator, renderTemplate } from '../../../test/render-template.mts'

// Reader chrome: rail utilities, outline heading, state indicators and the
// one-edit-control rule. Template checks render page.vue's Pug with stubs;
// rule checks run the real computed/methods against a plain view model.

const PAGE = 'client/themes/default/components/page.vue'

const baseState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  $t: keyTranslator,
  $slots: {},
  $vuetify: { locale: { isRtl: false }, display: { smAndDown: false, mdAndUp: true, width: 1440 }, theme: { current: { dark: false } } },
  mergeProps: Vue.mergeProps,
  utilityTooltipProps: (key: string) => ({ id: `page-tool-tip-${key}` }),
  printView: false,
  navMode: 'NONE',
  readerFocus: false,
  readerSectionsOpen: false,
  readerHasSections: false,
  readerSectionsAvailable: false,
  readerSectionIndex: -1,
  readerSection: null,
  talkActive: false,
  linksActive: false,
  tocPosition: 'left',
  editShortcutsObj: { editMenuBar: true, editMenuBtn: true, editFab: true },
  title: 'Field guide',
  locale: 'en',
  path: 'home',
  breadcrumbs: [],
  tags: [],
  tocFlattened: [],
  tocTreeVisible: [],
  isTocCompact: false,
  isTocMobile: false,
  winWidth: 1440,
  pageToolsHost: '#page-desktop-rail',
  pageOutlineHost: '#page-desktop-rail',
  tocDisclosureExpanded: true,
  isPublished: true,
  visibility: 'public',
  updatedAt: '2026-01-02T03:04:05.000Z',
  formattedUpdatedAt: 'Today at 3:04 AM',
  accessibleUpdatedAt: 'Friday, January 2, 2026 3:04 AM',
  authorAttribution: { before: 'by ', after: '' },
  authorName: 'Ada',
  hasAuthor: true,
  canViewHistory: true,
  pageHistoryUrl: '/h/en/home',
  isAuthenticated: true,
  pageWatched: false,
  pageWatchBlockedReason: '',
  pageProtection: { protected: false },
  pageProtectionBlockedReason: '',
  pageOnlineActionReady: true,
  pageOnlineActionUnavailableReason: '',
  hasWritePagesPermission: true,
  showEditFab: false,
  showHeaderEditButton: true,
  commentsEnabled: false,
  commentsPerms: { read: false, write: false },
  linksVisible: false,
  showPageViewTabs: false,
  selectedPageView: 'article',
  pageBranding: null,
  pageApproval: null,
  offlineControl: {
    state: 'off',
    tone: 'neutral',
    icon: 'mdi-cloud-download-outline',
    action: 'save',
    blocked: false,
    label: 'Save offline',
    title: 'Save offline',
    detail: 'Keep a copy on this device.',
    pressed: false
  },
  offlineActionLoading: false,
  offlineStatusId: 'offline-status',
  offlineStatusLabel: 'Save offline. Keep a copy on this device.',
  approvalStatusLabel: (status: string) => status,
  tagColor: () => 'neutral',
  readingProgress: 0,
  ...overrides
})

const countText = (html: string, needle: string): number => html.split(needle).length - 1

describe('page reader chrome template', () => {
  it('provides one named outline and an empty state when the document has no sections', async () => {
    const { document } = await renderTemplate(PAGE, baseState())
    const outlines = document.querySelectorAll('[aria-label="common:page.onThisPage"]')
    expect(outlines).toHaveLength(1)
    expect(outlines[0]!.textContent).toContain('common:page.noSections')
    expect(outlines[0]!.querySelector('[data-stub="page-toc-tree"]')).toBeNull()
  })

  it('exposes a mobile disclosure whose controlled outline follows its expanded state', async () => {
    const wide = (await renderTemplate(PAGE, baseState())).document
    expect(wide.querySelectorAll('[aria-label="common:page.onThisPage"]')).toHaveLength(1)
    expect(wide.querySelector('[aria-label="common:page.onThisPage"] [aria-controls][aria-expanded]')).toBeNull()

    for (const expanded of [false, true]) {
      const { document } = await renderTemplate(PAGE, baseState({
        isTocCompact: true,
        isTocMobile: true,
        winWidth: 390,
        pageOutlineHost: '#page-mobile-tools',
        tocDisclosureExpanded: expanded
      }))
      const outlines = document.querySelectorAll('[aria-label="common:page.onThisPage"]')
      expect(outlines).toHaveLength(1)
      const toggle = outlines[0]!.querySelector('[aria-controls][aria-expanded]')!
      expect(toggle).not.toBeNull()
      expect(toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      const controlled = document.getElementById(toggle.getAttribute('aria-controls')!)!
      expect(controlled).not.toBeNull()
      expect(controlled.style.display === 'none').toBe(!expanded)
    }
  })

  it('keeps history in the utilities row and the date and author in their own metadata column', async () => {
    const { document } = await renderTemplate(PAGE, baseState())
    const history = document.querySelector('.page-tools-history-link')
    expect(history?.closest('.page-tools-card__utilities')).not.toBeNull()
    expect(history?.getAttribute('href')).toBe('/h/en/home')
    const provenance = document.querySelector('.page-tools-card__provenance')
    expect(provenance?.querySelector('[data-stub="v-btn"]')).toBeNull()
    expect(provenance?.querySelector('.page-document-row--date time')?.getAttribute('datetime')).toBe('2026-01-02T03:04:05.000Z')
    expect(provenance?.querySelector('.page-document-author')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('by Ada')
  })

  it('gives every utility tooltip its own id and the shared, measured placement anchored to the whole card', async () => {
    const placeUtilityTooltip = vi.fn()
    const vm = {
      utilityTooltipTarget: '#page-desktop-rail .page-tools-card',
      utilityTooltip: { location: 'top left', offset: [6, -40], measuring: true },
      placeUtilityTooltip
    }
    const props = page.methods.utilityTooltipProps!.call(vm, 'share') as Record<string, unknown>
    expect(props).toMatchObject({
      id: 'page-tool-tip-share',
      target: '#page-desktop-rail .page-tools-card',
      location: 'top left',
      offset: [6, -40],
      maxWidth: 320,
      contentClass: 'page-tool-tip page-tool-tip--measuring'
    })
    ;(props['onUpdate:modelValue'] as (open: boolean) => void)(true)
    expect(placeUtilityTooltip).toHaveBeenCalledWith(true, 'share')

    const { document } = await renderTemplate(
      PAGE,
      baseState({
        isAuthenticated: true,
        utilityTooltipProps: (key: string) => page.methods.utilityTooltipProps!.call(vm, key)
      })
    )
    const tooltips = Array.from(document.querySelectorAll('.page-tools-card__utilities [data-stub="v-tooltip"]'))
    expect(tooltips.length).toBeGreaterThan(2)
    const ids = tooltips.map(tooltip => tooltip.getAttribute('id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id?.startsWith('page-tool-tip-'))).toBe(true)
    expect(tooltips.map(tooltip => tooltip.getAttribute('target'))).toEqual(tooltips.map(() => '#page-desktop-rail .page-tools-card'))
  })

  it('renders an author placeholder in the middle of a translated sentence without moving the name', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ authorAttribution: { before: 'Zuletzt von ', after: ' bearbeitet' } }))
    const author = document.querySelector('.page-document-author')
    expect(author?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Zuletzt von Ada bearbeitet')
    expect(author?.querySelector('bdi')?.textContent).toBe('Ada')
  })

  it('keeps blocked utilities focusable and puts the reason in their tooltip', async () => {
    const { document } = await renderTemplate(
      PAGE,
      baseState({
        pageWatchBlockedReason: 'Watch reason',
        pageOnlineActionReady: false,
        pageOnlineActionUnavailableReason: 'Offline reason',
        pageProtectionBlockedReason: 'Offline reason'
      })
    )
    for (const selector of ['.page-watch-control', '.page-approval-control', '.page-protection-control']) {
      const control = document.querySelector(selector)
      expect(control?.getAttribute('aria-disabled')).toBe('true')
      expect(control?.hasAttribute('disabled')).toBe(false)
      expect(control?.hasAttribute('title')).toBe(false)
    }
    const reasons = [...document.querySelectorAll('.page-tool-blocked-reason')].map(node => node.textContent)
    expect(reasons).toEqual(['Watch reason', 'Offline reason', 'Offline reason'])
  })

  it('uses one bell: it starts watching, then opens the watch settings with Stop watching', async () => {
    const idle = (await renderTemplate(PAGE, baseState())).document
    expect(idle.querySelectorAll('.page-watch-control')).toHaveLength(1)
    expect(idle.querySelector('.page-watch-control')?.getAttribute('aria-pressed')).toBe('false')
    expect(idle.querySelector('.page-watch-stop')).toBeNull()

    const watching = (await renderTemplate(PAGE, baseState({ pageWatched: true }))).document
    expect(watching.querySelectorAll('.page-watch-control')).toHaveLength(1)
    expect(watching.querySelector('.page-watch-control')?.getAttribute('aria-label')).toBe('common:page.watchingPage')
    expect(watching.querySelector('.page-watch-settings .page-watch-stop')?.textContent).toContain('common:page.stopWatchingPage')
    expect(watching.body.innerHTML).not.toContain('mdi-tune')
  })

  it('shows one static unpublished indicator', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ isPublished: false }))
    const html = document.body.innerHTML
    const indicator = document.querySelectorAll('.page-header-unpublished')
    expect(indicator).toHaveLength(1)
    expect(indicator[0]!.textContent).toContain('common:page.unpublished')
    expect(countText(html, 'common:page.unpublishedWarning')).toBe(1)
    expect(html).not.toContain('status-indicator')
    expect(html).not.toContain('pulse')
  })

  it('marks the reading position bar as decorative', async () => {
    const { document } = await renderTemplate(PAGE, baseState())
    const bar = document.querySelector('.page-position')
    expect(bar?.getAttribute('aria-hidden')).toBe('true')
    expect(bar?.hasAttribute('role')).toBe(false)
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('names the discussion view "Discussion" everywhere and keeps the book icon for focus reading only', async () => {
    const { document } = await renderTemplate(
      PAGE,
      baseState({
        showPageViewTabs: true,
        commentsEnabled: true,
        commentsPerms: { read: true, write: true }
      })
    )
    // Includes the teleported rail.
    const html = document.body.innerHTML
    expect(document.querySelector('#page-view-talk-tab')?.textContent?.trim()).toBe('common:comments.title')
    expect(html).not.toMatch(/>\s*Talk\s*</)
    expect(html).not.toContain('common:comments.sdTitle')
    expect(document.querySelector('.page-document-label')?.textContent).not.toContain('mdi-book-open-page-variant-outline')
    expect(countText(html, 'mdi-book-open-page-variant-outline')).toBe(1)
    expect(document.querySelector('.page-focus-control')?.textContent).toContain('mdi-book-open-page-variant-outline')
  })

  it('skips a page branding mark that repeats the site logo', async () => {
    const branding = { assetId: 2, imageUrl: '/logo.png?v=1', sourceSha256: 'a'.repeat(64), width: 10, height: 10 }
    const shown = (await renderTemplate(PAGE, baseState({ pageBranding: branding, pageBrandingDuplicatesSiteLogo: false }))).document.body.innerHTML
    expect(shown).toContain('data-stub="page-branding-mark"')
    const hidden = (await renderTemplate(PAGE, baseState({ pageBranding: branding, pageBrandingDuplicatesSiteLogo: true }))).document.body.innerHTML
    expect(hidden).not.toContain('data-stub="page-branding-mark"')
  })

  it('gives the all-tags chip a visible tooltip', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ tags: [{ tag: 'alpha', title: 'Alpha' }] }))
    const tooltip = document.querySelector('.page-tags-all')?.closest('[data-stub="v-tooltip"]')
    expect(tooltip?.textContent).toContain('common:page.tagsMatching')
  })
})

// ---- Script rules -------------------------------------------------------

const source = fs.readFileSync(path.join(process.cwd(), PAGE), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('page.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, '').replace('export default defineComponent({', 'const pageComponent = defineComponent({') +
    '\nreturn pageComponent'
)
const wikiStore = {
  user: { authenticated: true, id: 7, permissions: [] as string[] },
  site: { logoUrl: '/_site-logo/abc/logo.png' },
  authRefreshOutcome: 'authenticated' as string | null
}
type Rules = {
  computed: Record<string, (this: Record<string, unknown>) => unknown>
  methods: Record<string, (this: Record<string, unknown>, ...args: unknown[]) => unknown>
  watch: {
    readerSectionsAvailable: (this: Record<string, unknown>, available: boolean) => void
    tocFlattened: { handler: (this: Record<string, unknown>, entries: Array<{ anchor: string; title: string; depth: number }>) => void }
  }
}
const stubComponent = {}
const page = new Function(
  'defineComponent',
  'h',
  'markRaw',
  'mergeProps',
  'useGoTo',
  'i18next',
  'AsyncState',
  'PageBrandingMark',
  'SiteBanner',
  'NavSidebar',
  'wikiStore',
  'manualReviewerId',
  'brandingDuplicatesSiteLogo',
  'Prism',
  'ClipboardJS',
  'UTILITY_TOOLTIP_GAP',
  'UTILITY_TOOLTIP_MAX_WIDTH',
  'buildOutlineTree',
  'filterOutlineTree',
  'getInitialExpandedAnchors',
  'revealContentExtensionTarget',
  executableScript
)(
  (options: unknown) => options,
  () => ({}),
  <Value>(value: Value) => value,
  Vue.mergeProps,
  () => () => {},
  { t: (key: string) => key },
  stubComponent,
  stubComponent,
  stubComponent,
  stubComponent,
  wikiStore,
  manualReviewerId,
  brandingDuplicatesSiteLogo,
  { plugins: { toolbar: { registerButton: () => {} } } },
  class ClipboardJS {},
  UTILITY_TOOLTIP_GAP,
  UTILITY_TOOLTIP_MAX_WIDTH,
  buildOutlineTree,
  filterOutlineTree,
  getInitialExpandedAnchors,
  revealContentExtensionTarget
) as Rules

const call = (name: string, vm: Record<string, unknown>) => page.computed[name]!.call(vm)

describe('page reader chrome rules', () => {
  const display = (smAndDown: boolean) => ({ $vuetify: { display: { smAndDown } } })

  it('opens and closes navigation in Links and Discussion while keeping focused Article navigation suppressed', () => {
    const navigation = page.computed.navigationOpen as unknown as {
      get: (this: Record<string, unknown>) => boolean
      set: (this: Record<string, unknown>, value: boolean) => void
    }
    const vm = { readerFocus: true, talkActive: false, linksActive: false, navShown: false }
    navigation.set.call(vm, true)
    expect(vm.navShown).toBe(false)
    vm.navShown = true
    expect(navigation.get.call(vm)).toBe(false)
    for (const view of ['linksActive', 'talkActive'] as const) {
      vm[view] = true
      expect(navigation.get.call(vm)).toBe(true)
      navigation.set.call(vm, false)
      expect(navigation.get.call(vm)).toBe(false)
      navigation.set.call(vm, true)
      expect(navigation.get.call(vm)).toBe(true)
      vm[view] = false
      expect(navigation.get.call(vm)).toBe(false)
    }
    expect(vm.readerFocus).toBe(true)
  })

  it('shows one edit control on small screens', () => {
    const shortcuts = (editFab: boolean) => ({ editMenuBar: true, editMenuBtn: true, editFab })
    const cases = [
      { smAndDown: true, editFab: true, write: true, fab: true, header: false },
      { smAndDown: true, editFab: false, write: true, fab: false, header: true },
      { smAndDown: false, editFab: true, write: true, fab: false, header: false },
      { smAndDown: true, editFab: true, write: false, fab: true, header: true }
    ]
    for (const entry of cases) {
      const vm: Record<string, unknown> = {
        ...display(entry.smAndDown),
        editShortcutsObj: shortcuts(entry.editFab),
        hasWritePagesPermission: entry.write,
        hasAnyPagePermissions: true
      }
      vm.showEditFab = call('showEditFab', vm)
      expect({ fab: vm.showEditFab, header: call('showHeaderEditButton', vm) }).toEqual({ fab: entry.fab, header: entry.header })
    }
  })

  it('splits the author sentence around the name wherever the locale places it', () => {
    const translate = (template: string) => (key: string, options?: { author: string }) =>
      key === 'common:page.author' ? 'AUTHOR_MARKER' : template.replace('{{author}}', options?.author ?? '')
    expect(call('authorAttribution', { $t: translate('by {{author}}') })).toEqual({ before: 'by ', after: '' })
    expect(call('authorAttribution', { $t: translate('{{author}} が編集') })).toEqual({ before: '', after: ' が編集' })
  })

  it('explains why watching is blocked and stays quiet while it loads', () => {
    const vm = { $t: (key: string) => key, pageOnlineActionUnavailableReason: 'offline' }
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: false, pageWatchAuthorityReady: true, pageWatchLoading: false })).toBe('offline')
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: true, pageWatchAuthorityReady: false, pageWatchLoading: false })).toBe(
      'common:page.watchStateStale'
    )
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: true, pageWatchAuthorityReady: false, pageWatchLoading: true })).toBe('')
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: true, pageWatchAuthorityReady: true, pageWatchLoading: false })).toBe('')
  })

  it('reloads a stale watch state instead of toggling it', async () => {
    const loadPageWatchState = vi.fn(async () => true)
    const vm: Record<string, unknown> = { pageWatchLoading: false, pageOnlineActionReady: true, pageWatchAuthorityReady: false, loadPageWatchState }
    await page.methods.togglePageWatch!.call(vm)
    expect(loadPageWatchState).toHaveBeenCalledTimes(1)
  })

  it('refuses to open the approval workflow while page actions are unavailable', () => {
    const loadPageApproval = vi.fn(async () => true)
    const vm: Record<string, unknown> = { pageOnlineActionReady: false, approvalDialog: false, loadPageApproval }
    page.methods.openApprovalWorkflow!.call(vm)
    expect(vm.approvalDialog).toBe(false)
    expect(loadPageApproval).not.toHaveBeenCalled()
  })

  it('offers a typed user ID and keeps the selected reviewer labelled', () => {
    const vm: Record<string, unknown> = {
      approvalReviewerOptions: [{ id: 5, label: 'Grace (@grace)', source: 'discussion' }],
      approvalReviewerQuery: '#12',
      approvalAssigneeId: 9,
      approvalActorLabel: (id: number) => `User #${id}`
    }
    expect(call('approvalReviewerItems', vm)).toEqual([
      { id: 12, label: 'User #12', source: 'manual' },
      { id: 5, label: 'Grace (@grace)', source: 'discussion' },
      { id: 9, label: 'User #9', source: 'manual' }
    ])
  })


  it('names the browser time zone on Updated only when the account could not load and no zone is saved', () => {
    const vmFor = (known: boolean) => {
      const vm: Record<string, unknown> = {
        updatedAt: '2026-01-02T03:04:05.000Z',
        $t: (_key: string, options: { time: string; zone: string }) => `${options.time} (${options.zone})`,
        $helpers: { formatMoment: () => 'Today at 3:04 AM', timeZoneKnown: () => known, timeZoneLabel: () => 'UTC' }
      }
      vm.withUpdatedZone = (time: string) => page.methods.withUpdatedZone!.call(vm, time)
      return vm
    }
    try {
      for (const [outcome, known, expected] of [
        ['unavailable', false, 'Today at 3:04 AM (UTC)'],
        ['unavailable', true, 'Today at 3:04 AM'],
        ['authenticated', false, 'Today at 3:04 AM'],
        ['anonymous', false, 'Today at 3:04 AM'],
        [null, false, 'Today at 3:04 AM']
      ] as const) {
        wikiStore.authRefreshOutcome = outcome
        const vm = vmFor(known)
        vm.labelUpdatedZone = call('labelUpdatedZone', vm)
        expect(call('formattedUpdatedAt', vm)).toBe(expected)
      }
    } finally {
      wikiStore.authRefreshOutcome = 'authenticated'
    }
  })

  it('labels the signed-in reviewer as You in the approval history', () => {
    const vm = { $t: keyTranslator }
    expect(page.methods.approvalActorLabel!.call(vm, 7)).toBe('common:page.reviewerYou')
    expect(page.methods.approvalActorLabel!.call(vm, 7, 'Ada Lovelace')).toBe('common:page.reviewerYou')
    expect(page.methods.approvalActorLabel!.call(vm, 3)).toBe('common:page.reviewerById(id=3)')
  })

  it('names other approval actors from the API and falls back to the user ID', () => {
    const transitions = [
      { id: 'a', fromStatus: null, toStatus: 'submitted', actorId: 3, actorName: '  Grace Hopper ', comment: null, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', fromStatus: 'submitted', toStatus: 'changes-requested', actorId: 4, actorName: null, comment: 'x', createdAt: '2026-01-02T00:00:00Z' }
    ]
    const vm: Record<string, unknown> = { $t: keyTranslator, pageApproval: { transitions } }
    vm.approvalActorNames = call('approvalActorNames', vm)
    const label = (id: number, name?: unknown) => page.methods.approvalActorLabel!.call(vm, id, name)
    expect(label(3, 'Grace Hopper')).toBe('Grace Hopper')
    expect(label(4, null)).toBe('common:page.reviewerById(id=4)')
    expect(label(5, '   ')).toBe('common:page.reviewerById(id=5)')
    // A selected reviewer without a name argument reuses the name from the history.
    expect(label(3)).toBe('Grace Hopper')
  })
})

describe('responsive navigation focus', () => {
  beforeEach(() => resetBody())
  afterEach(() => resetBody())

  it('focuses temporary navigation without stealing content focus when the permanent drawer appears', async () => {
    browserDocument.body.innerHTML = '<input id="search"><nav id="page-navigation-drawer"><div class="nav-sidebar"><button>Home</button></div></nav>'
    const search = browserDocument.querySelector<HTMLInputElement>('#search')!
    const home = browserDocument.querySelector<HTMLButtonElement>('.nav-sidebar button')!
    for (const width of [1279, 1280]) {
      search.focus()
      page.methods.navigationVisibilityChanged!.call(
        {
          readerFocus: false,
          $vuetify: { display: { width } },
          $nextTick: Vue.nextTick
        },
        true
      )
      await Vue.nextTick()
      expect(browserDocument.activeElement).toBe(width < 1280 ? home : search)
    }
  })
})

describe('focus reading section navigation', () => {
  const sections = [
    { anchor: '#opening', title: 'Opening', depth: 0 },
    { anchor: '#hidden%20chapter', title: 'Hidden chapter', depth: 1 },
    { anchor: '#conclusion', title: 'Conclusion', depth: 0 }
  ]

  const reader = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const vm = baseState({
      readerFocus: true,
      tocFlattened: sections,
      activeAnchor: '#opening',
      tocQuery: '',
      expandedAnchors: new Set<string>(),
      collapsedByUser: new Set<string>(),
      searchOverrides: new Map<string, boolean>(),
      $nextTick: Vue.nextTick,
      setupTocResizeObserver: () => {},
      ensureActiveTocVisible: () => {},
      ...overrides
    })
    for (const name of ['pageOutlineHost', 'readerHasSections', 'readerSectionsAvailable', 'readerSectionIndex', 'readerSection', 'tocTree', 'tocTreeVisible']) {
      Object.defineProperty(vm, name, { configurable: true, get: () => call(name, vm) })
    }
    for (const name of [
      'closeReaderSections',
      'toggleReaderSections',
      'readerSectionsEscape',
      'moveReaderSection',
      'tocLinkClicked',
      'scrollToPageAnchor',
      'cancelScheduledScroll',
      'animatePageScroll',
      'toggleReaderFocus'
    ]) {
      vm[name] = (...args: unknown[]) => page.methods[name]!.call(vm, ...args)
    }
    return vm
  }

  beforeEach(() => {
    resetBody()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetBody()
  })

  it('names the current section without live announcements and disables only the document boundaries', async () => {
    const vm = reader({ title: 'Library guide', winWidth: 390, isTocMobile: true, isTocCompact: true })
    for (const [anchor, label, ordinal, previousDisabled, nextDisabled] of [
      ['#opening', 'Opening', 1, true, false],
      ['#hidden chapter', 'Hidden chapter', 2, false, false],
      ['#conclusion', 'Conclusion', 3, false, true]
    ] as const) {
      vm.activeAnchor = anchor
      const { document } = await renderTemplate(PAGE, vm)
      const dock = document.querySelector('.page-reading-dock')!
      expect(dock.querySelector('.page-reading-dock-title')?.textContent).toBe(label)
      expect(dock.querySelector('.page-reading-dock-position')?.textContent).toBe(`common:page.sectionPosition(current=${ordinal},total=3)`)
      expect(dock.querySelector('.page-reading-dock-document')?.textContent).toBe('Library guide')
      expect(dock.querySelector('.page-reading-previous')?.hasAttribute('disabled')).toBe(previousDisabled)
      expect(dock.querySelector('.page-reading-next')?.hasAttribute('disabled')).toBe(nextDisabled)
      expect(dock.querySelector('[aria-live]')).toBeNull()
    }

    vm.activeAnchor = ''
    expect(vm.readerSectionIndex).toBe(0)
    expect(vm.readerSection).toEqual(sections[0])
  })

  it('moves through unfiltered document order and leaves focus mode enabled', () => {
    const vm = reader({ tocQuery: 'Conclusion', readerSectionsOpen: true })
    expect((vm.tocTreeVisible as Array<{ title: string }>).map(section => section.title)).toEqual(['Conclusion'])
    const visited: string[] = []
    vm.scrollToPageAnchor = (anchor: string) => {
      visited.push(anchor)
      vm.activeAnchor = anchor
    }
    page.methods.moveReaderSection!.call(vm, -1)
    expect(visited).toEqual([])
    expect(vm.readerSectionsOpen).toBe(true)
    page.methods.moveReaderSection!.call(vm, 1)
    expect(vm.readerSectionsOpen).toBe(false)
    expect(vm.readerSectionIndex).toBe(1)
    page.methods.moveReaderSection!.call(vm, 1)
    page.methods.moveReaderSection!.call(vm, 1)
    page.methods.moveReaderSection!.call(vm, -1)
    expect(visited).toEqual(['#hidden%20chapter', '#conclusion', '#hidden%20chapter'])
    expect(vm.readerFocus).toBe(true)
    expect(vm.tocQuery).toBe('Conclusion')
  })

  it('keeps one searchable outline and the filter when closing the focus picker', async () => {
    const entries = Array.from({ length: 47 }, (_, index) => ({
      anchor: `#section-${index + 1}`,
      title: `Section ${index + 1}`,
      depth: 0
    }))
    const vm = reader({
      readerSectionsOpen: true,
      tocFlattened: entries,
      activeAnchor: '#section-23',
      tocQuery: 'Section 23',
      tocDisclosureExpanded: false,
      isTocMobile: true,
      isTocCompact: true,
      winWidth: 320,
      pageToolsHost: '#page-mobile-tools'
    })
    const open = await renderTemplate(PAGE, vm)
    const outlines = open.document.querySelectorAll('[aria-label="common:page.onThisPage"]')
    expect(outlines).toHaveLength(1)
    expect(open.document.querySelectorAll('[data-stub="page-toc-tree"]')).toHaveLength(1)
    expect(outlines[0]!.querySelector('[label="common:page.findSection"]')).not.toBeNull()
    expect((vm.tocTreeVisible as Array<{ anchor: string }>).map(section => section.anchor)).toEqual(['#section-23'])
    const opener = open.document.querySelector('[aria-haspopup="dialog"][aria-expanded]')!
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    const dialog = open.document.getElementById(opener.getAttribute('aria-controls')!)!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.style.display).not.toBe('none')

    page.methods.closeReaderSections!.call(vm)
    const closed = await renderTemplate(PAGE, vm)
    expect(closed.document.querySelectorAll('[aria-label="common:page.onThisPage"]')).toHaveLength(1)
    expect(closed.document.querySelectorAll('[data-stub="page-toc-tree"]')).toHaveLength(1)
    expect(closed.document.querySelector('[aria-haspopup="dialog"][aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(closed.document.getElementById(opener.getAttribute('aria-controls')!)?.style.display).toBe('none')
    expect(vm.tocDisclosureExpanded).toBe(false)
    expect(vm.tocQuery).toBe('Section 23')
  })

  it('targets Exit focus rather than the new first navigation button, then returns to the original focus control', async () => {
    browserDocument.body.innerHTML = `<div id="reader">
      <button class="page-reading-previous">Previous</button>
      <button class="page-reading-exit">Exit focus</button>
      <button class="page-focus-control">Focus reading</button>
      <article></article>
    </div>`
    const root = browserDocument.querySelector<HTMLElement>('#reader')!
    const vm = reader({
      readerFocus: false,
      $el: root,
      $refs: { container: root.querySelector('article') },
      scrollAnimationFrame: null,
      scrollAnimationToken: 0
    })
    await page.methods.toggleReaderFocus!.call(vm)
    await vi.advanceTimersByTimeAsync(32)
    expect(vm.readerFocus).toBe(true)
    expect(browserDocument.activeElement).toBe(root.querySelector('.page-reading-exit'))

    vm.readerSectionsOpen = true
    await page.methods.toggleReaderFocus!.call(vm)
    await vi.advanceTimersByTimeAsync(32)
    expect(vm.readerFocus).toBe(false)
    expect(vm.readerSectionsOpen).toBe(false)
    expect(browserDocument.activeElement).toBe(root.querySelector('.page-focus-control'))
  })

  it('opens on the outline search and lets Escape close it before clearing the filter, restoring its opener', async () => {
    browserDocument.body.innerHTML = `<div id="reader">
      <button class="page-reading-sections-toggle">Choose a section</button>
      <button class="page-reading-exit">Exit focus</button>
      <section><div class="page-toc-filter"><input /></div></section>
    </div>`
    const root = browserDocument.querySelector<HTMLElement>('#reader')!
    const panel = root.querySelector<HTMLElement>('section')!
    const opener = root.querySelector<HTMLElement>('.page-reading-sections-toggle')!
    const input = panel.querySelector<HTMLInputElement>('input')!
    const vm = reader({ $el: root, $refs: { readerSections: panel }, tocQuery: 'chapter' })
    root.addEventListener('keydown', event => page.methods.readerSectionsEscape!.call(vm, event), { capture: true })
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') vm.tocQuery = ''
    })
    opener.focus()
    await page.methods.toggleReaderSections!.call(vm)
    expect(vm.readerSectionsOpen).toBe(true)
    expect(browserDocument.activeElement).toBe(input)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(vm.readerSectionsOpen).toBe(false)
    expect(vm.tocQuery).toBe('chapter')
    expect(browserDocument.activeElement).toBe(opener)
    expect(vm.readerFocus).toBe(true)
  })

  it('selects and reveals a collapsed section, then focuses its heading with reduced motion and anchor reconciliation', async () => {
    browserDocument.body.innerHTML = `<div id="reader">
      <button class="page-reading-sections-toggle">Choose a section</button>
      <article><details><summary>Outer</summary><details><summary>Inner</summary>
        <h2 id="hidden chapter">Hidden chapter</h2>
      </details></details></article>
    </div>`
    const root = browserDocument.querySelector<HTMLElement>('#reader')!
    const article = root.querySelector<HTMLElement>('article')!
    const heading = article.querySelector<HTMLElement>('h2')!
    const opener = root.querySelector<HTMLElement>('button')!
    const originalMatchMedia = browserWindow.matchMedia
    vi.spyOn(browserWindow, 'matchMedia').mockImplementation(query => ({
      ...originalMatchMedia(query),
      matches: query === '(prefers-reduced-motion: reduce)'
    }))
    const scrollTo = vi.spyOn(browserWindow, 'scrollTo').mockImplementation(() => {})
    const setNavigationAnchor = vi.fn()
    const vm = reader({
      $el: root,
      $refs: { container: article },
      readerSectionsOpen: true,
      scrollAnimationFrame: null,
      scrollAnimationToken: 0,
      scrollOpts: { duration: 300 },
      pageScrollTarget: () => 160,
      outlineCleanup: { setNavigationAnchor }
    })
    opener.focus()
    const event = new MouseEvent('click', { button: 0, cancelable: true })
    page.methods.tocLinkClicked!.call(vm, event, '#hidden chapter')
    expect(event.defaultPrevented).toBe(true)
    expect(vm.readerSectionsOpen).toBe(false)
    expect(vm.activeAnchor).toBe('#hidden%20chapter')
    expect([...article.querySelectorAll<HTMLDetailsElement>('details')].every(details => details.open)).toBe(true)
    expect(setNavigationAnchor).toHaveBeenLastCalledWith('#hidden%20chapter')

    await vi.advanceTimersByTimeAsync(32)
    expect(browserDocument.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(scrollTo).toHaveBeenCalledWith(0, 160)
    expect(vm.scrollAnimationFrame).toBeNull()
    expect(vm.readerFocus).toBe(true)
  })

  it('omits section controls when headings are absent or the outline is disabled, and closes on page or view changes', async () => {
    for (const overrides of [{ tocFlattened: [] }, { tocPosition: 'off' }]) {
      const vm = reader(overrides)
      const { document } = await renderTemplate(PAGE, vm)
      expect(document.querySelector('.page-reading-dock-title')?.textContent).toBe('Field guide')
      expect(document.querySelector('.page-reading-sections-toggle')).toBeNull()
      expect(document.querySelector('.page-reading-previous')).toBeNull()
      expect(document.querySelector('.page-reading-next')).toBeNull()
      await page.methods.toggleReaderSections!.call(vm)
      expect(vm.readerSectionsOpen).toBe(false)
    }

    const vm = reader({ readerSectionsOpen: true })
    page.watch.tocFlattened.handler.call(vm, sections)
    expect(vm.readerSectionsOpen).toBe(false)
    for (const overrides of [{ readerFocus: false }, { printView: true }, { talkActive: true }, { linksActive: true }, { tocPosition: 'off' }]) {
      Object.assign(
        vm,
        { readerFocus: true, printView: false, talkActive: false, linksActive: false, tocPosition: 'left', readerSectionsOpen: true },
        overrides
      )
      page.watch.readerSectionsAvailable.call(vm, vm.readerSectionsAvailable as boolean)
      expect(vm.readerSectionsOpen).toBe(false)
    }
  })
})

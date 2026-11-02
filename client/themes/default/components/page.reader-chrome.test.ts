import fs from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { manualReviewerId } from '../../../helpers/approval-reviewer-search.ts'
import { brandingDuplicatesSiteLogo } from '../../../helpers/page-branding.ts'
import { sameReaderPageIdentity } from '../../../helpers/page-action-events.ts'
import { buildOutlineTree, filterOutlineTree, getInitialExpandedAnchors } from '../../../helpers/page-outline.ts'
import { revealContentExtensionTarget } from '../../../helpers/content-extension-runtime.ts'
import { normalizeTableOfContents } from '../../../helpers/table-of-contents.ts'
import { publicationBoundaryTimestamp, publicationWindowOpen } from '../../../../shared/publication-window.ts'
import { browserWindow, document as browserDocument, resetBody } from '../../../test/browser-dom.mts'
import { keyTranslator, renderTemplate as renderWithSlots } from '../../../test/render-template.mts'

// Template checks render the reader with component stubs; rule checks exercise
// current reader behavior against a plain view model.

const PAGE = 'client/themes/default/components/page.vue'
const renderTemplate = (relativePath: string, state: Record<string, unknown>) =>
  renderWithSlots(relativePath, state, { 'glossary-reader': { glossary: { canLeave: () => true } } })

const baseState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  $t: keyTranslator,
  $slots: {},
  $vuetify: { locale: { isRtl: false }, display: { smAndDown: false, mdAndUp: true, width: 1440 }, theme: { current: { dark: false } } },
  printView: false,
  navMode: 'NONE',
  readerFocus: false,
  readerSectionsOpen: false,
  readerSectionsEscape: () => {},
  navigationEscape: () => {},
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
  winWidth: 1440,
  tocDisclosureExpanded: true,
  isPublished: true,
  visibility: 'public',
  updatedAt: '2026-01-02T03:04:05.000Z',
  formattedUpdatedAt: 'Today at 3:04 AM',
  accessibleUpdatedAt: 'Friday, January 2, 2026 3:04 AM',
  authorAttribution: { before: 'by ', after: '' },
  authorName: 'Ada',
  hasAuthor: true,
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
  it('suppresses the outline below two headings instead of displaying an empty rail', async () => {
    for (const tocFlattened of [[], [{ anchor: '#only', title: 'Only heading', depth: 0 }]]) {
      const { document } = await renderTemplate(PAGE, baseState({ tocFlattened }))
      expect(document.querySelector<HTMLElement>('.page-toc-card')?.style.display).toBe('none')
      expect(document.querySelector('.page-main--with-rail')).toBeNull()
    }
  })

  it('uses one "On this page" heading that becomes a disclosure button only below the rail breakpoint', async () => {
    const outlined = {
      readerHasSections: true,
      tocFlattened: [
        { anchor: '#one', title: 'One', depth: 0 },
        { anchor: '#two', title: 'Two', depth: 0 }
      ]
    }
    const wide = (await renderTemplate(PAGE, baseState(outlined))).document
    expect(wide.querySelectorAll('.page-toc-card .page-toc-heading')).toHaveLength(1)
    expect(wide.querySelector('.page-toc-card .page-toc-toggle')).toBeNull()
    expect(wide.querySelector('.page-toc-card')?.textContent).toContain('common:page.onThisPage')

    const compact = (await renderTemplate(PAGE, baseState({ ...outlined, isTocCompact: true, winWidth: 900, tocDisclosureExpanded: false }))).document
    const toggle = compact.querySelector('.page-toc-card .page-toc-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.getAttribute('aria-controls')).toBe('page-toc-content')
    expect(compact.querySelector('.page-toc-card .page-toc-heading')).toBeNull()

    for (const doc of [wide, compact]) {
      expect(doc.querySelector('.page-toc-card')?.getAttribute('aria-label')).toBe('common:page.onThisPage')
    }
  })

  it('keeps factual update attribution and exposes History only to an admitted reader', async () => {
    for (const [hasReadHistoryPermission, pageOnlineActionReady, printView] of [
      [true, true, false],
      [true, false, false],
      [false, true, false],
      [true, true, true]
    ]) {
      const { document } = await renderTemplate(PAGE, baseState({ hasReadHistoryPermission, pageOnlineActionReady, printView }))
      const provenance = document.querySelector('.page-hero .page-document-provenance')
      expect(provenance?.querySelectorAll('time')).toHaveLength(1)
      expect(provenance?.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-02T03:04:05.000Z')
      expect(provenance?.querySelector('time')?.getAttribute('title')).toBe('Friday, January 2, 2026 3:04 AM')
      expect(provenance?.querySelector('.page-document-author')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('by Ada')
      const history = provenance?.querySelector<HTMLButtonElement>('button:has(time)')
      if (hasReadHistoryPermission && !printView) {
        expect(history).not.toBeNull()
        expect(history?.disabled).toBe(!pageOnlineActionReady)
      } else {
        expect(history).toBeNull()
      }
    }
  })

  it('renders an author placeholder in the middle of a translated sentence without moving the name', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ authorAttribution: { before: 'Zuletzt von ', after: ' bearbeitet' } }))
    const author = document.querySelector('.page-document-author')
    expect(author?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Zuletzt von Ada bearbeitet')
    expect(author?.querySelector('bdi')?.textContent).toBe('Ada')
  })

  it('exposes both offline toggle states and omits pressed state for non-toggle actions', async () => {
    for (const { pressed, attribute } of [
      { pressed: false, attribute: 'false' },
      { pressed: true, attribute: 'true' },
      { pressed: undefined, attribute: null }
    ]) {
      const { document } = await renderTemplate(
        PAGE,
        baseState({
          offlineControl: {
            state: 'off',
            tone: 'neutral',
            icon: 'mdi-cloud-download-outline',
            blocked: false,
            label: 'Save offline',
            title: 'Save offline',
            detail: 'Keep a copy on this device.',
            pressed
          }
        })
      )
      const control = document.querySelector('.page-offline-control')
      expect(control).not.toBeNull()
      expect(control?.getAttribute('aria-pressed')).toBe(attribute)
    }
  })

  it('shows one unpublished indicator and its explanation', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ isPublished: false }))
    const html = document.body.innerHTML
    const indicator = document.querySelectorAll('.page-header-unpublished')
    expect(indicator).toHaveLength(1)
    expect(indicator[0]!.textContent).toContain('common:page.unpublished')
    expect(countText(html, 'common:page.unpublishedWarning')).toBe(1)
  })

  it('names scalar article position without exposing it as earned reading', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ readingProgress: 42 }))
    const bar = document.querySelector('.page-position')
    expect(bar?.getAttribute('role')).toBe('progressbar')
    expect(bar?.getAttribute('aria-label')).toBe('common:page.articlePosition')
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
  })

  it('shows the decorative navigation cue only while enabled and pending without changing reading progress or busy status', async () => {
    const idle = (await renderTemplate(PAGE, baseState({ readingProgress: 42 }))).document
    const readingBar = idle.querySelector('.page-position')?.outerHTML
    for (const showPageProgress of [false, true]) {
      for (const navigationPending of [false, true]) {
        const doc = (await renderTemplate(PAGE, baseState({ showPageProgress, navigationPending, readingProgress: 42 }))).document
        const cue = doc.querySelector('.page-navigation-progress')
        expect(cue !== null).toBe(showPageProgress && navigationPending)
        expect(doc.querySelector('.page-position')?.outerHTML).toBe(readingBar)
        expect(doc.querySelector('[aria-busy="true"]') !== null).toBe(navigationPending)
        if (cue) {
          expect(cue.getAttribute('aria-hidden')).toBe('true')
          expect(cue.hasAttribute('role')).toBe(false)
          expect(cue.hasAttribute('aria-valuenow')).toBe(false)
          expect(cue.textContent).toBe('')
        }
      }
    }
    const print = (await renderTemplate(PAGE, baseState({ printView: true, showPageProgress: true, navigationPending: true }))).document
    expect(print.querySelector('.page-navigation-progress')).toBeNull()
    expect(print.querySelector('.page-position')).toBeNull()
  })

  it('labels the discussion view and identifies the focus-reading control', async () => {
    const { document } = await renderTemplate(
      PAGE,
      baseState({
        showPageViewTabs: true,
        commentsEnabled: true,
        commentsPerms: { read: true, write: true }
      })
    )
    expect(document.querySelector('#page-view-talk-tab')?.textContent?.trim()).toBe('common:comments.title')
    expect(document.querySelector('.page-focus-control')?.getAttribute('aria-label')).toBe('common:page.focusReading')
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
  'useGoTo',
  'i18next',
  'AsyncState',
  'PageBrandingMark',
  'SiteBanner',
  'NavSidebar',
  'GlossaryReader',
  'DiscussionAnnotations',
  'wikiStore',
  'manualReviewerId',
  'brandingDuplicatesSiteLogo',
  'Prism',
  'ClipboardJS',
  'buildOutlineTree',
  'filterOutlineTree',
  'getInitialExpandedAnchors',
  'revealContentExtensionTarget',
  'sameReaderPageIdentity',
  'AbortController',
  'normalizeTableOfContents',
  'publicationBoundaryTimestamp',
  'publicationWindowOpen',
  executableScript
)(
  (options: unknown) => options,
  () => ({}),
  <Value>(value: Value) => value,
  () => () => {},
  { t: (key: string) => key },
  stubComponent,
  stubComponent,
  stubComponent,
  stubComponent,
  stubComponent,
  stubComponent,
  wikiStore,
  manualReviewerId,
  brandingDuplicatesSiteLogo,
  { plugins: { toolbar: { registerButton: () => {} } } },
  class ClipboardJS {},
  buildOutlineTree,
  filterOutlineTree,
  getInitialExpandedAnchors,
  revealContentExtensionTarget,
  sameReaderPageIdentity,
  browserWindow.AbortController,
  normalizeTableOfContents,
  publicationBoundaryTimestamp,
  publicationWindowOpen
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

  it('keeps one authorized Edit in the hero and reserves the optional mobile menu for other page actions', async () => {
    const shortcuts = (editFab: boolean, editMenu = true) => ({ editMenuBar: editMenu, editMenuBtn: editMenu, editFab })
    const cases = [
      { smAndDown: true, editFab: true, editMenu: true, write: true, fab: true, header: true },
      { smAndDown: true, editFab: false, editMenu: true, write: true, fab: false, header: true },
      { smAndDown: false, editFab: true, editMenu: true, write: true, fab: false, header: true },
      { smAndDown: true, editFab: true, editMenu: true, write: false, fab: true, header: false },
      { smAndDown: true, editFab: true, editMenu: false, write: true, fab: true, header: true },
      { smAndDown: true, editFab: false, editMenu: false, write: true, fab: false, header: false }
    ]
    for (const entry of cases) {
      const vm: Record<string, unknown> = {
        ...display(entry.smAndDown),
        editShortcutsObj: shortcuts(entry.editFab, entry.editMenu),
        hasWritePagesPermission: entry.write,
        hasAnyPagePermissions: true
      }
      const showEditFab = call('showEditFab', vm)
      const showHeaderEditButton = call('showHeaderEditButton', vm)
      expect({ fab: showEditFab, header: showHeaderEditButton }).toEqual({ fab: entry.fab, header: entry.header })
      const { document } = await renderTemplate(
        PAGE,
        baseState({
          editShortcutsObj: vm.editShortcutsObj,
          hasWritePagesPermission: entry.write,
          showEditFab,
          showHeaderEditButton
        })
      )
      expect(document.querySelectorAll('.page-hero [aria-label="common:actions.edit"]')).toHaveLength(entry.header ? 1 : 0)
      expect(document.querySelector('.page-edit-fab') !== null).toBe(entry.fab)
      expect([...document.querySelectorAll('[data-stub="v-list-item"]')].some(item => item.textContent?.trim() === 'common:page.editPage')).toBe(false)
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

describe('reader sharing context', () => {
  afterEach(() => resetBody())

  it('shares only a currently rendered outline target, not a stale, removed or non-article heading', () => {
    const container = browserDocument.createElement('article')
    container.innerHTML = '<h2 id="café / chapter #%23?">Chapter</h2><p id="unlisted">Not a section</p>'
    browserDocument.body.append(container)
    const vm: Record<string, unknown> = {
      $refs: { container },
      activeAnchor: '#caf%C3%A9%20%2F%20chapter%20%23%2523%3F',
      tocFlattened: [{ anchor: '#caf%C3%A9%20%2F%20chapter%20%23%2523%3F', title: 'Chapter', depth: 0 }],
      navigationPending: false,
      selectedPageView: 'article'
    }
    expect(call('shareSectionAnchor', vm)).toBe('café / chapter #%23?')
    for (const change of [
      { navigationPending: true },
      { selectedPageView: 'talk' },
      { activeAnchor: '#unlisted' },
      { tocFlattened: [] },
      { $refs: { container: browserDocument.createElement('article') } }
    ]) {
      expect(call('shareSectionAnchor', { ...vm, ...change })).toBe('')
    }
  })

  it('requires independent anonymous-sharing proof as well as current published content and reader authority', () => {
    const container = browserDocument.createElement('article')
    const admitted: Record<string, unknown> = {
      visibility: 'public',
      publicSharingEligible: true,
      isPublished: true,
      currentPublicationEligible: true,
      pageTransportVerified: true,
      readingReaderAuthority: 'reader-7',
      readingContentAuthority: 'reader-7',
      readingAdmittedContentKey: 'content-2',
      readingContentKey: 'content-2',
      readingContentNode: container,
      $refs: { container },
      offlineDisposed: false,
      navigationPending: false,
      printView: false,
      selectedPageView: 'article'
    }
    expect(call('publicSharingContextEligible', admitted)).toBe(true)
    for (const revoked of [
      { publicSharingEligible: false },
      { publicSharingEligible: undefined },
      { publicSharingEligible: 'true' },
      { visibility: 'private' },
      { currentPublicationEligible: false },
      { pageTransportVerified: false },
      { readingReaderAuthority: null },
      { readingContentAuthority: 'previous-reader' },
      { readingAdmittedContentKey: 'previous-content' },
      { readingContentNode: browserDocument.createElement('article') },
      { offlineDisposed: true },
      { navigationPending: true },
      { printView: true },
      { selectedPageView: 'links' }
    ]) {
      expect(call('publicSharingContextEligible', { ...admitted, ...revoked })).toBe(false)
    }
  })

  it('requires server publication authority and never promotes a scheduled or expired writer-only page', () => {
    const now = Date.now()
    const vm = {
      isPublished: true,
      effectiveIsPublished: true,
      publicationClock: now,
      publishStartDate: new Date(now - 10_000).toISOString(),
      publishEndDate: new Date(now + 10_000).toISOString()
    }
    expect(call('currentPublicationEligible', vm)).toBe(true)
    for (const change of [
      { effectiveIsPublished: false },
      { effectiveIsPublished: undefined },
      { isPublished: false },
      { publishStartDate: new Date(now + 60_000).toISOString() },
      { publishEndDate: new Date(now - 1).toISOString() },
      { publishEndDate: 'invalid' }
    ]) {
      expect(Boolean(call('currentPublicationEligible', { ...vm, ...change }))).toBe(false)
    }
  })

  it('retires sharing across the inclusive end boundary while the reader stays open', () => {
    const start = Date.parse('2026-11-01T12:00:00Z')
    let now = start
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let scheduled: (() => void) | undefined
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      scheduled = callback
      expect(delay).toBe(2)
      return 123
    }) as typeof setTimeout)
    const vm: Record<string, unknown> = {
      isPublished: true,
      effectiveIsPublished: true,
      publicationClock: start,
      publicationTimer: null,
      offlineDisposed: false,
      publishStartDate: null,
      publishEndDate: new Date(start + 1).toISOString()
    }
    vm.refreshPublicationClock = () => page.methods.refreshPublicationClock!.call(vm)
    try {
      page.methods.refreshPublicationClock!.call(vm)
      now = start + 1
      expect(call('currentPublicationEligible', vm)).toBe(true)
      now = start + 2
      scheduled!()
      expect(call('currentPublicationEligible', vm)).toBe(false)
      expect(vm.publicationTimer).toBe(null)
      expect(timer).toHaveBeenCalledTimes(1)
    } finally {
      timer.mockRestore()
      clock.mockRestore()
    }
  })

  it('encodes locale and each stored path segment without losing literal URL punctuation or private scope', () => {
    const vm = { locales: ['en'], locale: 'fr#?%é', path: 'café #?/literal%23/雪', visibility: 'public' }
    const suffix = '/fr%23%3F%25%C3%A9/caf%C3%A9%20%23%3F/literal%2523/%E9%9B%AA'
    expect(call('pageUrl', vm)).toBe(`${browserWindow.location.origin}${suffix}`)
    expect(call('pageUrl', { ...vm, visibility: 'private' })).toBe(`${browserWindow.location.origin}/_private${suffix}`)
    expect(call('pageUrl', { ...vm, locales: [] })).toBe(`${browserWindow.location.origin}/caf%C3%A9%20%23%3F/literal%2523/%E9%9B%AA`)
  })
})

describe('page route motion policy', () => {
  beforeEach(() => resetBody())
  afterEach(() => {
    vi.restoreAllMocks()
    resetBody()
  })

  it('requires site transitions and no OS reduced-motion preference, cleaning up interrupted entrances', () => {
    browserDocument.body.innerHTML = '<main><h1>Next page</h1></main>'
    const content = browserDocument.querySelector('main')!
    let reducedMotion = false
    const originalMatchMedia = browserWindow.matchMedia
    vi.spyOn(browserWindow, 'matchMedia').mockImplementation(query => ({
      ...originalMatchMedia(query),
      matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion
    }))
    const vm = {
      $refs: { content },
      pageTransitions: true,
      routeAnimationAbortController: null as AbortController | null
    }
    const animate = () => page.methods.animatePageRoute!.call(vm)
    animate()
    expect(content.classList.contains('page-main--route-enter')).toBe(true)
    const first = vm.routeAnimationAbortController!
    animate()
    expect(first.signal.aborted).toBe(true)
    expect(content.classList.contains('page-main--route-enter')).toBe(true)
    content.dispatchEvent(new browserWindow.Event('animationend', { bubbles: true }))
    expect(content.classList.contains('page-main--route-enter')).toBe(false)
    expect(vm.routeAnimationAbortController).toBeNull()

    for (const enabled of [false, true]) {
      for (const reduced of [false, true]) {
        vm.pageTransitions = true
        reducedMotion = false
        animate()
        const previous = vm.routeAnimationAbortController!
        vm.pageTransitions = enabled
        reducedMotion = reduced
        animate()
        expect(previous.signal.aborted).toBe(true)
        expect(content.classList.contains('page-main--route-enter')).toBe(enabled && !reduced)
        expect(vm.routeAnimationAbortController !== null).toBe(enabled && !reduced)
      }
    }
    vm.routeAnimationAbortController?.abort()
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
          readerDockVisible: false,
          wideViewport: width >= 1280,
          viewportMedia: { matches: width >= 1280 },
          $nextTick: Vue.nextTick
        },
        true
      )
      await Vue.nextTick()
      expect(browserDocument.activeElement === (width < 1280 ? home : search)).toBe(true)
    }

    const resizing = { readerDockVisible: false, wideViewport: false, viewportMedia: { matches: false }, $nextTick: Vue.nextTick }
    search.focus()
    page.methods.navigationVisibilityChanged!.call(resizing, true)
    // CSS has crossed the boundary before the reactive render cache catches up.
    resizing.viewportMedia.matches = true
    await Vue.nextTick()
    expect(browserDocument.activeElement === search).toBe(true)
  })

  it('returns closed drawer focus to its opener without stealing newly claimed content focus', async () => {
    browserDocument.body.innerHTML =
      '<button id="opener">Navigation</button><nav id="page-navigation-drawer"><button id="inside">Home</button></nav><input id="filter">'
    const opener = browserDocument.querySelector<HTMLButtonElement>('#opener')!
    const inside = browserDocument.querySelector<HTMLButtonElement>('#inside')!
    const filter = browserDocument.querySelector<HTMLInputElement>('#filter')!
    const vm = { readerDockVisible: false, wideViewport: false, $refs: { navToggle: opener }, $nextTick: Vue.nextTick }

    inside.focus()
    page.methods.navigationVisibilityChanged!.call(vm, false)
    await Vue.nextTick()
    expect(browserDocument.activeElement === opener).toBe(true)

    inside.focus()
    page.methods.navigationVisibilityChanged!.call(vm, false)
    filter.focus()
    await Vue.nextTick()
    expect(browserDocument.activeElement === filter).toBe(true)
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
      retirePageOutline: () => {},
      setupPageOutline: () => {},
      ensureActiveTocVisible: () => {},
      ...overrides
    })
    for (const name of [
      'readerHasSections',
      'readerDockVisible',
      'readerSectionsAvailable',
      'readerSectionIndex',
      'readerSection',
      'tocTree',
      'tocTreeVisible'
    ]) {
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

  it('moves the sole searchable outline into the picker without changing compact disclosure state', async () => {
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
      isTocCompact: true,
      winWidth: 320
    })
    const open = await renderTemplate(PAGE, vm)
    const outline = open.document.querySelector<HTMLElement>('#page-toc-content')!
    expect(open.document.querySelectorAll('#page-toc-content')).toHaveLength(1)
    expect(open.document.querySelectorAll('[data-stub="page-toc-tree"]')).toHaveLength(1)
    expect(outline.closest('[data-teleport="#page-reading-sections-host"]')).not.toBeNull()
    expect(outline.style.display).not.toBe('none')
    expect(outline.querySelector('.page-toc-filter')?.getAttribute('modelvalue')).toBe('Section 23')
    expect(open.document.querySelector('.page-reading-sections-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(open.document.querySelector('.page-toc-toggle')).toBeNull()

    page.methods.closeReaderSections!.call(vm)
    const closed = await renderTemplate(PAGE, vm)
    expect(closed.document.querySelectorAll('#page-toc-content')).toHaveLength(1)
    expect(closed.document.querySelector('#page-toc-content')?.closest('[data-teleport="#page-inline-toc"]')).not.toBeNull()
    expect(closed.document.querySelector('.page-toc-toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(vm.tocQuery).toBe('Section 23')
  })

  it('keeps activation at the hero control on entry and returns there on exit without focusing the bottom dock', async () => {
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
      scrollAnimationToken: 0,
      readerPageIdentity: { pageId: 1, locale: 'en', path: 'home', visibility: 'public', sourceRevision: '' },
      readingReaderAuthority: 'reader-7'
    })
    const control = root.querySelector<HTMLElement>('.page-focus-control')!
    control.focus()
    await page.methods.toggleReaderFocus!.call(vm)
    await vi.advanceTimersByTimeAsync(32)
    expect(vm.readerFocus).toBe(true)
    expect(browserDocument.activeElement).toBe(control)

    vm.readerSectionsOpen = true
    root.querySelector<HTMLElement>('.page-reading-exit')!.focus()
    await page.methods.toggleReaderFocus!.call(vm)
    await vi.advanceTimersByTimeAsync(32)
    expect(vm.readerFocus).toBe(false)
    expect(vm.readerSectionsOpen).toBe(false)
    expect(browserDocument.activeElement).toBe(root.querySelector('.page-focus-control'))
  })

  it('opens on outline search and respects a consumed filter Escape before closing the picker from its opener', async () => {
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
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') page.methods.readerSectionsEscape!.call(vm, event)
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') event.stopPropagation()
    })
    opener.focus()
    await page.methods.toggleReaderSections!.call(vm)
    expect(vm.readerSectionsOpen).toBe(true)
    expect(browserDocument.activeElement).toBe(input)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(vm.readerSectionsOpen).toBe(true)
    expect(vm.tocQuery).toBe('chapter')
    expect(browserDocument.activeElement).toBe(input)
    expect(vm.readerFocus).toBe(true)
    opener.focus()
    opener.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(vm.readerSectionsOpen).toBe(false)
    expect(vm.tocQuery).toBe('chapter')
    expect(browserDocument.activeElement).toBe(opener)
    expect(vm.readerFocus).toBe(true)
  })

  it('does not let reader Escape override an overlay, a consumed key or IME composition', () => {
    const vm = reader()
    const exit = vi.fn()
    vm.toggleReaderFocus = exit
    for (const protectedBy of ['overlay', 'consumed', 'composing']) {
      const overlay = browserDocument.createElement('div')
      if (protectedBy === 'overlay') {
        overlay.className = 'v-overlay--active'
        browserDocument.body.append(overlay)
      }
      const event = new browserWindow.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, isComposing: protectedBy === 'composing' })
      if (protectedBy === 'consumed') event.preventDefault()
      page.methods.readerSectionsEscape!.call(vm, event)
      expect(exit).not.toHaveBeenCalled()
      expect(vm.readerFocus).toBe(true)
      overlay.remove()
    }
    const escapeEvent = new browserWindow.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    page.methods.readerSectionsEscape!.call(vm, escapeEvent)
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('keeps the left desktop outline expanded beside site navigation and uses a disclosure only on narrow screens', async () => {
    const vm = reader({ readerFocus: false, navMode: 'MIXED', tocPosition: 'left', tocFlattened: sections.slice(0, 2) })
    expect(vm.readerHasSections).toBe(true)
    for (const [wideViewport, navigationOpen] of [[true, false], [true, true], [false, true], [true, true]]) {
      vm.wideViewport = wideViewport
      vm.navigationOpen = navigationOpen
      vm.isTocCompact = call('isTocCompact', vm)
      const rendered = await renderTemplate(PAGE, vm)
      const outline = rendered.document.querySelector('.page-toc-card')!
      expect(outline.closest('[data-teleport]')?.getAttribute('data-teleport')).toBe(wideViewport ? '#page-desktop-rail' : '#page-inline-toc')
      expect(rendered.document.querySelectorAll('.page-toc-card')).toHaveLength(1)
      expect(rendered.document.querySelector('.page-main')?.classList.contains('page-main--with-rail')).toBe(wideViewport)
    }
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

  it('omits section controls below two headings or with the outline disabled, and closes on page or view changes', async () => {
    for (const overrides of [{ tocFlattened: [] }, { tocFlattened: sections.slice(0, 1) }, { tocPosition: 'off' }]) {
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

describe('Reader native Print completion', () => {
  beforeEach(() => resetBody())
  afterEach(() => {
    vi.restoreAllMocks()
    resetBody()
  })

  for (const outcome of ['returned', 'threw', 'navigated'] as const) {
    it(`restores disclosure state after Print ${outcome}, without focusing a different page`, () => {
      browserDocument.body.innerHTML =
        '<main><button data-page-actions-activator>Page actions</button><article><details><summary>Closed section</summary>Body</details><details open><summary>Open section</summary>Body</details></article></main>'
      const root = browserDocument.querySelector('main')!
      const original = root.querySelector('button')!
      const article = root.querySelector('article')!
      const details = Array.from(article.querySelectorAll('details'))
      const replacement = browserDocument.createElement('button')
      replacement.setAttribute('data-page-actions-activator', '')
      replacement.textContent = 'Page actions'
      vi.spyOn(replacement, 'getClientRects').mockReturnValue([new browserWindow.DOMRect(0, 0, 44, 44)] as unknown as DOMRectList)
      const ticks: Array<() => void> = []
      const identity = { pageId: 7, locale: 'en', path: 'field-guide', visibility: 'public', sourceRevision: '2' }
      const vm: Record<string, unknown> = {
        $el: root,
        $refs: { container: article },
        $nextTick: (callback: () => void) => {
          ticks.push(callback)
        },
        readerPageIdentity: identity,
        offlineDisposed: false,
        printView: false,
        printViewBeforePrint: null,
        printDetailsState: null
      }
      vm.preparePrintView = () => page.methods.preparePrintView!.call(vm)
      vm.restorePrintView = () => page.methods.restorePrintView!.call(vm)
      vi.spyOn(browserWindow, 'print').mockImplementation(() => {
        expect(vm.printView).toBe(true)
        expect(details.map(detail => detail.open)).toEqual([true, true])
        original.remove()
        root.prepend(replacement)
        if (outcome === 'navigated') vm.readerPageIdentity = { ...identity, pageId: 8 }
        if (outcome === 'threw') throw new Error('Native printing unavailable')
        // Deliberately no afterprint event: the native implementation may omit it.
      })
      original.focus()
      page.methods.print!.call(vm)
      if (outcome === 'threw') expect(() => ticks.shift()!()).toThrow('Native printing unavailable')
      else ticks.shift()!()
      expect(vm.printView).toBe(false)
      expect(details.map(detail => detail.open)).toEqual([false, true])
      ticks.shift()!()
      expect(browserDocument.activeElement).toBe(outcome === 'navigated' ? browserDocument.body : replacement)
    })
  }
})

describe('leading Markdown reader title', () => {
  beforeEach(() => resetBody())
  afterEach(() => resetBody())

  const fixture = (html: string, title = 'Café Guide', navigationKey = 0) => {
    browserDocument.body.innerHTML =
      '<h1 class="page-title" id="shell-title"><span></span></h1><article><div class="wiki-page-rendered-contents"></div></article>'
    const hero = browserDocument.querySelector<HTMLElement>('.page-title')!
    hero.firstElementChild!.textContent = title
    const container = browserDocument.querySelector<HTMLElement>('article')!
    container.firstElementChild!.innerHTML = html
    const vm: Record<string, unknown> = {
      $refs: { container, pageTitle: hero, pageTitleText: hero.firstElementChild },
      editor: 'markdown',
      title,
      leadingTitle: null,
      tocDecoded: [],
      navigationKey
    }
    vm.restoreLeadingTitle = () => page.methods.restoreLeadingTitle!.call(vm)
    const sync = () => page.methods.syncLeadingTitle!.call(vm)
    return { vm, hero, container, sync }
  }

  it('deduplicates canonically equivalent formatted text, preserves its fragment and leaves authored markup intact', () => {
    const { vm, hero, container, sync } = fixture(
      '<h1 id="café guide" class="toc-header"><a class="toc-anchor" aria-label="Link to heading" href="#café%20guide">¶</a> <em>CAFÉ</em>&nbsp;<br>Guide</h1><h2 id="chapter">Chapter</h2><h1 id="later">Café Guide</h1>'
    )
    const heading = container.querySelector<HTMLElement>('h1')!
    const authoredContents = heading.innerHTML
    vm.tocDecoded = [
      { anchor: '#café%20guide', title: 'Café Guide', children: [{ anchor: '#chapter', title: 'Chapter', children: [] }] },
      { anchor: '#later', title: 'Café Guide', children: [] }
    ]
    sync()
    expect(heading.hidden).toBe(true)
    expect(hero.querySelector('[id]')?.id).toBe('café guide')
    expect(hero.id).toBe('shell-title')
    expect(heading.innerHTML).toBe(authoredContents)
    expect(container.querySelector<HTMLElement>('#later')!.hidden).toBe(false)
    expect((call('tocFlattened', vm) as Array<{ anchor: string }>).map(entry => entry.anchor)).toEqual(['#chapter', '#later'])
    sync()
    expect(browserDocument.querySelectorAll('[id="café guide"]')).toHaveLength(1)
    page.methods.restoreLeadingTitle!.call(vm)
    expect(heading.hidden).toBe(false)
    expect(heading.id).toBe('café guide')
    expect(heading.innerHTML).toBe(authoredContents)
    expect(hero.querySelector('[id]')).toBeNull()
  })

  it('crosses both marked SPA transports but retains authored content below that boundary', () => {
    const { vm, hero, container, sync } = fixture(
      '<div class="wiki-page-rendered-contents" data-v-scope><h1 id="spa-title">Café Guide</h1></div>',
      'Café Guide',
      1
    )
    sync()
    expect(container.querySelector<HTMLElement>('h1')!.hidden).toBe(true)
    expect(browserDocument.getElementById('spa-title')?.parentElement).toBe(hero)
    page.methods.restoreLeadingTitle!.call(vm)
    container.firstElementChild!.innerHTML =
      '<div class="wiki-page-rendered-contents"><div class="wiki-page-rendered-contents"><h1 id="authored">Café Guide</h1></div></div>'
    sync()
    expect(container.querySelector<HTMLElement>('h1')!.hidden).toBe(false)
    expect(container.querySelector<HTMLElement>('h1')!.id).toBe('authored')
  })

  it('retains nonmatching, nested, later and meaningfully different headings', () => {
    for (const html of [
      '<h1 id="other">Other Guide</h1><h1>Café Guide</h1>',
      '<blockquote><h1>Café Guide</h1></blockquote>',
      '<section><h1>Café Guide</h1></section>',
      '<div><h1>Café Guide</h1></div>',
      '<div class="wiki-page-rendered-contents"><h1>Café Guide</h1></div>',
      '<p>Introduction</p><h1>Café Guide</h1>',
      'Introduction<h1>Café Guide</h1>',
      '<h1>Café Guide!</h1>',
      '<h1>Cafe Guide</h1>',
      '<h1>Ｃafé Guide</h1>',
      '<h1>Café Guide<img alt="Logo" src="/logo.png"></h1>',
      '<h1><a href="/en/home">Café Guide</a></h1>',
      '<h1 aria-label="Different spoken title">Café Guide</h1>',
      '<h2>Café Guide</h2>'
    ]) {
      const { vm, container, sync } = fixture(html)
      const before = container.innerHTML
      sync()
      expect(container.innerHTML).toBe(before)
    }
    const { vm, container, sync } = fixture('<h1>Café Guide</h1>')
    vm.editor = 'code'
    sync()
    expect(container.querySelector<HTMLElement>('h1')!.hidden).toBe(false)
  })

  it('restores a changed title and replaces stale aliases when rendered content arrives later', () => {
    const { vm, hero, container, sync } = fixture('<h1 id="old">Café Guide</h1>')
    sync()
    const old = container.querySelector<HTMLElement>('h1')!
    vm.title = 'Next Guide'
    hero.lastChild!.textContent = 'Next Guide'
    sync()
    expect(old.hidden).toBe(false)
    expect(old.id).toBe('old')
    container.firstElementChild!.innerHTML = '<h1 id="next"><strong>Next</strong> Guide</h1><p>Body</p>'
    sync()
    expect(browserDocument.getElementById('old')).toBeNull()
    expect(browserDocument.getElementById('next')?.parentElement).toBe(hero)
    expect(container.querySelector<HTMLElement>('h1')!.hidden).toBe(true)
  })

  it('resolves the encoded old fragment to the visible hero for programmatic navigation', () => {
    const { vm, hero, sync } = fixture('<h1 id="café guide">Café Guide</h1><h2 id="chapter">Chapter</h2>')
    sync()
    let destination: unknown
    Object.assign(vm, {
      tocFlattened: [],
      scrollAnimationToken: 0,
      scrollAnimationFrame: null,
      outlineCleanup: null,
      cancelScheduledScroll: () => page.methods.cancelScheduledScroll!.call(vm),
      pageScrollTarget: () => 0,
      animatePageScroll: (_top: number, target: HTMLElement) => {
        destination = target
      }
    })
    const frame = vi.spyOn(browserWindow, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    try {
      page.methods.scrollToPageAnchor!.call(vm, '#café%20guide')
      expect(destination).toBe(hero)
      expect(browserDocument.getElementById('café guide')?.textContent).toBe('Café Guide')
    } finally {
      frame.mockRestore()
    }
  })
})

import fs from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { manualReviewerId } from '../../../helpers/approval-reviewer-search.ts'
import { brandingDuplicatesSiteLogo } from '../../../helpers/page-branding.ts'
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
  printView: false,
  navMode: 'NONE',
  readerFocus: false,
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
    state: 'off', tone: 'neutral', icon: 'mdi-cloud-download-outline', action: 'save', blocked: false,
    label: 'Save offline', title: 'Save offline', detail: 'Keep a copy on this device.', pressed: false
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
  it('shows the empty outline message once', async () => {
    const { document } = await renderTemplate(PAGE, baseState())
    const empty = document.querySelectorAll('.page-toc-empty')
    expect(empty).toHaveLength(1)
    expect(countText(empty[0]!.textContent ?? '', 'common:page.noSections')).toBe(1)
  })

  it('uses one "On this page" heading that becomes a disclosure button only below the rail breakpoint', async () => {
    const wide = (await renderTemplate(PAGE, baseState())).document
    expect(wide.querySelectorAll('.page-toc-card .page-toc-heading')).toHaveLength(1)
    expect(wide.querySelector('.page-toc-card .page-toc-toggle')).toBeNull()
    expect(wide.querySelector('.page-toc-card')?.textContent).toContain('common:page.onThisPage')

    const compact = (await renderTemplate(PAGE, baseState({ isTocCompact: true, winWidth: 900, pageToolsHost: '#page-tablet-tools', tocDisclosureExpanded: false }))).document
    const toggle = compact.querySelector('.page-toc-card .page-toc-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.getAttribute('aria-controls')).toBe('page-toc-content')
    expect(compact.querySelector('.page-toc-card .page-toc-heading')).toBeNull()

    for (const doc of [wide, compact]) {
      expect(doc.querySelector('.page-toc-card')?.getAttribute('aria-label')).toBe('common:page.onThisPage')
      expect(doc.body.innerHTML).not.toContain('common:page.toc')
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

  it('opens every utility tooltip below the whole card with a capped width, so none covers the title or the metadata', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ isAuthenticated: true, utilityTooltipTarget: '#page-desktop-rail .page-tools-card' }))
    const tooltips = Array.from(document.querySelectorAll('.page-tools-card__utilities [data-stub="v-tooltip"]'))
    expect(tooltips.length).toBeGreaterThan(2)
    expect(tooltips.map(tooltip => tooltip.getAttribute('location'))).toEqual(tooltips.map(() => 'bottom'))
    expect(tooltips.map(tooltip => tooltip.getAttribute('target'))).toEqual(tooltips.map(() => '#page-desktop-rail .page-tools-card'))
    expect(tooltips.map(tooltip => tooltip.getAttribute('max-width'))).toEqual(tooltips.map(() => '280'))
  })

  it('renders an author placeholder in the middle of a translated sentence without moving the name', async () => {
    const { document } = await renderTemplate(PAGE, baseState({ authorAttribution: { before: 'Zuletzt von ', after: ' bearbeitet' } }))
    const author = document.querySelector('.page-document-author')
    expect(author?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Zuletzt von Ada bearbeitet')
    expect(author?.querySelector('bdi')?.textContent).toBe('Ada')
  })

  it('keeps blocked utilities focusable and puts the reason in their tooltip', async () => {
    const { document } = await renderTemplate(PAGE, baseState({
      pageWatchBlockedReason: 'Watch reason',
      pageOnlineActionReady: false,
      pageOnlineActionUnavailableReason: 'Offline reason',
      pageProtectionBlockedReason: 'Offline reason'
    }))
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
    const { document } = await renderTemplate(PAGE, baseState({
      showPageViewTabs: true,
      commentsEnabled: true,
      commentsPerms: { read: true, write: true }
    }))
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
  script.replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, '').replace('export default defineComponent({', 'const pageComponent = defineComponent({') + '\nreturn pageComponent'
)
const wikiStore = { user: { authenticated: true, id: 7, permissions: [] as string[] }, site: { logoUrl: '/_site-logo/abc/logo.png' }, authRefreshOutcome: 'authenticated' as string | null }
type Rules = {
  computed: Record<string, (this: Record<string, unknown>) => unknown>
  methods: Record<string, (this: Record<string, unknown>, ...args: unknown[]) => unknown>
}
const stubComponent = {}
const page = new Function(
  'defineComponent', 'h', 'markRaw', 'mergeProps', 'useGoTo', 'i18next',
  'AsyncState', 'PageBrandingMark', 'SiteBanner', 'NavSidebar',
  'wikiStore', 'manualReviewerId', 'brandingDuplicatesSiteLogo', 'Prism', 'ClipboardJS',
  executableScript
)(
  (options: unknown) => options, () => ({}), <Value>(value: Value) => value, Vue.mergeProps, () => () => {}, { t: (key: string) => key },
  stubComponent, stubComponent, stubComponent, stubComponent,
  wikiStore, manualReviewerId, brandingDuplicatesSiteLogo, { plugins: { toolbar: { registerButton: () => {} } } }, class ClipboardJS {}
) as Rules

const call = (name: string, vm: Record<string, unknown>) => page.computed[name]!.call(vm)

describe('page reader chrome rules', () => {
  const display = (smAndDown: boolean) => ({ $vuetify: { display: { smAndDown } } })

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
    const translate = (template: string) => (_key: string, options: { author: string }) => template.replace('{{author}}', options.author)
    expect(call('authorAttribution', { $t: translate('by {{author}}') })).toEqual({ before: 'by ', after: '' })
    expect(call('authorAttribution', { $t: translate('{{author}} が編集') })).toEqual({ before: '', after: ' が編集' })
  })

  it('explains why watching is blocked and stays quiet while it loads', () => {
    const vm = { $t: (key: string) => key, pageOnlineActionUnavailableReason: 'offline' }
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: false, pageWatchAuthorityReady: true, pageWatchLoading: false })).toBe('offline')
    expect(call('pageWatchBlockedReason', { ...vm, pageOnlineActionReady: true, pageWatchAuthorityReady: false, pageWatchLoading: false })).toBe('common:page.watchStateStale')
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

  it('anchors utility tooltips to the card in the host it is teleported to', () => {
    const target = (vm: Record<string, unknown>) => {
      vm.pageToolsHost = call('pageToolsHost', vm)
      return call('utilityTooltipTarget', vm)
    }
    expect(target({ isTocMobile: false, winWidth: 1440 })).toBe('#page-desktop-rail .page-tools-card')
    expect(target({ isTocMobile: false, winWidth: 1100 })).toBe('#page-tablet-tools .page-tools-card')
    expect(target({ isTocMobile: true, winWidth: 390 })).toBe('#page-mobile-tools .page-tools-card')
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
    expect(page.methods.approvalActorLabel!.call(vm, 3)).toBe('common:page.reviewerById(id=3)')
  })
})

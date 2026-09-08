import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history REST migration guard', () => {
  test('routes requests through abort-aware page REST helpers', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(source).toContain(
      "import { fetchPageHistory, fetchPageVersion, restorePageVersion, type PageHistoryTrailItem, type PageVersion } from '../helpers/pages-api'"
    )
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(
      /fetchWithAbort\s*\(url:\s*string,\s*init:\s*RequestInit\):\s*Promise<Response>\s*\{[\s\S]*?window\.fetch\s*\(\s*url,\s*\{[\s\S]*?signal:\s*this\.requestsAbortController\.signal/
    )
    expect(source).toContain('const page = await fetchPageVersion(this.fetchWithAbort, this.pageId, versionId)')
    expect(source).toContain('await restorePageVersion(this.fetchWithAbort, this.pageId, this.restoreTarget.versionId, this.sourceRevision)')
    expect(source).toMatch(/const result = await fetchPageHistory\s*\(\s*this\.fetchWithAbort,\s*this\.pageId,\s*offsetPage,/)
    expect(source).toContain('return this.requestsAbortController.signal.aborted ? null : result')
    expect(source).toContain('return { ...emptyPageVersion(versionId), path: this.path, locale: this.locale }')
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves latest-request cleanup, loading, cache, errors, and restore feedback', () => {
    const watcherCleanups = source.match(/onCleanup\s*\(\s*\(\)\s*=>\s*\{\s*cancelled = true\s*\}\s*\)/g) || []

    expect(watcherCleanups).toHaveLength(2)
    expect(source).toContain('if (!cancelled && this.diffSource === newValue) {')
    expect(source).toContain('if (!cancelled && this.diffTarget === newValue) {')
    expect(source).toMatch(/beforeUnmount\s*\(\)\s*\{\s*this\.requestsAbortController\.abort\s*\(\s*\)/)
    expect(source).toContain('window.clearTimeout(this.restoreRedirectTimer)')
    expect(source).toContain("loadingStart(wikiStore, 'history-version-' + versionId)")
    expect(source).toContain("loadingStop(wikiStore, 'history-version-' + versionId)")
    expect(source).toContain('this.cache.push(page)')
    expect(source).toMatch(
      /if\s*\(\s*!this\.requestsAbortController\.signal\.aborted\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore,\s*\{\s*style:\s*'red',\s*message:\s*getErrorMessage\(err\)/
    )
    expect(source).toMatch(/showNotification\s*\(\s*wikiStore,\s*\{\s*style:\s*'success'/)
    expect(source).toContain('this.isRestoreConfirmDialogShown = false')
    expect(source).toContain("loadingStop(wikiStore, 'history-restore')")
    expect(source).toContain("setLoading(wikiStore, 'history-trail-refresh', true)")
    expect(source).toContain("setLoading(wikiStore, 'history-trail-refresh', false)")
    expect(source).toContain('this.trailError = getErrorMessage(error)')
  })
})
describe('history sticky timeline and comparison behavior', () => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '')).replace('export default {', 'return {')

  const createHistoryInstance = (overrides = {}) => {
    const component = new Function(
      'markRaw',
      'Diff2Html',
      'createPatch',
      'AsyncState',
      'fetchPageHistory',
      'fetchPageVersion',
      'restorePageVersion',
      'getPageDownloadPath',
      'getPageSourcePath',
      'getErrorMessage',
      'loadingStart',
      'loadingStop',
      'setLoading',
      'showNotification',
      'wikiStore',
      'decodeBase64Json',
      executable
    )(
      v => v,
      {},
      () => '',
      {},
      {},
      {},
      {},
      () => '',
      () => '',
      () => '',
      () => {},
      () => {},
      () => {},
      () => {},
      { page: {} },
      () => ({})
    )

    const instance = {
      ...component.data(),
      authorId: 1,
      authorName: 'TestAuthor',
      updatedAt: '2026-09-08T10:00:00Z',
      path: 'home',
      locale: 'en',
      total: 2,
      trail: [
        { versionId: 2, authorId: 1, authorName: 'TestAuthor', actionType: 'edit', valueBefore: null, valueAfter: null, versionDate: '2026-09-07T10:00:00Z' },
        { versionId: 1, authorId: 1, authorName: 'TestAuthor', actionType: 'initial', valueBefore: null, valueAfter: null, versionDate: '2026-09-06T10:00:00Z' }
      ],
      cache: [
        { versionId: 0, path: 'home' },
        { versionId: 2, path: 'home' },
        { versionId: 1, path: 'home' }
      ],
      $vuetify: { display: { mdAndUp: true, smAndDown: false } },
      $nextTick: fn => fn(),
      $refs: {},
      ...overrides
    }

    for (const [name, method] of Object.entries(component.methods)) {
      instance[name] = method.bind(instance)
    }
    Object.defineProperty(instance, 'fullTrail', {
      get: () => component.computed.fullTrail.call(instance)
    })

    return instance
  }

  test('toggles diff view mode between line-by-line and side-by-side while preserving trail scroll position', () => {
    const trailEl = { scrollTop: 75 }
    const instance = createHistoryInstance({
      $refs: { trailContainer: trailEl }
    })

    instance.trailScrollTop = 75
    expect(instance.viewMode).toBe('line-by-line')

    instance.toggleViewMode()
    expect(instance.viewMode).toBe('side-by-side')
    expect(trailEl.scrollTop).toBe(75)

    instance.toggleViewMode()
    expect(instance.viewMode).toBe('line-by-line')
    expect(trailEl.scrollTop).toBe(75)
  })

  test('supports comparison source variants and preserves trail scroll position across revisions', () => {
    const trailEl = { scrollTop: 120 }
    const instance = createHistoryInstance({
      $refs: { trailContainer: trailEl }
    })

    instance.trailScrollTop = 120

    // Live vs latest edit
    expect(instance.canSelectVersion(0)).toBe(true)
    instance.selectVersion(0)
    expect(instance.diffTarget).toBe(0)
    expect(instance.diffSource).toBe(2)
    expect(trailEl.scrollTop).toBe(120)

    // Edit vs previous edit/initial
    expect(instance.canSelectVersion(1)).toBe(true)
    instance.selectVersion(1)
    expect(instance.diffTarget).toBe(2)
    expect(instance.diffSource).toBe(1)
    expect(trailEl.scrollTop).toBe(120)

    // Initial revision vs empty (when full trail is loaded)
    expect(instance.canSelectVersion(2)).toBe(true)
    instance.selectVersion(2)
    expect(instance.diffTarget).toBe(1)
    expect(instance.diffSource).toBe(-1)
    expect(trailEl.scrollTop).toBe(120)
  })

  test('accounts for pinned trail height + 12px clearance on mobile comparison scroll', () => {
    let scrolledTo = null
    let focused = false
    let preventScrollOption = null

    const originalWindow = global.window
    const originalDocument = global.document

    try {
      global.window = {
        scrollY: 150,
        innerWidth: 600,
        scrollTo: opts => {
          scrolledTo = opts
        },
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({
          getPropertyValue: prop => (prop === '--v-layout-top' ? '48px' : '0px')
        })
      }
      global.document = {
        documentElement: {}
      }

      const trailEl = {
        scrollTop: 60,
        getBoundingClientRect: () => ({ height: 200 })
      }
      const headingEl = {
        getBoundingClientRect: () => ({ top: 450 }),
        focus: opts => {
          focused = true
          preventScrollOption = opts?.preventScroll
        }
      }

      const instance = createHistoryInstance({
        $vuetify: { display: { mdAndUp: false, smAndDown: true } },
        $refs: {
          trailContainer: trailEl,
          comparisonHeading: headingEl
        }
      })

      instance.trailScrollTop = 60
      instance.selectVersion(0)

      // clearance = layoutTop (48) + 8 + trailHeight (200) + 12 = 268
      // headingTop = heading.top (450) + window.scrollY (150) = 600
      // expected targetY = headingTop (600) - clearance (268) = 332
      expect(scrolledTo).toEqual({ top: 332, behavior: 'smooth' })
      expect(focused).toBe(true)
      expect(preventScrollOption).toBe(true)
      expect(trailEl.scrollTop).toBe(60)

      // On desktop, selectVersion does not scroll the window
      scrolledTo = null
      global.window.innerWidth = 1200
      instance.$vuetify.display = { mdAndUp: true, smAndDown: false }
      instance.selectVersion(1)
      expect(scrolledTo).toBeNull()
    } finally {
      global.window = originalWindow
      global.document = originalDocument
    }
  })
})

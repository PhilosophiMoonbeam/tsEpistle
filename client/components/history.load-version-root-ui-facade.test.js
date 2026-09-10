import fs from 'node:fs'
import path from 'node:path'
import { onWatcherCleanup, reactive, watch } from 'vue'
const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history sticky timeline and comparison behavior', () => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '')).replace('export default {', 'return {')

  const createHistoryInstance = (overrides = {}, dependencies = {}) => {
    const component = new Function(
      'markRaw',
      'onWatcherCleanup',
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
      onWatcherCleanup,
      {},
      () => '',
      {},
      dependencies.fetchPageHistory ?? {},
      dependencies.fetchPageVersion ?? {},
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
    const selectionState = reactive({
      diffSource: instance.diffSource,
      diffTarget: instance.diffTarget
    })
    Object.defineProperties(instance, {
      diffSource: {
        get: () => selectionState.diffSource,
        set: value => {
          selectionState.diffSource = value
        }
      },
      diffTarget: {
        get: () => selectionState.diffTarget,
        set: value => {
          selectionState.diffTarget = value
        }
      }
    })

    return { component, instance }
  }
  const watchSelections = (component, instance) => {
    const stopSource = watch(
      () => instance.diffSource,
      value => component.watch.diffSource.call(instance, value),
      { flush: 'sync' }
    )
    const stopTarget = watch(
      () => instance.diffTarget,
      value => component.watch.diffTarget.call(instance, value),
      { flush: 'sync' }
    )
    return () => {
      stopSource()
      stopTarget()
    }
  }

  test('toggles diff view mode between line-by-line and side-by-side while preserving trail scroll position', () => {
    const trailEl = { scrollTop: 75 }
    const { instance } = createHistoryInstance({
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
    const { instance } = createHistoryInstance({
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

      const { instance } = createHistoryInstance({
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
  const page = versionId => ({
    versionId,
    content: `version-${versionId}`,
    path: 'home',
    locale: 'en',
    tags: []
  })
  const flushPendingWatch = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  test('keeps the latest source selection when responses resolve out of order', async () => {
    const pending = new Map()
    const fetchPageVersion = vi.fn(
      (_fetch, _pageId, versionId) =>
        new Promise(resolve => {
          pending.set(versionId, resolve)
        })
    )
    const { component, instance } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    const stop = watchSelections(component, instance)

    instance.diffSource = 1
    instance.diffSource = 2
    pending.get(2)(page(2))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(2)

    pending.get(1)(page(1))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(2)
    stop()
  })

  test('keeps the latest target selection when responses resolve out of order', async () => {
    const pending = new Map()
    const fetchPageVersion = vi.fn(
      (_fetch, _pageId, versionId) =>
        new Promise(resolve => {
          pending.set(versionId, resolve)
        })
    )
    const { component, instance } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    const stop = watchSelections(component, instance)

    instance.diffTarget = 3
    instance.diffTarget = 4
    pending.get(4)(page(4))
    await flushPendingWatch()
    expect(instance.target.versionId).toBe(4)

    pending.get(3)(page(3))
    await flushPendingWatch()
    expect(instance.target.versionId).toBe(4)
    stop()
  })

  test('does not commit source or target responses after the selection watchers are stopped on unmount', async () => {
    const pending = new Map()
    const fetchPageVersion = vi.fn(
      (_fetch, _pageId, versionId) =>
        new Promise(resolve => {
          pending.set(versionId, resolve)
        })
    )
    const { component, instance } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    const stop = watchSelections(component, instance)

    instance.diffSource = 5
    instance.diffTarget = 6
    component.beforeUnmount.call(instance)
    stop()

    pending.get(5)(page(5))
    pending.get(6)(page(6))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(0)
    expect(instance.target.versionId).toBe(0)
  })
})

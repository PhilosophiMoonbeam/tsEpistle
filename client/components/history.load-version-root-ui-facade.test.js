import fs from 'node:fs'
import path from 'node:path'
import { onWatcherCleanup, reactive, watch } from 'vue'
import { createPatch as createRealPatch } from 'diff'
import * as RealDiff2Html from 'diff2html'
import { createPinia } from 'pinia'
import { JSDOM } from 'jsdom'
import { loadingStart, loadingStop, setLoading } from '../helpers/root-ui-store.ts'
import { createInstance as createI18nInstance } from 'i18next'
import { afterEach, beforeEach } from '../../server/test/bun-test.mts'

const fixtureSiteConfig = {
  company: '', contentLicense: '', footerOverride: '', banner: {},
  darkMode: false, tocPosition: 'left', title: 'Test', logoUrl: '',
  product: { name: 'Test', version: '1.0.0' }
}
const installSiteConfig = () => {
  const browserWindow = global.window
  const descriptor = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
  Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, value: fixtureSiteConfig })
  return () => {
    if (descriptor) Object.defineProperty(browserWindow, 'siteConfig', descriptor)
    else Reflect.deleteProperty(browserWindow, 'siteConfig')
  }
}
let useWikiStore
const restoreImportConfig = installSiteConfig()
try {
  ;({ useWikiStore } = await import('../store/index.ts'))
} finally {
  restoreImportConfig()
}
const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history revision list and comparison behavior', () => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '')).replace('export default {', 'return {')
  let restoreSiteConfig
  const ownedInstances = []
  const ownedWatchers = []
  beforeEach(() => { restoreSiteConfig = installSiteConfig() })
  afterEach(() => {
    try {
      for (const stop of ownedWatchers.splice(0)) stop()
      for (const { component, instance, wikiStore } of ownedInstances.splice(0)) {
        if (!instance.isUnmounted) component.beforeUnmount.call(instance)
        wikiStore.$dispose?.()
      }
    } finally {
      restoreSiteConfig?.()
    }
  })

  const createHistoryInstance = (overrides = {}, dependencies = {}) => {
    const wikiStore = dependencies.wikiStore ?? useWikiStore(createPinia())
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
      value => value,
      onWatcherCleanup,
      dependencies.Diff2Html ?? { html: () => '' },
      dependencies.createPatch ?? (() => ''),
      {},
      dependencies.fetchPageHistory ?? {},
      dependencies.fetchPageVersion ?? {},
      dependencies.restorePageVersion ?? {},
      () => '',
      () => '',
      dependencies.getErrorMessage ?? (error => (error instanceof Error ? error.message : String(error))),
      dependencies.loadingStart ?? loadingStart,
      dependencies.loadingStop ?? loadingStop,
      dependencies.setLoading ?? setLoading,
      dependencies.showNotification ?? (() => {}),
      wikiStore,
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
      $helpers: { formatMoment: value => value },
      $refs: {},
      $el: {},
      ...overrides
    }

    for (const [name, method] of Object.entries(component.methods)) {
      instance[name] = method.bind(instance)
    }
    for (const [name, computed] of Object.entries(component.computed)) {
      Object.defineProperty(instance, name, {
        configurable: true,
        get: () => computed.call(instance)
      })
    }
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

    ownedInstances.push({ component, instance, wikiStore })
    return { component, instance, wikiStore }
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
    const stop = () => {
      stopSource()
      stopTarget()
    }
    ownedWatchers.push(stop)
    return stop
  }

  const page = versionId => ({
    versionId,
    content: `version-${versionId}`,
    contentType: 'markdown',
    title: `Version ${versionId}`,
    description: '',
    editor: 'markdown',
    locale: 'en',
    path: 'home',
    tags: [],
    versionDate: '2026-09-07T10:00:00Z',
    visibility: 'public'
  })
  const trailItem = (versionId, actionType = 'edit') => ({
    versionId,
    authorId: 1,
    authorName: 'TestAuthor',
    actionType,
    valueBefore: null,
    valueAfter: null,
    versionDate: `2026-09-0${versionId}T10:00:00Z`
  })
  const flushPendingWatch = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const seedUnrelatedOwner = store => store.startLoading('unrelated-reader')
  const expectHistoryOwners = (store, count) => {
    expect(store.loadingCounts['unrelated-reader']).toBe(1)
    const historyOwners = Object.entries(store.loadingCounts)
      .filter(([name]) => name !== 'unrelated-reader')
      .reduce((total, [, owners]) => total + owners, 0)
    expect(historyOwners).toBe(count)
    expect(store.isLoading).toBe(true)
  }
  const releaseUnrelatedOwner = store => {
    store.stopLoading('unrelated-reader')
    expect(store.isLoading).toBe(false)
  }

  test('uses explicit comparison format choices and preserves trail scroll position', () => {
    const trailEl = { scrollTop: 0 }
    const { instance } = createHistoryInstance({
      $refs: { trailContainer: trailEl },
      source: { ...page(1), content: 'Original paragraph\n' },
      target: { ...page(2), content: 'Updated paragraph\n' },
      sourceReady: true,
      targetReady: true,
      diffSource: 1,
      diffTarget: 2
    }, { createPatch: createRealPatch, Diff2Html: RealDiff2Html })

    instance.trailScrollTop = 75

    instance.setViewMode('side-by-side')
    expect(instance.viewMode).toBe('side-by-side')
    expect(trailEl.scrollTop).toBe(75)
    const sideBySide = JSDOM.fragment(instance.diffHTML)
    expect(sideBySide.querySelectorAll('.d2h-file-side-diff')).toHaveLength(2)
    expect(sideBySide.querySelector('.d2h-file-diff')).toBeNull()

    trailEl.scrollTop = 0
    instance.setViewMode('line-by-line')
    expect(instance.viewMode).toBe('line-by-line')
    expect(trailEl.scrollTop).toBe(75)
    const unified = JSDOM.fragment(instance.diffHTML)
    expect(unified.querySelectorAll('.d2h-file-diff')).toHaveLength(1)
    expect(unified.querySelector('.d2h-file-side-diff')).toBeNull()
  })

  test('supports live, historical, and initial-empty comparison selections', () => {
    const trailEl = { scrollTop: 0 }
    const { instance } = createHistoryInstance({
      $refs: { trailContainer: trailEl }
    })

    instance.trailScrollTop = 120

    expect(instance.canSelectVersion(0)).toBe(true)
    instance.selectVersion(0)
    expect(instance.diffTarget).toBe(0)
    expect(instance.diffSource).toBe(2)
    expect(trailEl.scrollTop).toBe(120)

    expect(instance.canSelectVersion(1)).toBe(true)
    trailEl.scrollTop = 0
    instance.selectVersion(1)
    expect(instance.diffTarget).toBe(2)
    expect(instance.diffSource).toBe(1)
    expect(trailEl.scrollTop).toBe(120)

    expect(instance.canSelectVersion(2)).toBe(true)
    trailEl.scrollTop = 0
    instance.selectVersion(2)
    expect(instance.diffTarget).toBe(1)
    expect(instance.diffSource).toBe(-1)
    expect(trailEl.scrollTop).toBe(120)
  })

  test('scrolls mobile revision selections to the comparison and preserves the trail position', () => {
    const originalWindow = global.window
    const originalDocument = global.document
    let scrolledTo = null
    let focusedWith = null

    try {
      global.window = {
        siteConfig: fixtureSiteConfig,
        scrollY: 150,
        innerWidth: 600,
        scrollTo: options => {
          scrolledTo = options
        },
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({
          getPropertyValue: property => (property === '--v-layout-top' ? '48px' : '0px')
        })
      }
      global.document = { documentElement: {} }

      const trailEl = { scrollTop: 0 }
      const headingEl = {
        getBoundingClientRect: () => ({ top: 450 }),
        focus: options => {
          focusedWith = options
        }
      }
      const { instance } = createHistoryInstance({
        $refs: { trailContainer: trailEl, comparisonHeading: headingEl }
      })

      instance.trailScrollTop = 60
      instance.selectVersion(0)

      expect(instance.diffTarget).toBe(0)
      expect(instance.diffSource).toBe(2)
      expect(scrolledTo).toEqual({ top: 540, behavior: 'smooth' })
      expect(focusedWith).toEqual({ preventScroll: true })
      expect(trailEl.scrollTop).toBe(60)

      scrolledTo = null
      global.window.innerWidth = 1200
      trailEl.scrollTop = 0
      instance.selectVersion(1)
      expect(scrolledTo).toBeNull()
      expect(trailEl.scrollTop).toBe(60)
    } finally {
      global.window = originalWindow
      global.document = originalDocument
    }
  })

  test('keeps the latest source selection when responses resolve out of order and balances version loading', async () => {
    const pending = new Map()
    const fetchPageVersion = vi.fn(
      (_fetch, _pageId, versionId) =>
        new Promise(resolve => {
          pending.set(versionId, resolve)
        })
    )
    const { component, instance, wikiStore } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    seedUnrelatedOwner(wikiStore)
    const stop = watchSelections(component, instance)

    instance.diffSource = 1
    instance.diffSource = 2
    expectHistoryOwners(wikiStore, 2)
    pending.get(1)(page(1))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(0)
    expect(instance.sourceLoading).toBe(true)
    expectHistoryOwners(wikiStore, 1)

    pending.get(2)(page(2))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(2)
    expect(instance.sourceLoading).toBe(false)
    expectHistoryOwners(wikiStore, 0)
    releaseUnrelatedOwner(wikiStore)
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
    const { component, instance, wikiStore } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    seedUnrelatedOwner(wikiStore)
    const stop = watchSelections(component, instance)

    instance.diffSource = 5
    instance.diffTarget = 6
    expect(instance.sourceLoading).toBe(true)
    expect(instance.targetLoading).toBe(true)
    expectHistoryOwners(wikiStore, 2)
    const sourceSignal = instance.sourceVersionController.signal
    const targetSignal = instance.targetVersionController.signal
    component.beforeUnmount.call(instance)
    stop()
    expect(sourceSignal.aborted).toBe(true)
    expect(targetSignal.aborted).toBe(true)

    pending.get(5)(page(5))
    await flushPendingWatch()
    expectHistoryOwners(wikiStore, 1)
    pending.get(6)(page(6))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(0)
    expect(instance.target.versionId).toBe(0)
    expect(instance.sourceReady).toBe(false)
    expect(instance.targetReady).toBe(false)
    expect(instance.source.content).toBe('')
    expect(instance.target.content).toBe('')
    expect(instance.cache).toEqual([])
    expectHistoryOwners(wikiStore, 0)
    releaseUnrelatedOwner(wikiStore)
  })

  test('keeps the latest authoritative history refresh and loading state when responses resolve out of order', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const { instance, wikiStore } = createHistoryInstance({ trail: [], cache: [] }, { fetchPageHistory })
    seedUnrelatedOwner(wikiStore)

    const first = instance.loadHistory()
    const second = instance.loadHistory()
    expect(fetchPageHistory).toHaveBeenCalledTimes(2)
    expect(pending[0].offsetSize).toBe(25)
    expect(pending[1].offsetSize).toBe(25)
    expectHistoryOwners(wikiStore, 2)

    pending[0].resolve({ total: 1, trail: [trailItem(2)] })
    expect(await first).toBe(false)
    expect(instance.trail).toEqual([])
    expect(instance.trailLoading).toBe(true)
    expectHistoryOwners(wikiStore, 1)

    pending[1].resolve({ total: 1, trail: [trailItem(3)] })
    expect(await second).toBe(true)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(false)
    expectHistoryOwners(wikiStore, 0)
    releaseUnrelatedOwner(wikiStore)
  })

  test('allows consecutive history pages after a successful load', async () => {
    const fetchPageHistory = vi
      .fn()
      .mockResolvedValueOnce({ total: 3, trail: [trailItem(2)] })
      .mockResolvedValueOnce({ total: 3, trail: [trailItem(1, 'initial')] })
    const { instance } = createHistoryInstance(
      {
        trailLoaded: true,
        trailLoading: false,
        total: 3,
        trail: [trailItem(3)],
        offsetPage: 0
      },
      { fetchPageHistory }
    )

    expect(await instance.loadMore()).toBe(true)
    expect(instance.loadingMore).toBe(false)
    expect(await instance.loadMore()).toBe(true)
    expect(instance.loadingMore).toBe(false)
    expect(instance.trail.map(item => item.versionId)).toEqual([3, 2, 1])
    expect(instance.offsetPage).toBe(2)
  })

  test('balances pagination and refresh loading when refresh supersedes pagination', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const { instance, wikiStore } = createHistoryInstance(
      {
        trailLoaded: true,
        trail: [trailItem(3)],
        trailLoading: false,
        total: 3,
        offsetPage: 0,
        cache: []
      },
      { fetchPageHistory }
    )
    seedUnrelatedOwner(wikiStore)

    const more = instance.loadMore()
    const refresh = instance.loadHistory()
    expect(fetchPageHistory).toHaveBeenCalledTimes(2)
    expect(pending[0].offsetPage).toBe(1)
    expect(pending[1].offsetPage).toBe(0)
    expectHistoryOwners(wikiStore, 2)

    pending[0].resolve({ total: 3, trail: [trailItem(2)] })
    expect(await more).toBe(false)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(true)
    expectHistoryOwners(wikiStore, 1)

    pending[1].resolve({ total: 3, trail: [trailItem(3)] })
    expect(await refresh).toBe(true)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(false)
    expectHistoryOwners(wikiStore, 0)
    releaseUnrelatedOwner(wikiStore)
  })

  test('releases history refresh ownership on unmount without publishing late revisions', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const { component, instance, wikiStore } = createHistoryInstance({ trail: [], cache: [] }, { fetchPageHistory })
    seedUnrelatedOwner(wikiStore)

    const first = instance.loadHistory()
    const second = instance.loadHistory()
    expect(instance.trailLoading).toBe(true)
    expectHistoryOwners(wikiStore, 2)
    component.beforeUnmount.call(instance)

    pending[0].resolve({ total: 1, trail: [trailItem(2)] })
    expect(await first).toBe(false)
    expectHistoryOwners(wikiStore, 1)
    pending[1].resolve({ total: 1, trail: [trailItem(3)] })
    expect(await second).toBe(false)
    expect(instance.trail).toEqual([])
    expectHistoryOwners(wikiStore, 0)
    releaseUnrelatedOwner(wikiStore)
  })

  test('releases restore ownership on unmount without late notification or navigation', async () => {
    const originalWindow = global.window
    let resolveRestore
    let restoreSignal
    const notifications = vi.fn()
    const setTimeout = vi.fn()
    const assign = vi.fn()
    const i18n = createI18nInstance()
    await i18n.init({
      lng: 'en',
      resources: { en: { history: { restore: { success: 'Revision restored' } } } }
    })
    try {
      global.window = {
        siteConfig: fixtureSiteConfig,
        fetch: (_url, init) => {
          restoreSignal = init.signal
          return new Promise(resolve => { resolveRestore = resolve })
        },
        setTimeout,
        clearTimeout: vi.fn(),
        location: { assign }
      }
      const restorePageVersion = fetch => fetch('/restore', {})
      const { component, instance, wikiStore } = createHistoryInstance({
        $t: i18n.t.bind(i18n),
        isRestoreConfirmDialogShown: true
      }, { restorePageVersion, showNotification: notifications })
      seedUnrelatedOwner(wikiStore)

      const restore = instance.restoreConfirm()
      expect(instance.restoreLoading).toBe(true)
      expectHistoryOwners(wikiStore, 1)
      expect(restoreSignal.aborted).toBe(false)
      component.beforeUnmount.call(instance)
      expect(restoreSignal.aborted).toBe(true)
      resolveRestore()

      await restore
      expectHistoryOwners(wikiStore, 0)
      releaseUnrelatedOwner(wikiStore)
      expect(notifications).not.toHaveBeenCalled()
      expect(setTimeout).not.toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()
      expect(instance.isRestoreConfirmDialogShown).toBe(true)
    } finally {
      global.window = originalWindow
    }
  })

  test('blocks concurrent pagination and deduplicates overlapping revision IDs', async () => {
    let resolvePage
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise(resolve => {
          expect(offsetPage).toBe(1)
          expect(offsetSize).toBe(25)
          resolvePage = resolve
        })
    )
    const { instance } = createHistoryInstance(
      {
        trailLoaded: true,
        trail: [trailItem(3)],
        trailLoading: false,
        total: 3,
        offsetPage: 0,
        cache: []
      },
      { fetchPageHistory }
    )

    const first = instance.loadMore()
    const second = instance.loadMore()
    expect(fetchPageHistory).toHaveBeenCalledTimes(1)
    expect(await second).toBe(false)

    resolvePage({ total: 3, trail: [trailItem(3), trailItem(2), trailItem(2)] })
    expect(await first).toBe(true)
    expect(instance.trail.map(item => item.versionId)).toEqual([3, 2])
  })

  test('surfaces pagination failures without dropping existing revisions and retries the same page', async () => {
    const fetchPageHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('Older revisions unavailable'))
      .mockResolvedValueOnce({ total: 2, trail: [trailItem(2)] })
    const { instance } = createHistoryInstance(
      {
        trailLoaded: true,
        trail: [trailItem(3)],
        total: 2,
        trailLoading: false,
        offsetPage: 0,
        cache: []
      },
      { fetchPageHistory }
    )

    expect(await instance.loadMore()).toBe(false)
    expect(instance.paginationError).toBe('Older revisions unavailable')
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.loadingMore).toBe(false)
    expect(instance.offsetPage).toBe(0)

    expect(await instance.loadMore()).toBe(true)
    expect(instance.paginationError).toBe('')
    expect(instance.trail.map(item => item.versionId)).toEqual([3, 2])
    expect(fetchPageHistory.mock.calls.map(([, , offset]) => offset)).toEqual([1, 1])
    expect(instance.offsetPage).toBe(1)
  })

  test('keeps failed revisions out of comparison and reports the error on either side', async () => {
    for (const side of ['source', 'target']) {
      const fetchPageVersion = vi.fn().mockRejectedValue(new Error('Revision was removed'))
      const overrides = side === 'target' ? { cache: [], source: page(2), sourceReady: true, diffSource: 2 } : { cache: [] }
      const { component, instance } = createHistoryInstance(overrides, { fetchPageVersion })
      const stop = watchSelections(component, instance)

      instance[side === 'source' ? 'diffSource' : 'diffTarget'] = 1
      await flushPendingWatch()

      expect(instance[`${side}Ready`]).toBe(false)
      expect(instance[`${side}Error`]).toBe('Revision was removed')
      expect(instance[side === 'source' ? 'targetError' : 'sourceError']).toBe('')
      expect(component.computed.comparisonLoading.call(instance)).toBe(false)
      expect(component.computed.comparisonReady.call(instance)).toBe(false)
      expect(component.computed.diffHTML.call(instance)).toBe('')
      stop()
    }
  })

  test('reports oversized comparisons instead of invoking the diff renderer', () => {
    const createPatch = vi.fn(() => 'should not be called')
    const { component, instance } = createHistoryInstance(
      {
        source: { ...page(1), content: 'a'.repeat(1_000_001) },
        target: { ...page(2), content: 'b' },
        sourceReady: true,
        targetReady: true,
        diffSource: 1,
        diffTarget: 2
      },
      { createPatch }
    )

    expect(component.computed.comparisonError.call(instance)).toContain('too large')
    expect(component.computed.diffHTML.call(instance)).toBe('')
    expect(createPatch).not.toHaveBeenCalled()
  })

  test('bounds wholly changed revisions below the input size limits', () => {
    const Diff2Html = { html: vi.fn() }
    const { instance } = createHistoryInstance(
      {
        source: { ...page(1), content: Array.from({ length: 18_000 }, (_, index) => `old${index}\n`).join('') },
        target: { ...page(2), content: Array.from({ length: 18_000 }, (_, index) => `new${index}\n`).join('') },
        sourceReady: true,
        targetReady: true,
        diffSource: 1,
        diffTarget: 2
      },
      { createPatch: createRealPatch, Diff2Html }
    )

    const started = performance.now()
    const result = instance.diffResult
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.error).toContain('View Source or Download Version')
    expect(result.html).toBe('')
    expect(Diff2Html.html).not.toHaveBeenCalled()
  })

  test('caps rendered patch rows before building a large DOM', () => {
    const Diff2Html = { html: vi.fn() }
    const { instance } = createHistoryInstance(
      {
        source: page(1),
        target: page(2),
        sourceReady: true,
        targetReady: true,
        diffSource: 1,
        diffTarget: 2
      },
      { createPatch: () => '+changed\n'.repeat(4_001), Diff2Html }
    )

    expect(instance.diffResult.error).toContain('too large')
    expect(Diff2Html.html).not.toHaveBeenCalled()
  })

  test('renders ordinary revisions and limits expensive line matching for larger patches', () => {
    const html = vi.fn(RealDiff2Html.html)
    const { instance } = createHistoryInstance(
      {
        source: { ...page(1), content: 'Original paragraph\n' },
        target: { ...page(2), content: 'Updated paragraph\n' },
        sourceReady: true,
        targetReady: true,
        diffSource: 1,
        diffTarget: 2
      },
      { createPatch: createRealPatch, Diff2Html: { html } }
    )

    expect(instance.diffResult.html).toContain('d2h-ins')
    expect(html.mock.calls[0][1].matching).toBe('lines')
    instance.target.content = 'Updated paragraph\n'.repeat(250)
    expect(instance.diffResult.html).toContain('d2h-ins')
    expect(html.mock.calls[1][1].matching).toBe('none')
    expect(html.mock.calls[1][1].maxLineLengthHighlight).toBe(0)
  })

  test('avoids unbounded word comparisons within long changed lines', () => {
    const { instance } = createHistoryInstance(
      {
        source: { ...page(1), content: 'old '.repeat(2_000) },
        target: { ...page(2), content: 'new '.repeat(2_000) },
        sourceReady: true,
        targetReady: true,
        diffSource: 1,
        diffTarget: 2
      },
      { createPatch: createRealPatch, Diff2Html: RealDiff2Html }
    )

    const started = performance.now()
    const result = instance.diffResult
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.error).toBe('')
    expect(result.html).toContain('d2h-ins')
  })
})

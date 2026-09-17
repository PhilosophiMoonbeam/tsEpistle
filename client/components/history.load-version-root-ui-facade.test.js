import fs from 'node:fs'
import path from 'node:path'
import { onWatcherCleanup, reactive, watch } from 'vue'
const source = fs.readFileSync(path.join(process.cwd(), 'client/components/history.vue'), 'utf8')

describe('history revision list and comparison behavior', () => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '')).replace('export default {', 'return {')

  const createHistoryInstance = (overrides = {}, dependencies = {}) => {
    const wikiStore = dependencies.wikiStore ?? { page: {} }
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
      dependencies.loadingStart ?? (() => {}),
      dependencies.loadingStop ?? (() => {}),
      dependencies.setLoading ?? (() => {}),
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
    return () => {
      stopSource()
      stopTarget()
    }
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

  test('uses explicit comparison format choices and preserves trail scroll position', () => {
    const trailEl = { scrollTop: 75 }
    const { instance } = createHistoryInstance({
      $refs: { trailContainer: trailEl }
    })

    instance.trailScrollTop = 75
    expect(instance.viewMode).toBe('line-by-line')

    instance.setViewMode('side-by-side')
    expect(instance.viewMode).toBe('side-by-side')
    expect(trailEl.scrollTop).toBe(75)

    instance.setViewMode('line-by-line')
    expect(instance.viewMode).toBe('line-by-line')
    expect(trailEl.scrollTop).toBe(75)
  })

  test('supports live, historical, and initial-empty comparison selections', () => {
    const trailEl = { scrollTop: 120 }
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
    instance.selectVersion(1)
    expect(instance.diffTarget).toBe(2)
    expect(instance.diffSource).toBe(1)
    expect(trailEl.scrollTop).toBe(120)

    expect(instance.canSelectVersion(2)).toBe(true)
    instance.selectVersion(2)
    expect(instance.diffTarget).toBe(1)
    expect(instance.diffSource).toBe(-1)
    expect(trailEl.scrollTop).toBe(120)
  })

  test('resolves component refs through their actual DOM elements', () => {
    const element = { scrollTop: 20, getBoundingClientRect: () => ({ top: 10, height: 30 }) }
    const { instance } = createHistoryInstance()

    expect(instance.resolveElementRef({ $el: element })).toBe(element)
    expect(instance.resolveElementRef(element)).toBe(element)
  })

  test('keeps the latest source selection when responses resolve out of order and balances version loading', async () => {
    const pending = new Map()
    const fetchPageVersion = vi.fn(
      (_fetch, _pageId, versionId) =>
        new Promise(resolve => {
          pending.set(versionId, resolve)
        })
    )
    const loadingStart = vi.fn()
    const loadingStop = vi.fn()
    const { component, instance, wikiStore } = createHistoryInstance({ cache: [] }, { fetchPageVersion, loadingStart, loadingStop })
    const stop = watchSelections(component, instance)

    instance.diffSource = 1
    instance.diffSource = 2
    pending.get(1)(page(1))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(0)
    expect(instance.sourceLoading).toBe(true)

    pending.get(2)(page(2))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(2)
    expect(instance.sourceLoading).toBe(false)
    expect(loadingStart).toHaveBeenNthCalledWith(1, wikiStore, 'history-version-1')
    expect(loadingStart).toHaveBeenNthCalledWith(2, wikiStore, 'history-version-2')
    expect(loadingStop).toHaveBeenNthCalledWith(1, wikiStore, 'history-version-1')
    expect(loadingStop).toHaveBeenNthCalledWith(2, wikiStore, 'history-version-2')
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
    const loadingStart = vi.fn()
    const loadingStop = vi.fn()
    const { component, instance, wikiStore } = createHistoryInstance({ cache: [] }, { fetchPageVersion, loadingStart, loadingStop })
    const stop = watchSelections(component, instance)

    instance.diffSource = 5
    instance.diffTarget = 6
    expect(instance.sourceLoading).toBe(true)
    expect(instance.targetLoading).toBe(true)
    component.beforeUnmount.call(instance)
    stop()

    pending.get(5)(page(5))
    pending.get(6)(page(6))
    await flushPendingWatch()
    expect(instance.source.versionId).toBe(0)
    expect(instance.target.versionId).toBe(0)
    expect(instance.sourceLoading).toBe(true)
    expect(instance.targetLoading).toBe(true)
    expect(loadingStart).toHaveBeenNthCalledWith(1, wikiStore, 'history-version-5')
    expect(loadingStart).toHaveBeenNthCalledWith(2, wikiStore, 'history-version-6')
    expect(loadingStop).toHaveBeenNthCalledWith(1, wikiStore, 'history-version-5')
    expect(loadingStop).toHaveBeenNthCalledWith(2, wikiStore, 'history-version-6')
  })

  test('keeps the latest authoritative history refresh and loading state when responses resolve out of order', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const setLoading = vi.fn()
    const { instance, wikiStore } = createHistoryInstance({ trail: [], cache: [] }, { fetchPageHistory, setLoading })

    const first = instance.loadHistory()
    const second = instance.loadHistory()
    expect(fetchPageHistory).toHaveBeenCalledTimes(2)
    expect(pending[0].offsetSize).toBe(25)
    expect(pending[1].offsetSize).toBe(25)

    pending[0].resolve({ total: 1, trail: [trailItem(2)] })
    expect(await first).toBe(false)
    expect(instance.trail).toEqual([])
    expect(instance.trailLoading).toBe(true)

    pending[1].resolve({ total: 1, trail: [trailItem(3)] })
    expect(await second).toBe(true)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(false)
    expect(setLoading).toHaveBeenNthCalledWith(1, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(2, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(3, wikiStore, 'history-trail-refresh', false)
    expect(setLoading).toHaveBeenNthCalledWith(4, wikiStore, 'history-trail-refresh', false)
  })

  test('balances pagination and refresh loading when refresh supersedes pagination', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const setLoading = vi.fn()
    const { instance, wikiStore } = createHistoryInstance(
      {
        trailLoaded: true,
        trail: [trailItem(3)],
        trailLoading: false,
        total: 3,
        offsetPage: 0,
        cache: []
      },
      { fetchPageHistory, setLoading }
    )

    const more = instance.loadMore()
    const refresh = instance.loadHistory()
    expect(fetchPageHistory).toHaveBeenCalledTimes(2)
    expect(pending[0].offsetPage).toBe(1)
    expect(pending[1].offsetPage).toBe(0)

    pending[0].resolve({ total: 3, trail: [trailItem(2)] })
    expect(await more).toBe(false)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(true)

    pending[1].resolve({ total: 3, trail: [trailItem(3)] })
    expect(await refresh).toBe(true)
    expect(instance.trail.map(item => item.versionId)).toEqual([3])
    expect(instance.trailLoading).toBe(false)
    expect(setLoading).toHaveBeenNthCalledWith(1, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(2, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(3, wikiStore, 'history-trail-refresh', false)
    expect(setLoading).toHaveBeenNthCalledWith(4, wikiStore, 'history-trail-refresh', false)
  })

  test('balances history refresh loading on unmount without clearing in-flight state', async () => {
    const pending = []
    const fetchPageHistory = vi.fn(
      (_fetch, _pageId, offsetPage, offsetSize) =>
        new Promise((resolve, reject) => {
          pending.push({ offsetPage, offsetSize, resolve, reject })
        })
    )
    const setLoading = vi.fn()
    const { component, instance, wikiStore } = createHistoryInstance({ trail: [], cache: [] }, { fetchPageHistory, setLoading })

    const first = instance.loadHistory()
    const second = instance.loadHistory()
    expect(instance.trailLoading).toBe(true)
    component.beforeUnmount.call(instance)

    pending[0].resolve({ total: 1, trail: [trailItem(2)] })
    pending[1].resolve({ total: 1, trail: [trailItem(3)] })
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(instance.trail).toEqual([])
    expect(instance.trailLoading).toBe(true)
    expect(setLoading).toHaveBeenNthCalledWith(1, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(2, wikiStore, 'history-trail-refresh', true)
    expect(setLoading).toHaveBeenNthCalledWith(3, wikiStore, 'history-trail-refresh', false)
    expect(setLoading).toHaveBeenNthCalledWith(4, wikiStore, 'history-trail-refresh', false)
  })

  test('balances restore loading on unmount without clearing the in-flight flag', async () => {
    let resolveRestore
    const restorePageVersion = vi.fn(
      () =>
        new Promise(resolve => {
          resolveRestore = resolve
        })
    )
    const loadingStart = vi.fn()
    const loadingStop = vi.fn()
    const { component, instance, wikiStore } = createHistoryInstance({}, { restorePageVersion, loadingStart, loadingStop })

    const restore = instance.restoreConfirm()
    expect(instance.restoreLoading).toBe(true)
    component.beforeUnmount.call(instance)
    resolveRestore()

    await restore
    expect(instance.restoreLoading).toBe(true)
    expect(loadingStart).toHaveBeenCalledWith(wikiStore, 'history-restore')
    expect(loadingStop).toHaveBeenCalledWith(wikiStore, 'history-restore')
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
    expect(new Set(instance.trail.map(item => item.versionId)).size).toBe(instance.trail.length)
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

    expect(await instance.loadMore()).toBe(true)
    expect(instance.paginationError).toBe('')
    expect(instance.trail.map(item => item.versionId)).toEqual([3, 2])
  })

  test('keeps a failed revision read out of the comparison and exposes a side-specific retry state', async () => {
    const fetchPageVersion = vi.fn().mockRejectedValue(new Error('Revision was removed'))
    const { component, instance } = createHistoryInstance({ cache: [] }, { fetchPageVersion })
    const stop = watchSelections(component, instance)

    instance.diffSource = 1
    await flushPendingWatch()

    expect(instance.sourceReady).toBe(false)
    expect(instance.sourceError).toBe('Revision was removed')
    expect(component.computed.comparisonReady.call(instance)).toBe(false)
    expect(component.computed.diffHTML.call(instance)).toBe('')
    stop()
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
})

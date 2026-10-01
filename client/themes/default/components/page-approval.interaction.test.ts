import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { computed, effectScope, nextTick, reactive, watch } from 'vue'
import type { EffectScope } from 'vue'

type FetchCall = [input: RequestInfo | URL, init?: RequestInit]
type ApprovalAction = 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign'
type PageApprovalVm = {
  pageId: number
  sourceRevision: string
  approvalLoading: boolean
  approvalInitialLoading: boolean
  pageApproval: { id: string; assigneeId?: number } | null
  hasWritePagesPermission: boolean
  approvalAssigneeId: number | null
  approvalComment: string
  approvalError: string
  pageOnlineActionReady: boolean
  approvalActionReady: boolean
  approvalAuthorityReady: boolean
  approvalAuthorityReadyKey: string | null
  approvalResourceKey: string
  approvalAuthorityContextKey: string
  pageAuthorityKey: string
  pageActionGeneration: number
  approvalRequestId: number
  approvalMutationId: number
  submitPageApproval: () => Promise<void>
  transitionPageApproval: (action: ApprovalAction) => Promise<void>
  approvalResponseError: (response: Response, fallback: string) => Promise<Error>
  loadPageApproval: () => Promise<boolean>
  isCurrentPageAction: (pageId: number, generation: number, requestId: number, currentRequestId: number) => boolean
  isCurrentApprovalAuthority: (pageId: number, generation: number, requestId: number, authorityKey: string | null) => boolean
  $t: (key: string) => string
}

const graphErrors: unknown[] = []
const successNotifications: unknown[] = []
const notificationsRefresh = vi.fn(async () => {})
const useSiteNotificationsStore = () => ({ refresh: notificationsRefresh })
const pushGraphError = (_store: unknown, error: unknown): void => {
  graphErrors.push(error)
}
const showNotification = (_store: unknown, notification: unknown): void => {
  successNotifications.push(notification)
}
const wikiStore = {}

const componentStub = {}

const componentPath = path.join(process.cwd(), 'client/themes/default/components/page.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const script = componentSource.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('page.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, '').replace('export default defineComponent({', 'const pageComponent = defineComponent({') +
    '\nreturn pageComponent'
)

const componentOptions = new Function(
  'defineComponent',
  'h',
  'markRaw',
  'mergeProps',
  'useGoTo',
  'i18next',
  'AsyncState',
  'PageBrandingMark',
  'StatusIndicator',
  'SiteBanner',
  'NavSidebar',
  'Prism',
  'ClipboardJS',
  'wikiStore',
  'useSiteNotificationsStore',
  'pushGraphError',
  'showNotification',
  executableScript
)(
  (options: unknown) => options,
  () => ({}),
  <Value>(value: Value): Value => value,
  (...values: unknown[]) => Object.assign({}, ...values),
  () => () => {},
  { t: () => '' },
  componentStub,
  componentStub,
  componentStub,
  componentStub,
  componentStub,
  { plugins: { toolbar: { registerButton: () => {} } } },
  class ClipboardJS {},
  wikiStore,
  useSiteNotificationsStore,
  pushGraphError,
  showNotification
) as {
  computed: {
    approvalResourceKey: (this: PageApprovalVm) => string
    approvalAuthorityContextKey: (this: PageApprovalVm) => string
    approvalActionReady: (this: PageApprovalVm) => boolean
  }
  watch: {
    approvalResourceKey: (this: PageApprovalVm, value: string, previous: string) => void
  }
  methods: {
    submitPageApproval: (this: PageApprovalVm) => Promise<void>
    transitionPageApproval: (this: PageApprovalVm, action: ApprovalAction) => Promise<void>
    approvalResponseError: (this: PageApprovalVm, response: Response, fallback: string) => Promise<Error>
    loadPageApproval: (this: PageApprovalVm) => Promise<boolean>
    isCurrentPageAction: (this: PageApprovalVm, pageId: number, generation: number, requestId: number, currentRequestId: number) => boolean
    isCurrentApprovalAuthority: (this: PageApprovalVm, pageId: number, generation: number, requestId: number, authorityKey: string | null) => boolean
  }
}

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const scopes: EffectScope[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

const makeVm = (overrides: Partial<PageApprovalVm> = {}): PageApprovalVm => {
  const vm = reactive({
    pageId: 42,
    sourceRevision: '17',
    approvalLoading: false,
    approvalInitialLoading: false,
    pageApproval: { id: 'approval-42' },
    hasWritePagesPermission: true,
    approvalAssigneeId: 9,
    approvalComment: '  Keep the rendered note  ',
    approvalError: '',
    pageOnlineActionReady: true,
    approvalAuthorityReady: true,
    approvalAuthorityReadyKey: null,
    pageAuthorityKey: 'actor:online',
    pageActionGeneration: 1,
    approvalRequestId: 1,
    approvalMutationId: 0,
    approvalResponseError: async (_response: Response, _fallback: string) => new Error('unbound'),
    loadPageApproval: vi.fn(async () => true),
    isCurrentPageAction: () => true,
    isCurrentApprovalAuthority: () => true,
    $t: (key: string) => key,
    ...overrides
  }) as unknown as PageApprovalVm
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => {
    for (const key of ['approvalResourceKey', 'approvalAuthorityContextKey', 'approvalActionReady'] as const) {
      const value = computed(() => componentOptions.computed[key].call(vm))
      Object.defineProperty(vm, key, { get: () => value.value })
    }
    if (vm.approvalAuthorityReady && !Object.hasOwn(overrides, 'approvalAuthorityReadyKey')) {
      vm.approvalAuthorityReadyKey = vm.approvalAuthorityContextKey
    }
    watch(
      () => vm.approvalResourceKey,
      (value, previous) => componentOptions.watch.approvalResourceKey.call(vm, value, previous)
    )
  })
  vm.approvalResponseError = componentOptions.methods.approvalResponseError.bind(vm)
  vm.isCurrentPageAction = componentOptions.methods.isCurrentPageAction.bind(vm)
  vm.isCurrentApprovalAuthority = componentOptions.methods.isCurrentApprovalAuthority.bind(vm)
  vm.submitPageApproval = componentOptions.methods.submitPageApproval.bind(vm)
  vm.transitionPageApproval = componentOptions.methods.transitionPageApproval.bind(vm)
  return vm
}

describe('reader page approval submission', () => {
  it('sends the revision rendered with the page even when the prop changes while the request is pending', async () => {
    graphErrors.length = 0
    successNotifications.length = 0
    notificationsRefresh.mockClear()
    const request = deferred<Response>()
    const calls: FetchCall[] = []
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return request.promise
    })
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as typeof fetch
    try {
      const vm = makeVm()
      const submission = vm.submitPageApproval()
      vm.sourceRevision = '18'
      await nextTick()
      request.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await submission

      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
        expectedSourceRevision: '17',
        assigneeId: 9,
        comment: 'Keep the rendered note'
      })
      expect(calls[0]?.[1]?.method).toBe('POST')
      expect(vm.loadPageApproval).not.toHaveBeenCalled()
      expect(vm.approvalComment).toBe('  Keep the rendered note  ')
      expect(graphErrors).toHaveLength(0)
      expect(successNotifications).toHaveLength(0)
      expect(notificationsRefresh).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('keeps the comment and reports a stale conflict without success or automatic reload', async () => {
    graphErrors.length = 0
    successNotifications.length = 0
    notificationsRefresh.mockClear()
    const staleError = new Response(JSON.stringify({ error: 'Page changed after it was rendered' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' }
    })
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => staleError) as typeof fetch
    try {
      const vm = makeVm()
      vm.approvalError = 'Existing approval error'
      const submission = componentOptions.methods.submitPageApproval.call(vm)
      await submission

      expect(vm.approvalComment).toBe('  Keep the rendered note  ')
      expect(vm.approvalError).toBe('Existing approval error')
      expect(vm.approvalLoading).toBe(false)
      expect(vm.loadPageApproval).not.toHaveBeenCalled()
      expect(graphErrors).toHaveLength(1)
      expect(graphErrors[0]).toBeInstanceOf(Error)
      expect((graphErrors[0] as Error).message).toBe('Page changed after it was rendered')
      expect(successNotifications).toHaveLength(0)
      expect(notificationsRefresh).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = previousFetch
    }
  })
  it.each([false, true])('preserves a resubmit draft when a conflict arrives (resource changed: %s)', async resourceChanged => {
    graphErrors.length = 0
    successNotifications.length = 0
    notificationsRefresh.mockClear()
    const request = deferred<Response>()
    const calls: FetchCall[] = []
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return request.promise
    })
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as typeof fetch
    try {
      const vm = makeVm()
      vm.approvalError = 'Existing approval error'
      const transition = vm.transitionPageApproval('resubmit')
      if (resourceChanged) {
        vm.sourceRevision = '18'
        await nextTick()
      }
      request.resolve(
        new Response(JSON.stringify({ error: 'Page changed after it was rendered' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      await transition

      expect(calls).toHaveLength(1)
      expect(calls[0]?.[1]?.method).toBe('POST')
      expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
        action: 'resubmit',
        expectedSourceRevision: '17',
        comment: 'Keep the rendered note'
      })
      expect(vm.approvalComment).toBe('  Keep the rendered note  ')
      expect(vm.approvalError).toBe('Existing approval error')
      expect(vm.approvalLoading).toBe(false)
      expect(vm.loadPageApproval).not.toHaveBeenCalled()
      if (resourceChanged) {
        expect(graphErrors).toHaveLength(0)
      } else {
        expect(graphErrors).toHaveLength(1)
        expect(graphErrors[0]).toBeInstanceOf(Error)
        expect((graphErrors[0] as Error).message).toBe('Page changed after it was rendered')
      }
      expect(successNotifications).toHaveLength(0)
      expect(notificationsRefresh).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = previousFetch
    }
  })
  it('dispatches only after a fresh current approval read is accepted', async () => {
    successNotifications.length = 0
    const calls: FetchCall[] = []
    let attempt = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      attempt += 1
      if (attempt === 2) return Promise.resolve(new Response('{}', { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ approval: { id: 'approval-42', assigneeId: 9 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    }) as typeof fetch
    try {
      const vm = makeVm({
        approvalAuthorityReady: false,
        approvalAuthorityReadyKey: null
      })
      vm.loadPageApproval = componentOptions.methods.loadPageApproval.bind(vm)
      await vm.submitPageApproval()
      expect(calls).toHaveLength(0)

      expect(await vm.loadPageApproval()).toBe(true)
      expect(vm.approvalAuthorityReady).toBe(true)
      expect(vm.approvalAuthorityReadyKey).toBe(vm.approvalAuthorityContextKey)

      expect(vm.approvalActionReady).toBe(true)
      await vm.submitPageApproval()

      expect(calls.map(([input, init]) => [String(input), init?.method ?? 'GET'])).toEqual([
        ['/_api/pages/42/approval', 'GET'],
        ['/_api/pages/42/approval', 'POST'],
        ['/_api/pages/42/approval', 'GET']
      ])
      expect(successNotifications).toHaveLength(1)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('does not dispatch cached approval state after transport loss or a context-key change', async () => {
    const calls: FetchCall[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
    try {
      const offlineVm = makeVm({ pageOnlineActionReady: false })
      await offlineVm.submitPageApproval()
      await offlineVm.transitionPageApproval('approve')

      const staleVm = makeVm({
        approvalAuthorityReadyKey: 'previous-context'
      })
      await staleVm.submitPageApproval()
      await staleVm.transitionPageApproval('approve')

      expect(calls).toHaveLength(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('does not let a late approval read re-enable another page or actor', async () => {
    const request = deferred<Response>()
    const calls: FetchCall[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return request.promise
    }) as typeof fetch
    try {
      const vm = makeVm({
        approvalAuthorityReady: false,
        approvalAuthorityReadyKey: null
      })
      vm.loadPageApproval = componentOptions.methods.loadPageApproval.bind(vm)
      const read = vm.loadPageApproval()
      vm.pageId = 43
      vm.pageActionGeneration = 2
      vm.pageAuthorityKey = 'actor-b:online'
      vm.pageApproval = { id: 'approval-43', assigneeId: 19 }
      vm.approvalAssigneeId = 19
      await nextTick()
      vm.approvalRequestId += 1
      request.resolve(
        new Response(JSON.stringify({ approval: { id: 'approval-42', assigneeId: 9 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      expect(await read).toBe(false)
      expect(vm.approvalAuthorityReady).toBe(false)
      expect(vm.approvalAuthorityReadyKey).toBeNull()
      expect(vm.pageApproval).toEqual({ id: 'approval-43', assigneeId: 19 })
      expect(vm.approvalAssigneeId).toBe(19)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it.each(['actor', 'page'] as const)('rejects a pending read after only the %s changes', async change => {
    const request = deferred<Response>()
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() => request.promise) as typeof fetch
    try {
      const vm = makeVm({
        pageApproval: { id: 'current-approval', assigneeId: 19 },
        approvalAssigneeId: 19,
        approvalAuthorityReady: false,
        approvalAuthorityReadyKey: null
      })
      vm.loadPageApproval = componentOptions.methods.loadPageApproval.bind(vm)
      const read = vm.loadPageApproval()
      const requestId = vm.approvalRequestId
      if (change === 'actor') {
        // Method-boundary race before the actor watcher runs: no page,
        // generation, resource or request change can mask the actor guard.
        vm.pageAuthorityKey = 'actor-b:online'
        expect(vm.pageId).toBe(42)
        expect(vm.pageActionGeneration).toBe(1)
        expect(vm.approvalRequestId).toBe(requestId)
      } else {
        vm.pageId = 43
        await nextTick()
      }
      request.resolve(new Response(JSON.stringify({ approval: { id: 'late-approval', assigneeId: 9 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
      expect(await read).toBe(false)
      expect(vm.approvalAuthorityReady).toBe(false)
      expect(vm.approvalAuthorityReadyKey).toBeNull()
      expect(vm.pageApproval).toEqual({ id: 'current-approval', assigneeId: 19 })
      expect(vm.approvalAssigneeId).toBe(19)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('retries a failed transition with a read and does not replay the transition POST', async () => {
    graphErrors.length = 0
    const calls: FetchCall[] = []
    let attempt = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      attempt += 1
      if (attempt === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Transition outcome is unknown' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ approval: { id: 'approval-42', assigneeId: 9 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    }) as typeof fetch
    try {
      const vm = makeVm()
      vm.loadPageApproval = componentOptions.methods.loadPageApproval.bind(vm)
      await vm.transitionPageApproval('approve')
      expect(calls).toHaveLength(1)
      expect(vm.approvalAuthorityReady).toBe(false)

      await vm.loadPageApproval()

      expect(calls).toHaveLength(2)
      expect(calls[0]?.[1]?.method).toBe('POST')
      expect(calls[1]?.[1]?.method ?? 'GET').toBe('GET')
      expect(String(calls[1]?.[0])).toBe('/_api/pages/42/approval')
      expect(JSON.parse(String(calls[0]?.[1]?.body))).not.toHaveProperty('expectedSourceRevision')
      expect(vm.approvalAuthorityReady).toBe(true)
      expect(graphErrors).toHaveLength(1)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
  it('retries by reading approval state and never replays a failed submit', async () => {
    graphErrors.length = 0
    const calls: FetchCall[] = []
    let attempt = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      attempt += 1
      if (attempt === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Approval outcome is unknown' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ approval: { id: 'approval-42', assigneeId: 9 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    }) as typeof fetch
    try {
      const vm = makeVm()
      vm.loadPageApproval = componentOptions.methods.loadPageApproval.bind(vm)
      await vm.submitPageApproval()
      expect(calls).toHaveLength(1)
      expect(vm.approvalAuthorityReady).toBe(false)

      await vm.loadPageApproval()

      expect(calls).toHaveLength(2)
      expect(calls[0]?.[1]?.method).toBe('POST')
      expect(calls[1]?.[1]?.method ?? 'GET').toBe('GET')
      expect(String(calls[1]?.[0])).toBe('/_api/pages/42/approval')
      expect(vm.approvalAuthorityReady).toBe(true)
      expect(graphErrors).toHaveLength(1)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

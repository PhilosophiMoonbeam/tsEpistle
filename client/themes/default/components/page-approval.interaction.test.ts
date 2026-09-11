import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from '../../../../server/test/bun-test.mts'

type FetchCall = [input: RequestInfo | URL, init?: RequestInit]
type ApprovalAction = 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign'
type PageApprovalVm = {
  pageId: number
  sourceRevision: string
  approvalLoading: boolean
  pageApproval: { id: string } | null
  hasWritePagesPermission: boolean
  approvalAssigneeId: number | null
  approvalComment: string
  approvalError: string
  submitPageApproval: () => Promise<void>
  transitionPageApproval: (action: ApprovalAction) => Promise<void>
  approvalResponseError: (response: Response, fallback: string) => Promise<Error>
  loadPageApproval: () => Promise<void>
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
  methods: {
    submitPageApproval: (this: PageApprovalVm) => Promise<void>
    transitionPageApproval: (this: PageApprovalVm, action: ApprovalAction) => Promise<void>
    approvalResponseError: (this: PageApprovalVm, response: Response, fallback: string) => Promise<Error>
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

const makeVm = (overrides: Partial<PageApprovalVm> = {}): PageApprovalVm => {
  const vm = {
    pageId: 42,
    sourceRevision: 'rendered-revision-17',
    approvalLoading: false,
    pageApproval: { id: 'approval-42' },
    hasWritePagesPermission: true,
    approvalAssigneeId: 9,
    approvalComment: '  Keep the rendered note  ',
    approvalError: '',
    approvalResponseError: async (_response: Response, _fallback: string) => new Error('unbound'),
    loadPageApproval: vi.fn(async () => {}),
    $t: (key: string) => key,
    ...overrides
  } as PageApprovalVm
  vm.approvalResponseError = componentOptions.methods.approvalResponseError.bind(vm)
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
      vm.sourceRevision = 'newer-rendered-revision-18'
      request.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await submission

      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
        expectedSourceRevision: 'rendered-revision-17',
        assigneeId: 9,
        comment: 'Keep the rendered note'
      })
      expect(vm.loadPageApproval).toHaveBeenCalledOnce()
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
  it('sends the displayed revision only for resubmit and preserves context on a stale conflict', async () => {
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
      vm.sourceRevision = 'newer-rendered-revision-18'
      request.resolve(
        new Response(JSON.stringify({ error: 'Page changed after it was rendered' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      await transition

      expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
        action: 'resubmit',
        expectedSourceRevision: 'rendered-revision-17',
        comment: 'Keep the rendered note'
      })
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
})

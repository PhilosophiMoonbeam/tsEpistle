import fs from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { reactive, toRaw } from 'vue'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const compileComponentOptions = (path: string): string => {
  const parsed = parse(fs.readFileSync(path, 'utf8'), { filename: path })
  if (parsed.errors.length > 0 || !parsed.descriptor.script || parsed.descriptor.scriptSetup)
    throw new Error(`Could not read the ordinary script from ${path}.`)

  const source = ts.createSourceFile(path, parsed.descriptor.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const transformed = ts.transform(source, [
    context => root =>
      ts.visitEachChild(
        root,
        node => {
          if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return undefined
          if (ts.isExportAssignment(node)) {
            if (node.isExportEquals) throw new Error(`${path} must use an ES module default export.`)
            return ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [ts.factory.createVariableDeclaration('component', undefined, undefined, node.expression)],
                ts.NodeFlags.Const
              )
            )
          }
          return node
        },
        context
      )
  ])
  try {
    return new Bun.Transpiler({ loader: 'ts' }).transformSync(ts.createPrinter().printFile(transformed.transformed[0]!))
  } finally {
    transformed.dispose()
  }
}

const compiled = compileComponentOptions('client/components/admin/admin-utilities.vue')
const cacheCompiled = compileComponentOptions('client/components/admin/admin-utilities-cache.vue')

const receipt = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'import-v1-users',
  state: 'running',
  phase: 'queued',
  actorId: 1,
  apiKeyId: null,
  reason: 'Recover a reviewed import',
  createdAt: '2026-09-07T00:00:00.000Z',
  heartbeatAt: '2026-09-07T00:00:00.000Z',
  completedAt: null,
  acknowledgedAt: null,
  acknowledgedByOperationId: null,
  progress: null,
  summary: 'Import was recorded.',
  result: null
}
const workspace = {
  observedAt: '2026-09-07T00:00:00.000Z',
  fingerprint: 'a'.repeat(64),
  telemetry: { enabled: false, clientId: null },
  locales: [{ code: 'en', name: 'English' }],
  importTargets: { disk: { available: true, reason: null }, git: { available: true, reason: null } },
  operations: []
}

function arrange(overrides: Record<string, unknown> = {}) {
  const values: Record<string, string | undefined> = {}
  const sessionStorage = {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete values[key]
    })
  }
  const transport = {
    fetchUtilitiesWorkspace: vi.fn().mockResolvedValue(structuredClone(workspace)),
    fetchUtilitiesReceipt: vi.fn().mockResolvedValue(structuredClone(receipt)),
    startUtilitiesOperation: vi.fn().mockResolvedValue(structuredClone(receipt)),
    ...overrides
  }
  const window = {
    sessionStorage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(),
    confirm: vi.fn().mockReturnValue(true),
    location: { pathname: '/a/utilities', protocol: 'https:', assign: vi.fn() }
  }
  const bindings = {
    Cookies: { set: vi.fn() },
    defineAsyncComponent: (value: unknown) => value,
    defineComponent: (value: unknown) => value,
    markRaw: <Value>(value: Value) => value,
    utilityOperationConfirmation: (kind: string) => `CONFIRM ${kind}`,
    utilityOperationTitle: (kind: string) => kind,
    fetchUtilitiesReceipt: transport.fetchUtilitiesReceipt,
    fetchUtilitiesWorkspace: transport.fetchUtilitiesWorkspace,
    startUtilitiesOperation: transport.startUtilitiesOperation,
    toRaw,
    structuredClone,
    crypto: { randomUUID: vi.fn(() => receipt.id) },
    window
  }
  const component = new Function(...Object.keys(bindings), compiled + ';return component')(...Object.values(bindings))
  const state = reactive({ ...component.data(), workspace: structuredClone(workspace), $route: { query: {} }, $router: { replace: vi.fn() } })
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, transport, window, values }
}

describe('Utilities reviewed operation recovery', () => {
  it('stores an immutable reactive review snapshot before a lost response and resolves only its exact receipt', async () => {
    const draft = reactive({ mongoDbConnString: 'mongodb://admin:private@legacy.example/wiki', groupMode: 'MULTI' })
    const { state, transport, window, values } = arrange({
      startUtilitiesOperation: vi.fn(async () => {
        draft.groupMode = 'SINGLE'
        throw new Error('Connection lost')
      })
    })
    const recorded = vi.fn()
    await state.requestOperation({
      kind: 'import-v1-users',
      reason: 'Recover the reviewed user import',
      payload: draft,
      onRecorded: recorded
    })
    expect(state).not.toBe(toRaw(state))
    expect(transport.startUtilitiesOperation).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { mongoDbConnString: 'mongodb://admin:private@legacy.example/wiki', groupMode: 'MULTI' } })
    )
    expect(transport.startUtilitiesOperation).toHaveBeenCalledOnce()
    expect(window.sessionStorage.setItem).toHaveBeenCalledWith('utilities.pending-operation.v1', expect.any(String))
    const serializedPending = window.sessionStorage.setItem.mock.calls[0]![1] as string
    expect(JSON.parse(serializedPending)).toEqual({ id: receipt.id, kind: 'import-v1-users', createdAt: expect.any(String) })
    expect(serializedPending).not.toContain(draft.mongoDbConnString)
    expect(window.sessionStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(transport.startUtilitiesOperation.mock.invocationCallOrder[0])
    expect(transport.fetchUtilitiesReceipt).toHaveBeenCalledWith(receipt.id)
    expect(recorded).toHaveBeenCalledWith(receipt)
    expect(values['utilities.pending-operation.v1']).toBeUndefined()
    expect(state.pendingRequest).toBeNull()
  })

  it('recovers only the stored pending identity after a reload without replaying it', async () => {
    const { state, transport, values } = arrange()
    values['utilities.pending-operation.v1'] = JSON.stringify({
      id: receipt.id,
      kind: receipt.kind,
      createdAt: '2026-09-07T00:00:00.000Z'
    })
    state.restorePending()
    await state.recoverPending()
    expect(transport.fetchUtilitiesReceipt).toHaveBeenCalledWith(receipt.id)
    expect(transport.startUtilitiesOperation).not.toHaveBeenCalled()
    expect(state.pendingRequest).toBeNull()
  })

  it('releases a known rejected reactive request without clearing its caller secret or replaying it', async () => {
    const rejected = vi.fn()
    const draft = reactive({ mongoDbConnString: 'mongodb://admin:private@legacy.example/wiki', groupMode: 'MULTI' })
    const { state, transport } = arrange({
      startUtilitiesOperation: vi.fn().mockRejectedValue(Object.assign(new Error('Settings changed; review again.'), { status: 409 }))
    })
    await state.requestOperation({
      kind: 'import-v1-users',
      reason: 'Review the user import',
      payload: draft,
      onRejected: rejected
    })
    expect(transport.startUtilitiesOperation).toHaveBeenCalledOnce()
    expect(transport.fetchUtilitiesReceipt).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith('Settings changed; review again.')
    expect(draft.mongoDbConnString).toBe('mongodb://admin:private@legacy.example/wiki')
    expect(state.pendingRequest).toBeNull()
  })

  it('rejects an overlong reason before persisting or sending an operation', async () => {
    const rejected = vi.fn()
    const { state, transport, window } = arrange()
    await state.requestOperation({ kind: 'cache-pages', reason: 'x'.repeat(1001), payload: {}, onRejected: rejected })
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled()
    expect(transport.startUtilitiesOperation).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith('Enter an administrative reason of 3 to 1000 characters.')
  })

  it('keeps mutation entry locked while another receipt is running and resets removed route selections', async () => {
    const { state, component, transport } = arrange()
    state.workspace.operations = [structuredClone(receipt)]
    await state.requestOperation({ kind: 'cache-pages', reason: 'Do not begin a second action', payload: {} })
    expect(transport.startUtilitiesOperation).not.toHaveBeenCalled()
    state.section = 'export'
    component.watch['$route.query.section'].handler.call(state, undefined)
    component.watch['$route.query.receipt'].handler.call(state, undefined)
    expect(state.section).toBe('auth')
    expect(state.receiptId).toBe('')
  })
})

describe('Utilities browser-cache recovery', () => {
  it('reports a blocked locale-cache operation instead of claiming the cache was cleared', () => {
    const localWindow = {}
    Object.defineProperty(localWindow, 'localStorage', {
      get() {
        throw new Error('Storage access denied')
      }
    })
    const component = new Function('defineComponent', 'utilityOperationConfirmation', 'UtilityReview', 'window', cacheCompiled + ';return component')(
      (value: unknown) => value,
      (kind: string) => `CONFIRM ${kind}`,
      {},
      localWindow
    )
    const notices: Array<{ message: string; color: string }> = []
    const state = {
      ...component.data(),
      $emit: (event: string, value: { message: string; color: string }) => {
        if (event === 'notice') notices.push(value)
      }
    }
    state.clearLocaleCache = component.methods.clearLocaleCache.bind(state)
    state.clearLocaleCache()
    expect(notices).toEqual([{ message: 'This browser blocked access to its locale cache. No cache-cleared result can be confirmed.', color: 'warning' }])
  })
})

import fs from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { computed, reactive, toRaw } from 'vue'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { UtilitiesWorkspace } from '../../../shared/utilities-workspace.ts'
import { StorageImportPreviewSchema, StorageImportReviewSchema, type StorageImportPreview } from '../../../shared/utility-content-import.ts'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
import { helpers, applyUserPresentation } from '../../helpers/index.ts'

import { translateEnglish } from '../../test/english-translate.mts'

// Keep the actual locally registered state component in the stripped-import options seam.
Bun.plugin({
  name: 'utilities-workflow-state-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\/common\/async-state\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'utilities-workflow-state',
        genDefaultAs: 'component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default component;` }
    })
  }
})
// Static SFC imports run before the test-only compiler plugin is registered.
const { default: AsyncState } = await import('../common/async-state.vue')

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

const importCompiled = compileComponentOptions('client/components/admin/admin-utilities-importv1.vue')
const receipt = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'import-v1-content',
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
    AsyncState,
    helpers,
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
  const state = reactive({
    ...component.data.call({ $t: translateEnglish }),
    $t: translateEnglish,
    workspace: structuredClone(workspace),
    $route: { query: {} },
    $router: { replace: vi.fn() }
  })
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, transport, window, values }
}

const importPreview: StorageImportPreview = {
  scope: { actorId: 1, apiKeyId: null, targetKey: 'git', configurationRevision: 'review-fixture' },
  snapshot: 'a'.repeat(64),
  locales: ['en'],
  entries: [{ sourcePath: 'guide.md', kind: 'file', sourceSha256: 'b'.repeat(64) }],
  pages: [{
    sourcePath: 'guide.md', sourceSha256: 'b'.repeat(64), contentType: 'markdown', locale: 'en', path: 'guide',
    format: 'plain_markdown', owned: false, existingPageId: null, expectedSourceRevision: null, diagnostics: []
  }],
  destinations: [{ id: 41, locale: 'en', path: 'legacy-guide', sourceRevision: '7' }]
}

function arrangeImport(initialWorkspace: UtilitiesWorkspace = workspace) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body))
    return Response.json({ ...structuredClone(importPreview), scope: { ...importPreview.scope, targetKey: payload.mode } })
  })
  const bindings = {
    defineComponent: (value: unknown) => value,
    utilityOperationConfirmation: (kind: string) => `CONFIRM ${kind}`,
    UtilityReview: {},
    StorageImportPreviewSchema,
    StorageImportReviewSchema,
    sameOriginJsonFetch,
    window: { fetch }
  }
  const component = new Function(...Object.keys(bindings), importCompiled + ';return component')(...Object.values(bindings))
  const props = { workspace: structuredClone(initialWorkspace), busy: false, $t: translateEnglish }
  const emit = vi.fn()
  const state = reactive({ ...component.data(props), ...props, $emit: emit })
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, emit, component, fetch }
}

describe('Utilities reviewed operation recovery', () => {
  it('stores an immutable reactive review snapshot before a lost response and resolves only its exact receipt', async () => {
    const draft = reactive({ password: 'fixture-private-token', mode: 'git' })
    const { state, transport, window, values } = arrange({
      startUtilitiesOperation: vi.fn(async () => {
        draft.mode = 'disk'
        throw new Error('Connection lost')
      })
    })
    const recorded = vi.fn()
    await state.requestOperation({
      kind: 'import-v1-content',
      reason: 'Recover the reviewed content import',
      payload: draft,
      onRecorded: recorded
    })
    expect(transport.startUtilitiesOperation).toHaveBeenCalledWith(expect.objectContaining({ payload: { password: 'fixture-private-token', mode: 'git' } }))
    expect(transport.startUtilitiesOperation).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.setItem).toHaveBeenCalledWith('utilities.pending-operation.v1', expect.any(String))
    const serializedPending = window.sessionStorage.setItem.mock.calls[0]![1] as string
    expect(JSON.parse(serializedPending)).toEqual({ id: receipt.id, kind: 'import-v1-content', createdAt: expect.any(String) })
    expect(serializedPending).not.toContain(draft.password)
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
    const draft = reactive({ password: 'fixture-private-token', mode: 'git' })
    const { state, transport } = arrange({
      startUtilitiesOperation: vi.fn().mockRejectedValue(Object.assign(new Error('Settings changed; review again.'), { status: 409 }))
    })
    await state.requestOperation({
      kind: 'import-v1-content',
      reason: 'Review the content import',
      payload: draft,
      onRejected: rejected
    })
    expect(transport.startUtilitiesOperation).toHaveBeenCalledTimes(1)
    expect(transport.fetchUtilitiesReceipt).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith('Settings changed; review again.')
    expect(draft.password).toBe('fixture-private-token')
    expect(state.pendingRequest).toBeNull()
  })

  it('rejects an overlong reason before persisting or sending an operation', async () => {
    const { state, transport, window } = arrange()
    await state.requestOperation({ kind: 'cache-pages', reason: 'x'.repeat(1001), payload: {} })
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled()
    expect(transport.startUtilitiesOperation).not.toHaveBeenCalled()
  })

  it('keeps mutation entry locked while another receipt is running and resets removed route selections', async () => {
    const { state, component, transport } = arrange()
    state.workspace.operations = [structuredClone(receipt)]
    await state.requestOperation({ kind: 'cache-pages', reason: 'Do not begin a second action', payload: {} })
    expect(transport.startUtilitiesOperation).not.toHaveBeenCalled()
    state.section = 'export'
    component.watch['$route.query.section'].handler.call(state, undefined)
    state.receiptId = receipt.id
    state.receiptDetail = structuredClone(receipt)
    state.receiptError = 'Previous receipt read failed'
    expect(state.selectedReceipt).toEqual(receipt)
    component.watch['$route.query.receipt'].handler.call(state, undefined)
    expect(state.section).toBe('content')
    expect(state.receiptId).toBe('')
    expect(state.selectedReceipt).toBeNull()
    expect(state.receiptDetail).toBeNull()
    expect(state.receiptError).toBe('')
  })

  it('preserves the selected utility and URL until discard approval resolves, including cancellation', async () => {
    const { state, component } = arrange()
    state.section = 'telemetry'
    state.$route.query = { section: 'telemetry' }
    state.draftDirty = true
    const selectedComponent = state.selectedComponent
    let resolveLeave!: (accepted: boolean) => void
    state.canLeave = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveLeave = resolve
        })
    )

    const cancelled = state.selectSection('cache')
    expect(state.section).toBe('telemetry')
    expect(state.selectedComponent).toBe(selectedComponent)
    expect(state.$router.replace).not.toHaveBeenCalled()
    resolveLeave(false)
    await cancelled
    expect(state.section).toBe('telemetry')
    expect(state.draftDirty).toBe(true)
    expect(state.$route.query.section).toBe('telemetry')
    expect(state.$router.replace).not.toHaveBeenCalled()

    const accepted = state.selectSection('cache')
    expect(state.selectedComponent).toBe(selectedComponent)
    resolveLeave(true)
    await accepted
    expect(state.$router.replace).toHaveBeenCalledWith({ query: { section: 'cache' } })
    // Component selection follows the committed route rather than the selector event.
    state.$route.query.section = 'cache'
    component.watch['$route.query.section'].handler.call(state, 'cache')
    expect(state.section).toBe('cache')
    expect(state.selectedComponent).not.toBe(selectedComponent)
  })
})

describe('Utilities receipt timestamp presentation', () => {
  it('reacts to account instant formatting while retaining the receipt ISO value and invalid fallback', () => {
    const { state } = arrange()
    const original = receipt.createdAt
    const label = computed(() => state.receiptTimestamp(original))
    try {
      applyUserPresentation({ dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'UTC' })
      expect(label.value).toBe('07/09/2026 00:00')
      applyUserPresentation({ dateFormat: 'MM/DD/YYYY', timeFormat: '12h', timezone: 'America/Los_Angeles' })
      expect(label.value).toBe('09/06/2026 5:00 PM')
      expect(receipt.createdAt).toBe(original)
      expect(state.receiptTimestamp('invalid receipt instant')).toBe('Invalid Date')
    } finally {
      applyUserPresentation({ dateFormat: '', timezone: '' })
    }
  })
})

describe('Utilities content-import review boundaries', () => {
  it('starts clean on an available disk target and preserves later source choices across workspace refreshes', () => {
    const { state } = arrangeImport({
      ...workspace,
      importTargets: { ...workspace.importTargets, git: { available: false, reason: 'Git storage is not configured' } }
    })
    expect(state.contentMode).toBe('disk')
    expect(state.formDirty).toBe(false)
    state.workspace = structuredClone(workspace)
    expect(state.contentMode).toBe('disk')
    expect(state.formDirty).toBe(false)
    state.contentMode = 'git'
    state.workspace = {
      ...structuredClone(workspace),
      importTargets: { ...workspace.importTargets, git: { available: false, reason: 'Git storage was removed' } }
    }
    expect(state.contentMode).toBe('git')
    expect(state.formDirty).toBe(true)
    expect(state.canImportContent).toBe(false)
    state.contentMode = 'disk'
    expect(state.formDirty).toBe(false)
  })

  it('shows required Git feedback only after interaction and requires preview before final review', async () => {
    const { state, emit } = arrangeImport()
    Object.assign(state.git, { repoUrl: 'https://example.test/wiki.git', authType: 'basic', username: 'reader', password: 'fixture-token' })
    expect(state.canImportContent).toBe(true)
    for (const { field, touched, error } of [
      { field: 'branch', touched: 'branch', error: 'branchError' },
      { field: 'localRepoPath', touched: 'workingCopy', error: 'workingCopyError' },
      { field: 'username', touched: 'password', error: 'passwordError' },
      { field: 'password', touched: 'password', error: 'passwordError' }
    ]) {
      const original = state.git[field]
      state.touched[touched] = false
      state.git[field] = ''
      expect(state[error]).toBe('')
      expect(state.canImportContent).toBe(false)
      await state.inspectContent()
      await state.openContentReview()
      state.submit({ reason: 'Import reviewed content' })
      expect(state.review.open).toBe(false)
      expect(emit).not.toHaveBeenCalled()
      state.touched[touched] = true
      expect(state[error]).not.toBe('')
      state.git[field] = original
      expect(state[error]).toBe('')
      expect(state.canImportContent).toBe(true)
    }
    await state.openContentReview()
    expect(state.review.open).toBe(false)
    await state.inspectContent()
    expect(state.review.open).toBe(false)
    expect(emit).not.toHaveBeenCalled()
    await state.openContentReview()
    expect(state.review.open).toBe(true)
  })

  it('rechecks the reviewed source availability without substituting a different target or clearing secrets', async () => {
    const { state, emit } = arrangeImport()
    Object.assign(state.git, { repoUrl: 'https://example.test/wiki.git', authType: 'basic', username: 'reader', password: 'fixture-token' })
    await state.inspectContent()
    await state.openContentReview()
    const reviewed = state.review.payload
    state.workspace.importTargets.git = { available: false, reason: 'Reviewed Git target was removed' }
    expect(state.canImportContent).toBe(false)
    state.submit({ reason: 'Import reviewed content' })
    expect(emit).not.toHaveBeenCalled()
    expect(state.review.open).toBe(true)
    expect(state.review.payload).toBe(reviewed)
    expect(state.reviewError).toBe('Reviewed Git target was removed')
    expect(state.git.password).toBe('fixture-token')
  })

  it('keeps reviewed parameters immutable and redacted, retains rejected secrets, and clears them only once recorded', async () => {
    const { state, emit } = arrangeImport()
    Object.assign(state.git, {
      repoUrl: 'https://embedded-user:embedded-token@example.test/wiki.git',
      authType: 'basic',
      username: 'reader',
      password: 'fixture-password',
      privateKey: 'fixture-private-key'
    })
    await state.inspectContent()
    state.mappingFor('guide.md').path = 'reviewed-guide'
    await state.openContentReview()
    const reviewed = state.review.payload
    const parameters = JSON.stringify(state.review.parameters)
    expect(parameters).toContain('https://example.test/wiki.git')
    for (const secret of ['embedded-user', 'embedded-token', 'fixture-password', 'fixture-private-key']) {
      expect(parameters).not.toContain(secret)
    }
    state.mappingFor('guide.md').path = 'changed-after-review'
    state.submit({ reason: 'Import reviewed content' })
    const request = emit.mock.calls.find(([event]) => event === 'request')?.[1] as {
      payload: Record<string, unknown>
      onRejected: (message: string) => void
      onRecorded: () => void
    }
    expect(request.payload).toBe(reviewed)
    expect(request.payload).toMatchObject({
      mode: 'git',
      repoUrl: 'https://embedded-user:embedded-token@example.test/wiki.git',
      branch: 'master',
      password: 'fixture-password'
    })
    expect(request.payload).not.toHaveProperty('privateKey')
    expect(request.payload).not.toHaveProperty('defaultEmail')
    expect(request.payload).not.toHaveProperty('defaultName')
    expect(request.payload.review).toMatchObject({ mappings: [{ sourcePath: 'guide.md', path: 'reviewed-guide' }] })
    request.onRejected('Settings changed; review again')
    expect(state.review.open).toBe(true)
    expect(state.git.password).toBe('fixture-password')
    expect(state.git.privateKey).toBe('fixture-private-key')
    expect(state.reviewError).toBe('Settings changed; review again')
    state.setReviewDirty(true)
    request.onRecorded()
    expect(state.git.password).toBe('')
    expect(state.git.privateKey).toBe('')
    expect(state.review.open).toBe(false)
    expect(state.reviewError).toBe('')
    expect(state.reviewDirty).toBe(false)
  })

  it('submits only the explicitly chosen destination association and current reviewed source hashes', async () => {
    const { state, emit, fetch } = arrangeImport()
    state.contentMode = 'disk'
    state.diskPath = '/data/reviewed'
    const dottedPreview = {
      ...structuredClone(importPreview),
      scope: { ...importPreview.scope, targetKey: 'disk' },
      entries: [{ ...importPreview.entries[0], sourcePath: 'a.b.md' }],
      pages: [{ ...importPreview.pages[0], sourcePath: 'a.b.md', path: 'a.b', diagnostics: ['Unsupported native identity; choose a reviewed mapping.'] }]
    }
    fetch.mockResolvedValueOnce(Response.json(dottedPreview))
    fetch.mockResolvedValueOnce(Response.json(dottedPreview))
    await state.inspectContent()
    expect(state.preview.pages[0].diagnostics).toEqual(['Unsupported native identity; choose a reviewed mapping.'])
    expect(state.mappingFor('a.b.md').existingPageId).toBeNull()
    expect(emit).not.toHaveBeenCalled()
    state.mappingFor('a.b.md').path = 'a-b'
    state.associateDestination('a.b.md', 41)
    await state.openContentReview()
    expect(state.review.open).toBe(true)
    const validated = JSON.parse(String(fetch.mock.calls[1]![1].body))
    expect(validated.review).toMatchObject({
      snapshot: importPreview.snapshot,
      mappings: [{ sourcePath: 'a.b.md', sourceSha256: 'b'.repeat(64), locale: 'en', path: 'legacy-guide', existingPageId: 41, expectedSourceRevision: '7' }]
    })
    expect(emit.mock.calls.filter(([event]) => event === 'request')).toEqual([])
    state.submit({ reason: 'Associate the reviewed legacy page' })
    const request = emit.mock.calls.find(([event]) => event === 'request')?.[1]
    expect(request).toMatchObject({ kind: 'import-v1-content', payload: validated })
  })

  it('keeps invalid and stale review responses actionable without opening final confirmation or submitting mutations', async () => {
    for (const message of ['Unsupported native destination for guide.md', 'Storage import review is stale; preview again']) {
      const { state, emit, fetch } = arrangeImport()
      state.contentMode = 'disk'
      state.diskPath = '/data/reviewed'
      await state.inspectContent()
      state.mappingFor('guide.md').path = 'invalid.name'
      fetch.mockResolvedValueOnce(Response.json({ error: message }, { status: 409 }))
      await state.openContentReview()
      expect(state.previewError).toBe(message)
      expect(state.previewLoading).toBe(false)
      expect(state.review.open).toBe(false)
      expect(state.preview).not.toBeNull()
      state.submit({ reason: 'Do not submit an invalid review' })
      expect(emit).not.toHaveBeenCalled()
    }
  })

  it('discards an in-flight preview on cancel and ignores its later response without starting an import', async () => {
    const { state, emit, fetch } = arrangeImport()
    state.contentMode = 'disk'
    state.diskPath = '/data/reviewed'
    const response = Promise.withResolvers<Response>()
    fetch.mockImplementationOnce(() => response.promise)
    const pending = state.inspectContent()
    expect(state.previewLoading).toBe(true)
    state.cancelPreview()
    response.resolve(Response.json({ ...structuredClone(importPreview), scope: { ...importPreview.scope, targetKey: 'disk' } }))
    await pending
    expect(state.preview).toBeNull()
    expect(state.previewPayload).toBeNull()
    expect(state.previewLoading).toBe(false)
    expect(state.review.open).toBe(false)
    expect(state.mappings).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe('/_api/utilities/content-import/preview')
  })

  it('invalidates both inventory and final review when the source settings change', async () => {
    const { state, component, emit } = arrangeImport()
    state.contentMode = 'disk'
    state.diskPath = '/data/reviewed'
    await state.inspectContent()
    await state.openContentReview()
    expect(state.review.open).toBe(true)
    state.diskPath = '/data/replacement'
    component.watch.diskPath.call(state)
    expect(state.preview).toBeNull()
    expect(state.review.open).toBe(false)
    state.submit({ reason: 'A different source needs a new review' })
    expect(emit.mock.calls.filter(([event]) => event === 'request')).toEqual([])
  })

  it('keeps credentials editable after a preview failure and never substitutes a mutation request', async () => {
    const { state, emit, fetch } = arrangeImport()
    Object.assign(state.git, { repoUrl: 'https://example.test/wiki.git', authType: 'basic', username: 'reader', password: 'fixture-token' })
    fetch.mockResolvedValueOnce(Response.json({ error: 'Local working copy is unavailable; no clone or fetch was performed.' }, { status: 409 }))
    await state.inspectContent()
    expect(state.previewError).toContain('Local working copy is unavailable')
    expect(state.git.password).toBe('fixture-token')
    expect(state.previewLoading).toBe(false)
    expect(state.preview).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps dot exclusion implicit, requires explicit per-source choices, and snapshots exact native removal proof', async () => {
    const { state, emit, fetch } = arrangeImport()
    Object.assign(state.git, { repoUrl: 'https://example.test/wiki.git', authType: 'basic', username: 'reader', password: 'fixture-token' })
    const owner = { kind: 'asset' as const, id: 42, path: '.owned.bin', locale: '', revision: 'e'.repeat(64), sha256: 'c'.repeat(64), sourceOwned: true }
    const dotPreview: StorageImportPreview = {
      ...structuredClone(importPreview),
      entries: [{ sourcePath: '.guide.md', kind: 'file', sourceSha256: 'b'.repeat(64) }],
      pages: [{ ...importPreview.pages[0]!, sourcePath: '.guide.md', path: '.guide' }],
      gitContent: [
        { sourcePath: '.guide.md', sourceSha256: 'b'.repeat(64), sourceKey: 'd'.repeat(64), hidden: true, previous: false, sourceAvailable: true, automatic: false, kind: 'page', owner: null, diagnostics: [] },
        { sourcePath: '.owned.bin', sourceSha256: 'c'.repeat(64), sourceKey: 'd'.repeat(64), hidden: true, previous: false, sourceAvailable: true, automatic: false, kind: 'asset', owner, diagnostics: [] },
        { sourcePath: '.legacy.bin', sourceSha256: 'c'.repeat(64), sourceKey: 'd'.repeat(64), hidden: true, previous: false, sourceAvailable: true, automatic: false, kind: 'asset',
          owner: { ...owner, id: 43, path: '.legacy.bin', sourceOwned: false }, diagnostics: ['Explicit association is required.'] }
      ]
    }
    fetch.mockImplementation(async () => Response.json(dotPreview))
    await state.inspectContent()
    expect(state.dotActions).toEqual({ '.guide.md': '', '.owned.bin': '', '.legacy.bin': '' })
    expect(state.dotChoiceOptions(dotPreview.gitContent![2]).map((choice: { value: string }) => choice.value)).not.toContain('remove')
    expect(state.dotChoiceOptions(dotPreview.gitContent![1]).map((choice: { value: string }) => choice.value)).toContain('remove')
    state.dotActions['.guide.md'] = 'include'
    state.mappingFor('.guide.md').path = 'guide'
    state.dotActions['.owned.bin'] = 'remove'
    state.dotActions['.legacy.bin'] = 'retain'
    await state.openContentReview()
    expect(state.review.open).toBe(true)
    const reviewed = structuredClone(state.review.payload.review)
    expect(reviewed).toMatchObject({
      mappings: [{ sourcePath: '.guide.md', path: 'guide' }],
      gitContent: [
        { sourcePath: '.guide.md', action: 'include', sourceSha256: 'b'.repeat(64), owner: null },
        { sourcePath: '.owned.bin', action: 'remove', owner },
        { sourcePath: '.legacy.bin', action: 'retain', owner: { id: 43, sourceOwned: false } }
      ]
    })
    expect(JSON.stringify(state.review.parameters)).toContain('native asset 42 at revision')
    expect(JSON.stringify(state.review.parameters)).not.toContain('fixture-token')
    state.dotActions['.owned.bin'] = 'retain'
    state.submit({ reason: 'Remove only the exact reviewed source-owned asset' })
    expect(emit.mock.calls.find(([event]) => event === 'request')?.[1].payload.review).toEqual(reviewed)
    state.cancelPreview()
    expect(state.dotActions).toEqual({})
    expect(state.dotDestinations).toEqual({})
  })
  it('requires a smaller exact-choice batch before requesting a review that exceeds the managed 2 MiB quota', async () => {
    const suffix = Array.from({ length: 9 }, () => 'a'.repeat(200)).join('/')
    const gitContent = Array.from({ length: 1200 }, (_, index) => ({
      sourcePath: `.batch-${index}/${suffix}.bin`, sourceSha256: 'c'.repeat(64), sourceKey: 'd'.repeat(64),
      hidden: true, previous: false, sourceAvailable: true, automatic: false, kind: 'asset' as const, owner: null, diagnostics: []
    }))
    const inventory: StorageImportPreview = { ...importPreview, pages: [], gitContent,
      entries: gitContent.map(entry => ({ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, kind: 'file' as const })) }
    const { state, fetch } = arrangeImport()
    fetch.mockImplementation(async () => Response.json(inventory))
    Object.assign(state.git, { repoUrl: 'https://example.test/wiki.git', branch: 'main', localRepoPath: '/srv/wiki' })
    await state.inspectContent()
    for (const entry of gitContent) state.dotActions[entry.sourcePath] = 'include'
    await state.openContentReview()
    expect(state.review.open).toBe(false)
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
      ...component.data.call({ $t: translateEnglish }),
      $t: translateEnglish,
      $emit: (event: string, value: { message: string; color: string }) => {
        if (event === 'notice') notices.push(value)
      }
    }
    state.clearLocaleCache = component.methods.clearLocaleCache.bind(state)
    state.clearLocaleCache()
    expect(notices.map(notice => notice.color)).toEqual(['warning'])
    expect(notices[0]!.message).not.toBe('')
  })
})

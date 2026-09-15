import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import _ from 'lodash'
import * as ts from 'typescript'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { PageBrandingAssignmentSchema, type PageBrandingAssignment } from '../../../shared/page-branding.ts'
import {
  OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_KEY_VERSION,
  type DraftKeyContext,
  type OfflineDraftEnvelopeV1
} from '../../../shared/offline.ts'
import {
  decryptOfflineDraft,
  requestDraftKey,
  type OfflineDraftKeyHandle
} from '../../helpers/offline-crypto.ts'
import {
  OfflineEditorDraftCoordinator,
  type OfflineEditorDraftIdentity,
  type OfflineEditorDraftValues,
  type OfflineEditorDraftView
} from '../../helpers/offline-editor-drafts.ts'
import { invalidateOfflineSession } from '../../helpers/offline-session.ts'
import {
  updatePage,
  type PageWriteInput
} from '../../helpers/pages-api.ts'
import type {
  OfflineDraftDeleteOptions,
  OfflineDraftWriteOptions,
  OfflineStorage,
  OfflineStorageGenerationOptions,
  OfflineSubmissionFinalizationOptions,
  OfflineSubmissionFinalizationResult
} from '../../helpers/offline-storage.ts'

const ORIGIN = 'https://wiki.example.test'
const ACCOUNT_ID = 42
const SESSION_GENERATION = 0
const SITE_ID = 'site-fixture'
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_value, index) => index + 1)
const shellPath = join(process.cwd(), 'client/components/editor.vue')
const shellSource = readFileSync(shellPath, 'utf8')
const shellSfc = parse(shellSource, { filename: shellPath })
const shellScript = shellSfc.descriptor.script?.content ?? ''
const shellAst = ts.createSourceFile(shellPath, shellScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const shellDefaultExport = shellAst.statements.find(ts.isExportAssignment)
if (!shellDefaultExport || !ts.isCallExpression(shellDefaultExport.expression) || !ts.isObjectLiteralExpression(shellDefaultExport.expression.arguments[0])) {
  throw new Error('Unable to find the editor Options API component definition')
}
const shellOptions = shellDefaultExport.expression.arguments[0]
const extractShellObjectOption = (name: string): string => {
  const property = shellOptions.properties.find(
    candidate =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) || (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
  )
  if (!property || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
    throw new Error(`Unable to find the editor ${name} option`)
  }
  return shellScript.slice(property.initializer.getStart(shellAst) + 1, property.initializer.end - 1)
}
const shellComputedSource = extractShellObjectOption('computed')
const shellMethodsSource = extractShellObjectOption('methods')
const executableShellBehavior = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const shellBehavior = {
    computed: { ${shellComputedSource} },
    methods: { ${shellMethodsSource} }
  }
`)

type OkfState = {
  authority: { state: string; metadata: Record<string, unknown> | null; trust: unknown }
  projection: { state: string; value: unknown }
}

type EditorStore = {
  editor: {
    id: number
    editor: string
    editorKey: string
    content: string
    mode: 'update'
    activeModal: string
    checkoutDateActive: string
  }
  page: {
    id: number
    description: string
    isPublished: boolean
    isSearchable: boolean
    visibility: 'public' | 'private'
    locale: string
    path: string
    publishEndDate: string
    publishStartDate: string
    tags: string[]
    title: string
    scriptCss: string
    scriptJs: string
    sourceRevision: string
    brandingAssignment: PageBrandingAssignment | null
    brandingView: null
    okf: OkfState
    okfLoading: boolean
    okfError: string | null
  }
  user: { authenticated: boolean; id: number }
  authRefreshPending: boolean
  authRefreshSettled: boolean
  authRefreshOutcome: 'authenticated'
  offlineIdentityReady: boolean
  offlineIdentityEpoch: number
  waitForAuthRefresh: () => Promise<'authenticated'>
  notifications: Array<Record<string, unknown>>
  showNotification: (value: Record<string, unknown>) => void
}

type TestWindow = {
  fetch: typeof fetch
  location: {
    origin: string
    assigned: string[]
    replaced: string[]
    assign: (url: string) => void
    replace: (url: string) => void
    reload: () => void
  }
  clearTimeout: (id: number) => void
  setTimeout: (handler: () => void, delay?: number) => number
}

type AdapterSafety = {
  ready: boolean
  editVersion: number
  nonPersisted: boolean
  mergeDirty: boolean
  collaborationBacklog: number
  revision: string
}

type Adapter = {
  capture: () => { text: string; editVersion: number }
  snapshot: () => AdapterSafety
  markPersisted: (editVersion?: number) => void
  noteTextChange: () => void
}

type ShellBehavior = {
  computed: {
    isDirty: (this: ShellContext) => boolean
    mode: (this: ShellContext) => string
    offlineDraftMutationBlocked: (this: ShellContext) => boolean
  }
  methods: Record<string, (this: ShellContext, ...args: unknown[]) => unknown>
}

type ShellContext = {
  [key: string]: unknown
  savedState: Record<string, unknown>
  editorAdapter: Adapter
  editorAdapterSafety: AdapterSafety
  offlineDraftCoordinator: OfflineEditorDraftCoordinator
  offlineDraftStatus: string | null
  offlineDraftError: string
  offlineSubmissionCandidates: unknown[]
  offlineDraftCandidates: unknown[]
  offlineDraftCandidate: unknown
  submissionCaptureValues: unknown
  submissionCaptureIdentity: unknown
  dialogProgress: boolean
  isSaving: boolean
  lifecycleGeneration: number
  accountId: number
  isAuthenticated: boolean
  pageId: number
  checkoutDateActive: string
  currentEditor: string
  progressShown: number
  progressHidden: number
  safetyRevision: number
  offlineDraftMutationBlocked: boolean
  save: (options?: { rethrow?: boolean; overwrite?: boolean }) => Promise<boolean>
}

const evaluateShellBehavior = (store: EditorStore, testWindow: TestWindow, fetchPage: (fetcher: typeof fetch, id: number, fallback: string) => Promise<unknown>): ShellBehavior => {
  const freezePageInput = (input: PageWriteInput): PageWriteInput => {
    Object.freeze(input.tags)
    if (input.okfMetadata !== undefined) Object.freeze(input.okfMetadata)
    if (input.branding !== undefined && input.branding !== null) Object.freeze(input.branding)
    return Object.freeze(input)
  }
  const evaluate = new Function(
    '_',
    'PageBrandingAssignmentSchema',
    'wikiStore',
    'window',
    'buildOkfMetadataPayload',
    'freezePageInput',
    'changePageVisibility',
    'checkPageConflict',
    'createPage',
    'discardCollaborationDraft',
    'fetchPage',
    'updatePage',
    'notifyReloadSafetyChanged',
    'requestOfflineIdentityBoundary',
    'emitEditorSaveConflict',
    'getErrorMessage',
    'removeEditorPageCss',
    'clearOfflineCreateIdentity',
    'scopeEditorPageCss',
    `${executableShellBehavior}\nreturn shellBehavior`
  ) as (...args: unknown[]) => ShellBehavior
  return evaluate(
    _,
    PageBrandingAssignmentSchema,
    store,
    testWindow,
    () => undefined,
    freezePageInput,
    async () => ({ sourceRevision: 'visibility-revision' }),
    async () => false,
    async () => ({ id: 91, updatedAt: '2026-09-03T12:00:00.000Z' }),
    async () => undefined,
    fetchPage,
    updatePage,
    () => undefined,
    () => true,
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
    () => undefined,
    () => undefined,
    (css: string) => css
  )
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})
const sameEnvelope = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.recordId === right.recordId &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId &&
  sameBytes(left.nonce, right.nonce) &&
  sameBytes(left.ciphertext, right.ciphertext)

class ComposedDraftStorage {
  readonly records = new Map<string, OfflineDraftEnvelopeV1>()
  private readonly generation = SESSION_GENERATION

  private assertGeneration(options: OfflineStorageGenerationOptions): void {
    if (options.expectedSessionGeneration !== undefined && options.expectedSessionGeneration !== this.generation) throw new Error('session generation mismatch')
  }

  async currentSessionGeneration(): Promise<number> {
    return this.generation
  }

  async listDraftEnvelopes(_accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1[]> {
    this.assertGeneration(options)
    return [...this.records.values()].map(cloneEnvelope)
  }

  async putDraft(envelope: OfflineDraftEnvelopeV1, options: OfflineDraftWriteOptions = {}): Promise<OfflineDraftEnvelopeV1> {
    this.assertGeneration(options)
    const existing = this.records.get(envelope.recordId)
    if (options.expectedDraftRevision !== undefined) {
      if (options.expectedDraftRevision === null ? existing !== undefined : existing?.draftRevision !== options.expectedDraftRevision) throw new Error('draft revision conflict')
    }
    if (options.expectedSubmissionId !== undefined && (existing?.submissionId ?? null) !== options.expectedSubmissionId) throw new Error('submission selector conflict')
    if (existing && existing.submissionId !== null && !sameEnvelope(existing, envelope)) throw new Error('immutable submission overwrite')
    const saved = cloneEnvelope(envelope)
    this.records.set(saved.recordId, saved)
    return cloneEnvelope(saved)
  }

  async deleteDraft(recordId: string, options: OfflineDraftDeleteOptions = {}): Promise<boolean> {
    this.assertGeneration(options)
    const existing = this.records.get(recordId)
    if (!existing) return false
    if (options.expectedDraftRevision !== undefined && existing.draftRevision !== options.expectedDraftRevision) throw new Error('draft revision conflict')
    if (options.expectedSubmissionId !== undefined && existing.submissionId !== options.expectedSubmissionId) throw new Error('submission selector conflict')
    this.records.delete(recordId)
    return true
  }

  async finalizeSubmission(options: OfflineSubmissionFinalizationOptions): Promise<OfflineSubmissionFinalizationResult> {
    this.assertGeneration(options)
    const receipt = this.records.get(options.expectedReceipt.recordId)
    if (!receipt || !sameEnvelope(receipt, options.expectedReceipt)) throw new Error('immutable receipt conflict')
    const source = options.expectedSource === null ? null : this.records.get(options.expectedSource.recordId)
    if (options.expectedSource && (!source || !sameEnvelope(source, options.expectedSource))) throw new Error('source conflict')
    const oldFork = options.expectedSurvivingFork === null ? null : this.records.get(options.expectedSurvivingFork.recordId)
    if (options.expectedSurvivingFork && (!oldFork || !sameEnvelope(oldFork, options.expectedSurvivingFork))) throw new Error('fork conflict')
    if (options.expectedSurvivingFork && !options.survivingFork) throw new Error('fork replacement missing')
    if (options.survivingFork && (!source || options.survivingFork.draftRevision <= source.draftRevision)) throw new Error('fork conflict')
    if (options.survivingFork && options.expectedSurvivingFork && (
      options.survivingFork.recordId !== options.expectedSurvivingFork.recordId ||
      options.survivingFork.draftRevision <= options.expectedSurvivingFork.draftRevision
    )) throw new Error('fork replacement conflict')
    if (options.survivingFork && !options.expectedSurvivingFork && this.records.has(options.survivingFork.recordId)) throw new Error('fork record conflict')

    this.records.delete(receipt.recordId)
    if (source) this.records.delete(source.recordId)
    if (oldFork) this.records.delete(oldFork.recordId)
    if (options.survivingFork) this.records.set(options.survivingFork.recordId, cloneEnvelope(options.survivingFork))
    return {
      receiptDeleted: true,
      sourceDeleted: source !== null,
      survivingFork: options.survivingFork ? cloneEnvelope(options.survivingFork) : null
    }
  }

  close(): void {}
}

class FailingDraftStorage extends ComposedDraftStorage {
  override async putDraft(_envelope: OfflineDraftEnvelopeV1, _options: OfflineDraftWriteOptions = {}): Promise<OfflineDraftEnvelopeV1> {
    throw new Error('offline draft persistence unavailable')
  }
}

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
const lengthPrefixed = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, bytes.byteLength, false)
  return concatBytes([length, bytes])
}
const encodeKeyFrame = (context: DraftKeyContext): Uint8Array => {
  const account = new Uint8Array(8)
  new DataView(account.buffer).setBigUint64(0, BigInt(context.accountId), false)
  const authVersion = new Uint8Array(8)
  new DataView(authVersion.buffer).setBigUint64(0, BigInt(context.authVersion), false)
  return concatBytes([
    new TextEncoder().encode(OFFLINE_DRAFT_KEY_MAGIC),
    lengthPrefixed(context.canonicalOrigin),
    lengthPrefixed(context.siteId),
    account,
    authVersion,
    lengthPrefixed(context.keyVersion),
    KEY_BYTES
  ])
}

const keyContext: DraftKeyContext = {
  canonicalOrigin: ORIGIN,
  siteId: SITE_ID,
  accountId: ACCOUNT_ID,
  authVersion: 0,
  keyVersion: OFFLINE_KEY_VERSION
}
const keyFetch = async (): Promise<Response> => new Response(encodeKeyFrame(keyContext) as unknown as BodyInit, {
  status: 200,
  headers: { 'content-type': 'application/octet-stream' }
})
const keyFetchImpl = keyFetch as unknown as typeof fetch
const identity = (baseSourceRevision = '1', baseUpdatedAt = '2026-09-03T11:00:00.000Z'): OfflineEditorDraftIdentity => ({
  editorKey: 'markdown',
  pageId: 12,
  createIdentity: null,
  locale: 'en',
  path: '/docs/example',
  baseSourceRevision,
  baseUpdatedAt
})
const values = (content: string): OfflineEditorDraftValues => ({
  title: 'Example',
  description: 'A local example',
  content
})

const createStore = (): EditorStore => ({
  editor: {
    id: 12,
    editor: 'editorMarkdown',
    editorKey: 'markdown',
    content: 'A',
    mode: 'update',
    activeModal: '',
    checkoutDateActive: '2026-09-03T11:00:00.000Z'
  },
  page: {
    id: 12,
    description: 'A local example',
    isPublished: true,
    isSearchable: true,
    visibility: 'public',
    locale: 'en',
    path: '/docs/example',
    publishEndDate: '',
    publishStartDate: '',
    tags: [],
    title: 'Example',
    scriptCss: '',
    scriptJs: '',
    sourceRevision: '1',
    brandingAssignment: null,
    brandingView: null,
    okf: {
      authority: { state: 'valid', metadata: null, trust: { score: 1 } },
      projection: { state: 'current', value: null }
    },
    okfLoading: false,
    okfError: null
  },
  user: { authenticated: true, id: ACCOUNT_ID },
  authRefreshPending: false,
  authRefreshSettled: true,
  authRefreshOutcome: 'authenticated',
  offlineIdentityReady: true,
  offlineIdentityEpoch: 0,
  waitForAuthRefresh: async () => 'authenticated',
  notifications: [],
  showNotification(notification) {
    this.notifications.push(notification)
  }
})

const createTestWindow = (fetchImpl: typeof fetch): TestWindow => {
  const location = {
    origin: ORIGIN,
    assigned: [] as string[],
    replaced: [] as string[],
    assign(url: string) { this.assigned.push(url) },
    replace(url: string) { this.replaced.push(url) },
    reload() {}
  }
  return {
    fetch: fetchImpl,
    location,
    clearTimeout() {},
    setTimeout() { return 1 }
  }
}

const createShellContext = (
  store: EditorStore,
  testWindow: TestWindow,
  coordinator: OfflineEditorDraftCoordinator,
  fetchPage: (fetcher: typeof fetch, id: number, fallback: string) => Promise<unknown>
): ShellContext => {
  const behavior = evaluateShellBehavior(store, testWindow, fetchPage)
  let editVersion = 0
  let nonPersisted = true
  const adapter: Adapter = {
    capture: () => ({ text: store.editor.content, editVersion }),
    snapshot: () => ({
      ready: true,
      editVersion,
      nonPersisted,
      mergeDirty: false,
      collaborationBacklog: 0,
      revision: `adapter:${editVersion}:${nonPersisted ? 1 : 0}`
    }),
    markPersisted: (version = editVersion) => {
      if (version === editVersion) nonPersisted = false
    },
    noteTextChange: () => {
      editVersion += 1
      nonPersisted = true
    }
  }
  const context = {
    savedState: {
      content: 'baseline',
      description: store.page.description,
      isPublished: store.page.isPublished,
      isSearchable: store.page.isSearchable,
      visibility: store.page.visibility,
      locale: store.page.locale,
      path: store.page.path,
      publishEndDate: store.page.publishEndDate,
      publishStartDate: store.page.publishStartDate,
      tags: [...store.page.tags],
      title: store.page.title,
      scriptCss: store.page.scriptCss,
      scriptJs: store.page.scriptJs,
      brandingAssignment: null,
      brandingView: null,
      okf: _.cloneDeep(store.page.okf)
    },
    navigationTimer: null,
    dialogUnsaved: false,
    dialogProgress: false,
    exitConfirmed: false,
    lifecycleGeneration: 0,
    editorInstanceKey: 0,
    isSaving: false,
    discardPending: false,
    collaborationActive: false,
    collaborationGeneration: null,
    collaborationDiscarded: false,
    isConflict: false,
    pageId: store.page.id,
    checkoutDateActive: store.editor.checkoutDateActive,
    currentEditor: 'editorMarkdown',
    isAuthenticated: true,
    accountId: ACCOUNT_ID,
    offlineConnectionState: 'online',
    authRefreshPending: false,
    serverSaveDisabled: false,
    activeModal: '',
    offlineDraftBusy: false,
    offlineDraftStatus: null,
    offlineDraftError: '',
    offlineDraftCandidates: [],
    offlineSubmissionCandidates: [],
    offlineDraftCandidate: null,
    offlineReconcilePrompt: null,
    offlineDraftCoordinator: coordinator,
    submissionCaptureValues: null,
    submissionCaptureIdentity: null,
    safetyRevision: 0,
    editorAdapter: adapter,
    editorAdapterSafety: adapter.snapshot(),
    progressShown: 0,
    progressHidden: 0,
    $t: (key: string) => key,
    notifySafetyChanged() {
      const shell = this as unknown as ShellContext
      shell.safetyRevision += 1
    }
  } as unknown as ShellContext
  for (const [name, method] of Object.entries(behavior.methods)) context[name] = method.bind(context)
  Object.defineProperty(context, 'mode', { get: () => behavior.computed.mode.call(context) })
  Object.defineProperty(context, 'isDirty', { get: () => behavior.computed.isDirty.call(context) })
  Object.defineProperty(context, 'offlineDraftMutationBlocked', { get: () => behavior.computed.offlineDraftMutationBlocked.call(context) })
  return context
}

let previousWindow: unknown

const installWindow = (testWindow: TestWindow): void => {
  previousWindow = (globalThis as Record<string, unknown>).window
  ;(globalThis as Record<string, unknown>).window = testWindow
  ;(globalThis as Record<string, unknown>).location = testWindow.location
}

afterEach(() => {
  invalidateOfflineSession()
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else (globalThis as Record<string, unknown>).window = previousWindow
  Reflect.deleteProperty(globalThis, 'location')
  previousWindow = undefined
})

describe('composed editor offline submission boundary', () => {
  test('freezes A for the network request and receipt while preserving B for a fresh verified consumer', async () => {
    const storage = new ComposedDraftStorage()
    let requestBody: Record<string, unknown> | undefined
    let releaseNetwork: (() => void) | undefined
    let networkStarted: (() => void) | undefined
    const networkStartedPromise = new Promise<void>(resolve => { networkStarted = resolve })
    const networkRelease = new Promise<void>(resolve => { releaseNetwork = resolve })
    const pageFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/_api/pages/12') && init?.method === 'PUT') {
        const parsedBody: unknown = JSON.parse(String(init.body))
        if (!parsedBody || typeof parsedBody !== 'object' || !('content' in parsedBody)) throw new Error('Malformed update request')
        requestBody = Object.fromEntries(Object.entries(parsedBody))
        networkStarted?.()
        await networkRelease
        return new Response(JSON.stringify({ page: { updatedAt: '2026-09-03T12:00:00.000Z', sourceRevision: '2' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`Unexpected page request: ${url}`)
    }
    const testWindow = createTestWindow(pageFetch as typeof fetch)
    installWindow(testWindow)
    const store = createStore()
    const identityForCoordinator = (): OfflineEditorDraftIdentity => identity(store.page.sourceRevision, store.editor.checkoutDateActive)
    const valuesForCoordinator = (): OfflineEditorDraftValues => values(store.editor.content)
    const changes: OfflineEditorDraftView[] = []
    const coordinator = new OfflineEditorDraftCoordinator({
      fetchImpl: keyFetchImpl,
      isAuthenticated: () => store.user.authenticated,
      accountId: () => store.user.id,
      getActorEpoch: () => store.offlineIdentityEpoch,
      isOfflineBoundaryReady: () => true,
      getIdentity: identityForCoordinator,
      getValues: valuesForCoordinator,
      isDirty: () => true,
      isOnline: () => false,
      getReloadSafetyFacts: () => ({}),
      storage: storage as unknown as OfflineStorage,
      debounceMs: 0,
      onChange: view => changes.push(view)
    })
    const context = createShellContext(
      store,
      testWindow,
      coordinator,
      async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: store.page.sourceRevision, isSearchable: true })
    )
    const savePromise = context.save()
    await networkStartedPromise

    expect(requestBody?.content).toBe('A')
    const receipt = [...storage.records.values()].find(record => record.submissionId !== null)
    expect(receipt).toBeDefined()
    const handle: OfflineDraftKeyHandle = await requestDraftKey(keyFetchImpl, {
      expectedAccountId: ACCOUNT_ID,
      expectedSessionGeneration: SESSION_GENERATION
    })
    const decryptedReceipt = await decryptOfflineDraft(handle, receipt!)
    expect(decryptedReceipt.content).toBe('A')

    store.editor.content = 'B'
    context.editorAdapter.noteTextChange()
    context.editorAdapterSafety = context.editorAdapter.snapshot()
    releaseNetwork?.()
    expect(await savePromise).toBe(true)
    expect(requestBody?.content).toBe('A')
    expect(context.isDirty).toBe(true)
    expect(changes.some(view => view.state === 'publishing')).toBe(true)

    coordinator.destroy()
    invalidateOfflineSession()
    let recoveredContent: string | undefined
    const fresh = new OfflineEditorDraftCoordinator({
      fetchImpl: keyFetchImpl,
      isAuthenticated: () => true,
      accountId: () => ACCOUNT_ID,
      getActorEpoch: () => 0,
      isOfflineBoundaryReady: () => true,
      getIdentity: () => identity('2', '2026-09-03T12:00:00.000Z'),
      getValues: () => values('server A'),
      isOnline: () => false,
      storage: storage as unknown as OfflineStorage,
      detachedApply: payload => { recoveredContent = payload.content },
      onChange: () => undefined
    })
    const recoveredView = await fresh.initialize()
    expect(recoveredView.candidate?.payload.content).toBe('B')
    expect(await fresh.applyDetachedCandidate()).toMatchObject({ content: 'B' })
    expect(recoveredContent).toBe('B')
    fresh.destroy()
  })
  test('latches unavailable after a real coordinator receiptless capture failure', async () => {
    const storage = new FailingDraftStorage()
    let updateCalls = 0
    const pageFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/_api/pages/12') && init?.method === 'PUT') {
        updateCalls++
        return new Response(JSON.stringify({ message: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`Unexpected page request: ${url}`)
    }
    const testWindow = createTestWindow(pageFetch as typeof fetch)
    installWindow(testWindow)
    const store = createStore()
    let context: ShellContext | null = null
    const changes: OfflineDraftView[] = []
    const coordinator = new OfflineEditorDraftCoordinator({
      fetchImpl: keyFetchImpl,
      isAuthenticated: () => store.user.authenticated,
      accountId: () => store.user.id,
      getActorEpoch: () => store.offlineIdentityEpoch,
      isOfflineBoundaryReady: () => true,
      getIdentity: () => identity(store.page.sourceRevision, store.editor.checkoutDateActive),
      getValues: () => values(store.editor.content),
      isDirty: () => true,
      isOnline: () => true,
      getReloadSafetyFacts: () => ({}),
      storage: storage as unknown as OfflineStorage,
      debounceMs: 0,
      onChange: view => {
        changes.push(view)
        if (context) {
          context.offlineDraftStatus = view.state
          context.offlineDraftError = view.error ?? ''
        }
      }
    })
    const shell = createShellContext(
      store,
      testWindow,
      coordinator,
      async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: store.page.sourceRevision, isSearchable: true })
    )
    context = shell

    expect(await shell.save()).toBe(false)
    expect(updateCalls).toBe(1)
    expect(changes.some(view => view.error !== null)).toBe(true)
    expect(shell.offlineDraftStatus).toBe('unavailable')
    expect(shell.offlineDraftMutationBlocked).toBe(true)
    expect(await shell.save()).toBe(false)
    expect(updateCalls).toBe(1)
    expect(store.notifications).toHaveLength(2)
    expect(store.notifications.some(notification =>
      notification.message === 'Publishing is unavailable because the page may have been deleted or access may have been denied, but the local draft could not be retained.' &&
      notification.style === 'error'
    )).toBe(true)
    expect(store.notifications.some(notification => notification.style === 'warning')).toBe(true)
  })
})

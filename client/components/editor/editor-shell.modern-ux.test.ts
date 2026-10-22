import { readFileSync } from 'node:fs'
import moment from 'moment-timezone'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import _ from 'lodash'
import pug from 'pug'
import * as ts from 'typescript'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import '../../test/browser-dom.mts'
import { OfflineSnapshotSelectorSchema } from '../../../shared/offline.ts'
import { normalizeAvailableEditors } from '../../../shared/page-editors.ts'
import { normalizePageFeatures } from '../../../shared/page-features.ts'
import { MAX_PAGE_CHANGE_REASON_LENGTH, PageChangeReasonSchema } from '../../../shared/page-change-reason.ts'
import { getEditorComponentName } from '../../helpers/editor-key.ts'
import { PageBrandingAssignmentSchema, type PageBrandingAssignment, type PageBrandingView } from '../../../shared/page-branding.ts'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createSourceAuthoring } from '../../helpers/editor-source-authoring'
import { createSourceImageAuthoring } from '../../helpers/editor-source-images'
import * as imagePropertiesHelpers from '../../helpers/editor-image-properties'
import { isPageRenderPending, waitForPageRender, type PageRenderTarget } from '../../helpers/pages-api.ts'

import { translateEnglish } from '../../test/english-translate.mts'
const shellPath = join(process.cwd(), 'client/components/editor.vue')

const shellSource = readFileSync(shellPath, 'utf8')

const shellSfc = parse(shellSource, { filename: shellPath })

const shellScript = shellSfc.descriptor.script?.content ?? ''

// Vuetify captures DOM globals at evaluation, after the shared browser harness installs them.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const modalPath = join(process.cwd(), 'client/components/editor/editor-modal-unsaved.vue')
const modalSfc = parse(readFileSync(modalPath, 'utf8'), { filename: modalPath }).descriptor
if (!modalSfc.template || !modalSfc.script) throw new Error('Unsaved modal SFC is incomplete')
const modalTemplate = compileTemplate({
  source: modalSfc.template.content,
  filename: modalPath,
  id: 'editor-unsaved-test',
  preprocessLang: modalSfc.template.lang,
  compilerOptions: { mode: 'function' }
})
if (modalTemplate.errors.length) throw modalTemplate.errors[0]
const modalRender = new Function('Vue', modalTemplate.code)(Vue)
const modalScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  modalSfc.script.content.replace(/^import .*$/gm, '').replace('export default defineComponent', 'return defineComponent')
)
const modalOptions = new Function('defineComponent', modalScript)(Vue.defineComponent)
const cardPath = join(process.cwd(), 'client/components/common/v-card-chin.vue')
const cardSfc = parse(readFileSync(cardPath, 'utf8'), { filename: cardPath }).descriptor
if (!cardSfc.template) throw new Error('Card action region template is missing')
const cardTemplate = compileTemplate({
  source: cardSfc.template.content,
  filename: cardPath,
  id: 'editor-card-chin-test',
  preprocessLang: cardSfc.template.lang,
  compilerOptions: { mode: 'function' }
})
if (cardTemplate.errors.length) throw cardTemplate.errors[0]
const cardRender = new Function('Vue', cardTemplate.code)(Vue)
// Compile the owner's invocation unchanged, rather than supplying dialog props in the test.
const shellMarkup = cheerio.load(pug.render(shellSfc.descriptor.template?.content ?? ''))
const ownerUnsavedInvocation = shellMarkup('editor-modal-unsaved')
if (ownerUnsavedInvocation.length !== 1) throw new Error('Editor unsaved dialog invocation is missing or ambiguous')
const ownerUnsavedTemplate = compileTemplate({
  source: ownerUnsavedInvocation.toString(),
  filename: shellPath,
  id: 'editor-owner-unsaved-test',
  compilerOptions: { mode: 'function' }
})
if (ownerUnsavedTemplate.errors.length) throw ownerUnsavedTemplate.errors[0]
const ownerUnsavedRender = new Function('Vue', ownerUnsavedTemplate.code)(Vue)
const ownerSaveTemplate = compileTemplate({
  source: `<div>${shellMarkup('.editor-save-status, .editor-save-action, .editor-save-close-action, .editor-close-action, .editor-change-reason').toString()}</div>`,
  filename: shellPath,
  id: 'editor-owner-save-test',
  compilerOptions: { mode: 'function' }
})
if (ownerSaveTemplate.errors.length) throw ownerSaveTemplate.errors[0]
const ownerSaveRender = new Function('Vue', ownerSaveTemplate.code)(Vue)
const modalUnmounts: Array<() => void> = []
afterEach(() => {
  for (const unmount of modalUnmounts.splice(0)) unmount()
  vi.useRealTimers()
})
type OkfState = {
  authority: {
    state: string
    metadata: Record<string, unknown> | null
    trust: unknown
  }
  projection: {
    state: string
    value: unknown
  }
}
type EditorAdapterSafety = {
  ready: boolean
  editVersion: number
  nonPersisted: boolean
  mergeDirty: boolean
  collaborationBacklog: number
  revision: string
}

type EditorAdapterHarness = {
  capture: () => { text: string; editVersion: number }
  snapshot: () => EditorAdapterSafety
  replaceText: (text: string, options?: { detached?: boolean }) => void
  clear: () => void
  destroy: () => void
  flushEligibleText: () => void
  markPersisted: (editVersion?: number) => void
  onState: (listener: (safety: EditorAdapterSafety) => void) => () => void
  notifyState: () => void
}

type OfflineCoordinatorHarness = {
  isAuthenticatedUser: () => boolean
  lock: () => void
  destroy: () => void
  applyDetachedCandidate: (recordId?: string) => Promise<unknown>
  discardCurrentDraft: () => Promise<boolean>
  prepareSubmission: (options?: { editVersion?: number }) => Promise<unknown>
  completeSubmission: (prepared: unknown, outcome: unknown) => Promise<boolean>
  captureNow: (options?: { force?: boolean; state?: string; editVersion?: number }) => Promise<boolean>
  readonly captureStates: string[]
  readonly hasCommittedCurrentValues: boolean
  readonly hasInFlightWork: boolean
  readonly hasUnresolvedSubmission: boolean
  readonly reloadSafetySnapshot: { safe: boolean; revision: string; actorEpoch?: string | number }
}
type OfflineStorageHarness = {
  isClosed: boolean
  readOfflinePolicy: () => Promise<{
    sessionGeneration: number
    state: {
      automaticSavingEnabled: boolean
      policyRevision: number
    }
    pages: Array<{
      siteId: string
      pageId: number
      locale: string
      excluded: boolean
      availability: string
    }>
  }>
  recordSuccessfulPageEdit: (selector: unknown, options: Record<string, unknown>) => Promise<unknown>
  close: () => void
}

type AuthOutcome = 'authenticated' | 'unavailable'

type EditorStore = {
  editor: {
    id: number
    editor: string
    editorKey: string
    content: string
    mode: 'create' | 'update'
  }
  page: {
    id: number
    isPublished: boolean
    description: string
    isSearchable: boolean
    visibility: 'public' | 'private'
    protected?: boolean
    isProtected?: boolean
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
    brandingView: PageBrandingView | null
    okf: OkfState
    okfLoading: boolean
    okfError: string | null
  }
  notifications: Array<Record<string, unknown>>
  loadingOwners: string[]
  user: { authenticated: boolean; id: number }
  authRefreshPending: boolean
  authRefreshSettled: boolean
  authRefreshOutcome: AuthOutcome
  offlineIdentityReady: boolean
  offlineIdentityEpoch: number
  waitForAuthRefresh: () => Promise<AuthOutcome>
  showNotification: (notification: Record<string, unknown>) => void
  startLoading: (owner: string) => void
}

type SavedState = {
  content: string
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
  brandingAssignment: PageBrandingAssignment | null
  brandingView: PageBrandingView | null
  okf: OkfState
}

type PageInput = {
  content: string
  description: string
  locale: string
  visibility: 'public' | 'private'
  isPublished: boolean
  isSearchable: boolean
  path: string
  publishEndDate: string
  publishStartDate: string
  scriptCss: string
  scriptJs: string
  tags: string[]
  title: string
  changeReason?: string
  okfMetadata?: Record<string, unknown>
  branding?: PageBrandingAssignment | null
}

type ShellContext = {
  [key: string]: unknown
  savedState: SavedState
  navigationTimer: number | null
  dialogUnsaved: boolean
  saveFeedback: string
  lastSavedAt: number | null
  exitConfirmed: boolean
  lifecycleGeneration: number
  editorInstanceKey: number
  offlineConnectionState: string
  isSaving: boolean
  changeReason: string
  renderWaitController: AbortController | null
  discardPending: boolean
  discardError: string
  collaborationActive: boolean
  collaborationGeneration: number | null
  collaborationDiscarded: boolean
  isConflict: boolean
  pageId: number
  checkoutDateActive: string
  currentEditor: string
  isAuthenticated: boolean
  accountId: number
  activeModal: string
  offlineDraftBusy: boolean
  offlineDraftStatus: string | null
  offlineDraftStatusText: string
  offlineDraftMutationBlocked: boolean
  offlineMutationBlocked: boolean
  offlineDraftError: string
  localDiscardCalls: number
  offlineDraftCandidates: unknown[]
  offlineSubmissionCandidates: unknown[]
  dialogProps: boolean
  dialogEditorSelector: boolean
  editorAdapter: EditorAdapterHarness
  editorAdapterSafety: EditorAdapterSafety
  offlineDraftCoordinator: OfflineCoordinatorHarness | null
  offlineStorage: OfflineStorageHarness | null
  offlineStoragePromise: Promise<OfflineStorageHarness> | null
  offlineMetadataOperation: number
  applyOfflineDraft: (payload: { content: string; title: string; description: string }) => void
  restoreOfflineDraft: (recordId?: string) => Promise<void>
  submissionCaptureValues: unknown
  submissionCaptureIdentity: unknown
  isMetadataDirty: () => boolean
  isDirty: boolean
  mode: string
  progressShown: number
  progressHidden: number
  $t: (key: string) => string
  exitGo: () => void
  handleOfflineSessionInvalidated: () => void
  exit: () => Promise<void>
  handleBeforeUnload: (event: BeforeUnloadEvent) => void
  save: (options?: { rethrow?: boolean; overwrite?: boolean }) => Promise<boolean>
  saveAndClose: () => Promise<boolean>
  cancelRenderWait: () => void
  saveUnsavedAndClose: () => Promise<void>
  beginSaveFeedback: () => void
  endSaveFeedback: (outcome: 'saved' | 'device' | 'failed' | 'idle') => void
}
type ShellBehavior = {
  computed: {
    isDirty: (this: ShellContext) => boolean
    mode: (this: ShellContext) => string
    offlineDraftMutationBlocked: (this: ShellContext) => boolean
    offlineMutationBlocked: (this: ShellContext) => boolean
    offlineDraftStatusText: (this: ShellContext) => string
    saveStatusText: (this: ShellContext) => string
    saveStatusIcon: (this: ShellContext) => string
    saveActionLabel: (this: ShellContext) => string
    renderWaitOwnerKey: (this: ShellContext) => string
    changeReasonErrors: (this: ShellContext) => string[]
    sourceEditorReady: (this: { currentEditor: string; warmAuthenticatedActor: boolean }) => boolean
    warmAuthenticatedActor: (this: { isAuthenticated: boolean; accountId: number }) => boolean
  }
  watch: {
    renderWaitOwnerKey: { flush: 'sync'; handler: (this: ShellContext) => void }
  }
  methods: Record<string, (this: ShellContext, ...args: never[]) => unknown>
}

type ApiDependencies = {
  buildOkfMetadataPayload: (metadata: Record<string, unknown> | null) => Record<string, unknown> | undefined
  freezePageInput: (input: PageInput) => PageInput
  changePageVisibility: (
    fetcher: typeof fetch,
    id: number,
    visibility: 'public' | 'private',
    sourceRevision: string,
    isPublic: boolean
  ) => Promise<{ sourceRevision: string }>
  checkPageConflict: (fetcher: typeof fetch, id: number, checkoutDate: string) => Promise<boolean>
  createPage: (fetcher: typeof fetch, input: PageInput) => Promise<{ id: number; updatedAt: string; sourceRevision: string }>
  discardCollaborationDraft: (fetcher: typeof fetch, pageId: number, expectedUpdatedAt: string, expectedSourceRevision: string) => Promise<void>
  fetchPage: (fetcher: typeof fetch, id: number, errorMessage: string) => Promise<{ okf: OkfState; sourceRevision: string; isSearchable?: boolean }>
  updatePage: (
    fetcher: typeof fetch,
    id: number,
    input: PageInput,
    sourceRevision: string,
    expectedCollaborationGeneration?: number
  ) => Promise<{ sourceRevision: string; updatedAt: string }>
  waitForPageRender: (fetcher: typeof fetch, expected: PageRenderTarget, signal: AbortSignal, fallbackMessage: string) => Promise<void>
  openOfflineStorage: () => Promise<OfflineStorageHarness>
  siteConfig: { availableEditors: unknown }
  notifyReloadSafetyChanged: () => void
  requestOfflineIdentityBoundary: (request: { accountId: number; reason: 'unauthorized' }) => Promise<boolean>
}

type TestWindow = {
  location: {
    origin: string
    assigned: string[]
    replaced: string[]
    assign: (url: string) => void
    replace: (url: string) => void
  }
  clearedTimers: number[]
  scheduledTimers: Array<{ id: number; delay: number | undefined }>
  clearTimeout: (id: number | null | undefined) => void
  setTimeout: (handler: () => void, delay?: number) => number
  fetch: typeof fetch
}

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
    watch: { ${extractShellObjectOption('watch')} },
    methods: { ${shellMethodsSource} }
  }
`)

const createStore = (mode: 'create' | 'update' = 'update'): EditorStore => {
  const store: EditorStore = {
    editor: {
      id: 12,
      editor: 'editorMarkdown',
      editorKey: 'markdown',
      content: 'persisted content',
      mode
    },
    page: {
      id: 12,
      description: 'persisted description',
      isPublished: true,
      isSearchable: true,
      visibility: 'public',
      protected: false,
      locale: 'en',
      path: 'persisted-path',
      publishEndDate: '2030-01-02',
      publishStartDate: '2026-01-02',
      tags: ['persisted-tag'],
      title: 'Persisted title',
      scriptCss: '.persisted {}',
      scriptJs: 'window.persisted = true',
      sourceRevision: '1',
      brandingAssignment: null as PageBrandingAssignment | null,
      brandingView: null as PageBrandingView | null,
      okf: {
        authority: {
          state: 'valid',
          metadata: { type: 'Reference', status: 'stable' },
          trust: { score: 1 }
        },
        projection: {
          state: 'current',
          value: { summary: 'persisted projection' }
        }
      },
      okfLoading: false,
      okfError: null
    },
    user: {
      authenticated: true,
      id: 42
    },
    authRefreshPending: false,
    authRefreshSettled: true,
    authRefreshOutcome: 'authenticated',
    offlineIdentityReady: true,
    offlineIdentityEpoch: 0,
    waitForAuthRefresh: async () => store.authRefreshOutcome,
    notifications: [],
    loadingOwners: [],
    showNotification(notification) {
      this.notifications.push(notification)
    },
    startLoading(owner) {
      this.loadingOwners.push(owner)
    }
  }
  return store
}

const createTestWindow = (): TestWindow => {
  let nextTimer = 100
  const location = {
    origin: 'https://wiki.example.test',
    assigned: [] as string[],
    replaced: [] as string[],
    assign(url: string) {
      this.assigned.push(url)
    },
    replace(url: string) {
      this.replaced.push(url)
    }
  }
  return {
    location,
    clearedTimers: [],
    scheduledTimers: [],
    clearTimeout(id) {
      if (id !== null && id !== undefined) this.clearedTimers.push(id)
    },
    setTimeout(_handler, delay) {
      const id = nextTimer++
      this.scheduledTimers.push({ id, delay })
      return id
    },
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ protected: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )) as unknown as typeof fetch
  }
}

const mockRenderPreviews = (testWindow: TestWindow, fetchPreview: typeof fetch): void => {
  const fetchMetadata = testWindow.fetch
  testWindow.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, testWindow.location.origin)
    return url.pathname === '/_api/pages/preview' ? fetchPreview(input, init) : fetchMetadata(input, init)
  }) as typeof fetch
}
const createOfflineStorage = (
  automaticSavingEnabled = false,
  onRecord: OfflineStorageHarness['recordSuccessfulPageEdit'] = async () => undefined,
  pages: Array<{ siteId: string; pageId: number; locale: string; excluded: boolean; availability: string }> = []
): OfflineStorageHarness => ({
  isClosed: false,
  readOfflinePolicy: async () => ({
    sessionGeneration: 4,
    state: {
      automaticSavingEnabled,
      policyRevision: 7
    },
    pages
  }),
  recordSuccessfulPageEdit: onRecord,
  close() {
    this.isClosed = true
  }
})

const defaultDependencies = (store: EditorStore): ApiDependencies => ({
  buildOkfMetadataPayload: metadata => metadata ?? undefined,
  freezePageInput: input => {
    Object.freeze(input.tags)
    if (input.okfMetadata !== undefined) Object.freeze(input.okfMetadata)
    if (input.branding !== undefined && input.branding !== null) Object.freeze(input.branding)
    return Object.freeze(input)
  },
  changePageVisibility: async () => ({ sourceRevision: 'revision-3' }),
  checkPageConflict: async () => false,
  createPage: async () => ({ id: 91, sourceRevision: 'revision-1', updatedAt: '2026-09-03T12:00:00.000Z' }),
  discardCollaborationDraft: async () => undefined,
  openOfflineStorage: async () => createOfflineStorage(),
  siteConfig: {
    availableEditors: ['markdown', 'visual-markdown', 'ckeditor', 'asciidoc', 'code']
  },
  requestOfflineIdentityBoundary: async () => true,
  fetchPage: async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: 'revision-2', isSearchable: store.page.isSearchable }),
  updatePage: async () => ({ sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' }),
  waitForPageRender: async () => undefined,
  notifyReloadSafetyChanged: () => undefined
})

const loadShellBehavior = (store: EditorStore, testWindow: TestWindow, overrides: Partial<ApiDependencies> = {}): ShellBehavior => {
  const dependencies = { ...defaultDependencies(store), ...overrides }
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
    'waitForPageRender',
    'isPageRenderPending',
    'markRaw',
    'moment',
    'SAVE_SHORTCUT_LABEL',
    'notifyReloadSafetyChanged',
    'requestOfflineIdentityBoundary',
    'openOfflineStorage',
    'OfflineSnapshotSelectorSchema',
    'normalizeAvailableEditors',
    'getEditorComponentName',
    'normalizePageFeatures',
    'siteConfig',
    'emitEditorSaveConflict',
    'getErrorMessage',
    'removeEditorPageCss',
    'clearOfflineCreateIdentity',
    'scopeEditorPageCss',
    'PageChangeReasonSchema',
    `${executableShellBehavior}\nreturn shellBehavior`
  ) as (...args: unknown[]) => ShellBehavior
  return evaluate(
    _,
    PageBrandingAssignmentSchema,
    store,
    testWindow,
    dependencies.buildOkfMetadataPayload,
    dependencies.freezePageInput,
    dependencies.changePageVisibility,
    dependencies.checkPageConflict,
    dependencies.createPage,
    dependencies.discardCollaborationDraft,
    dependencies.fetchPage,
    dependencies.updatePage,
    dependencies.waitForPageRender,
    isPageRenderPending,
    Vue.markRaw,
    moment,
    'Ctrl+S',
    dependencies.notifyReloadSafetyChanged,
    dependencies.requestOfflineIdentityBoundary,
    dependencies.openOfflineStorage,
    OfflineSnapshotSelectorSchema,
    normalizeAvailableEditors,
    getEditorComponentName,
    normalizePageFeatures,
    dependencies.siteConfig,
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
    () => undefined,
    () => undefined,
    (css: string) => css,
    PageChangeReasonSchema
  )
}

const createShellHarness = (store: EditorStore, testWindow: TestWindow, overrides: Partial<ApiDependencies> = {}): ShellContext => {
  const behavior = loadShellBehavior(store, testWindow, overrides)
  const adapterState: EditorAdapterSafety = {
    ready: true,
    editVersion: 0,
    nonPersisted: false,
    mergeDirty: false,
    collaborationBacklog: 0,
    revision: 'test-adapter:0'
  }
  const context = Vue.reactive({
    savedState: {} as SavedState,
    navigationTimer: null,
    dialogUnsaved: false,
    saveFeedback: 'idle',
    lastSavedAt: null,
    lastSaveKind: 'server',
    welcomeMode: false,
    serverSaveDisabled: false,
    exitConfirmed: false,
    lifecycleGeneration: 0,
    editorInstanceKey: 0,
    isSaving: false,
    changeReason: '',
    changeReasonLimit: MAX_PAGE_CHANGE_REASON_LENGTH,
    renderWaitController: null,
    discardError: '',
    discardPending: false,
    collaborationActive: store.editor.mode === 'update' && store.editor.editorKey === 'markdown',
    collaborationGeneration: store.editor.mode === 'update' && store.editor.editorKey === 'markdown' ? 1 : null,
    collaborationDiscarded: false,
    isConflict: false,
    pageId: store.page.id,
    checkoutDateActive: '2026-09-03T11:00:00.000Z',
    currentEditor: store.editor.editor,
    isAuthenticated: store.user.authenticated,
    accountId: store.user.id,
    offlineConnectionState: 'online',
    offlineStorage: null,
    offlineStoragePromise: null,
    offlineMetadataOperation: 0,
    activeModal: '',
    offlineDraftBusy: false,
    offlineDraftStatus: null,
    offlineDraftError: '',
    offlineDraftCandidates: [],
    offlineSubmissionCandidates: [],
    localDiscardCalls: 0,
    dialogProps: false,
    dialogEditorSelector: false,
    offlineDraftCandidate: null,
    offlineCreateIdentity: store.editor.mode === 'create' ? 'test-create-identity' : null,
    submissionCaptureValues: null,
    submissionCaptureIdentity: null,
    progressShown: 0,
    progressHidden: 0,
    $t: translateEnglish
  }) as unknown as ShellContext

  const adapterListeners = new Set<(safety: EditorAdapterSafety) => void>()
  const syncAdapterSafety = () => {
    context.editorAdapterSafety = adapter.snapshot()
    for (const listener of adapterListeners) listener(context.editorAdapterSafety)
  }
  const adapter: EditorAdapterHarness = {
    capture: () => ({ text: store.editor.content, editVersion: adapterState.editVersion }),
    snapshot: () => ({
      ...adapterState,
      revision: `test-adapter:${adapterState.editVersion}:${adapterState.nonPersisted ? 1 : 0}`
    }),
    replaceText: text => {
      store.editor.content = text
      adapterState.editVersion += 1
      adapterState.nonPersisted = true
      syncAdapterSafety()
    },
    clear: () => {
      store.editor.content = ''
      adapterState.editVersion += 1
      adapterState.nonPersisted = true
      syncAdapterSafety()
    },
    destroy: () => {
      adapterState.ready = false
      adapterState.revision = 'test-adapter:destroyed'
      syncAdapterSafety()
      adapterListeners.clear()
    },
    flushEligibleText: () => undefined,
    onState: listener => {
      adapterListeners.add(listener)
      listener(adapter.snapshot())
      return () => adapterListeners.delete(listener)
    },
    notifyState: syncAdapterSafety,
    markPersisted: (editVersion = adapterState.editVersion) => {
      if (editVersion !== adapterState.editVersion) return
      adapterState.nonPersisted = false
      adapterState.revision = `test-adapter:${adapterState.editVersion}:persisted`
      syncAdapterSafety()
    }
  }
  context.editorAdapter = adapter
  context.editorAdapterSafety = adapter.snapshot()

  const coordinatorState = {
    discardCalls: 0,
    captureStates: [] as string[],
    hasCommittedCurrentValues: false,
    hasInFlightWork: false,
    hasUnresolvedSubmission: false,
    destroyed: false,
    nextSubmission: 0
  }
  const coordinator: OfflineCoordinatorHarness = {
    isAuthenticatedUser: () => context.isAuthenticated,
    lock: () => {
      adapter.clear()
    },
    destroy: () => {
      coordinatorState.destroyed = true
      coordinatorState.hasCommittedCurrentValues = false
      coordinatorState.hasInFlightWork = false
      coordinatorState.hasUnresolvedSubmission = false
    },
    applyDetachedCandidate: async () => null,
    discardCurrentDraft: async () => {
      coordinatorState.discardCalls++
      context.localDiscardCalls++
      return true
    },
    prepareSubmission: async options => {
      coordinatorState.hasInFlightWork = true
      coordinatorState.hasUnresolvedSubmission = true
      const prepared = Object.freeze({
        submission: Object.freeze({ recordId: `test-submission-${++coordinatorState.nextSubmission}` }),
        envelope: Object.freeze({}),
        editVersion: options?.editVersion ?? adapterState.editVersion
      })
      coordinatorState.hasInFlightWork = false
      return prepared
    },
    captureNow: async options => {
      coordinatorState.captureStates.push(options?.state ?? 'local')
      coordinatorState.hasCommittedCurrentValues = true
      context.offlineDraftStatus = options?.state ?? 'local'
      context.offlineDraftError = ''
      adapter.markPersisted(options?.editVersion ?? adapterState.editVersion)
      return true
    },
    completeSubmission: async () => {
      coordinatorState.hasInFlightWork = false
      coordinatorState.hasUnresolvedSubmission = false
      return true
    },
    get captureStates() {
      return coordinatorState.captureStates
    },
    get hasCommittedCurrentValues() {
      return coordinatorState.hasCommittedCurrentValues
    },
    get hasInFlightWork() {
      return coordinatorState.hasInFlightWork
    },
    get hasUnresolvedSubmission() {
      return coordinatorState.hasUnresolvedSubmission
    },
    get reloadSafetySnapshot() {
      const safe = !context.isDirty && !context.dialogUnsaved && !coordinatorState.hasInFlightWork && !coordinatorState.hasUnresolvedSubmission
      return {
        safe,
        revision: `test-coordinator:${safe ? 'safe' : 'unsafe'}`,
        actorEpoch: store.offlineIdentityEpoch
      }
    }
  }

  context.offlineDraftCoordinator = coordinator
  for (const [name, method] of Object.entries(behavior.methods)) {
    context[name] = method.bind(context)
  }
  Object.defineProperty(context, 'isDirty', {
    get: () => behavior.computed.isDirty.call(context)
  })
  Object.defineProperty(context, 'mode', {
    get: () => behavior.computed.mode.call(context)
  })
  Object.defineProperty(context, 'offlineDraftMutationBlocked', {
    get: () => behavior.computed.offlineDraftMutationBlocked.call(context)
  })
  Object.defineProperty(context, 'offlineMutationBlocked', {
    get: () => behavior.computed.offlineMutationBlocked.call(context)
  })
  Object.defineProperty(context, 'offlineDraftStatusText', {
    get: () => behavior.computed.offlineDraftStatusText.call(context)
  })

  const beginSaveFeedback = context.beginSaveFeedback
  const endSaveFeedback = context.endSaveFeedback
  context.beginSaveFeedback = () => {
    context.progressShown++
    beginSaveFeedback()
  }
  context.endSaveFeedback = outcome => {
    if (context.saveFeedback === 'saving') context.progressHidden++
    endSaveFeedback(outcome)
  }
  context.setCurrentSavedState()
  return context
}

const flushSaveUi = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve()
  await Vue.nextTick()
}

const mountSaveActions = (store: EditorStore, testWindow: TestWindow, overrides: Partial<ApiDependencies> = {}) => {
  const context = createShellHarness(store, testWindow, overrides)
  const behavior = loadShellBehavior(store, testWindow, overrides)
  for (const name of ['saveStatusText', 'saveStatusIcon', 'saveActionLabel', 'renderWaitOwnerKey', 'changeReasonErrors'] as const) {
    Object.defineProperty(context, name, { get: () => behavior.computed[name].call(context) })
  }
  let action: Promise<boolean> | undefined
  const save = context.save
  const saveAndClose = context.saveAndClose
  context.save = options => {
    action = save(options)
    return action
  }
  context.saveAndClose = () => {
    action = saveAndClose()
    return action
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    setup: () => context,
    watch: { renderWaitOwnerKey: behavior.watch.renderWaitOwnerKey },
    beforeUnmount() {
      context.lifecycleGeneration++
      context.cancelRenderWait()
    },
    render: ownerSaveRender
  })
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.mount(host)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    app.unmount()
    host.remove()
  }
  modalUnmounts.push(unmount)
  return {
    context,
    host,
    unmount,
    click(actionName: 'save' | 'close' = 'close'): Promise<boolean> {
      const button = host.querySelector<HTMLButtonElement>(actionName === 'save' ? '.editor-save-action' : '.editor-save-close-action')
      if (!button) throw new Error('The editor save action is not mounted')
      button.click()
      if (!action) throw new Error('The editor save action did not run')
      return action
    }
  }
}

const holdRecoveryCaptureAfterSubmission = (context: ShellContext) => {
  const coordinator = context.offlineDraftCoordinator
  if (!coordinator) throw new Error('The recovery coordinator is missing')
  const completeSubmission = coordinator.completeSubmission
  const captureNow = coordinator.captureNow
  const inFlightWork = Object.getOwnPropertyDescriptor(coordinator, 'hasInFlightWork')?.get
  if (!inFlightWork) throw new Error('The recovery work boundary is missing')
  let pending = false
  let release!: (captured: boolean) => void
  let reject!: (error: Error) => void
  const completion = new Promise<boolean>((resolve, rejectCapture) => {
    release = resolve
    reject = rejectCapture
  })
  Object.defineProperty(coordinator, 'hasInFlightWork', {
    get: () => pending || inFlightWork.call(coordinator)
  })
  coordinator.completeSubmission = async (prepared, outcome) => {
    const completed = await completeSubmission(prepared, outcome)
    if (completed) pending = true
    return completed
  }
  coordinator.captureNow = async options => {
    if (pending) {
      let captured: boolean
      try {
        captured = await completion
      } finally {
        pending = false
      }
      if (!captured) return false
    }
    return captureNow(options)
  }
  return {
    release: (captured = true) => release(captured),
    reject
  }
}

const pendingRenderError = () => Object.assign(new Error('The current page render is pending.'), { status: 503, code: 'PAGE_RENDER_PENDING' })

const createRenderPreview = (store: EditorStore, sourceRevision = '2') => ({
  id: store.page.id,
  sourceRevision,
  locale: store.page.locale,
  path: store.page.path,
  visibility: store.page.visibility,
  excerpt: 'Rendered saved content'
})

const mutableSnapshot = (store: EditorStore): SavedState => ({
  content: store.editor.content,
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
  brandingAssignment: _.cloneDeep(store.page.brandingAssignment),
  brandingView: _.cloneDeep(store.page.brandingView),
  pageFeatures: normalizePageFeatures(store.page.pageFeatures),
  okf: _.cloneDeep(store.page.okf)
})

const applyEveryEdit = (store: EditorStore) => {
  store.editor.content = 'discarded content'
  store.page.description = 'discarded description'
  store.page.isPublished = false
  store.page.isSearchable = false
  store.page.visibility = 'private'
  store.page.locale = 'fr'
  store.page.path = 'discarded-path'
  store.page.publishEndDate = '2040-04-05'
  store.page.publishStartDate = '2039-03-04'
  store.page.tags = ['discarded-tag']
  store.page.title = 'Discarded title'
  store.page.scriptCss = '.discarded {}'
  store.page.scriptJs = 'window.discarded = true'
  store.page.okf = {
    authority: {
      state: 'invalid',
      metadata: { type: 'Article', status: 'draft' },
      trust: { score: 0 }
    },
    projection: {
      state: 'stale',
      value: { summary: 'discarded projection' }
    }
  }
}

describe('modern editor shell interaction contract', () => {
  for (const outcome of ['success', 'rejected', 'unknown', 'post-write'] as const) {
    test(`mounted save reason follows the captured save and ${outcome === 'success' ? 'clears only after confirmation' : `survives ${outcome} outcome without retry`}`, async () => {
      const store = Vue.reactive(createStore())
      const testWindow = createTestWindow()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const inputs: PageInput[] = []
      const mounted = mountSaveActions(store, testWindow, {
        updatePage: async (_fetch, _id, input) => {
          inputs.push(input)
          started.resolve()
          await release.promise
          if (outcome === 'rejected') throw Object.assign(new Error('Rejected save'), { status: 409 })
          if (outcome === 'unknown') throw new TypeError('Failed to fetch')
          return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
        },
        fetchPage: async () => {
          if (outcome === 'post-write') throw new Error('The post-save refresh is unavailable')
          return { okf: _.cloneDeep(store.page.okf), sourceRevision: '2', isSearchable: store.page.isSearchable }
        }
      })
      mounted.context.editorAdapter.replaceText('The captured source')
      const field = mounted.host.querySelector<HTMLInputElement>('.editor-change-reason input')
      if (!field) throw new Error('Save reason field is not mounted')
      expect(field.maxLength).toBe(MAX_PAGE_CHANGE_REASON_LENGTH)
      field.value = 'Explain this exact source'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await Vue.nextTick()
      const saving = mounted.click('save')
      await started.promise
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({ content: 'The captured source', changeReason: 'Explain this exact source' })
      expect(mounted.context.changeReason).toBe('Explain this exact source')
      release.resolve()
      expect(await saving).toBe(outcome === 'success')
      expect(mounted.context.changeReason).toBe(outcome === 'success' ? '' : 'Explain this exact source')
      expect(inputs).toHaveLength(1)
    })
  }

  for (const change of ['new reason', 'new source', 'account', 'page', 'lifecycle'] as const) {
    test(`a confirmed older save preserves its reason after ${change} changes while in flight`, async () => {
      const store = Vue.reactive(createStore())
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const mounted = mountSaveActions(store, createTestWindow(), {
        updatePage: async () => {
          started.resolve()
          await release.promise
          return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
        },
        fetchPage: async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: '2', isSearchable: store.page.isSearchable })
      })
      mounted.context.editorAdapter.replaceText('Captured source')
      mounted.context.changeReason = 'Explain captured source'
      const saving = mounted.context.save()
      await started.promise
      if (change === 'new reason') mounted.context.changeReason = 'Explain the next source'
      if (change === 'new source') mounted.context.editorAdapter.replaceText('Newer unsaved source')
      if (change === 'account') {
        mounted.context.accountId = 99
        store.user.id = 99
        store.offlineIdentityEpoch++
      }
      if (change === 'page') store.page.id = 99
      if (change === 'lifecycle') mounted.context.lifecycleGeneration++
      release.resolve()
      await saving
      expect(mounted.context.changeReason).toBe(change === 'new reason' ? 'Explain the next source' : 'Explain captured source')
    })
  }

  test('mounted first Save and close settles pending recovery before requesting the authorized saved preview', async () => {
    const store = Vue.reactive(createStore())
    store.page.visibility = 'private'
    const testWindow = createTestWindow()
    let writes = 0
    const previews: Array<{ url: string; credentials: RequestCredentials | undefined }> = []
    mockRenderPreviews(testWindow, (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, testWindow.location.origin)
      previews.push({ url: `${url.pathname}${url.search}`, credentials: init?.credentials })
      return Response.json(createRenderPreview(store))
    }) as typeof fetch)
    const mounted = mountSaveActions(store, testWindow, {
      updatePage: async () => {
        writes++
        return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      fetchPage: async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: '2', isSearchable: store.page.isSearchable }),
      waitForPageRender
    })
    const recovery = holdRecoveryCaptureAfterSubmission(mounted.context)
    mounted.context.editorAdapter.replaceText('first-close saved content')
    const capturedVersion = mounted.context.editorAdapter.capture().editVersion
    const saving = mounted.click()
    await flushSaveUi()

    expect(writes).toBe(1)
    expect(previews).toEqual([])
    expect(testWindow.location.assigned).toEqual([])
    expect(mounted.context.isSaving).toBe(true)
    expect(mounted.context.saveFeedback).toBe('saved')
    expect(mounted.context.offlineDraftCoordinator?.hasUnresolvedSubmission).toBe(false)
    expect(mounted.context.editorAdapter.snapshot()).toMatchObject({ editVersion: capturedVersion, nonPersisted: false })
    expect(mounted.host.querySelector('[role="status"]')?.textContent).toContain('Saved. Preparing the page for viewing')
    expect(await mounted.context.saveAndClose()).toBe(false)

    recovery.release()
    expect(await saving).toBe(true)
    expect(writes).toBe(1)
    expect(previews).toEqual([{ url: '/_api/pages/preview?id=12', credentials: 'same-origin' }])
    expect(testWindow.location.assigned).toEqual(['/_private/en/persisted-path'])
    expect(mounted.context.isSaving).toBe(false)
    expect(mounted.context.renderWaitController).toBeNull()
    expect(mounted.context.isDirty).toBe(false)
    expect(store.notifications.at(-1)?.style).toBe('success')
  })

  for (const change of [
    'typing',
    'reverted typing',
    'metadata',
    'account',
    'unmount',
    'new collaboration work',
    'unresolved submission',
    'new local work'
  ] as const) {
    test(`mounted Save and close protects ${change} while its recovery capture is pending`, async () => {
      const store = Vue.reactive(createStore())
      const testWindow = createTestWindow()
      let writes = 0
      let previews = 0
      mockRenderPreviews(testWindow, (async () => {
        previews++
        return Response.json(createRenderPreview(store))
      }) as typeof fetch)
      const mounted = mountSaveActions(store, testWindow, {
        updatePage: async () => {
          writes++
          return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
        },
        fetchPage: async () => {
          throw pendingRenderError()
        },
        waitForPageRender
      })
      const recovery = holdRecoveryCaptureAfterSubmission(mounted.context)
      mounted.context.editorAdapter.replaceText('saved content')
      let backlog = change === 'new collaboration work' ? 3 : 0
      const snapshot = mounted.context.editorAdapter.snapshot
      mounted.context.editorAdapter.snapshot = () => ({ ...snapshot(), collaborationBacklog: backlog })
      mounted.context.editorAdapter.notifyState()
      const saving = mounted.click()
      await flushSaveUi()
      expect(mounted.context.isSaving).toBe(true)
      expect(previews).toBe(0)
      const settlementSignal = mounted.context.renderWaitController?.signal
      expect(settlementSignal).toBeDefined()

      if (change === 'typing' || change === 'reverted typing') mounted.context.editorAdapter.replaceText('new unsaved content')
      if (change === 'reverted typing') mounted.context.editorAdapter.replaceText('saved content')
      if (change === 'metadata') store.page.title = 'New unsaved title'
      if (change === 'account') {
        mounted.context.accountId = 99
        store.user.id = 99
        store.offlineIdentityEpoch++
      }
      if (change === 'unmount') mounted.unmount()
      if (change === 'new collaboration work') {
        backlog = 2
        mounted.context.editorAdapter.notifyState()
        backlog = 3
        mounted.context.editorAdapter.notifyState()
      }
      if (change === 'unresolved submission') {
        Object.defineProperty(mounted.context.offlineDraftCoordinator, 'hasUnresolvedSubmission', { get: () => true })
      }
      if (change === 'new local work') {
        Object.defineProperty(mounted.context.offlineDraftCoordinator, 'hasInFlightWork', { get: () => true })
      }
      recovery.release()
      expect(await saving).toBe(false)

      expect(writes).toBe(1)
      expect(previews).toBe(0)
      expect(testWindow.location.assigned).toEqual([])
      expect(testWindow.location.replaced).toEqual([])
      expect(mounted.context.savedState.content).toBe('saved content')
      expect(mounted.context.saveFeedback).toBe('saved')
      expect(mounted.context.renderWaitController).toBeNull()
      if (change === 'typing') {
        expect(store.editor.content).toBe('new unsaved content')
        expect(mounted.context.isDirty).toBe(true)
      }
      if (change === 'typing' || change === 'reverted typing') expect(mounted.context.editorAdapter.snapshot().nonPersisted).toBe(true)
      if (change === 'metadata') expect(store.page.title).toBe('New unsaved title')
      if (change === 'account' || change === 'unmount') expect(settlementSignal?.aborted).toBe(true)
      if (change === 'unresolved submission') expect(mounted.context.offlineDraftCoordinator?.hasUnresolvedSubmission).toBe(true)
      if (change === 'new local work') expect(mounted.context.offlineDraftCoordinator?.hasInFlightWork).toBe(true)
    })
  }

  test('mounted Save and close does not settle recovery through an already unresolved submission', async () => {
    const store = Vue.reactive(createStore())
    const testWindow = createTestWindow()
    let writes = 0
    let previews = 0
    mockRenderPreviews(testWindow, (async () => {
      previews++
      return Response.json(createRenderPreview(store))
    }) as typeof fetch)
    const mounted = mountSaveActions(store, testWindow, {
      updatePage: async () => {
        writes++
        return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      fetchPage: async () => {
        throw pendingRenderError()
      },
      waitForPageRender
    })
    const recovery = holdRecoveryCaptureAfterSubmission(mounted.context)
    Object.defineProperty(mounted.context.offlineDraftCoordinator, 'hasUnresolvedSubmission', { get: () => true })
    mounted.context.editorAdapter.replaceText('saved content with a retained receipt')
    const saving = mounted.click()
    await flushSaveUi()
    expect(mounted.context.isSaving).toBe(false)
    expect(await saving).toBe(false)
    recovery.release()
    expect(writes).toBe(1)
    expect(previews).toBe(0)
    expect(testWindow.location.assigned).toEqual([])
    expect(mounted.context.offlineDraftCoordinator?.hasUnresolvedSubmission).toBe(true)
    expect(mounted.context.saveFeedback).toBe('saved')
  })

  for (const failure of ['unavailable', 'throws'] as const) {
    test(`mounted ${failure} recovery bookkeeping preserves the successful save and retries close without rewriting`, async () => {
      const store = Vue.reactive(createStore())
      const testWindow = createTestWindow()
      let writes = 0
      let previews = 0
      mockRenderPreviews(testWindow, (async () => {
        previews++
        return Response.json(createRenderPreview(store))
      }) as typeof fetch)
      const mounted = mountSaveActions(store, testWindow, {
        updatePage: async () => {
          writes++
          return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
        },
        fetchPage: async () => {
          throw pendingRenderError()
        },
        waitForPageRender
      })
      const recovery = holdRecoveryCaptureAfterSubmission(mounted.context)
      mounted.context.editorAdapter.replaceText('source saved before recovery failure')
      const saving = mounted.click()
      await flushSaveUi()
      expect(mounted.context.isSaving).toBe(true)
      if (failure === 'throws') recovery.reject(new Error('Local recovery storage is unavailable.'))
      else recovery.release(false)
      expect(await saving).toBe(false)
      expect(writes).toBe(1)
      expect(previews).toBe(0)
      expect(testWindow.location.assigned).toEqual([])
      expect(mounted.context.saveFeedback).toBe('saved')
      expect(mounted.context.isDirty).toBe(false)
      expect(mounted.context.savedState.content).toBe('source saved before recovery failure')
      expect(mounted.context.renderWaitController).toBeNull()
      expect(store.notifications.at(-1)?.style).not.toBe('error')

      expect(await mounted.click()).toBe(true)
      expect(writes).toBe(1)
      expect(previews).toBe(1)
      expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
    })
  }

  for (const { mode, backlog, remainingBacklog } of [
    { mode: 'update', backlog: 0, remainingBacklog: 0 },
    { mode: 'update', backlog: 3, remainingBacklog: 3 },
    { mode: 'update', backlog: 3, remainingBacklog: 2 },
    { mode: 'create', backlog: 0, remainingBacklog: 0 }
  ] as const) {
    test(`mounted ${mode} waits for the saved render with collaboration backlog ${backlog} to ${remainingBacklog} and rejects duplicate saves`, async () => {
      vi.useFakeTimers()
      const store = Vue.reactive(createStore(mode))
      if (mode === 'update') store.page.visibility = 'private'
      const testWindow = createTestWindow()
      let ready = false
      let writes = 0
      let previews = 0
      mockRenderPreviews(testWindow, (async () => {
        previews++
        return Response.json(ready ? createRenderPreview(store) : { error: 'Still rendering', code: 'PAGE_RENDER_PENDING' }, { status: ready ? 200 : 503 })
      }) as typeof fetch)
      const written = async () => {
        writes++
        expect(mounted.context.editorAdapter.snapshot().collaborationBacklog).toBe(backlog)
        expect(mounted.context.editorAdapter.snapshot().nonPersisted).toBe(true)
        return { id: mode === 'create' ? 91 : 12, sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      }
      const mounted = mountSaveActions(store, testWindow, {
        createPage: written,
        updatePage: written,
        fetchPage: async () => ({
          sourceRevision: '2',
          isSearchable: store.page.isSearchable,
          okf: {
            ..._.cloneDeep(store.page.okf),
            authority: {
              ..._.cloneDeep(store.page.okf.authority),
              metadata: {
                type: 'Reference',
                status: 'stable',
                generated: { by: 'human:42', at: '2026-09-03T12:00:00.000Z' }
              }
            }
          }
        }),
        waitForPageRender
      })
      mounted.context.editorAdapter.replaceText('saved content')
      let pendingUpdates: number = backlog
      const snapshot = mounted.context.editorAdapter.snapshot
      mounted.context.editorAdapter.snapshot = () => ({ ...snapshot(), collaborationBacklog: pendingUpdates })
      mounted.context.editorAdapter.notifyState()
      const capturedVersion = mounted.context.editorAdapter.capture().editVersion
      expect(mounted.context.editorAdapterSafety.nonPersisted).toBe(true)
      const saving = mounted.click(mode === 'create' ? 'save' : 'close')
      await flushSaveUi()

      expect(previews).toBe(1)
      expect(writes).toBe(1)
      expect(mounted.context.editorAdapter.snapshot()).toMatchObject({
        editVersion: capturedVersion,
        nonPersisted: false,
        collaborationBacklog: backlog
      })
      expect(testWindow.location.assigned).toEqual([])
      expect(mounted.host.querySelector('[role="status"]')?.textContent).toContain('Saved. Preparing the page for viewing')
      expect(mounted.host.querySelector<HTMLButtonElement>('.editor-save-action')?.disabled).toBe(true)
      expect(mounted.host.querySelector<HTMLButtonElement>('.editor-save-close-action')?.disabled).toBe(true)
      expect(await mounted.context.save()).toBe(false)
      expect(await mounted.context.saveAndClose()).toBe(false)
      expect(mounted.context.isSaving).toBe(true)

      pendingUpdates = remainingBacklog
      mounted.context.editorAdapter.notifyState()
      ready = true
      await vi.advanceTimersByTimeAsync(100)
      expect(await saving).toBe(true)
      expect(previews).toBe(2)
      expect(writes).toBe(1)
      expect(mounted.context.isDirty).toBe(false)
      expect(mounted.context.editorAdapter.snapshot()).toMatchObject({
        editVersion: capturedVersion,
        nonPersisted: false,
        collaborationBacklog: remainingBacklog
      })
      expect(mounted.context.isSaving).toBe(false)
      expect(testWindow.location.assigned).toEqual([mode === 'update' ? '/_private/en/persisted-path' : '/en/persisted-path'])
    })
  }

  for (const failure of ['timeout', 'forbidden', 'untyped service failure', 'mismatched revision'] as const) {
    test(`mounted Save and close keeps a persisted save recoverable after ${failure} and retries readiness without rewriting`, async () => {
      vi.useFakeTimers()
      const store = Vue.reactive(createStore())
      const testWindow = createTestWindow()
      let writes = 0
      let retryReady = false
      let previews = 0
      mockRenderPreviews(testWindow, (async () => {
        previews++
        if (retryReady) return Response.json(createRenderPreview(store))
        if (failure === 'timeout') return Response.json({ error: 'Still rendering', code: 'PAGE_RENDER_PENDING' }, { status: 503 })
        if (failure === 'forbidden') return Response.json({ error: 'Page access was revoked.' }, { status: 403 })
        if (failure === 'untyped service failure') return Response.json({ error: 'Rendering service failed.' }, { status: 503 })
        return Response.json(createRenderPreview(store, '3'))
      }) as typeof fetch)
      const mounted = mountSaveActions(store, testWindow, {
        updatePage: async () => {
          writes++
          return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
        },
        fetchPage: async () => {
          throw pendingRenderError()
        },
        waitForPageRender
      })
      mounted.context.editorAdapter.replaceText('content that was saved')
      const saving = mounted.click()
      await flushSaveUi()
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(15_000)
      expect(await saving).toBe(false)
      await flushSaveUi()

      expect(writes).toBe(1)
      expect(mounted.context.savedState.content).toBe('content that was saved')
      expect(store.editor.content).toBe('content that was saved')
      expect(mounted.context.isDirty).toBe(false)
      expect(mounted.context.editorAdapterSafety.nonPersisted).toBe(false)
      expect(mounted.context.saveFeedback).toBe('saved')
      expect(mounted.context.isSaving).toBe(false)
      expect(mounted.context.exitConfirmed).toBe(false)
      expect(testWindow.location.assigned).toEqual([])
      expect(testWindow.location.replaced).toEqual([])
      expect(store.notifications.at(-1)?.style).toBe('warning')
      expect(mounted.host.querySelector('[role="status"]')?.textContent).not.toContain('Not saved')
      if (failure !== 'timeout') expect(previews).toBe(1)
      if (failure === 'forbidden') expect(String(store.notifications.at(-1)?.message)).toContain('Page access was revoked.')
      if (failure === 'untyped service failure') expect(String(store.notifications.at(-1)?.message)).toContain('Rendering service failed.')

      retryReady = true
      expect(await mounted.click()).toBe(true)
      expect(writes).toBe(1)
      expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
    })
  }

  for (const change of [
    'typing',
    'reverted typing',
    'metadata',
    'modal',
    'offline',
    'auth refresh',
    'merge',
    'collaboration backlog',
    'covered collaboration backlog',
    'new backlog after acknowledgement',
    'revision',
    'page',
    'account',
    'unmount'
  ] as const) {
    test(`mounted Save and close does not navigate when ${change} changes during render readiness`, async () => {
      const store = Vue.reactive(createStore())
      const testWindow = createTestWindow()
      let release!: (response: Response) => void
      let previewSignal: AbortSignal | undefined
      mockRenderPreviews(testWindow, (async (_url, init) => {
        previewSignal = init?.signal ?? undefined
        return new Promise<Response>(resolve => {
          release = resolve
        })
      }) as typeof fetch)
      const mounted = mountSaveActions(store, testWindow, {
        updatePage: async () => ({ sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }),
        fetchPage: async () => {
          throw pendingRenderError()
        },
        waitForPageRender
      })
      mounted.context.editorAdapter.replaceText('saved content')
      let pendingUpdates = change === 'covered collaboration backlog' || change === 'new backlog after acknowledgement' ? 3 : 0
      const snapshot = mounted.context.editorAdapter.snapshot
      mounted.context.editorAdapter.snapshot = () => ({ ...snapshot(), collaborationBacklog: pendingUpdates })
      mounted.context.editorAdapter.notifyState()
      const saving = mounted.click()
      await flushSaveUi()
      expect(previewSignal).toBeDefined()
      expect(mounted.context.editorAdapterSafety.nonPersisted).toBe(false)
      const savedPreview = createRenderPreview(store)
      if (change === 'typing' || change === 'reverted typing') mounted.context.editorAdapter.replaceText('new unsaved content')
      if (change === 'reverted typing') mounted.context.editorAdapter.replaceText('saved content')
      if (change === 'metadata') store.page.title = 'New unsaved title'
      if (change === 'modal') mounted.context.activeModal = 'editorModalConflict'
      if (change === 'offline') mounted.context.offlineConnectionState = 'offline'
      if (change === 'auth refresh') store.authRefreshPending = true
      if (change === 'merge') mounted.context.editorAdapterSafety.mergeDirty = true
      if (change === 'collaboration backlog' || change === 'covered collaboration backlog') {
        pendingUpdates++
        mounted.context.editorAdapter.notifyState()
      }
      if (change === 'new backlog after acknowledgement') {
        pendingUpdates = 2
        mounted.context.editorAdapter.notifyState()
        pendingUpdates = 3
        mounted.context.editorAdapter.notifyState()
      }
      if (change === 'revision') store.page.sourceRevision = '3'
      if (change === 'page') store.page.id = 99
      if (change === 'account') {
        mounted.context.accountId = 99
        store.user.id = 99
        store.offlineIdentityEpoch++
      }
      if (change === 'unmount') mounted.unmount()
      release(Response.json(savedPreview))
      expect(await saving).toBe(false)
      expect(testWindow.location.assigned).toEqual([])
      expect(testWindow.location.replaced).toEqual([])
      expect(mounted.context.savedState.content).toBe('saved content')
      if (change === 'typing') {
        expect(store.editor.content).toBe('new unsaved content')
        expect(mounted.context.isDirty).toBe(true)
      }
      if (change === 'metadata') expect(store.page.title).toBe('New unsaved title')
      if (change === 'account' || change === 'unmount') expect(previewSignal?.aborted).toBe(true)
    })
  }

  test('mounted Create keeps a successful write saved after render timeout and closes later without creating again', async () => {
    vi.useFakeTimers()
    const store = Vue.reactive(createStore('create'))
    const testWindow = createTestWindow()
    let creates = 0
    let ready = false
    mockRenderPreviews(testWindow, (async () =>
      ready
        ? Response.json(createRenderPreview(store))
        : Response.json({ error: 'Still rendering', code: 'PAGE_RENDER_PENDING' }, { status: 503 })) as typeof fetch)
    const mounted = mountSaveActions(store, testWindow, {
      createPage: async () => {
        creates++
        return { id: 91, sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      waitForPageRender
    })
    mounted.context.editorAdapter.replaceText('new page saved content')
    const creating = mounted.click('save')
    await flushSaveUi()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await creating).toBe(true)
    await flushSaveUi()
    expect(creates).toBe(1)
    expect(store.page.id).toBe(91)
    expect(store.editor.mode).toBe('update')
    expect(mounted.context.isDirty).toBe(false)
    expect(mounted.context.saveFeedback).toBe('saved')
    expect(store.editor.content).toBe('new page saved content')
    expect(store.notifications.at(-1)?.style).toBe('warning')
    expect(testWindow.location.assigned).toEqual([])

    ready = true
    expect(await mounted.click()).toBe(true)
    expect(creates).toBe(1)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
  })

  test('mounted clean Close after a server save waits for readiness without submitting again', async () => {
    const store = Vue.reactive(createStore())
    const testWindow = createTestWindow()
    let writes = 0
    let previews = 0
    let release!: (response: Response) => void
    mockRenderPreviews(testWindow, (async () => {
      previews++
      return new Promise<Response>(resolve => {
        release = resolve
      })
    }) as typeof fetch)
    const mounted = mountSaveActions(store, testWindow, {
      updatePage: async () => {
        writes++
        return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      fetchPage: async () => {
        throw pendingRenderError()
      },
      waitForPageRender
    })
    mounted.context.editorAdapter.replaceText('saved before ordinary Close')
    expect(await mounted.click('save')).toBe(true)
    await flushSaveUi()
    expect(previews).toBe(0)
    mounted.host.querySelector<HTMLButtonElement>('.editor-close-action')!.click()
    await flushSaveUi()
    expect(previews).toBe(1)
    expect(writes).toBe(1)
    expect(testWindow.location.assigned).toEqual([])
    expect(mounted.context.isSaving).toBe(true)

    release(Response.json(createRenderPreview(store)))
    await flushSaveUi()
    expect(writes).toBe(1)
    expect(mounted.context.isSaving).toBe(false)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
  })

  test('mounted plain Save acknowledges persisted source while its follow-up reader render is pending', async () => {
    const store = Vue.reactive(createStore())
    const testWindow = createTestWindow()
    let readinessCalls = 0
    const mounted = mountSaveActions(store, testWindow, {
      updatePage: async () => ({ sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }),
      fetchPage: async () => {
        throw pendingRenderError()
      },
      waitForPageRender: async () => {
        readinessCalls++
      }
    })
    mounted.context.editorAdapter.replaceText('saved without closing')
    expect(await mounted.click('save')).toBe(true)
    await flushSaveUi()
    expect(readinessCalls).toBe(0)
    expect(mounted.context.isDirty).toBe(false)
    expect(mounted.context.saveFeedback).toBe('saved')
    expect(mounted.context.savedState.content).toBe('saved without closing')
    expect(store.page.okfError).toBeNull()
    expect(store.notifications.at(-1)?.style).toBe('success')
    expect(testWindow.location.assigned).toEqual([])
  })

  test('mounted Save and close retains the genuine mutation-conflict path without waiting for render', async () => {
    const store = Vue.reactive(createStore())
    const testWindow = createTestWindow()
    let readinessCalls = 0
    const mounted = mountSaveActions(store, testWindow, {
      updatePage: async () => {
        throw Object.assign(new Error('The page changed on the server.'), { status: 409 })
      },
      waitForPageRender: async () => {
        readinessCalls++
      }
    })
    mounted.context.editorAdapter.replaceText('unsaved conflicted content')
    expect(await mounted.click()).toBe(false)
    await flushSaveUi()
    expect(readinessCalls).toBe(0)
    expect(mounted.context.isConflict).toBe(true)
    expect(mounted.context.isDirty).toBe(true)
    expect(mounted.context.saveFeedback).toBe('failed')
    expect(mounted.context.savedState.content).toBe('persisted content')
    expect(store.editor.content).toBe('unsaved conflicted content')
    expect(store.notifications.at(-1)?.style).toBe('warning')
    expect(testWindow.location.assigned).toEqual([])
  })

  test('binds each source controller only after the cold actor boundary is ready and retains owner fencing', async () => {
    const invocation = shellMarkup('component.editor-active-editor').toString()
    const compiled = compileTemplate({
      source: invocation,
      filename: shellPath,
      id: 'source-editor-readiness',
      compilerOptions: { mode: 'function' }
    })
    if (compiled.errors.length) throw compiled.errors[0]
    const render = new Function('Vue', compiled.code)(Vue)
    for (const [editor, mode, expectedCode] of [
      ['editorMarkdown', 'markdown', '```\nselected <>&\n```'],
      ['editorAsciidoc', 'asciidoc', '[source]\n----\nselected <>&\n----'],
      ['editorCode', 'html', '<pre><code>selected &lt;&gt;&amp;</code></pre>']
    ] as const) {
      const store = Vue.reactive(createStore())
      store.editor.editor = editor
      store.user = { authenticated: false, id: 0 }
      store.authRefreshPending = true
      store.authRefreshSettled = false
      store.offlineIdentityReady = false
      const behavior = loadShellBehavior(store, createTestWindow())
      const controllers: Array<{
        view: EditorView
        source: { insertCodeBlock: () => boolean; insertTable: () => boolean }
        image: { insert: (payload: { path: string; text?: string }) => boolean }
      }> = []
      const Source = Vue.defineComponent({
        setup() {
          const host = Vue.ref<HTMLElement>()
          Vue.onMounted(() => {
            const owner = () => `${store.user.id}:${store.offlineIdentityEpoch}:${store.page.id}`
            const source = createSourceAuthoring(mode, () => store.user.authenticated, owner)
            const image = createSourceImageAuthoring(mode, () => store.user.authenticated, owner)
            const view = new EditorView({
              parent: host.value,
              state: EditorState.create({
                doc: 'selected <>&',
                selection: { anchor: 0, head: 12 },
                extensions: [source.extension, image.extension]
              })
            })
            controllers.push({ view, source, image })
            Vue.onUnmounted(() => view.destroy())
          })
          return () => Vue.h('div', { ref: host })
        }
      })
      const host = document.createElement('div')
      document.body.append(host)
      const app = Vue.createApp(
        Vue.defineComponent({
          components: { [editor]: Source },
          setup() {
            return {
              currentEditor: Vue.computed(() => store.editor.editor),
              sourceEditorReady: Vue.computed(() =>
                behavior.computed.sourceEditorReady.call({
                  currentEditor: store.editor.editor,
                  warmAuthenticatedActor: behavior.computed.warmAuthenticatedActor.call({
                    isAuthenticated: store.user.authenticated,
                    accountId: store.user.id
                  })
                })
              ),
              editorInstanceKey: 0,
              save: () => undefined,
              wikiLinkOptions: undefined,
              handleCollaborationState: () => undefined,
              handleEditorAdapter: () => undefined,
              handleEditorAdapterClear: () => undefined
            }
          },
          render
        })
      )
      app.mount(host)
      try {
        expect(controllers).toHaveLength(0)
        store.user = { authenticated: true, id: 42 }
        await Vue.nextTick()
        expect(controllers).toHaveLength(0)
        store.offlineIdentityReady = true
        store.authRefreshPending = false
        store.authRefreshSettled = true
        await Vue.nextTick()
        expect(controllers).toHaveLength(1)
        const { source, image, view } = controllers[0]
        expect(source.insertCodeBlock()).toBe(true)
        expect(view.state.doc.toString()).toBe(expectedCode)
        expect(image.insert({ path: '/owned.png', text: 'owned' })).toBe(true)
        store.authRefreshPending = true
        store.authRefreshSettled = false
        await Vue.nextTick()
        expect(controllers).toHaveLength(1)
        store.offlineIdentityEpoch++
        const before = view.state.doc.toString()
        expect(source.insertTable()).toBe(false)
        expect(image.insert({ path: '/other.png' })).toBe(false)
        expect(view.state.doc.toString()).toBe(before)
      } finally {
        app.unmount()
        host.remove()
      }
    }
  })

  for (const outcome of ['ready', 'cancelled', 'account changed', 'forbidden'] as const) {
    test(`discard restores the private persisted baseline before waiting for a real render receipt: ${outcome}`, async () => {
      const store = createStore()
      store.editor.editorKey = 'visual-markdown'
      store.page.visibility = 'private'
      const testWindow = createTestWindow()
      let release!: (response: Response) => void
      let previewCalls = 0
      let writes = 0
      mockRenderPreviews(testWindow, (async () => {
        previewCalls++
        return await new Promise<Response>(resolve => {
          release = resolve
        })
      }) as typeof fetch)
      const context = createShellHarness(store, testWindow, {
        waitForPageRender,
        updatePage: async () => {
          writes++
          return { sourceRevision: 'unexpected', updatedAt: '' }
        }
      })
      const baseline = _.cloneDeep(context.savedState)
      context.editorAdapter.replaceText('new unsaved Visual Markdown')
      store.page.path = 'discarded-path'
      store.page.visibility = 'public'
      context.dialogUnsaved = true

      const discarding = context.discardAndExit()
      await flushSaveUi()

      expect(previewCalls).toBe(1)
      expect(testWindow.location.assigned).toEqual([])
      expect(mutableSnapshot(store)).toEqual(baseline)
      expect(context.editorAdapter.capture().text).toBe(baseline.content)
      expect(context.localDiscardCalls).toBe(1)
      expect(context.dialogUnsaved).toBe(false)
      if (outcome === 'cancelled') context.cancelRenderWait()
      if (outcome === 'account changed') context.accountId += 1
      release(
        outcome === 'forbidden'
          ? Response.json({ error: 'Page access was revoked.' }, { status: 403 })
          : Response.json(createRenderPreview(store, store.page.sourceRevision))
      )
      await discarding

      expect(testWindow.location.assigned).toEqual(outcome === 'ready' ? ['/_private/en/persisted-path'] : [])
      expect(mutableSnapshot(store)).toEqual(baseline)
      expect(context.editorAdapter.capture().text).toBe(baseline.content)
      expect(context.isDirty).toBe(false)
      expect(context.dialogUnsaved).toBe(false)
      expect(context.discardPending).toBe(false)
      expect(context.renderWaitController).toBeNull()
      expect(context.localDiscardCalls).toBe(1)
      expect(writes).toBe(0)
      if (outcome === 'forbidden') expect(String(store.notifications.at(-1)?.message)).toContain('Page access was revoked.')
    })
  }

  test('resets the durable Markdown draft before restoring a public page and exiting', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let persistenceCalls = 0
    const discardedDrafts: Array<{ pageId: number; expectedUpdatedAt: string; expectedSourceRevision: string }> = []
    const context = createShellHarness(store, testWindow, {
      discardCollaborationDraft: async (_fetcher, pageId, expectedUpdatedAt, expectedSourceRevision) => {
        discardedDrafts.push({ pageId, expectedUpdatedAt, expectedSourceRevision })
      },
      createPage: async () => {
        persistenceCalls++
        return { id: 0, updatedAt: '' }
      },
      updatePage: async () => {
        persistenceCalls++
        return { sourceRevision: 'unexpected', updatedAt: '' }
      },
      changePageVisibility: async () => {
        persistenceCalls++
        return { sourceRevision: 'unexpected' }
      }
    })
    const expected = _.cloneDeep(context.savedState)
    applyEveryEdit(store)
    context.dialogUnsaved = true
    context.navigationTimer = 77

    await context.discardAndExit()

    expect(mutableSnapshot(store)).toEqual(expected)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
    expect(testWindow.clearedTimers).toEqual([77])
    expect(testWindow.scheduledTimers).toEqual([])
    expect(context.navigationTimer).toBeNull()
    expect(context.exitConfirmed).toBe(true)
    expect(context.dialogUnsaved).toBe(false)
    expect(context.currentEditor).toBe('editorMarkdown')
    expect(context.progressShown).toBe(0)
    expect(context.progressHidden).toBe(0)
    expect(store.notifications).toEqual([])
    expect(store.loadingOwners).toEqual([])
    expect(persistenceCalls).toBe(0)
    expect(context.localDiscardCalls).toBe(1)
    expect(discardedDrafts).toEqual([
      {
        pageId: 12,
        expectedUpdatedAt: '2026-09-03T11:00:00.000Z',
        expectedSourceRevision: '1'
      }
    ])
    expect(store.page.tags).not.toBe(context.savedState.tags)
    expect(store.page.okf).not.toBe(context.savedState.okf)
    store.page.tags.push('new live tag')
    store.page.okf.authority.metadata = { type: 'LiveOnly' }
    expect(context.savedState.tags).toEqual(['persisted-tag'])
    expect(context.savedState.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable' })
  })

  test('restores private and create baselines to their canonical destinations', async () => {
    const privateStore = createStore()
    privateStore.page.visibility = 'private'
    privateStore.page.locale = 'de'
    privateStore.page.path = 'private-page'
    const privateWindow = createTestWindow()
    const privateContext = createShellHarness(privateStore, privateWindow)
    const expectedPrivate = _.cloneDeep(privateContext.savedState)
    applyEveryEdit(privateStore)
    privateStore.page.visibility = 'public'

    await privateContext.discardAndExit()

    expect(mutableSnapshot(privateStore)).toEqual(expectedPrivate)
    expect(privateWindow.location.assigned).toEqual(['/_private/de/private-page'])

    const createStoreState = createStore('create')
    const createWindow = createTestWindow()
    const createContext = createShellHarness(createStoreState, createWindow)
    const expectedCreate = _.cloneDeep(createContext.savedState)
    applyEveryEdit(createStoreState)

    await createContext.discardAndExit()

    expect(mutableSnapshot(createStoreState)).toEqual(expectedCreate)
    expect(createWindow.location.assigned).toEqual(['/'])
    expect(createStoreState.notifications).toEqual([])
    expect(createStoreState.loadingOwners).toEqual([])
  })

  test('does not call collaboration reset for non-collaboration editors', async () => {
    const store = createStore()
    store.editor.editorKey = 'code'
    store.editor.editor = 'editorCode'
    const testWindow = createTestWindow()
    let collaborationDiscardCalls = 0
    const context = createShellHarness(store, testWindow, {
      discardCollaborationDraft: async () => {
        collaborationDiscardCalls++
      }
    })
    applyEveryEdit(store)

    await context.discardAndExit()

    expect(collaborationDiscardCalls).toBe(0)
    expect(context.localDiscardCalls).toBe(1)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
    expect(context.isDirty).toBe(false)
  })

  test('discards locally when Markdown collaboration startup fell back or is disabled', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let collaborationDiscardCalls = 0
    const context = createShellHarness(store, testWindow, {
      discardCollaborationDraft: async () => {
        collaborationDiscardCalls++
      }
    })
    context.handleCollaborationState({ active: false, discarded: false, generation: null })
    applyEveryEdit(store)

    await context.discardAndExit()

    expect(collaborationDiscardCalls).toBe(0)
    expect(context.localDiscardCalls).toBe(1)
    expect(context.isDirty).toBe(false)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
  })

  test('keeps the dirty editor open when durable collaboration discard fails', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow, {
      discardCollaborationDraft: async () => {
        throw new Error('Another user is actively editing this page.')
      }
    })
    applyEveryEdit(store)
    const dirtyState = mutableSnapshot(store)
    context.dialogUnsaved = true

    await context.discardAndExit()

    expect(mutableSnapshot(store)).toEqual(dirtyState)
    expect(context.isDirty).toBe(true)
    expect(context.dialogUnsaved).toBe(true)
    expect(context.exitConfirmed).toBe(false)
    expect(testWindow.location.assigned).toEqual([])
    expect(context.progressShown).toBe(0)
    expect(context.progressHidden).toBe(0)
    expect(store.loadingOwners).toEqual([])
    expect(store.notifications).toEqual([
      {
        message: 'Another user is actively editing this page.',
        style: 'error',
        icon: 'warning'
      }
    ])
  })

  test('turns an unnotified stale peer terminal when its generation-fenced Save is rejected', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        throw new Error('This collaboration draft was discarded. Reload the page before saving.')
      }
    })
    applyEveryEdit(store)

    await context.save()
    await context.save()

    expect(updateCalls).toBe(1)
    expect(context.collaborationActive).toBe(false)
    expect(context.collaborationGeneration).toBeNull()
    expect(context.collaborationDiscarded).toBe(true)
    expect(context.isDirty).toBe(true)
    expect(testWindow.location.assigned).toEqual([])
  })

  test('blocks stale peer-tab save and save-and-close after terminal discard', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        return { sourceRevision: '2', updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    store.editor.content = 'discarded stale content'
    context.handleCollaborationState({ active: false, discarded: true, generation: null })
    context.handleCollaborationState({ active: false, discarded: false, generation: null })
    await context.save()
    expect(await context.saveAndClose()).toBe(false)

    expect(updateCalls).toBe(0)
    expect(testWindow.location.assigned).toEqual([])
    expect(context.progressShown).toBe(0)
    expect(context.progressHidden).toBe(0)
    expect(store.notifications).toHaveLength(2)
    for (const notification of store.notifications) {
      expect(notification.style).toBe('error')
      expect(String(notification.message)).toMatch(/discard/i)
      expect(String(notification.message)).toMatch(/reload/i)
    }
  })
  test('opens the dirty modal but closes a clean editor immediately without save behavior', async () => {
    const cleanStore = createStore()
    const cleanWindow = createTestWindow()
    const cleanContext = createShellHarness(cleanStore, cleanWindow)
    cleanContext.navigationTimer = 41

    await cleanContext.exit()

    expect(cleanWindow.location.assigned).toEqual(['/en/persisted-path'])
    expect(cleanWindow.clearedTimers).toEqual([41])
    expect(cleanWindow.scheduledTimers).toEqual([])
    expect(cleanContext.currentEditor).toBe('editorMarkdown')
    expect(cleanContext.exitConfirmed).toBe(true)
    expect(cleanContext.progressShown).toBe(0)
    expect(cleanStore.notifications).toEqual([])
    expect(cleanStore.loadingOwners).toEqual([])

    const dirtyStore = createStore()
    const dirtyWindow = createTestWindow()
    const dirtyContext = createShellHarness(dirtyStore, dirtyWindow)
    dirtyStore.editor.content = 'unsaved content'

    await dirtyContext.exit()

    expect(dirtyContext.dialogUnsaved).toBe(true)
    expect(dirtyContext.exitConfirmed).toBe(false)
    expect(dirtyWindow.location.assigned).toEqual([])
    expect(dirtyWindow.scheduledTimers).toEqual([])
  })
  test('ignores generated state, normalizes optional dates, and tracks editable changes', () => {
    const store = createStore()
    store.page.publishStartDate = ''
    store.page.publishEndDate = null as unknown as string
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow)

    store.page.okf.authority.trust = { score: 0 }
    store.page.okf.projection = { state: 'stale', value: { summary: 'generated only' } }
    store.page.brandingView = {} as PageBrandingView
    store.page.publishStartDate = null as unknown as string
    store.page.publishEndDate = ''

    expect(context.isDirty).toBe(false)
    expect(context.isMetadataDirty()).toBe(false)

    store.page.okf.authority.metadata = { type: 'Reference', status: 'draft' }
    expect(context.isDirty).toBe(true)
    expect(context.isMetadataDirty()).toBe(true)
    store.page.okf.authority.metadata = { type: 'Reference', status: 'stable' }
    store.editor.content = 'content changed'
    expect(context.isDirty).toBe(true)
    expect(context.isMetadataDirty()).toBe(false)
    store.editor.content = 'persisted content'
    expect(context.isDirty).toBe(false)
  })

  test('captures ready editor text before deciding whether close is dirty', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow)
    context.editorAdapter.capture = () => ({ text: 'adapter-only content', editVersion: 1 })

    await context.exit()

    expect(store.editor.content).toBe('adapter-only content')
    expect(context.isDirty).toBe(true)
    expect(context.dialogUnsaved).toBe(true)
    expect(testWindow.location.assigned).toEqual([])
  })

  test('keeps the unsaved dialog open and displays the real discard failure', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow)
    const coordinator = context.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.discardCurrentDraft = async () => false
    context.offlineDraftError = 'The local draft could not be discarded.'
    applyEveryEdit(store)
    context.dialogUnsaved = true

    await context.discardAndExit()

    expect(context.dialogUnsaved).toBe(true)
    expect(context.discardError).toBe('The local draft could not be discarded.')
    expect(context.isDirty).toBe(true)
    expect(testWindow.location.assigned).toEqual([])
    expect(store.notifications).toEqual([
      {
        message: 'The local draft could not be discarded.',
        style: 'error',
        icon: 'warning'
      }
    ])
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({
      setup: () => context,
      render: ownerUnsavedRender
    })
    app.config.globalProperties.$t = translateEnglish
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.component('VCardChin', { render: cardRender })
    app.component('EditorModalUnsaved', { ...modalOptions, render: modalRender })
    app.mount(host)
    modalUnmounts.push(() => {
      app.unmount()
      host.remove()
    })
    await Vue.nextTick()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.querySelector('[role="alert"]')?.textContent?.trim()).toBe(context.discardError)
    // Main must execute the behavioral replacement before retiring this former binding guard.
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/editor-modal-unsaved\([\s\S]*:error='discardError'/)
  })

  test('unsaved dialog shows a spinner on Discard and keeps it apart from Save and close', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({
      render: () => Vue.h(Vue.resolveComponent('EditorModalUnsaved'), { modelValue: true, discarding: true })
    })
    app.config.globalProperties.$t = translateEnglish
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.component('VCardChin', { render: cardRender })
    app.component('EditorModalUnsaved', { ...modalOptions, render: modalRender })
    app.mount(host)
    modalUnmounts.push(() => {
      app.unmount()
      host.remove()
    })
    await Vue.nextTick()
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['Discard Changes', 'Cancel', 'Save and close'])
    expect(buttons[0]?.classList.contains('v-btn--loading')).toBe(true)
    expect(buttons[2]?.classList.contains('v-btn--loading')).toBe(false)
    expect(buttons.every(button => button.disabled)).toBe(true)
  })

  test('records one eligible automatic edit after a successful update', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const records: Array<{ selector: unknown; options: Record<string, unknown> }> = []
    const storage = createOfflineStorage(true, async (selector, options) => {
      records.push({ selector, options })
    })
    const context = createShellHarness(store, testWindow, {
      openOfflineStorage: async () => storage
    })
    store.editor.content = 'edited content'

    expect(await context.save()).toBe(true)

    expect(records).toHaveLength(1)
    expect(records[0]?.selector).toEqual({
      siteId: 'https://wiki.example.test',
      pageId: 12,
      locale: 'en'
    })
    expect(Object.isFrozen(records[0]?.selector)).toBe(true)
    expect(records[0]?.options).toMatchObject({
      expectedSessionGeneration: 4,
      expectedPolicyRevision: 7,
      editedAt: '2026-09-03T12:00:00.000Z'
    })
    expect(context.isDirty).toBe(false)
    expect(testWindow.location.assigned).toEqual([])
  })

  test('keeps the editor usable during an inline save and rejects a parallel save', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let releaseWrite: () => void = () => undefined
    let writes = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        writes++
        await new Promise<void>(resolve => {
          releaseWrite = resolve
        })
        return { sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    store.editor.content = 'edited content'

    const firstSave = context.save()
    await Promise.resolve()
    expect(context.isSaving).toBe(true)
    expect(context.saveFeedback).toBe('saving')
    // A second click, Ctrl+S or Save and close must not start another write.
    expect(await context.save()).toBe(false)
    expect(await context.saveAndClose()).toBe(false)
    for (let attempt = 0; attempt < 20 && writes === 0; attempt++) await Promise.resolve()
    releaseWrite()

    expect(await firstSave).toBe(true)
    expect(writes).toBe(1)
    expect(context.isSaving).toBe(false)
    expect(context.saveFeedback).toBe('saved')
    expect(context.lastSavedAt).toBeGreaterThan(0)
    expect(shellSfc.descriptor.template?.content ?? '').not.toContain('login-success-animation')
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/v-btn\.editor-save-action\([\s\S]*:loading='isSaving'/)
  })

  test('records a successful create before Save and close navigates', async () => {
    const store = createStore('create')
    const testWindow = createTestWindow()
    const records: unknown[] = []
    let assignedAtRecord = -1
    const storage = createOfflineStorage(true, async selector => {
      assignedAtRecord = testWindow.location.assigned.length
      records.push(selector)
    })
    const context = createShellHarness(store, testWindow, {
      openOfflineStorage: async () => storage
    })
    store.editor.content = 'new page content'
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      siteId: 'https://wiki.example.test',
      pageId: 91,
      locale: 'en'
    })
    expect(assignedAtRecord).toBe(0)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
  })

  test('does not record metadata for failed, excluded, or ineligible saves', async () => {
    const ineligibleCases: Array<(store: EditorStore, testWindow: TestWindow) => void> = [
      store => {
        store.page.visibility = 'private'
      },
      store => {
        store.page.isPublished = false
      },
      (_store, testWindow) => {
        testWindow.fetch = (() =>
          Promise.resolve(
            new Response(JSON.stringify({ protected: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )) as unknown as typeof fetch
      },
      (_store, testWindow) => {
        testWindow.fetch = (() => Promise.resolve(new Response(JSON.stringify({})))) as unknown as typeof fetch
      },
      store => {
        store.editor.editorKey = 'unsupported'
        store.editor.editor = 'unsupported'
      }
    ]

    for (const configure of ineligibleCases) {
      const store = createStore()
      const testWindow = createTestWindow()
      configure(store, testWindow)
      let recordCalls = 0
      const storage = createOfflineStorage(true, async () => {
        recordCalls++
      })
      const context = createShellHarness(store, testWindow, {
        openOfflineStorage: async () => storage
      })
      store.editor.content = 'edited content'

      expect(await context.save()).toBe(true)
      expect(recordCalls).toBe(0)
    }

    const excludedStore = createStore()
    let excludedRecordCalls = 0
    const excludedStorage = createOfflineStorage(true, async () => {
      excludedRecordCalls++
    }, [{ siteId: 'https://wiki.example.test', pageId: 12, locale: 'en', excluded: true, availability: 'available' }])
    const excludedContext = createShellHarness(excludedStore, createTestWindow(), {
      openOfflineStorage: async () => excludedStorage
    })
    excludedStore.editor.content = 'edited content'

    expect(await excludedContext.save()).toBe(true)
    expect(excludedRecordCalls).toBe(0)

    const failedStore = createStore()
    let failedRecordCalls = 0
    const failedStorage = createOfflineStorage(true, async () => {
      failedRecordCalls++
    })
    const failedContext = createShellHarness(failedStore, createTestWindow(), {
      openOfflineStorage: async () => failedStorage,
      updatePage: async () => {
        throw new Error('save rejected')
      }
    })
    failedStore.editor.content = 'edited content'

    expect(await failedContext.save()).toBe(false)
    expect(failedRecordCalls).toBe(0)
  })

  test('keeps a successful save nonfatal when automatic metadata recording fails', async () => {
    const store = createStore('create')
    const testWindow = createTestWindow()
    let recordCalls = 0
    const storage = createOfflineStorage(true, async () => {
      recordCalls++
      throw new Error('quota exhausted')
    })
    const context = createShellHarness(store, testWindow, {
      openOfflineStorage: async () => storage
    })
    store.editor.content = 'new page content'
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(recordCalls).toBe(1)
    expect(testWindow.location.assigned).toEqual(['/en/persisted-path'])
    const warnings = store.notifications.filter(notification => notification.style === 'warning')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.message)).toContain('quota exhausted')
  })

  test('successful update Save and close persists edits and cancels the stale edit redirect', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateInput: PageInput | undefined
    let updateFence: { sourceRevision: string; generation: number | undefined } | undefined
    let visibilityCalls = 0
    let started!: () => void
    let release!: () => void
    const requestStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const requestRelease = new Promise<void>(resolve => {
      release = resolve
    })
    const context = createShellHarness(store, testWindow, {
      updatePage: async (_fetcher, _id, input, sourceRevision, generation) => {
        updateInput = input
        updateFence = { sourceRevision, generation }
        started()
        await requestRelease
        return { sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      changePageVisibility: async () => {
        visibilityCalls++
        return { sourceRevision: 'revision-3' }
      },
      fetchPage: async () => ({
        okf: _.cloneDeep(store.page.okf),
        sourceRevision: 'revision-3',
        isSearchable: store.page.isSearchable
      })
    })
    applyEveryEdit(store)
    context.dialogUnsaved = true

    const save = context.saveUnsavedAndClose()
    await requestStarted
    const originalMetadata = _.cloneDeep(store.page.okf.authority.metadata)
    store.page.tags.push('later-live-tag')
    store.page.okf.authority.metadata!.type = 'Later live type'
    store.page.title = 'Later live title'
    expect(updateInput?.tags).toEqual(['discarded-tag'])
    expect(updateInput?.okfMetadata).toEqual({ type: 'Article', status: 'draft' })
    expect(updateInput?.title).toBe('Discarded title')
    // Return to the submitted snapshot before completion to retain this case's clean-close contract.
    store.page.tags.pop()
    store.page.okf.authority.metadata = originalMetadata
    store.page.title = 'Discarded title'
    release()
    await save

    expect(updateInput).toMatchObject({
      content: 'discarded content',
      description: 'discarded description',
      locale: 'fr',
      visibility: 'private',
      path: 'discarded-path',
      title: 'Discarded title'
    })
    expect(updateFence).toEqual({ sourceRevision: '1', generation: 1 })
    expect(updateInput?.tags).toEqual(['discarded-tag'])
    expect(updateInput?.okfMetadata).toEqual({ type: 'Article', status: 'draft' })
    expect(visibilityCalls).toBe(1)
    expect(context.savedState).toEqual(mutableSnapshot(store))
    expect(context.isDirty).toBe(false)
    expect(context.dialogUnsaved).toBe(false)
    expect(context.saveFeedback).toBe('saved')
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]?.style).toBe('success')
    expect(store.loadingOwners).toEqual([])
    expect(testWindow.scheduledTimers).toEqual([])
    expect(testWindow.clearedTimers).toEqual([])
    expect(context.navigationTimer).toBeNull()
    expect(testWindow.location.replaced).toEqual([])
    expect(testWindow.location.assigned).toEqual(['/_private/fr/discarded-path'])
  })

  test('failed Save and close keeps edits and the unsaved dialog without navigating', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        throw new Error('save rejected')
      }
    })
    const baseline = _.cloneDeep(context.savedState)
    applyEveryEdit(store)
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(context.savedState).toEqual(baseline)
    expect(context.isDirty).toBe(true)
    expect(context.dialogUnsaved).toBe(true)
    expect(context.exitConfirmed).toBe(false)
    expect(context.saveFeedback).toBe('failed')
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]?.style).toBe('error')
    expect(store.notifications[0]?.message).toBe('save rejected')
    expect(store.loadingOwners).toEqual([])
    expect(testWindow.location.assigned).toEqual([])
    expect(testWindow.location.replaced).toEqual([])
    expect(testWindow.scheduledTimers).toEqual([])
  })

  test('successful create Save and close keeps saved values and navigates once', async () => {
    const store = createStore('create')
    const testWindow = createTestWindow()
    let createdInput: PageInput | undefined
    let started!: () => void
    let release!: () => void
    const requestStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const requestRelease = new Promise<void>(resolve => {
      release = resolve
    })
    const context = createShellHarness(store, testWindow, {
      createPage: async (_fetcher, input) => {
        createdInput = input
        started()
        await requestRelease
        return { id: 91, sourceRevision: 'revision-1', updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    applyEveryEdit(store)
    context.dialogUnsaved = true

    const save = context.saveUnsavedAndClose()
    await requestStarted
    const originalMetadata = _.cloneDeep(store.page.okf.authority.metadata)
    store.page.tags.push('later-live-tag')
    store.page.okf.authority.metadata!.type = 'Later live type'
    store.editor.content = 'Later live content'
    expect(createdInput?.tags).toEqual(['discarded-tag'])
    expect(createdInput?.okfMetadata).toEqual({ type: 'Article', status: 'draft' })
    expect(createdInput?.content).toBe('discarded content')
    store.page.tags.pop()
    store.page.okf.authority.metadata = originalMetadata
    store.editor.content = 'discarded content'
    release()
    await save

    expect(createdInput?.content).toBe('discarded content')
    expect(createdInput?.tags).toEqual(['discarded-tag'])
    expect(createdInput?.okfMetadata).toEqual({ type: 'Article', status: 'draft' })
    expect(store.editor.id).toBe(91)
    expect(store.editor.mode).toBe('update')
    expect(context.savedState).toEqual(mutableSnapshot(store))
    expect(context.dialogUnsaved).toBe(false)
    expect(context.saveFeedback).toBe('saved')
    expect(testWindow.location.assigned).toEqual(['/_private/fr/discarded-path'])
    expect(testWindow.scheduledTimers).toEqual([])
    expect(store.loadingOwners).toEqual([])
  })

  for (const originalVisibility of ['public', 'private'] as const) {
    for (const failRefresh of [false, true]) {
      test(`keeps a failed ${originalVisibility} visibility transition retryable after persisted content${failRefresh ? ' and a failed refresh' : ''}`, async () => {
        const store = createStore()
        store.page.visibility = originalVisibility
        const requestedVisibility = originalVisibility === 'public' ? 'private' : 'public'
        const testWindow = createTestWindow()
        const persistedOkf = _.cloneDeep(store.page.okf)
        const writeRevisions: string[] = []
        const visibilityRequests: Array<{ visibility: string; sourceRevision: string }> = []
        let refreshCalls = 0
        const context = createShellHarness(store, testWindow, {
          updatePage: async (_fetcher, _id, _input, sourceRevision) => {
            writeRevisions.push(sourceRevision)
            return { sourceRevision: `content-revision-${writeRevisions.length}`, updatedAt: '2026-09-03T12:00:00.000Z' }
          },
          changePageVisibility: async (_fetcher, _id, visibility, sourceRevision) => {
            visibilityRequests.push({ visibility, sourceRevision })
            if (visibilityRequests.length === 1) throw new Error('Visibility change was rejected.')
            return { sourceRevision: 'visibility-revision' }
          },
          fetchPage: async () => {
            refreshCalls++
            if (refreshCalls === 1 && failRefresh) throw new Error('Follow-up page could not be loaded.')
            return {
              okf: _.cloneDeep(persistedOkf),
              sourceRevision: refreshCalls === 1 ? 'content-revision-1' : 'visibility-revision',
              isSearchable: true
            }
          }
        })
        context.editorAdapter.replaceText('content that did persist')
        store.page.visibility = requestedVisibility

        expect(await context.saveAndClose()).toBe(false)
        expect(context.savedState.content).toBe('content that did persist')
        expect(context.savedState.visibility).toBe(originalVisibility)
        expect(store.page.visibility).toBe(requestedVisibility)
        expect(store.page.sourceRevision).toBe('content-revision-1')
        expect(context.checkoutDateActive).toBe('2026-09-03T12:00:00.000Z')
        expect(context.editorAdapterSafety.nonPersisted).toBe(false)
        expect(context.isDirty).toBe(true)
        expect(store.notifications).toHaveLength(1)
        expect(store.notifications[0]?.style).toBe('warning')
        expect(String(store.notifications[0]?.message)).toContain('Visibility change was rejected.')
        expect(testWindow.location.assigned).toEqual([])
        expect(testWindow.location.replaced).toEqual([])
        expect(testWindow.scheduledTimers).toEqual([])

        expect(await context.save()).toBe(true)
        expect(writeRevisions).toEqual(['1', 'content-revision-1'])
        expect(visibilityRequests).toEqual([
          { visibility: requestedVisibility, sourceRevision: 'content-revision-1' },
          { visibility: requestedVisibility, sourceRevision: 'content-revision-2' }
        ])
        expect(context.savedState.visibility).toBe(requestedVisibility)
        expect(context.isDirty).toBe(false)
      })
    }
  }

  for (const pendingStage of ['write', 'refresh'] as const) {
    for (const lateEdit of ['Knowledge', 'searchability', 'both'] as const) {
      test(`preserves late ${lateEdit} edits while the save ${pendingStage} is pending and acknowledges the submitted baseline`, async () => {
        const store = createStore()
        const testWindow = createTestWindow()
        const originalOkf = _.cloneDeep(store.page.okf)
        const submittedOkf = _.cloneDeep(originalOkf)
        submittedOkf.authority.metadata = { type: 'Article', status: 'draft' }
        submittedOkf.projection = { state: 'current', value: { summary: 'authoritative saved projection' } }
        let started!: () => void
        let release!: () => void
        const pendingStarted = new Promise<void>(resolve => {
          started = resolve
        })
        const pendingRelease = new Promise<void>(resolve => {
          release = resolve
        })
        const inputs: PageInput[] = []
        let refreshCalls = 0
        const changesKnowledge = lateEdit !== 'searchability'
        const changesSearchability = lateEdit !== 'Knowledge'
        const context = createShellHarness(store, testWindow, {
          updatePage: async (_fetcher, _id, input) => {
            inputs.push(_.cloneDeep(input))
            if (inputs.length === 1 && pendingStage === 'write') {
              started()
              await pendingRelease
            }
            return { sourceRevision: 'content-revision', updatedAt: '2026-09-03T12:00:00.000Z' }
          },
          fetchPage: async () => {
            refreshCalls++
            if (refreshCalls === 1 && pendingStage === 'refresh') {
              started()
              await pendingRelease
            }
            return {
              okf: _.cloneDeep(refreshCalls === 1 || !changesKnowledge ? submittedOkf : originalOkf),
              sourceRevision: 'authoritative-revision',
              isSearchable: refreshCalls > 1 && changesSearchability
            }
          }
        })
        context.editorAdapter.replaceText('submitted content')
        store.page.okf.authority.metadata = { type: 'Article', status: 'draft' }
        store.page.isSearchable = false
        const save = context.save()
        await pendingStarted
        // Reverting a field to its old baseline is still a new unsaved edit after this capture.
        if (changesKnowledge) store.page.okf.authority.metadata = _.cloneDeep(originalOkf.authority.metadata)
        if (changesSearchability) store.page.isSearchable = true
        release()

        expect(await save).toBe(true)
        expect(store.page.okf.authority.metadata).toEqual(changesKnowledge ? originalOkf.authority.metadata : submittedOkf.authority.metadata)
        if (!changesKnowledge) expect(store.page.okf.projection).toEqual(submittedOkf.projection)
        expect(store.page.isSearchable).toBe(changesSearchability)
        expect(context.savedState.content).toBe('submitted content')
        expect(context.savedState.okf.authority.metadata).toEqual({ type: 'Article', status: 'draft' })
        expect(context.savedState.isSearchable).toBe(false)
        expect(context.editorAdapterSafety.nonPersisted).toBe(false)
        expect(context.isDirty).toBe(true)
        expect(testWindow.location.assigned).toEqual([])
        expect(testWindow.location.replaced).toEqual([])

        expect(await context.save()).toBe(true)
        expect(inputs[1]?.okfMetadata).toEqual(changesKnowledge ? originalOkf.authority.metadata : submittedOkf.authority.metadata)
        expect(inputs[1]?.isSearchable).toBe(changesSearchability)
        expect(context.isDirty).toBe(false)
      })
    }
  }

  test('keeps late typing after create and uses the authoritative new ID for conflict, update and hydration', async () => {
    const store = createStore('create')
    store.page.id = 0
    store.editor.id = 0
    const testWindow = createTestWindow()
    const persistedOkf = _.cloneDeep(store.page.okf)
    let started!: () => void
    let release!: () => void
    const createStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const createRelease = new Promise<void>(resolve => {
      release = resolve
    })
    const createdInputs: PageInput[] = []
    const updatedInputs: Array<{ id: number; content: string; sourceRevision: string }> = []
    const conflictIds: number[] = []
    const fetchedIds: number[] = []
    const context = createShellHarness(store, testWindow, {
      createPage: async (_fetcher, input) => {
        createdInputs.push(_.cloneDeep(input))
        started()
        await createRelease
        return { id: 91, sourceRevision: 'created-revision', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      checkPageConflict: async (_fetcher, id) => {
        conflictIds.push(id)
        return false
      },
      updatePage: async (_fetcher, id, input, sourceRevision) => {
        updatedInputs.push({ id, content: input.content, sourceRevision })
        return { sourceRevision: 'updated-revision', updatedAt: '2026-09-03T13:00:00.000Z' }
      },
      fetchPage: async (_fetcher, id) => {
        fetchedIds.push(id)
        return { okf: _.cloneDeep(persistedOkf), sourceRevision: 'updated-revision', isSearchable: true }
      }
    })
    context.editorAdapter.replaceText('captured new content')
    const create = context.save()
    await createStarted
    context.editorAdapter.replaceText('late new content')
    release()

    expect(await create).toBe(true)
    expect(createdInputs[0]?.content).toBe('captured new content')
    expect(store.editor.content).toBe('late new content')
    expect(store.page.id).toBe(91)
    expect(store.editor.mode).toBe('update')
    expect(context.pageId).toBe(0)
    expect(context.savedState.content).toBe('captured new content')
    expect(context.isDirty).toBe(true)
    expect(context.editorAdapterSafety.nonPersisted).toBe(true)
    expect(testWindow.location.assigned).toEqual([])

    await context.refreshConflict()
    expect(conflictIds).toEqual([91])
    expect(await context.save()).toBe(true)
    expect(conflictIds).toEqual([91, 91])
    expect(updatedInputs).toEqual([{ id: 91, content: 'late new content', sourceRevision: 'created-revision' }])
    expect(fetchedIds).toEqual([91])
    expect(context.isDirty).toBe(false)
    expect(store.notifications.every(notification => notification.style === 'success')).toBe(true)

    await context.hydratePage()
    expect(fetchedIds).toEqual([91, 91])
  })

  for (const boundary of ['page', 'lifecycle', 'account'] as const) {
    test(`ignores a save hydration response after the ${boundary} identity boundary changes`, async () => {
      const store = createStore()
      const testWindow = createTestWindow()
      let release!: () => void
      const requestRelease = new Promise<void>(resolve => {
        release = resolve
      })
      const oldOkf = _.cloneDeep(store.page.okf)
      const context = createShellHarness(store, testWindow, {
        fetchPage: async () => {
          await requestRelease
          return {
            okf: { ...oldOkf, authority: { ...oldOkf.authority, metadata: { type: 'Stale response' } } },
            sourceRevision: 'stale-revision',
            isSearchable: false
          }
        }
      })
      const refresh = context.refreshOkfAfterSave(context.captureSaveSnapshot())
      if (boundary === 'page') store.page.id = 99
      if (boundary === 'lifecycle') context.lifecycleGeneration++
      if (boundary === 'account') {
        context.accountId = 99
        store.user.id = 99
        store.offlineIdentityEpoch++
      }
      release()
      await refresh

      expect(store.page.okf).toEqual(oldOkf)
      expect(store.page.sourceRevision).toBe('1')
      expect(store.page.isSearchable).toBe(true)
    })
  }

  test('ignores a conflict result for a replaced current store page even if the original prop is unchanged', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let release!: (conflict: boolean) => void
    const pendingConflict = new Promise<boolean>(resolve => {
      release = resolve
    })
    const context = createShellHarness(store, testWindow, {
      checkPageConflict: async () => pendingConflict
    })
    context.editorAdapter.replaceText('dirty content')
    const refresh = context.refreshConflict()
    store.page.id = 99
    release(true)
    await refresh
    expect(context.pageId).toBe(12)
    expect(context.isConflict).toBe(false)
  })

  test('prompts only for a genuinely dirty unconfirmed unload', () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow)
    store.editor.content = 'unsaved content'
    let prevented = 0
    const dirtyEvent = {
      preventDefault: () => {
        prevented++
      },
      returnValue: false
    } as unknown as BeforeUnloadEvent

    context.handleBeforeUnload(dirtyEvent)

    expect(prevented).toBe(1)
    expect(dirtyEvent.returnValue).toBe(true)

    context.restoreCurrentSavedState()
    const restoredEvent = {
      preventDefault: () => {
        prevented++
      },
      returnValue: false
    } as unknown as BeforeUnloadEvent
    context.handleBeforeUnload(restoredEvent)
    expect(prevented).toBe(1)
    expect(restoredEvent.returnValue).toBe(false)

    store.editor.content = 'new unsaved content'
    context.exitConfirmed = true
    const confirmedEvent = {
      preventDefault: () => {
        prevented++
      },
      returnValue: false
    } as unknown as BeforeUnloadEvent
    context.handleBeforeUnload(confirmedEvent)
    expect(prevented).toBe(1)
    expect(confirmedEvent.returnValue).toBe(false)
  })
  test('invalidating the offline session destroys the editor boundary without restoring plaintext', () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const context = createShellHarness(store, testWindow)
    applyEveryEdit(store)
    context.activeModal = 'editorModalConflict'
    context.dialogUnsaved = true
    context.navigationTimer = 77
    store.offlineIdentityEpoch = 1

    context.handleOfflineSessionInvalidated()

    expect(store.editor.content).toBe('')
    expect(store.editor.mode).toBe('create')
    expect(store.page.title).toBe('')
    expect(store.page.description).toBe('')
    expect(store.page.scriptCss).toBe('')
    expect(store.page.scriptJs).toBe('')
    expect(store.page.tags).toEqual([])
    expect(context.savedState.content).toBe('')
    expect(context.savedState.title).toBe('')
    expect(context.activeModal).toBe('')
    expect(context.dialogUnsaved).toBe(false)
    expect(context.offlineDraftStatus).toBe('locked')
    expect(context.collaborationActive).toBe(false)
    expect(context.collaborationGeneration).toBeNull()
    expect(context.editorAdapterSafety.ready).toBe(false)
    expect(context.editorInstanceKey).toBe(1)
    expect(testWindow.clearedTimers).toEqual([77])
    expect(JSON.stringify(context.savedState)).not.toContain('persisted content')
    expect(JSON.stringify(store.page)).not.toContain('persisted description')
  })
  test('blocks save, save-and-close and unsaved-save-and-close while draft recovery is locked or missing', async () => {
    const lockedStore = createStore()
    const lockedWindow = createTestWindow()
    let lockedWrites = 0
    const lockedContext = createShellHarness(lockedStore, lockedWindow, {
      updatePage: async () => {
        lockedWrites++
        return { sourceRevision: 'unexpected', updatedAt: '' }
      }
    })
    applyEveryEdit(lockedStore)
    lockedContext.offlineDraftStatus = 'locked'
    expect(lockedContext.offlineDraftMutationBlocked).toBe(true)
    expect(lockedContext.offlineMutationBlocked).toBe(true)
    expect(await lockedContext.save()).toBe(false)
    expect(await lockedContext.saveAndClose()).toBe(false)
    lockedContext.dialogUnsaved = true
    await lockedContext.saveUnsavedAndClose()
    expect(lockedContext.dialogUnsaved).toBe(true)
    expect(lockedContext.exitConfirmed).toBe(false)
    expect(lockedWindow.location.assigned).toEqual([])
    expect(lockedWindow.location.replaced).toEqual([])
    expect(lockedWrites).toBe(0)
    expect(lockedContext.progressShown).toBe(0)
    expect(lockedContext.progressHidden).toBe(0)
    expect(lockedStore.notifications).toHaveLength(3)
    for (const notification of lockedStore.notifications) expect(notification.style).toBe('warning')

    const missingStore = createStore()
    const missingWindow = createTestWindow()
    let missingWrites = 0
    const missingContext = createShellHarness(missingStore, missingWindow, {
      updatePage: async () => {
        missingWrites++
        return { sourceRevision: 'unexpected', updatedAt: '' }
      }
    })
    applyEveryEdit(missingStore)
    missingContext.offlineDraftCoordinator = null

    expect(missingContext.offlineDraftMutationBlocked).toBe(true)
    expect(missingContext.offlineMutationBlocked).toBe(true)
    expect(await missingContext.save()).toBe(false)
    expect(await missingContext.saveAndClose()).toBe(false)
    missingContext.dialogUnsaved = true
    await missingContext.saveUnsavedAndClose()
    expect(missingContext.dialogUnsaved).toBe(true)
    expect(missingContext.exitConfirmed).toBe(false)
    expect(missingContext.saveFeedback).toBe('idle')
    expect(missingWindow.location.assigned).toEqual([])
    expect(missingWindow.location.replaced).toEqual([])
    expect(missingWrites).toBe(0)
    expect(missingStore.notifications).toHaveLength(3)
    for (const notification of missingStore.notifications) expect(notification.style).toBe('warning')

    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/offlineDraftStatus === `locked` \|\| !offlineDraftCoordinator/)
  })
  test('blocks unavailable resource publication without converting it into identity lock recovery', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        return { sourceRevision: 'unexpected', updatedAt: '' }
      }
    })
    applyEveryEdit(store)
    context.offlineDraftStatus = 'unavailable'

    expect(context.offlineDraftMutationBlocked).toBe(true)
    expect(context.offlineMutationBlocked).toBe(true)
    expect(await context.save()).toBe(false)
    expect(updateCalls).toBe(0)
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]?.style).toBe('warning')
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/offlineDraftStatus === `locked` \|\| !offlineDraftCoordinator/)
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/editor-draft-review-actions\(v-if='offlineDraftRows.length > 0'\)/)
    expect(shellSfc.descriptor.template?.content ?? '').not.toMatch(/editor-draft-recovery-actions\(v-if='offlineDraftStatus === `unavailable`'/)
  })
  test('requests the global identity boundary for a receiptless unauthorized save', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    const boundaryRequests: Array<{ accountId: number; reason: 'unauthorized' }> = []
    let updateCalls = 0
    let context: ShellContext | null = null
    const shell = createShellHarness(store, testWindow, {
      requestOfflineIdentityBoundary: async request => {
        boundaryRequests.push(request)
        context?.handleOfflineSessionInvalidated()
        return true
      },
      updatePage: async () => {
        updateCalls++
        const error = new Error('unauthorized')
        Object.defineProperty(error, 'status', { value: 401 })
        throw error
      }
    })
    context = shell
    const coordinator = shell.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.prepareSubmission = async () => undefined
    applyEveryEdit(store)

    expect(await shell.save()).toBe(false)
    expect(boundaryRequests).toEqual([{ accountId: 42, reason: 'unauthorized' }])
    expect(updateCalls).toBe(1)
    expect(shell.offlineDraftCoordinator).toBeNull()
    expect(store.notifications).toEqual([])
  })

  test('blocks receiptless forbidden saves even when unavailable-draft capture fails', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    let captureOptions: { force?: boolean; state?: string; editVersion?: number } | undefined
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        const error = new Error('forbidden')
        Object.defineProperty(error, 'status', { value: 403 })
        throw error
      }
    })
    const coordinator = context.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.prepareSubmission = async () => undefined
    coordinator.captureNow = async options => {
      captureOptions = options
      return false
    }
    applyEveryEdit(store)

    expect(await context.save()).toBe(false)
    expect(captureOptions?.state).toBe('unavailable')
    expect(context.offlineDraftStatus).toBe('unavailable')
    expect(context.offlineDraftMutationBlocked).toBe(true)
    expect(context.offlineMutationBlocked).toBe(true)
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]?.style).toBe('error')
    expect(String(store.notifications[0]?.message)).toMatch(/local draft.*not.*retain/i)

    expect(await context.save()).toBe(false)
    expect(updateCalls).toBe(1)
  })

  test('requests unavailable capture for a receiptless not-found save and blocks replay', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        const error = new Error('not found')
        Object.defineProperty(error, 'status', { value: 404 })
        throw error
      }
    })
    const coordinator = context.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.prepareSubmission = async () => undefined
    applyEveryEdit(store)

    expect(await context.save()).toBe(false)
    expect(coordinator.captureStates).toEqual(['unavailable'])
    expect(context.offlineDraftStatus).toBe('unavailable')
    expect(context.offlineDraftMutationBlocked).toBe(true)
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]?.style).toBe('error')
    expect(String(store.notifications[0]?.message)).toMatch(/publishing.*unavailable/i)
    expect(await context.save()).toBe(false)
    expect(updateCalls).toBe(1)
  })

  test('does not let a conflict response from the previous account mutate the editor', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let releaseConflict: ((value: boolean) => void) | undefined
    let conflictCalls = 0
    let updateCalls = 0
    const conflict = new Promise<boolean>(resolve => {
      releaseConflict = resolve
    })
    const context = createShellHarness(store, testWindow, {
      checkPageConflict: async () => {
        conflictCalls++
        return conflict
      },
      updatePage: async () => {
        updateCalls++
        return { sourceRevision: 'stale', updatedAt: '' }
      }
    })
    applyEveryEdit(store)

    const savePromise = context.save()
    for (let attempt = 0; attempt < 8 && conflictCalls === 0; attempt++) await Promise.resolve()
    expect(conflictCalls).toBe(1)

    context.accountId = 99
    store.user.id = 99
    store.offlineIdentityEpoch = 1
    context.handleOfflineSessionInvalidated()
    releaseConflict?.(false)

    expect(await savePromise).toBe(false)
    expect(updateCalls).toBe(0)
    expect(store.editor.content).toBe('')
    expect(store.notifications).toEqual([])
  })

  test('does not apply a previous account write response or follow-up mutation', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let releaseUpdate: ((value: { sourceRevision: string; updatedAt: string }) => void) | undefined
    let updateCalls = 0
    let visibilityCalls = 0
    const update = new Promise<{ sourceRevision: string; updatedAt: string }>(resolve => {
      releaseUpdate = resolve
    })
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        return update
      },
      changePageVisibility: async () => {
        visibilityCalls++
        return { sourceRevision: 'stale-visibility' }
      }
    })
    applyEveryEdit(store)

    const savePromise = context.save()
    for (let attempt = 0; attempt < 8 && updateCalls === 0; attempt++) await Promise.resolve()
    expect(updateCalls).toBe(1)

    context.accountId = 99
    store.user.id = 99
    store.offlineIdentityEpoch = 1
    context.handleOfflineSessionInvalidated()
    releaseUpdate?.({ sourceRevision: 'stale', updatedAt: 'stale' })

    expect(await savePromise).toBe(false)
    expect(visibilityCalls).toBe(0)
    expect(store.page.sourceRevision).toBe('')
    expect(store.notifications).toEqual([])
  })
  test('ignores a late detached draft completion after identity invalidation', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let releaseDetached: (() => void) | undefined
    const detached = new Promise<void>(resolve => {
      releaseDetached = resolve
    })
    const context = createShellHarness(store, testWindow)
    const coordinator = context.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.applyDetachedCandidate = async () => {
      await detached
      context.applyOfflineDraft({
        content: 'previous-account detached secret',
        title: 'previous-account title',
        description: 'previous-account description'
      })
      return true
    }

    const restorePromise = context.restoreOfflineDraft()
    expect(context.offlineDraftBusy).toBe(true)
    context.accountId = 99
    store.user.id = 99
    store.offlineIdentityEpoch = 1
    context.handleOfflineSessionInvalidated()
    releaseDetached?.()

    await restorePromise
    expect(store.editor.content).toBe('')
    expect(store.page.title).toBe('')
    expect(store.page.description).toBe('')
    expect(context.offlineDraftCoordinator).toBeNull()
  })
  test('completes an ordinary verified online save when receipt storage is unavailable with a recovery warning', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async () => {
        updateCalls++
        return { sourceRevision: 'revision-online', updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    applyEveryEdit(store)
    const coordinator = context.offlineDraftCoordinator
    if (!coordinator) throw new Error('Expected an offline draft coordinator')
    coordinator.prepareSubmission = async () => {}
    expect(await context.save()).toBe(true)
    expect(updateCalls).toBe(1)
    expect(context.isDirty).toBe(false)
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]).toMatchObject({ style: 'warning', icon: 'warning' })
    expect(String(store.notifications[0]?.message)).not.toContain('Saved on this device')
  })
  test('declares an optional historical bootstrap alert with text interpolation', () => {
    const template = shellSfc.descriptor.template?.content ?? ''
    expect(shellScript).toMatch(/bootstrapNotice:\s*\{\s*type:\s*String/)
    expect(template).toMatch(/v-alert\.editor-bootstrap-notice[\s\S]*v-if='bootstrapNotice'/)
    expect(template).toContain('{{ bootstrapNotice }}')
  })
})

describe('source image properties focus lifecycle', () => {
  const invocation = shellMarkup('v-dialog').filter((_index, element) => shellMarkup(element).attr('aria-labelledby') === 'editor-image-properties-title')
  if (invocation.length !== 1) throw new Error('Image properties dialog invocation is missing or ambiguous')
  const template = compileTemplate({
    source: invocation.toString(),
    filename: shellPath,
    id: 'editor-image-properties-owner-test',
    compilerOptions: { mode: 'function' }
  })
  if (template.errors.length) throw template.errors[0]
  const render = new Function('Vue', template.code)(Vue)
  const imagePath = join(process.cwd(), 'client/components/editor/editor-image-properties.vue')
  const imageSfc = parse(readFileSync(imagePath, 'utf8'), { filename: imagePath }).descriptor
  if (!imageSfc.script || !imageSfc.template) throw new Error('Image properties component is incomplete')
  const imageTemplate = compileTemplate({
    source: imageSfc.template.content,
    filename: imagePath,
    id: 'editor-image-properties-form-test',
    preprocessLang: imageSfc.template.lang,
    compilerOptions: { mode: 'function' }
  })
  if (imageTemplate.errors.length) throw imageTemplate.errors[0]
  const imageAst = ts.createSourceFile(imagePath, imageSfc.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imageScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    imageAst.statements
      .filter(statement => !ts.isImportDeclaration(statement))
      .map(statement => statement.getText(imageAst))
      .join('\n')
      .replace('export default defineComponent', 'return defineComponent')
  )
  const imageOptions = new Function('defineComponent', ...Object.keys(imagePropertiesHelpers), imageScript)(
    Vue.defineComponent,
    ...Object.values(imagePropertiesHelpers)
  )
  const behavior = new Function('markRaw', `${executableShellBehavior}\nreturn shellBehavior`)(Vue.markRaw)
  const settle = async () => {
    for (let pass = 0; pass < 6; pass++) {
      await Promise.resolve()
      await Vue.nextTick()
    }
  }
  const mount = async () => {
    let finishLeave: (() => void) | undefined
    const host = document.body.appendChild(document.createElement('div'))
    const sourceHost = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({
      state: EditorState.create({ doc: '![Owned raster](/owned-raster.png)' }),
      parent: sourceHost
    })
    const app = Vue.createApp({
      data: () => ({
        imagePropertiesRequest: null,
        imagePropertiesGeneration: 0,
        imagePropertiesAbortCleanup: null,
        imagePropertiesReturnFocus: null,
        imagePropertiesOwnerKey: 'owned-source-session'
      }),
      methods: behavior.methods,
      render
    })
    app.use(
      createVuetify({
        components: vuetifyComponents,
        directives: vuetifyDirectives,
        defaults: {
          VDialog: {
            transition: {
              component: Vue.Transition,
              css: false,
              onLeave: (_element: Element, done: () => void) => {
                finishLeave = done
              }
            }
          }
        }
      })
    )
    app.config.globalProperties.$t = translateEnglish
    app.component('EditorImageProperties', { ...imageOptions, render: new Function('Vue', imageTemplate.code)(Vue) })
    const context = app.mount(host) as unknown as {
      imagePropertiesOwnerKey: string
      openImageProperties: (request: imagePropertiesHelpers.EditorImagePropertiesRequest) => void
    }
    modalUnmounts.push(() => {
      app.unmount()
      view.destroy()
      sourceHost.remove()
      host.remove()
    })
    view.focus()
    const abort = new AbortController()
    context.openImageProperties({
      properties: { src: '/owned-raster.png', alt: 'Owned raster', width: '', height: '', align: '', styles: [] },
      signal: abort.signal,
      apply: () => {
        abort.abort()
        return true
      }
    })
    await settle()
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    if (!field) throw new Error('Image dialog did not render')
    field.focus()
    return {
      context,
      view,
      field,
      leave: async () => {
        await settle()
        expect(finishLeave).toBeDefined()
        expect(view.hasFocus).toBe(false)
        finishLeave!()
        await settle()
      }
    }
  }
  for (const action of ['Close image properties', 'Cancel', 'Apply changes']) {
    test(`${action} restores the actual invoking source only after the overlay leaves`, async () => {
      const { view, leave } = await mount()
      if (action === 'Apply changes') {
        const alt = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
        alt.value = 'Updated owned raster'
        alt.dispatchEvent(new Event('input', { bubbles: true }))
        await settle()
      }
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        button => button.getAttribute('aria-label') === action || button.textContent?.trim() === action
      )
      if (!button) throw new Error(`${action} is missing`)
      button.click()
      await leave()
      expect(view.hasFocus).toBe(true)
    })
  }
  test('does not return focus into a replaced source owner', async () => {
    const { context, view, leave } = await mount()
    context.imagePropertiesOwnerKey = 'replacement-source-session'
    document.querySelector<HTMLButtonElement>('button[aria-label="Close image properties"]')!.click()
    await leave()
    expect(view.hasFocus).toBe(false)
  })
  for (const unavailable of ['disconnected', 'inert', 'hidden', 'read-only']) {
    test(`does not focus a source that became ${unavailable} during the dialog`, async () => {
      const { view, leave } = await mount()
      if (unavailable === 'disconnected') view.dom.remove()
      if (unavailable === 'inert') view.dom.setAttribute('inert', '')
      if (unavailable === 'hidden') view.dom.setAttribute('aria-hidden', 'true')
      if (unavailable === 'read-only') view.contentDOM.setAttribute('contenteditable', 'false')
      document.querySelector<HTMLButtonElement>('button[aria-label="Close image properties"]')!.click()
      await leave()
      expect(view.hasFocus).toBe(false)
    })
  }
})

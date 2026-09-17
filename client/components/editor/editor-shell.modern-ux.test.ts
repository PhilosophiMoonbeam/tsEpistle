import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import _ from 'lodash'
import * as ts from 'typescript'
import { describe, expect, test } from '../../../server/test/bun-test.mts'
import { PageBrandingAssignmentSchema, type PageBrandingAssignment, type PageBrandingView } from '../../../shared/page-branding.ts'

const shellPath = join(process.cwd(), 'client/components/editor.vue')

const shellSource = readFileSync(shellPath, 'utf8')

const shellSfc = parse(shellSource, { filename: shellPath })

const shellScript = shellSfc.descriptor.script?.content ?? ''
const markdownPath = join(process.cwd(), 'client/components/editor/editor-markdown.vue')
const shellStyle = shellSfc.descriptor.styles.map(style => style.content).join('\n')
const markdownSource = readFileSync(markdownPath, 'utf8')
const markdownSfc = parse(markdownSource, { filename: markdownPath })
const markdownTemplate = markdownSfc.descriptor.template?.content ?? ''
const markdownStyle = markdownSfc.descriptor.styles.map(style => style.content).join('\n')

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
  okfMetadata?: Record<string, unknown>
  branding?: PageBrandingAssignment | null
}

type ShellContext = {
  [key: string]: unknown
  savedState: SavedState
  navigationTimer: number | null
  dialogUnsaved: boolean
  dialogProgress: boolean
  exitConfirmed: boolean
  lifecycleGeneration: number
  editorInstanceKey: number
  offlineConnectionState: string
  isSaving: boolean
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
  saveUnsavedAndClose: () => Promise<void>
  showProgressDialog: () => void
}
type ShellBehavior = {
  computed: {
    isDirty: (this: ShellContext) => boolean
    mode: (this: ShellContext) => string
    offlineDraftMutationBlocked: (this: ShellContext) => boolean
    offlineMutationBlocked: (this: ShellContext) => boolean
    offlineDraftStatusText: (this: ShellContext) => string
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
  createPage: (fetcher: typeof fetch, input: PageInput) => Promise<{ id: number; updatedAt: string }>
  discardCollaborationDraft: (fetcher: typeof fetch, pageId: number, expectedUpdatedAt: string, expectedSourceRevision: string) => Promise<void>
  fetchPage: (fetcher: typeof fetch, id: number, errorMessage: string) => Promise<{ okf: OkfState; sourceRevision: string; isSearchable?: boolean }>
  updatePage: (
    fetcher: typeof fetch,
    id: number,
    input: PageInput,
    sourceRevision: string,
    expectedCollaborationGeneration?: number
  ) => Promise<{ sourceRevision: string; updatedAt: string }>
  notifyReloadSafetyChanged: () => void
  requestOfflineIdentityBoundary: (request: { accountId: number; reason: 'unauthorized' }) => Promise<boolean>
}

type TestWindow = {
  location: {
    assigned: string[]
    replaced: string[]
    assign: (url: string) => void
    replace: (url: string) => void
  }
  clearedTimers: number[]
  scheduledTimers: Array<{ id: number; delay: number | undefined }>
  clearTimeout: (id: number) => void
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
      this.clearedTimers.push(id)
    },
    setTimeout(_handler, delay) {
      const id = nextTimer++
      this.scheduledTimers.push({ id, delay })
      return id
    },
    fetch: (() => Promise.resolve(new Response())) as unknown as typeof fetch
  }
}

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
  createPage: async () => ({ id: 91, updatedAt: '2026-09-03T12:00:00.000Z' }),
  discardCollaborationDraft: async () => undefined,
  requestOfflineIdentityBoundary: async () => true,
  fetchPage: async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: 'revision-4', isSearchable: store.page.isSearchable }),
  updatePage: async () => ({ sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' }),
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
    dependencies.buildOkfMetadataPayload,
    dependencies.freezePageInput,
    dependencies.changePageVisibility,
    dependencies.checkPageConflict,
    dependencies.createPage,
    dependencies.discardCollaborationDraft,
    dependencies.fetchPage,
    dependencies.updatePage,
    dependencies.notifyReloadSafetyChanged,
    dependencies.requestOfflineIdentityBoundary,
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
    () => undefined,
    () => undefined,
    (css: string) => css
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
  const context = {
    savedState: {} as SavedState,
    navigationTimer: null,
    dialogUnsaved: false,
    dialogProgress: false,
    exitConfirmed: false,
    lifecycleGeneration: 0,
    editorInstanceKey: 0,
    isSaving: false,
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
    $t: (key: string) => key
  } as unknown as ShellContext

  const syncAdapterSafety = () => {
    context.editorAdapterSafety = adapter.snapshot()
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
    },
    flushEligibleText: () => undefined,
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

  const showProgressDialog = context.showProgressDialog
  const hideProgressDialog = context.hideProgressDialog
  context.showProgressDialog = () => {
    context.progressShown++
    showProgressDialog()
  }
  context.hideProgressDialog = () => {
    context.progressHidden++
    hideProgressDialog()
  }
  context.setCurrentSavedState()
  return context
}

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
  test('keeps the active editor in the bounded shell surface after notices', () => {
    const template = shellSfc.descriptor.template?.content ?? ''
    const surfaceStart = template.indexOf('.editor-main-surface')
    const activeEditorStart = template.indexOf('component.editor-active-editor')

    expect(shellSfc.errors).toEqual([])
    expect(surfaceStart).toBeGreaterThanOrEqual(0)
    expect(activeEditorStart).toBeGreaterThan(surfaceStart)
    expect(template.slice(surfaceStart, activeEditorStart)).toContain('Keep as new draft')
    expect(shellStyle).toMatch(/\.editor-active-editor\s*\{[\s\S]*display:\s*flex;[\s\S]*flex:\s*1 1 auto;[\s\S]*min-width:\s*0;[\s\S]*min-height:\s*0;/)
  })

  test('keeps Markdown panes bounded, locally scrollable, and reader-themed', () => {
    expect(markdownSfc.errors).toEqual([])
    expect(markdownTemplate).toContain('editor-markdown-preview-content.editor-page-canvas.contents')
    expect(markdownTemplate).toContain('editor-markdown-sysbar-position')
    expect(markdownStyle).not.toContain('50vw')
    expect(markdownStyle).toMatch(
      /&-editor\s*\{[\s\S]*background:\s*rgb\(var\(--v-theme-background\)\);[\s\S]*flex:\s*1 1 0;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;/
    )
    expect(markdownStyle).toMatch(/&-preview\s*\{[\s\S]*background:\s*rgb\(var\(--v-theme-background\)\);[\s\S]*flex:\s*1 1 0;[\s\S]*min-width:\s*0;/)
    expect(markdownStyle).toContain('background: rgb(var(--v-theme-background)) !important;')
    expect(markdownStyle).toMatch(/&-preview-enter-active,[\s\S]*max-width:\s*50%;[\s\S]*width:\s*100%;/)
    expect(markdownStyle).toMatch(
      /&-sysbar\s*\{[\s\S]*position:\s*static !important;[\s\S]*background:\s*var\(--wiki-surface-raised\) !important;[\s\S]*border-top:\s*1px solid var\(--wiki-surface-border\);/
    )
    expect(markdownStyle).toMatch(/&-path\s*\{[\s\S]*flex:\s*0 1 auto;[\s\S]*text-overflow:\s*ellipsis;/)
    expect(markdownStyle).toMatch(
      /&-position\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*padding-inline-end:\s*calc\(var\(--wiki-space-3\) \+ env\(safe-area-inset-right\)\);/
    )
    expect(markdownStyle).toMatch(/&-toolbar\s*\{[\s\S]*background:\s*var\(--wiki-surface-raised\) !important;/)
    expect(markdownStyle).toMatch(/&-sidebar\s*\{[\s\S]*background:\s*var\(--wiki-surface-sunken\);/)
  })

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
    expect(store.notifications).toEqual([
      {
        message: 'This collaboration draft was discarded. Reload the page before saving.',
        style: 'error',
        icon: 'warning'
      },
      {
        message: 'This collaboration draft was discarded. Reload the page before saving.',
        style: 'error',
        icon: 'warning'
      }
    ])
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

  test('keeps the unsaved dialog open with the real discard failure', async () => {
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
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/editor-modal-unsaved\([\s\S]*:error='discardError'/)
  })

  test('successful update Save and close persists edits and cancels the stale edit redirect', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateInput: PageInput | undefined
    let updateInputFrozen = false
    let updateFence: { sourceRevision: string; generation: number | undefined } | undefined
    let visibilityCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async (_fetcher, _id, input, sourceRevision, generation) => {
        updateInputFrozen =
          Object.isFrozen(input) &&
          Object.isFrozen(input.tags) &&
          (input.okfMetadata === undefined || Object.isFrozen(input.okfMetadata)) &&
          (input.branding === undefined || input.branding === null || Object.isFrozen(input.branding))
        updateInput = _.cloneDeep(input)
        updateFence = { sourceRevision, generation }
        return { sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' }
      },
      changePageVisibility: async () => {
        visibilityCalls++
        return { sourceRevision: 'revision-3' }
      },
      fetchPage: async () => ({
        okf: _.cloneDeep(store.page.okf),
        sourceRevision: 'revision-4',
        isSearchable: store.page.isSearchable
      })
    })
    applyEveryEdit(store)
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(updateInput).toMatchObject({
      content: 'discarded content',
      description: 'discarded description',
      locale: 'fr',
      visibility: 'private',
      path: 'discarded-path',
      title: 'Discarded title'
    })
    expect(updateFence).toEqual({ sourceRevision: '1', generation: 1 })
    expect(updateInputFrozen).toBe(true)
    expect(visibilityCalls).toBe(1)
    expect(context.savedState).toEqual(mutableSnapshot(store))
    expect(context.isDirty).toBe(false)
    expect(context.dialogUnsaved).toBe(false)
    expect(context.progressShown).toBe(1)
    expect(context.progressHidden).toBe(1)
    expect(store.notifications).toEqual([
      {
        message: 'editor:save.updateSuccess',
        style: 'success',
        icon: 'check'
      }
    ])
    expect(store.loadingOwners).toEqual([])
    expect(testWindow.scheduledTimers).toEqual([{ id: 100, delay: 1000 }])
    expect(testWindow.clearedTimers).toEqual([100])
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
    expect(context.progressShown).toBe(1)
    expect(context.progressHidden).toBe(1)
    expect(store.notifications).toEqual([
      {
        message: 'save rejected',
        style: 'error',
        icon: 'warning'
      }
    ])
    expect(store.loadingOwners).toEqual([])
    expect(testWindow.location.assigned).toEqual([])
    expect(testWindow.location.replaced).toEqual([])
    expect(testWindow.scheduledTimers).toEqual([])
  })

  test('successful create Save and close keeps saved values and navigates once', async () => {
    const store = createStore('create')
    const testWindow = createTestWindow()
    let createdInput: PageInput | undefined
    let createdInputFrozen = false
    const context = createShellHarness(store, testWindow, {
      createPage: async (_fetcher, input) => {
        createdInputFrozen =
          Object.isFrozen(input) &&
          Object.isFrozen(input.tags) &&
          (input.okfMetadata === undefined || Object.isFrozen(input.okfMetadata)) &&
          (input.branding === undefined || input.branding === null || Object.isFrozen(input.branding))
        createdInput = _.cloneDeep(input)
        return { id: 91, updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    applyEveryEdit(store)
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(createdInput?.content).toBe('discarded content')
    expect(createdInputFrozen).toBe(true)
    expect(store.editor.id).toBe(91)
    expect(store.editor.mode).toBe('update')
    expect(context.savedState).toEqual(mutableSnapshot(store))
    expect(context.dialogUnsaved).toBe(false)
    expect(context.progressShown).toBe(1)
    expect(context.progressHidden).toBe(1)
    expect(testWindow.location.assigned).toEqual(['/_private/fr/discarded-path'])
    expect(testWindow.scheduledTimers).toEqual([])
    expect(store.loadingOwners).toEqual([])
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
  test('blocks every save entry point while local draft recovery is locked or unavailable', async () => {
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
    expect(lockedContext.offlineDraftStatusText).toBe(
      'Local draft recovery is locked. Verify this account online, then reload the editor to recover encrypted drafts.'
    )
    expect(lockedContext.offlineDraftMutationBlocked).toBe(true)
    expect(lockedContext.offlineMutationBlocked).toBe(true)
    expect(await lockedContext.save()).toBe(false)
    expect(lockedWrites).toBe(0)
    expect(lockedContext.progressShown).toBe(0)
    expect(lockedContext.progressHidden).toBe(0)
    expect(lockedStore.notifications).toEqual([
      {
        message: 'Offline draft recovery is locked. Verify this account online, then reload the editor before saving.',
        style: 'warning',
        icon: 'warning'
      }
    ])

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
    expect(missingContext.offlineDraftStatusText).toBe('Offline draft recovery is unavailable. Reload the editor before saving.')
    expect(await missingContext.save()).toBe(false)
    expect(missingWrites).toBe(0)
    expect(missingStore.notifications).toEqual([
      {
        message: 'Offline draft recovery is unavailable. Reload the editor before saving.',
        style: 'warning',
        icon: 'warning'
      }
    ])

    expect(shellScript).toMatch(/setSaveHotkeyHandler\(\(\) => \{[\s\S]*offlineDraftMutationBlocked[\s\S]*notifyOfflineMutationBlocked/)
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

    expect(context.offlineDraftStatusText).toBe(
      'The page may have been deleted or access may have been denied. Publishing and replay are blocked; local recovery and deletion remain available.'
    )
    expect(context.offlineDraftMutationBlocked).toBe(true)
    expect(context.offlineMutationBlocked).toBe(true)
    expect(await context.save()).toBe(false)
    expect(updateCalls).toBe(0)
    expect(store.notifications).toEqual([
      {
        message:
          'Publishing is unavailable because the page may have been deleted or access may have been denied. Local recovery and deletion remain available.',
        style: 'warning',
        icon: 'warning'
      }
    ])
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/offlineDraftStatus === `locked` \|\| !offlineDraftCoordinator/)
    expect(shellSfc.descriptor.template?.content ?? '').toMatch(/editor-draft-review-actions\(v-if='offlineDraftCandidate'\)/)
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
    expect(store.notifications).toEqual([
      {
        message: 'Publishing is unavailable because the page may have been deleted or access may have been denied, but the local draft could not be retained.',
        style: 'error',
        icon: 'warning'
      }
    ])

    expect(await context.save()).toBe(false)
    expect(updateCalls).toBe(1)
    expect(shellScript).toMatch(/if \(this\.offlineDraftMutationBlocked\)/)
  })

  test('persists a receiptless not-found save as unavailable without replay', async () => {
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
    expect(store.notifications).toEqual([
      {
        message:
          'Publishing is unavailable because the page may have been deleted or access may have been denied. Local recovery and deletion remain available.',
        style: 'error',
        icon: 'warning'
      }
    ])
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
    expect(String(store.notifications[0]?.message)).toContain('Local recovery receipt could not be committed')
    expect(String(store.notifications[0]?.message)).not.toContain('Saved on this device')
  })
  test('renders an optional historical bootstrap warning as an escaped persistent alert', () => {
    const template = shellSfc.descriptor.template?.content ?? ''
    expect(shellScript).toMatch(/bootstrapNotice:\s*\{\s*type:\s*String/)
    expect(template).toMatch(/v-alert\.editor-bootstrap-notice[\s\S]*v-if='bootstrapNotice'/)
    expect(template).toContain('{{ bootstrapNotice }}')
    expect(template).not.toContain('v-html')
  })
})

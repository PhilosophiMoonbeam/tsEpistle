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
    description: string
    isPublished: boolean
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
  showNotification: (notification: Record<string, unknown>) => void
  startLoading: (owner: string) => void
}

type SavedState = {
  content: string
  description: string
  isPublished: boolean
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
  path: string
  publishEndDate: string
  publishStartDate: string
  scriptCss: string
  scriptJs: string
  tags: string[]
  title: string
  okfMetadata?: Record<string, unknown>
}

type ShellContext = {
  [key: string]: unknown
  savedState: SavedState
  navigationTimer: number | null
  dialogUnsaved: boolean
  dialogProgress: boolean
  exitConfirmed: boolean
  isSaving: boolean
  collaborationActive: boolean
  collaborationGeneration: number | null
  collaborationDiscarded: boolean
  isConflict: boolean
  pageId: number
  checkoutDateActive: string
  currentEditor: string
  isDirty: boolean
  mode: string
  progressShown: number
  progressHidden: number
  $t: (key: string) => string
  setCurrentSavedState: () => void
  restoreCurrentSavedState: () => void
  discardAndExit: () => Promise<void>
  exitGo: () => void
  handleCollaborationState: (state: { active: boolean, discarded: boolean, generation: number | null }) => void
  exit: () => Promise<void>
  handleBeforeUnload: (event: BeforeUnloadEvent) => void
  save: (options?: { rethrow?: boolean, overwrite?: boolean }) => Promise<void>
  saveAndClose: () => Promise<boolean>
  saveUnsavedAndClose: () => Promise<void>
  showProgressDialog: () => void
  hideProgressDialog: () => void
}

type ShellBehavior = {
  computed: {
    isDirty: (this: ShellContext) => boolean
    mode: (this: ShellContext) => string
  }
  methods: Record<string, (this: ShellContext, ...args: never[]) => unknown>
}

type ApiDependencies = {
  buildOkfMetadataPayload: (metadata: Record<string, unknown> | null) => Record<string, unknown> | undefined
  changePageVisibility: (
    fetcher: typeof fetch,
    id: number,
    visibility: 'public' | 'private',
    sourceRevision: string,
    isPublic: boolean
  ) => Promise<{ sourceRevision: string }>
  checkPageConflict: (fetcher: typeof fetch, id: number, checkoutDate: string) => Promise<boolean>
  createPage: (fetcher: typeof fetch, input: PageInput) => Promise<{ id: number, updatedAt: string }>
  discardCollaborationDraft: (fetcher: typeof fetch, pageId: number, expectedUpdatedAt: string, expectedSourceRevision: string) => Promise<void>
  fetchPage: (fetcher: typeof fetch, id: number, errorMessage: string) => Promise<{ okf: OkfState, sourceRevision: string }>
  updatePage: (
    fetcher: typeof fetch,
    id: number,
    input: PageInput,
    sourceRevision: string,
    expectedCollaborationGeneration?: number
  ) => Promise<{ sourceRevision: string, updatedAt: string }>
}

type TestWindow = {
  location: {
    assigned: string[]
    replaced: string[]
    assign: (url: string) => void
    replace: (url: string) => void
  }
  clearedTimers: number[]
  scheduledTimers: Array<{ id: number, delay: number | undefined }>
  clearTimeout: (id: number) => void
  setTimeout: (handler: () => void, delay?: number) => number
  fetch: typeof fetch
}

const shellAst = ts.createSourceFile(shellPath, shellScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const shellDefaultExport = shellAst.statements.find(ts.isExportAssignment)
if (
  !shellDefaultExport ||
  !ts.isCallExpression(shellDefaultExport.expression) ||
  !ts.isObjectLiteralExpression(shellDefaultExport.expression.arguments[0])
) {
  throw new Error('Unable to find the editor Options API component definition')
}
const shellOptions = shellDefaultExport.expression.arguments[0]

const extractShellObjectOption = (name: string): string => {
  const property = shellOptions.properties.find(candidate =>
    ts.isPropertyAssignment(candidate) &&
    ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
      (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
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
    notifications: [],
    loadingOwners: [],
    showNotification (notification) {
      this.notifications.push(notification)
    },
    startLoading (owner) {
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
    assign (url: string) {
      this.assigned.push(url)
    },
    replace (url: string) {
      this.replaced.push(url)
    }
  }
  return {
    location,
    clearedTimers: [],
    scheduledTimers: [],
    clearTimeout (id) {
      this.clearedTimers.push(id)
    },
    setTimeout (_handler, delay) {
      const id = nextTimer++
      this.scheduledTimers.push({ id, delay })
      return id
    },
    fetch: (() => Promise.resolve(new Response())) as unknown as typeof fetch
  }
}

const defaultDependencies = (store: EditorStore): ApiDependencies => ({
  buildOkfMetadataPayload: metadata => metadata ?? undefined,
  changePageVisibility: async () => ({ sourceRevision: 'revision-3' }),
  checkPageConflict: async () => false,
  createPage: async () => ({ id: 91, updatedAt: '2026-09-03T12:00:00.000Z' }),
  discardCollaborationDraft: async () => undefined,
  fetchPage: async () => ({ okf: _.cloneDeep(store.page.okf), sourceRevision: 'revision-4' }),
  updatePage: async () => ({ sourceRevision: 'revision-2', updatedAt: '2026-09-03T12:00:00.000Z' })
})

const loadShellBehavior = (
  store: EditorStore,
  testWindow: TestWindow,
  overrides: Partial<ApiDependencies> = {}
): ShellBehavior => {
  const dependencies = { ...defaultDependencies(store), ...overrides }
  const evaluate = new Function(
    '_',
    'PageBrandingAssignmentSchema',
    'wikiStore',
    'window',
    'buildOkfMetadataPayload',
    'changePageVisibility',
    'checkPageConflict',
    'createPage',
    'discardCollaborationDraft',
    'fetchPage',
    'updatePage',
    'emitEditorSaveConflict',
    'getErrorMessage',
    'removeEditorPageCss',
    'scopeEditorPageCss',
    `${executableShellBehavior}\nreturn shellBehavior`
  ) as (...args: unknown[]) => ShellBehavior
  return evaluate(
    _,
    PageBrandingAssignmentSchema,
    store,
    testWindow,
    dependencies.buildOkfMetadataPayload,
    dependencies.changePageVisibility,
    dependencies.checkPageConflict,
    dependencies.createPage,
    dependencies.discardCollaborationDraft,
    dependencies.fetchPage,
    dependencies.updatePage,
    () => undefined,
    (error: unknown) => error instanceof Error ? error.message : String(error),
    () => undefined,
    (css: string) => css
  )
}

const createShellHarness = (
  store: EditorStore,
  testWindow: TestWindow,
  overrides: Partial<ApiDependencies> = {}
): ShellContext => {
  const behavior = loadShellBehavior(store, testWindow, overrides)
  const context = {
    savedState: {} as SavedState,
    navigationTimer: null,
    dialogUnsaved: false,
    dialogProgress: false,
    exitConfirmed: false,
    isSaving: false,
    discardPending: false,
    collaborationActive: store.editor.mode === 'update' && store.editor.editorKey === 'markdown',
    collaborationGeneration: store.editor.mode === 'update' && store.editor.editorKey === 'markdown' ? 1 : null,
    collaborationDiscarded: false,
    isConflict: false,
    pageId: store.page.id,
    checkoutDateActive: '2026-09-03T11:00:00.000Z',
    currentEditor: store.editor.editor,
    progressShown: 0,
    progressHidden: 0,
    $t: (key: string) => key
  } as unknown as ShellContext

  for (const [name, method] of Object.entries(behavior.methods)) {
    context[name] = method.bind(context)
  }
  Object.defineProperty(context, 'isDirty', {
    get: () => behavior.computed.isDirty.call(context)
  })
  Object.defineProperty(context, 'mode', {
    get: () => behavior.computed.mode.call(context)
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

  test('resets the durable Markdown draft before restoring a public page and exiting', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let persistenceCalls = 0
    const discardedDrafts: Array<{ pageId: number, expectedUpdatedAt: string, expectedSourceRevision: string }> = []
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
    expect(discardedDrafts).toEqual([{
      pageId: 12,
      expectedUpdatedAt: '2026-09-03T11:00:00.000Z',
      expectedSourceRevision: '1'
    }])
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
    expect(store.notifications).toEqual([{
      message: 'Another user is actively editing this page.',
      style: 'error',
      icon: 'warning'
    }])
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

  test('successful update Save and close persists edits and cancels the stale edit redirect', async () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let updateInput: PageInput | undefined
    let updateFence: { sourceRevision: string, generation: number | undefined } | undefined
    let visibilityCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async (_fetcher, _id, input, sourceRevision, generation) => {
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
        sourceRevision: 'revision-4'
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
    expect(visibilityCalls).toBe(1)
    expect(context.savedState).toEqual(mutableSnapshot(store))
    expect(context.isDirty).toBe(false)
    expect(context.dialogUnsaved).toBe(false)
    expect(context.progressShown).toBe(1)
    expect(context.progressHidden).toBe(1)
    expect(store.notifications).toEqual([{
      message: 'editor:save.updateSuccess',
      style: 'success',
      icon: 'check'
    }])
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
    expect(store.notifications).toEqual([{
      message: 'save rejected',
      style: 'error',
      icon: 'warning'
    }])
    expect(store.loadingOwners).toEqual([])
    expect(testWindow.location.assigned).toEqual([])
    expect(testWindow.location.replaced).toEqual([])
    expect(testWindow.scheduledTimers).toEqual([])
  })

  test('successful create Save and close keeps saved values and navigates once', async () => {
    const store = createStore('create')
    const testWindow = createTestWindow()
    let createdInput: PageInput | undefined
    const context = createShellHarness(store, testWindow, {
      createPage: async (_fetcher, input) => {
        createdInput = _.cloneDeep(input)
        return { id: 91, updatedAt: '2026-09-03T12:00:00.000Z' }
      }
    })
    applyEveryEdit(store)
    context.dialogUnsaved = true

    await context.saveUnsavedAndClose()

    expect(createdInput?.content).toBe('discarded content')
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
})

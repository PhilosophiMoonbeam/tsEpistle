import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import _ from 'lodash'
import * as ts from 'typescript'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const shellPath = join(process.cwd(), 'client/components/editor.vue')
const propertiesPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const unsavedPath = join(process.cwd(), 'client/components/editor/editor-modal-unsaved.vue')

const shellSource = readFileSync(shellPath, 'utf8')
const propertiesSource = readFileSync(propertiesPath, 'utf8')
const unsavedSource = readFileSync(unsavedPath, 'utf8')

const shellSfc = parse(shellSource, { filename: shellPath })
const propertiesSfc = parse(propertiesSource, { filename: propertiesPath })
const unsavedSfc = parse(unsavedSource, { filename: unsavedPath })

const shellTemplate = shellSfc.descriptor.template?.content ?? ''
const shellScript = shellSfc.descriptor.script?.content ?? ''
const propertiesTemplate = propertiesSfc.descriptor.template?.content ?? ''
const propertiesScript = propertiesSfc.descriptor.script?.content ?? ''
const unsavedTemplate = unsavedSfc.descriptor.template?.content ?? ''
const unsavedScript = unsavedSfc.descriptor.script?.content ?? ''
const shellRegistrations = shellScript.match(/components:\s*\{([\s\S]*?)\n\s*\},\n\s*props:/)?.[1] ?? ''
const desktopSaveClose = shellTemplate.match(/v-btn\.editor-save-close-action[\s\S]*?\n\s{8}\)/)?.[0] ?? ''
const propertiesComputed = propertiesScript.match(/computed:\s*\{([\s\S]*?)\n\s*\},\n\s*watch:/)?.[1] ?? ''

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
  discardAndExit: () => void
  exitGo: () => void
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
  fetchPage: (fetcher: typeof fetch, id: number, errorMessage: string) => Promise<{ okf: OkfState, sourceRevision: string }>
  updatePage: (
    fetcher: typeof fetch,
    id: number,
    input: PageInput,
    sourceRevision: string
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
      sourceRevision: 'revision-1',
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
    'wikiStore',
    'window',
    'buildOkfMetadataPayload',
    'changePageVisibility',
    'checkPageConflict',
    'createPage',
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
    store,
    testWindow,
    dependencies.buildOkfMetadataPayload,
    dependencies.changePageVisibility,
    dependencies.checkPageConflict,
    dependencies.createPage,
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
    isConflict: false,
    pageId: store.page.id,
    checkoutDateActive: '2026-09-03T11:00:00.000Z',
    currentEditor: store.editor.editor,
    progressShown: 0,
    progressHidden: 0,
    $t: (key: string) => key
  } as ShellContext

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
  test('owns cmd+s and prevents the browser save action before invoking editor save', () => {
    expect(shellSfc.errors).toEqual([])
    expect(shellScript).toMatch(/import \{ useHotkey \} from 'vuetify'/)
    expect(shellScript).toMatch(/useHotkey\('cmd\+s', event => \{\s*event\.preventDefault\(\)\s*saveHandler\?\.\(\)\s*\}\)/)
    expect(shellScript).toMatch(/created\(\) \{\s*this\.setSaveHotkeyHandler\(\(\) => \{\s*void this\.save\(\)/)
    expect(shellScript).toMatch(/beforeUnmount\(\) \{\s*this\.setSaveHotkeyHandler\(null\)/)
  })

  test('keeps Save and close visibly reachable on desktop and mobile regardless of dirty state', () => {
    expect(desktopSaveClose).toContain("v-if='$vuetify.display.mdAndUp'")
    expect(desktopSaveClose).toContain("aria-label='Save and close'")
    expect(desktopSaveClose).toContain("@click='saveAndClose'")
    expect(desktopSaveClose).not.toMatch(/isDirty|mode ===/)
    expect(shellTemplate).toMatch(/v-btn\.editor-save-close-action[\s\S]*?span Save and close/)
    expect(shellTemplate).toMatch(/v-list-item\(@click='saveAndClose'\)[\s\S]*?v-list-item-title Save and close/)
  })

  test('mounts recoverable heavyweight editor dialogs only while their owning state is active', () => {
    expect(shellTemplate).toContain("editor-modal-properties(v-if='dialogProps', v-model='dialogProps')")
    expect(shellTemplate).toContain("editor-modal-editorselect(v-if='dialogEditorSelector', v-model='dialogEditorSelector')")
    expect(shellTemplate).toMatch(/editor-modal-unsaved\(\s*v-if='dialogUnsaved'[\s\S]*?v-model='dialogUnsaved'/)
    expect(shellTemplate).toContain("component(v-if='activeModal', :is='activeModal')")

    expect(shellScript).toContain("import { createAsyncComponent } from './common/async-component-state.vue'")
    for (const component of ['editorModalProperties', 'editorModalEditorselect', 'editorModalUnsaved']) {
      expect(shellRegistrations).toMatch(new RegExp(`${component}: createAsyncComponent\\(\\(\\) => import\\(`))
    }
    expect(shellRegistrations).not.toContain('defineAsyncComponent')
  })

  test('keeps page-property edits reversible until the user explicitly accepts the draft', () => {
    expect(propertiesSfc.errors).toEqual([])
    expect(propertiesTemplate).toMatch(/v-btn\.mx-0\.mr-2\([\s\S]*?@click='cancel'[\s\S]*?common:actions\.cancel/)
    expect(propertiesScript).toMatch(
      /function createPropertiesDraft \(\): PagePropertiesDraft \{\s*return \{[\s\S]*title: wikiStore\.page\.title[\s\S]*tags: \[\.\.\.wikiStore\.page\.tags\]/
    )

    for (const field of ['title', 'description', 'locale', 'tags', 'path', 'isPublished', 'publishStartDate', 'publishEndDate', 'scriptJs', 'scriptCss']) {
      expect(propertiesComputed).toMatch(new RegExp(`${field}:\\s*\\{\\s*get\\(\\) \\{\\s*return this\\.draft\\.${field}\\s*\\}[\\s\\S]*?set\\(value:`))
    }
    expect(propertiesComputed).toMatch(/privatePage:[\s\S]*this\.draft\.visibility === 'private'[\s\S]*this\.draft\.visibility = value \? 'private' : 'public'/)

    expect(propertiesScript).toMatch(
      /handler \(newValue: boolean\) \{[\s\S]*if \(newValue\) \{\s*this\.beginEditing\(\)[\s\S]*\} else \{\s*this\.rollbackDraft\(\)/
    )
    expect(propertiesScript).toMatch(/cancel \(\) \{\s*this\.rollbackDraft\(\)\s*this\.isShown = false\s*\}/)
    expect(propertiesScript).toMatch(/async close\(\) \{[\s\S]*if \(!result\?\.valid\)[\s\S]*this\.commitDraft\(\)\s*this\.isShown = false/)
    expect(propertiesScript).toMatch(
      /commitDraft \(\) \{[\s\S]*wikiStore\.page\.title = this\.draft\.title[\s\S]*wikiStore\.page\.tags = \[\.\.\.this\.draft\.tags\]/
    )
  })

  test('offers Save and close from the unsaved dialog and closes only after save succeeds', () => {
    expect(unsavedSfc.errors).toEqual([])
    expect(shellTemplate).toMatch(/editor-modal-unsaved\([\s\S]*?:busy='isSaving'[\s\S]*?@discard='discardAndExit'[\s\S]*?@save='saveUnsavedAndClose'/)
    expect(unsavedTemplate).toMatch(/v-btn\.px-4\([\s\S]*?:loading='busy'[\s\S]*?@click='save'[\s\S]*?\) Save and close/)
    expect(unsavedScript).toMatch(/emits: \['discard', 'save', 'update:modelValue'\]/)
    expect(unsavedScript).toMatch(/discard\(\) \{\s*this\.isShown = false\s*this\.\$emit\('discard'\)\s*\}/)
    expect(unsavedScript).not.toMatch(/\$emit\('discard',/)
    expect(unsavedScript).toMatch(/save\(\) \{\s*this\.\$emit\('save'\)\s*\}/)
    expect(shellScript).toMatch(/async saveUnsavedAndClose\(\) \{\s*if \(await this\.saveAndClose\(\)\) \{\s*this\.dialogUnsaved = false/)
  })

  test('does not register removed API or redirect editors that could resurrect dead editor paths', () => {
    expect(shellRegistrations).not.toMatch(/\beditor(?:Api|Redirect)\s*:/i)
    expect(shellRegistrations).not.toMatch(/editor-(?:api|redirect)\.vue/i)
    expect(shellScript).toMatch(/normalizeAvailableEditors\(siteConfig\.availableEditors\)/)
    expect(shellScript).toMatch(/this\.currentEditor = getEditorComponentName\(availableEditors\[0\]\)/)
  })

  test('uses one complete saved snapshot captured only after decoded content is assigned', () => {
    expect(shellScript).not.toContain('initContentParsed')
    const contentAssignment = shellScript.indexOf("wikiStore.editor.content = this.initContent ? Base64.decode(this.initContent) : ''")
    const initialSnapshot = shellScript.indexOf('this.setCurrentSavedState()', contentAssignment)
    const mountedEditorSelection = shellScript.indexOf("if (this.mode === 'create' && !this.initEditor)", contentAssignment)
    expect(contentAssignment).toBeGreaterThan(-1)
    expect(initialSnapshot).toBeGreaterThan(contentAssignment)
    expect(initialSnapshot).toBeLessThan(mountedEditorSelection)
    for (const field of [
      'content',
      'description',
      'isPublished',
      'visibility',
      'locale',
      'path',
      'publishEndDate',
      'publishStartDate',
      'title',
      'scriptCss',
      'scriptJs'
    ]) {
      expect(shellScript).toMatch(new RegExp(`${field}: wikiStore\\.(?:editor|page)\\.`))
    }
    expect(shellScript).toContain('tags: [...wikiStore.page.tags]')
    expect(shellScript).toContain('okf: _.cloneDeep(wikiStore.page.okf)')
    expect(shellScript).toMatch(/wikiStore\.page\.okf = page\.okf[\s\S]*?this\.setCurrentSavedState\(\)/)
    expect(shellScript).toMatch(/await this\.refreshOkfAfterSave\(\)[\s\S]*?this\.setCurrentSavedState\(\)/)
  })

  test('restores every public-page field before an immediate discard exit without save UI or aliases', () => {
    const store = createStore()
    const testWindow = createTestWindow()
    let persistenceCalls = 0
    const context = createShellHarness(store, testWindow, {
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

    context.discardAndExit()

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
    expect(store.page.tags).not.toBe(context.savedState.tags)
    expect(store.page.okf).not.toBe(context.savedState.okf)
    store.page.tags.push('new live tag')
    store.page.okf.authority.metadata = { type: 'LiveOnly' }
    expect(context.savedState.tags).toEqual(['persisted-tag'])
    expect(context.savedState.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable' })
  })

  test('restores private and create baselines to their canonical destinations', () => {
    const privateStore = createStore()
    privateStore.page.visibility = 'private'
    privateStore.page.locale = 'de'
    privateStore.page.path = 'private-page'
    const privateWindow = createTestWindow()
    const privateContext = createShellHarness(privateStore, privateWindow)
    const expectedPrivate = _.cloneDeep(privateContext.savedState)
    applyEveryEdit(privateStore)
    privateStore.page.visibility = 'public'

    privateContext.discardAndExit()

    expect(mutableSnapshot(privateStore)).toEqual(expectedPrivate)
    expect(privateWindow.location.assigned).toEqual(['/_private/de/private-page'])

    const createStoreState = createStore('create')
    const createWindow = createTestWindow()
    const createContext = createShellHarness(createStoreState, createWindow)
    const expectedCreate = _.cloneDeep(createContext.savedState)
    applyEveryEdit(createStoreState)

    createContext.discardAndExit()

    expect(mutableSnapshot(createStoreState)).toEqual(expectedCreate)
    expect(createWindow.location.assigned).toEqual(['/'])
    expect(createStoreState.notifications).toEqual([])
    expect(createStoreState.loadingOwners).toEqual([])
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
    let visibilityCalls = 0
    const context = createShellHarness(store, testWindow, {
      updatePage: async (_fetcher, _id, input) => {
        updateInput = _.cloneDeep(input)
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

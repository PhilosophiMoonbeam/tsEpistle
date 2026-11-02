import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import type { DateInstance } from 'vuetify'
import * as lodash from 'lodash-es'
import { PageBrandingAssignmentSchema, PageBrandingViewSchema } from '../../../shared/page-branding.ts'
import { describePageVisibility } from './common/page-visibility'
import { translateEnglish } from '../../test/english-translate.mts'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

const pug: { render(source: string): string } = createRequire(import.meta.url)('pug')
const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const { descriptor } = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath })
const script = descriptor.script?.content ?? ''

// Static imports cannot work here: Vuetify must snapshot capabilities after the shared DOM harness installs them.
const Vue = await import('vue')
const { createVuetify, useDate } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

// Keep the owner's dialog attributes/bindings; replace only the unrelated form content.
const markup = cheerio.load(pug.render(descriptor.template?.content ?? ''))
const ownerDialog = markup('v-dialog').first().clone()
if (ownerDialog.length !== 1) throw new Error('Page Properties dialog invocation is missing')
ownerDialog.empty().append(`
  <button class="outer-field">Field</button>
  <v-dialog v-model="nestedOpen"><button class="nested-field">Nested</button></v-dialog>
`)
const dialogTemplate = compileTemplate({
  source: ownerDialog.toString(),
  filename: componentPath,
  id: 'page-properties-escape-owner',
  compilerOptions: { mode: 'function' }
})
if (dialogTemplate.errors.length) throw dialogTemplate.errors[0]
const dialogRender = new Function('Vue', dialogTemplate.code)(Vue)

/** Returns the source text of one options-API method, braces balanced. */
const methodSource = (name: string): string => {
  const start = script.search(new RegExp(`    ${name}\\s*\\(`))
  if (start < 0) throw new Error(`${name} was not found`)
  const open = script.indexOf('{', start)
  let depth = 0
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1
    if (script[index] === '}') depth -= 1
    if (depth === 0) return script.slice(start, index + 1)
  }
  throw new Error(`${name} is not balanced`)
}
const handlerCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = { ${methodSource('handleDialogKeydown')} }`)
const { handleDialogKeydown } = new Function(`${handlerCode}\nreturn methods`)() as {
  handleDialogKeydown: (this: { brandingPickerShown: boolean; cancel: () => void; closeBrandingPicker: () => void }, event: KeyboardEvent) => void
}

const cancelCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = { ${methodSource('cancel')} }`)
const { cancel } = new Function(`${cancelCode}\nreturn methods`)()
const unmounts: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

const settleOverlay = async (): Promise<void> => {
  await settle()
  vi.advanceTimersByTime(0)
  await settle()
}

const mountOwnerDialog = async () => {
  const rollbackDraft = vi.fn()
  const context = Vue.reactive({ isShown: true, brandingPickerShown: false, nestedOpen: false })
  const host = document.body.appendChild(document.createElement('div'))
  const OwnerDialog = Vue.defineComponent({
    data: () => context,
    methods: {
      handleDialogKeydown,
      cancel,
      rollbackDraft,
      closeBrandingPicker() {
        this.brandingPickerShown = false
      }
    },
    render: dialogRender
  })
  const app = Vue.createApp({
    render: () => Vue.h(vuetifyComponents.VApp, null, () => Vue.h(OwnerDialog))
  })
  app.use(createVuetify({ components: vuetifyComponents }))
  app.mount(host)
  unmounts.push(() => {
    app.unmount()
    host.remove()
  })
  await settleOverlay()
  const field = document.querySelector<HTMLElement>('.outer-field')
  if (!field) throw new Error('Page Properties dialog content did not render')
  return { field, rollbackDraft, context }
}

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetBody()
})

const escapeKey = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })

describe('Page Properties Esc', () => {
  test('Esc cancels like Cancel, but first closes an open branding picker', () => {
    const context = { brandingPickerShown: false, cancel: vi.fn(), closeBrandingPicker: vi.fn() }
    const first = escapeKey()
    handleDialogKeydown.call(context, first)
    expect(context.cancel).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)

    context.brandingPickerShown = true
    handleDialogKeydown.call(context, escapeKey())
    expect(context.closeBrandingPicker).toHaveBeenCalledTimes(1)
    expect(context.cancel).toHaveBeenCalledTimes(1)
  })

  test('ignores other keys, IME composition and Esc already handled by a child control', () => {
    const context = { brandingPickerShown: false, cancel: vi.fn(), closeBrandingPicker: vi.fn() }
    handleDialogKeydown.call(context, escapeKey({ key: 'Enter' }))
    handleDialogKeydown.call(context, escapeKey({ isComposing: true }))
    const handled = escapeKey()
    handled.preventDefault()
    handleDialogKeydown.call(context, handled)
    expect(context.cancel).not.toHaveBeenCalled()
    expect(context.closeBrandingPicker).not.toHaveBeenCalled()
  })

  test('the owner keeps scrim clicks and child-handled Esc from discarding edits, then cancels on Esc', async () => {
    vi.useFakeTimers()
    const { field, rollbackDraft } = await mountOwnerDialog()
    const scrim = document.querySelector<HTMLElement>('.v-overlay--active .v-overlay__scrim')
    if (!scrim) throw new Error('Page Properties scrim did not render')
    scrim.dispatchEvent(new document.defaultView!.MouseEvent('mousedown', { bubbles: true }))
    scrim.click()
    // Run ClickOutside's deferred handler rather than guessing a wall-clock delay.
    await settleOverlay()
    expect(document.querySelector('.v-overlay--active .outer-field')).toBe(field)
    expect(rollbackDraft).not.toHaveBeenCalled()

    field.dispatchEvent(escapeKey({ isComposing: true }))
    const handled = escapeKey()
    handled.preventDefault()
    field.dispatchEvent(handled)
    await settle()
    expect(document.querySelector('.v-overlay--active .outer-field')).toBe(field)
    expect(rollbackDraft).not.toHaveBeenCalled()

    field.focus()
    const escapeEvent = escapeKey()
    field.dispatchEvent(escapeEvent)
    await settle()
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(rollbackDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.v-overlay--active .outer-field')).toBeNull()
  })

  test('the owner leaves Esc to the top nested overlay before cancelling Page Properties', async () => {
    vi.useFakeTimers()
    const { field, rollbackDraft, context } = await mountOwnerDialog()
    context.nestedOpen = true
    await settleOverlay()
    const nestedField = document.querySelector<HTMLElement>('.nested-field')
    if (!nestedField) throw new Error('Nested dialog content did not render')
    nestedField.focus()
    nestedField.dispatchEvent(escapeKey())
    await settleOverlay()
    expect(context.nestedOpen).toBe(false)
    expect(rollbackDraft).not.toHaveBeenCalled()
    expect(document.querySelector('.v-overlay--active .outer-field')).toBe(field)
    field.focus()
    field.dispatchEvent(escapeKey())
    await settle()
    expect(rollbackDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.v-overlay--active .outer-field')).toBeNull()
  })
})

const scheduleCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const behavior = {
    watch: {
      ${methodSource('isPublishStartShown')},
      ${methodSource('isPublishEndShown')},
      ${methodSource('publishStartDate')},
      ${methodSource('publishEndDate')}
    },
    methods: {
      ${methodSource('applyPublishStartDate')},
      ${methodSource('applyPublishEndDate')}
    }
  }
`)
const scheduleBehavior = new Function(`${scheduleCode}\nreturn behavior`)()
type ScheduleHarness = {
  dateAdapter: DateInstance
  publishStartDate: string
  publishEndDate: string
  publishStartDraft: unknown
  publishEndDraft: unknown
  isPublishStartShown: boolean
  isPublishEndShown: boolean
  applyPublishStartDate: () => void
  applyPublishEndDate: () => void
}
const mountSchedule = (): ScheduleHarness => {
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp({
    ...scheduleBehavior,
    setup: () => ({ dateAdapter: useDate() }),
    data: () => ({
      publishStartDate: '',
      publishEndDate: '',
      publishStartDraft: null,
      publishEndDraft: null,
      isPublishStartShown: false,
      isPublishEndShown: false
    }),
    render: () => null
  })
  app.use(createVuetify({ components: vuetifyComponents }))
  const context = app.mount(host)
  unmounts.push(() => {
    app.unmount()
    host.remove()
  })
  return context as unknown as ScheduleHarness
}

describe('Page Properties scheduling draft', () => {
  for (const picker of [
    { date: 'publishStartDate', draft: 'publishStartDraft', open: 'isPublishStartShown', accept: 'applyPublishStartDate' },
    { date: 'publishEndDate', draft: 'publishEndDraft', open: 'isPublishEndShown', accept: 'applyPublishEndDate' }
  ] as const) {
    test(`${picker.date} seeds each opening and OK preserves an unchanged schedule exactly`, async () => {
      const context = mountSchedule()
      context[picker.date] = '2030-05-17T09:30:00.000Z'
      context[picker.open] = true
      await settle()
      expect(context.dateAdapter.toISO(context[picker.draft])).toBe('2030-05-17')
      context[picker.accept]()
      expect(context[picker.date]).toBe('2030-05-17T09:30:00.000Z')
      expect(context[picker.open]).toBe(false)
      await settle()

      context[picker.date] = '2031-06-18'
      context[picker.open] = true
      await settle()
      expect(context.dateAdapter.toISO(context[picker.draft])).toBe('2031-06-18')
      context[picker.accept]()
      expect(context[picker.date]).toBe('2031-06-18')
    })

    test(`${picker.date} discards cancelled picker selections and cannot resurrect a cleared date`, async () => {
      const context = mountSchedule()
      context[picker.date] = '2030-05-17'
      context[picker.open] = true
      await settle()
      context[picker.draft] = context.dateAdapter.parseISO('2032-07-19')
      context[picker.open] = false
      await settle()
      context[picker.open] = true
      await settle()
      expect(context.dateAdapter.toISO(context[picker.draft])).toBe('2030-05-17')
      context[picker.open] = false
      context[picker.date] = ''
      await settle()
      context[picker.open] = true
      await settle()
      expect(context[picker.draft]).toBeNull()
      context[picker.accept]()
      expect(context[picker.date]).toBe('')
    })

    test(`${picker.date} applies a selected day and honours an explicit clear while open`, async () => {
      const context = mountSchedule()
      context[picker.date] = '2030-05-17'
      context[picker.open] = true
      await settle()
      context[picker.draft] = context.dateAdapter.parseISO('2032-07-19')
      context[picker.accept]()
      expect(context[picker.date]).toBe('2032-07-19')
      await settle()
      context[picker.open] = true
      await settle()
      context[picker.date] = ''
      await settle()
      expect(context[picker.draft]).toBeNull()
      context[picker.accept]()
      expect(context[picker.date]).toBe('')
    })
  }
})

// The complete form and real Knowledge child share the same footer and session lifecycle.
// Only unrelated branding/selector surfaces are replaced; path validation remains Vuetify's.
const compileSfcRender = (source: string, filename: string) => {
  const template = parse(source, { filename }).descriptor.template
  if (!template) throw new Error(`Missing template: ${filename}`)
  const compiled = compileTemplate({
    source: template.content,
    filename,
    id: filename,
    preprocessLang: template.lang,
    preprocessOptions: { doctype: 'html' },
    compilerOptions: { mode: 'function' }
  })
  if (compiled.errors.length) throw compiled.errors[0]
  return new Function('Vue', compiled.code)(Vue)
}
const withoutImports = (source: string) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '')
const knowledgePath = join(process.cwd(), 'client/components/editor/editor-okf-panel.vue')
const knowledgeSource = readFileSync(knowledgePath, 'utf8')
const knowledgeScript = parse(knowledgeSource, { filename: knowledgePath }).descriptor.script!.content
// Keep the real exported draft handle; introduce the function return only after type erasure.
const knowledgeCode = new Bun.Transpiler({ loader: 'ts' })
  .transformSync(withoutImports(knowledgeScript))
  .replace('export function parseExtensionJson', 'function parseExtensionJson')
  .replace('export default', 'return')
const propertiesCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(withoutImports(script).replace('export default', 'return'))
const unusedSurface = Vue.defineComponent({ render: () => null })
const propertiesRender = compileSfcRender(readFileSync(componentPath, 'utf8'), componentPath)
const knowledgeRender = compileSfcRender(knowledgeSource, knowledgePath)
const createDraftStore = (metadata: Record<string, unknown> | null = { type: 'Reference', status: 'stable', oldExtension: true }) =>
  Vue.reactive({
    editor: { mode: 'create', media: { currentFileId: null } },
    page: {
      id: 0,
      title: 'Original title',
      description: 'Original description',
      locale: 'en',
      tags: ['original'],
      path: 'docs/original',
      isPublished: true,
      isSearchable: true,
      visibility: 'public',
      publishStartDate: '',
      publishEndDate: '',
      scriptJs: '',
      scriptCss: '',
      brandingAssignment: null,
      brandingView: null,
      pageFeatures: { linksVisible: true, ratingsAllowed: true, lastEditorVisible: true },
      effectivePermissions: { pages: { script: false, style: false } },
      sourceRevision: 'original-source',
      okfLoading: false,
      okfError: '',
      okf: {
        authority: { state: metadata ? 'valid' : 'missing', metadata, trust: { stale: false } },
        projection: { state: 'pending', value: null }
      }
    }
  })
type PropertiesHandle = {
  currentTab: number
  applying: boolean
  tagSearchError: string
  okfPanel: { readonly canCommit: boolean }
  $refs: { propsForm: { validate: () => Promise<{ valid: boolean }>; $: { setupState: { validate: () => Promise<{ valid: boolean }> } } } }
}
const mountDraftProperties = async (metadata?: Record<string, unknown> | null) => {
  const store = createDraftStore(metadata)
  const knowledge = {
    ...new Function('defineComponent', 'getCurrentInstance', 'wikiStore', knowledgeCode)(Vue.defineComponent, Vue.getCurrentInstance, store),
    render: knowledgeRender
  }
  const dependencies = {
    defineComponent: Vue.defineComponent,
    markRaw: Vue.markRaw,
    ref: Vue.ref,
    useDate,
    _: lodash,
    wikiStore: store,
    EditorOkfPanel: knowledge,
    PageBrandingMark: unusedSurface,
    createAsyncComponent: () => unusedSurface,
    describePageVisibility,
    PageBrandingAssignmentSchema,
    PageBrandingViewSchema,
    siteLangs: [{ code: 'en' }],
    siteConfig: { lang: 'en' }
  }
  const options = new Function(...Object.keys(dependencies), propertiesCode)(...Object.values(dependencies))
  const Owner = Vue.defineComponent({ ...options, render: propertiesRender })
  const shown = Vue.reactive({ value: true })
  const owner = Vue.ref<PropertiesHandle>()
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp({
    render: () =>
      Vue.h(vuetifyComponents.VApp, null, () =>
        Vue.h(Owner, {
          ref: owner,
          modelValue: shown.value,
          'onUpdate:modelValue': (value: boolean) => {
            shown.value = value
          }
        })
      )
  })
  app.component('PageSelector', unusedSurface)
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  unmounts.push(() => {
    app.unmount()
    host.remove()
  })
  await settle()
  return { store, shown, owner }
}
const draftField = (key: string): HTMLInputElement | HTMLTextAreaElement => {
  const label = Array.from(document.querySelectorAll('label')).find(label => label.htmlFor && label.textContent?.trim() === translateEnglish(key))
  const input = label ? document.getElementById(label.htmlFor) : null
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error(`Missing field ${key}`)
  return input
}
const editDraftField = async (key: string, value: string) => {
  const input = draftField(key)
  input.value = value
  input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }))
  await settle()
}
const footerAction = (key: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.editor-properties-actions button')).find(
    button => button.textContent?.trim() === translateEnglish(key)
  )
  if (!button) throw new Error(`Missing footer action ${key}`)
  return button
}
const applyProperties = async (owner: { value: PropertiesHandle | undefined }) => {
  footerAction('common:actions.apply').click()
  await vi.waitFor(() => expect(owner.value?.applying).toBe(false))
  await settle()
}

describe('Page Properties Knowledge footer transaction', () => {
  test('applies pending extensions from another tab with the property draft and preserves trust/projection', async () => {
    const { store, shown, owner } = await mountDraftProperties()
    const original = store.page.okf.authority.metadata
    const trust = store.page.okf.authority.trust
    const projection = store.page.okf.projection
    await editDraftField('editor:props.title', 'Updated title')
    owner.value!.currentTab = 5
    await settle()
    await editDraftField('editor:editorOkfPanel.extensions', '{"custom":{"enabled":true}}')
    owner.value!.currentTab = 1
    await settle()
    expect(store.page.title).toBe('Original title')
    expect(store.page.okf.authority.metadata).toBe(original)
    expect(document.querySelectorAll('.editor-properties-actions button')).toHaveLength(2)
    await applyProperties(owner)
    expect(shown.value).toBe(false)
    expect(store.page.title).toBe('Updated title')
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable', custom: { enabled: true } })
    expect(original).toEqual({ type: 'Reference', status: 'stable', oldExtension: true })
    expect(store.page.okf.authority.trust).toBe(trust)
    expect(store.page.okf.projection).toBe(projection)
  })

  test.each(['{', '{"type":"Article"}', '{"custom":[{"constructor":{"prototype":{}}}]}'])(
    'keeps invalid extension drafts open without partially committing properties: %s',
    async text => {
      const { store, shown, owner } = await mountDraftProperties()
      const original = store.page.okf.authority.metadata
      await editDraftField('editor:props.title', 'Must remain a draft')
      await editDraftField('editor:editorOkfPanel.extensions', text)
      owner.value!.currentTab = 0
      await settle()
      await applyProperties(owner)
      expect(shown.value).toBe(true)
      expect(owner.value!.currentTab).toBe(5)
      const input = draftField('editor:editorOkfPanel.extensions')
      expect(document.activeElement).toBe(input)
      const error = document.querySelector('#editor-okf-extension-error')
      expect(error?.getAttribute('role')).toBe('alert')
      expect(error?.textContent?.trim()).toBeTruthy()
      expect(store.page.title).toBe('Original title')
      expect(store.page.okf.authority.metadata).toBe(original)
    }
  )

  test('does not commit valid extensions when the real path form rejects the property draft', async () => {
    const { store, shown, owner } = await mountDraftProperties()
    const original = store.page.okf.authority.metadata
    await editDraftField('editor:props.title', 'Must remain a draft')
    await editDraftField('editor:props.path', 'invalid#path')
    await editDraftField('editor:editorOkfPanel.extensions', '{"custom":42}')
    owner.value!.currentTab = 5
    await settle()
    await applyProperties(owner)
    expect(shown.value).toBe(true)
    expect(owner.value!.currentTab).toBe(0)
    const path = draftField('editor:props.path')
    expect(document.activeElement).toBe(path)
    const fieldError = path.closest('.v-input')?.querySelector('[role="alert"]')
    expect(fieldError?.textContent?.trim()).toBeTruthy()
    expect(store.page.title).toBe('Original title')
    expect(store.page.path).toBe('docs/original')
    expect(store.page.okf.authority.metadata).toBe(original)
  })

  test('Cancel retires both live metadata changes and pending JSON when the same dialog reopens', async () => {
    const { store, shown, owner } = await mountDraftProperties()
    await editDraftField('editor:props.title', 'Discarded title')
    owner.value!.currentTab = 5
    await settle()
    await editDraftField('editor:editorOkfPanel.type', 'Article')
    await editDraftField('editor:editorOkfPanel.extensions', '{"discarded":true}')
    footerAction('common:actions.cancel').click()
    await settle()
    expect(shown.value).toBe(false)
    expect(store.page.title).toBe('Original title')
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable', oldExtension: true })
    shown.value = true
    await settle()
    expect(draftField('editor:props.title').value).toBe('Original title')
    expect(JSON.parse(draftField('editor:editorOkfPanel.extensions').value)).toEqual({ oldExtension: true })
    await editDraftField('editor:props.title', 'Reopened title')
    await applyProperties(owner)
    expect(store.page.title).toBe('Reopened title')
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable', oldExtension: true })
  })

  test('an Apply awaiting validation cannot commit into a cancelled or reopened editing session', async () => {
    const { store, shown, owner } = await mountDraftProperties()
    await editDraftField('editor:props.title', 'Retired title')
    owner.value!.currentTab = 5
    await settle()
    await editDraftField('editor:editorOkfPanel.extensions', '{"retired":true}')
    owner.value!.currentTab = 0
    await settle()
    expect(owner.value!.okfPanel.canCommit).toBe(true)
    const form = owner.value!.$refs.propsForm
    const originalValidate = form.validate
    const validation = Promise.withResolvers<void>()
    let formResult: { valid: boolean } | undefined
    // Assign the wrapper through Vue's proxy setter rather than instrumenting a
    // Proxy with spyOn. Preserve genuine VForm validation and defer its result.
    const validate = vi.fn(async () => {
      const result = await originalValidate()
      formResult = result
      await validation.promise
      return result
    })
    form.validate = validate
    expect(form.validate).toBe(validate)
    expect(form.$.setupState.validate).toBe(validate)
    const apply = footerAction('common:actions.apply')
    expect(apply.disabled).toBe(false)
    apply.click()
    await vi.waitFor(() => {
      expect(validate).toHaveBeenCalledTimes(1)
      expect(formResult?.valid).toBe(true)
      expect(owner.value!.applying).toBe(true)
    })
    footerAction('common:actions.cancel').click()
    await settle()
    shown.value = true
    await settle()
    validation.resolve()
    await vi.waitFor(() => expect(owner.value!.applying).toBe(false))
    await settle()
    expect(shown.value).toBe(true)
    expect(store.page.title).toBe('Original title')
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable', oldExtension: true })
    expect(JSON.parse(draftField('editor:editorOkfPanel.extensions').value)).toEqual({ oldExtension: true })
  })

  test('revalidates edited JSON after asynchronous property validation before either draft can commit', async () => {
    const { store, shown, owner } = await mountDraftProperties()
    const original = store.page.okf.authority.metadata
    await editDraftField('editor:props.title', 'Still pending')
    owner.value!.currentTab = 5
    await settle()
    await editDraftField('editor:editorOkfPanel.extensions', '{"custom":true}')
    owner.value!.currentTab = 0
    await settle()
    expect(owner.value!.okfPanel.canCommit).toBe(true)
    const form = owner.value!.$refs.propsForm
    const originalValidate = form.validate
    const validation = Promise.withResolvers<void>()
    let formResult: { valid: boolean } | undefined
    const validate = vi.fn(async () => {
      const result = await originalValidate()
      formResult = result
      await validation.promise
      return result
    })
    form.validate = validate
    expect(form.validate).toBe(validate)
    expect(form.$.setupState.validate).toBe(validate)
    const apply = footerAction('common:actions.apply')
    expect(apply.disabled).toBe(false)
    apply.click()
    await vi.waitFor(() => {
      expect(validate).toHaveBeenCalledTimes(1)
      expect(formResult?.valid).toBe(true)
      expect(owner.value!.applying).toBe(true)
    })
    owner.value!.currentTab = 5
    await settle()
    await editDraftField('editor:editorOkfPanel.extensions', '{"custom":{"__proto__":{}}}')
    validation.resolve()
    await vi.waitFor(() => expect(owner.value!.applying).toBe(false))
    await settle()
    expect(shown.value).toBe(true)
    expect(owner.value!.currentTab).toBe(5)
    expect(document.activeElement).toBe(draftField('editor:editorOkfPanel.extensions'))
    expect(document.querySelector('#editor-okf-extension-error')?.getAttribute('role')).toBe('alert')
    expect(store.page.title).toBe('Original title')
    expect(store.page.okf.authority.metadata).toBe(original)
  })

  test('ordinary property edits do not create missing Knowledge authority', async () => {
    const { store, shown, owner } = await mountDraftProperties(null)
    const authority = store.page.okf.authority
    const projection = store.page.okf.projection
    await editDraftField('editor:props.title', 'Properties only')
    await applyProperties(owner)
    expect(shown.value).toBe(false)
    expect(store.page.title).toBe('Properties only')
    expect(store.page.okf.authority).toBe(authority)
    expect(store.page.okf.authority.metadata).toBeNull()
    expect(store.page.okf.authority.state).toBe('missing')
    expect(store.page.okf.projection).toBe(projection)
  })

  test('associates ordinary Info and Scheduling help without announcing it as errors', async () => {
    const { owner } = await mountDraftProperties()
    for (const tab of [0, 1, 5]) {
      owner.value!.currentTab = tab
      await settle()
      const help = Array.from(
        document.querySelectorAll('.editor-properties-help, #editor-okf-resource-help, #editor-okf-stale-help, #editor-okf-extension-help')
      )
      expect(help.length).toBeGreaterThan(0)
      for (const element of help) {
        expect(element.textContent?.trim()).toBeTruthy()
        expect(element.closest('[role="alert"], [aria-live]')).toBeNull()
        expect(document.querySelector(`[aria-describedby~="${element.id}"]`)).not.toBeNull()
      }
    }
    owner.value!.currentTab = 0
    owner.value!.tagSearchError = 'Suggestions unavailable'
    await settle()
    const tagError = document.querySelector('#editor-properties-tags-error')
    expect(tagError?.getAttribute('role')).toBe('alert')
    expect(tagError?.textContent).toContain('Suggestions unavailable')
    expect(document.querySelector('[aria-describedby~="editor-properties-tags-error"]')).not.toBeNull()
  })
})

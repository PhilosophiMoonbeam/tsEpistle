import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { browserWindow } from '../../test/browser-dom.mts'

const panelPath = path.join(process.cwd(), 'client/components/editor/editor-okf-panel.vue')
const panelSource = fs.readFileSync(panelPath, 'utf8')
const script = panelSource.match(/<script lang=['"]ts['"]>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? ''
type PanelMethod = (...args: unknown[]) => unknown
type PanelDefinition = { methods: Record<string, PanelMethod> }
type ExtensionParser = (text: string) => { value: Record<string, unknown> | null; error: string | null }

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script
    .replace(/^import .*$/gm, '')
    .replace('export function parseExtensionJson', 'function parseExtensionJson')
    .replace('export default defineComponent', 'const panel = defineComponent') + '\nreturn { panel, parseExtensionJson }'
)
const loadPanel = () =>
  new Function('defineComponent', executableScript)((options: unknown) => options) as { panel: PanelDefinition; parseExtensionJson: ExtensionParser }
const loadParser = () => loadPanel().parseExtensionJson

// Vuetify snapshots browser globals during evaluation; import after the shared DOM harness.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const descriptor = parse(panelSource, { filename: panelPath }).descriptor
if (!descriptor.template) throw new Error('OKF panel template is required')
const template = compileTemplate({
  source: descriptor.template.content,
  filename: panelPath,
  id: 'editor-okf-panel-test',
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue)
const unmounts: Array<() => void> = []
const editorPath = path.join(process.cwd(), 'client/components/editor.vue')
const ownerScript = parse(fs.readFileSync(editorPath, 'utf8'), { filename: editorPath }).descriptor.script?.content
if (!ownerScript) throw new Error('Editor retry owner script is missing')
const ownerAst = ts.createSourceFile(editorPath, ownerScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const ownerExport = ownerAst.statements.find(ts.isExportAssignment)
if (!ownerExport || !ts.isCallExpression(ownerExport.expression) || !ts.isObjectLiteralExpression(ownerExport.expression.arguments[0])) {
  throw new Error('Editor retry owner component is missing')
}
const ownerOptions = ownerExport.expression.arguments[0]
const ownerMember = (name: string, group?: string) => {
  let properties = ownerOptions.properties
  if (group) {
    const property = properties.find(property => !ts.isSpreadAssignment(property) && property.name?.getText(ownerAst) === group)
    if (!property || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error(`Missing owner option: ${group}`)
    properties = property.initializer.properties
  }
  const member = properties.find(property => !ts.isSpreadAssignment(property) && property.name?.getText(ownerAst) === name)
  if (!member) throw new Error(`Missing owner member: ${name}`)
  return member.getText(ownerAst)
}
const ownerBehavior = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `return { ${ownerMember('provide')}, ${ownerMember('canRetryOkfAuthorityLoad', 'computed')}, ${ownerMember('retryOkfAuthorityLoad', 'methods')} }`
)

interface PanelStore {
  page: {
    id: number
    sourceRevision: string
    okfLoading: boolean
    okfError: string
    okf: {
      authority: { state: string; metadata: Record<string, unknown> | null; trust: Record<string, unknown> | null }
      projection: { state: string; value: Record<string, unknown> | null }
    }
  }
}
const panelStore = (metadata: Record<string, unknown> | null = { type: 'Reference', status: 'stable' }): PanelStore => Vue.reactive({
  page: {
    id: 12,
    sourceRevision: 'revision-panel',
    okfLoading: false,
    okfError: '',
    okf: {
      authority: { state: metadata ? 'valid' : 'missing', metadata, trust: null },
      projection: { state: 'pending', value: null }
    }
  }
})

const mountPanel = (store: PanelStore, retry?: { isAvailable: () => boolean; run: () => Promise<void> }) => {
  const options = new Function('defineComponent', 'wikiStore', executableScript)(Vue.defineComponent, store).panel
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...options, render })
  app.config.globalProperties.$t = translateEnglish
  if (retry) app.provide('okfLoadRetry', retry)
  app.use(createVuetify({ components, directives }))
  app.mount(host)
  unmounts.push(() => { app.unmount(); host.remove() })
  return host
}

const field = (root: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement => {
  const element = Array.from(root.querySelectorAll('label')).find(element => element.htmlFor && element.textContent?.trim() === label)
  const input = element?.htmlFor ? document.getElementById(element.htmlFor) : null
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error(`Missing field: ${label}`)
  expect(input.disabled).toBe(false)
  return input
}
const edit = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await Vue.nextTick()
}
const button = (root: ParentNode, name: string): HTMLButtonElement => {
  const target = Array.from(root.querySelectorAll('button')).find(element =>
    (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  if (!target) throw new Error(`Missing button: ${name}`)
  return target
}
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('Knowledge / OKF editor panel', () => {
  it('edits metadata through enabled controls without mutating authority or derived data', async () => {
    const store = panelStore({ type: 'Reference', status: 'stable', resource: 'urn:old', stale_after: '2026-12-01' })
    store.page.okf.authority.trust = { stale: false }
    const original = store.page.okf.authority.metadata
    const trust = store.page.okf.authority.trust
    const projection = store.page.okf.projection
    const root = mountPanel(store)
    await edit(field(root, 'Type'), 'Article')
    const status = field(root, 'Status')
    status.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Vue.nextTick()
    const draft = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(element => element.textContent?.trim() === 'draft')
    if (!draft) throw new Error('Draft status option is missing')
    draft.click()
    await Vue.nextTick()
    await edit(field(root, 'Resource'), 'urn:new')
    await edit(field(root, 'Stale after'), '2027-01-01')
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Article', status: 'draft', resource: 'urn:new', stale_after: '2027-01-01' })
    expect(original).toEqual({ type: 'Reference', status: 'stable', resource: 'urn:old', stale_after: '2026-12-01' })
    expect(store.page.okf.authority.metadata).not.toBe(original)
    expect(store.page.okf.authority.trust).toBe(trust)
    expect(store.page.okf.projection).toBe(projection)
  })

  it('deletes cleared optional fields without changing required metadata', () => {
    const methods = loadPanel().panel.methods
    const projection = { state: 'pending', value: { summary: 'derived data' } }
    const store = {
      page: {
        okf: {
          authority: {
            state: 'valid',
            metadata: {
              type: 'Reference',
              status: 'stable',
              resource: 'urn:example:resource',
              stale_after: '2026-12-01T00:00:00.000Z'
            },
            trust: null
          },
          projection
        }
      }
    }
    const context: Record<string, unknown> = { okfStore: store }
    Object.defineProperty(context, 'authorityMetadata', {
      get: () => store.page.okf.authority.metadata
    })
    context.replaceMetadata = methods.replaceMetadata.bind(context)

    methods.updateOptionalMetadata.call(context, 'resource', '')
    methods.updateOptionalMetadata.call(context, 'stale_after', '')

    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable' })
    expect(store.page.okf.projection).toBe(projection)
  })

  it('edits and removes only the selected source without mutating the baseline', async () => {
    const store = panelStore({
      type: 'Reference', status: 'stable',
      sources: [{ resource: 'urn:first', id: 'one' }, { resource: 'urn:second', id: 'two' }]
    })
    const original = store.page.okf.authority.metadata
    const projection = store.page.okf.projection
    const trust = store.page.okf.authority.trust
    const root = mountPanel(store)
    const second = root.querySelector('[role="group"][aria-label="Source 2"]')
    if (!second) throw new Error('Second source is missing')
    await edit(field(second, 'Source resource'), 'urn:changed')
    expect(store.page.okf.authority.metadata?.sources).toEqual([{ resource: 'urn:first', id: 'one' }, { resource: 'urn:changed', id: 'two' }])
    button(root, 'Remove source 1').click()
    await Vue.nextTick()
    expect(store.page.okf.authority.metadata?.sources).toEqual([{ resource: 'urn:changed', id: 'two' }])
    expect(original?.sources).toEqual([{ resource: 'urn:first', id: 'one' }, { resource: 'urn:second', id: 'two' }])
    expect(store.page.okf.projection).toBe(projection)
    expect(store.page.okf.authority.trust).toBe(trust)
  })

  it('validates extension JSON and rejects core or unsafe keys without overwriting metadata', async () => {
    const parseExtensionJson = loadParser()
    expect(parseExtensionJson('{"custom":{"enabled":true}}')).toEqual({ value: { custom: { enabled: true } }, error: null })
    expect(parseExtensionJson('{')).toMatchObject({ value: null })
    expect(parseExtensionJson('[]').value).toBeNull()
    expect(parseExtensionJson('{"status":"stable"}').value).toBeNull()
    expect(parseExtensionJson('{"__proto__":{}}').value).toBeNull()
    const store = panelStore({ type: 'Reference', status: 'stable', resource: 'urn:core', oldExtension: true })
    const original = store.page.okf.authority.metadata
    const projection = store.page.okf.projection
    const root = mountPanel(store)
    const editableMetadata = field(root, 'Extensions').closest('.v-card')
    if (!editableMetadata) throw new Error('Editable metadata region is missing')
    const projectionAlert = Array.from(root.querySelectorAll('[role="alert"]')).find(alert => !editableMetadata.contains(alert))
    expect(projectionAlert).toBeDefined()
    const projectionMessage = projectionAlert!.textContent
    await edit(field(root, 'Extensions'), '{"__proto__":{}}')
    button(root, 'Apply extensions').click()
    await Vue.nextTick()
    const extensionError = translateEnglish(parseExtensionJson('{"__proto__":{}}').error!)
    expect(Array.from(editableMetadata.querySelectorAll('[role="alert"]'), alert => alert.textContent)).toEqual(expect.arrayContaining([expect.stringContaining(extensionError)]))
    expect(store.page.okf.authority.metadata).toBe(original)
    await edit(field(root, 'Extensions'), '{"custom":{"enabled":true}}')
    button(root, 'Apply extensions').click()
    await Vue.nextTick()
    expect(Array.from(editableMetadata.querySelectorAll('[role="alert"]'), alert => alert.textContent)).not.toEqual(expect.arrayContaining([expect.stringContaining(extensionError)]))
    expect(root.contains(projectionAlert!)).toBe(true)
    expect(projectionAlert!.textContent).toBe(projectionMessage)
    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable', resource: 'urn:core', custom: { enabled: true } })
    expect(original).toEqual({ type: 'Reference', status: 'stable', resource: 'urn:core', oldExtension: true })
    expect(store.page.okf.projection).toBe(projection)
  })

  it('resets missing or invalid authority locally without replacing derived data', async () => {
    const resetInvalid = loadPanel().panel.methods.resetInvalid
    for (const state of ['invalid', 'missing']) {
      const projection = { state: 'current', value: { summary: 'derived data' } }
      const trust = { preserved: true }
      const store = {
        page: {
          okf: {
            authority: { state, metadata: null, trust },
            projection
          }
        }
      }
      const context = {
        okfStore: store,
        hasMetadata: false,
        extensionError: 'previous error',
        extensionEditing: true
      }

      resetInvalid.call(context)

      expect(store.page.okf.authority).toEqual({
        state: 'valid',
        metadata: { type: 'Reference', status: 'stable' },
        trust
      })
      expect(store.page.okf.projection).toBe(projection)
    }
    for (const state of ['invalid', 'missing']) {
      const store = panelStore(null)
      store.page.okf.authority.state = state
      store.page.okf.authority.trust = { preserved: true }
      const projection = store.page.okf.projection
      const trust = store.page.okf.authority.trust
      const root = mountPanel(store)
      button(root, 'Reset to stable reference').click()
      await Vue.nextTick()
      expect(store.page.okf.authority).toEqual({ state: 'valid', metadata: { type: 'Reference', status: 'stable' }, trust })
      expect(store.page.okf.projection).toBe(projection)
      expect(root.querySelector('[role="status"]')).toBeNull()
    }
  })

  it('retries failed authority loads once and restores focus for either outcome', async () => {
    const retryLoad = loadPanel().panel.methods.retryLoad
    let resolveRequest: (() => void) | undefined
    let retryCalls = 0
    let retryAvailable = true
    const focusTargets: unknown[] = []
    const retryButton = { name: 'retry' }
    const authorityHeading = { name: 'authority' }
    const context = {
      okfError: 'Authority load failed',
      okfLoading: false,
      retryPending: false,
      okfLoadRetry: {
        isAvailable: () => retryAvailable,
        run: () => {
          retryCalls += 1
          return new Promise<void>(resolve => {
            resolveRequest = resolve
          })
        }
      },
      $nextTick: () => Promise.resolve(),
      $refs: { retryButton, authorityHeading },
      focusControl: (target: unknown) => focusTargets.push(target)
    }

    const failedRetry = retryLoad.call(context) as Promise<void>
    const duplicateRetry = retryLoad.call(context) as Promise<void>
    expect(retryCalls).toBe(1)
    expect(context.retryPending).toBe(true)
    resolveRequest?.()
    await Promise.all([failedRetry, duplicateRetry])
    expect(context.retryPending).toBe(false)
    expect(focusTargets).toEqual([retryButton])

    const successfulRetry = retryLoad.call(context) as Promise<void>
    context.okfError = ''
    retryAvailable = false
    resolveRequest?.()
    await successfulRetry
    expect(retryCalls).toBe(2)
    expect(focusTargets).toEqual([retryButton, authorityHeading])

    const store = panelStore()
    store.page.okf.authority.metadata = null
    store.page.okf.authority.state = 'missing'
    store.page.okfError = 'Authority load failed'
    const owner = Vue.reactive({
      mode: 'update',
      hydratePage: () => {
        calls++
        return new Promise<void>(resolve => { finish = resolve })
      }
    })
    let finish: (() => void) | undefined
    let calls = 0
    const behavior = new Function('wikiStore', ownerBehavior)(store)
    Object.defineProperty(owner, 'canRetryOkfAuthorityLoad', { get: () => behavior.canRetryOkfAuthorityLoad.call(owner) })
    Object.assign(owner, { retryOkfAuthorityLoad: behavior.retryOkfAuthorityLoad.bind(owner) })
    const root = mountPanel(store, behavior.provide.call(owner).okfLoadRetry)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(store.page.okfError)
    const retry = button(root, 'Retry')
    retry.click()
    retry.click()
    await Vue.nextTick()
    expect(calls).toBe(1)
    expect(retry.disabled).toBe(true)
    finish?.()
    for (let attempt = 0; attempt < 8 && document.activeElement !== retry; attempt++) await Vue.nextTick()
    expect(document.activeElement).toBe(retry)
    retry.click()
    store.page.okfError = ''
    store.page.okf.authority.metadata = { type: 'Reference', status: 'stable' }
    finish?.()
    for (let attempt = 0; attempt < 8 && document.activeElement?.textContent !== 'Authority'; attempt++) await Vue.nextTick()
    expect(calls).toBe(2)
    expect(document.activeElement?.textContent).toBe('Authority')
    expect(Array.from(root.querySelectorAll('button')).some(element => element.textContent?.trim() === 'Retry')).toBe(false)
    store.page.okfError = 'Unavailable'
    store.page.okfLoading = true
    await Vue.nextTick()
    expect(root.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(Array.from(root.querySelectorAll('button')).some(element => element.textContent?.trim() === 'Retry')).toBe(false)
    store.page.okfLoading = false
    owner.mode = 'create'
    await Vue.nextTick()
    expect(Array.from(root.querySelectorAll('button')).some(element => element.textContent?.trim() === 'Retry')).toBe(false)
    owner.mode = 'update'
    owner.pageId = 0
    await Vue.nextTick()
    expect(Array.from(root.querySelectorAll('button')).some(element => element.textContent?.trim() === 'Retry')).toBe(false)
  })

  it('shows authority, projection, completeness and trust-staleness distinctions', async () => {
    const store = panelStore()
    const root = mountPanel(store)
    const valueAfter = (label: string) => Array.from(root.querySelectorAll('.text-label-small')).find(element => element.textContent?.trim() === label)?.nextElementSibling?.textContent?.trim()
    expect(valueAfter('State')).toBe('valid')
    expect(valueAfter('Projection')).toBe('pending')
    expect(valueAfter('Completeness')).toBe('—')
    expect(valueAfter('Stale')).toBe('—')
    store.page.okf.authority.state = 'invalid'
    store.page.okf.authority.trust = { stale: true }
    store.page.okf.projection = { state: 'current', value: {
      state: 'incomplete', tags: [], missingFields: ['summary'], entities: [], relationships: [], openQuestions: [],
      provenance: { deterministicVersion: 'version' }
    } }
    await Vue.nextTick()
    expect(valueAfter('State')).toBe('invalid')
    expect(valueAfter('Projection')).toBe('current')
    expect(valueAfter('Completeness')).toBe('incomplete')
    expect(valueAfter('Stale')).toBe('stale')
    store.page.okf.authority.trust = { stale: false }
    store.page.okf.projection.value!.state = 'complete'
    await Vue.nextTick()
    expect(valueAfter('Completeness')).toBe('complete')
    expect(valueAfter('Stale')).toBe('current')
  })

  it('shows supplied provenance and distinguishes absent evidence and utility', async () => {
    const store = panelStore()
    const values = ['deterministic-v7', 'summary-field', 'source-agent', 'evidence-quote', 'profile-v9', 'model-example', 'input-hash', 'output-hash', 'generated-time']
    store.page.okf.projection.value = {
      tags: [], missingFields: [], entities: [], relationships: [], openQuestions: [],
      provenance: {
        deterministicVersion: values[0],
        fields: [{ field: values[1], source: values[2], evidence: values[3] }],
        utility: { profileVersionId: values[4], model: values[5], inputSha256: values[6], outputSha256: values[7], generatedAt: values[8] }
      }
    }
    const root = mountPanel(store)
    for (const value of values) expect(root.textContent).toContain(value)
    store.page.okf.projection.value = {
      tags: [], missingFields: [], entities: [], relationships: [], openQuestions: [],
      provenance: { deterministicVersion: values[0], fields: [], utility: null }
    }
    await Vue.nextTick()
    expect(root.textContent).toContain(values[0])
    for (const value of values.slice(1)) expect(root.textContent).not.toContain(value)
    expect(root.querySelector('.v-list')).toBeNull()
    expect(root.querySelector('code')).toBeNull()
  })
})

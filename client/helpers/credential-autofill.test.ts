import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../server/test/bun-test.mts'
import { protectCredentialControl } from './credential-autofill.ts'
import { translateEnglish } from '../test/english-translate.mts'
import '../test/browser-dom.mts'
import { babelParse, compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import type { BindingMetadata } from '@vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import type { ElementNode, TemplateChildNode } from '@vue/compiler-dom'
import type { Component } from 'vue'
import path from 'node:path'

// Vuetify snapshots browser capabilities at import time; load it after the shared DOM installs its stubs.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')

const compileRender = (source: string, filename: string, bindingMetadata?: BindingMetadata) => {
  const result = compileTemplate({ source, filename, id: 'credential-autofill', compilerOptions: { mode: 'function', bindingMetadata } })
  if (result.errors.length) throw result.errors[0]
  return new Function('Vue', result.code)(Vue)
}

const authPath = path.resolve('client/components/admin/admin-auth-fields.vue')
const auth = parse(fs.readFileSync(authPath, 'utf8'), { filename: authPath }).descriptor
const authScript = auth.script!.content
const authSyntax = babelParse(authScript, { sourceType: 'module', plugins: ['typescript'] })
let executableAuth = authScript
for (const node of [...authSyntax.program.body].reverse()) {
  if (node.type === 'ImportDeclaration') executableAuth = executableAuth.slice(0, node.start!) + executableAuth.slice(node.end!)
}
const authImports: Record<string, unknown> = {}
for (const node of authSyntax.program.body) {
  if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue
  const imported = await import(path.resolve(path.dirname(authPath), node.source.value))
  for (const specifier of node.specifiers) {
    if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
      authImports[specifier.local.name] = imported[specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value]
    }
  }
}
const AuthFields = new Function(...Object.keys(authImports),
  new Bun.Transpiler({ loader: 'ts' }).transformSync(executableAuth.replace('export default', 'const component =')) + '\nreturn component'
)(...Object.values(authImports))
AuthFields.render = compileRender(auth.template!.content, authPath)

const storagePath = path.resolve('client/components/admin/admin-storage.vue')
const storage = parse(fs.readFileSync(storagePath, 'utf8'), { filename: storagePath }).descriptor
const fieldSections: string[] = []
const collectFields = (nodes: TemplateChildNode[]): void => {
  for (const node of nodes) {
    if (node.type !== 1) continue
    const element = node as ElementNode
    const classes = element.props.find(prop => prop.type === 6 && prop.name === 'class')
    const value = classes?.type === 6 ? classes.value?.content : ''
    const schedule = element.props.some(prop => prop.type === 7 && prop.name === 'if' && prop.exp?.type === 4 && prop.exp.content === 'selectedTarget.schedule')
    const credentials = value === 'storage-field-section' && element.props.some(prop =>
      prop.type === 7 && prop.name === 'for' && prop.exp?.type === 4 && prop.exp.content === 'group in fieldGroups')
    if (schedule || credentials) fieldSections.push(element.loc.source)
    else collectFields(element.children)
  }
}
collectFields(baseParse(storage.template!.content).children)
if (fieldSections.length !== 2) throw new Error('Storage schedule and credential field sections are required')
const storageBindings = compileScript(storage, { id: 'credential-storage' }).bindings
const renderStorageFields = compileRender(`<div>${fieldSections.join('')}</div>`, storagePath, storageBindings)
const storageImports: Record<string, unknown> = {}
for (const node of babelParse(storage.scriptSetup!.content, { sourceType: 'module', plugins: ['typescript'] }).program.body) {
  if (node.type !== 'ImportDeclaration' || !node.source.value.endsWith('/credential-autofill.ts')) continue
  const imported = await import(path.resolve(path.dirname(storagePath), node.source.value))
  for (const specifier of node.specifiers) {
    if (specifier.type === 'ImportSpecifier') {
      storageImports[specifier.local.name] = imported[specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value]
    }
  }
}

const nativeControl = (host: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement => {
  // Vuetify's inactive floating labels have no `for`, and VSelect's hidden
  // form inputs have no id. Empty-string equality is not a label association.
  const control = [...host.querySelectorAll<HTMLLabelElement>('label')]
    .filter(element => element.textContent?.trim() === label)
    .map(element => element.control)
    .find(candidate => candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) throw new Error(`No native control labeled ${label}`)
  return control
}

const expectProtection = (control: HTMLInputElement | HTMLTextAreaElement, autocomplete: string): void => {
  expect(control.getAttribute('autocomplete')).toBe(autocomplete)
  for (const [name, value] of Object.entries(protectedAttributes)) expect(control.getAttribute(name)).toBe(value)
}

const mountFields = (component: Component) => {
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp(component)
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components, directives }))
  app.mount(host)
  return { app, host }
}

const protectedAttributes = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other'
}

describe('credential autofill protection', () => {
  it.each([
    ['text', 'off'],
    ['number', 'off'],
    ['password', 'new-password']
  ])('protects a native %s input', (type, autocomplete) => {
    const dom = new JSDOM(`<div><input type="${type}"></div>`)
    const root = dom.window.document.querySelector('div') as HTMLElement
    const control = root.querySelector('input') as HTMLInputElement

    protectCredentialControl(root)

    expect(control.getAttribute('autocomplete')).toBe(autocomplete)
    for (const [name, value] of Object.entries(protectedAttributes)) expect(control.getAttribute(name)).toBe(value)
  })

  it('protects a native textarea root', () => {
    const dom = new JSDOM('<textarea></textarea>')
    const control = dom.window.document.querySelector('textarea') as HTMLElement

    protectCredentialControl(control)

    expect(control.getAttribute('autocomplete')).toBe('off')
    for (const [name, value] of Object.entries(protectedAttributes)) expect(control.getAttribute(name)).toBe(value)
  })

  it('protects every rendered authentication field and newly replaced credentials', async () => {
    const fields = Vue.reactive([
      { key: 'certificate', title: 'Certificate', sensitive: true, multiline: true, type: 'string', choices: [], hint: '' },
      { key: 'password', title: 'Password', sensitive: true, multiline: false, type: 'string', choices: [], hint: '' },
      { key: 'notes', title: 'Notes', sensitive: false, multiline: true, type: 'string', choices: [], hint: '' },
      { key: 'attempts', title: 'Attempts', sensitive: false, multiline: false, type: 'number', choices: [], hint: '' },
      { key: 'username', title: 'Username', sensitive: false, multiline: false, type: 'string', choices: [], hint: '' }
    ])
    const model = Vue.ref({ config: { notes: '', attempts: 3, username: '' }, secrets: {
      certificate: { action: 'keep', value: '' }, password: { action: 'keep', value: '' }
    } })
    const disabled = Vue.ref(true)
    const { app, host } = mountFields({
      render: () => Vue.h(AuthFields, { fields, disabled: disabled.value, modelValue: model.value, 'onUpdate:modelValue': (value: typeof model.value) => { model.value = value } })
    })
    try {
      expect(nativeControl(host, 'Notes').tagName).toBe('TEXTAREA')
      for (const label of ['Notes', 'Attempts', 'Username']) {
        const control = nativeControl(host, label)
        expect(control.disabled).toBe(true)
        expectProtection(control, 'off')
      }
      expect(host.querySelector('input[type=password]')).toBeNull()
      model.value.secrets.certificate.action = 'replace'
      model.value.secrets.password.action = 'replace'
      await Vue.nextTick()
      expectProtection(nativeControl(host, 'Replacement Certificate'), 'off')
      expectProtection(nativeControl(host, 'Replacement Password'), 'new-password')
      expect(nativeControl(host, 'Replacement Certificate').disabled).toBe(true)
      const password = nativeControl(host, 'Replacement Password')
      expect(password.disabled).toBe(true)
      fields[1]!.multiline = true
      await Vue.nextTick()
      expect(nativeControl(host, 'Replacement Password').tagName).toBe('TEXTAREA')
      expect(nativeControl(host, 'Replacement Password')).not.toBe(password)
      expectProtection(nativeControl(host, 'Replacement Password'), 'off')
      disabled.value = false
      await Vue.nextTick()
      for (const label of ['Notes', 'Attempts', 'Username', 'Replacement Certificate', 'Replacement Password']) {
        const control = nativeControl(host, label)
        expect(control.disabled).toBe(false)
        expectProtection(control, 'off')
      }
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('protects authored storage schedule and all credential/config field branches after updates', async () => {
    const fields = Vue.reactive([
      { key: 'certificate', title: 'Certificate', sensitive: true, multiline: true, type: 'string', options: [], hint: '' },
      { key: 'password', title: 'Password', sensitive: true, multiline: false, type: 'string', options: [], hint: '' },
      { key: 'notes', title: 'Notes', sensitive: false, multiline: true, type: 'string', options: [], hint: '' },
      { key: 'attempts', title: 'Attempts', sensitive: false, multiline: false, type: 'number', options: [], hint: '' },
      { key: 'username', title: 'Username', sensitive: false, multiline: false, type: 'string', options: [], hint: '' }
    ])
    const state = Vue.reactive({
      selectedTarget: { key: 's3', schedule: true, isAvailable: true, secrets: {} },
      selectedDraft: { mode: 'push', syncInterval: 'PT2H', config: {}, secrets: {
        certificate: { action: 'keep', value: '' }, password: { action: 'keep', value: '' }
      } },
      locked: true, scheduleMode: 'custom',
      intervals: [{ value: 'custom', title: 'Custom interval' }],
      secretActions: [
        { value: 'keep', title: 'Keep saved value' },
        { value: 'replace', title: 'Replace value' },
        { value: 'clear', title: 'Clear saved value' }
      ],
      fieldGroups: [{ title: 'Configuration', hint: '', fields }],
      setSchedule: () => {}, setSecretAction: () => {}, secretValue: () => '', setSecretValue: () => {}, setField: () => {}
    })
    const { app, host } = mountFields({ setup: () => ({ ...Vue.toRefs(state), ...storageImports }), render: renderStorageFields })
    try {
      expect((nativeControl(host, 'Custom interval (ISO 8601)') as HTMLInputElement).type).toBe('text')
      for (const label of ['Custom interval (ISO 8601)', 'Notes', 'Attempts', 'Username']) {
        const control = nativeControl(host, label)
        expect(control.disabled).toBe(true)
        expectProtection(control, 'off')
      }
      expect(host.querySelector('input[type=password]')).toBeNull()
      state.selectedDraft.secrets.certificate.action = 'replace'
      state.selectedDraft.secrets.password.action = 'replace'
      await Vue.nextTick()
      expectProtection(nativeControl(host, 'New Certificate'), 'off')
      expectProtection(nativeControl(host, 'New Password'), 'new-password')
      expect(nativeControl(host, 'New Certificate').disabled).toBe(true)
      expect(nativeControl(host, 'New Password').disabled).toBe(true)
      state.locked = false
      await Vue.nextTick()
      for (const label of ['Custom interval (ISO 8601)', 'Notes', 'Attempts', 'Username', 'New Certificate', 'New Password']) {
        const control = nativeControl(host, label)
        expect(control.disabled).toBe(false)
        expectProtection(control, label === 'New Password' ? 'new-password' : 'off')
      }
      const changing = nativeControl(host, 'Username')
      changing.removeAttribute('data-1p-ignore')
      fields[4]!.type = 'number'
      await Vue.nextTick()
      expect(nativeControl(host, 'Username')).toBe(changing)
      expect((changing as HTMLInputElement).type).toBe('number')
      expectProtection(changing, 'off')
    } finally {
      app.unmount()
      host.remove()
    }
  })
})

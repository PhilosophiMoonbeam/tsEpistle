import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const { descriptor } = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath })
const script = descriptor.script?.content ?? ''

// Vuetify snapshots browser capabilities, so these imports follow the shared DOM harness.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')

/** Returns the source text of one options-API method, braces balanced. */
const methodSource = (name: string): string => {
  const start = script.indexOf(`    ${name} (`)
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

const unmounts: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  vi.restoreAllMocks()
  resetBody()
})

const escapeKey = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })

describe('Page Properties Esc', () => {
  test('binds Esc on the persistent dialog itself', () => {
    const pug = descriptor.template?.content ?? ''
    const root = pug.slice(pug.indexOf('v-dialog('), pug.indexOf(')', pug.indexOf('v-dialog(')))
    expect(root).toContain('persistent')
    expect(root).toContain("@keydown='handleDialogKeydown'")
  })

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

  test('Vuetify forwards Esc from a persistent dialog only while it is the top overlay', async () => {
    const onKeydown = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const nestedOpen = Vue.ref(false)
    const app = Vue.createApp({
      render: () => Vue.h(vuetifyComponents.VApp, null, () => Vue.h(vuetifyComponents.VDialog, { modelValue: true, persistent: true, onKeydown }, () => [
        Vue.h('button', { class: 'outer-field' }, 'Field'),
        Vue.h(vuetifyComponents.VDialog, { modelValue: nestedOpen.value }, () => Vue.h('button', { class: 'nested-field' }, 'Nested'))
      ]))
    })
    app.use(createVuetify({ components: vuetifyComponents }))
    app.mount(host)
    unmounts.push(() => { app.unmount(); host.remove() })
    await settle()
    const field = document.querySelector<HTMLElement>('.outer-field')
    if (!field) throw new Error('Dialog content did not render')
    field.focus()
    field.dispatchEvent(escapeKey())
    expect(onKeydown).toHaveBeenCalledTimes(1)

    nestedOpen.value = true
    await settle()
    // Vuetify updates its overlay stack after a frame.
    await new Promise(resolve => setTimeout(resolve, 50))
    await settle()
    field.dispatchEvent(escapeKey())
    expect(onKeydown).toHaveBeenCalledTimes(1)
  })
})

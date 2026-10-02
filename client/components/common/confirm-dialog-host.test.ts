import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'
import * as confirmDialog from './confirm-dialog.ts'

resetBody()
const Vue = await import('vue')
const filename = path.join(process.cwd(), 'client/components/common/confirm-dialog-host.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse confirm-dialog-host.vue: ${errors}`)
const compiled = compileTemplate({
  filename,
  id: 'confirm-dialog-host-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile confirm-dialog-host.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
)
const options = new Function('defineComponent', 'currentConfirmation', 'registerConfirmationHost', 'settleConfirmation', script)(
  Vue.defineComponent,
  confirmDialog.currentConfirmation,
  confirmDialog.registerConfirmationHost,
  confirmDialog.settleConfirmation
)
const Host = { ...options, render }

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

// The dialog stub renders while open and exposes the "dismiss" path Vuetify uses for Esc and outside clicks.
const DialogStub = Vue.defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(props, { attrs, emit, slots }) {
    return () =>
      props.modelValue
        ? Vue.h('div', { ...attrs, role: 'dialog' }, [
            Vue.h('button', { class: 'dismiss', type: 'button', onClick: () => emit('update:modelValue', false) }, 'Esc'),
            slots.default?.()
          ])
        : null
  }
})

let app: ReturnType<typeof Vue.createApp> | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  resetBody()
})

const mount = async (translations: Record<string, string> = {}) => {
  app = Vue.createApp(Host)
  app.component('v-dialog', DialogStub)
  for (const name of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-spacer']) app.component(name, passthrough())
  app.component('v-icon', passthrough('span'))
  app.component('v-btn', passthrough('button'))
  app.config.globalProperties.$t = (key: string, opts?: { defaultValue?: string }) => translations[key] ?? opts?.defaultValue ?? key
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await Vue.nextTick()
  return host
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.confirm-dialog__actions button')]

describe('confirm dialog host', () => {
  test('shows the request with labelled title and message, then resolves with the chosen action', async () => {
    const host = await mount()
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    const answer = confirmDialog.confirmDiscard('Discard unsaved theme changes?', 'Colors return to the saved palette.')
    await Vue.nextTick()

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    const title = host.querySelector<HTMLElement>('.confirm-dialog__title')!
    const message = host.querySelector<HTMLElement>('.confirm-dialog__message')!
    expect(title.textContent).toContain('Discard unsaved theme changes?')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id)
    expect(buttons(host).map(button => button.textContent)).toEqual(['Keep editing', 'Discard'])
    expect(buttons(host)[1].getAttribute('color')).toBe('error')

    buttons(host)[1].click()
    await expect(answer).resolves.toBe(true)
    await Vue.nextTick()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  test('dismissing the dialog keeps the draft, and the next queued request follows', async () => {
    const host = await mount({ 'common:confirm.keepEditing': 'Weiter bearbeiten' })
    const first = confirmDialog.requestConfirmation({ title: 'Leave this access review?', confirmLabel: 'Leave', cancelLabel: 'Stay' })
    const second = confirmDialog.confirmDiscard('Discard unsaved publication changes?')
    await Vue.nextTick()

    expect(buttons(host).map(button => button.textContent)).toEqual(['Stay', 'Leave'])
    expect(buttons(host)[1].getAttribute('color')).toBe('primary')
    host.querySelector<HTMLButtonElement>('.dismiss')!.click()
    await expect(first).resolves.toBe(false)
    await Vue.nextTick()

    expect(host.querySelector('.confirm-dialog__title')?.textContent).toContain('Discard unsaved publication changes?')
    expect(buttons(host)[0].textContent).toBe('Weiter bearbeiten')
    buttons(host)[0].click()
    await expect(second).resolves.toBe(false)
  })

  test('unmounting the host cancels a pending request', async () => {
    await mount()
    const pending = confirmDialog.confirmDiscard('Discard the new group draft?')
    app?.unmount()
    app = undefined
    await expect(pending).resolves.toBe(false)
  })
})

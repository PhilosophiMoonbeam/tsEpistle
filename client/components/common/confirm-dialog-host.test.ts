import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'
import * as confirmDialog from './confirm-dialog.ts'

resetBody()
// Evaluate framework browser-detection only after the shared DOM is installed;
// these imports intentionally exercise the browser module-loading boundary.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
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

// Keep Vuetify's real overlay, teleport, Escape handling and focus trap. Only
// CSS animation is disabled in this non-layout DOM; native E2E covers animation.
const settle = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
  // Vuetify publishes globalTop in a scheduled task.
  await vi.advanceTimersByTimeAsync(0)
  await Vue.nextTick()
}

let app: ReturnType<typeof Vue.createApp> | undefined
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.useRealTimers()
  resetBody()
})

const mount = async (
  translations: Record<string, string> = {},
  options: {
    nested?: boolean
    replacementOpen?: { value: boolean }
    onLeave?: (element: Element, done: () => void) => void
  } = {}
) => {
  app = Vue.createApp({
    render: () => Vue.h(components.VApp, null, () => [
      options.nested
      ? Vue.h(components.VDialog, { modelValue: true, persistent: true, 'aria-label': 'Parent review' }, () => [
          Vue.h('button', { id: 'nested-trigger', type: 'button' }, 'Reload review'),
          Vue.h(Host)
        ])
      : Vue.h(Host),
      options.replacementOpen
        ? Vue.h(components.VDialog, { modelValue: options.replacementOpen.value, persistent: true, 'aria-label': 'Replacement dialog' },
            () => Vue.h('button', { id: 'replacement-trigger', type: 'button' }, 'Continue'))
        : null
    ])
  })
  app.use(createVuetify({ components, directives, defaults: {
    VDialog: { transition: { component: Vue.Transition, css: false, onLeave: options.onLeave } }
  } }))
  app.config.globalProperties.$t = (key: string, opts?: { defaultValue?: string }) => translations[key] ?? opts?.defaultValue ?? key
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await settle()
  return document.body
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.confirm-dialog__actions button')]
const trigger = (label = 'Reload') => {
  const button = document.createElement('button')
  button.textContent = label
  document.body.append(button)
  button.focus()
  return button
}
const pressEscape = (element: HTMLElement) =>
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

describe('confirm dialog host', () => {
  test('shows the request with labelled title and message, then resolves with the chosen action', async () => {
    const host = await mount()
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    const answer = confirmDialog.confirmDiscard('Discard unsaved theme changes?', 'Colors return to the saved palette.')
    await settle()

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    const title = host.querySelector<HTMLElement>('.confirm-dialog__title')!
    const message = host.querySelector<HTMLElement>('.confirm-dialog__message')!
    expect(title.textContent).toContain('Discard unsaved theme changes?')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id)
    expect(buttons(host).map(button => button.textContent?.trim())).toEqual(['Keep editing', 'Discard'])
    expect(buttons(host)[1].classList.contains('bg-error')).toBe(true)

    buttons(host)[1].click()
    await expect(answer).resolves.toBe(true)
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  test('dismissing the dialog keeps the draft, and the next queued request follows', async () => {
    const host = await mount({ 'common:confirm.keepEditing': 'Weiter bearbeiten' })
    const first = confirmDialog.requestConfirmation({ title: 'Leave this access review?', confirmLabel: 'Leave', cancelLabel: 'Stay' })
    const second = confirmDialog.confirmDiscard('Discard unsaved publication changes?')
    await settle()

    expect(buttons(host).map(button => button.textContent?.trim())).toEqual(['Stay', 'Leave'])
    expect(buttons(host)[1].classList.contains('bg-primary')).toBe(true)
    buttons(host)[0].focus()
    pressEscape(buttons(host)[0])
    await expect(first).resolves.toBe(false)
    await settle()

    expect(host.querySelector('.confirm-dialog__title')?.textContent).toContain('Discard unsaved publication changes?')
    expect(buttons(host)[0].textContent?.trim()).toBe('Weiter bearbeiten')
    buttons(host)[0].click()
    await expect(second).resolves.toBe(false)
  })

  test('restores the captured invoking control only after the real overlay finishes leaving', async () => {
    let finishLeave: (() => void) | undefined
    const host = await mount({}, { onLeave: (_element, done) => { finishLeave = done } })
    const opener = trigger()
    const answer = confirmDialog.confirmDiscard('Discard this draft?')
    // Opening is asynchronous, so capturing focus in the host's mounted overlay
    // would incorrectly save this other control rather than the actual invoker.
    const other = trigger('Other control')
    await settle()
    buttons(host)[0].focus()
    buttons(host)[0].click()
    await expect(answer).resolves.toBe(false)
    await settle()

    expect(finishLeave).toBeDefined()
    expect(document.activeElement).not.toBe(opener)
    expect(document.activeElement).not.toBe(other)
    finishLeave!()
    await settle()
    expect(document.activeElement).toBe(opener)
  })

  test('queued requests keep focus in the dialog and cancel returns to the last actual invoker', async () => {
    const host = await mount()
    const firstOpener = trigger('First reload')
    const first = confirmDialog.confirmDiscard('First draft?')
    const secondOpener = trigger('Second reload')
    const second = confirmDialog.confirmDiscard('Second draft?')
    await settle()
    buttons(host)[0].focus()
    buttons(host)[0].click()
    await expect(first).resolves.toBe(false)
    await settle()

    expect(host.querySelector('.confirm-dialog__title')?.textContent).toContain('Second draft?')
    expect(document.activeElement).not.toBe(firstOpener)
    expect(document.activeElement).not.toBe(secondOpener)
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull()
    buttons(host)[0].focus()
    pressEscape(buttons(host)[0])
    await expect(second).resolves.toBe(false)
    await settle()
    expect(document.activeElement).toBe(secondOpener)
  })

  test('a request queued from a nested confirmation returns to the parent control, not its removed button', async () => {
    const host = await mount({}, { nested: true })
    const opener = host.querySelector<HTMLButtonElement>('#nested-trigger')!
    opener.focus()
    const first = confirmDialog.confirmDiscard('Discard review draft?')
    await settle()
    buttons(host)[0].focus()
    const second = confirmDialog.confirmDiscard('Discard another review draft?')
    buttons(host)[0].click()
    await expect(first).resolves.toBe(false)
    await settle()
    expect(document.activeElement?.closest('[aria-label="Parent review"]')).toBeNull()
    expect(host.querySelector('.confirm-dialog')?.closest('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
    buttons(host)[0].focus()
    pressEscape(buttons(host)[0])
    await expect(second).resolves.toBe(false)
    await settle()

    expect(host.querySelector('[aria-label="Parent review"]')).not.toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('a delayed close never restores focus behind a newly opened dialog', async () => {
    const replacementOpen = Vue.ref(false)
    let finishLeave: (() => void) | undefined
    const host = await mount({}, { nested: true, replacementOpen, onLeave: (_element, done) => { finishLeave = done } })
    const opener = host.querySelector<HTMLButtonElement>('#nested-trigger')!
    opener.focus()
    const answer = confirmDialog.confirmDiscard('Discard parent draft?')
    await settle()
    buttons(host)[0].focus()
    buttons(host)[0].click()
    await expect(answer).resolves.toBe(false)
    await settle()
    expect(finishLeave).toBeDefined()

    replacementOpen.value = true
    await settle()
    const replacementTrigger = host.querySelector<HTMLButtonElement>('#replacement-trigger')!
    replacementTrigger.focus()
    replacementTrigger.blur()
    finishLeave!()
    await settle()
    expect(host.querySelector('[aria-label="Replacement dialog"]')).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(document.activeElement).not.toBe(opener)
  })

  test('ignores a disconnected opener and leaves acceptance focus to the caller', async () => {
    const host = await mount()
    const removed = trigger()
    const canceled = confirmDialog.confirmDiscard('Discard removed draft?')
    await settle()
    removed.remove()
    buttons(host)[0].focus()
    pressEscape(buttons(host)[0])
    await expect(canceled).resolves.toBe(false)
    await settle()
    expect(document.activeElement).toBe(document.body)

    const opener = trigger()
    const destination = document.createElement('h1')
    destination.tabIndex = -1
    document.body.append(destination)
    const accepted = confirmDialog.confirmDiscard('Leave this page?')
    const navigation = accepted.then(confirmed => { if (confirmed) destination.focus() })
    await settle()
    buttons(host)[1].focus()
    buttons(host)[1].click()
    await expect(accepted).resolves.toBe(true)
    await navigation
    await settle()
    expect(document.activeElement).toBe(destination)
    expect(document.activeElement).not.toBe(opener)
  })

  test('unmounting the host cancels a pending request', async () => {
    await mount()
    const pending = confirmDialog.confirmDiscard('Discard the new group draft?')
    await settle()
    app?.unmount()
    app = undefined
    await expect(pending).resolves.toBe(false)
  })
})

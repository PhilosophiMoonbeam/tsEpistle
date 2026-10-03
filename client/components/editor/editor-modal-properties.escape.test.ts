import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import type { DateAdapter } from 'vuetify'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-properties.vue')
const { descriptor } = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath })
const script = descriptor.script?.content ?? ''

// Static imports cannot work here: Vuetify must snapshot capabilities after the shared DOM harness installs them.
const Vue = await import('vue')
const { createVuetify, useDate } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')

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
  dateAdapter: DateAdapter
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
  unmounts.push(() => { app.unmount(); host.remove() })
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

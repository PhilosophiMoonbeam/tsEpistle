import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import type { App } from 'vue'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { WikiSource } from '../../../shared/wiki-source.ts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { createCitedCopyPayload } from '../../helpers/cited-copy.ts'
import { translateEnglish } from '../../test/english-translate.mts'

// Load the production setup/template after the shared test document exists.
const Vue = await import('vue')
Bun.plugin({
  name: 'cited-copy-authority-regression',
  setup(builder) {
    builder.onLoad({ filter: /\/cited-copy-action\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const compiled = compileScript(parsed.descriptor, {
        id: path.basename(filename, '.vue'),
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
  }
})
const componentPath = path.resolve('client/components/common/cited-copy-action.vue')
const CitedCopyAction = (await import(componentPath)).default
const previousClipboard = Object.getOwnPropertyDescriptor(browserWindow.navigator, 'clipboard')
const previousLocation = browserWindow.location.href
let app: App | null = null

const settle = async (): Promise<void> => {
  for (let n = 0; n < 4; n++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = null
  if (previousClipboard) Object.defineProperty(browserWindow.navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(browserWindow.navigator, 'clipboard')
  setLocation(previousLocation)
  resetBody()
  vi.restoreAllMocks()
})

describe('Cited copy byte policy', () => {
  const source: WikiSource = {
    id: 71,
    locale: 'fr',
    path: 'guide/Café #?%',
    title: 'Contract',
    description: '',
    visibility: 'private',
    updatedAt: '2026-10-27T00:00:00.000Z',
    sourceRevision: '1',
    excerpt: 'Current authorized passage',
    excerptTruncated: false
  }
  const context = { origin: 'https://wiki.example' }

  it('preserves source layout and Unicode bytes with an encoded canonical private citation', () => {
    setLocation('https://wiki.example/en/contract?token=not-for-copy#selection')
    const text = '\tHeading\r\n  • Café\n|العربية|🧭|\tend\r'
    const citationHref = 'https://wiki.example/_private/fr/guide/Caf%C3%A9%20%23%3F%25#part%3A%E7%B2%BE'
    expect(createCitedCopyPayload({ text, source, context, blockAnchor: 'part:精' })).toEqual({
      text: `${text}\n\n${citationHref}`,
      citationHref
    })
  })

  it('rejects exactly the forbidden control and invisible ranges in text and locators', () => {
    setLocation(context.origin)
    for (const [first, last] of [
      [0x00, 0x08],
      [0x0b, 0x0c],
      [0x0e, 0x1f],
      [0x7f, 0x9f],
      [0x200b, 0x200b],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff]
    ] as const) {
      for (let code = first; code <= last; code++) {
        const text = `before${String.fromCharCode(code)}after`
        expect(() => createCitedCopyPayload({ text, source, context })).toThrow('invalid-text')
        expect(() => createCitedCopyPayload({ text: 'Visible', source: { ...source, path: text }, context })).toThrow('invalid-source')
        expect(() => createCitedCopyPayload({ text: 'Visible', source, context, blockAnchor: text })).toThrow('invalid-source')
      }
    }
    for (const character of ['\t', '\n', '\r']) {
      const locator = `before${character}after`
      expect(() => createCitedCopyPayload({ text: 'Visible', source: { ...source, path: locator }, context })).toThrow('invalid-source')
      expect(() => createCitedCopyPayload({ text: 'Visible', source, context, blockAnchor: locator })).toThrow('invalid-source')
    }
  })

  it('admits layout controls and Unicode immediately outside the excluded ranges without changing text', () => {
    setLocation(context.origin)
    for (const code of [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0xa0, 0x200a, 0x200c, 0x2029, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff00]) {
      const text = `before${String.fromCharCode(code)}after`
      expect(createCitedCopyPayload({ text, source, context }).text).toBe(`${text}\n\nhttps://wiki.example/_private/fr/guide/Caf%C3%A9%20%23%3F%25`)
    }
  })
})

describe('Cited copy authority', () => {
  it('ignores superseded and revoked clipboard completions, admits the next current copy, and retires pending work on unmount', async () => {
    resetBody()
    setLocation('https://wiki.example/en/contract')
    const writes: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
    Object.defineProperty(browserWindow.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => {
          const write = Promise.withResolvers<void>()
          writes.push(write)
          return write.promise
        }
      }
    })
    const source: WikiSource = {
      id: 71,
      locale: 'en',
      path: 'contract',
      title: 'Contract',
      description: '',
      visibility: 'public',
      updatedAt: '2026-10-27T00:00:00.000Z',
      sourceRevision: '1',
      excerpt: 'Current authorized passage',
      excerptTruncated: false
    }
    const props = Vue.reactive({
      text: 'Current authorized passage',
      source,
      identity: 'owner-a:en:1',
      disabled: false,
      context: { origin: browserWindow.location.origin },
      blockAnchor: 'contract-clause',
      hintId: 'authority-copy-hint'
    })
    const copied = vi.fn()
    const failed = vi.fn()
    const host = document.createElement('div')
    host.className = 'wiki-cited-copy-owner'
    host.dataset.citedCopyOwner = 'authority-regression'
    document.body.append(host)
    app = Vue.createApp({ render: () => Vue.h(CitedCopyAction, { ...props, onCopied: copied, onFailed: failed }) })
    app.config.globalProperties.$t = translateEnglish
    app.component('v-icon', { render: () => null })
    app.mount(host)
    await settle()
    const button = (): HTMLButtonElement => host.querySelector('button')!
    const state = (): string | null | undefined => host.querySelector('.cited-copy-action')?.getAttribute('data-copy-state')
    expect(button().getAttribute('aria-describedby')).toBe('authority-copy-hint')
    expect(host.querySelector('#authority-copy-hint')).not.toBeNull()

    button().click()
    await settle()
    expect(state()).toBe('copying')
    props.identity = 'owner-b:ar:2'
    props.source = { ...source, locale: 'ar', sourceRevision: '2' }
    await settle()
    expect(state()).toBe('idle')
    button().click()
    await settle()
    writes[0]!.resolve()
    await settle()
    expect(state()).toBe('copying')
    expect(copied).not.toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    expect(host.querySelector('.wiki-cited-copy-sweep')).toBeNull()

    props.disabled = true
    await settle()
    writes[1]!.resolve()
    await settle()
    expect(button().disabled).toBe(true)
    expect(state()).toBe('idle')
    expect(copied).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()

    props.disabled = false
    await settle()
    button().click()
    await settle()
    writes[2]!.resolve()
    await settle()
    expect(state()).toBe('copied')
    expect(copied).toHaveBeenCalledTimes(1)
    expect(copied).toHaveBeenCalledWith({
      identity: 'owner-b:ar:2',
      citationHref: 'https://wiki.example/ar/contract#contract-clause'
    })

    button().click()
    await settle()
    expect(state()).toBe('copying')
    app.unmount()
    app = null
    writes[3]!.resolve()
    await settle()
    expect(copied).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(host.querySelector('.cited-copy-action')).toBeNull()
    expect(host.querySelector('.wiki-cited-copy-sweep')).toBeNull()
  })
})

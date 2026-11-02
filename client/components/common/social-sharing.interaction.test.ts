import fs from 'node:fs'
import { babelParse, compileTemplate, parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { createVuetify } from 'vuetify'
import { VBtn, VIcon, VList, VListItem, VListItemTitle } from 'vuetify/components'

const filename = new URL('./social-sharing.vue', import.meta.url).pathname
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
if (!descriptor.script || !descriptor.template) throw new Error('Sharing component script or template missing')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import .*$/gm, '').replace('export default defineComponent(', 'return defineComponent(')
)
const compiled = compileTemplate({
  source: descriptor.template.content,
  filename,
  id: 'social-sharing-interaction',
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function', expressionPlugins: ['typescript'] }
})
if (compiled.errors.length) throw compiled.errors[0]
const render = new Function('Vue', compiled.code)(Vue)
const notifications: Array<{ style: string; message: string }> = []
const component = new Function('defineComponent', 'wikiStore', 'translate', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', executable)(
  Vue.defineComponent,
  { showNotification: (notification: { style: string; message: string }) => notifications.push(notification) },
  (key: string) => key,
  browserWindow,
  document,
  browserWindow.navigator,
  browserWindow.HTMLElement,
  browserWindow.HTMLInputElement
) as Vue.ComponentOptions
const Sharing = { ...component, render }
const readerFilename = new URL('../../themes/default/components/page.vue', import.meta.url).pathname
const readerScript = parse(fs.readFileSync(readerFilename, 'utf8'), { filename: readerFilename }).descriptor.script?.content
if (!readerScript) throw new Error('Reader component script missing')
const readerExport = babelParse(readerScript, { sourceType: 'module', plugins: ['typescript'] }).program.body.find(
  node => node.type === 'ExportDefaultDeclaration'
)
const readerOptions = readerExport?.declaration.type === 'CallExpression' ? readerExport.declaration.arguments[0] : null
const readerComputed =
  readerOptions?.type === 'ObjectExpression'
    ? readerOptions.properties.find(node => node.type === 'ObjectProperty' && node.key.type === 'Identifier' && node.key.name === 'computed')
    : null
if (readerComputed?.type !== 'ObjectProperty' || readerComputed.value.type !== 'ObjectExpression') throw new Error('Reader computed options missing')
const readerAdmission = readerComputed.value.properties.find(
  node => node.type === 'ObjectMethod' && node.key.type === 'Identifier' && node.key.name === 'publicSharingContextEligible'
)
if (readerAdmission?.type !== 'ObjectMethod' || readerAdmission.start == null || readerAdmission.end == null)
  throw new Error('Reader sharing admission missing')
const readerSharingEligible = new Function(
  new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `return ({${readerScript.slice(readerAdmission.start, readerAdmission.end)}}).publicSharingContextEligible`
  )
)() as (this: Record<string, unknown>) => boolean
const restorations: Array<() => void> = []
const cleanups: Array<() => void> = []
const override = (target: object, key: string, value: unknown): void => {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  restorations.push(() => {
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  })
}
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}
type SharingInstance = Vue.ComponentPublicInstance & {
  shareNative: () => Promise<void>
  openSocialPop: (url: string) => void
}
const mountSharing = (props: Record<string, unknown> = {}, readerContext?: Record<string, unknown>) => {
  const state = Vue.reactive<Record<string, unknown>>({ url: 'https://wiki.example/en/guide', title: 'Field guide', ...props })
  const host = document.createElement('div')
  document.body.append(host)
  const sharing = Vue.shallowRef<SharingInstance | null>(null)
  const app = Vue.createApp({
    render: () =>
      Vue.h(Sharing, {
        ...state,
        ...(readerContext ? { publicContextEligible: readerSharingEligible.call(readerContext) } : {}),
        ref: sharing
      })
  })
  app.config.globalProperties.$t = (key: string) => key
  app.use(createVuetify({ components: { VBtn, VIcon, VList, VListItem, VListItemTitle } }))
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.includes(label))
    if (!found) throw new Error(`Sharing action missing: ${label}`)
    return found
  }
  if (!sharing.value) throw new Error('Sharing component instance was not mounted')
  return { host, state, button, instance: sharing.value }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const restore of restorations.splice(0).reverse()) restore()
  notifications.splice(0)
  resetBody()
})

describe('sharing clipboard actions', () => {
  it('copies a credential/query-free canonical URL, escaped Markdown and an encoded current section without moving focus', async () => {
    const clipboard = vi.fn(async (_value: string) => {})
    override(browserWindow.navigator, 'clipboard', { writeText: clipboard })
    const { host, button } = mountSharing({
      url: 'https://user:secret@wiki.example/en/guide(part)?token=secret#old',
      title: 'A [guide]\n(next)',
      sectionAnchor: 'café / 50%'
    })
    const input = host.querySelector<HTMLInputElement>('input')!
    input.focus()
    expect(input.value).toBe('https://wiki.example/en/guide(part)')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    for (const [label, expected] of [
      ['common:socialSharing.copyLink', 'https://wiki.example/en/guide(part)'],
      ['common:socialSharing.copyMarkdownLink', '[A \\[guide\\] \\(next\\)](https://wiki.example/en/guide%28part%29)'],
      ['common:socialSharing.copyCurrentSectionLink', 'https://wiki.example/en/guide(part)#caf%C3%A9%20%2F%2050%25']
    ]) {
      const action = button(label!)
      action.focus()
      action.click()
      await settle()
      expect(clipboard.mock.calls.at(-1)?.[0]).toBe(expected)
      expect(document.activeElement).toBe(action)
      expect(host.querySelector('[role="status"]')?.textContent).not.toBe('')
    }
  })

  it.each(['javascript:alert(1)', 'data:text/plain,guide', 'ftp://wiki.example/en/guide', 'http://[', ''])(
    'rejects invalid or non-HTTP URLs at every sharing boundary (%s)',
    async url => {
      const clipboard = vi.fn(async (_value: string) => {})
      const nativeShare = vi.fn(async () => {})
      const openWindow = vi.fn(() => null)
      override(browserWindow.navigator, 'clipboard', { writeText: clipboard })
      override(browserWindow.navigator, 'share', nativeShare)
      override(browserWindow.navigator, 'canShare', () => true)
      override(browserWindow, 'open', openWindow)
      override(browserWindow, 'siteConfig', { publicSocialSharing: true })
      const { host, state, button, instance } = mountSharing({ url, sectionAnchor: 'chapter', publicContextEligible: true })
      const copyLink = button('common:socialSharing.copyLink')
      expect(copyLink.disabled).toBe(true)
      copyLink.click()
      for (const label of ['copyMarkdownLink', 'copyCurrentSectionLink']) {
        const action = button(`common:socialSharing.${label}`)
        // VListItem consumes disabled rather than forwarding a native button attribute.
        expect(action.getAttribute('aria-disabled')).toBe('true')
        expect(action.tabIndex).toBe(-1)
        action.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      const email = [...host.querySelectorAll('.v-list-item')].find(element => element.textContent?.includes('common:socialSharing.shareViaEmail'))!
      expect(email.getAttribute('aria-disabled')).toBe('true')
      expect(email.hasAttribute('href')).toBe(false)
      expect(host.querySelector('a[href]')).toBeNull()
      expect(host.textContent?.includes('Facebook')).toBe(false)
      expect([...host.querySelectorAll('button')].some(element => element.textContent?.trim() === 'common:socialSharing.share')).toBe(false)
      await instance.shareNative()
      instance.openSocialPop('https://www.facebook.com/sharer/sharer.php')
      await settle()
      expect(clipboard).not.toHaveBeenCalled()
      expect(nativeShare).not.toHaveBeenCalled()
      expect(openWindow).not.toHaveBeenCalled()
      state.url = 'https://wiki.example/en/next#old'
      state.sectionAnchor = ''
      await Vue.nextTick()
      expect(button('common:socialSharing.copyLink').disabled).toBe(false)
      expect(button('common:socialSharing.copyCurrentSectionLink').getAttribute('aria-disabled')).toBe('true')
      expect(host.querySelector('a[href^="mailto:"]')).not.toBeNull()
    }
  )

  it('reports clipboard failure and restores focus after a rejected legacy fallback', async () => {
    override(browserWindow.navigator, 'clipboard', {
      writeText: async () => {
        throw new Error('Permission denied')
      }
    })
    override(document, 'execCommand', () => false)
    const { host, button } = mountSharing()
    const action = button('common:socialSharing.copyLink')
    action.focus()
    action.click()
    await settle()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('common:socialSharing.failedCopyClipboard')
    expect(notifications.map(notification => notification.style)).toEqual(['red'])
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(action)
  })

  it.each([false, true])('retires pending clipboard feedback and fallback on page change or unmount (rejected: %s)', async rejected => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const clipboard = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    override(browserWindow.navigator, 'clipboard', { writeText: clipboard })
    const legacyCopy = vi.fn(() => true)
    override(document, 'execCommand', legacyCopy)
    const { host, state, button } = mountSharing()
    button('common:socialSharing.copyLink').click()
    state.url = 'https://wiki.example/en/replacement'
    await Vue.nextTick()
    if (rejected) first.reject(new Error('Clipboard denied after navigation'))
    else first.resolve()
    await settle()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    expect(notifications).toHaveLength(0)
    button('common:socialSharing.copyLink').click()
    cleanups.pop()!()
    if (rejected) second.reject(new Error('Clipboard denied after unmount'))
    else second.resolve()
    await settle()
    expect(notifications).toHaveLength(0)
    expect(legacyCopy).not.toHaveBeenCalled()
  })
})

describe('public sharing admission', () => {
  it('removes rendered provider, app and native destinations when anonymous proof is denied or absent, retaining access-aware sharing', async () => {
    const clipboard = vi.fn(async (_value: string) => {})
    override(browserWindow.navigator, 'clipboard', { writeText: clipboard })
    override(browserWindow.navigator, 'share', async () => {})
    override(browserWindow.navigator, 'canShare', () => true)
    override(browserWindow, 'siteConfig', { publicSocialSharing: true })
    const container = document.createElement('article')
    const reader = Vue.reactive<Record<string, unknown>>({
      publicSharingEligible: true,
      visibility: 'public',
      currentPublicationEligible: true,
      pageTransportVerified: true,
      readingReaderAuthority: 'current-admin-reader',
      readingContentAuthority: 'current-admin-reader',
      readingContentKey: 'current-content',
      readingAdmittedContentKey: 'current-content',
      readingContentNode: Vue.markRaw(container),
      $refs: { container: Vue.markRaw(container) },
      offlineDisposed: false,
      navigationPending: false,
      printView: false,
      selectedPageView: 'article'
    })
    const { host, button } = mountSharing({ sectionAnchor: 'chapter' }, reader)
    for (const proof of [true, false, undefined, true]) {
      reader.publicSharingEligible = proof
      await settle()
      for (const provider of ['Facebook', 'LinkedIn', 'Reddit', 'Telegram', 'X', 'Weibo', 'WhatsApp']) {
        expect([...host.querySelectorAll('button')].some(element => element.textContent?.trim() === provider)).toBe(proof === true)
      }
      expect(host.querySelector('a[href^="viber:"]') !== null).toBe(proof === true)
      expect([...host.querySelectorAll('button')].some(element => element.textContent?.trim() === 'common:socialSharing.share')).toBe(proof === true)
      expect(button('common:socialSharing.copyLink').disabled).toBe(false)
      expect(button('common:socialSharing.copyMarkdownLink').disabled).toBe(false)
      expect(button('common:socialSharing.copyCurrentSectionLink').disabled).toBe(false)
      expect(host.querySelector('a[href^="mailto:"]')).not.toBeNull()
      button('common:socialSharing.copyLink').click()
      await settle()
      expect(clipboard.mock.calls.at(-1)?.[0]).toBe('https://wiki.example/en/guide')
    }
  })

  it('requires explicit site policy and eligible online context for native and public destinations, while retaining private copy', async () => {
    override(browserWindow.navigator, 'share', async () => {})
    override(browserWindow.navigator, 'canShare', () => true)
    for (const policy of [undefined, false, true]) {
      override(browserWindow, 'siteConfig', { publicSocialSharing: policy })
      for (const publicContextEligible of [false, true]) {
        for (const offline of [false, true]) {
          const { host, button } = mountSharing({ publicContextEligible, offline })
          const admitted = policy === true && publicContextEligible && !offline
          expect(host.textContent?.includes('Facebook')).toBe(admitted)
          expect([...host.querySelectorAll('button')].some(element => element.textContent?.trim() === 'common:socialSharing.share')).toBe(admitted)
          expect(button('common:socialSharing.copyLink').disabled).toBe(false)
          cleanups.pop()!()
        }
      }
    }
  })
})

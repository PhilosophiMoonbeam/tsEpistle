import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import type { ComponentOptions } from 'vue'
import { afterEach, describe, expect, it, vi, type Mock } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import * as contracts from '../../../shared/content-extensions.ts'

// Vuetify snapshots DOM capabilities; static imports would run before the browser harness installs them.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const filename = join(process.cwd(), 'client/components/editor/editor-modal-blocks.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
const script = compileScript(descriptor, { id: 'content-extension-authoring', genDefaultAs: 'component' })
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.content.replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, ''))
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'content-extension-authoring', preprocessLang: 'pug', preprocessOptions: { doctype: 'html' }, compilerOptions: { mode: 'function', expressionPlugins: ['typescript'] } })
if (template.errors.length) throw template.errors[0]
const renderFactory = new Bun.Transpiler({ loader: 'ts' }).transformSync(`function renderTemplate(Vue) {\n${template.code}\n}`)
const render = new Function('Vue', `${renderFactory}\nreturn renderTemplate(Vue)`)(Vue)
const unmounts: Array<() => void> = []
afterEach(() => {
  unmounts.splice(0).forEach(unmount => { unmount() })
  resetBody()
})

type Modal = {
  selectedKey: string
  isLoading: boolean
  canSubmit: boolean
  canInsertActive: boolean
  index: { showUpdatedAt: boolean }
  youtube: { url: string; title: string; start: number }
  insertExtension: () => void
}
const mountModal = async (key: 'index' | 'youtube', enabled = true) => {
  const wikiStore = Vue.reactive({ user: { authenticated: true, id: 1 }, offlineIdentityEpoch: 0, page: { id: 1, locale: 'en', path: 'guide/page' }, editor: { activeModal: 'editorModalBlocks', editorKey: 'markdown' } })
  const insert = vi.fn()
  const fetchContentExtensions = async () => ({ hostVersion: 1, extensions: contracts.BUILTIN_CONTENT_EXTENSIONS.map(definition => ({ ...definition, isEnabled: enabled, compatible: true, diagnostic: null })) })
  const component = new Function('defineComponent', 'markRaw', 'wikiStore', 'emitEditorInsert', 'fetchContentExtensions', 'KROKI_DIAGRAM_TYPES', 'LINKS_GRID_ICONS', 'LINKS_GRID_STARTER', 'parseContentExtensionEnvelope', 'serializeContentExtensionFence', 'parseYoutubeContentExtensionSource', `${executable}\nreturn component`)(Vue.defineComponent, Vue.markRaw, wikiStore, insert, fetchContentExtensions, contracts.KROKI_DIAGRAM_TYPES, contracts.LINKS_GRID_ICONS, contracts.LINKS_GRID_STARTER, contracts.parseContentExtensionEnvelope, contracts.serializeContentExtensionFence, contracts.parseYoutubeContentExtensionSource) as ComponentOptions
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp({ ...component, render })
  app.use(createVuetify({ components, directives }))
  app.config.globalProperties.$t = translateEnglish
  const modal = app.mount(host) as unknown as Modal
  unmounts.push(() => app.unmount())
  await vi.waitFor(() => expect(modal.isLoading).toBe(false))
  modal.selectedKey = key
  await Vue.nextTick()
  return { modal, insert, wikiStore }
}

const insertedEnvelope = (insert: Mock<(payload: { text: string }) => void>) => {
  expect(insert).toHaveBeenCalledTimes(1)
  const text = insert.mock.calls[0][0].text
  const envelope = contracts.parseContentExtensionFence(text.split('\n')[1]!)
  return envelope
}

describe('native extension authoring', () => {
  it('exposes a labelled default-off checkbox and round trips its selected date option', async () => {
    const { modal, insert } = await mountModal('index')
    expect(modal.index.showUpdatedAt).toBe(false)
    await vi.waitFor(() => expect([...document.querySelectorAll('label')].some(label => label.textContent === 'Show last-updated dates')).toBe(true))
    const label = [...document.querySelectorAll('label')].find(label => label.textContent === 'Show last-updated dates')!
    expect(label).toBeDefined()
    const checkbox = document.getElementById(label.htmlFor) as HTMLInputElement
    expect(checkbox.type).toBe('checkbox')
    checkbox.focus()
    expect(document.activeElement).toBe(checkbox)
    checkbox.click()
    await Vue.nextTick()
    expect(modal.index.showUpdatedAt).toBe(true)
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Vue.nextTick()
    expect(insertedEnvelope(insert)).toMatchObject({ key: 'index', version: 1, props: { showUpdatedAt: true } })
  })

  it.each([
    ['https://youtube.com/playlist?list=PL_native_123&t=12s', 2, { source: { kind: 'playlist', playlistId: 'PL_native_123' } }],
    ['https://youtu.be/abc123_DEF?list=PL_native_123&t=12s', 2, { source: { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' } }],
    ['abc123_DEF', 1, { videoId: 'abc123_DEF' }]
  ])('authors a canonical typed source from %s', async (url, version, sourceProps) => {
    const { modal, insert } = await mountModal('youtube')
    modal.youtube.url = url
    modal.youtube.title = 'Reader player'
    await Vue.nextTick()
    expect(modal.canSubmit).toBe(true)
    expect(modal.youtube.start).toBe(url.includes('t=12s') ? 12 : 0)
    modal.insertExtension()
    expect(insertedEnvelope(insert)).toMatchObject({ key: 'youtube', version, props: { ...sourceProps, title: 'Reader player', start: modal.youtube.start } })
  })

  it.each([false, true])('refuses disabled or invalid authoring without losing the input (%s)', async enabled => {
    const { modal, insert } = await mountModal('youtube', enabled)
    const url = enabled ? 'https://youtube.com.evil.test/playlist?list=PL_native_123' : 'https://youtube.com/playlist?list=PL_native_123'
    modal.youtube.url = url
    await Vue.nextTick()
    modal.insertExtension()
    expect(insert).not.toHaveBeenCalled()
    expect(modal.youtube.url).toBe(url)
    expect(enabled ? modal.canSubmit : modal.canInsertActive).toBe(false)
  })
})

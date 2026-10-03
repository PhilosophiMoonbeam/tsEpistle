import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import type { ComponentOptions } from 'vue'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { createModalFocusScope } from '../common/modal-focus-scope.ts'
import { isRecord } from '../../helpers/type-guards.ts'
import { TextEditor } from './common/text-editor.ts'
import { EditorAdapterController } from './common/editor-adapter.ts'
import { decodeBase64Text } from '../../helpers/base64.ts'
import { EditorView, keymap } from '@codemirror/view'
import { html } from '@codemirror/lang-html'
import _ from 'lodash'

import { translateEnglish } from '../../test/english-translate.mts'
;globalThis.useTranslate = () => translateEnglish
const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-drawio.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''

// Vuetify snapshots browser capabilities, so these imports follow the shared DOM harness.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const compiledTemplate = compileTemplate({
  source: template,
  filename: componentPath,
  id: 'drawio-modal-contract',
  preprocessLang: descriptor.template?.lang,
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw compiledTemplate.errors[0]
const render = new Function('Vue', compiledTemplate.code)(Vue)
const asyncStatePath = join(process.cwd(), 'client/components/common/async-state.vue')
const asyncStateDescriptor = parse(readFileSync(asyncStatePath, 'utf8'), { filename: asyncStatePath }).descriptor
const asyncStateScript = compileScript(asyncStateDescriptor, { id: 'drawio-async-state', genDefaultAs: 'component' })
const asyncStateTemplate = compileTemplate({
  source: asyncStateDescriptor.template!.content,
  filename: asyncStatePath,
  id: 'drawio-async-state',
  compilerOptions: { mode: 'function' }
})
if (asyncStateTemplate.errors.length > 0) throw asyncStateTemplate.errors[0]
const AsyncState = new Function('Vue', new Bun.Transpiler({ loader: 'ts' }).transformSync(
  asyncStateScript.content.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g, (_match, bindings: string) =>
    `const {${bindings.replace(/\bas\b/g, ':')}} = Vue;`)
) + '\nreturn component')(Vue)
AsyncState.render = new Function('Vue', asyncStateTemplate.code)(Vue)

const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[^\n]*(?:\n|$)/gm, '').replace('export default defineComponent(', 'const component = defineComponent(')
)
const evaluateComponent = new Function('defineComponent', 'wikiStore', 'emitEditorInsert', 'isRecord', 'AsyncState', 'createModalFocusScope',
  `${executable}\nreturn component`) as (...dependencies: unknown[]) => ComponentOptions
type DrawioContext = {
  loading: boolean
  loadError: string
  loadTimer: unknown | null
  diagramXml: string | null
  startLoadTimer: () => void
  close: () => void
  send: (message: unknown) => void
  receive: (event: MessageEvent) => void
}
const mountedApps: Array<() => void> = []
const makeComponent = () => {
  const wikiStore = {
    editor: { activeModal: 'editorModalDrawio', activeModalData: '<mxfile>local diagram</mxfile>' as string | null },
    page: { title: 'Diagram page' }
  }
  const insert = vi.fn()
  const component = evaluateComponent(Vue.defineComponent, wikiStore, insert, isRecord, AsyncState, createModalFocusScope)
  return { component, wikiStore, insert }
}
const mountModal = () => {
  const harness = makeComponent()
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp({ ...harness.component, render })
  const mountErrors: unknown[] = []
  app.config.errorHandler = error => { mountErrors.push(error) }
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  const context = app.mount(host) as unknown as DrawioContext
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  for (const element of host.querySelectorAll<HTMLElement>('*')) {
    element.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
  }
  return { ...harness, context, host, mountErrors, unmount }
}
const settle = async () => {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetBody()
})

const loadSourceEditor = (variant: 'code' | 'asciidoc' | 'markdown', wikiStore: object) => {
  const filename = join(process.cwd(), `client/components/editor/editor-${variant}.vue`)
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
  const script = descriptor.script!.content
    .replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, '')
    .replace('export default defineComponent(', 'const component = defineComponent(')
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script)
  const dependencies = {
    defineComponent: Vue.defineComponent, markRaw: Vue.markRaw, wikiStore,
    TextEditor, EditorAdapterController, decodeBase64Text, EditorView, keymap, html, _,
    HTMLElement: browserWindow.HTMLElement, require,
    Velocity: () => {}, markdownHelp: {}, vRovingToolbar: {},
    onEditorInsert: () => {}, onEditorSaveConflict: () => {}, onEditorContentOverwrite: () => {}
  }
  return new Function(...Object.keys(dependencies), `${executable}\nreturn component`)(
    ...Object.values(dependencies)
  )
}

describe('Source document authoring contract', () => {
  for (const variant of ['code', 'asciidoc'] as const) {
    for (const incoming of ['distinctive template payload\nsecond line', ' ', '']) {
      test(`${variant} mounts the incoming template and seeds only an empty create document (${JSON.stringify(incoming)})`, () => {
        const wikiStore = { editor: { content: incoming, editorKey: '' } }
        const component = loadSourceEditor(variant, wikiStore)
        const host = document.body.appendChild(document.createElement('div'))
        const context = {
          ...component.data.call({}),
          mode: 'create', $refs: { cm: host }, $vuetify: { theme: { current: { dark: false } } },
          $t: translateEnglish, $emit: () => {}, processContent: () => {}, positionSync: () => {}
        }
        try {
          component.mounted.call(context)
          const expected = incoming || translateEnglish(variant === 'code'
            ? 'editor:editorCode.h1TitleH1P' : 'editor:editorAsciidoc.headerContent')
          expect(context.cm.getValue()).toBe(expected)
          expect(context.editorAdapter.capture().text).toBe(expected)
          expect(wikiStore.editor.content).toBe(expected)
        } finally {
          context.editorAdapter?.destroy()
          context.cm?.destroy()
          context.debouncedProcessContent?.cancel()
          host.remove()
        }
      })
    }
  }

  for (const variant of ['markdown', 'asciidoc'] as const) {
    test(`${variant} edits each diagram without replacing intervening prose or the other diagram`, () => {
      const first = btoa('<mxfile>first</mxfile>')
      const second = btoa('<mxfile>second</mxfile>')
      const initial = ['```diagram', first, '```', 'Distinctive intervening prose', '```diagram', second, '```'].join('\n')
      const wikiStore = { editor: { activeModalData: '' }, showNotification: vi.fn() }
      const component = loadSourceEditor(variant, wikiStore)
      const host = document.body.appendChild(document.createElement('div'))
      const editor = new TextEditor({ parent: host, value: initial, ariaLabel: 'Diagram source', dark: false })
      let markers: Parameters<TextEditor['setMarkers']>[0] = []
      const setMarkers = vi.spyOn(editor, 'setMarkers').mockImplementation(value => { markers = value })
      const toggleModal = vi.fn()
      try {
        const context = { cm: editor, editor: () => editor, $t: translateEnglish, toggleModal }
        component.methods.processMarkers.call(context, 0, editor.lineCount)
        expect(markers).toHaveLength(2)
        markers[0]!.action(new browserWindow.Event('click'))
        expect(wikiStore.editor.activeModalData).toBe('<mxfile>first</mxfile>')
        editor.replaceSelection(['```diagram', btoa('<mxfile>updated first</mxfile>'), '```'].join('\n'))
        expect(editor.getValue()).toBe([
          '```diagram', btoa('<mxfile>updated first</mxfile>'), '```',
          'Distinctive intervening prose', '```diagram', second, '```'
        ].join('\n'))
        markers[1]!.action(new browserWindow.Event('click'))
        expect(wikiStore.editor.activeModalData).toBe('<mxfile>second</mxfile>')
        expect(toggleModal).toHaveBeenCalledTimes(2)
        expect(wikiStore.showNotification).not.toHaveBeenCalled()
      } finally {
        setMarkers.mockRestore()
        editor.destroy()
        host.remove()
      }
    })
  }
})

describe('Draw.io editor modal contract', () => {

  test('clears the live load timer and returns to the editor when closed', async () => {
    vi.useFakeTimers()
    const { component, wikiStore } = makeComponent()
    const context = {
      ...component.data!.call({} as never, {} as never),
      $nextTick: (callback: () => void) => Promise.resolve().then(callback)
    } as unknown as DrawioContext
    for (const [name, method] of Object.entries(component.methods!)) {
      Reflect.set(context, name, method.bind(context))
    }
    context.startLoadTimer()
    expect(context.loadTimer).not.toBeNull()

    context.close()
    expect(wikiStore.editor.activeModal).toBe('')
    expect(context.loadTimer).toBeNull()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(context.loadError).toBe('')
  })

  test('enforces the trusted diagrams.net send and receive boundary', async () => {
    const { component, wikiStore, insert } = makeComponent()
    const host = document.body.appendChild(document.createElement('div'))
    // Isolate the message protocol from focus installation; the lifecycle runs unchanged in the focus case below.
    const app = Vue.createApp({ ...component, mounted: undefined, render })
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.config.globalProperties.$t = translateEnglish
    const context = app.mount(host) as unknown as DrawioContext
    mountedApps.push(() => { app.unmount(); host.remove() })
    await settle()
    const frame = host.querySelector('iframe')!
    const embedUrl = new URL(frame.src)
    expect(embedUrl.origin).toBe('https://embed.diagrams.net')
    expect(Object.fromEntries(embedUrl.searchParams)).toMatchObject({
      embed: '1', proto: 'json', spin: '1', saveAndExit: '1', noSaveBtn: '1', noExitBtn: '0'
    })
    const frameWindow = frame.contentWindow!
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {})
    const exportMessage = { action: 'export', format: 'xmlsvg' }
    context.send(exportMessage)
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify(exportMessage), embedUrl.origin)

    const exportData = JSON.stringify({ event: 'export', data: 'data:image/svg+xml;base64,ZGlhZ3JhbQ==' })
    const receive = (origin: string, source: Window) => context.receive(new document.defaultView!.MessageEvent('message', {
      origin, source, data: exportData
    }))
    receive('https://attacker.example', frameWindow)
    expect(insert).not.toHaveBeenCalled()
    expect(wikiStore.editor.activeModal).toBe('editorModalDrawio')
    receive(embedUrl.origin, browserWindow)
    expect(insert).not.toHaveBeenCalled()
    expect(wikiStore.editor.activeModal).toBe('editorModalDrawio')
    receive(embedUrl.origin, frameWindow)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith({ kind: 'DIAGRAM', text: 'ZGlhZ3JhbQ==' })
    expect(wikiStore.editor.activeModal).toBe('')
    postMessage.mockRestore()
  })

  test('mounts the actual modal with accessible labels, iframe focus, Escape, and focus restoration', async () => {
    const background = document.body.appendChild(document.createElement('main'))
    background.setAttribute('aria-hidden', 'false')
    const trigger = background.appendChild(document.createElement('button'))
    trigger.textContent = 'Open diagram editor'
    trigger.focus()
    const mounted = mountModal()
    await settle()
    expect(mounted.mountErrors).toEqual([])
    const dialog = mounted.host.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')
    expect(title).not.toBeNull()
    expect(dialog.contains(title)).toBe(true)
    expect(title?.textContent?.trim()).not.toBe('')
    const closeButton = dialog.querySelector<HTMLButtonElement>('button')!
    expect((closeButton.getAttribute('aria-label') ?? '').trim()).not.toBe('')
    expect(background.inert).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(closeButton)
    closeButton.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true
    }))
    expect(document.activeElement).toBe(dialog.querySelector('iframe'))
    closeButton.focus()
    closeButton.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(mounted.wikiStore.editor.activeModal).toBe('')
    mounted.unmount()
    await settle()
    expect(background.inert).toBe(false)
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  test('redirects a frame exit only for the live topmost modal and ignores stale exits after disposal', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.focus()
    const mounted = mountModal()
    await settle()
    const dialog = mounted.host.querySelector<HTMLElement>('[role="dialog"]')!
    const back = dialog.querySelector<HTMLButtonElement>('button')!
    const boundary = dialog.querySelector<HTMLElement>('[aria-hidden="true"][tabindex="0"]')!
    boundary.focus()
    expect(document.activeElement).toBe(back)

    const upper = document.body.appendChild(document.createElement('section'))
    const upperButton = upper.appendChild(document.createElement('button'))
    for (const element of [upper, upperButton]) {
      element.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
    }
    const upperScope = createModalFocusScope({ root: upper, restoreTarget: back, onEscape: () => {} })
    try {
      expect(document.activeElement).toBe(upperButton)
      boundary.dispatchEvent(new document.defaultView!.FocusEvent('focus'))
      expect(document.activeElement).toBe(upperButton)
    } finally {
      upperScope.deactivate()
      upper.remove()
    }
    boundary.focus()
    expect(document.activeElement).toBe(back)
    mounted.unmount()
    expect(document.activeElement).toBe(trigger)
    boundary.dispatchEvent(new document.defaultView!.FocusEvent('focus'))
    expect(document.activeElement).toBe(trigger)
  })

  test('removes the frame exit on a trusted frame error and installs a fresh usable exit after Retry', async () => {
    const mounted = mountModal()
    await settle()
    const dialog = mounted.host.querySelector<HTMLElement>('[role="dialog"]')!
    const back = dialog.querySelector<HTMLButtonElement>('button')!
    const originalFrame = dialog.querySelector<HTMLIFrameElement>('iframe')!
    const originalBoundary = dialog.querySelector<HTMLElement>('[aria-hidden="true"][tabindex="0"]')!
    browserWindow.dispatchEvent(new document.defaultView!.MessageEvent('message', {
      origin: 'https://embed.diagrams.net',
      source: originalFrame.contentWindow,
      data: JSON.stringify({ event: 'error', message: 'Controlled remote diagram error' })
    }))
    await settle()
    expect(dialog.querySelector('iframe')).toBeNull()
    expect(dialog.querySelector('[aria-hidden="true"][tabindex="0"]')).toBeNull()
    expect(originalFrame.isConnected).toBe(false)
    expect(originalBoundary.isConnected).toBe(false)
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
    expect(mounted.insert).not.toHaveBeenCalled()
    expect(mounted.wikiStore.editor.activeModal).toBe('editorModalDrawio')

    dialog.querySelector<HTMLButtonElement>('.async-state__retry')!.click()
    await settle()
    const replacementFrame = dialog.querySelector<HTMLIFrameElement>('iframe')!
    const replacementBoundary = dialog.querySelector<HTMLElement>('[aria-hidden="true"][tabindex="0"]')!
    expect(replacementFrame).not.toBe(originalFrame)
    expect(replacementFrame.isConnected).toBe(true)
    expect(replacementBoundary).not.toBe(originalBoundary)
    expect(replacementBoundary.isConnected).toBe(true)
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    replacementBoundary.focus()
    expect(document.activeElement).toBe(back)
  })
})

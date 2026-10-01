import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { fetchPageConflictLatest as fetchConflictLatest } from '../../helpers/pages-api.ts'
import { TextEditor } from './common/text-editor.ts'
import { EditorView } from '@codemirror/view'
import { getOriginalDoc, unifiedMergeView } from '@codemirror/merge'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'

// Vuetify snapshots browser capabilities; load it only after the shared DOM harness.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const mountedApps = []
afterEach(() => {
  for (const dispose of mountedApps.splice(0)) dispose()
  resetBody()
})

const readScript = relativePath => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  expect(source).toContain("<script lang='ts'>")
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

const loadConflictComponent = dependencies => {
  const script = readScript('client/components/editor/editor-modal-conflict.vue')
    .replace(/^import[^\n]*(?:\n|$)/gm, '')
    .replace('export default defineComponent(', 'const component = defineComponent(')
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script)
  return new Function(...Object.keys(dependencies), `${executable}\nreturn component`)(...Object.values(dependencies))
}

const createConflictHarness = ({
  latest = null,
  editorKey = 'markdown',
  container = null,
  fetchImplementation = async () => ({ ok: true }),
  fetchPageConflictLatest,
  realEditor = false,
  rtl = false,
  dark = false
} = {}) => {
  class Editor {
    static instances = []

    constructor(options) {
      this.options = options
      this.destroyed = false
      Editor.instances.push(this)
    }

    destroy() {
      this.destroyed = true
    }

    getValue() {
      return 'merged draft'
    }
  }

  const wikiStore = {
    editor: {
      activeModal: 'editorModalConflict',
      checkoutDateActive: '',
      content: 'local draft',
      editorKey
    },
    page: {
      description: 'Local description',
      id: 42,
      title: 'Local title'
    }
  }
  const notifications = []
  const EditorImplementation = realEditor ? TextEditor : Editor
  const fetchCalls = []
  const windowStub = {
    fetch: async (url, init) => {
      fetchCalls.push([url, init])
      return fetchImplementation(url, init)
    }
  }
  const component = loadConflictComponent({
    AbortController,
    Element: browserWindow.Element,
    HTMLElement: browserWindow.HTMLElement,
    TextEditor: EditorImplementation,
    defineComponent: value => value,
    emitEditorConflictResolved: () => {},
    fetchPageConflictLatest:
      fetchPageConflictLatest ??
      (async fetcher => {
        await fetcher('/api/pages/42/conflict', { method: 'GET' })
        return latest
      }),
    html,
    markdown,
    markRaw: Vue.markRaw,
    showNotification: (_store, notification) => notifications.push(notification),
    siteConfig: { rtl },
    unifiedMergeView,
    wikiStore,
    window: windowStub
  })
  const state = component.data()
  const context = Vue.reactive({
    ...state,
    $nextTick: async () => {},
    $vuetify: { theme: { current: { dark } } },
    $refs: { cm: container },
    activeModal: 'editorModalConflict',
    editorKey,
    ...component.methods
  })

  return { component, context, Editor, fetchCalls, notifications, wikiStore }
}

const loadTiptapConflictComponent = dependencies => {
  const script = readScript('client/components/editor/tiptap/conflict.vue')
    .replace(/^import[^\n]*(?:\n|$)/gm, '')
    .replace('export default defineComponent(', 'const component = defineComponent(')
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script)
  return new Function(...Object.keys(dependencies), `${executable}\nreturn component`)(...Object.values(dependencies))
}

const createDeferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createTiptapConflictHarness = ({
  fetchPageConflictLatest = fetchConflictLatest,
  fetchImplementation = async () => ({}),
  nextTick = async () => {},
  modelValue = true
} = {}) => {
  const wikiStore = {
    editor: {
      checkoutDateActive: 'local-checkout-date',
      content: 'local draft'
    },
    page: { id: 42 }
  }
  const windowFetchCalls = []
  const window = {
    fetch: (...args) => {
      windowFetchCalls.push(args)
      return fetchImplementation(...args)
    }
  }
  const resolutionEvents = []
  const emitted = []
  const focusCalls = []
  const fetchLatestImplementation = fetchPageConflictLatest
  const component = loadTiptapConflictComponent({
    HTMLElement: class {},
    AbortController,
    defineComponent: value => value,
    emitEditorConflictReset: () => resolutionEvents.push('reset'),
    emitEditorConflictResolved: () => resolutionEvents.push('resolved'),
    fetchPageConflictLatest: fetchLatestImplementation,
    markRaw: Vue.markRaw,
    wikiStore,
    window
  })
  const context = {
    ...component.data(),
    modelValue,
    $emit: (...args) => {
      emitted.push(args)
      if (args[0] === 'update:modelValue') context.modelValue = args[1]
    },
    $nextTick: nextTick,
    $refs: { loadErrorAlert: { $el: { focus: () => focusCalls.push(true) } } },
    ...component.methods
  }
  Object.defineProperty(context, 'isShown', {
    get: () => component.computed.isShown.get.call(context),
    set: value => component.computed.isShown.set.call(context, value)
  })

  return { component, context, emitted, focusCalls, resolutionEvents, wikiStore, windowFetchCalls }
}

const createLatestConflict = (overrides = {}) => ({
  updatedAt: '2026-09-01T12:00:00.000Z',
  authorName: 'Remote author',
  content: '# Remote draft',
  locale: 'en',
  path: 'remote-page',
  title: 'Remote title',
  description: 'Remote description',
  sourceRevision: '17',
  ...overrides
})

const compileRender = relativePath => {
  const filename = path.join(process.cwd(), relativePath)
  const parsed = parse(fs.readFileSync(filename, 'utf8'), { filename })
  if (parsed.errors.length > 0) throw parsed.errors[0]
  const compiled = compileTemplate({
    source: parsed.descriptor.template.content,
    filename,
    id: relativePath,
    preprocessLang: parsed.descriptor.template.lang,
    compilerOptions: { mode: 'function' }
  })
  if (compiled.errors.length > 0) throw compiled.errors[0]
  return new Function('Vue', compiled.code)(Vue)
}
const renderTiptapConflict = compileRender('client/components/editor/tiptap/conflict.vue')
const CardChin = Vue.defineComponent({ render: compileRender('client/components/common/v-card-chin.vue') })
const settle = async () => {
  for (let pass = 0; pass < 6; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const mountTiptapConflict = fetchImplementation => {
  const wikiStore = {
    editor: { checkoutDateActive: 'local-checkout-date', content: 'local draft' },
    page: { id: 42 }
  }
  const component = loadTiptapConflictComponent({
    HTMLElement: browserWindow.HTMLElement,
    AbortController,
    defineComponent: Vue.defineComponent,
    emitEditorConflictReset: () => {},
    emitEditorConflictResolved: () => {},
    fetchPageConflictLatest: fetchConflictLatest,
    markRaw: Vue.markRaw,
    wikiStore,
    window: { fetch: fetchImplementation }
  })
  component.render = renderTiptapConflict
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp(component, { modelValue: true })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.component('VCardChin', CardChin)
  // Translation contents are irrelevant here; preserve named slots and real dialog/button behavior.
  app.component('i18next', Vue.defineComponent({
    props: { tag: { type: String, default: 'div' } },
    setup: (props, { slots }) => () => Vue.h(props.tag, slots.default?.())
  }))
  app.config.globalProperties.$t = key => key
  app.config.globalProperties.$helpers = { formatMoment: value => value }
  const context = app.mount(host)
  mountedApps.push(() => { app.unmount(); host.remove() })
  return context
}

const expectDialogLabel = dialog => {
  expect(dialog).not.toBeNull()
  const labelIds = (dialog.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean)
  expect(labelIds.length).toBeGreaterThan(0)
  for (const id of labelIds) {
    const label = document.getElementById(id)
    expect(label).not.toBeNull()
    expect(label.isConnected).toBe(true)
    expect(label.textContent.trim()).not.toBe('')
    expect(label.closest('[hidden], [aria-hidden="true"]')).toBeNull()
    for (let ancestor = label; ancestor; ancestor = ancestor.parentElement) {
      expect(browserWindow.getComputedStyle(ancestor).display).not.toBe('none')
    }
  }
}

describe('Tiptap conflict component behavior', () => {
  test('Tiptap conflict shows fetch failures inline, retries, and resolves using the latest data', async () => {
    const failedFetch = createDeferred()
    const retriedFetch = createDeferred()
    const attempts = [failedFetch, retriedFetch]
    const latest = createLatestConflict()
    const harness = createTiptapConflictHarness({
      fetchImplementation: () => attempts.shift().promise
    })

    const initialLoad = harness.component.mounted.call(harness.context)
    failedFetch.reject(new Error('offline'))
    await initialLoad

    expect(harness.context.loadState).toBe('error')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.context.requestController).toBeNull()
    expect(harness.focusCalls).toHaveLength(1)
    expect(harness.windowFetchCalls.map(([url]) => url)).toEqual(['/_api/pages/42/conflict-latest'])
    const retry = harness.context.loadLatestVersion()
    expect(harness.context.loadState).toBe('loading')
    expect(harness.context.loadError).toBe('')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.windowFetchCalls.map(([url]) => url)).toEqual([
      '/_api/pages/42/conflict-latest',
      '/_api/pages/42/conflict-latest'
    ])

    retriedFetch.resolve(Response.json(latest))
    await retry

    expect(harness.context.loadState).toBe('success')
    expect(harness.context.latest).toEqual(latest)
    expect(harness.context.hasLatestVersion).toBe(true)
    expect(harness.context.requestController).toBeNull()

    harness.context.useRemote()

    expect(harness.wikiStore.editor.content).toBe(latest.content)
    expect(harness.wikiStore.editor.checkoutDateActive).toBe(latest.updatedAt)
    expect(harness.resolutionEvents).toEqual(['resolved'])
    expect(harness.emitted).toEqual([['update:modelValue', false]])
  })
  test('Tiptap conflict ignores local and remote resolutions until latest data loads', async () => {
    const failedFetch = createDeferred()
    const harness = createTiptapConflictHarness({
      fetchPageConflictLatest: () => failedFetch.promise
    })

    const pendingLoad = harness.component.mounted.call(harness.context)
    const expectResolutionsIgnored = () => {
      harness.context.useLocal()
      harness.context.useRemote()
      expect(harness.wikiStore.editor.content).toBe('local draft')
      expect(harness.wikiStore.editor.checkoutDateActive).toBe('local-checkout-date')
      expect(harness.resolutionEvents).toEqual([])
      expect(harness.emitted).toEqual([])
    }

    expect(harness.context.loadState).toBe('loading')
    expect(harness.context.hasLatestVersion).toBe(false)
    expectResolutionsIgnored()

    failedFetch.reject(new Error('offline'))
    await pendingLoad

    expect(harness.context.loadState).toBe('error')
    expect(harness.context.hasLatestVersion).toBe(false)
    expectResolutionsIgnored()
  })

  test('Tiptap conflict resolves locally using the latest timestamp without replacing the draft', async () => {
    const latest = createLatestConflict()
    const harness = createTiptapConflictHarness({
      fetchPageConflictLatest: async () => latest
    })

    await harness.component.mounted.call(harness.context)
    harness.context.useLocal()

    expect(harness.wikiStore.editor.content).toBe('local draft')
    expect(harness.wikiStore.editor.checkoutDateActive).toBe(latest.updatedAt)
    expect(harness.resolutionEvents).toEqual(['reset'])
    expect(harness.emitted).toEqual([['update:modelValue', false]])
  })

  test('Tiptap conflict aborts the request on unmount and ignores a late response', async () => {
    const lateFetch = createDeferred()
    const harness = createTiptapConflictHarness({
      fetchPageConflictLatest: fetcher => {
        fetcher('/inert-request', {})
        return lateFetch.promise
      }
    })

    const pendingLoad = harness.component.mounted.call(harness.context)

    const requestController = harness.context.requestController
    const requestInit = harness.windowFetchCalls[0][1]

    expect(requestController).toBeInstanceOf(AbortController)
    expect(requestController.signal.aborted).toBe(false)
    expect(harness.windowFetchCalls).toHaveLength(1)
    expect(requestInit.signal).toBe(requestController.signal)

    harness.component.beforeUnmount.call(harness.context)

    expect(requestController.signal.aborted).toBe(true)
    expect(requestInit.signal.aborted).toBe(true)
    expect(harness.context.requestController).toBeNull()

    lateFetch.resolve(createLatestConflict({ content: '# Stale response' }))
    await pendingLoad

    expect(harness.context.latest.content).toBe('')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.context.requestController).toBeNull()
    expect(harness.wikiStore.editor.content).toBe('local draft')
    expect(harness.wikiStore.editor.checkoutDateActive).toBe('local-checkout-date')
    expect(harness.resolutionEvents).toEqual([])
    expect(harness.emitted).toEqual([])
    expect(harness.focusCalls).toEqual([])
  })

  test('stale fetch-error continuation does not steal focus after retry starts', async () => {
    const focusTick = createDeferred()
    const focusTickRequested = createDeferred()
    const retriedFetch = createDeferred()
    const latest = createLatestConflict()
    let attemptCount = 0
    let nextTickCount = 0
    const harness = createTiptapConflictHarness({
      fetchPageConflictLatest: () => {
        attemptCount += 1
        return attemptCount === 1 ? Promise.reject(new Error('offline')) : retriedFetch.promise
      },
      nextTick: () => {
        if (nextTickCount++ === 0) {
          focusTickRequested.resolve()
          return focusTick.promise
        }
        return Promise.resolve()
      }
    })

    const failedLoad = harness.component.mounted.call(harness.context)
    await focusTickRequested.promise
    expect(harness.context.loadState).toBe('error')

    const retry = harness.context.loadLatestVersion()
    expect(harness.context.loadState).toBe('loading')
    focusTick.resolve()
    await failedLoad

    expect(harness.focusCalls).toEqual([])

    retriedFetch.resolve(latest)
    await retry
    expect(harness.context.latest).toEqual(latest)
    expect(harness.context.loadState).toBe('success')
  })

  test('renders state-gated accessible conflict actions and a safe latest-version link', async () => {
    const failedFetch = createDeferred()
    const retriedFetch = createDeferred()
    const attempts = [failedFetch, retriedFetch]
    const context = mountTiptapConflict(() => attempts.shift().promise)
    await settle()
    const localAction = () => document.querySelector('button[title="editor:conflict.useLocalHint"]')
    const remoteAction = () => document.querySelector('button[title="editor:conflict.useRemoteHint"]')
    const expectActionsUnavailable = () => {
      for (const action of [localAction(), remoteAction()]) {
        if (action) expect(action.disabled).toBe(true)
      }
    }
    const mainDialog = document.querySelector('[role="dialog"]')
    expectDialogLabel(mainDialog)
    const status = document.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expectActionsUnavailable()

    failedFetch.resolve(Response.json({ error: 'offline' }, { status: 503 }))
    await settle()
    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.tabIndex).toBe(-1)
    alert.focus()
    expect(document.activeElement).toBe(alert)
    expect(document.querySelector('[role="status"]')).toBeNull()
    expectActionsUnavailable()
    const retry = alert.querySelector('button')
    expect(retry).not.toBeNull()
    retry.click()
    await settle()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[role="status"]').getAttribute('aria-live')).toBe('polite')
    expectActionsUnavailable()

    retriedFetch.resolve(Response.json(createLatestConflict()))
    await settle()
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(localAction().disabled).toBe(false)
    expect(remoteAction().disabled).toBe(false)
    const latestLink = document.querySelector('a[target="_blank"]')
    expect(latestLink).not.toBeNull()
    expect(new URL(latestLink.href).pathname).toBe('/en/remote-page')
    expect(latestLink.relList.contains('noopener')).toBe(true)
    context.hasLatestVersion = false
    await settle()
    expectActionsUnavailable()
    context.hasLatestVersion = true
    await settle()
    remoteAction().click()
    await settle()
    const dialogs = [...document.querySelectorAll('.v-overlay--active[role="dialog"]')]
    expect(dialogs).toHaveLength(2)
    expectDialogLabel(dialogs.find(dialog => dialog !== mainDialog))
  })

  test('conflict template retains loading, error, dialog-label, and noopener contracts', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'client/components/editor/tiptap/conflict.vue'), 'utf8')
    const template = source.match(/<template lang=['"]pug['"]>([\s\S]*?)<\/template>/)?.[1]

    expect(template).toBeDefined()
    const lines = template.split('\n')
    const gatedBlock = expression => {
      const gateIndex = lines.findIndex(line => line.includes(expression) && /\bv-(?:if|else-if)\s*=/.test(line))
      expect(gateIndex).toBeGreaterThanOrEqual(0)
      if (gateIndex < 0) return ''

      let startIndex = gateIndex
      if (/^\s+v-(?:if|else-if)\s*=/.test(lines[gateIndex])) {
        const conditionIndent = lines[gateIndex].match(/^\s*/)[0].length
        for (let index = gateIndex - 1; index >= 0; index--) {
          if (lines[index].trimEnd().endsWith('(') && lines[index].match(/^\s*/)[0].length < conditionIndent) {
            startIndex = index
            break
          }
        }
      }

      const blockIndent = lines[startIndex].match(/^\s*/)[0].length
      let endIndex = startIndex + 1
      while (endIndex < lines.length) {
        if (lines[endIndex].trim() && lines[endIndex].match(/^\s*/)[0].length <= blockIndent) break
        endIndex++
      }
      return lines.slice(startIndex, endIndex).join('\n')
    }
    const expectOnlyInGate = (expression, markers) => {
      const block = gatedBlock(expression)
      for (const marker of markers) {
        const occurrences = text => text.split(marker).length - 1
        expect(occurrences(block)).toBeGreaterThan(0)
        expect(occurrences(block)).toBe(occurrences(template))
      }
    }

    expectOnlyInGate('loadState === `loading`', ["role='status'"])
    expectOnlyInGate('loadState === `error`', ["role='alert'", "@click='loadLatestVersion'", 'Retry'])
    expectOnlyInGate('loadState === `success` && hasLatestVersion', ["@click='useLocal'", "@click='useRemote'"])
    expect(template).toContain("role='status'\n          aria-live='polite'")
    expect(template).toContain("role='alert'\n          tabindex='-1'")
    expect(template).toContain("@click='loadLatestVersion'")
    expect(template).toContain("aria-labelledby='editor-conflict-title'")
    expect(template).toContain('span#editor-conflict-title')
    expect(template).toContain("aria-labelledby='editor-conflict-overwrite-title'")
    expect(template).toContain('span#editor-conflict-overwrite-title')
    expect(template).toContain("target='_blank', rel='noopener'")
  })
})

describe('editor conflict REST migration guard', () => {
  test('reports a failed REST load, destroys the stale editor, and releases its request', async () => {
    const harness = createConflictHarness({
      fetchPageConflictLatest: fetchConflictLatest,
      fetchImplementation: async () => Response.json({ error: 'offline' }, { status: 503 })
    })
    const staleEditor = new harness.Editor({})
    harness.context.cm = staleEditor

    await harness.context.loadConflict()

    expect(staleEditor.destroyed).toBe(true)
    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(harness.fetchCalls[0][0]).toBe('/_api/pages/42/conflict-latest')
    expect(harness.notifications).toEqual([
      expect.objectContaining({ style: 'warning', icon: 'warning' })
    ])
    expect(harness.context.isLoading).toBe(false)
    expect(harness.context.latestLoaded).toBe(false)
    expect(harness.context.requestController).toBeNull()
  })

  test('initializes an editable local merge document with the remote original only after live DOM is available', async () => {
    const latest = createLatestConflict()
    const container = document.body.appendChild(document.createElement('div'))
    const harness = createConflictHarness({ latest, container, realEditor: true, rtl: true, dark: true })
    try {
      const loading = harness.context.loadConflict()
      const requestController = harness.context.requestController
      expect(Vue.isProxy(requestController)).toBe(false)
      expect(harness.fetchCalls[0][1].signal).toBe(requestController.signal)
      await loading

      expect(harness.context.latest).toEqual(latest)
      expect(Vue.isProxy(harness.context.cm)).toBe(false)
      expect(harness.context.cm).toBeInstanceOf(TextEditor)
      const view = EditorView.findFromDOM(container.querySelector('.cm-editor'))
      expect(view.state.doc.toString()).toBe('local draft')
      expect(getOriginalDoc(view.state).toString()).toBe(latest.content)
      const content = container.querySelector('.cm-content')
      expect(content.isContentEditable || content.getAttribute('contenteditable') === 'true').toBe(true)
      expect((content.getAttribute('aria-label') ?? '').trim()).not.toBe('')
      expect(content.getAttribute('dir')).toBe('rtl')
      expect(view.state.facet(EditorView.darkTheme)).toBe(true)
      expect(container.querySelector('.cm-chunkButtons')).toBeNull()
      harness.context.cm.setValue('edited local merge')
      expect(harness.context.cm.getValue()).toBe('edited local merge')
      expect(harness.context.mergeValue).toBe('edited local merge')
      expect(getOriginalDoc(view.state).toString()).toBe(latest.content)
      expect(harness.context.latestLoaded).toBe(true)
      expect(harness.context.requestController).toBeNull()
    } finally {
      harness.context.cm?.destroy()
      container.remove()
    }

    const missingDom = createConflictHarness({ latest })
    await missingDom.context.loadConflict()
    expect(missingDom.Editor.instances).toHaveLength(0)
    expect(missingDom.context.latestLoaded).toBe(false)
    expect(missingDom.context.requestController).toBeNull()
  })

  test('releases a completed request without initializing after the conflict modal closes', async () => {
    let context
    const latest = {
      title: 'Remote title',
      description: 'Remote description',
      updatedAt: '2026-09-01T12:00:00.000Z',
      authorName: 'Remote author',
      content: '# Remote draft'
    }
    const harness = createConflictHarness({
      fetchPageConflictLatest: async () => {
        context.activeModal = ''
        return latest
      }
    })
    context = harness.context

    await context.loadConflict()

    expect(context.requestController).toBeNull()
    expect(context.latestLoaded).toBe(false)
    expect(harness.Editor.instances).toHaveLength(0)
    expect(harness.notifications).toHaveLength(0)
  })

  test('aborts an in-flight request and destroys the raw editor before unmount', () => {
    const harness = createConflictHarness()
    const controller = Vue.markRaw(new AbortController())
    const editor = new harness.Editor({})
    harness.context.requestController = controller
    harness.context.cm = editor

    harness.component.beforeUnmount.call(harness.context)

    expect(controller.signal.aborted).toBe(true)
    expect(editor.destroyed).toBe(true)
    expect(harness.context.requestController).toBeNull()
    expect(harness.context.cm).toBeNull()
  })
})

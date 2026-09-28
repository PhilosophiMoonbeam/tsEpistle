import fs from 'node:fs'
import path from 'node:path'

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
  markRaw = value => value
} = {}) => {
  class Element {}
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
  const mergeOptions = []
  const fetchCalls = []
  const windowStub = {
    fetch: async (url, init) => {
      fetchCalls.push([url, init])
      return fetchImplementation(url, init)
    }
  }
  const component = loadConflictComponent({
    AbortController,
    Element,
    HTMLElement: Element,
    TextEditor: Editor,
    defineComponent: value => value,
    emitEditorConflictResolved: () => {},
    fetchPageConflictLatest:
      fetchPageConflictLatest ??
      (async fetcher => {
        await fetcher('/api/pages/42/conflict', { method: 'GET' })
        return latest
      }),
    html: () => ({ language: 'html' }),
    markdown: () => ({ language: 'markdown' }),
    markRaw,
    showNotification: (_store, notification) => notifications.push(notification),
    siteConfig: { rtl: false },
    unifiedMergeView: options => {
      mergeOptions.push(options)
      return { merge: options }
    },
    wikiStore,
    window: windowStub
  })
  const state = component.data()
  const context = {
    ...state,
    $nextTick: async () => {},
    $vuetify: { theme: { current: { dark: false } } },
    $refs: { cm: container },
    activeModal: 'editorModalConflict',
    editorKey,
    ...component.methods
  }

  return { component, context, Editor, Element, fetchCalls, mergeOptions, notifications, wikiStore }
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

const createTiptapConflictHarness = ({ fetchPageConflictLatest, nextTick = async () => {}, modelValue = true } = {}) => {
  const wikiStore = {
    editor: {
      checkoutDateActive: 'local-checkout-date',
      content: 'local draft'
    },
    page: { id: 42 }
  }
  const fetchLatestCalls = []
  const windowFetchCalls = []
  const window = {
    fetch: (...args) => {
      windowFetchCalls.push(args)
      return Promise.resolve({})
    }
  }
  const notifications = []
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
    fetchPageConflictLatest: (fetcher, pageId) => {
      fetchLatestCalls.push({ fetcher, pageId })
      return fetchLatestImplementation(fetcher, pageId)
    },
    markRaw: value => value,
    showNotification: (...args) => notifications.push(args),
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

  return { component, context, emitted, fetchLatestCalls, focusCalls, notifications, resolutionEvents, wikiStore, windowFetchCalls }
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

describe('Tiptap conflict component behavior', () => {
  test('Tiptap conflict shows fetch failures inline, retries, and resolves using the latest data', async () => {
    const failedFetch = createDeferred()
    const retriedFetch = createDeferred()
    const attempts = [failedFetch, retriedFetch]
    const latest = createLatestConflict()
    const harness = createTiptapConflictHarness({
      fetchPageConflictLatest: () => attempts.shift().promise
    })

    const initialLoad = harness.component.mounted.call(harness.context)
    failedFetch.reject(new Error('offline'))
    await initialLoad

    expect(harness.context.loadState).toBe('error')
    expect(harness.context.loadError).toBe('Failed to fetch latest version.')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.context.requestController).toBeNull()
    expect(harness.focusCalls).toHaveLength(1)
    expect(harness.notifications).toEqual([])
    expect(harness.fetchLatestCalls).toHaveLength(1)
    expect(harness.fetchLatestCalls[0].fetcher).toEqual(expect.any(Function))
    expect(harness.fetchLatestCalls[0].pageId).toBe(42)
    const retry = harness.context.loadLatestVersion()
    expect(harness.context.loadState).toBe('loading')
    expect(harness.context.loadError).toBe('')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.fetchLatestCalls.map(({ pageId }) => pageId)).toEqual([42, 42])
    expect(harness.fetchLatestCalls.every(({ fetcher }) => typeof fetcher === 'function')).toBe(true)

    retriedFetch.resolve(latest)
    await retry

    expect(harness.context.loadState).toBe('success')
    expect(harness.context.latest).toEqual(latest)
    expect(harness.context.hasLatestVersion).toBe(true)
    expect(harness.context.requestController).toBeNull()
    expect(harness.notifications).toEqual([])

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

    expect(harness.context.loadState).toBe('loading')
    expect(harness.context.latest.content).toBe('')
    expect(harness.context.hasLatestVersion).toBe(false)
    expect(harness.context.requestController).toBeNull()
    expect(harness.notifications).toEqual([])
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
    const rawValues = []
    const harness = createConflictHarness({
      markRaw: value => {
        rawValues.push(value)
        return value
      }
    })
    const staleEditor = new harness.Editor({})
    harness.context.cm = staleEditor

    await harness.context.loadConflict()

    expect(staleEditor.destroyed).toBe(true)
    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(rawValues[0]).toBeInstanceOf(AbortController)
    expect(harness.notifications).toEqual([
      {
        message: 'Failed to fetch latest version.',
        style: 'warning',
        icon: 'warning'
      }
    ])
    expect(harness.context.loadError).toContain('Failed to fetch the latest version.')
    expect(harness.context.isLoading).toBe(false)
    expect(harness.context.latestLoaded).toBe(false)
    expect(harness.context.requestController).toBeNull()
  })

  test('initializes a raw typed merge editor only after a live conflict DOM is available', async () => {
    const latest = {
      title: 'Remote title',
      description: 'Remote description',
      updatedAt: '2026-09-01T12:00:00.000Z',
      authorName: 'Remote author',
      content: '# Remote draft'
    }
    const rawValues = []
    const harness = createConflictHarness({
      latest,
      markRaw: value => {
        rawValues.push(value)
        return value
      }
    })
    harness.context.$refs.cm = new harness.Element()

    await harness.context.loadConflict()

    expect(harness.context.latest).toEqual(latest)
    expect(harness.context.cm).toBe(harness.Editor.instances[0])
    expect(rawValues).toContain(harness.context.cm)
    expect(harness.context.cm.options).toMatchObject({
      parent: harness.context.$refs.cm,
      ariaLabel: 'Editable merge result',
      dark: false,
      value: 'local draft',
      language: { language: 'markdown' },
      direction: 'ltr'
    })
    expect(harness.mergeOptions).toEqual([
      {
        original: '# Remote draft',
        mergeControls: false,
        collapseUnchanged: {
          margin: 3,
          minSize: 4
        }
      }
    ])
    expect(harness.context.latestLoaded).toBe(true)
    expect(harness.context.requestController).toBeNull()

    const missingDom = createConflictHarness({ latest })
    await missingDom.context.loadConflict()
    expect(missingDom.Editor.instances).toHaveLength(0)
    expect(missingDom.context.loadError).toBe('The conflict editor could not be initialized.')
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
    const controller = new AbortController()
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

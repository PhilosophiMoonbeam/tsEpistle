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
    $refs: { cm: container },
    activeModal: 'editorModalConflict',
    editorKey,
    ...component.methods
  }

  return { component, context, Editor, Element, fetchCalls, mergeOptions, notifications, wikiStore }
}

describe('editor conflict REST migration guard', () => {
  test('Tiptap conflict owns cancellation independently of thrown error shape and names its dialogs', () => {
    const relativePath = 'client/components/editor/tiptap/conflict.vue'
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    const script = readScript(relativePath)

    expect(script).toMatch(/import\s*\{(?=[^}]*\bdefineComponent\b)(?=[^}]*\bmarkRaw\b)[^}]*\}\s*from\s*['"]vue['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { fetchPageConflictLatest, type PageConflictLatest } from '../../../helpers/pages-api'")
    expect(script).toMatch(
      /const\s+requestController\s*=\s*markRaw\s*\(\s*new\s+AbortController\s*\(\s*\)\s*\)[\s\S]*?this\.requestController\s*=\s*requestController/
    )
    expect(script).toMatch(
      /fetchPageConflictLatest\s*\(\s*\(\s*url\s*,\s*init\s*\)\s*=>\s*window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.init\s*,\s*signal:\s*requestController\.signal\s*\}\s*\)\s*,\s*wikiStore\.page\.id\s*\)/
    )
    expect(script).toMatch(
      /catch\s*\{[\s\S]*?if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return[\s\S]*?\}\s*if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return/
    )
    expect(script.match(/if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return/g)).toHaveLength(2)
    expect(script).not.toMatch(/AbortError|(?:error|err)\.name/)
    expect(script).toMatch(
      /this\.requestController\s*=\s*null\s*[\s\S]*?if\s*\(\s*!resp\s*\)\s*\{\s*return\s+showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?message:\s*['"]Failed to fetch latest version\.['"][\s\S]*?style:\s*['"]warning['"][\s\S]*?icon:\s*['"]warning['"][\s\S]*?\}\s*\)\s*\}[\s\S]*?this\.latest\s*=\s*resp/
    )
    expect(script).toMatch(/beforeUnmount\s*\(\s*\)\s*\{\s*this\.requestController\?\.abort\s*\(\s*\)[\s\S]*?this\.requestController\s*=\s*null\s*\}/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(
      /useLocal\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictReset\s*\(\s*\)[\s\S]*this\.close\s*\(\s*\)/
    )
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.content\s*=\s*this\.latest\.content[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
    expect(source).toContain("aria-labelledby='editor-conflict-title'")
    expect(source).toContain("span#editor-conflict-title {{$t('editor:conflict.title')}}")
    expect(source).toContain("aria-labelledby='editor-conflict-overwrite-title'")
    expect(source).toContain("span#editor-conflict-overwrite-title {{$t('editor:conflict.overwrite.title')}}")
    expect(source).toMatch(/v-btn\.mt-2\([^)]*:href='`\/` \+ latest\.locale \+ `\/` \+ latest\.path'[^)]*target='_blank'[^)]*rel='noopener'/)
  })

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

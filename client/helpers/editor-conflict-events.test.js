import fs from 'node:fs'
import path from 'node:path'
import { babelParse, parse } from '@vue/compiler-sfc'
import '../test/browser-dom.mts'
import { describe, expect, test, vi } from '../../server/test/bun-test.mts'
import * as Vue from 'vue'
import * as CodeMirrorView from '@codemirror/view'
import * as MarkdownLanguage from '@codemirror/lang-markdown'
import * as HtmlLanguage from '@codemirror/lang-html'
import * as Completion from '@codemirror/autocomplete'
import * as Preview from '../components/editor/markdown/preview.ts'
import * as PreviewAlignment from '../components/editor/markdown/preview-alignment'
import * as WikiLinks from '../../shared/wikilinks.ts'
import * as InsertEvents from './editor-insert-events'
import * as Base64 from './base64'
import { TextEditor } from '../components/editor/common/text-editor'
import { EditorAdapterController } from '../components/editor/common/editor-adapter'
import lodash from 'lodash'

import * as editorConflictEvents from './editor-conflict-events.ts'

const {
  EDITOR_SAVE_CONFLICT_EVENT,
  EDITOR_CONTENT_OVERWRITE_EVENT,
  EDITOR_CONFLICT_RESET_EVENT
} = editorConflictEvents

const repoRoot = path.resolve(import.meta.dirname, '../..')
const guardedFiles = [
  'client/components/editor.vue',
  'client/components/editor/editor-markdown.vue',
  'client/components/editor/editor-code.vue',
  'client/components/editor/editor-asciidoc.vue',
  'client/components/editor/editor-ckeditor.vue',
  'client/components/editor/editor-modal-conflict.vue',
  'client/components/editor/tiptap/editor.vue',
  'client/components/editor/tiptap/conflict.vue',
  'client/components/editor/editor-modal-drawio.vue'
]
const conflictEventNames = [
  EDITOR_SAVE_CONFLICT_EVENT,
  EDITOR_CONTENT_OVERWRITE_EVENT,
  EDITOR_CONFLICT_RESET_EVENT
]
const conflictEventCases = [
  ['EditorSaveConflict', EDITOR_SAVE_CONFLICT_EVENT],
  ['EditorContentOverwrite', EDITOR_CONTENT_OVERWRITE_EVENT],
  ['EditorConflictReset', EDITOR_CONFLICT_RESET_EVENT]
]

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directRootEventPattern (eventName) {
  return new RegExp(
    '\\bthis\\s*\\.\\s*\\$root\\s*\\.\\s*\\$(?:emit|on|off)\\s*\\(\\s*([\'"`])' + eventName + '\\1',
    'g'
  )
}

function helperRootArgumentPattern () {
  return /\b(?:emit|on|off)Editor(?:SaveConflict|ContentOverwrite|ConflictReset|ConflictResolved)\s*\(\s*this\.\$root\b/g
}

function visitSyntax (node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'comments') continue
    if (Array.isArray(value)) value.forEach(child => { visitSyntax(child, visit) })
    else if (value && typeof value === 'object') visitSyntax(value, visit)
  }
}

function componentOptions (relativePath, wikiStore) {
  const filename = path.join(repoRoot, relativePath)
  const script = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor.script.content
  const syntax = babelParse(script, { sourceType: 'module', plugins: ['typescript'] })
  let executable = script
  for (const node of [...syntax.program.body].reverse()) {
    if (node.type === 'ImportDeclaration') executable = executable.slice(0, node.start) + executable.slice(node.end)
  }
  executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(executable.replace('export default', 'const component ='))
  const dependencies = {
    ...Vue,
    ...CodeMirrorView,
    ...MarkdownLanguage,
    ...HtmlLanguage,
    ...Completion,
    ...Preview,
    ...PreviewAlignment,
    ...WikiLinks,
    ...InsertEvents,
    ...editorConflictEvents,
    ...Base64,
    TextEditor,
    EditorAdapterController,
    wikiStore,
    _: lodash,
    markdownHelp: {},
    Velocity: () => {},
    siteConfig: { rtl: false },
    siteLangs: []
  }
  const bindings = Object.entries(dependencies).filter(([name]) => name !== 'default')
  return new Function(...bindings.map(([name]) => name), `${executable}\nreturn component`)(...bindings.map(([, value]) => value))
}

function lifecycleContext (component) {
  const root = document.body.appendChild(document.createElement('div'))
  const cm = root.appendChild(document.createElement('div'))
  const context = {
    $refs: { root, cm },
    $vuetify: { theme: { current: { dark: false } } },
    $emit: () => {},
    $nextTick: callback => Vue.nextTick(callback),
    mdAndUp: false,
    wikiLinkOptions: WikiLinks.WIKI_LINKS_DISABLED
  }
  Object.assign(context, component.data.call(context))
  for (const [name, method] of Object.entries(component.methods)) context[name] = method.bind(context)
  for (const [name, computed] of Object.entries(component.computed)) {
    Object.defineProperty(context, name, typeof computed === 'function'
      ? { configurable: true, get: computed.bind(context) }
      : { configurable: true, get: computed.get.bind(context), set: computed.set.bind(context) })
  }
  return { context, root }
}

describe('editor conflict events', () => {
  test('editor conflict transport has no Vue runtime or instance-bus dependency', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'client/helpers/editor-conflict-events.ts'), 'utf8')
    const violations = []
    visitSyntax(babelParse(source, { sourceType: 'module', plugins: ['typescript'] }), node => {
      if (node.type === 'ImportDeclaration' && /^vue(?:\/|$)/.test(node.source.value) && node.importKind !== 'type') {
        if (node.specifiers.length === 0 || node.specifiers.some(specifier => specifier.importKind !== 'type')) violations.push('Vue runtime import')
      }
      if (node.type === 'CallExpression' &&
        (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require')) &&
        node.arguments[0]?.type === 'StringLiteral' && /^vue(?:\/|$)/.test(node.arguments[0].value)) violations.push('Vue runtime load')
      if (node.type === 'ImportExpression' && /^vue(?:\/|$)/.test(node.source.value ?? '')) violations.push('Vue runtime load')
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        const name = node.computed ? node.property.value : node.property.name
        if (['$emit', '$on', '$off'].includes(name)) violations.push('Vue instance bus')
      }
    })
    expect(violations).toEqual([])
  })

  test.each(conflictEventCases)('emit%s delivers only to its private %s channel', (suffix) => {
    const listeners = conflictEventCases.map(([name]) => ({ name, handler: vi.fn() }))
    for (const { name, handler } of listeners) editorConflictEvents[`on${name}`](handler)
    try {
      editorConflictEvents[`emit${suffix}`]()
      for (const { name, handler } of listeners) expect(handler).toHaveBeenCalledTimes(name === suffix ? 1 : 0)
    } finally {
      for (const { name, handler } of listeners) editorConflictEvents[`off${name}`](handler)
    }
  })

  test('emitEditorConflictResolved emits overwrite before reset', () => {
    const calls = []
    const overwriteHandler = vi.fn(() => calls.push(EDITOR_CONTENT_OVERWRITE_EVENT))
    const resetHandler = vi.fn(() => calls.push(EDITOR_CONFLICT_RESET_EVENT))

    editorConflictEvents.onEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.onEditorConflictReset(resetHandler)
    editorConflictEvents.emitEditorConflictResolved()
    editorConflictEvents.offEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.offEditorConflictReset(resetHandler)

    expect(calls).toEqual([EDITOR_CONTENT_OVERWRITE_EVENT, EDITOR_CONFLICT_RESET_EVENT])
    expect(overwriteHandler).toHaveBeenCalledTimes(1)
    expect(resetHandler).toHaveBeenCalledTimes(1)
  })

  test.each(conflictEventCases)('off%s removes only its handler from the private %s channel', (suffix) => {
    const removed = vi.fn()
    const remaining = vi.fn()
    editorConflictEvents[`on${suffix}`](removed)
    editorConflictEvents[`on${suffix}`](remaining)
    try {
      editorConflictEvents[`off${suffix}`](removed)
      editorConflictEvents[`emit${suffix}`]()
      expect(removed).not.toHaveBeenCalled()
      expect(remaining).toHaveBeenCalledTimes(1)
    } finally {
      editorConflictEvents[`off${suffix}`](removed)
      editorConflictEvents[`off${suffix}`](remaining)
    }
  })

  test.each(conflictEventCases)('off%s does not broadly unsubscribe without a handler', (suffix) => {
    const handler = vi.fn()

    editorConflictEvents[`on${suffix}`](handler)
    editorConflictEvents[`off${suffix}`]()
    editorConflictEvents[`emit${suffix}`]()
    editorConflictEvents[`off${suffix}`](handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('editor conflict event usage', () => {
  test.each(['markdown', 'code'])('%s owns conflict subscriptions only while its editor is mounted', async (kind) => {
    const wikiStore = { page: { id: 0, locale: 'en', path: 'draft' }, editor: { mode: 'create', content: 'Local draft', activeModal: '' } }
    const component = componentOptions(`client/components/editor/editor-${kind}.vue`, wikiStore)
    const { context, root } = lifecycleContext(component)
    const survivor = vi.fn()
    editorConflictEvents.onEditorSaveConflict(survivor)
    let unmounted = false
    let writes
    try {
      await component.mounted.call(context)
      const editor = context.cm
      editorConflictEvents.emitEditorSaveConflict()
      expect(context.activeModal).toBe('editorModalConflict')
      wikiStore.editor.content = 'Remote draft\nwith exact replacement'
      editorConflictEvents.emitEditorContentOverwrite()
      expect(editor.getValue()).toBe('Remote draft\nwith exact replacement')
      editorConflictEvents.emitEditorConflictReset()
      expect(context.activeModal).toBe('editorModalConflict')
      expect(wikiStore.editor.content).toBe('Remote draft\nwith exact replacement')
      expect(editor.getValue()).toBe('Remote draft\nwith exact replacement')
      writes = vi.spyOn(editor, 'setValue')
      component.beforeUnmount.call(context)
      unmounted = true
      wikiStore.editor.activeModal = 'unmounted-sentinel'
      wikiStore.editor.content = 'Draft after unmount'
      editorConflictEvents.emitEditorSaveConflict()
      editorConflictEvents.emitEditorContentOverwrite()
      expect(wikiStore.editor.activeModal).toBe('unmounted-sentinel')
      expect(wikiStore.editor.content).toBe('Draft after unmount')
      expect(writes).not.toHaveBeenCalled()
      expect(survivor).toHaveBeenCalledTimes(2)
    } finally {
      if (!unmounted) component.beforeUnmount.call(context)
      writes?.mockRestore()
      editorConflictEvents.offEditorSaveConflict(context.handleEditorSaveConflict)
      editorConflictEvents.offEditorContentOverwrite(context.handleEditorContentOverwrite)
      InsertEvents.offEditorInsert(context.handleEditorInsert)
      editorConflictEvents.offEditorSaveConflict(survivor)
      root.remove()
    }
  })

  test('editor conflict components use the helper instead of direct root bus conflict events', () => {
    const offenders = []

    for (const relPath of guardedFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')

      for (const eventName of conflictEventNames) {
        const pattern = directRootEventPattern(eventName)
        let match

        while ((match = pattern.exec(content)) !== null) {
          offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root event for ${eventName}`)
        }
      }

      const helperPattern = helperRootArgumentPattern()
      let helperMatch
      while ((helperMatch = helperPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, helperMatch.index)}: helper called with this.$root`)
      }
    }

    expect(offenders).toEqual([])
  })
})

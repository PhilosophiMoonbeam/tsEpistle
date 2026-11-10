import { Editor, type ChainedCommands } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import * as cheerio from 'cheerio'
import pug from 'pug'
import * as ts from 'typescript'
import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import { createWikiMarkdownRenderer, sanitizeWikiMarkdownHtml } from '../markdown/preview.ts'
import { createTiptapExtensions, discoveredPageLinkContent, getVisualEditorDefinition, getVisualEditorStats, serializeVisualEditorData, VisualEditorSource, type VisualEditorFormat } from './editor-config.ts'
import { prepareTiptapHtml, prepareTiptapMarkdown } from './dialect.ts'
import { installTiptapSlashMenu, type DiscoveredPageLink } from './slash-menu.ts'
import { EditorAdapterController } from '../common/editor-adapter.ts'
import {
  ADMONITION_KINDS,
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  searchVisualMarkdownGlyphs
} from './visual-markdown-authoring.ts'
import { parseWikiLinkAt, resolveWikiLinkHref, type WikiLinkOptions } from '../../../../shared/wikilinks.ts'
import '../../../test/browser-dom.mts'
import { translateEnglish } from '../../../test/english-translate.mts'
import { FORMATTING_TOOLS } from '../common/formatting-tools.ts'
import * as editorConflictEvents from '../../../helpers/editor-conflict-events.ts'
import * as editorInsertEvents from '../../../helpers/editor-insert-events.ts'

// Static Vuetify imports capture DOM globals before the shared harness installs them.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const menuUnmounts: Array<() => void> = []
// Vue's editor integration must capture the browser globals installed by the harness.
const { Editor: VueEditor, EditorContent } = await import('@tiptap/vue-3')

// Execute the owner template and Options behavior without starting its unrelated
// collaboration/network lifecycle. Insertion still uses a real Tiptap editor.
const visualPath = join(process.cwd(), 'client/components/editor/tiptap/editor.vue')
const visualSfc = parse(readFileSync(visualPath, 'utf8'), { filename: visualPath }).descriptor
if (!visualSfc.script || !visualSfc.template) throw new Error('Visual editor SFC is incomplete')
const visualScript = visualSfc.script.content
const visualAst = ts.createSourceFile(visualPath, visualScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const visualExport = visualAst.statements.find(ts.isExportAssignment)
if (!visualExport || !ts.isCallExpression(visualExport.expression) || !ts.isObjectLiteralExpression(visualExport.expression.arguments[0])) {
  throw new Error('Visual editor Options API definition is missing')
}
const visualOptions = visualExport.expression.arguments[0]
const visualOption = (name: string): string => {
  const property = visualOptions.properties.find(
    candidate => (ts.isPropertyAssignment(candidate) || ts.isMethodDeclaration(candidate)) && ts.isIdentifier(candidate.name) && candidate.name.text === name
  )
  if (!property) throw new Error(`Visual editor ${name} option is missing`)
  return property.getText(visualAst)
}
// Preserve Vue activator-slot ancestry instead of native HTML template fragments.
const visualMarkup = cheerio.load(pug.render(visualSfc.template.content, { doctype: 'html' }), { xml: true })
const formattingInsertMenu = visualMarkup('v-menu').filter((_index, element) => visualMarkup(element).attr('v-model') === 'insertMenuOpen')
if (formattingInsertMenu.length !== 1) throw new Error('Formatting Insert menu is missing or ambiguous')
const insertTemplate = compileTemplate({
  source: `<v-app>${formattingInsertMenu.toString()}${visualMarkup('.editor-tiptap-glyph-menu').closest('v-menu').toString()}${visualMarkup('v-dialog[aria-labelledby="editor-tiptap-admonition-title"]').toString()}</v-app>`,
  filename: visualPath,
  id: 'visual-insert-consumer',
  compilerOptions: { mode: 'function' }
})
if (insertTemplate.errors.length) throw insertTemplate.errors[0]
const insertRender = new Function('Vue', insertTemplate.code)(Vue)
const visualConstants = visualAst.statements
  .filter(ts.isVariableStatement)
  .map(statement => statement.getText(visualAst))
  .join('\n')
const visualBehaviorCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `${visualConstants}\nreturn { ${['data', 'methods', 'computed', 'watch'].map(visualOption).join(',')} }`
)
const visualBehavior = new Function(
  'markRaw',
  'FORMATTING_TOOLS',
  'ADMONITION_KINDS',
  'VISUAL_MARKDOWN_GLYPHS',
  'insertVisualMarkdownDefinitionList',
  'insertVisualMarkdownGlyph',
  'insertVisualMarkdownAdmonition',
  'searchVisualMarkdownGlyphs',
  visualBehaviorCode
)(
  Vue.markRaw,
  FORMATTING_TOOLS,
  ADMONITION_KINDS,
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  insertVisualMarkdownAdmonition,
  searchVisualMarkdownGlyphs
)

const settleInsertMenu = async () => {
  await Vue.nextTick()
  for (let frame = 0; frame < 3; frame++) {
    const nextFrame = Promise.withResolvers<void>()
    requestAnimationFrame(() => nextFrame.resolve())
    await nextFrame.promise
  }
  await Vue.nextTick()
}

const mountInsertMenu = () => {
  const editor = createEditor('markdown', '')
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    data() {
      return { ...visualBehavior.data.call({ $t: translateEnglish }), editor: Vue.markRaw(editor), format: 'markdown' }
    },
    methods: visualBehavior.methods,
    computed: visualBehavior.computed,
    watch: visualBehavior.watch,
    render: insertRender
  })
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.mount(host)
  menuUnmounts.push(() => {
    app.unmount()
    host.remove()
  })
  const insertTrigger = (): HTMLButtonElement => {
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')).find(
      button => button.getAttribute('aria-label') === translateEnglish('editor:markup.insertTools')
    )
    if (!trigger) throw new Error('The formatting Insert opener is not mounted')
    return trigger
  }
  return {
    editor,
    host,
    insertTrigger,
    async choose(labelKey: string) {
      insertTrigger().click()
      await settleInsertMenu()
      const item = Array.from(document.querySelectorAll<HTMLElement>('.v-list-item')).find(item => item.textContent?.trim() === translateEnglish(labelKey))
      if (!item) throw new Error(`Insert action ${labelKey} is not reachable`)
      item.click()
      await settleInsertMenu()
    }
  }
}

const editors: Editor[] = []
let restoreRangeGeometry: (() => void) | undefined

function installRangeGeometry(): void {
  if (restoreRangeGeometry) return
  const { Range, DOMRect } = document.defaultView!
  const prototype = Range.prototype
  const methods = ['getClientRects', 'getBoundingClientRect'] as const
  const originals = methods.map(name => Object.getOwnPropertyDescriptor(prototype, name))
  const elementPrototype = document.defaultView!.HTMLElement.prototype
  const originalScroll = Object.getOwnPropertyDescriptor(elementPrototype, 'scrollIntoView')
  Object.defineProperty(elementPrototype, 'scrollIntoView', { configurable: true, value: () => {} })
  // JSDOM has no layout. Supply geometry only; keep native editor/menu behavior intact.
  const rectangle = new DOMRect(0, 0, 1, 16)
  Object.defineProperties(prototype, {
    getClientRects: {
      configurable: true,
      value: () =>
        Object.assign([rectangle], {
          item: (index: number) => (index === 0 ? rectangle : null)
        })
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle
    }
  })
  restoreRangeGeometry = () => {
    methods.forEach((name, index) => {
      const original = originals[index]
      if (original) Object.defineProperty(prototype, name, original)
      else Reflect.deleteProperty(prototype, name)
    })
    if (originalScroll) Object.defineProperty(elementPrototype, 'scrollIntoView', originalScroll)
    else Reflect.deleteProperty(elementPrototype, 'scrollIntoView')
    restoreRangeGeometry = undefined
  }
}
const enabledWikiLinks: WikiLinkOptions = {
  enabled: true,
  context: { locale: 'en', pagePath: 'guide', namespaced: true }
}

function createEditor(format: VisualEditorFormat, content: string, wikiLinks?: WikiLinkOptions): Editor {
  installRangeGeometry()
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: createTiptapExtensions(format, wikiLinks),
    content: format === 'markdown' ? prepareTiptapMarkdown(content) : prepareTiptapHtml(content),
    contentType: format
  })
  editors.push(editor)
  return editor
}

function findTextblockEnd(editor: Editor, text: string, parentType: string): number | null {
  let result: number | null = null
  editor.state.doc.descendants((node, position, parent) => {
    if (node.isTextblock && node.textContent === text && parent?.type.name === parentType) {
      result = position + 1 + node.content.size
    }
  })
  return result
}

function selectionHasAncestor(editor: Editor, name: string): boolean {
  const $from = editor.state.selection.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) return true
  }
  return false
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

function typeVisualText(editor: Editor, text: string): void {
  const { from, to } = editor.state.selection
  const defaultTransaction = () => editor.state.tr.insertText(text)
  const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, text, defaultTransaction))
  if (!handled) editor.view.dispatch(defaultTransaction())
}

async function renderServerMarkdown(input: string): Promise<string> {
  return Reflect.apply(
    markdownRenderer.render,
    {
      input,
      config: {
        allowHTML: true,
        linebreaks: false,
        linkify: false,
        typographer: false,
        quotes: 'English',
        underline: false
      },
      children: [
        { key: 'markdownAbbr', config: {} },
        { key: 'markdownDeflist', config: {} },
        { key: 'markdownFootnotes', config: {} },
        { key: 'markdownImsize', config: {} },
        { key: 'markdownMark', config: {} },
        { key: 'markdownMultiTable', config: {} },
        { key: 'markdownSupsub', config: {} },
        { key: 'markdownTasklists', config: {} }
      ]
    },
    []
  ) as Promise<string>
}

afterEach(() => {
  try {
    for (const unmount of menuUnmounts.splice(0)) unmount()
    for (const editor of editors.splice(0)) editor.destroy()
    document.body.replaceChildren()
  } finally {
    restoreRangeGeometry?.()
  }
})

describe('Tiptap visual formats', () => {
  it('admits all native discovery menus after the mounted cold whoami settles, without rebinding retired identities', async () => {
    installRangeGeometry()
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => Response.json({ items: [{ id: 7, title: 'Target', path: 'target', locale: 'en', visibility: 'public', href: '/en/target' }] })
    })
    try {
      for (const boundary of ['account', 'epoch', 'authVersion', 'document'] as const) {
        const store = Vue.reactive({
          user: { id: 0, authVersion: 0, authenticated: false, permissions: [] as string[] },
          page: { id: 42, locale: 'en', path: 'guide' },
          editor: { editorKey: '', content: 'Unsaved draft', activeModal: '' },
          offlineIdentityEpoch: 0, authRefreshPending: true, authRefreshSettled: false,
          authRefreshOutcome: null as string | null
        })
        const dependencies = {
          Editor: VueEditor, markRaw: Vue.markRaw, wikiStore: store, siteLangs: ['en'],
          FORMATTING_TOOLS, ADMONITION_KINDS, VISUAL_MARKDOWN_GLYPHS,
          insertVisualMarkdownDefinitionList, insertVisualMarkdownGlyph, insertVisualMarkdownAdmonition, searchVisualMarkdownGlyphs,
          createTiptapExtensions, discoveredPageLinkContent, getVisualEditorDefinition, getVisualEditorStats,
          prepareTiptapMarkdown, prepareTiptapHtml, VisualEditorSource, installTiptapSlashMenu, EditorAdapterController,
          ...editorConflictEvents, ...editorInsertEvents
        }
        // Execute the owner's real mounted/unmount lifecycle and options against
        // the reactive session boundary; no copied discovery-owner implementation.
        const mountedCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(
          `${visualConstants}\nreturn { ${['data', 'methods', 'computed', 'watch', 'mounted', 'beforeUnmount'].map(visualOption).join(',')} }`
        )
        const behavior = new Function(...Object.keys(dependencies), mountedCode)(...Object.values(dependencies))
        const host = document.createElement('div')
        document.body.append(host)
        const app = Vue.createApp({
          ...behavior,
          emits: ['editor-adapter', 'editor-adapter-clear'],
          data() { return { ...behavior.data.call(this), format: 'markdown', wikiLinkOptions: enabledWikiLinks, save: () => {} } },
          render() {
            return Vue.h('div', { class: 'editor-tiptap', ref: 'root' }, [Vue.h(EditorContent, { editor: this.editor })])
          }
        })
        app.config.globalProperties.$t = translateEnglish
        app.mount(host)
        try {
          await Vue.nextTick()
          const editor = host.querySelector<HTMLElement & { __wikiEditor?: Editor }>('.editor-tiptap')!.__wikiEditor!
          expect(editor.getText()).toBe('Unsaved draft')
          const shortcut = () => {
            const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true })
            editor.view.dom.dispatchEvent(event)
            return event.defaultPrevented
          }
          expect(shortcut()).toBe(false)
          expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
          const whoami = Promise.withResolvers<void>()
          const settled = whoami.promise.then(() => {
            // A cold refresh may establish a new epoch before publishing its
            // verified profile and settled outcome.
            store.offlineIdentityEpoch = 1
            store.user = { id: 12, authVersion: 3, authenticated: true, permissions: ['write:pages'] }
            store.authRefreshPending = false
            store.authRefreshSettled = true
            store.authRefreshOutcome = 'authenticated'
          })
          whoami.resolve()
          await settled
          await Vue.nextTick()
          expect(editor.getText()).toBe('Unsaved draft')
          editor.commands.setContent('')
          expect(shortcut()).toBe(true)
          expect(document.getElementById(editor.view.dom.getAttribute('aria-controls')!)?.hidden).toBe(false)
          editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          typeVisualText(editor, '/')
          expect(document.getElementById(editor.view.dom.getAttribute('aria-controls')!)?.hidden).toBe(false)
          editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          expect(editor.getText()).toBe('/')
          editor.commands.setContent('')
          typeVisualText(editor, '[[')
          await nextEventLoopTurn()
          const menu = document.getElementById(editor.view.dom.getAttribute('aria-controls')!)!
          expect(menu.querySelector('button')?.getAttribute('aria-label')).toBe('Target')
          const stale = menu.querySelector<HTMLButtonElement>('button')!
          if (boundary === 'account') { store.user.id = 99; store.user.id = 12 }
          if (boundary === 'epoch') { store.offlineIdentityEpoch = 2; store.offlineIdentityEpoch = 1 }
          if (boundary === 'authVersion') { store.user.authVersion = 4; store.user.authVersion = 3 }
          if (boundary === 'document') { store.page.id = 43; store.page.id = 42 }
          stale.click()
          expect(menu.hidden).toBe(true)
          expect(editor.getText()).toBe('[[')
          editor.commands.setContent('')
          expect(shortcut()).toBe(false)
          typeVisualText(editor, '/')
          expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
          expect(editor.getText()).toBe('/')
        } finally {
          app.unmount()
          host.remove()
        }
      }
    } finally {
      Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
    }
  })

  it('inserts a definition list from the formatting Insert menu without losing the document', async () => {
    const mounted = mountInsertMenu()
    mounted.editor.commands.insertContent('Keep this paragraph.')
    mounted.editor.commands.setTextSelection(mounted.editor.state.doc.content.size)
    await mounted.choose('editor:markup.definitionListShort')
    expect(mounted.editor.getMarkdown()).toContain('Keep this paragraph.')
    expect(mounted.editor.getMarkdown()).toContain('Term\n: Definition')
  })

  it('returns from the emoji picker to the surviving Insert trigger on cancel and after insertion', async () => {
    const mounted = mountInsertMenu()
    mounted.editor.commands.insertContent('Existing text ')
    const original = mounted.editor.getMarkdown()
    const trigger = mounted.insertTrigger()
    await mounted.choose('editor:markup.glyphShort')
    const search = document.querySelector<HTMLInputElement>('.editor-tiptap-glyph-search input')!
    search.value = 'deploy'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await Vue.nextTick()
    document.querySelector<HTMLButtonElement>('.editor-tiptap-glyph-menu .wiki-close-control')!.click()
    await settleInsertMenu()
    expect(mounted.editor.getMarkdown()).toBe(original)
    expect(trigger.isConnected).toBe(true)
    expect(mounted.insertTrigger() === trigger, 'Cancel retains the original formatting Insert opener').toBe(true)
    expect(document.activeElement === trigger, 'Cancel returns focus to the formatting Insert opener').toBe(true)

    await mounted.choose('editor:markup.glyphShort')
    const reopened = document.querySelector<HTMLInputElement>('.editor-tiptap-glyph-search input')!
    expect(reopened.value).toBe('')
    reopened.value = 'deploy'
    reopened.dispatchEvent(new Event('input', { bubbles: true }))
    await Vue.nextTick()
    document.querySelector<HTMLButtonElement>('.editor-tiptap-glyph-button[title="Rocket"]')!.click()
    await settleInsertMenu()
    expect(mounted.editor.getMarkdown()).toContain('Existing text 🚀')
    expect(mounted.insertTrigger() === trigger, 'Insertion retains the original formatting Insert opener').toBe(true)
    expect(document.activeElement === trigger, 'Insertion returns focus to the formatting Insert opener').toBe(true)
  })

  it('submits the real admonition dialog opened from Insert into the current document', async () => {
    const mounted = mountInsertMenu()
    await mounted.choose('editor:markup.admonitionShort')
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="editor-tiptap-admonition-title"]')!
    const titleLabel = Array.from(dialog.querySelectorAll<HTMLLabelElement>('label[for]')).find(
      label => label.textContent?.trim() === translateEnglish('editor:editor.title')
    )
    const title = titleLabel?.control
    if (!(title instanceof HTMLInputElement)) throw new Error('The real admonition Title label is not associated with its input')
    title.value = 'Release window'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    const body = dialog.querySelector<HTMLTextAreaElement>('textarea')!
    body.value = 'Keep one replica online.'
    body.dispatchEvent(new Event('input', { bubbles: true }))
    await Vue.nextTick()
    const insert = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      button => button.textContent?.trim() === translateEnglish('common:actions.insert')
    )!
    expect(insert.disabled).toBe(false)
    insert.click()
    await settleInsertMenu()
    expect(mounted.editor.getMarkdown()).toContain('> **NOTE: Release window**')
    expect(mounted.editor.getMarkdown()).toContain('> Keep one replica online.')
  })

  it('keeps persisted editor keys stable across the engine replacement', () => {
    expect(getVisualEditorDefinition('html').editorKey).toBe('ckeditor')
    expect(getVisualEditorDefinition('markdown').editorKey).toBe('visual-markdown')
  })

  it('captures exact HTML source through pristine startup, selection changes, and Undo', async () => {
    const original =
      "<h2 id='saved-heading'> Saved heading</h2>\r\n<p>Original <a href='/home' class='saved-link'>link</a>.</p>\r\n<div class='table-container'><table><colgroup><col></col></colgroup><tbody><tr><td>Cell</td></tr></tbody></table></div><p>End</p>"
    const editor = createEditor('html', original)
    const created = new Promise<void>(resolve => editor.once('create', () => resolve()))
    const source = new VisualEditorSource(editor, 'html', original)
    const adapter = new EditorAdapterController({
      readText: () => source.readText(),
      writeText: text => source.replaceText(text),
      clearText: () => source.replaceText('')
    })
    editor.on('update', () => adapter.noteTextChange())
    adapter.initialize()

    // This legacy input is intentionally not the serializer's canonical output.
    expect(serializeVisualEditorData('html', editor)).not.toBe(original)
    expect(adapter.capture()).toEqual({ text: original, editVersion: 0 })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    await created
    expect(adapter.capture()).toEqual({ text: original, editVersion: 0 })
    expect(adapter.snapshot().nonPersisted).toBe(false)

    editor.commands.setLink({ href: '/chosen-page' })
    expect(adapter.capture().text).toContain('href="/chosen-page"')
    expect(adapter.snapshot().nonPersisted).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(adapter.capture().text).toBe(original)
    // Restoring equivalent content is not permission to acknowledge a version.
    expect(adapter.capture().editVersion).toBeGreaterThan(0)
    expect(adapter.snapshot().nonPersisted).toBe(true)
    adapter.destroy()
  })

  it('pairs discarded or replaced HTML with its exact source without hiding later native edits', async () => {
    const original = '<h2> Saved heading</h2>\r\n<p>Original draft baseline.</p>'
    const replacement = "<p class='server-source'> Replacement bytes &amp; spacing.</p>\r\n"
    const editor = createEditor('html', original)
    const created = new Promise<void>(resolve => editor.once('create', () => resolve()))
    const source = new VisualEditorSource(editor, 'html', original)
    const adapter = new EditorAdapterController({
      readText: () => source.readText(),
      writeText: text => source.replaceText(text),
      clearText: () => source.replaceText('')
    })
    editor.on('update', () => adapter.noteTextChange())
    adapter.initialize()

    editor.commands.insertContent('Unsaved link draft')
    const editedVersion = adapter.capture().editVersion
    adapter.replaceText(original, { detached: true })
    const discarded = adapter.capture()
    expect(discarded.text).toBe(original)
    expect(discarded.editVersion).toBeGreaterThan(editedVersion)
    expect(editor.getText()).not.toContain('Unsaved link draft')
    adapter.markPersisted(discarded.editVersion)
    expect(adapter.snapshot().nonPersisted).toBe(false)

    adapter.replaceText(replacement, { detached: true })
    const replaced = adapter.capture()
    expect(replaced.text).toBe(replacement)
    expect(editor.getText()).toContain('Replacement bytes & spacing.')
    adapter.markPersisted(replaced.editVersion)
    editor.commands.insertContent('Early native edit')
    // A deferred create callback must never reset the new document's baseline.
    await created
    expect(adapter.capture().text).toContain('Early native edit')
    expect(adapter.capture().text).not.toBe(replacement)
    expect(adapter.capture().editVersion).toBeGreaterThan(replaced.editVersion)
    adapter.markPersisted(replaced.editVersion)
    expect(adapter.snapshot().nonPersisted).toBe(true)

    adapter.clear()
    expect(adapter.capture().text).toBe('')
    expect(editor.getText()).toBe('')
    expect(adapter.snapshot().nonPersisted).toBe(true)
    adapter.destroy()
  })

  it('round-trips the Standard Markdown authoring surface', () => {
    const source = `# Visual Markdown

Paragraph with **bold**, *italic*, ~~strike~~, ==highlight==, H~2~O, x^2^, <kbd>Ctrl</kbd>, \`code\`, and [link](/docs).

- [x] Done
- [ ] Pending

| Name | Value |
| --- | --- |
| Alpha | One |

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

Term
: Definition
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()

    expect(output).toContain('==highlight==')
    expect(output).toContain('H~2~O')
    expect(output).toContain('x^2^')
    expect(output).toContain('<kbd>Ctrl</kbd>')
    expect(output).toContain('- [x] Done')
    expect(output).toContain('```mermaid')
    expect(output).toContain('Term\n: Definition')

    const reopened = createEditor('markdown', output)
    expect(reopened.getMarkdown()).toBe(output)
  })

  it('renders attributed quotes identically in source preview and the published Markdown renderer', async () => {
    const sources = [
      '> [name=Ada] Quoted **body** with [link](/safe).',
      '> [name=Ada]\n> Quoted **body** with [link](/safe).',
      '> [name=Ada]\n>\n> Quoted **body** with [link](/safe).',
      '> [name=Outer] First\n>\n> [name=Later] Literal\n>\n> > [name=Inner] Nested',
      '> [name=<img src=x onerror=alert(1)> **bold** https://evil.test "quoted" & [link\\](javascript:alert(1))] [Body](https://example.test) [Bad](javascript:alert(1))'
    ]
    for (const source of sources) {
      const preview = sanitizeWikiMarkdownHtml(createWikiMarkdownRenderer().render(source))
      expect(preview).toBe(sanitizeWikiMarkdownHtml(await renderServerMarkdown(source)))
      const document = new DOMParser().parseFromString(preview, 'text/html')
      expect(
        document.querySelectorAll('.quote-attribution a, .quote-attribution img, .quote-attribution strong, a[href^="javascript:"], [onerror]')
      ).toHaveLength(0)
    }
  })

  it('normalizes marker-only visual quotes and keeps author source syntax out of opaque nodes', () => {
    for (const source of ['> [name=Ada] Body', '> [name=Ada]\n> Body', '> [name=Ada]\n>\n> Body']) {
      const editor = createEditor('markdown', source)
      expect(editor.state.doc.firstChild?.attrs.author).toBe('Ada')
      expect(editor.state.doc.firstChild?.childCount).toBe(1)
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe('Body')
      expect(editor.getMarkdown()).toBe('> [name=Ada]\n> Body')
      expect(createEditor('markdown', editor.getMarkdown()).getJSON()).toEqual(editor.getJSON())
    }
    const author = '$E=mc^2$ {#identity} A^^|B'
    const editor = createEditor('markdown', `> [name=${author}] Body`)
    expect(editor.state.doc.firstChild?.attrs.author).toBe(author)
    expect(editor.getHTML()).not.toContain('wiki-source')
    expect(createEditor('markdown', editor.getMarkdown()).state.doc.firstChild?.attrs.author).toBe(author)

    const ordinary = createEditor('markdown', '> First\n>\n> [name=Later] Literal\n>\n> `[name=Code]`\n>\n> > [name=Inner] Nested')
    expect(ordinary.state.doc.firstChild?.attrs.author).toBeNull()
    expect(ordinary.state.doc.firstChild?.child(1).textContent).toBe('[name=Later] Literal')
    expect(ordinary.state.doc.firstChild?.child(2).firstChild?.marks.some(mark => mark.type.name === 'code')).toBe(true)
    expect(ordinary.state.doc.firstChild?.lastChild?.attrs.author).toBe('Inner')
    expect(createEditor('markdown', ordinary.getMarkdown()).getJSON()).toEqual(ordinary.getJSON())
  })

  it('keeps attribution native through visual body edits, canonical Markdown serialization and reopen', async () => {
    const author = '<img src=x onerror=alert(1)> **bold** https://evil.test "quoted" & [link](javascript:alert(1))'
    const source =
      '> [name=<img src=x onerror=alert(1)> **bold** https://evil.test "quoted" & [link\\](javascript:alert(1))] Body [link](/safe)\n>\n> > [name=Inner] Nested'
    const editor = createEditor('markdown', source)
    const pairedSource = new VisualEditorSource(editor, 'markdown', source)
    const quote = editor.state.doc.firstChild!
    expect(quote.type.name).toBe('blockquote')
    expect(quote.attrs.author).toBe(author)
    expect(quote.firstChild?.textContent).toBe('Body link')
    expect(quote.lastChild?.type.name).toBe('blockquote')
    expect(quote.lastChild?.attrs.author).toBe('Inner')
    expect(quote.lastChild?.firstChild?.textContent).toBe('Nested')
    const outerQuote = editor.view.dom.querySelector(':scope > blockquote')
    const byline = outerQuote?.querySelector<HTMLElement>(':scope > .quote-attribution')
    expect(byline?.textContent).toBe(author)
    // JSDOM does not reflect contentEditable into an HTML attribute.
    expect(byline?.contentEditable).toBe('false')
    expect(byline?.querySelectorAll('img, a, strong, [onerror]')).toHaveLength(0)
    const innerQuote = outerQuote?.querySelector('blockquote')
    expect(innerQuote?.querySelector(':scope > .quote-attribution')?.textContent).toBe('Inner')

    editor.commands.setTextSelection(findTextblockEnd(editor, 'Body link', 'blockquote')! - 'Body link'.length)
    editor.commands.insertContent('Edited ')
    const output = pairedSource.readText()
    expect(output).toContain(
      '> [name=<img src=x onerror=alert(1)> **bold** https://evil.test "quoted" & [link\\](javascript:alert(1))]\n> Edited Body [link](/safe)'
    )
    const reopened = createEditor('markdown', output)
    expect(reopened.state.doc.firstChild?.attrs.author).toBe(author)
    expect(reopened.state.doc.firstChild?.firstChild?.textContent).toBe('Edited Body link')
    expect(reopened.state.doc.firstChild?.lastChild?.attrs.author).toBe('Inner')
    expect(reopened.state.doc.firstChild?.lastChild?.firstChild?.textContent).toBe('Nested')
    const reopenedQuote = reopened.view.dom.querySelector(':scope > blockquote')
    expect(reopenedQuote?.querySelector(':scope > .quote-attribution')?.textContent).toBe(author)
    const reopenedInnerQuote = reopenedQuote?.querySelector('blockquote')
    expect(reopenedInnerQuote?.querySelector(':scope > .quote-attribution')?.textContent).toBe('Inner')
    expect(reopened.getMarkdown()).toBe(output)
    expect(reopened.getJSON()).toEqual(editor.getJSON())

    const rendered = new DOMParser().parseFromString(await renderServerMarkdown(output), 'text/html')
    const renderedQuote = rendered.body.querySelector(':scope > blockquote')
    expect(renderedQuote?.getAttribute('data-quote-author')).toBe(author)
    expect(renderedQuote?.querySelector(':scope > .quote-attribution')?.textContent).toBe(author)
    expect(renderedQuote?.querySelector(':scope > p > a')?.getAttribute('href')).toBe('/safe')
    const renderedInnerQuote = renderedQuote?.querySelector('blockquote')
    expect(renderedInnerQuote?.getAttribute('data-quote-author')).toBe('Inner')
    expect(renderedInnerQuote?.querySelector(':scope > .quote-attribution')?.textContent).toBe('Inner')
    expect(renderedInnerQuote?.querySelector(':scope > p:not(.quote-attribution)')?.textContent).toBe('Nested')
    expect(rendered.querySelectorAll('img, [onerror], a[href^="javascript:"]')).toHaveLength(0)
  })

  it('preserves quote author attributes and a separate inert byline through HTML editing and reopen', () => {
    const source =
      '<blockquote data-quote-author="Ada &amp; &quot;Grace&quot;"><p>Body <a href="/safe">link</a></p><p class="quote-attribution"><span>Ada &amp; "Grace"</span></p></blockquote>'
    const editor = createEditor('html', source)
    expect(editor.state.doc.firstChild?.attrs.author).toBe('Ada & "Grace"')
    expect(editor.state.doc.firstChild?.childCount).toBe(1)
    editor.commands.setTextSelection(findTextblockEnd(editor, 'Body link', 'blockquote')!)
    editor.commands.insertContent(' edited')
    const output = serializeVisualEditorData('html', editor)
    const reopened = createEditor('html', output)
    expect(reopened.getJSON()).toEqual(editor.getJSON())
    const rendered = new DOMParser().parseFromString(output, 'text/html')
    expect(rendered.querySelectorAll('blockquote > .quote-attribution')).toHaveLength(1)
    expect(rendered.querySelector('blockquote > .quote-attribution')?.textContent).toBe('Ada & "Grace"')
    expect(rendered.querySelector('blockquote > p')?.textContent).toBe('Body link edited')
    expect(rendered.querySelector('blockquote > div')).toBeNull()
  })

  it('preserves every extended dialect family through source-backed nodes', async () => {
    const source = `# Dialect {#dialect .reference}

HTML is an abbreviation.[^note]

*[HTML]: Hyper Text Markup Language

[^note]: A footnote with **formatting**.

An image ![Sized](/assets/image.png =120x80) and inline math $E=mc^2$.

$$
a^2 + b^2 = c^2
$$

<div class="raw-widget">Raw <strong>HTML</strong></div>

| A | B |
| --- | --- |
| one \\ | continued |
| ^^ | rowspan |
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()

    expect(output).toContain('{#dialect .reference}')
    expect(output).toContain('[^note]')
    expect(output).toContain('*[HTML]: Hyper Text Markup Language')
    expect(output).toContain('[^note]: A footnote with **formatting**.')
    expect(output).toContain('![Sized](/assets/image.png =120x80)')
    expect(output).toContain('$E=mc^2$')
    expect(output).toContain('a^2 + b^2 = c^2')
    expect(output).toContain('<div class="raw-widget">Raw <strong>HTML</strong></div>')
    expect(output).toContain('| ^^ | rowspan |')

    const reopened = createEditor('markdown', output)
    expect(reopened.getMarkdown()).toBe(output)
    expect(await renderServerMarkdown(output)).toBe(await renderServerMarkdown(source))
  })

  it('preserves unsupported table source through unrelated visual edits and reopening without disabling ordinary tables', async () => {
    const preview = createWikiMarkdownRenderer()
    const fixtures: Array<[string, boolean]> = [
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A || B |', true],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A |||', true],
      ['| H1 | H2 |\n| --- | --- |\n| A | B |\n| ^^ | C |', true],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A | B | C |', false],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A {.cell #a} || [B](/en/target){target=_blank} |', true],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A {colspan=2 rowspan=2} | B | C |', true],
      ['| H1 | H2 |\n| --- | --- |\n| A | literal | `B|C` |', true],
      ['| H1 | H2 |\n| - | not-a-separator |\n| A || B |', false],
      ['A {.cell #a}\n\n[B](/en/target){target=_blank}\n\n`| A || B |`', false],
      ['| H1 | H2 |\n| --- | --- |\n| A \\| literal | `B|C` |', true]
    ]
    const tables = (html: string) => cheerio.load(html)('table').toString()
    for (const [original, opaque] of fixtures) {
      const editor = createEditor('markdown', original)
      const source = new VisualEditorSource(editor, 'markdown', original)
      if (opaque) expect(editor.state.doc.firstChild?.type.name).toBe('wikiSourceBlock')
      else if (original.includes('| --- |')) expect(editor.state.doc.firstChild?.type.name).toBe('table')
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: 'Unrelated edit' }] })
      const edited = source.readText()
      expect(edited).toContain('Unrelated edit')
      if (opaque) expect(edited).toContain(original)
      const reopened = createEditor('markdown', edited)
      const saved = new VisualEditorSource(reopened, 'markdown', edited).readText()
      for (const output of [edited, saved]) {
        expect(tables(preview.render(output))).toBe(tables(preview.render(original)))
        expect(tables(await renderServerMarkdown(output))).toBe(tables(await renderServerMarkdown(original)))
      }
    }
  })

  it('renders native preview spans and attrs before applying the existing sanitizer policy', () => {
    const preview = createWikiMarkdownRenderer()
    for (const [input, span] of [
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A || B |', '2'],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A |||', '3'],
      ['| H1 | H2 | H3 |\n| --- | --- | --- |\n| A {.cell #a} || [B](/en/target){target=_blank} |', '2']
    ] as const) {
      const raw = preview.render(input)
      const $ = cheerio.load(raw)
      expect($('tbody td').first().text()).toBe('A')
      expect($('tbody td').first().attr('colspan')).toBe(span)
      expect($('tbody td').toArray().map(cell => $(cell).text())).toEqual(span === '3' ? ['A'] : ['A', 'B'])
      if (input.includes('#a')) {
        expect($('td#a.cell')).toHaveLength(1)
        expect($('a[href="/en/target"]').attr('target')).toBe('_blank')
        const safe = cheerio.load(sanitizeWikiMarkdownHtml(raw))
        expect(safe('td#a.cell').attr('colspan')).toBe('2')
        expect(safe('a[href="/en/target"]').text()).toBe('B')
        expect(safe('a').attr('target')).toBeUndefined()
      }
    }
  })

  it('preserves HTML table groups, spans and attrs as inert source through unrelated edits and reopening', async () => {
    const rendered = await renderServerMarkdown('| H1 | H2 | H3 |\n| --- | --- | --- |\n| A {.cell #a} || [B](/en/target){target=_blank} |')
    for (const original of [
      rendered,
      await renderServerMarkdown('| H1 | H2 | H3 |\n| --- | --- | --- |\n| A | B | C |'),
      '<table data-layout="authored"><tbody><tr data-row="first"><td rowspan="2" headers="h1" class="cell" id="a">A<!--keep--></td><td>B</td></tr><tr><td>C</td></tr></tbody></table>'
    ]) {
      const editor = createEditor('html', original)
      expect(editor.state.doc.firstChild?.type.name).toBe('wikiSourceBlock')
      expect(editor.view.dom.querySelector('table')).toBeNull()
      const source = new VisualEditorSource(editor, 'html', original)
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: 'Unrelated edit' }] })
      const edited = source.readText()
      const table = (html: string) => {
        const element = new DOMParser().parseFromString(html, 'text/html').querySelector('table')
        if (!element) return null
        // Ignore only formatter indentation, not row groups, attrs or cell text.
        for (const parent of [element, ...element.querySelectorAll('*')]) {
          for (const child of [...parent.childNodes]) {
            if (child.nodeType === 3 && !child.textContent?.trim()) child.remove()
          }
        }
        return element.outerHTML
      }
      expect(table(edited)).toBe(table(original))
      expect(edited).toContain('Unrelated edit')
      const reopened = createEditor('html', edited)
      expect(table(new VisualEditorSource(reopened, 'html', edited).readText())).toBe(table(original))
    }
    const editable = createEditor('html', '<table><tbody><tr><td><p>Editable</p></td></tr></tbody></table>')
    expect(editable.state.doc.firstChild?.type.name).toBe('table')
  })

  it('renders the complete Markdown editor dialect after a visual round trip', () => {
    const source = `# Dialect {#dialect .reference}

"Smart quotes" -- autolink https://example.com, [reference][guide], and emoji :rocket:.
First line
second line with ==mark==, H~2~O, x^2^, <kbd>Ctrl</kbd>, and a	tab.[^note]

- [x] Complete

HTML
: Hyper Text Markup Language

*[HTML]: Hyper Text Markup Language

[^note]: Footnote **body**.

![Sized](/assets/image.png =120x80)

Inline math $E=mc^2$.

$$
a^2 + b^2 = c^2
$$

<div class="raw-widget">Raw <strong>HTML</strong></div>

| A | B |
| --- | --- |
| one \\ | continued |
| ^^ | rowspan |

## Tabs {.tabset}

### First

Tab content.

[guide]: /guide "Guide"

\`\`\`plantuml
Alice -> Bob
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()
    const sourceRenderer = createWikiMarkdownRenderer()
    const visualRenderer = createWikiMarkdownRenderer()

    expect(visualRenderer.render(output)).toBe(sourceRenderer.render(source))
    expect(visualRenderer.render(output)).toContain('/_assets/svg/twemoji/1f680.svg')
    expect(visualRenderer.render(output)).toContain('class="katex"')
    expect(visualRenderer.render(output)).toContain('class="footnotes')
    expect(visualRenderer.render(output)).toContain('rowspan="2"')
  })

  it('round-trips enabled wikilinks as ordinary safe anchors in both Markdown surfaces', () => {
    const source = '[[target]] [[target|label]] [[target#section]] [[#section]]'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const output = editor.getMarkdown()
    const editorHtml = editor.getHTML()
    const previewHtml = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(output).toBe(source)
    expect(editorHtml).toContain('href="/en/guide/target"')
    expect(editorHtml).toContain('href="/en/guide/target#section"')
    expect(editorHtml).toContain('href="#section"')
    expect(editorHtml).not.toContain('wikiLinkSource')
    expect(previewHtml).toContain('href="/en/guide/target"')
    expect(previewHtml).toContain('href="/en/guide/target#section"')
    expect(previewHtml).toContain('href="#section"')
    expect(resolveWikiLinkHref('[[target#section]]', enabledWikiLinks.context)).toBe('/en/guide/target#section')
    expect(resolveWikiLinkHref('[[file.name]]', enabledWikiLinks.context)).toBe('/en/guide/file%2Ename')
  })

  it('keeps discovered routes correct across enabled, disabled, private and cross-locale Markdown links', () => {
    for (const fixture of [
      { options: enabledWikiLinks, page: { visibility: 'public', locale: 'en', href: '/en/target' }, source: '[[/target|Target]]' },
      { options: { enabled: false }, page: { visibility: 'public', locale: 'en', href: '/en/target' }, source: '[Target](/en/target)' },
      { options: enabledWikiLinks, page: { visibility: 'private', locale: 'en', href: '/_private/en/target' }, source: '[Target](/_private/en/target)' },
      { options: enabledWikiLinks, page: { visibility: 'public', locale: 'fr', href: '/fr/target' }, source: '[Target](/fr/target)' }
    ] as const) {
      const editor = createEditor('markdown', '', fixture.options)
      editor.commands.insertContent(discoveredPageLinkContent({ id: 1, title: 'Target', path: 'target', ...fixture.page }, 'markdown', fixture.options))
      expect(editor.getMarkdown()).toBe(fixture.source)
      expect(editor.getHTML()).toContain(`href="${fixture.page.href}"`)
      const reopened = createEditor('markdown', editor.getMarkdown(), fixture.options)
      expect(reopened.getMarkdown()).toBe(fixture.source)
      expect(reopened.getHTML()).toContain(`href="${fixture.page.href}"`)
    }
  })

  it('renders wikilink labels as escaped text', () => {
    const source = '[[target|<img src=x onerror=alert(1)> & text]]'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const preview = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(editor.getHTML()).not.toContain('<img')
    expect(preview).not.toContain('<img')
    expect(preview).toContain('&lt;img')
    expect(preview).toContain('&amp;')
  })

  it('keeps wikilinks disabled by default', () => {
    const source = '[[target]]'
    const editor = createEditor('markdown', source)
    const preview = createWikiMarkdownRenderer().render(source)

    expect(editor.getMarkdown()).toBe(source)
    expect(editor.getHTML()).not.toContain('<a')
    expect(preview).not.toContain('<a')
  })

  it('leaves Markdown citations, code, HTML attributes, and unsafe malformed wikilinks untouched', () => {
    const source = 'Citation [[1]](https://example.com), inline `[[target]]`.\n\n```md\n[[target]]\n```'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const preview = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(editor.getMarkdown()).toContain('[[1]](https://example.com)')
    expect(editor.getMarkdown()).toContain('`[[target]]`')
    expect(editor.getMarkdown()).toContain('[[target]]')
    expect(preview).toContain('href="https://example.com"')
    expect(preview).not.toContain('href="/en/guide/target"')
    expect(preview).toContain('<code>[[target]]</code>')

    const htmlAttribute = createWikiMarkdownRenderer(enabledWikiLinks).render('<span data-source="[[target]]">literal</span>')
    expect(htmlAttribute).toContain('data-source="[[target]]"')
    expect(htmlAttribute).not.toContain('href="/en/guide/target"')

    const malformed = '[[javascript:alert(1)]] [[//evil.example]] [[target#]] [[target|one|two]]'
    expect(parseWikiLinkAt('[[1]](https://example.com)')).toBeNull()
    expect(parseWikiLinkAt('[[target]][reference]')).toBeNull()
    expect(parseWikiLinkAt('[[target]][[next]]')?.raw).toBe('[[target]]')
    for (const candidate of malformed.split(' ')) expect(parseWikiLinkAt(candidate)).toBeNull()
    const malformedEditor = createEditor('markdown', malformed, enabledWikiLinks)
    const malformedPreview = createWikiMarkdownRenderer(enabledWikiLinks).render(malformed)
    expect(malformedEditor.getMarkdown()).toContain(malformed)
    expect(malformedPreview).toContain(malformed)
    expect(malformedPreview).not.toContain('href="javascript:')
    expect(malformedPreview).not.toContain('href="//evil.example')
  })

  it('falls back to an ordinary Markdown link when a wikilink label is edited', () => {
    const editor = createEditor('markdown', '[[target|label]]', enabledWikiLinks)

    const link = editor.state.doc.firstChild?.firstChild
    expect(link?.type.name).toBe('wikiLink')
    editor.commands.setTextSelection({ from: 2, to: 2 + (link?.content.size ?? 0) })
    editor.commands.insertContent('Changed label')

    expect(editor.getMarkdown()).toContain('[Changed label](/en/guide/target)')
    expect(editor.getMarkdown()).not.toContain('[[target|label]]')
  })

  it('progresses through definition terms and descriptions without dropping existing entries', () => {
    const editor = createEditor('markdown', 'Term\n: Definition')
    const termEnd = findTextblockEnd(editor, 'Term', 'definitionList')
    expect(termEnd).not.toBeNull()
    editor.commands.setTextSelection(termEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(selectionHasAncestor(editor, 'definitionDescription')).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe('Definition')

    const definitionEnd = findTextblockEnd(editor, 'Definition', 'definitionDescription')
    expect(definitionEnd).not.toBeNull()
    editor.commands.setTextSelection(definitionEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe('definitionTerm')
    expect(editor.state.selection.$from.parent.textContent).toBe('')

    expect(pressEnter(editor)).toBe(true)
    expect(selectionHasAncestor(editor, 'definitionDescription')).toBe(true)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(selectionHasAncestor(editor, 'definitionList')).toBe(false)
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.text).toBe('Term')
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2)
  })

  it('moves to an existing next term and keeps nested, multi-paragraph definitions editable', () => {
    const nextTermEditor = createEditor('markdown', 'Term\n: Definition\n\nNext\n: Explanation')
    const definitionEnd = findTextblockEnd(nextTermEditor, 'Definition', 'definitionDescription')
    expect(definitionEnd).not.toBeNull()
    nextTermEditor.commands.setTextSelection(definitionEnd!)
    expect(pressEnter(nextTermEditor)).toBe(true)
    expect(nextTermEditor.state.selection.$from.parent.type.name).toBe('definitionTerm')
    expect(nextTermEditor.state.selection.$from.parent.textContent).toBe('Next')

    const source =
      '<dl><dt>Term</dt><dd><p>First paragraph</p><p>Second paragraph</p><ul><li><p>Nested item</p></li></ul></dd><dd><p>Alternate definition</p></dd></dl>'
    const editor = createEditor('html', source)
    const firstParagraphEnd = findTextblockEnd(editor, 'First paragraph', 'definitionDescription')
    expect(firstParagraphEnd).not.toBeNull()
    editor.commands.setTextSelection(firstParagraphEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.getText()).toContain('First paragraph')
    expect(editor.getText()).toContain('Second paragraph')
    expect(editor.getText()).toContain('Nested item')
    expect(editor.getText()).toContain('Alternate definition')
    const list = editor.getJSON().content?.[0]
    expect(list?.content?.filter(child => child.type === 'definitionDescription')).toHaveLength(2)
  })

  it('sanitizes the renderer shared by both Markdown previews', () => {
    const markdown = createWikiMarkdownRenderer()
    const preview = sanitizeWikiMarkdownHtml(markdown.render('<img src=x onerror=alert(1)><script>alert(2)</script>'))

    expect(preview).toContain('<img src="x">')
    expect(preview).not.toContain('onerror')
    expect(preview).not.toContain('<script')
  })

  it('keeps code fence presentation metadata in the shared preview renderer', () => {
    const markdown = createWikiMarkdownRenderer()
    const preview = sanitizeWikiMarkdownHtml(markdown.render('```ts title="src/main.ts" linesStart=30 linesHighlight="31,30"\nfirst\nsecond\n```'))

    expect(preview).toContain('<figure class="codeblock-framed">')
    expect(preview).not.toContain('data-source-line')
    expect(preview).toContain('<figcaption class="codeblock-title">src/main.ts</figcaption>')
    expect(preview).toContain('class="prismjs language-ts line-numbers"')
    expect(preview).toContain('data-start="30"')
    expect(preview).toContain('data-line-offset="29"')
    expect(preview).toContain('data-line="30-31"')
  })

  it('applies visual marks and inserts canonical definition lists', () => {
    const editor = createEditor('markdown', 'Important H2O x2 Ctrl')

    editor.commands.setTextSelection({ from: 1, to: 10 })
    editor.commands.toggleHighlight()
    editor.commands.setTextSelection({ from: 12, to: 13 })
    editor.commands.toggleSubscript()
    editor.commands.setTextSelection({ from: 16, to: 17 })
    editor.commands.toggleSuperscript()
    editor.commands.setTextSelection({ from: 18, to: 22 })
    editor.commands.toggleMark('keyboard')
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertVisualMarkdownDefinitionList(editor)

    const output = editor.getMarkdown()
    expect(output).toContain('==Important== H~2~O x^2^ <kbd>Ctrl</kbd>')
    expect(output).toContain('Term\n: Definition')
  })

  it('inserts canonical admonitions and local glyphs', () => {
    const editor = createEditor('markdown', '')
    const canonical = '> **WARNING: Deployment window**\n>\n> Restart one node at a time.'
    insertVisualMarkdownAdmonition(editor, {
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    insertVisualMarkdownGlyph(editor, VISUAL_MARKDOWN_GLYPHS.find(glyph => glyph.label === 'Rocket')!)

    expect(editor.getMarkdown()).toContain(canonical.trim())
    expect(editor.getMarkdown()).toContain('🚀')
  })

  it('offers unique glyph choices with semantic and typo-tolerant search', () => {
    expect(new Set(VISUAL_MARKDOWN_GLYPHS.map(glyph => glyph.value)).size).toBe(VISUAL_MARKDOWN_GLYPHS.length)
    expect(searchVisualMarkdownGlyphs('celebrte')[0]?.label).toBe('Celebrate')
    expect(searchVisualMarkdownGlyphs('deploy')[0]?.label).toBe('Rocket')
    expect(searchVisualMarkdownGlyphs('secure')[0]?.label).toBe('Lock')
    const shapes = searchVisualMarkdownGlyphs('shape', 'icon')
    expect(shapes.map(glyph => glyph.value)).toEqual(expect.arrayContaining(['◆', '●', '■']))
    expect(shapes.every(glyph => glyph.category === 'icon')).toBe(true)
    expect(searchVisualMarkdownGlyphs('zzqxy')).toEqual([])
  })

  it('keeps both serializers independent of canvas theme and layout classes', () => {
    const fixtures: Array<{ format: VisualEditorFormat; source: string }> = [
      { format: 'markdown', source: '# Themed heading\n\nBody with **meaning**.' },
      { format: 'html', source: '<h1>Themed heading</h1><p>Body with <strong>meaning</strong>.</p>' }
    ]

    for (const fixture of fixtures) {
      const editor = createEditor(fixture.format, fixture.source)
      const serialized = serializeVisualEditorData(fixture.format, editor)

      const element = editor.options.element
      if (!(element instanceof HTMLElement)) throw new Error('The editor fixture must use an HTML mount element')
      element.classList.add('contents', 'editor-page-canvas')

      expect(serializeVisualEditorData(fixture.format, editor)).toBe(serialized)
    }
  })

  it('edits real sized image nodes without rewriting titles or unrelated source classes', () => {
    const source = '![A diagram](/assets/diagram.png "Architecture" =120x80){.align-right .keep-me .wiki-image-border}'
    const editor = createEditor('markdown', source)
    expect(editor.state.doc.firstChild?.type.name).toBe('image')
    expect(editor.getMarkdown()).toBe(source)

    editor.commands.setNodeSelection(0)
    editor.commands.updateAttributes('image', { width: '50%', class: 'keep-me align-center wiki-image-shadow' })
    const updated = editor.getMarkdown()
    expect(updated).toContain('"Architecture" =50%x80')
    expect(updated).toContain('keep-me')
    expect(updated).toContain('align-center')
    expect(updated).toContain('wiki-image-shadow')
    expect(updated).not.toContain('align-right')
    const reopened = createEditor('markdown', updated)
    expect(reopened.state.doc.firstChild?.attrs.width).toBe('50%')
    expect(reopened.state.doc.firstChild?.attrs.class).toContain('keep-me')
  })

  it('keeps supported HTML image properties editable and unknown image attributes opaque', () => {
    const supported = '<img src="/assets/photo.png" alt="Photo" width="160" height="auto" class="align-abstopright wiki-image-rounded" style="width:160px">'
    const editor = createEditor('markdown', supported)
    expect(editor.state.doc.firstChild?.type.name).toBe('image')
    expect(editor.getMarkdown()).toBe(supported)
    editor.commands.setNodeSelection(0)
    editor.commands.updateAttributes('image', { alt: 'Updated photograph', width: '320' })
    const edited = editor.getMarkdown()
    expect(edited).toContain('alt="Updated photograph"')
    expect(edited).toContain('width="320"')
    expect(edited).toContain('width:320px')
    expect(edited).toContain('align-abstopright wiki-image-rounded')
    editor.commands.updateAttributes('image', { alt: '' })
    expect(editor.getMarkdown()).toContain('alt=""')

    const withoutAlt = createEditor('markdown', '<img src="/assets/photo.png">')
    withoutAlt.commands.setNodeSelection(0)
    withoutAlt.commands.updateAttributes('image', { alt: 'New description' })
    expect(withoutAlt.getMarkdown()).toContain('alt="New description"')

    const unknown = '<img src="/assets/photo.png" data-custom="keep exactly" class="foreign" style="object-fit:contain">'
    for (const format of ['markdown', 'html'] as const) {
      const opaque = createEditor(format, unknown)
      expect(opaque.state.doc.firstChild?.type.name).toBe('wikiSourceBlock')
      expect(serializeVisualEditorData(format, opaque)).toContain(unknown)
    }
  })

  it('executes filtered slash commands through native keyboard and pointer actions', () => {
    for (const format of ['markdown', 'html'] as const) {
      const editor = createEditor(format, '')
      installTiptapSlashMenu(
        editor,
        [
          { id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: (chain: ChainedCommands) => chain.setHeading({ level: 2 }) },
          {
            id: 'table',
            label: 'Table',
            icon: 'mdi-table',
            hint: '|',
            run: (chain: ChainedCommands) => chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
          }
        ],
        'Insert'
      )
      typeVisualText(editor, '/')
      typeVisualText(editor, 'heading')
      editor.view.dispatch(closeHistory(editor.state.tr))
      expect(pressEnter(editor)).toBe(true)
      expect(editor.state.doc.firstChild?.type.name).toBe('heading')
      expect(editor.state.doc.firstChild?.attrs.level).toBe(2)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
      expect(editor.getText()).toBe('/heading')

      editor.commands.setContent('')
      typeVisualText(editor, '/')
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(pressEnter(editor)).toBe(true)
      expect(editor.state.doc.firstChild?.type.name).toBe('table')

      editor.commands.setContent('')
      typeVisualText(editor, '/')
      typeVisualText(editor, 'table')
      const menu = document.querySelector<HTMLElement>(`#${editor.view.dom.getAttribute('aria-controls')}`)
      expect(menu?.hidden).toBe(false)
      menu?.querySelector<HTMLButtonElement>('button')?.click()
      expect(editor.state.doc.firstChild?.type.name).toBe('table')
      expect(editor.state.doc.firstChild?.childCount).toBe(2)
      editor.destroy()
    }
  })

  it('keeps command labels and hints inert and preserves the focused choice across viewport events', () => {
    const editor = createEditor('markdown', '')
    const label = '<img src=x onerror=alert(1)> Heading'
    const hint = '<svg onload=alert(1)>'
    const dispose = installTiptapSlashMenu(
      editor,
      [
        { id: 'heading', label, icon: 'mdi-format-header-2', hint, run: chain => chain.setHeading({ level: 2 }) },
        { id: 'quote', label: 'Quote', icon: 'mdi-format-quote-close', hint: '>', run: chain => chain.setBlockquote() }
      ],
      'Insert'
    )
    typeVisualText(editor, '/')
    const menu = document.getElementById(editor.view.dom.getAttribute('aria-controls')!)!
    const first = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    expect(first.getAttribute('aria-label')).toBe(label)
    expect(first.textContent).toContain(label)
    expect(first.textContent).toContain(hint)
    expect(first.querySelector('img, svg, script')).toBeNull()
    expect(first.querySelector('.mdi')?.getAttribute('aria-hidden')).toBe('true')
    expect(first.querySelector('.editor-tiptap-slash-hint')?.getAttribute('aria-hidden')).toBe('true')
    const quote = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!
    quote.focus()
    quote.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(quote)
    // No geometry assertions: resize and scroll may reposition, not retire a focused command.
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('scroll'))
    expect(document.activeElement).toBe(quote)
    expect(menu.querySelectorAll('[role="menuitem"]')[1]).toBe(quote)
    expect(editor.getText()).toBe('/')
    quote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(editor.state.doc.firstChild?.type.name).toBe('blockquote')
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('paragraph')
    // getText() includes block separators for the nested and trailing paragraphs.
    expect(editor.state.doc.textContent).toBe('')
    dispose()
    expect(menu.isConnected).toBe(false)
    expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(editor.view.dom.hasAttribute('aria-activedescendant')).toBe(false)
    window.dispatchEvent(new Event('resize'))
    editor.commands.setContent('')
    typeVisualText(editor, '/')
    expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
    expect(editor.getText()).toBe('/')
  })

  it('keeps unmatched slash input editable and lets Tab leave without executing a command', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(
      editor,
      [{ id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) }],
      'Insert',
      'No commands'
    )
    typeVisualText(editor, '/')
    typeVisualText(editor, 'absent')
    const menu = document.getElementById(editor.view.dom.getAttribute('aria-controls')!)!
    expect(menu.querySelector('[role="status"]')?.textContent).toBe('No commands')
    expect(menu.querySelector('[role="menuitem"]')).toBeNull()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(menu.hidden).toBe(true)
    expect(editor.getText()).toBe('/absent')
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
  })

  it('maps an active slash line past unrelated document edits and refuses replaced queries', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(
      editor,
      [{ id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) }],
      'Insert'
    )
    typeVisualText(editor, '/')
    const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text('Remote paragraph'))
    editor.view.dispatch(editor.state.tr.insert(0, paragraph))
    const menuId = editor.view.dom.getAttribute('aria-controls')
    expect(menuId).not.toBeNull()
    const menu = document.getElementById(menuId!)!
    expect(menu.hidden).toBe(false)
    const button = menu.querySelector<HTMLButtonElement>('button')
    expect(button).not.toBeNull()
    button!.click()
    expect(editor.state.doc.firstChild?.textContent).toBe('Remote paragraph')
    const mappedBlock = editor.state.doc.nodeAt(paragraph.nodeSize)
    expect(mappedBlock?.type.name).toBe('heading')
    expect(mappedBlock?.attrs.level).toBe(2)
    expect(mappedBlock?.textContent).toBe('')

    editor.commands.setContent('')
    typeVisualText(editor, '/')
    const staleButton = document.querySelector<HTMLButtonElement>('.editor-tiptap-slash-menu button')
    editor.view.dispatch(editor.state.tr.insertText('other', editor.state.selection.from))
    staleButton?.click()
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.getText()).toBe('/other')
  })

  it('dismisses slash suggestions without consuming source during Escape, IME or read-only transitions', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(
      editor,
      [{ id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) }],
      'Insert'
    )
    typeVisualText(editor, '/')
    const menu = document.querySelector<HTMLElement>('.editor-tiptap-slash-menu')!
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(menu.hidden).toBe(true)
    expect(editor.getText()).toBe('/')

    editor.commands.setContent('')
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeVisualText(editor, '/')
    expect(menu.hidden).toBe(true)
    expect(editor.getText()).toBe('/')
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))

    // A fresh editor avoids depending on the browser's deferred composition-end timer.
    const readonly = createEditor('html', '')
    installTiptapSlashMenu(
      readonly,
      [{ id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) }],
      'Insert'
    )
    typeVisualText(readonly, '/')
    const activeMenu = document.querySelector<HTMLElement>(`#${readonly.view.dom.getAttribute('aria-controls')}`)!
    const staleButton = activeMenu.querySelector<HTMLButtonElement>('button')
    readonly.setEditable(false)
    staleButton?.click()
    expect(activeMenu.hidden).toBe(true)
    expect(readonly.getText()).toBe('/')
    readonly.setEditable(true)
    expect(activeMenu.hidden).toBe(true)
    readonly.destroy()
    expect(activeMenu.isConnected).toBe(false)
  })

  it('does not trigger a slash menu in code, nested lists, or a replaced selection', () => {
    for (const fixture of [
      { source: '<pre><code></code></pre>', position: 1 },
      { source: '<ul><li><p></p></li></ul>', position: 3 },
      { source: '<p>Replace</p>', position: { from: 1, to: 8 } }
    ]) {
      const editor = createEditor('html', fixture.source)
      installTiptapSlashMenu(
        editor,
        [{ id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) }],
        'Insert'
      )
      editor.commands.setTextSelection(fixture.position)
      typeVisualText(editor, '/')
      expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
      expect(editor.getText()).toContain('/')
    }
  })

  it('opens full Ctrl+Space commands only at an empty root and inline-safe commands mid-line', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(editor, [
      { id: 'heading', label: 'Heading', icon: 'mdi-format-header-2', hint: 'H2', run: chain => chain.setHeading({ level: 2 }) },
      { id: 'star', label: 'Star', icon: 'mdi-star', hint: '★', inlineSafe: true, run: chain => chain.insertContent('★') }
    ], 'Insert')
    const shortcut = () => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true })
      editor.view.dom.dispatchEvent(event)
      return event
    }
    expect(shortcut().defaultPrevented).toBe(true)
    const menu = editor.view.dom.parentElement!.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.querySelectorAll('button')).toHaveLength(2)
    typeVisualText(editor, 'heading')
    expect(pressEnter(editor)).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe('heading')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('heading')

    editor.commands.setContent('<p>Keep both sides</p>', { contentType: 'html' })
    editor.commands.setTextSelection(6)
    expect(shortcut().defaultPrevented).toBe(true)
    expect([...menu.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Star★'])
    typeVisualText(editor, 'star')
    menu.querySelector<HTMLButtonElement>('button')!.click()
    expect(editor.getText()).toBe('Keep ★both sides')
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('Keep starboth sides')
  })

  it('leaves prevented, IME-owned, code, opaque, selected and read-only Ctrl+Space unhandled', () => {
    const fixtures = [
      { content: '<p>text</p>', position: 2, event: { isComposing: true } },
      { content: '<p>text</p>', position: 2, event: { keyCode: 229 } },
      { content: '<pre><code>text</code></pre>', position: 2 },
      { content: '<p><code>text</code></p>', position: 2 },
      { content: '<p>text</p>', position: { from: 1, to: 3 } },
      { content: '<custom-widget>opaque</custom-widget>', position: 0 },
      { content: '<p>text</p>', position: 2, readonly: true },
      { content: '<p>text</p>', position: 2, prevented: true }
    ]
    for (const fixture of fixtures) {
      const editor = createEditor('html', fixture.content)
      installTiptapSlashMenu(editor, [
        { id: 'star', label: 'Star', icon: 'mdi-star', hint: '★', inlineSafe: true, run: chain => chain.insertContent('★') }
      ], 'Insert')
      if (fixture.position !== 0) editor.commands.setTextSelection(fixture.position)
      else editor.commands.setNodeSelection(0)
      if (fixture.readonly) editor.setEditable(false)
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true, ...fixture.event })
      if (fixture.prevented) event.preventDefault()
      editor.view.dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(!!fixture.prevented)
      expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
      editor.destroy()
    }
  })

  it('discovers typed wikilinks through the existing path API and replaces a mapped range in one undo step', async () => {
    const editor = createEditor('markdown', 'Keep both sides', enabledWikiLinks)
    editor.commands.setTextSelection(6)
    const page: DiscoveredPageLink = { id: 12, title: 'Target', locale: 'en', path: 'target', visibility: 'public', href: '/en/target' }
    const requests: Array<{ url: string; init?: RequestInit }> = []
    installTiptapSlashMenu(editor, [], 'Insert', 'No commands', {
      authority: () => 'actor:document:permissions',
      links: {
        locale: () => 'en', localizedPaths: true,
        content: result => discoveredPageLinkContent(result, 'markdown', enabledWikiLinks),
        fetch: async (url, init) => {
          requests.push({ url: String(url), init })
          return Response.json({ items: [page] })
        },
        label: 'Pages', loadingLabel: 'Loading', emptyLabel: 'No pages', errorLabel: 'Failed'
      }
    })
    typeVisualText(editor, '[')
    expect(requests).toHaveLength(0)
    typeVisualText(editor, '[')
    typeVisualText(editor, '/tar')
    await nextEventLoopTurn()
    const menu = editor.view.dom.parentElement!.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.hidden).toBe(false)
    expect(requests.at(-1)!.url).toBe('/_api/pages/link-suggestions?locale=en&pathPrefix=%2Ftar&limit=20')
    expect(requests.at(-1)!.init?.credentials).toBe('same-origin')
    expect(requests.at(-1)!.init?.cache).toBe('no-store')
    expect(requests[0]!.init?.signal?.aborted).toBe(true)
    const stale = menu.querySelector<HTMLButtonElement>('button')!
    const remote = editor.schema.nodes.paragraph!.create(null, editor.schema.text('Remote'))
    editor.view.dispatch(editor.state.tr.insert(0, remote))
    stale.click()
    expect(editor.getText()).toContain('[[/tar')
    await nextEventLoopTurn()
    expect(pressEnter(editor)).toBe(true)
    expect(editor.getMarkdown()).toBe('Remote\n\nKeep [[/target|Target]]both sides')
    expect(editor.getHTML()).toContain('href="/en/target"')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('Remote\n\nKeep [[/tarboth sides')
    expect(menu.hidden).toBe(true)
  })

  it('uses title search without exposing superseded path results and keeps pointer labels inert', async () => {
    const editor = createEditor('html', '<p>Link: suffix</p>')
    editor.commands.setTextSelection(7)
    const pending = Promise.withResolvers<Response>()
    const title = '<img src=x onerror=alert(1)>'
    const requests: string[] = []
    installTiptapSlashMenu(editor, [], 'Insert', 'No commands', {
      links: {
        locale: () => 'en', localizedPaths: false,
        content: result => discoveredPageLinkContent(result, 'html', { enabled: false }),
        fetch: async url => {
          requests.push(String(url))
          if (requests.length === 1) return pending.promise
          return Response.json({
            results: [{ id: 2, title, path: 'target', locale: 'en', visibility: 'public', description: '', tags: [], score: 1, matchedFields: ['title'], excerpt: null, copySource: null }],
            suggestions: [], totalHits: 1
          })
        },
        label: 'Pages', loadingLabel: 'Loading', emptyLabel: 'No pages', errorLabel: 'Failed'
      }
    })
    typeVisualText(editor, '[[')
    typeVisualText(editor, 'Title')
    await nextEventLoopTurn()
    const menu = editor.view.dom.parentElement!.querySelector<HTMLElement>('[role="menu"]')!
    expect(requests.at(-1)).toBe('/_api/pages/search?query=Title&locale=en')
    expect(menu.querySelector<HTMLButtonElement>('button')!.getAttribute('aria-label')).toBe(title)
    expect(menu.querySelector('img,script')).toBeNull()
    pending.resolve(Response.json({ items: [{ id: 99, title: 'Stale', path: 'stale', locale: 'en', visibility: 'public', href: '/stale' }] }))
    await nextEventLoopTurn()
    expect(menu.textContent).not.toContain('Stale')
    menu.querySelector<HTMLButtonElement>('button')!.click()
    expect(editor.getText()).toBe(`Link: ${title}suffix`)
    expect(editor.getHTML()).toContain('href="/target"')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('Link: [[Titlesuffix')
  })

  it('retires displayed and pending links on every ownership fence without deleting literal input', async () => {
    for (const fence of ['escape', 'selection', 'actor', 'permission', 'document', 'readonly', 'composition', 'remote', 'same-bytes', 'destroy'] as const) {
      for (const delayed of [false, true]) {
        const editor = createEditor('markdown', '', enabledWikiLinks)
        let authority: string | null = 'actor:document:permission'
        const pending = Promise.withResolvers<Response>()
        const payload = { items: [{ id: 1, title: 'Target', path: 'target', locale: 'en', visibility: 'public', href: '/en/target' }] }
        let requestSignal: AbortSignal | null | undefined
        const dispose = installTiptapSlashMenu(editor, [], 'Insert', 'No commands', {
          authority: () => authority,
          links: {
            locale: () => 'en', localizedPaths: true,
            content: result => discoveredPageLinkContent(result, 'markdown', enabledWikiLinks),
            fetch: async (_url, init) => { requestSignal = init?.signal; return delayed ? pending.promise : Response.json(payload) },
            label: 'Pages', loadingLabel: 'Loading', emptyLabel: 'No pages', errorLabel: 'Failed'
          }
        })
        typeVisualText(editor, '[[')
        await nextEventLoopTurn()
        const menu = editor.view.dom.parentElement!.querySelector<HTMLElement>('[role="menu"]')!
        const staleButton = menu.querySelector<HTMLButtonElement>('button')
        if (!delayed) expect(staleButton).not.toBeNull()
        if (fence === 'escape') editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        if (fence === 'selection') editor.commands.setTextSelection(1)
        if (fence === 'actor' || fence === 'permission' || fence === 'document') { authority = fence; dispose.invalidate() }
        if (fence === 'readonly') editor.setEditable(false)
        if (fence === 'composition') editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        if (fence === 'remote') editor.view.dispatch(editor.state.tr.insertText('remote', 3))
        if (fence === 'same-bytes') editor.view.dispatch(editor.state.tr.insertText('[[', 1, 3))
        if (fence === 'destroy') editor.destroy()
        staleButton?.click()
        if (delayed) pending.resolve(Response.json(payload))
        await nextEventLoopTurn()
        expect(requestSignal?.aborted).toBe(true)
        expect(menu.hidden || !menu.isConnected).toBe(true)
        if (!editor.isDestroyed) {
          expect(editor.getText()).toBe(fence === 'remote' ? '[[remote' : '[[')
          expect(editor.getHTML()).not.toContain('<a')
          editor.destroy()
        }
      }
    }
  })

  it('preserves literal brackets on empty and failed discovery and ignores ineligible openers', async () => {
    for (const failed of [false, true]) {
      const editor = createEditor('markdown', '', enabledWikiLinks)
      installTiptapSlashMenu(editor, [], 'Insert', 'No commands', {
        links: {
          locale: () => 'en', localizedPaths: true,
          content: result => discoveredPageLinkContent(result, 'markdown', enabledWikiLinks),
          fetch: async () => { if (failed) throw new Error('offline'); return Response.json({ items: [] }) },
          label: 'Pages', loadingLabel: 'Loading', emptyLabel: 'No pages', errorLabel: 'Failed'
        }
      })
      typeVisualText(editor, '[[')
      await nextEventLoopTurn()
      const menu = editor.view.dom.parentElement!.querySelector<HTMLElement>('[role="menu"]')!
      expect(menu.querySelector('[role="status"]')?.textContent).toBe(failed ? 'Failed' : 'No pages')
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      typeVisualText(editor, 'literal]]')
      expect(editor.getText()).toBe('[[literal]]')
      expect(menu.hidden).toBe(true)
      editor.destroy()
    }
    for (const fixture of [
      { content: '<pre><code>code</code></pre>', position: 2 },
      { content: '<p><code>code</code></p>', position: 2 },
      { content: '<p><a href="/target">link</a></p>', position: 2 },
      { content: '<custom-widget>opaque</custom-widget>', position: 0 },
      { content: '<p>text</p>', position: { from: 1, to: 3 } },
      { content: '<p>text</p>', position: 2, composing: true },
      { content: '<p>text</p>', position: 2, readonly: true },
      { content: '<p>\\</p>', position: 2 },
      { content: '<p>[</p>', position: 2 }
    ]) {
      const editor = createEditor('html', fixture.content)
      let requests = 0
      installTiptapSlashMenu(editor, [], 'Insert', 'No commands', {
        links: {
          locale: () => 'en', localizedPaths: true,
          content: result => discoveredPageLinkContent(result, 'html', { enabled: false }),
          fetch: async () => { requests++; return Response.json({ items: [] }) },
          label: 'Pages', loadingLabel: 'Loading', emptyLabel: 'No pages', errorLabel: 'Failed'
        }
      })
      if (fixture.position === 0) editor.commands.setNodeSelection(0)
      else editor.commands.setTextSelection(fixture.position)
      if (fixture.composing) editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      if (fixture.readonly) editor.setEditable(false)
      typeVisualText(editor, '[[')
      expect(requests).toBe(0)
      expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
      editor.destroy()
    }
  })

  it('losslessly preserves unknown HTML elements and comments across reopening', () => {
    const source =
      '<h2 id="heading">Known</h2><custom-widget data-mode="full"><b>Unknown</b></custom-widget><!--keep--><table style="min-width: 75px"><colgroup><col style="min-width: 25px"></colgroup><tbody><tr><td><p>Cell</p></td></tr></tbody></table>'
    const editor = createEditor('html', source)
    const output = serializeVisualEditorData('html', editor)
    expect(output).toContain('<h2 id="heading">Known</h2>')
    expect(output).toContain('<custom-widget data-mode="full"><b>Unknown</b></custom-widget>')
    expect(output).toContain('<!--keep-->')
    expect(output).toContain('<colgroup>')
    expect(output).toContain('<td')
    expect(output).toContain(source.slice(source.indexOf('<table')))

    const reopened = createEditor('html', output)
    expect(serializeVisualEditorData('html', reopened)).toBe(output)
  })
})

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, relative } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { convert } from '@asciidoctor/core'
import createDOMPurify, { type WindowLike } from 'dompurify'
import { defineComponent } from 'vue'
import { describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { decodeBase64Text } from '../../helpers/base64.ts'
import { TextEditor } from './common/text-editor.ts'
import { vRovingToolbar } from './common/roving-toolbar.ts'

const filename = join(process.cwd(), 'client/components/editor/editor-asciidoc.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
const script = compileScript(descriptor, { id: 'asciidoc-preview-security', genDefaultAs: 'component' })
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.content.replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, '')
)
const DOMPurify = createDOMPurify(browserWindow as unknown as WindowLike)

type PreviewContext = {
  cm: TextEditor
  previewShown: boolean
  previewHTML: string
  previewDirty: boolean
  previewLoading: boolean
  previewError: string
  previewRequestId: number
  $t: typeof translateEnglish
  editor: () => TextEditor
  processMarkers: (from: number, to: number) => void
}
type PreviewComponent = {
  data: (this: { mdAndUp: boolean }) => Record<string, unknown>
  methods: {
    editor: (this: PreviewContext) => TextEditor
    processMarkers: (this: PreviewContext, from: number, to: number) => void
    processContent: (this: PreviewContext, source: string) => Promise<void>
    flushEligibleEditorText: (this: PreviewContext) => void
  }
}

// Execute the compiled production method with the installed converter and a real
// DOMPurify window. Transport spies observe access, not conversion or safe options.
const evaluateComponent = new Function(
  'defineComponent', 'wikiStore', 'convert', 'DOMPurify', 'decodeBase64Text', 'vRovingToolbar', 'require',
  `${executable}\nreturn component`
) as (...dependencies: unknown[]) => PreviewComponent

describe('Native AsciiDoc preview security', () => {
  test('denies automatic includes while preserving rich preview content and saveable source', async () => {
    // Keep the canary under the converter's normal base directory: safe (rather
    // than secure) mode can read it, so a path-jail rejection cannot hide a regression.
    const directory = await fs.mkdtemp(join(process.cwd(), '.asciidoc-preview-'))
    const canaryPath = join(directory, 'canary.adoc')
    const canary = `Private preview include content ${randomUUID()}`
    const host = document.body.appendChild(document.createElement('div'))
    let editor: TextEditor | undefined
    try {
      await fs.writeFile(canaryPath, canary)
      const source = [
        '= Public preview', '',
        'A *bold* and _emphasized_ paragraph.', '',
        'NOTE: Ordinary admonition remains visible.', '',
        '|===', '|Name |Status', '', '|Public row |Visible', '|===', '',
        '[source,javascript]', '----', 'const publicValue = 42;', '----', '',
        '++++', '<script>window.previewCanary = "unsafe"</script><span onclick="alert(1)">Public passthrough</span>', '++++', '',
        `include::${relative(process.cwd(), canaryPath)}[]`, '',
        'include::https://example.invalid/private-preview.adoc[]'
      ].join('\n')
      const wikiStore = { editor: { content: '' } }
      const component = evaluateComponent(defineComponent, wikiStore, convert, DOMPurify, decodeBase64Text, vRovingToolbar, require)
      editor = new TextEditor({ parent: host, value: source, ariaLabel: 'AsciiDoc source', dark: false })
      const context = { ...component.data.call({ mdAndUp: true }), cm: editor, $t: translateEnglish } as PreviewContext
      context.editor = component.methods.editor.bind(context)
      context.processMarkers = component.methods.processMarkers.bind(context)
      const fileReads = vi.spyOn(fs, 'readFile')
      const denyFetch = () => { throw new Error('Preview attempted an automatic include request') }
      const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(denyFetch)
      const windowRequests = vi.spyOn(browserWindow, 'fetch').mockImplementation(denyFetch)

      await component.methods.processContent.call(context, editor.getValue())
      component.methods.flushEligibleEditorText.call(context)
      const preview = document.createElement('div')
      preview.innerHTML = context.previewHTML
      expect(context.previewError).toBe('')
      expect(context.previewLoading).toBe(false)
      expect(context.previewDirty).toBe(false)
      expect(requests).not.toHaveBeenCalled()
      expect(windowRequests).not.toHaveBeenCalled()
      expect(fileReads.mock.calls.some(([target]) => String(target).endsWith('/canary.adoc'))).toBe(false)
      expect(preview.textContent).not.toContain(canary)
      expect(preview.querySelector('h1')?.textContent).toBe('Public preview')
      expect(preview.querySelector('strong')?.textContent).toBe('bold')
      expect(preview.querySelector('em')?.textContent).toBe('emphasized')
      expect(preview.querySelector('.admonitionblock.note')?.textContent).toContain('Ordinary admonition remains visible.')
      expect(preview.querySelector('table.tableblock')?.textContent).toContain('Public row')
      expect(preview.querySelector('pre code')?.textContent).toContain('const publicValue = 42;')
      expect(preview.textContent).toContain('Public passthrough')
      expect(preview.querySelector('script, [onclick]')).toBeNull()
      expect(editor.getValue()).toBe(source)
      expect(wikiStore.editor.content).toBe(source)
    } finally {
      vi.restoreAllMocks()
      editor?.destroy()
      host.remove()
      resetBody()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../../server/test/bun-test.mts'

const tiptapPath = join(process.cwd(), 'client/components/editor/tiptap/editor.vue')
const shellPath = join(process.cwd(), 'client/components/editor.vue')
const themeStylesheetPath = join(process.cwd(), 'client/themes/default/scss/app.scss')
const pagePath = join(process.cwd(), 'client/themes/default/components/page.vue')
const tiptapSource = readFileSync(tiptapPath, 'utf8')
const shellSource = readFileSync(shellPath, 'utf8')
const themeStylesheet = readFileSync(themeStylesheetPath, 'utf8')
const pageSource = readFileSync(pagePath, 'utf8')
const tiptapSfc = parse(tiptapSource, { filename: tiptapPath })
const shellSfc = parse(shellSource, { filename: shellPath })
const pageSfc = parse(pageSource, { filename: pagePath })
const tiptapTemplate = tiptapSfc.descriptor.template?.content ?? ''
const tiptapScript = tiptapSfc.descriptor.script?.content ?? ''
const tiptapStyle = tiptapSfc.descriptor.styles.map(style => style.content).join('\n')
const pageStyle = pageSfc.descriptor.styles.map(style => style.content).join('\n')
const shellScript = shellSfc.descriptor.script?.content ?? ''

describe('TipTap editor layout and page-theme ownership', () => {
  test('puts the compact, horizontally reachable tool rows first in the editor surface', () => {
    expect(tiptapSfc.errors).toEqual([])
    expect(shellSfc.errors).toEqual([])
    expect(tiptapTemplate.trimStart()).toMatch(/^\.editor-tiptap\(ref='root'\)\n\s+v-toolbar\.editor-tiptap-toolbar/)
    expect(tiptapTemplate).toContain("v-toolbar.editor-tiptap-toolbar(flat, density='compact')")
    expect(tiptapTemplate).toContain(".editor-tiptap-markdown-tools(v-if='format === `markdown`'")
    expect(tiptapStyle.match(/overflow-x:\s*auto;/g)?.length).toBeGreaterThanOrEqual(2)
    expect(tiptapStyle.match(/justify-content:\s*safe center;/g)).toHaveLength(2)
    expect(tiptapStyle.match(/justify-content:\s*flex-start;/g)).toHaveLength(2)
    expect(tiptapStyle).toContain('min-height: calc(var(--wiki-control-height) + var(--wiki-space-1));')
    expect(tiptapStyle).toContain('min-height: var(--wiki-control-height);')
  })

  test('removes the decorative strip between tools and the live canvas', () => {
    expect(tiptapTemplate).not.toContain('editor-tiptap-page-status')
    expect(tiptapStyle).not.toContain('&-page-status')
    expect(tiptapStyle).toContain('margin: 0 auto var(--wiki-space-5);')
  })

  test('lets the shared contents theme own live canvas typography and headings', () => {
    expect(tiptapTemplate).toContain(`.editor-tiptap-page-canvas.editor-page-canvas\n    editor-content.contents(:editor='editor')`)
    expect(tiptapStyle).not.toMatch(/^\s*h[1-6](?:\s*,|\s*\{)/m)

    const canvasStart = tiptapStyle.indexOf('> .editor-tiptap-page-canvas {')
    const canvasFocusState = tiptapStyle.indexOf('&:focus-within', canvasStart)
    expect(canvasStart).toBeGreaterThanOrEqual(0)
    expect(canvasFocusState).toBeGreaterThan(canvasStart)
    expect(tiptapStyle.slice(canvasStart, canvasFocusState)).not.toMatch(/\b(?:color|font-family|font-size|line-height):/)
  })

  test('uses accessible accent ink for headings while keeping warm accents decorative', () => {
    expect(pageSfc.errors).toEqual([])

    // Shared stylesheet owns heading typography and accessible accent ink for reader and editor
    expect(themeStylesheet).toMatch(/h1\s*\{[^}]*color:\s*var\(--wiki-accent-ink\)/)
    expect(themeStylesheet).not.toMatch(/h1\s*\{[^}]*color:\s*var\(--wiki-accent-warm\)/)

    // Shared typography targets both reader scope and TipTap editor canvas
    expect(themeStylesheet).toMatch(/\.v-main \.contents/)
    expect(themeStylesheet).toMatch(/\.contents \.tiptap|\.editor-page-canvas|\.tiptap/)

    // Authored H1 swoosh in shared theme reaches editor canvas while hero remains undecorated
    expect(themeStylesheet).toMatch(/h1[\s\S]*?::after[\s\S]*?(?:10rem|min\(100%,\s*10rem\))/)
    expect(pageStyle).not.toMatch(/\.page-title(?:::after|\s*::after)/)

    // Ownership cutover: page-local file must NOT own heading typography
    expect(pageStyle).not.toMatch(/\.wiki-page \.v-main \.contents\s*\{[\s\S]*?h1\s*\{/s)
    expect(pageStyle).not.toMatch(/\.contents\s+h1\s*\{[^}]*color:/)

    // TipTap editor canvas retains caret color, and list markers use decorative warm accent
    expect(tiptapStyle).toContain('caret-color: var(--wiki-accent-warm);')
    expect(themeStylesheet).toMatch(/::marker\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--wiki-accent-warm/)
  })

  test('matches the published page reading measure without owning its theme', () => {
    expect(tiptapStyle).toMatch(/\.tiptap\s*\{[\s\S]*?max-width:\s*76ch;[\s\S]*?margin-inline:\s*auto;/)
  })

  test('parses and scopes page CSS to the canvas instead of editor chrome', () => {
    expect(shellScript).toContain("const EDITOR_PAGE_CANVAS_SCOPE = '.editor-page-canvas'")
    expect(shellScript).toContain('parserStyle.sheet?.cssRules')
    expect(shellScript).toContain('rule.type === CSSRule.IMPORT_RULE')
    expect(shellScript).toContain("console.warn('Page CSS @import rules are unsupported in the editor preview and were omitted.')")
    expect(shellScript).toContain('.filter(rule => rule.type !== CSSRule.IMPORT_RULE)')
    expect(shellScript).toContain('rule => rule.cssText')
    expect(shellScript.indexOf('.filter(rule => rule.type !== CSSRule.IMPORT_RULE)')).toBeLessThan(
      shellScript.indexOf('`@scope ($' + '{EDITOR_PAGE_CANVAS_SCOPE}) {')
    )
    expect(shellScript).toContain('styl.textContent = scopeEditorPageCss(css)')
    expect(shellScript).not.toContain('createTextNode(css)')
    expect(shellScript).toContain('removeEditorPageCss()')
  })

  test('does not claim unsupported visual collaboration or presence', () => {
    expect(tiptapScript).not.toMatch(/Collaboration|awareness|presence/)
  })
})

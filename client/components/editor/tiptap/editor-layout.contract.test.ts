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

  test('keeps shared and published Markdown H1s on the active warm accent token', () => {
    expect(pageSfc.errors).toEqual([])

    const modernThemeStart = themeStylesheet.indexOf('// Modern reading surface')
    expect(modernThemeStart).toBeGreaterThanOrEqual(0)

    expect(themeStylesheet.slice(modernThemeStart)).toMatch(/\.v-main \.contents\s*\{[\s\S]*?\n {2}h1\s*\{[\s\S]*?\n {4}color:\s*var\(--wiki-accent-warm\)\s*;/)
    expect(pageStyle).toMatch(/\.v-main \.contents\s*\{[\s\S]*?\n {2}h1\s*\{[\s\S]*?\n {4}color:\s*var\(--wiki-accent-warm\)\s*;/)
    expect(themeStylesheet.slice(modernThemeStart)).toMatch(/h1\s*\{[\s\S]*?\n {4}strong\s*\{[\s\S]*?\n {6}color:\s*inherit\s*;/)
    expect(pageStyle).toMatch(/h1\s*\{[\s\S]*?\n {4}strong\s*\{[\s\S]*?\n {6}color:\s*inherit\s*;/)
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

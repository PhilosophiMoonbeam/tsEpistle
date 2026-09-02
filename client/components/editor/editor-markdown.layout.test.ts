import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const editorPath = path.join(process.cwd(), 'client/components/editor/editor-markdown.vue')
const editorSource = fs.readFileSync(editorPath, 'utf8')
const template = editorSource.match(/<template lang=['"]pug['"]>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''
const style = editorSource.match(/<style lang=['"]scss['"]>\s*([\s\S]*?)\s*<\/style>/)?.[1] ?? ''
const textEditorPath = path.join(process.cwd(), 'client/components/editor/common/text-editor.ts')
const textEditorSource = fs.readFileSync(textEditorPath, 'utf8')
const visualEditorPath = path.join(process.cwd(), 'client/components/editor/tiptap/editor.vue')
const visualEditorSource = fs.readFileSync(visualEditorPath, 'utf8')

describe('Markdown editor layout', () => {
  it('starts the formatting toolbar at the leading edge without a reserved sidebar strip', () => {
    expect(template).toMatch(/^\.editor-markdown\(ref='root'\)\n {4}v-toolbar\.editor-markdown-toolbar/)
    expect(template.indexOf('v-toolbar.editor-markdown-toolbar')).toBeLessThan(template.indexOf('.editor-markdown-main'))
    expect(style).toContain('padding-inline: 0;')
    expect(style).not.toContain('padding-left: 64px;')
  })

  it('switches mobile panes atomically while keeping the CodeMirror instance mounted', () => {
    expect(template).toContain('.editor-markdown-editor(:class=\'{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }\')')
    expect(template).toContain("transition(name='editor-markdown-preview', :css='$vuetify.display.mdAndUp')")
    expect(template).toContain(".editor-markdown-preview(v-if='previewShown')")
    expect(template.match(/div\(ref='cm'\)/g)).toHaveLength(1)

    expect(style).toMatch(/&-editor\s*\{[\s\S]*?@include until\(\$tablet\)\s*\{[\s\S]*?flex-basis: 100%;[\s\S]*?width: 100%;/)
    expect(style).toMatch(/&-preview\s*\{[\s\S]*?@include until\(\$tablet\)\s*\{[\s\S]*?flex: 1 1 100%;[\s\S]*?max-width: 100%;[\s\S]*?width: 100%;/)
  })

  it('retains desktop split-preview transitions with markdown-specific selectors', () => {
    expect(style.match(/flex: 1 1 50%;/g)).toHaveLength(2)
    expect(style).toContain('&-preview-enter-active,')
    expect(style).toContain('&-preview-leave-active {')
    expect(style).toContain('max-width: 50vw;')
    expect(style).toContain('.editor-markdown-preview-content {')
    expect(style).not.toContain('.editor-code-preview-content')
  })

  it('marks the rendered preview as a page CSS canvas', () => {
    expect(template).toContain(".editor-markdown-preview-content.editor-page-canvas.contents(ref='editorPreviewContainer')")
  })

  it('uses active Vuetify theme colors for the Markdown source pane', () => {
    expect(textEditorSource).toContain("backgroundColor: 'rgb(var(--v-theme-surface))'")
    expect(textEditorSource).toContain("color: 'rgb(var(--v-theme-on-surface))'")
    expect(textEditorSource).toContain("backgroundColor: 'rgba(var(--v-theme-primary), .24)'")
    expect(textEditorSource).not.toMatch(/#(?:1d1f21|181a1b|e0e0e0|616161|212121)/)
  })

  it('keeps both Markdown status bars from reserving space above their editors', () => {
    expect(template).toContain('v-system-bar.editor-status-bar.editor-markdown-sysbar(absolute, color="grey-darken-3")')
    expect(visualEditorSource).toContain('v-system-bar.editor-status-bar.editor-tiptap-sysbar(absolute)')
  })

  it('preserves pane controls and collaboration accessibility metadata', () => {
    expect(template).toContain(":aria-label='previewShown ? `Show editor` : `Show preview`'")
    expect(template).toContain("role='status'")
    expect(template).toContain("aria-live='polite'")
    expect(template).toContain("ref='editorPreviewContainer'")
  })
})

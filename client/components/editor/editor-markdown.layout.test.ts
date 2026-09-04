import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const editorPath = path.join(process.cwd(), 'client/components/editor/editor-markdown.vue')
const editorSource = fs.readFileSync(editorPath, 'utf8')
const template = editorSource.match(/<template lang=['"]pug['"]>\s*([\s\S]*?)\s*<\/template>/)?.[1] ?? ''
const script = editorSource.match(/<script lang=['"]ts['"]>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? ''
const style = editorSource.match(/<style lang=['"]scss['"]>\s*([\s\S]*?)\s*<\/style>/)?.[1] ?? ''
const textEditorPath = path.join(process.cwd(), 'client/components/editor/common/text-editor.ts')
const textEditorSource = fs.readFileSync(textEditorPath, 'utf8')
const visualEditorPath = path.join(process.cwd(), 'client/components/editor/tiptap/editor.vue')
const packageSource = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
const lockSource = fs.readFileSync(path.join(process.cwd(), 'bun.lock'), 'utf8')
const visualEditorSource = fs.readFileSync(visualEditorPath, 'utf8')

const directScssBlock = (source: string, selector: string): string => {
  let depth = 0

  for (let index = 0; index < source.length; index += 1) {
    if (depth === 0 && source.startsWith(selector, index)) {
      let openingBrace = index + selector.length
      while (/\s/.test(source[openingBrace] ?? '')) openingBrace += 1

      if (source[openingBrace] === '{') {
        let blockDepth = 1
        for (let end = openingBrace + 1; end < source.length; end += 1) {
          if (source[end] === '{') blockDepth += 1
          if (source[end] === '}') blockDepth -= 1
          if (blockDepth === 0) return source.slice(openingBrace + 1, end)
        }
      }
    }

    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
  }

  throw new Error(`Missing direct SCSS block: ${selector}`)
}

const directScssDeclarations = (block: string): string => {
  let declarations = ''
  let depth = 0

  for (const character of block) {
    if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
    } else if (depth === 0) {
      declarations += character
    }
  }

  return declarations
}

describe('Markdown editor layout', () => {
  it('starts the formatting toolbar at the leading edge without a reserved sidebar strip', () => {
    expect(template).toMatch(/^\.editor-markdown\(ref='root'\)\n {4}v-toolbar\.editor-markdown-toolbar/)
    expect(template.indexOf('v-toolbar.editor-markdown-toolbar')).toBeLessThan(template.indexOf('.editor-markdown-main'))
    expect(style).toContain('padding-inline: 0;')
    expect(style).not.toContain('padding-left: 64px;')
  })

  it('constrains the editor to the Vuetify viewport content area', () => {
    const rootDeclarations = directScssDeclarations(directScssBlock(style, '.editor-markdown'))
    expect(rootDeclarations).toMatch(/(?:^|\n)\s*height:\s*calc\(100vh - var\(--v-layout-top, 0px\) - var\(--v-layout-bottom, 0px\)\);/)
    expect(rootDeclarations).toMatch(/(?:^|\n)\s*height:\s*calc\(100dvh - var\(--v-layout-top, 0px\) - var\(--v-layout-bottom, 0px\)\);/)
    expect(rootDeclarations).toMatch(/(?:^|\n)\s*max-height:\s*calc\(100dvh - var\(--v-layout-top, 0px\) - var\(--v-layout-bottom, 0px\)\);/)
    expect(rootDeclarations).toMatch(/(?:^|\n)\s*min-height:\s*0;/)
    expect(rootDeclarations).toMatch(/(?:^|\n)\s*overflow:\s*hidden;/)
    expect(rootDeclarations).not.toMatch(/(?:^|\n)\s*height:\s*100%;/)
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

  it('preserves default syntax colors while giving URL destinations a semantic contrast color', () => {
    expect(textEditorSource).toContain("backgroundColor: 'rgb(var(--v-theme-surface))'")
    expect(textEditorSource).toContain("color: 'rgb(var(--v-theme-on-surface))'")
    expect(textEditorSource).toContain("backgroundColor: 'rgba(var(--v-theme-primary), .24)'")
    expect(textEditorSource).toContain("import { tags } from '@lezer/highlight'")
    expect(textEditorSource).toContain('const semanticHighlightStyle = HighlightStyle.define([')
    expect(textEditorSource).toContain("{ tag: tags.url, color: 'var(--wiki-accent-ink)' }")
    expect(textEditorSource).not.toContain('tag: tags.link')
    expect(textEditorSource).not.toContain('#219')
    expect(textEditorSource).not.toMatch(/#(?:1d1f21|181a1b|e0e0e0|616161|212121)/)

    const defaultHighlighter = textEditorSource.indexOf('syntaxHighlighting(defaultHighlightStyle)')
    expect(defaultHighlighter).toBeGreaterThan(-1)
    expect(defaultHighlighter).toBeGreaterThan(textEditorSource.indexOf('basicSetup,'))
    expect(textEditorSource).toContain('Prec.highest(syntaxHighlighting(semanticHighlightStyle))')
    expect(textEditorSource).not.toMatch(/^\s*syntaxHighlighting\(semanticHighlightStyle\),$/m)
  })

  it('declares the semantic highlighting package at its resolved version', () => {
    expect(packageSource).toMatch(/"dependencies": \{[\s\S]*?"@lezer\/highlight": "1\.2\.3"/)
    expect(lockSource).toMatch(/"workspaces": \{[\s\S]*?"dependencies": \{[\s\S]*?"@lezer\/highlight": "1\.2\.3"/)
    expect(lockSource).toContain('"@lezer/highlight": ["@lezer/highlight@1.2.3"')
  })

  it('aligns source clicks without coupling keyboard cursor or render updates', () => {
    const desktopToolbarStart = template.indexOf("template(v-if='$vuetify.display.mdAndUp')")
    const mobileToolbarStart = template.indexOf('template(v-else)', desktopToolbarStart)
    const desktopToolbar = template.slice(desktopToolbarStart, mobileToolbarStart)
    const mobileToolbar = template.slice(mobileToolbarStart, template.indexOf('.editor-markdown-main'))
    for (const toolbar of [desktopToolbar, mobileToolbar]) {
      expect(toolbar).toContain("aria-label='Align preview to cursor'")
      expect(toolbar).toContain("@click='alignPreviewToCursor'")
      expect(toolbar.indexOf("@click='alignPreviewToCursor'")).toBeLessThan(toolbar.indexOf('previewShown = !previewShown'))
    }
    expect(template.match(/aria-label='Align preview to cursor'/g)).toHaveLength(2)
    expect(template.match(/@click='alignPreviewToCursor'/g)).toHaveLength(2)

    expect(script).toContain("token.attrSet('data-source-line', String(line))")
    expect(script).toContain('sourceLinesByEditor.set(this, renderEnvironment.sourceLines)')
    expect(script).not.toContain('debouncedScrollSync')
    expect(script).not.toContain('scrollSync')
    expect(script).not.toContain('performScrollSync')
    expect(script.match(/alignPreviewToCursor/g)).toHaveLength(2)
    expect(script).toMatch(/onCursor: position => \{\s*this\.positionSync\(position\)\s*\}/)
    expect(script).toMatch(/onClick: \(\) => \{\s*this\.alignPreviewToCursor\(\)\s*\}/)

    const processContentStart = script.indexOf('    processContent (newContent: string)')
    const positionSyncStart = script.indexOf('    positionSync(position: TextPosition)', processContentStart)
    const processContent = script.slice(processContentStart, positionSyncStart)
    expect(processContent).not.toContain('Velocity')
    expect(processContent).not.toContain('alignPreviewToCursor')

    const alignStart = script.indexOf('    alignPreviewToCursor ()')
    const alignEnd = script.indexOf('    toggleHelp ()', alignStart)
    const alignMethod = script.slice(alignStart, alignEnd)
    expect(alignMethod).toContain('this.editorDisposed || !this.previewShown || !this.cm || this.previewHTML.trim().length === 0')
    expect(alignMethod).toContain("this.cm.cursor('head').line")
    expect(alignMethod).not.toContain('hasSelection')
    expect(alignMethod).toContain('for (let index = sourceLines.length - 1; index >= 0; index--)')
    expect(alignMethod).toContain('if (sourceLine === undefined || sourceLine > currentLine) continue')
    expect(alignMethod).toContain(`preview.querySelector<HTMLElement>(\`[data-source-line='\${sourceLine}']\`)`)
    expect(alignMethod).toContain('if (markedDestination) break')
    expect(alignMethod).toContain('const destination = markedDestination ?? firstPreviewElement')
    expect(alignMethod).toContain("const offset = markedDestination ? '-100' : '-50'")
    expect(alignMethod).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180")
    expect(alignMethod.indexOf('stopPreviewAlignment(this)')).toBeLessThan(alignMethod.indexOf("Velocity(destination, 'scroll'"))
    expect(script).toContain("if (target) Velocity(target, 'stop', true)")
    expect(script).toMatch(/\} else if \(!newValue && oldValue\) \{\s*stopPreviewAlignment\(this\)/)
    expect(script).toMatch(/beforeUnmount\(\) \{[\s\S]*?this\.editorDisposed = true[\s\S]*?stopPreviewAlignment\(this\)/)
    expect(script.match(/stopPreviewAlignment\(this\)/g)).toHaveLength(3)

    const markdownBlock = directScssBlock(style, '.editor-markdown')
    const sourceEditorDeclarations = directScssDeclarations(directScssBlock(markdownBlock, '&-editor'))
    const previewBlock = directScssBlock(markdownBlock, '&-preview')
    const previewDeclarations = directScssDeclarations(previewBlock)
    const previewContentDeclarations = directScssDeclarations(directScssBlock(previewBlock, '&-content'))

    expect(previewDeclarations).toMatch(/(?:^|\n)\s*display:\s*flex;/)
    expect(previewDeclarations).toMatch(/(?:^|\n)\s*flex-flow:\s*column nowrap;/)
    expect(previewDeclarations).toMatch(/(?:^|\n)\s*min-height:\s*0;/)
    expect(previewBlock).not.toContain('display: block;')
    expect(previewContentDeclarations).toMatch(/(?:^|\n)\s*flex:\s*1 1 auto;/)
    expect(previewContentDeclarations).toMatch(/(?:^|\n)\s*min-height:\s*0;/)
    expect(sourceEditorDeclarations).toMatch(/(?:^|\n)\s*overflow:\s*auto;/)
    expect(previewDeclarations).toMatch(/(?:^|\n)\s*overflow:\s*hidden;/)
    expect(previewDeclarations).not.toMatch(/(?:^|\n)\s*overflow(?:-[xy])?:\s*auto;/)
    expect(previewContentDeclarations).toMatch(/(?:^|\n)\s*overflow-y:\s*auto;/)
  })

  it('keeps both Markdown status bars from reserving space above their editors', () => {
    expect(template).toContain('.v-system-bar.editor-status-bar.editor-markdown-sysbar.bg-grey-darken-3')
    expect(visualEditorSource).toContain('.v-system-bar.editor-status-bar.editor-tiptap-sysbar')
    expect(template).not.toMatch(/^\s*v-system-bar\.editor-status-bar\.editor-markdown-sysbar/m)
    expect(visualEditorSource).not.toMatch(/^\s*v-system-bar\.editor-status-bar\.editor-tiptap-sysbar/m)
    expect(style).toMatch(/&-sysbar\s*\{[\s\S]*?display: flex;/)
    expect(visualEditorSource).toMatch(/&-sysbar\s*\{[\s\S]*?display: flex;/)
  })

  it('preserves pane controls and collaboration accessibility metadata', () => {
    expect(template).toContain(":aria-label='previewShown ? `Show editor` : `Show preview`'")
    expect(template).toContain("role='status'")
    expect(template).toContain("aria-live='polite'")
    expect(template).toContain("ref='editorPreviewContainer'")
  })
})

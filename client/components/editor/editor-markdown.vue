<template lang='pug'>
  .editor-markdown
    v-toolbar.editor-markdown-toolbar(dense, color='primary', dark, flat, style='overflow-x: hidden;')
      template(v-if='isModalShown')
        v-spacer
        v-btn.animated.fadeInRight(text, @click='closeAllModal')
          v-icon(left) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      template(v-else)
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn(icon, tile, v-bind='props', @click='toggleMarkup({ start: `**` })').mx-0
              v-icon mdi-format-bold
          span {{$t('editor:markup.bold')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p1s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `*` })').mx-0
              v-icon mdi-format-italic
          span {{$t('editor:markup.italic')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p2s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `~~` })').mx-0
              v-icon mdi-format-strikethrough
          span {{$t('editor:markup.strikethrough')}}
        v-menu(offset-y, open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p3s(icon, tile, v-bind='props').mx-0
              v-icon mdi-format-header-pound
          v-list.py-0
            template(v-for='(n, idx) in 6', :key='idx')
              v-list-item(@click='setHeaderLine(n)')
                div.v-list-item-action
                  v-icon(:size='24 - (idx - 1) * 2') mdi-format-header-{{n}}
                v-list-item-title {{$t('editor:markup.heading', { level: n })}}
              v-divider(v-if='idx < 5')
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p4s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `~` })').mx-0
              v-icon mdi-format-subscript
          span {{$t('editor:markup.subscript')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p5s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `^` })').mx-0
              v-icon mdi-format-superscript
          span {{$t('editor:markup.superscript')}}
        v-menu(offset-y, open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p6s(icon, tile, v-bind='props').mx-0
              v-icon mdi-alpha-t-box-outline
          v-list.py-0
            v-list-item(@click='insertBeforeEachLine({ content: `> `})')
              div.v-list-item-action
                v-icon mdi-alpha-t-box-outline
              v-list-item-title {{$t('editor:markup.blockquote')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-info}`})')
              div.v-list-item-action
                v-icon(color='blue') mdi-alpha-i-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteInfo')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-success}`})')
              div.v-list-item-action
                v-icon(color='success') mdi-alpha-s-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteSuccess')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-warning}`})')
              div.v-list-item-action
                v-icon(color='warning') mdi-alpha-w-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteWarning')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-danger}`})')
              div.v-list-item-action
                v-icon(color='error') mdi-alpha-e-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteError')}}
            v-divider
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p7s(icon, tile, v-bind='props', @click='insertBeforeEachLine({ content: `- `})').mx-0
              v-icon mdi-format-list-bulleted
          span {{$t('editor:markup.unorderedList')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p8s(icon, tile, v-bind='props', @click='insertBeforeEachLine({ content: `1. `})').mx-0
              v-icon mdi-format-list-numbered
          span {{$t('editor:markup.orderedList')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p9s(icon, tile, v-bind='props', @click='toggleMarkup({ start: "`" })').mx-0
              v-icon mdi-code-tags
          span {{$t('editor:markup.inlineCode')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p10s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `<kbd>`, end: `</kbd>` })').mx-0
              v-icon mdi-keyboard-variant
          span {{$t('editor:markup.keyboardKey')}}
        v-tooltip(bottom, color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p11s(icon, tile, v-bind='props', @click='insertAfter({ content: `---`, newLine: true })').mx-0
              v-icon mdi-minus
          span {{$t('editor:markup.horizontalBar')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(bottom, color='primary', v-if='previewShown')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p1s(icon, tile, v-bind='props', @click='spellModeActive = !spellModeActive').mx-0
                v-icon(:color='spellModeActive ? `amber` : `white`') mdi-spellcheck
            span {{$t('editor:markup.toggleSpellcheck')}}
          v-tooltip(bottom, color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p2s(icon, tile, v-bind='props', @click='previewShown = !previewShown').mx-0
                v-icon mdi-book-open-outline
            span {{$t('editor:markup.togglePreviewPane')}}
    .editor-markdown-main
      .editor-markdown-sidebar
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInLeft(icon, tile, v-bind='props', dark, @click='insertLink').mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, tile, v-bind='props', dark, @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p2s(icon, tile, v-bind='props', dark, @click='toggleModal(`editorModalDrawio`)').mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(right, color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, tile, v-bind='props', dark, @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
          v-tooltip(right, color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, tile, v-bind='props', dark, @click='toggleHelp').mx-0
                v-icon(:color='helpShown ? `teal` : ``') mdi-help-circle
            span {{$t('editor:markup.markdownFormattingHelp')}}
      .editor-markdown-editor
        textarea(ref='cm')
      transition(name='editor-markdown-preview')
        .editor-markdown-preview(v-if='previewShown')
          .editor-markdown-preview-content.contents(ref='editorPreviewContainer')
            div(
              ref='editorPreview'
              v-html='previewHTML'
              :spellcheck='spellModeActive'
              :contenteditable='spellModeActive'
              @blur='spellModeActive = false'
              )

    v-system-bar.editor-markdown-sysbar(dark, status, color='grey darken-3')
      .caption.editor-markdown-sysbar-locale {{locale.toUpperCase()}}
      .caption.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .caption Markdown
        v-spacer
        .caption Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}

    markdown-help(v-if='helpShown')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import markdownHelp from './markdown/help.vue'
import { searchPages } from '../../helpers/pages-api'
import DOMPurify from 'dompurify'
import Velocity from 'velocity-animate'

/* global siteConfig, siteLangs */

// ========================================
// IMPORTS
// ========================================

// Code Mirror
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'

// Language
import 'codemirror/mode/markdown/markdown.js'

// Addons
import 'codemirror/addon/selection/active-line.js'
import 'codemirror/addon/display/fullscreen.js'
import 'codemirror/addon/display/fullscreen.css'
import 'codemirror/addon/selection/mark-selection.js'
import 'codemirror/addon/search/searchcursor.js'
import 'codemirror/addon/hint/show-hint.js'
import 'codemirror/addon/fold/foldcode.js'
import 'codemirror/addon/fold/foldgutter.js'
import 'codemirror/addon/fold/foldgutter.css'

// Markdown-it
import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import mdDecorate from 'markdown-it-decorate'
import { full as mdEmoji } from 'markdown-it-emoji'
import mdTaskLists from 'markdown-it-task-lists'
import mdExpandTabs from 'markdown-it-expand-tabs'
import mdAbbr from 'markdown-it-abbr'
import mdSup from 'markdown-it-sup'
import mdSub from 'markdown-it-sub'
import mdMark from 'markdown-it-mark'
import mdMultiTable from 'markdown-it-multimd-table'
import mdFootnote from 'markdown-it-footnote'
import mdImsize from 'markdown-it-imsize'
import katex from 'katex'
import underline from '../../libs/markdown-it-underline'
import 'katex/dist/contrib/mhchem'
import twemoji from 'twemoji'
import plantuml from './markdown/plantuml'

// Prism (Syntax Highlighting)
import Prism from 'prismjs'

// Mermaid
import mermaid from 'mermaid'

// Helpers
import katexHelper from './common/katex'
import tabsetHelper from './markdown/tabset'
import cmFold from './common/cmFold'

type MarkdownMarkerKind = 'diagram'

type ToggleMarkupOptions = {
  start: string
  end?: string
}

type InsertContentOptions = {
  content: string
}

type InsertAfterOptions = InsertContentOptions & {
  newLine?: boolean
}

type InsertBeforeEachLineOptions = InsertContentOptions & {
  after?: string
}

type LinkSelection = {
  locale: string
  path: string
}

type AddMarkerOptions = {
  from: CodeMirror.Position
  to: CodeMirror.Position
  text: string
  action: EventListener
}


type MarkdownEditorConfiguration = CodeMirror.EditorConfiguration & {
  line: boolean
  highlightSelectionMatches: {
    annotateScrollbar: boolean
  }
}

type MarkdownItRenderRule = NonNullable<InstanceType<typeof MarkdownIt>['renderer']['rules'][string]>

function requireEditor (editor: CodeMirror.EditorFromTextArea | null): CodeMirror.EditorFromTextArea {
  if (!editor) {
    throw new Error('Markdown editor has not been initialized.')
  }
  return editor
}

// ========================================
// INIT
// ========================================

// Platform detection
const CtrlKey = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'

// Prism Config
Prism.plugins.autoloader.languages_path = '/_assets/js/prism/'
Prism.plugins.NormalizeWhitespace.setDefaults({
  'remove-trailing': true,
  'remove-indent': true,
  'left-trim': true,
  'right-trim': true,
  'remove-initial-line-feed': true,
  'tabs-to-spaces': 2
})

// Markdown Instance
const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang === 'diagram') {
      return `<pre class="diagram">` + Buffer.from(str, 'base64').toString() + `</pre>`
    } else if (['mermaid', 'plantuml'].includes(lang)) {
      return `<pre class="codeblock-${lang}"><code>${_.escape(str)}</code></pre>`
    } else {
      return `<pre class="line-numbers"><code class="language-${lang}">${_.escape(str)}</code></pre>`
    }
  }
})
  .use(mdAttrs, {
    allowedAttributes: ['id', 'class', 'target']
  })
  .use(mdDecorate)
  .use(underline)
  .use(mdEmoji)
  .use(mdTaskLists, { label: false, labelAfter: false })
  .use(mdExpandTabs)
  .use(mdAbbr)
  .use(mdSup)
  .use(mdSub)
  .use(mdMultiTable, { multiline: true, rowspan: true, headerless: true })
  .use(mdMark)
  .use(mdFootnote)
  .use(mdImsize)

// DOMPurify fix for draw.io
DOMPurify.addHook('uponSanitizeElement', (node) => {
  if (!(node instanceof Element)) { return }
  const breaks = node.querySelectorAll('foreignObject br, foreignObject p')
  breaks.forEach((breakElement: Element) => {
    breakElement.parentNode?.replaceChild(
      document.createElement('div'),
      breakElement
    )
  })
})

// ========================================
// HELPER FUNCTIONS
// ========================================

// Inject line numbers for preview scroll sync
let linesMap: number[] = []
const injectLineNumbers: MarkdownItRenderRule = (tokens, idx, options, _env, renderer) => {
  const token = tokens[idx]
  if (token.map && token.level === 0) {
    const line = token.map[0]
    token.attrJoin('class', 'line')
    token.attrSet('data-line', String(line))
    linesMap.push(line)
  }
  return renderer.renderToken(tokens, idx, options)
}
md.renderer.rules.paragraph_open = injectLineNumbers
md.renderer.rules.heading_open = injectLineNumbers
md.renderer.rules.blockquote_open = injectLineNumbers

cmFold.register('markdown')
// ========================================
// PLANTUML
// ========================================

// TODO: Use same options as defined in backend
plantuml.init(md, {})

// ========================================
// KATEX
// ========================================

const macros: Record<string, string> = {}
md.inline.ruler.after('escape', 'katex_inline', katexHelper.katexInline)
md.renderer.rules.katex_inline = (tokens, idx) => {
  try {
    return katex.renderToString(tokens[idx].content, {
      displayMode: false, macros
    })
  } catch (err) {
    console.warn(err)
    return tokens[idx].content
  }
}
md.block.ruler.after('blockquote', 'katex_block', katexHelper.katexBlock, {
  alt: [ 'paragraph', 'reference', 'blockquote', 'list' ]
})
md.renderer.rules.katex_block = (tokens, idx) => {
  try {
    return `<p>` + katex.renderToString(tokens[idx].content, {
      displayMode: true, macros
    }) + `</p>`
  } catch (err) {
    console.warn(err)
    return tokens[idx].content
  }
}

// ========================================
// TWEMOJI
// ========================================

md.renderer.rules.emoji = (token, idx) => {
  return twemoji.parse(token[idx].content, {
    callback (icon) {
      return `/_assets/svg/twemoji/${icon}.svg`
    }
  })
}

// ========================================
// Vue Component
// ========================================

let mermaidId = 0

export default defineComponent({
  components: {
    markdownHelp
  },
  props: {
    save: {
      type: Function as PropType<() => void>,
      default: () => {}
    }
  },
  data() {
    return {
      fabInsertMenu: false,
      cm: null as CodeMirror.EditorFromTextArea | null,
      cursorPos: { ch: 0, line: 1 } as CodeMirror.Position,
      previewShown: true,
      previewHTML: '',
      helpShown: false,
      spellModeActive: false,
      insertLinkDialog: false,
      markers: new Set<CodeMirror.TextMarker>(),
      debouncedProcessContent: null as _.DebouncedFunc<(newContent: string) => void> | null,
      debouncedScrollSync: null as _.DebouncedFunc<(cm: CodeMirror.Editor) => void> | null
    }
  },
  computed: {
    isMobile() {
      return this.$vuetify.display.smAndDown
    },
    isModalShown() {
      return this.helpShown || this.activeModal !== ''
    },
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    },
    mode() {
      return wikiStore.editor.mode
    },
    activeModal: {
      get() {
        return wikiStore.editor.activeModal
      },
      set(value: string) {
        wikiStore.editor.activeModal = value
      }
    }
  },
  watch: {
    previewShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.$nextTick(() => {
          const preview = this.$refs.editorPreview as HTMLElement
          this.renderMermaidDiagrams()
          Prism.highlightAllUnder(preview)
          preview.querySelectorAll('pre.line-numbers').forEach(pre => pre.classList.add('prismjs'))
        })
      }
    },
    spellModeActive (newValue: boolean) {
      if (newValue) {
        this.$nextTick(() => {
          ;(this.$refs.editorPreview as HTMLElement).focus()
        })
      }
    }
  },
  methods: {
    toggleModal(key: string) {
      this.activeModal = (this.activeModal === key) ? '' : key
      this.helpShown = false
    },
    handleEditorSaveConflict() {
      this.toggleModal(`editorModalConflict`)
    },
    handleEditorContentOverwrite() {
      requireEditor(this.cm).setValue(wikiStore.editor.content)
    },
    handleEditorInsert(opts: EditorInsertPayload) {
      const cm = requireEditor(this.cm)
      switch (opts.kind) {
        case 'IMAGE': {
          let img = `![${opts.text}](${opts.path})`
          if (opts.align && opts.align !== '') {
            img += `{.align-${opts.align}}`
          }
          this.insertAtCursor({
            content: img
          })
          break
        }
        case 'BINARY':
          this.insertAtCursor({
            content: `[${opts.text}](${opts.path})`
          })
          break
        case 'DIAGRAM': {
          const selStartLine = cm.getCursor('from').line
          const selEndLine = cm.getCursor('to').line + 1
          cm.getDoc().replaceSelection('```diagram\n' + opts.text + '\n```\n', 'start')
          this.processMarkers(selStartLine, selEndLine)
          break
        }
      }
    },
    closeAllModal() {
      this.activeModal = ''
      this.helpShown = false
    },
    onCmInput (newContent: string) {
      this.debouncedProcessContent?.(newContent)
    },
    onCmPaste (_cm: CodeMirror.Editor, _ev: ClipboardEvent) {
      // const clipItems = (ev.clipboardData || ev.originalEvent.clipboardData).items
      // for (let clipItem of clipItems) {
      //   if (_.startsWith(clipItem.type, 'image/')) {
      //     const file = clipItem.getAsFile()
      //     const reader = new FileReader()
      //     reader.onload = evt => {
      //       wikiStore.startLoading('editor-paste-image')
      //       this.insertAfter({
      //         content: `![${file.name}](${evt.target.result})`,
      //         newLine: true
      //       })
      //     }
      //     reader.readAsDataURL(file)
      //   }
      // }
    },
    processContent (newContent: string) {
      const cm = requireEditor(this.cm)
      linesMap = []
      // wikiStore.editor.content = newContent
      this.processMarkers(cm.firstLine(), cm.lastLine())
      this.previewHTML = DOMPurify.sanitize(md.render(newContent), {
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true }
      })
      this.$nextTick(() => {
        const preview = this.$refs.editorPreview as HTMLElement
        tabsetHelper.format()
        this.renderMermaidDiagrams()
        Prism.highlightAllUnder(preview)
        preview.querySelectorAll('pre.line-numbers').forEach(pre => pre.classList.add('prismjs'))
        this.scrollSync(cm)
      })
    },
    /**
     * Update cursor state
     */
    positionSync(cm: CodeMirror.Editor) {
      this.cursorPos = cm.getCursor('head')
    },
    /**
     * Wrap selection with start / end tags
     */
    toggleMarkup({ start, end }: ToggleMarkupOptions) {
      const cm = requireEditor(this.cm)
      if (!end) { end = start }
      if (!cm.getDoc().somethingSelected()) {
        return wikiStore.showNotification({
          message: this.$t('editor:markup.noSelectionError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      cm.getDoc().replaceSelections(cm.getDoc().getSelections().map((selection: string) => start + selection + end))
    },
    /**
     * Set current line as header
     */
    setHeaderLine(lvl: number) {
      const cm = requireEditor(this.cm)
      const curLine = cm.getDoc().getCursor('head').line
      let lineContent = cm.getDoc().getLine(curLine)
      const lineLength = lineContent.length
      if (_.startsWith(lineContent, '#')) {
        lineContent = lineContent.replace(/^(#+ )/, '')
      }
      lineContent = _.times(lvl, () => '#').join('') + ` ` + lineContent
      cm.getDoc().replaceRange(lineContent, { line: curLine, ch: 0 }, { line: curLine, ch: lineLength })
    },
    /**
     * Get the header lever of the current line
     */
    getHeaderLevel(cm: CodeMirror.Editor) {
      const curLine = cm.getDoc().getCursor('head').line
      const lineContent = cm.getDoc().getLine(curLine)
      const result = lineContent.match(/^(#+) /)
      return result?.[1]?.length ?? 0
    },
    /**
     * Insert content at cursor
     */
    insertAtCursor({ content }: InsertContentOptions) {
      const doc = requireEditor(this.cm).getDoc()
      const cursor = doc.getCursor('head')
      doc.replaceRange(content, cursor)
    },
    /**
     * Insert content after current line
     */
    insertAfter({ content, newLine }: InsertAfterOptions) {
      const doc = requireEditor(this.cm).getDoc()
      const curLine = doc.getCursor('to').line
      const lineLength = doc.getLine(curLine).length
      doc.replaceRange(newLine ? `\n${content}\n` : content, { line: curLine, ch: lineLength + 1 })
    },
    /**
     * Insert content before current line
     */
    insertBeforeEachLine({ content, after }: InsertBeforeEachLineOptions) {
      const doc = requireEditor(this.cm).getDoc()
      let lines: number[] = []
      if (!doc.somethingSelected()) {
        lines.push(doc.getCursor('head').line)
      } else {
        lines = _.flatten(doc.listSelections().map((selection: CodeMirror.Range) => {
          const range = Math.abs(selection.anchor.line - selection.head.line) + 1
          const lowestLine = (selection.anchor.line > selection.head.line) ? selection.head.line : selection.anchor.line
          return _.times(range, lineOffset => lineOffset + lowestLine)
        }))
      }
      lines.forEach(line => {
        let lineContent = doc.getLine(line)
        const lineLength = lineContent.length
        if (_.startsWith(lineContent, content)) {
          lineContent = lineContent.substring(content.length)
        }

        doc.replaceRange(content + lineContent, { line, ch: 0 }, { line, ch: lineLength })
      })
      const lastLine = _.last(lines)
      if (after && lastLine !== undefined) {
        doc.replaceRange(`\n${after}\n`, { line: lastLine, ch: doc.getLine(lastLine).length + 1 })
      }
    },
    /**
     * Update scroll sync
     */
    scrollSync (cm: CodeMirror.Editor) {
      this.debouncedScrollSync?.(cm)
    },
    performScrollSync (cm: CodeMirror.Editor) {
      if (!this.previewShown || cm.somethingSelected()) { return }
      const currentLine = cm.getCursor().line
      const preview = this.$refs.editorPreview as HTMLElement
      const previewContainer = this.$refs.editorPreviewContainer as HTMLElement
      if (currentLine < 3) {
        Velocity(preview, 'stop', true)
        if (preview.firstElementChild) {
          Velocity(preview.firstElementChild, 'scroll', { offset: '-50', duration: 1000, container: previewContainer })
        }
      } else {
        const closestLine = _.findLast(linesMap, line => line <= currentLine)
        const destination = preview.querySelector<HTMLElement>(`[data-line='${closestLine}']`)
        if (destination) {
          Velocity(preview, 'stop', true)
          Velocity(destination, 'scroll', { offset: '-100', duration: 1000, container: previewContainer })
        }
      }
    },
    toggleHelp () {
      this.helpShown = !this.helpShown
      this.activeModal = ''
    },
    toggleFullscreen () {
      requireEditor(this.cm).setOption('fullScreen', true)
    },
    refresh() {
      this.$nextTick(() => {
        requireEditor(this.cm).refresh()
      })
    },
    renderMermaidDiagrams () {
      document.querySelectorAll<HTMLElement>('.editor-markdown-preview pre.codeblock-mermaid > code').forEach(element => {
        mermaidId++
        const mermaidDef = element.innerText
        const mermaidElement = document.createElement('div')
        mermaidElement.innerHTML = `<div id="mermaid-id-${mermaidId}">${mermaid.render(`mermaid-id-${mermaidId}`, mermaidDef)}</div>`
        element.parentElement?.replaceWith(mermaidElement)
      })
    },
    autocomplete (cm: CodeMirror.Editor, change: CodeMirror.EditorChange) {
      if (cm.getModeAt(cm.getCursor()).name !== 'markdown') {
        return
      }

      // Links
      if (change.text[0] === '(') {
        const curLine = cm.getLine(change.from.line).substring(0, change.from.ch)
        if (curLine[curLine.length - 1] === ']') {
          cm.showHint({
            hint: async (hintEditor: CodeMirror.Editor) => {
              const cur = hintEditor.getCursor()
              const curLine = hintEditor.getLine(cur.line).substring(0, cur.ch)
              const queryString = curLine.substring(curLine.lastIndexOf('[') + 1, curLine.length - 2)
              const token = hintEditor.getTokenAt(cur)
              try {
                const resp = await searchPages(window.fetch.bind(window), queryString, {
                  locale: this.locale
                })
                if (resp && resp.totalHits > 0) {
                  return {
                    list: resp.results.map(r => ({
                      text: '(' + (siteLangs.length > 0 ? `/${r.locale}/${r.path}` : `/${r.path}`) + ')',
                      displayText: siteLangs.length > 0 ? `/${r.locale}/${r.path} - ${r.title}` : `/${r.path} - ${r.title}`
                    })),
                    from: CodeMirror.Pos(cur.line, token.start),
                    to: CodeMirror.Pos(cur.line, token.end)
                  }
                }
              } catch (err) {}
              return {
                list: [],
                from: CodeMirror.Pos(cur.line, token.start),
                to: CodeMirror.Pos(cur.line, token.end)
              }
            }
          })
        }
      }
    },
    insertLink () {
      this.insertLinkDialog = true
    },
    insertLinkHandler ({ locale, path }: LinkSelection) {
      const lastPart = _.last(path.split('/'))
      this.insertAtCursor({
        content: siteLangs.length > 0 ? `[${lastPart}](/${locale}/${path})` : `[${lastPart}](/${path})`
      })
    },
    processMarkers (from: number, to: number) {
      const cm = requireEditor(this.cm)
      let found: MarkdownMarkerKind | null = null
      let foundStart = 0
      let currentLine = from
      this.markers.forEach(marker => marker.clear())
      this.markers.clear()
      cm.eachLine(from, to, lineHandle => {
        const line = currentLine++
        if (lineHandle.text.startsWith('```diagram')) {
          found = 'diagram'
          foundStart = line
        } else if (lineHandle.text === '```' && found) {
          switch (found) {
            case 'diagram': {
              if (line - foundStart !== 2) {
                return
              }
              this.addMarker({
                from: { line: foundStart, ch: 3 },
                to: { line: foundStart, ch: 10 },
                text: 'Edit Diagram',
                action: ((start: number, end: number): EventListener => {
                  return () => {
                    const doc = requireEditor(this.cm).getDoc()
                    doc.setSelection({ line: start, ch: 0 }, { line: end, ch: 3 })
                    try {
                      const raw = doc.getLine(end - 1)
                      wikiStore.editor.activeModalData = Buffer.from(raw, 'base64').toString()
                      this.toggleModal(`editorModalDrawio`)
                    } catch (err) {
                      return wikiStore.showNotification({
                        message: 'Failed to process diagram data.',
                        style: 'warning',
                        icon: 'warning'
                      })
                    }
                  }
                })(foundStart, line)
              })
              const foldPosition = { line: foundStart, ch: cm.getLine(foundStart).length }
              if (!cm.isFolded(foldPosition)) {
                cm.foldCode(foundStart)
              }
              break
            }
          }
          found = null
        }
      })
    },
    addMarker ({ from, to, text, action }: AddMarkerOptions) {
      const markerElement = document.createElement('span')
      markerElement.appendChild(document.createTextNode(text))
      markerElement.className = 'CodeMirror-buttonmarker'
      markerElement.addEventListener('click', action)
      const marker = requireEditor(this.cm).markText(from, to, { replacedWith: markerElement })
      this.markers.add(marker)
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'markdown'

    if (this.mode === 'create' && !wikiStore.editor.content) {
      wikiStore.editor.content = '# Header\nYour content here'
    }

    // Initialize Mermaid API
    mermaid.initialize({
      startOnLoad: false,
      theme: this.$vuetify.theme.current.dark ? `dark` : `default`
    })

    // Initialize CodeMirror

    this.cm = CodeMirror.fromTextArea(this.$refs.cm as HTMLTextAreaElement, {
      tabSize: 2,
      mode: 'text/markdown',
      theme: 'wikijs-dark',
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      highlightSelectionMatches: {
        annotateScrollbar: true
      },
      viewportMargin: 50,
      inputStyle: 'contenteditable',
      allowDropFileTypes: ['image/jpg', 'image/png', 'image/svg', 'image/jpeg', 'image/gif'],
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']
    })
    this.debouncedProcessContent = _.debounce((newContent: string) => this.processContent(newContent), 600)
    this.debouncedScrollSync = _.debounce((editor: CodeMirror.Editor) => this.performScrollSync(editor), 500)
    this.cm.setValue(wikiStore.editor.content)
    this.cm.on('change', c => {
      wikiStore.editor.content = c.getValue()
      this.onCmInput(wikiStore.editor.content)
    })
    if (this.$vuetify.display.mdAndUp) {
      this.cm.setSize(null, 'calc(100vh - 112px - 24px)')
    } else {
      this.cm.setSize(null, 'calc(100vh - 112px - 16px)')
    }

    // Set Keybindings

    const keyBindings = {
      'F11' (c: CodeMirror.Editor) {
        c.setOption('fullScreen', !c.getOption('fullScreen'))
      },
      'Esc' (c: CodeMirror.Editor) {
        if (c.getOption('fullScreen')) c.setOption('fullScreen', false)
      }
    }
    _.set(keyBindings, `${CtrlKey}-S`, (_c: CodeMirror.Editor) => {
      this.save()
      return false
    })
    _.set(keyBindings, `${CtrlKey}-B`, (_c: CodeMirror.Editor) => {
      this.toggleMarkup({ start: `**` })
      return false
    })
    _.set(keyBindings, `${CtrlKey}-I`, (_c: CodeMirror.Editor) => {
      this.toggleMarkup({ start: `*` })
      return false
    })
    _.set(keyBindings, `${CtrlKey}-Alt-Right`, (c: CodeMirror.Editor) => {
      let lvl = this.getHeaderLevel(c)
      if (lvl >= 6) { lvl = 5 }
      this.setHeaderLine(lvl + 1)
      return false
    })
    _.set(keyBindings, `${CtrlKey}-Alt-Left`, (c: CodeMirror.Editor) => {
      let lvl = this.getHeaderLevel(c)
      if (lvl <= 1) { lvl = 2 }
      this.setHeaderLine(lvl - 1)
      return false
    })
    this.cm.setOption('extraKeys', keyBindings)

    this.cm.on('inputRead', this.autocomplete)

    // Handle cursor movement

    this.cm.on('cursorActivity', c => {
      this.positionSync(c)
      this.scrollSync(c)
    })

    // Handle special paste

    this.cm.on('paste', this.onCmPaste)

    // Render initial preview

    this.processContent(wikiStore.editor.content)
    this.refresh()

    onEditorInsert(this.handleEditorInsert)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount() {
    this.debouncedProcessContent?.cancel()
    this.debouncedScrollSync?.cancel()
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
  }
})
</script>

<style lang='scss'>

$editor-height: calc(100vh - 112px - 24px);
$editor-height-mobile: calc(100vh - 112px - 16px);

.editor-markdown {
  &-main {
    display: flex;
    width: 100%;
  }

  &-editor {
    background-color: darken(mc('grey', '900'), 4.5%);
    flex: 1 1 50%;
    display: block;
    height: $editor-height;
    position: relative;

    @include until($tablet) {
      height: $editor-height-mobile;
    }
  }

  &-preview {
    flex: 1 1 50%;
    background-color: mc('grey', '100');
    position: relative;
    height: $editor-height;
    overflow: hidden;
    padding: 1rem;

    @at-root .theme--dark & {
      background-color: mc('grey', '900');
    }

    @include until($tablet) {
      display: none;
    }

    &-enter-active, &-leave-active {
      transition: max-width .5s ease;
      max-width: 50vw;

      .editor-code-preview-content {
        width: 50vw;
        overflow:hidden;
      }
    }
    &-enter, &-leave-to {
      max-width: 0;
    }

    &-content {
      height: $editor-height;
      overflow-y: scroll;
      padding: 0;
      width: calc(100% + 17px);
      // -ms-overflow-style: none;

      // &::-webkit-scrollbar {
      //   width: 0px;
      //   background: transparent;
      // }

      @include until($tablet) {
        height: $editor-height-mobile;
      }

      > div {
        outline: none;
      }

      p.line {
        overflow-wrap: break-word;
      }

      .tabset {
        background-color: mc('teal', '700');
        color: mc('teal', '100') !important;
        padding: 5px 12px;
        font-size: 14px;
        font-weight: 500;
        border-radius: 5px 0 0 0;
        font-style: italic;

        &::after {
          display: none;
        }

        &-header {
          background-color: mc('teal', '500');
          color: #FFF !important;
          padding: 5px 12px;
          font-size: 14px;
          font-weight: 500;
          margin-top: 0 !important;

          &::after {
            display: none;
          }
        }

        &-content {
          border-left: 5px solid mc('teal', '500');
          background-color: mc('teal', '50');
          padding: 0 15px 15px;
          overflow: hidden;

          @at-root .theme--dark & {
            background-color: rgba(mc('teal', '500'), .1);
          }
        }
      }
    }
  }

  &-toolbar {
    background-color: mc('blue', '700');
    background-image: linear-gradient(to bottom, mc('blue', '700') 0%, mc('blue','800') 100%);
    color: #FFF;

    .v-toolbar__content {
      padding-left: 64px;

      @include until($tablet) {
        padding-left: 8px;
      }
    }
  }

  &-insert:not(.v-speed-dial--right) {
    @include from($tablet) {
      left: 50%;
      margin-left: -28px;
    }
  }

  &-sidebar {
    background-color: mc('grey', '900');
    width: 64px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 24px 0;

    @include until($tablet) {
      padding: 12px 0;
      width: 40px;
    }
  }

  &-sysbar {
    padding-left: 0;

    &-locale {
      background-color: rgba(255,255,255,.25);
      display:inline-flex;
      padding: 0 12px;
      height: 24px;
      width: 63px;
      justify-content: center;
      align-items: center;
    }
  }

  // ==========================================
  // Fix FAB revealing under codemirror
  // ==========================================

  .speed-dial--fixed {
    z-index: 8;
  }

  // ==========================================
  // CODE MIRROR
  // ==========================================

  .CodeMirror {
    height: auto;
    font-family: 'Roboto Mono', monospace;
    font-size: .9rem;

    .cm-header-1 {
      font-size: 1.5rem;
    }
    .cm-header-2 {
      font-size: 1.25rem;
    }
    .cm-header-3 {
      font-size: 1.15rem;
    }
    .cm-header-4 {
      font-size: 1.1rem;
    }
    .cm-header-5 {
      font-size: 1.05rem;
    }
    .cm-header-6 {
      font-size: 1.025rem;
    }
  }

  .CodeMirror-wrap pre.CodeMirror-line, .CodeMirror-wrap pre.CodeMirror-line-like {
    word-break: break-word;
  }

  .CodeMirror-focused .cm-matchhighlight {
    background-image: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12NgYGBgkKzc8x9CMDAwAAAmhwSbidEoSQAAAABJRU5ErkJggg==);
    background-position: bottom;
    background-repeat: repeat-x;
  }
  .cm-matchhighlight {
    background-color: mc('grey', '800');
  }
  .CodeMirror-selection-highlight-scrollbar {
    background-color: mc('green', '600');
  }
}

// HINT DROPDOWN

.CodeMirror-hints {
  position: absolute;
  z-index: 10;
  overflow: hidden;
  list-style: none;

  margin: 0;
  padding: 1px;

  box-shadow: 2px 3px 5px rgba(0,0,0,.2);
  border: 1px solid mc('grey', '700');

  background: mc('grey', '900');
  font-family: 'Roboto Mono', monospace;
  font-size: .9rem;

  max-height: 150px;
  overflow-y: auto;

  min-width: 250px;
  max-width: 80vw;
}

.CodeMirror-hint {
  margin: 0;
  padding: 0 4px;
  white-space: pre;
  color: #FFF;
  cursor: pointer;
}

li.CodeMirror-hint-active {
  background: mc('blue', '500');
  color: #FFF;
}
</style>

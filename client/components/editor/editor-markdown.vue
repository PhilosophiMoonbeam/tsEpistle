<template lang='pug'>
  .editor-markdown(ref='root')
    v-toolbar.editor-markdown-toolbar(density="compact", color='primary', flat, style='overflow-x: hidden;')
      template(v-if='isModalShown')
        v-spacer
        v-btn.animated.fadeInRight(variant="text", @click='closeAllModal')
          v-icon(start) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      template(v-else)
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn(icon, tile, v-bind='props', @click='toggleMarkup({ start: `**` })').mx-0
              v-icon mdi-format-bold
          span {{$t('editor:markup.bold')}}
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p1s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `*` })').mx-0
              v-icon mdi-format-italic
          span {{$t('editor:markup.italic')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p2s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `~~` })').mx-0
              v-icon mdi-format-strikethrough
          span {{$t('editor:markup.strikethrough')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p3s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `==` })').mx-0
              v-icon mdi-format-color-highlight
          span {{$t('editor:markup.highlight')}}
        v-menu(:open-on-hover='$vuetify.display.mdAndUp')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p3s(icon, tile, v-bind='props').mx-0
              v-icon mdi-format-header-pound
          v-list.py-0
            template(v-for='(n, idx) in 6', :key='idx')
              v-list-item(@click='setHeaderLine(n)')
                template(v-slot:append)
                  v-icon(:size='24 - (idx - 1) * 2') mdi-format-header-{{n}}
                v-list-item-title {{$t('editor:markup.heading', { level: n })}}
              v-divider(v-if='idx < 5')
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p4s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `~` })').mx-0
              v-icon mdi-format-subscript
          span {{$t('editor:markup.subscript')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p5s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `^` })').mx-0
              v-icon mdi-format-superscript
          span {{$t('editor:markup.superscript')}}
        v-menu(v-if='$vuetify.display.mdAndUp', open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p6s(icon, tile, v-bind='props').mx-0
              v-icon mdi-alpha-t-box-outline
          v-list.py-0
            v-list-item(@click='insertBeforeEachLine({ content: `> `})')
              template(v-slot:append)
                v-icon mdi-alpha-t-box-outline
              v-list-item-title {{$t('editor:markup.blockquote')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-info}`})')
              template(v-slot:append)
                v-icon(color='blue') mdi-alpha-i-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteInfo')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-success}`})')
              template(v-slot:append)
                v-icon(color='success') mdi-alpha-s-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteSuccess')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-warning}`})')
              template(v-slot:append)
                v-icon(color='warning') mdi-alpha-w-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteWarning')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `> `, after: `{.is-danger}`})')
              template(v-slot:append)
                v-icon(color='error') mdi-alpha-e-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteError')}}
            v-divider
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p7s(icon, tile, v-bind='props', @click='insertBeforeEachLine({ content: `- `})').mx-0
              v-icon mdi-format-list-bulleted
          span {{$t('editor:markup.unorderedList')}}
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p8s(icon, tile, v-bind='props', @click='insertBeforeEachLine({ content: `1. `})').mx-0
              v-icon mdi-format-list-numbered
          span {{$t('editor:markup.orderedList')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p9s(icon, tile, v-bind='props', @click='toggleMarkup({ start: "`" })').mx-0
              v-icon mdi-code-tags
          span {{$t('editor:markup.inlineCode')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p10s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `<kbd>`, end: `</kbd>` })').mx-0
              v-icon mdi-keyboard-variant
          span {{$t('editor:markup.keyboardKey')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p11s(icon, tile, v-bind='props', @click='insertAfter({ content: `---`, newLine: true })').mx-0
              v-icon mdi-minus
          span {{$t('editor:markup.horizontalBar')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="bottom", color='primary', v-if='previewShown')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p1s(icon, tile, v-bind='props', @click='spellModeActive = !spellModeActive').mx-0
                v-icon(:color='spellModeActive ? `amber` : `white`') mdi-spellcheck
            span {{$t('editor:markup.toggleSpellcheck')}}
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p2s(icon, tile, v-bind='props', @click='previewShown = !previewShown').mx-0
                v-icon mdi-book-open-outline
            span {{$t('editor:markup.togglePreviewPane')}}
        template(v-else)
          v-spacer
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(
                icon
                tile
                v-bind='props'
                @click='previewShown = !previewShown'
                :aria-label='previewShown ? `Show editor` : `Show preview`'
              )
                v-icon {{ previewShown ? 'mdi-pencil-outline' : 'mdi-book-open-outline' }}
            span {{ previewShown ? 'Show editor' : $t('editor:markup.togglePreviewPane') }}
          v-menu(location="left", min-width='260')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(
                icon
                tile
                v-bind='props'
                aria-label='More formatting tools'
              )
                v-icon mdi-dots-horizontal
            v-list(nav)
              v-list-item(@click='insertLink')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-link-plus
                v-list-item-title {{$t('editor:markup.insertLink')}}
              v-list-item(@click='toggleModal(`editorModalMedia`)')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-folder-multiple-image
                v-list-item-title {{$t('editor:markup.insertAssets')}}
              v-list-item(@click='toggleModal(`editorModalDrawio`)')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-chart-multiline
                v-list-item-title {{$t('editor:markup.insertDiagram')}}
              v-list-item(@click='toggleModal(`editorModalBlocks`)')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-qrcode
                v-list-item-title Insert content extension
              v-list-item(@click='insertDefinitionList')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-list-group-plus
                v-list-item-title {{$t('editor:markup.insertDefinitionList')}}
              v-divider
              v-list-item(@click='toggleMarkup({ start: `~~` })')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-strikethrough
                v-list-item-title {{$t('editor:markup.strikethrough')}}
              v-list-item(@click='insertBeforeEachLine({ content: `> `})')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-quote-open
                v-list-item-title {{$t('editor:markup.blockquote')}}
              v-list-item(@click='toggleMarkup({ start: "`" })')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-code-tags
                v-list-item-title {{$t('editor:markup.inlineCode')}}
              v-list-item(@click='toggleMarkup({ start: `==` })')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-color-highlight
                v-list-item-title {{$t('editor:markup.highlight')}}
              v-divider
              v-list-item(@click='toggleHelp')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-help-circle
                v-list-item-title {{$t('editor:markup.markdownFormattingHelp')}}
    .editor-markdown-main
      .editor-markdown-sidebar
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInLeft(icon, tile, v-bind='props', @click='insertLink').mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, tile, v-bind='props', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p2s(icon, tile, v-bind='props', @click='toggleModal(`editorModalDrawio`)').mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, tile, v-bind='props', aria-label='Insert content extension', @click='toggleModal(`editorModalBlocks`)').mx-0
              v-icon(:color='activeModal === `editorModalBlocks` ? `teal` : ``') mdi-qrcode
          span Insert content extension
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, tile, v-bind='props', @click='insertDefinitionList').mx-0
              v-icon mdi-format-list-group-plus
          span {{$t('editor:markup.insertDefinitionList')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, tile, v-bind='props', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, tile, v-bind='props', @click='toggleHelp').mx-0
                v-icon(:color='helpShown ? `teal` : ``') mdi-help-circle
            span {{$t('editor:markup.markdownFormattingHelp')}}
      .editor-markdown-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        div(ref='cm')
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

    v-system-bar.editor-status-bar.editor-markdown-sysbar(absolute, status, color="grey-darken-3")
      .text-body-small.editor-markdown-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.px-3 /{{path}}
      template(v-if='collaborationStatus')
        v-spacer
        .text-body-small.d-flex.align-center(
          role='status'
          aria-live='polite'
          :title='collaborationLabel'
        )
          v-icon.mr-1(size="small", :color='collaborationColor') {{collaborationIcon}}
          span {{collaborationLabel}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small Markdown
        v-spacer
        .text-body-small Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}

    markdown-help(v-if='helpShown')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')</template>

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
import { decodeBase64Text } from '../../helpers/base64'

/* global siteConfig, siteLangs */

import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { TextEditor, type TextEditorHandle, type TextPosition } from './common/text-editor'
import {
  createMarkdownCollaboration,
  type CollaborationStatus,
  type MarkdownCollaboration
} from './collaboration'

// Markdown-it
import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import { full as mdEmoji } from 'markdown-it-emoji'
import mdTaskLists from 'markdown-it-task-lists'
import mdExpandTabs from 'markdown-it-expand-tabs'
import mdAbbr from 'markdown-it-abbr'
import mdSup from 'markdown-it-sup'
import mdSub from 'markdown-it-sub'
import mdMark from 'markdown-it-mark'
import mdDeflist from 'markdown-it-deflist'
import mdMultiTable from 'markdown-it-multimd-table'
import mdFootnote from 'markdown-it-footnote'
import mdImsize from '../../../shared/markdown-it-image-size'
import katex from 'katex'
import underline from '../../libs/markdown-it-underline'
import 'katex/dist/contrib/mhchem.mjs'
import twemoji from 'twemoji'
import plantuml from './markdown/plantuml'

// Prism (Syntax Highlighting)
import Prism from '../../libs/prism/setup'

// Mermaid
import mermaid from 'mermaid'

// Helpers
import katexHelper from './common/katex'
import tabsetHelper from './markdown/tabset'

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
  from: TextPosition
  to: TextPosition
  text: string
  action: EventListener
}

type MarkdownItRenderRule = NonNullable<InstanceType<typeof MarkdownIt>['renderer']['rules'][string]>

function requireEditor (editor: TextEditorHandle | null): TextEditorHandle {
  if (!editor) throw new Error('Markdown editor has not been initialized.')
  return editor
}

// ========================================
// INIT
// ========================================

// Platform detection
const CtrlKey = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'


// Markdown Instance
const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang === 'diagram') {
      return `<pre class="diagram">` + decodeBase64Text(str) + `</pre>`
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
  .use(underline)
  .use(mdEmoji)
  .use(mdTaskLists, { label: false, labelAfter: false })
  .use(mdExpandTabs)
  .use(mdAbbr)
  .use(mdSup)
  .use(mdSub)
  .use(mdMultiTable, { multiline: true, rowspan: true, headerless: true })
  .use(mdMark)
  .use(mdDeflist)
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

// ========================================
// PLANTUML
// ========================================

// Plugin defaults mirror the server renderer defaults.
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
const collaborations = new WeakMap<object, MarkdownCollaboration>()

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
type MarkdownEditorHost = HTMLElement & { __wikiSourceEditor?: TextEditorHandle }

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
      cm: null as TextEditorHandle | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: this.$vuetify.display.mdAndUp,
      previewHTML: '',
      helpShown: false,
      spellModeActive: false,
      insertLinkDialog: false,
      markers: [] as AddMarkerOptions[],
      debouncedProcessContent: null as _.DebouncedFunc<(newContent: string) => void> | null,
      collaborationStatus: null as CollaborationStatus | null,
      editorDisposed: false,
      debouncedScrollSync: null as _.DebouncedFunc<(cm: TextEditorHandle) => void> | null
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
    },
    collaborationLabel(): string {
      const status = this.collaborationStatus
      if (!status) return ''
      if (status.state === 'connected') return `${status.participants} editing`
      if (status.state === 'connecting') return 'Live: connecting'
      if (status.state === 'offline') return 'Live: offline — edits kept locally'
      return 'Live stopped — reload before saving'
    },
    collaborationIcon(): string {
      const state = this.collaborationStatus?.state
      if (state === 'connected') return 'mdi-account-multiple'
      if (state === 'connecting') return 'mdi-sync'
      if (state === 'offline') return 'mdi-cloud-off-outline'
      return 'mdi-alert-outline'
    },
    collaborationColor(): string {
      const state = this.collaborationStatus?.state
      if (state === 'connected') return 'green-lighten-2'
      if (state === 'conflict') return 'amber-lighten-2'
      return 'white'
    },
  },
  watch: {
    previewShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.$nextTick(() => {
          const preview = this.$refs.editorPreview as HTMLElement
          void this.renderMermaidDiagrams()
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
          const selStartLine = cm.cursor('from').line
          const selEndLine = cm.cursor('to').line + 1
          cm.replaceSelection('```diagram\n' + opts.text + '\n```\n')
          this.processMarkers(selStartLine, selEndLine)
          break
        }
        case 'EXTENSION':
          if (typeof opts.text === 'string') {
            this.insertAtCursor({
              content: opts.text
            })
          }
          break
      }
    },
    closeAllModal() {
      this.activeModal = ''
      this.helpShown = false
    },
    onCmInput (newContent: string) {
      this.debouncedProcessContent?.(newContent)
    },
    onCmPaste (_ev: ClipboardEvent) {
      // Image paste uploads remain handled by the asset workflow.
    },
    processContent (newContent: string) {
      const cm = requireEditor(this.cm)
      linesMap = []
      // wikiStore.editor.content = newContent
      this.processMarkers(0, cm.lineCount)
      this.previewHTML = DOMPurify.sanitize(md.render(newContent), {
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true }
      })
      this.$nextTick(() => {
        const preview = this.$refs.editorPreview as HTMLElement
        tabsetHelper.format()
        void this.renderMermaidDiagrams()
        Prism.highlightAllUnder(preview)
        preview.querySelectorAll('pre.line-numbers').forEach(pre => pre.classList.add('prismjs'))
        this.scrollSync(cm)
      })
    },
    /**
     * Update cursor state
     */
    positionSync(position: TextPosition) {
      this.cursorPos = position
    },
    /**
     * Wrap selection with start / end tags
     */
    toggleMarkup({ start, end }: ToggleMarkupOptions) {
      const cm = requireEditor(this.cm)
      if (!end) { end = start }
      if (!cm.hasSelection()) {
        return wikiStore.showNotification({
          message: this.$t('editor:markup.noSelectionError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      const selections = cm.selectedOffsets().reverse()
      for (const selection of selections) {
        cm.replaceOffsets(start + cm.slice(selection.from, selection.to) + end, selection.from, selection.to)
      }
    },
    /**
     * Set current line as header
     */
    setHeaderLine(lvl: number) {
      const cm = requireEditor(this.cm)
      const curLine = cm.cursor().line
      let lineContent = cm.getLine(curLine)
      const lineLength = lineContent.length
      if (_.startsWith(lineContent, '#')) lineContent = lineContent.replace(/^(#+ )/, '')
      lineContent = _.times(lvl, () => '#').join('') + ` ` + lineContent
      cm.replaceRange(lineContent, { line: curLine, ch: 0 }, { line: curLine, ch: lineLength })
    },
    /**
     * Get the header lever of the current line
     */
    getHeaderLevel(cm: TextEditorHandle) {
      const lineContent = cm.getLine(cm.cursor().line)
      const result = lineContent.match(/^(#+) /)
      return result?.[1]?.length ?? 0
    },
    /**
     * Insert content at cursor
     */
    insertAtCursor({ content }: InsertContentOptions) {
      const editor = requireEditor(this.cm)
      editor.replaceRange(content, editor.cursor())
    },
    /**
     * Insert content after current line
     */
    insertAfter({ content, newLine }: InsertAfterOptions) {
      const editor = requireEditor(this.cm)
      const curLine = editor.cursor('to').line
      editor.replaceRange(newLine ? `\n${content}\n` : content, { line: curLine, ch: editor.getLine(curLine).length })
    },
    /**
     * Insert content before current line
     */
    insertBeforeEachLine({ content, after }: InsertBeforeEachLineOptions) {
      const editor = requireEditor(this.cm)
      const lines = editor.selectedLines()
      for (const line of [...lines].reverse()) {
        const lineContent = editor.getLine(line)
        const replacement = _.startsWith(lineContent, content) ? lineContent.substring(content.length) : content + lineContent
        editor.replaceRange(replacement, { line, ch: 0 }, { line, ch: lineContent.length })
      }
      const lastLine = _.last(lines)
      if (after && lastLine !== undefined) {
        editor.replaceRange(`\n${after}\n`, { line: lastLine, ch: editor.getLine(lastLine).length })
      }
    },
    insertDefinitionList() {
      const editor = requireEditor(this.cm)
      const position = editor.cursor()
      const line = editor.getLine(position.line)
      const term = String(this.$t('editor:markup.definitionListTerm'))
      const definition = String(this.$t('editor:markup.definitionListDefinition'))
      const skeleton = `${term}\n: ${definition}\n\n${term}\n: ${definition}`
      const before = line.slice(0, position.ch).trim().length > 0 ? '\n\n' : ''
      const after = line.slice(position.ch).trim().length > 0 ? '\n\n' : '\n'
      editor.replaceRange(`${before}${skeleton}${after}`, position)
      const firstTermLine = position.line + (before ? 2 : 0)
      editor.setSelection(
        { line: firstTermLine, ch: 0 },
        { line: firstTermLine, ch: term.length }
      )
    },
    /**
     * Update scroll sync
     */
    scrollSync (cm: TextEditorHandle) {
      this.debouncedScrollSync?.(cm)
    },
    performScrollSync (cm: TextEditorHandle) {
      if (!this.previewShown || cm.hasSelection()) return
      const currentLine = cm.cursor().line
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
      this.$el.requestFullscreen?.()
    },
    refresh() {
      this.$nextTick(() => requireEditor(this.cm).requestMeasure())
    },
    async renderMermaidDiagrams (): Promise<void> {
      const elements = document.querySelectorAll<HTMLElement>('.editor-markdown-preview pre.codeblock-mermaid > code')
      for (const element of elements) {
        const codeBlock = element.parentElement
        if (!codeBlock) continue
        const id = `mermaid-id-${++mermaidId}`
        try {
          const { svg, bindFunctions } = await mermaid.render(id, element.innerText)
          const mermaidElement = document.createElement('div')
          mermaidElement.innerHTML = svg
          codeBlock.replaceWith(mermaidElement)
          bindFunctions?.(mermaidElement)
        } catch {
          // Keep the source block visible when the diagram is invalid.
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
    processMarkers (_from: number, _to: number) {
      const cm = requireEditor(this.cm)
      let found: MarkdownMarkerKind | null = null
      let foundStart = 0
      this.markers = []
      for (let line = 0; line < cm.lineCount; line++) {
        const text = cm.getLine(line)
        if (text.startsWith('```diagram')) {
          found = 'diagram'
          foundStart = line
        } else if (text === '```' && found === 'diagram') {
          if (line - foundStart === 2) {
            this.addMarker({
              from: { line: foundStart, ch: 3 },
              to: { line: foundStart, ch: 10 },
              text: 'Edit Diagram',
              action: () => {
                const editor = requireEditor(this.cm)
                editor.setSelection({ line: foundStart, ch: 0 }, { line, ch: 3 })
                try {
                  wikiStore.editor.activeModalData = decodeBase64Text(editor.getLine(line - 1))
                  this.toggleModal(`editorModalDrawio`)
                } catch {
                  wikiStore.showNotification({
                    message: 'Failed to process diagram data.',
                    style: 'warning',
                    icon: 'warning'
                  })
                }
              }
            })
            cm.foldRange(
              { line: foundStart, ch: cm.getLine(foundStart).length },
              { line, ch: 0 }
            )
          }
          found = null
        }
      }
      cm.setMarkers(this.markers)
    },
    addMarker (marker: AddMarkerOptions) {
      this.markers.push(marker)
    }
  },
  async mounted() {
    wikiStore.editor.editorKey = 'markdown'

    if (this.mode === 'create' && !wikiStore.editor.content) {
      wikiStore.editor.content = '# Header\nYour content here'
    }

    // Initialize Mermaid API
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: this.$vuetify.theme.current.dark ? `dark` : `default`
    })

    this.debouncedProcessContent = _.debounce((newContent: string) => this.processContent(newContent), 600)
    this.debouncedScrollSync = _.debounce((editor: TextEditorHandle) => this.performScrollSync(editor), 500)
    const completePageLink = async (context: CompletionContext) => {
      const prefix = context.matchBefore(/\[[^\]]+\]\($/)
      if (!prefix) return null
      const title = prefix.text.slice(1, -2)
      try {
        const response = await searchPages(window.fetch.bind(window), title, { locale: this.locale })
        return {
          from: context.pos,
          options: response.results.map(result => ({
            label: siteLangs.length > 0 ? `/${result.locale}/${result.path} - ${result.title}` : `/${result.path} - ${result.title}`,
            apply: (siteLangs.length > 0 ? `/${result.locale}/${result.path}` : `/${result.path}`) + ')'
          }))
        }
      } catch {
        return null
      }
    }

    const extensions = [
      autocompletion({ override: [completePageLink] }),
      keymap.of([
        { key: 'F11', run: () => { this.toggleFullscreen(); return true } },
        { key: 'Mod-s', run: () => { this.save(); return true } },
        { key: 'Mod-b', run: () => { this.toggleMarkup({ start: '**' }); return true } },
        { key: 'Mod-i', run: () => { this.toggleMarkup({ start: '*' }); return true } },
        {
          key: 'Mod-Alt-ArrowRight',
          run: () => {
            let level = this.getHeaderLevel(requireEditor(this.cm))
            if (level >= 6) level = 5
            this.setHeaderLine(level + 1)
            return true
          }
        },
        {
          key: 'Mod-Alt-ArrowLeft',
          run: () => {
            let level = this.getHeaderLevel(requireEditor(this.cm))
            if (level <= 1) level = 2
            this.setHeaderLine(level - 1)
            return true
          }
        }
      ])
    ]
    if (this.mode === 'update' && Number.isSafeInteger(wikiStore.page.id) && wikiStore.page.id > 0) {
      try {
        const collaboration = await createMarkdownCollaboration({
          pageId: wikiStore.page.id,
          expectedUpdatedAt: () => wikiStore.editor.checkoutDateActive,
          fetchImpl: window.fetch,
          onBaseUpdatedAt: updatedAt => { wikiStore.editor.checkoutDateActive = updatedAt },
          onStatus: status => {
            if (this.editorDisposed) return
            const firstConflict = status.state === 'conflict' && this.collaborationStatus?.state !== 'conflict'
            this.collaborationStatus = status
            if (firstConflict) {
              wikiStore.showNotification({
                message: 'Live collaboration stopped because the page or your access changed. Your edits remain in this editor.',
                style: 'warning',
                icon: 'warning'
              })
            }
          }
        })
        if (this.editorDisposed) {
          collaboration.destroy()
          return
        }
        collaborations.set(this, collaboration)
        wikiStore.editor.content = collaboration.content
        extensions.push(collaboration.extension)
      } catch {
        if (!this.editorDisposed) {
          wikiStore.showNotification({
            message: 'Live collaboration is unavailable. You can continue editing locally.',
            style: 'warning',
            icon: 'warning'
          })
        }
      }
    }

    const cm = new TextEditor({
      parent: this.$refs.cm as HTMLElement,
      value: wikiStore.editor.content,
      language: markdown(),
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      extensions,
      onChange: value => {
        wikiStore.editor.content = value
        this.onCmInput(value)
      },
      onCursor: position => {
        this.positionSync(position)
        this.scrollSync(cm)
      }
    })
    this.cm = cm
    Object.defineProperty(this.$refs.root as MarkdownEditorHost, '__wikiSourceEditor', {
      configurable: true,
      value: cm
    })
    ;(this.$refs.cm as HTMLElement).style.height = this.$vuetify.display.mdAndUp
      ? 'calc(100vh - 112px - 24px)'
      : 'calc(100vh - 112px - 16px)'

    // Render initial preview

    this.processContent(wikiStore.editor.content)
    this.refresh()

    onEditorInsert(this.handleEditorInsert)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount() {
    this.editorDisposed = true
    this.debouncedProcessContent?.cancel()
    this.debouncedScrollSync?.cancel()
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    delete (this.$refs.root as MarkdownEditorHost).__wikiSourceEditor
    this.cm?.destroy()
    this.cm = null
    collaborations.get(this)?.destroy()
    collaborations.delete(this)
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

      &.is-mobile-hidden {
        display: none;
      }
  }

  &-preview {
    flex: 1 1 50%;
    background-color: mc('grey', '100');
    position: relative;
    height: $editor-height;
    overflow: hidden;
    padding: 1rem;

    @at-root .v-theme--dark & {
      background-color: mc('grey', '900');
    }

    @include until($tablet) {
      display: block;
      flex: 1 1 100%;
      width: 100%;
      max-width: 100vw !important;
      padding: 12px;
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
        width: 100%;
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

          @at-root .v-theme--dark & {
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


  &-sidebar {
    background-color: mc('grey', '900');
    width: 64px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 24px 0;

    @include until($tablet) {
      display: none;
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

}

</style>

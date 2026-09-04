<template lang='pug'>
  .editor-markdown(ref='root')
    v-toolbar.editor-markdown-toolbar(density="compact", color='primary', flat, role='toolbar', aria-label='Formatting tools')
      template(v-if='isModalShown')
        v-spacer
        v-btn.animated.fadeInRight(variant="text", @click='closeAllModal')
          v-icon(start) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      template(v-else)
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.bold`)', @click='toggleMarkup({ start: `**` })').mx-0
              v-icon mdi-format-bold
          span {{$t('editor:markup.bold')}}
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p1s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.italic`)', @click='toggleMarkup({ start: `*` })').mx-0
              v-icon mdi-format-italic
          span {{$t('editor:markup.italic')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p2s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.strikethrough`)', @click='toggleMarkup({ start: `~~` })').mx-0
              v-icon mdi-format-strikethrough
          span {{$t('editor:markup.strikethrough')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p3s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.highlight`)', @click='toggleMarkup({ start: `==` })').mx-0
              v-icon mdi-format-color-highlight
          span {{$t('editor:markup.highlight')}}
        v-menu(:open-on-hover='$vuetify.display.mdAndUp')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p3s(icon, rounded='0', v-bind='props', aria-label='Heading level').mx-0
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
            v-btn.animated.fadeIn.wait-p4s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.subscript`)', @click='toggleMarkup({ start: `~` })').mx-0
              v-icon mdi-format-subscript
          span {{$t('editor:markup.subscript')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p5s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.superscript`)', @click='toggleMarkup({ start: `^` })').mx-0
              v-icon mdi-format-superscript
          span {{$t('editor:markup.superscript')}}
        v-menu(v-if='$vuetify.display.mdAndUp', open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p6s(icon, rounded='0', v-bind='props', aria-label='Admonition type').mx-0
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
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p7s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.unorderedList`)', @click='insertBeforeEachLine({ content: `- `})').mx-0
              v-icon mdi-format-list-bulleted
          span {{$t('editor:markup.unorderedList')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p8s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.orderedList`)', @click='insertBeforeEachLine({ content: `1. `})').mx-0
              v-icon mdi-format-list-numbered
          span {{$t('editor:markup.orderedList')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p9s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.inlineCode`)', @click='toggleMarkup({ start: "`" })').mx-0
              v-icon mdi-code-tags
          span {{$t('editor:markup.inlineCode')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p10s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.keyboardKey`)', @click='toggleMarkup({ start: `<kbd>`, end: `</kbd>` })').mx-0
              v-icon mdi-keyboard-variant
          span {{$t('editor:markup.keyboardKey')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p11s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.horizontalBar`)', @click='insertAfter({ content: `---`, newLine: true })').mx-0
              v-icon mdi-minus
          span {{$t('editor:markup.horizontalBar')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(v-if='previewShown', location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn(icon, rounded='0', v-bind='props', aria-label='Align preview to cursor', @click='alignPreviewToCursor').mx-0
                v-icon mdi-crosshairs-gps
            span Align preview to cursor
          v-tooltip(location="bottom", color='primary', v-if='previewShown')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p1s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.toggleSpellcheck`)', :aria-pressed='spellModeActive', @click='spellModeActive = !spellModeActive').mx-0
                v-icon(:color='spellModeActive ? `amber` : `white`') mdi-spellcheck
            span {{$t('editor:markup.toggleSpellcheck')}}
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p2s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.togglePreviewPane`)', :aria-pressed='previewShown', @click='previewShown = !previewShown').mx-0
                v-icon mdi-book-open-outline
            span {{$t('editor:markup.togglePreviewPane')}}
        template(v-else)
          v-spacer
          v-tooltip(v-if='previewShown', location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(icon, rounded='0', v-bind='props', aria-label='Align preview to cursor', @click='alignPreviewToCursor')
                v-icon mdi-crosshairs-gps
            span Align preview to cursor
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(
                icon
                rounded='0'
                v-bind='props'
                :aria-pressed='previewShown'
                @click='previewShown = !previewShown'
                :aria-label='previewShown ? `Show editor` : `Show preview`'
              )
                v-icon {{ previewShown ? 'mdi-pencil-outline' : 'mdi-book-open-outline' }}
            span {{ previewShown ? 'Show editor' : $t('editor:markup.togglePreviewPane') }}
          v-menu(location="left", min-width='260')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(
                icon
                rounded='0'
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
              v-list-item(@click='insertAbbreviation')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-tooltip-plus-outline
                v-list-item-title {{$t('editor:markup.insertAbbreviation')}}
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
            v-btn.animated.fadeInLeft(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.insertLink`)', @click='insertLink').mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.insertAssets`)', :aria-pressed='activeModal === `editorModalMedia`', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p2s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.insertDiagram`)', :aria-pressed='activeModal === `editorModalDrawio`', @click='toggleModal(`editorModalDrawio`)').mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, rounded='0', v-bind='props', aria-label='Insert content extension', :aria-pressed='activeModal === `editorModalBlocks`', @click='toggleModal(`editorModalBlocks`)').mx-0
              v-icon(:color='activeModal === `editorModalBlocks` ? `teal` : ``') mdi-qrcode
          span Insert content extension
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.insertDefinitionList`)', @click='insertDefinitionList').mx-0
              v-icon mdi-format-list-group-plus
          span {{$t('editor:markup.insertDefinitionList')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p5s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.insertAbbreviation`)', @click='insertAbbreviation').mx-0
              v-icon mdi-tooltip-plus-outline
          span {{$t('editor:markup.insertAbbreviation')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.distractionFreeMode`)', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:markup.markdownFormattingHelp`)', :aria-pressed='helpShown', @click='toggleHelp').mx-0
                v-icon(:color='helpShown ? `teal` : ``') mdi-help-circle
            span {{$t('editor:markup.markdownFormattingHelp')}}
      .editor-markdown-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        div(ref='cm')
      transition(name='editor-markdown-preview', :css='$vuetify.display.mdAndUp')
        .editor-markdown-preview(v-if='previewShown')
          .editor-markdown-preview-content.editor-page-canvas.contents(ref='editorPreviewContainer')
            div(
              ref='editorPreview'
              v-html='previewHTML'
              :spellcheck='false'
              )

    .v-system-bar.editor-status-bar.editor-markdown-sysbar.bg-grey-darken-3
      .text-body-small.editor-markdown-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.editor-markdown-sysbar-path.px-3(:title='`/${path}`') /{{path}}
      template(v-if='collaborationStatus')
        v-spacer
        .text-body-small.d-flex.align-center.editor-markdown-sysbar-collaboration(
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
import { defineComponent, markRaw, type PropType } from 'vue'
import { useDisplay } from 'vuetify'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import markdownHelp from './markdown/help.vue'
import { searchPages } from '../../helpers/pages-api'
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



// Helpers
import {
  createWikiMarkdownRenderer,
  enhanceWikiMarkdownPreview,
  sanitizeWikiMarkdownHtml
} from './markdown/preview.ts'

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

type MarkdownItRenderRule = NonNullable<ReturnType<typeof createWikiMarkdownRenderer>['renderer']['rules'][string]>
type MarkdownRenderEnvironment = { sourceLines: number[] }

function requireEditor (editor: TextEditorHandle | null): TextEditorHandle {
  if (!editor) throw new Error('Markdown editor has not been initialized.')
  return editor
}

// ========================================
// INIT
// ========================================

const md = createWikiMarkdownRenderer()

// ========================================
// HELPER FUNCTIONS
// ========================================

// Stamp source lines into preview roots for explicit cursor-to-preview alignment.
const injectSourceLine: MarkdownItRenderRule = (tokens, idx, options, env, renderer) => {
  const token = tokens[idx]
  if (token.map && token.level === 0) {
    const line = token.map[0]
    token.attrJoin('class', 'line')
    token.attrSet('data-source-line', String(line))
    const sourceLines = env?.sourceLines
    if (Array.isArray(sourceLines)) sourceLines.push(line)
  }
  return renderer.renderToken(tokens, idx, options)
}
md.renderer.rules.paragraph_open = injectSourceLine
md.renderer.rules.heading_open = injectSourceLine
md.renderer.rules.blockquote_open = injectSourceLine

const renderFence = md.renderer.rules.fence
if (!renderFence) throw new TypeError('Markdown fence renderer is unavailable.')
md.renderer.rules.fence = (tokens, idx, options, env, renderer) => {
  const line = tokens[idx]?.map?.[0]
  const html = renderFence(tokens, idx, options, env, renderer)
  if (line === undefined) return html
  const sourceLines = env?.sourceLines
  if (Array.isArray(sourceLines)) sourceLines.push(line)
  return html.replace(/^<([a-z]+)/, `<$1 data-source-line="${line}"`)
}

const collaborations = new WeakMap<object, MarkdownCollaboration>()
const sourceLinesByEditor = new WeakMap<object, number[]>()
const previewAlignmentTargets = new WeakMap<object, HTMLElement>()

function stopPreviewAlignment (editor: object) {
  const target = previewAlignmentTargets.get(editor)
  if (target) Velocity(target, 'stop', true)
  previewAlignmentTargets.delete(editor)
}


// ========================================
// Vue Component
// ========================================

type MarkdownEditorHost = HTMLElement & { __wikiSourceEditor?: TextEditorHandle }

export default defineComponent({
  components: {
    markdownHelp
  },
  emits: ['collaboration-state'],
  props: {
    save: {
      type: Function as PropType<() => void>,
      default: () => {}
    }
  },
  setup() {
    const { mdAndUp } = useDisplay()
    return { mdAndUp }
  },
  data() {
    return {
      cm: null as TextEditorHandle | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: this.mdAndUp,
      previewHTML: '',
      previewDirty: true,
      helpShown: false,
      spellModeActive: false,
      insertLinkDialog: false,
      debouncedProcessContent: null as _.DebouncedFunc<(newContent: string) => void> | null,
      collaborationStatus: null as CollaborationStatus | null,
      editorDisposed: false,
      collaborationAbortController: null as AbortController | null
    }
  },
  computed: {
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
    '$vuetify.theme.current.dark' (newValue: boolean) {
      this.cm?.setDark(newValue)
    },
    previewShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.debouncedProcessContent?.cancel()
        if (this.previewDirty) {
          this.processContent(requireEditor(this.cm).getValue())
          return
        }
        this.$nextTick(() => {
          if (this.editorDisposed) return
          const preview = this.$refs.editorPreview as HTMLElement | undefined
          if (preview) {
            enhanceWikiMarkdownPreview(preview, this.$vuetify.theme.current.dark)
          }
        })
      } else if (!newValue && oldValue) {
        stopPreviewAlignment(this)
      }
    },
    spellModeActive (newValue: boolean) {
      this.cm?.setSpellcheck(newValue)
      if (newValue) {
        this.$nextTick(() => {
          if (!this.editorDisposed && this.cm) {
            this.cm.focus()
          }
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
      this.previewDirty = true
      this.debouncedProcessContent?.(newContent)
    },
    onCmPaste (_ev: ClipboardEvent) {
      // Image paste uploads remain handled by the asset workflow.
    },
    processContent (newContent: string) {
      const cm = requireEditor(this.cm)
      this.processMarkers(0, cm.lineCount)
      if (!this.previewShown) {
        this.previewDirty = true
        return
      }
      const renderEnvironment: MarkdownRenderEnvironment = { sourceLines: [] }
      this.previewHTML = sanitizeWikiMarkdownHtml(md.render(newContent, renderEnvironment))
      sourceLinesByEditor.set(this, renderEnvironment.sourceLines)
      this.previewDirty = false
      this.$nextTick(() => {
        if (this.editorDisposed || !this.previewShown) return
        const preview = this.$refs.editorPreview as HTMLElement | undefined
        if (!preview) return
        enhanceWikiMarkdownPreview(preview, this.$vuetify.theme.current.dark)
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
    insertAbbreviation() {
      const editor = requireEditor(this.cm)
      const position = editor.cursor()
      const line = editor.getLine(position.line)
      const beforeText = line.slice(0, position.ch)
      const afterText = line.slice(position.ch)
      const term = String(this.$t('editor:markup.abbreviationTerm'))
      const definition = String(this.$t('editor:markup.abbreviationDefinition'))
      const startsNewLine = beforeText.trim().length > 0
      const insertion = `${startsNewLine ? '\n' : ''}*[${term}]: ${definition}${afterText.trim().length > 0 ? '\n' : ''}`
      const from = startsNewLine ? position : { line: position.line, ch: 0 }
      editor.replaceRange(insertion, from, position)
      const termLine = position.line + (startsNewLine ? 1 : 0)
      const termStart = startsNewLine ? 2 : from.ch + 2
      editor.setSelection(
        { line: termLine, ch: termStart },
        { line: termLine, ch: termStart + term.length }
      )
    },
    /**
     * Align the independently scrollable preview to the current selection head.
     */
    alignPreviewToCursor () {
      if (this.editorDisposed || !this.previewShown || !this.cm || this.previewHTML.trim().length === 0) return
      const preview = this.$refs.editorPreview as HTMLElement | undefined
      const previewContainer = this.$refs.editorPreviewContainer as HTMLElement | undefined
      const firstPreviewElement = preview?.firstElementChild
      if (!preview || !previewContainer || !(firstPreviewElement instanceof HTMLElement)) return

      const currentLine = this.cm.cursor('head').line
      const sourceLines = sourceLinesByEditor.get(this) ?? []
      let markedDestination: HTMLElement | null = null
      for (let index = sourceLines.length - 1; index >= 0; index--) {
        const sourceLine = sourceLines[index]
        if (sourceLine === undefined || sourceLine > currentLine) continue
        markedDestination = preview.querySelector<HTMLElement>(`[data-source-line='${sourceLine}']`)
        if (markedDestination) break
      }
      const destination = markedDestination ?? firstPreviewElement
      const offset = markedDestination ? '-100' : '-50'
      const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180

      stopPreviewAlignment(this)
      previewAlignmentTargets.set(this, destination)
      Velocity(destination, 'scroll', {
        offset,
        duration,
        container: previewContainer
      })
    },
    toggleHelp () {
      this.helpShown = !this.helpShown
      this.activeModal = ''
    },
    toggleFullscreen () {
      const root = this.$refs.root
      if (root instanceof HTMLElement) void root.requestFullscreen?.()
    },
    refresh() {
      this.$nextTick(() => {
        if (!this.editorDisposed) this.cm?.requestMeasure()
      })
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
      const markers: AddMarkerOptions[] = []
      for (let line = 0; line < cm.lineCount; line++) {
        const text = cm.getLine(line)
        if (text.startsWith('```diagram')) {
          found = 'diagram'
          foundStart = line
        } else if (text === '```' && found === 'diagram') {
          if (line - foundStart === 2) {
            markers.push({
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
      cm.setMarkers(markers)
    }
  },
  async mounted() {
    wikiStore.editor.editorKey = 'markdown'

    if (this.mode === 'create' && !wikiStore.editor.content) {
      wikiStore.editor.content = '# Header\nYour content here'
    }


    this.debouncedProcessContent = _.debounce((newContent: string) => this.processContent(newContent), 600)
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
      const collaborationAbortController = markRaw(new AbortController())
      this.collaborationAbortController = collaborationAbortController
      try {
        const collaboration = await createMarkdownCollaboration({
          pageId: wikiStore.page.id,
          expectedUpdatedAt: () => wikiStore.editor.checkoutDateActive,
          fetchImpl: (input, init) => window.fetch(input, { ...init, signal: collaborationAbortController.signal }),
          onBaseline: baseline => {
            wikiStore.editor.checkoutDateActive = baseline.updatedAt
            wikiStore.page.sourceRevision = baseline.sourceRevision
          },
          onStatus: status => {
            if (this.editorDisposed) return
            const firstConflict = status.state === 'conflict' && this.collaborationStatus?.state !== 'conflict'
            this.collaborationStatus = status
            if (status.state === 'conflict' && status.conflict === 'draft-discarded') {
              this.$emit('collaboration-state', { active: false, discarded: true, generation: null })
            }
            if (firstConflict) {
              wikiStore.showNotification({
                message: status.conflict === 'draft-discarded'
                  ? 'This collaboration draft was discarded. Reload the page before saving.'
                  : 'Live collaboration stopped because the page or your access changed. Your edits remain in this editor.',
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
        this.$emit('collaboration-state', { active: true, discarded: false, generation: collaboration.generation })
        wikiStore.editor.content = collaboration.content
        extensions.push(collaboration.extension)
      } catch {
        collaborationAbortController.abort()
        if (this.collaborationAbortController === collaborationAbortController) {
          this.collaborationAbortController = null
        }
        this.$emit('collaboration-state', { active: false, discarded: false, generation: null })
        if (!this.editorDisposed) {
          wikiStore.showNotification({
            message: 'Live collaboration is unavailable. You can continue editing locally.',
            style: 'warning',
            icon: 'warning'
          })
        }
      }
    }
    if (this.editorDisposed) return


    const container = this.$refs.cm
    const root = this.$refs.root
    if (!(container instanceof HTMLElement) || !(root instanceof HTMLElement)) {
      collaborations.get(this)?.destroy()
      collaborations.delete(this)
      this.collaborationAbortController?.abort()
      this.collaborationAbortController = null
      throw new Error('Markdown editor hosts are unavailable')
    }
    const cm = new TextEditor({
      parent: container,
      ariaLabel: 'Markdown source',
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      language: markdown(),
      spellcheck: false,
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      extensions,
      onChange: value => {
        wikiStore.editor.content = value
        this.onCmInput(value)
      },
      onCursor: position => {
        this.positionSync(position)
      },
      onClick: () => {
        this.alignPreviewToCursor()
      }
    })
    this.cm = markRaw(cm)
    Object.defineProperty(root as MarkdownEditorHost, '__wikiSourceEditor', {
      configurable: true,
      value: cm
    })

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
    stopPreviewAlignment(this)
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    const root = this.$refs.root
    if (root instanceof HTMLElement) delete (root as MarkdownEditorHost).__wikiSourceEditor
    this.cm?.destroy()
    this.cm = null
    collaborations.get(this)?.destroy()
    collaborations.delete(this)
    this.collaborationAbortController?.abort()
    this.collaborationAbortController = null
    sourceLinesByEditor.delete(this)
  }
})
</script>

<style lang='scss'>


.editor-markdown {
  background: rgb(var(--v-theme-background));
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  flex: 1 1 auto;
  flex-flow: column nowrap;
  height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  max-height: calc(100vh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  max-height: calc(100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px));
  min-height: 0;
  overflow: hidden;

  &-main {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    width: 100%;
  }

  &-editor {
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%);
    display: block;
    flex: 1 1 50%;
    min-height: 0;
    overflow: auto;
    position: relative;

    &.is-mobile-hidden {
      display: none;
    }

    @include until($tablet) {
      flex-basis: 100%;
      width: 100%;
    }
  }

  &-preview {
    background: rgb(var(--v-theme-surface));
    display: flex;
    flex: 1 1 50%;
    flex-flow: column nowrap;
    min-height: 0;
    overflow: hidden;
    padding: 1rem;
    position: relative;

    @include until($tablet) {
      flex: 1 1 100%;
      max-width: 100%;
      padding: 12px;
      width: 100%;
    }
    &-content {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 0;
      width: 100%;

      @include until($tablet) {
        width: 100%;
      }

      > div {
        outline: none;
      }

      p.line {
        overflow-wrap: break-word;
      }

      .tabset {
        background: rgba(var(--v-theme-primary), .12);
        color: rgb(var(--v-theme-on-surface)) !important;
        padding: 5px 12px;
        font-size: 14px;
        font-weight: 500;
        border-radius: 5px 0 0 0;
        font-style: italic;

        &::after {
          display: none;
        }

        &-header {
          padding: 5px 12px;
          font-size: 14px;
          background: rgba(var(--v-theme-primary), .22);
          color: rgb(var(--v-theme-on-primary)) !important;

          &::after {
            display: none;
          }
        }

        &-content {
          padding: 0 15px 15px;
          border-left: 5px solid rgba(var(--v-theme-primary), .7);
          background: rgba(var(--v-theme-primary), .06);
        }
      }
    }
  }

  &-preview-enter-active,
  &-preview-leave-active {
    max-width: 50vw;
    transition: max-width .5s ease;

    .editor-markdown-preview-content {
      overflow: hidden;
      width: 50vw;
    }
  }

  &-preview-enter-from,
  &-preview-leave-to {
    max-width: 0;
  }

  &-toolbar {
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, rgb(var(--v-theme-primary)) 6%) !important;
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12);
    color: rgb(var(--v-theme-on-surface));
    flex: 0 0 auto;
    overflow-x: auto !important;
    scrollbar-width: thin;

    .v-toolbar__content {
      min-width: max-content;
      padding-inline: 0;
    }
  }


  &-sidebar {
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, rgb(var(--v-theme-primary)) 8%);
    border-inline-end: 1px solid rgba(var(--v-theme-on-surface), .12);
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 24px 0;
    width: 64px;

    @include until($tablet) {
      display: none;
    }
  }

  &-sysbar {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 90%, rgb(var(--v-theme-on-surface)) 10%) !important;
    border-top: 1px solid rgba(var(--v-theme-on-surface), .12);
    color: rgba(var(--v-theme-on-surface), .62);
    flex: 0 0 calc(24px + env(safe-area-inset-bottom));
    min-height: calc(24px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: 0;

    &-locale {
      align-items: center;
      background: rgba(var(--v-theme-primary), .14);
      color: var(--wiki-accent-ink);
      display: inline-flex;
      font-weight: 700;
      height: 24px;
      justify-content: center;
      padding: 0 12px;
      width: 63px;
    }

    &-path {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-collaboration {
      flex: 0 1 auto;
      min-width: 0;
      white-space: nowrap;
    }
  }

@media (max-width: 380px) {
  .editor-markdown-sysbar-collaboration span {
    display: none;
  }

  .editor-markdown-sysbar-collaboration .v-icon {
    margin-inline-end: 0 !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  &,
  & * {
    animation: none !important;
    transition: none !important;
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

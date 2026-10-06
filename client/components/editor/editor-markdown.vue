<template lang='pug'>
  .editor-markdown(ref='root')
    v-toolbar.editor-markdown-toolbar(density="compact", flat)
      template(v-if='isModalShown')
        v-spacer
        v-btn.editor-tool(variant="text", @click='closeAllModal')
          v-icon(start) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      .editor-markdown-toolbar-inner(
        v-else
        role='toolbar'
        :aria-label='$t(`editor:markup.formattingTools`)'
        v-roving-toolbar='{ onEscape: focusEditor }'
      )
        template(v-for='group of toolbarGroups', :key='group.id')
          .editor-tool-group(role='group', :aria-label='$t(group.labelKey)')
            template(v-for='toolId of group.tools', :key='toolId')
              v-menu(v-if='toolId === `heading`', :open-on-hover='$vuetify.display.mdAndUp')
                template(v-slot:activator='{ props: menuProps }')
                  v-btn.editor-tool(
                    v-bind='menuProps'
                    icon
                    rounded='md'
                    variant='text'
                    :class='{ "is-active": formatState.headingLevel > 0 }'
                    :aria-label='headingToolLabel'
                  )
                    v-icon {{ formatState.headingLevel > 0 ? `mdi-format-header-${formatState.headingLevel}` : tools.heading.icon }}
                    v-tooltip(activator='parent', location='bottom') {{ headingToolLabel }}
                v-list.py-0(density='compact')
                  v-list-item(v-for='n in 6', :key='n', :active='formatState.headingLevel === n', @click='setHeaderLine(n)')
                    template(v-slot:prepend)
                      v-icon {{ $t(`editor:editorMarkdown.mdiFormatHeader`, { n, interpolation: { escapeValue: false } }) }}
                    v-list-item-title {{$t('editor:markup.heading', { level: n })}}
              v-menu(v-else-if='toolId === `blockquote`', :open-on-hover='$vuetify.display.mdAndUp')
                template(v-slot:activator='{ props: menuProps }')
                  v-btn.editor-tool(
                    v-bind='menuProps'
                    icon
                    rounded='md'
                    variant='text'
                    :class='{ "is-active": formatState.blockquote }'
                    :aria-label='$t(`editor:markup.blockquoteType`)'
                  )
                    v-icon {{ tools.blockquote.icon }}
                    v-tooltip(activator='parent', location='bottom') {{ $t('editor:markup.blockquoteType') }}
                v-list.py-0(density='compact')
                  v-list-item.wiki-purpose-control(
                    v-for='kind of admonitionKinds'
                    :key='kind.id'
                    :data-purpose='kind.purpose'
                    @click='insertBeforeEachLine({ content: `> `, after: kind.after })'
                  )
                    template(v-slot:prepend)
                      v-icon {{ kind.icon }}
                    v-list-item-title {{ $t(kind.labelKey) }}
              v-btn.editor-tool(
                v-else
                icon
                rounded='md'
                variant='text'
                :aria-label='toolLabel(toolId)'
                :aria-pressed='toolPressed(toolId)'
                :aria-disabled='toolUnavailable(toolId) ? `true` : undefined'
                @click='runMarkdownTool(toolId)'
              )
                v-icon {{ tools[toolId].icon }}
                v-tooltip(activator='parent', location='bottom') {{ toolTooltipText(toolId) }}
        v-spacer
        .editor-tool-group(role='group', :aria-label='$t(`editor:markup.viewGroup`)')
          v-btn.editor-tool(
            v-if='previewShown'
            icon
            rounded='md'
            variant='text'
            :aria-label='$t(`editor:markup.alignPreview`)'
            :aria-pressed='previewAlignmentEnabled'
            @click='togglePreviewAlignment'
          )
            v-icon mdi-crosshairs-gps
            v-tooltip(activator='parent', location='bottom') {{ previewAlignmentEnabled ? $t('editor:markup.previewFollows') : $t('editor:markup.previewAlignmentOff') }}
          v-btn.editor-tool(
            v-if='previewShown && $vuetify.display.mdAndUp'
            icon
            rounded='md'
            variant='text'
            :aria-label='$t(`editor:markup.toggleSpellcheck`)'
            :aria-pressed='spellModeActive'
            @click='spellModeActive = !spellModeActive'
          )
            v-icon mdi-spellcheck
            v-tooltip(activator='parent', location='bottom') {{$t('editor:markup.toggleSpellcheck')}}
          v-btn.editor-tool(
            v-if='$vuetify.display.mdAndUp'
            icon
            rounded='md'
            variant='text'
            :aria-label='$t(`editor:markup.togglePreviewPane`)'
            :aria-pressed='previewShown'
            @click='togglePreview'
          )
            v-icon mdi-book-open-outline
            v-tooltip(activator='parent', location='bottom') {{$t('editor:markup.togglePreviewPane')}}
          v-btn.editor-tool(
            v-else
            icon
            rounded='md'
            variant='text'
            :aria-label='previewShown ? $t(`editor:markup.showEditor`) : $t(`editor:markup.showPreview`)'
            @click='togglePreview'
          )
            v-icon {{ previewShown ? 'mdi-pencil-outline' : 'mdi-book-open-outline' }}
            v-tooltip(activator='parent', location='bottom') {{ previewShown ? $t('editor:markup.showEditor') : $t('editor:markup.showPreview') }}
          v-menu(v-if='!$vuetify.display.mdAndUp', location="left", min-width='260')
            template(v-slot:activator='{ props: menuProps }')
              v-btn.editor-tool(v-bind='menuProps', icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.moreTools`)')
                v-icon mdi-dots-horizontal
            v-list(nav, density='compact')
              template(v-for='toolId of mobileMenuTools', :key='toolId')
                v-divider(v-if='toolId === `divider`')
                v-list-item(v-else, @click='runMarkdownTool(toolId)')
                  template(v-slot:prepend)
                    v-icon.mr-3 {{ tools[toolId].icon }}
                  v-list-item-title {{ toolLabel(toolId) }}
              v-divider
              v-list-item(@click='toggleHelp')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-help-circle-outline
                v-list-item-title {{$t('editor:markup.markdownFormattingHelp')}}
    .editor-markdown-main
      .editor-markdown-sidebar(
        role='toolbar'
        aria-orientation='vertical'
        :aria-label='$t(`editor:markup.insertTools`)'
        v-roving-toolbar='{ onEscape: focusEditor }'
      )
        v-btn.editor-tool(
          v-for='toolId of sidebarTools'
          :key='toolId'
          icon
          rounded='md'
          variant='text'
          :aria-label='toolLabel(toolId)'
          :aria-pressed='toolPressed(toolId)'
          @click='runMarkdownTool(toolId)'
        )
          v-icon {{ tools[toolId].icon }}
          v-tooltip(activator='parent', location='right') {{ toolLabel(toolId) }}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          .editor-markdown-sidebar-actions
            v-btn.editor-tool(icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.distractionFreeMode`)', @click='toggleFullscreen')
              v-icon mdi-arrow-expand-all
              v-tooltip(activator='parent', location='right') {{$t('editor:markup.distractionFreeMode')}} (F11)
            v-btn.editor-tool(icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.markdownFormattingHelp`)', :aria-pressed='helpShown', @click='toggleHelp')
              v-icon mdi-help-circle-outline
              v-tooltip(activator='parent', location='right') {{$t('editor:markup.markdownFormattingHelp')}}
      .editor-markdown-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        div(ref='cm')
      transition(name='editor-markdown-preview', :css='$vuetify.display.mdAndUp')
        .editor-markdown-preview(v-if='previewShown')
          .editor-markdown-preview-content.editor-page-canvas.contents(ref='editorPreviewContainer')
            v-alert.mb-3(v-if='previewError', type='error', variant='tonal', density='compact', role='alert')
              span {{previewError}}
              v-btn.ml-2(type='button', size='small', variant='text', @click='retryPreview') {{$t('editor:retryPreview')}}
            div(
              ref='editorPreview'
              v-html='previewHTML'
              :spellcheck='false'
              )

    .v-system-bar.editor-status-bar.editor-markdown-sysbar
      .text-body-small.editor-markdown-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.editor-markdown-sysbar-path.px-3 /{{path}}
        v-tooltip(activator='parent', location='top') /{{path}}
      template(v-if='collaborationStatus')
        v-spacer
        .text-body-small.d-flex.align-center.editor-markdown-sysbar-collaboration(
          role='status'
          aria-live='polite'
        )
          v-icon.mr-1(size="small", :color='collaborationColor') {{collaborationIcon}}
          span {{collaborationLabel}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small.editor-markdown-sysbar-mode {{ $t(`editor:editorMarkdown.markdown`) }}
        v-spacer
        .text-body-small.editor-markdown-sysbar-format(v-if='formatSummary', :aria-label='$t(`editor:markup.formatAtCursor`, { format: formatSummary })') {{ formatSummary }}
        .text-body-small.editor-markdown-sysbar-position {{ $t(`editor:editorMarkdown.lnCol`, { line: cursorPos.line + 1, ch: cursorPos.ch + 1, interpolation: { escapeValue: false } }) }}

    markdown-help(v-if='helpShown')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
import { defineComponent, markRaw, type PropType } from 'vue'
import { useDisplay } from 'vuetify'
import * as _ from 'lodash-es'
import type { DebouncedFunc } from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import markdownHelp from './markdown/help.vue'
import { searchPages } from '../../helpers/pages-api'
import Velocity from 'velocity-animate'
import { decodeBase64Text } from '../../helpers/base64'

/* global siteConfig, siteLangs */

import { autocompletion, insertCompletionText, pickedCompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import {
  TextEditor,
  type TextEditorHandle,
  type TextEditorOffsetChange,
  type TextEditorSelection,
  type TextEditorSelectionChange,
  type TextPosition
} from './common/text-editor'
import { EditorAdapterController } from './common/editor-adapter'
import {
  EMPTY_MARKDOWN_FORMAT_STATE,
  FORMATTING_TOOLS,
  describeMarkdownFormatState,
  markdownFormatStateFromPath,
  toolTooltip,
  type FormattingToolId,
  type MarkdownFormatState
} from './common/formatting-tools'
import { vRovingToolbar } from './common/roving-toolbar'
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
import { PreviewAlignmentScheduler, calculatePreviewAlignment, resolveVisiblePreviewTarget, stampDetailsSourceLine } from './markdown/preview-alignment'
import { WIKI_LINKS_DISABLED, type WikiLinkOptions } from '../../../shared/wikilinks.ts'

type MarkdownMarkerKind = 'diagram'

type MarkdownToolbarGroup = {
  id: string
  labelKey: string
  tools: FormattingToolId[]
}

type MobileMenuEntry = FormattingToolId | 'divider'

const MODAL_TOOLS: Partial<Record<FormattingToolId, string>> = {
  assets: 'editorModalMedia',
  diagram: 'editorModalDrawio',
  contentExtension: 'editorModalBlocks'
}

// Callout pickers keep their semantic purpose colour; plain tools stay neutral.
const ADMONITION_KINDS = [
  { id: 'quote', labelKey: 'editor:markup.blockquote', icon: 'mdi-format-quote-open', purpose: 'neutral', after: undefined },
  { id: 'info', labelKey: 'editor:markup.blockquoteInfo', icon: 'mdi-information-outline', purpose: 'info', after: '{.is-info}' },
  { id: 'success', labelKey: 'editor:markup.blockquoteSuccess', icon: 'mdi-check-circle-outline', purpose: 'success', after: '{.is-success}' },
  { id: 'warning', labelKey: 'editor:markup.blockquoteWarning', icon: 'mdi-alert-outline', purpose: 'warning', after: '{.is-warning}' },
  { id: 'error', labelKey: 'editor:markup.blockquoteError', icon: 'mdi-alert-octagon-outline', purpose: 'error', after: '{.is-danger}' }
] as const

const SIDEBAR_TOOLS: FormattingToolId[] = ['link', 'assets', 'diagram', 'contentExtension', 'definitionList', 'abbreviation']
const MOBILE_MENU_TOOLS: MobileMenuEntry[] = [
  'link', 'assets', 'diagram', 'contentExtension', 'definitionList', 'abbreviation',
  'divider',
  'strikethrough', 'highlight', 'blockquote', 'inlineCode', 'unorderedList', 'orderedList'
]

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

const markdownEditorInputTheme = EditorView.theme({
  '.cm-content': {
    fontSize: 'calc(.9rem + 1px)'
  }
})


// ========================================
// HELPER FUNCTIONS
// ========================================

// Stamp source lines into preview roots so following the cursor uses stable block anchors.
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

function createEditorMarkdownRenderer (wikiLinks: WikiLinkOptions) {
  const markdown = createWikiMarkdownRenderer(wikiLinks)
  markdown.renderer.rules.paragraph_open = injectSourceLine
  markdown.renderer.rules.heading_open = injectSourceLine
  markdown.renderer.rules.blockquote_open = injectSourceLine
  markdown.renderer.rules.html_block = (tokens, idx, _options, env) => {
    const token = tokens[idx]
    const line = token?.map?.[0]
    if (!token || line === undefined) return token?.content ?? ''
    const stampedHtml = stampDetailsSourceLine(token.content, line)
    if (stampedHtml === null) return token.content
    const sourceLines = env?.sourceLines
    if (Array.isArray(sourceLines)) sourceLines.push(line)
    return stampedHtml
  }
  const renderFence = markdown.renderer.rules.fence
  if (!renderFence) throw new TypeError('Markdown fence renderer is unavailable.')
  markdown.renderer.rules.fence = (tokens, idx, options, env, renderer) => {
    const line = tokens[idx]?.map?.[0]
    const html = renderFence(tokens, idx, options, env, renderer)
    if (line === undefined) return html
    const sourceLines = env?.sourceLines
    if (Array.isArray(sourceLines)) sourceLines.push(line)
    return html.replace(/^<([a-z]+)/, `<$1 data-source-line="${line}"`)
  }
  return markdown
}

const collaborations = new WeakMap<object, MarkdownCollaboration>()
const sourceLinesByEditor = new WeakMap<object, number[]>()
type PreviewAlignmentAnimation = {
  destination: HTMLElement
  container: HTMLElement
}
const previewAlignmentAnimations = new WeakMap<object, PreviewAlignmentAnimation>()
const previewAlignmentSchedulers = new WeakMap<object, PreviewAlignmentScheduler>()

type VelocityTweenProgress = (elements: Element[], complete: number, remaining: number, start: number, tweenValue: number | null) => void
type VelocityTweenOptions = {
  duration?: number
  complete?: () => void
  progress?: VelocityTweenProgress
}

// Animate an absolute scrollTop value instead of Velocity's offset-parent based scroll action.
const velocityTween = Velocity as unknown as (
  target: Element,
  properties: { tween: [number, number] },
  options: VelocityTweenOptions
) => void

function stopPreviewAlignment (editor: object) {
  previewAlignmentSchedulers.get(editor)?.cancel()
  const animation = previewAlignmentAnimations.get(editor)
  if (animation) Velocity(animation.container, 'stop', true)
  previewAlignmentAnimations.delete(editor)
}


// ========================================
// Vue Component
// ========================================

type MarkdownEditorHost = HTMLElement & { __wikiSourceEditor?: TextEditorHandle }

export default defineComponent({
  components: {
    markdownHelp
  },
  directives: {
    rovingToolbar: vRovingToolbar
  },
  emits: ['collaboration-state', 'editor-adapter', 'editor-adapter-clear'],
  props: {
    save: {
      type: Function as PropType<() => void>,
      default: () => {}
    },
    wikiLinkOptions: {
      type: Object as PropType<WikiLinkOptions>,
      default: () => WIKI_LINKS_DISABLED
    },
  },
  setup() {
    const { mdAndUp } = useDisplay()
    return { mdAndUp }
  },
  data() {
    return {
      markdownRenderer: markRaw(createEditorMarkdownRenderer(this.wikiLinkOptions)),
      cm: null as TextEditorHandle | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: Boolean(this.mdAndUp),
      previewAlignmentEnabled: true,
      previewHTML: '',
      previewDirty: true,
      previewRevision: 0,
      previewError: '',
      helpShown: false,
      spellModeActive: false,
      insertLinkDialog: false,
      debouncedProcessContent: null as DebouncedFunc<(newContent: string) => void> | null,
      collaborationStatus: null as CollaborationStatus | null,
      editorDisposed: false,
      editorAdapter: null as EditorAdapterController | null,
      collaborationAbortController: null as AbortController | null,
      formatState: EMPTY_MARKDOWN_FORMAT_STATE as MarkdownFormatState,
      historyDepth: { undo: 0, redo: 0 },
      tools: FORMATTING_TOOLS,
      admonitionKinds: ADMONITION_KINDS,
      sidebarTools: SIDEBAR_TOOLS,
      mobileMenuTools: MOBILE_MENU_TOOLS
    }
  },
  computed: {
    toolbarGroups(): MarkdownToolbarGroup[] {
      if (!this.$vuetify.display.mdAndUp) {
        return [
          { id: 'history', labelKey: 'editor:markup.historyGroup', tools: ['undo', 'redo'] },
          { id: 'text', labelKey: 'editor:markup.textGroup', tools: ['bold', 'italic', 'heading'] }
        ]
      }
      return [
        { id: 'history', labelKey: 'editor:markup.historyGroup', tools: ['undo', 'redo'] },
        {
          id: 'text',
          labelKey: 'editor:markup.textGroup',
          tools: ['bold', 'italic', 'strikethrough', 'highlight', 'subscript', 'superscript', 'inlineCode', 'keyboardKey']
        },
        {
          id: 'structure',
          labelKey: 'editor:markup.structureGroup',
          tools: ['heading', 'blockquote', 'unorderedList', 'orderedList', 'horizontalBar']
        }
      ]
    },
    headingToolLabel(): string {
      const level = this.formatState.headingLevel
      return level > 0
        ? String(this.$t('editor:markup.headingLevelCurrent', { level }))
        : String(this.$t('editor:markup.headingLevel'))
    },
    formatSummary(): string {
      return describeMarkdownFormatState(this.formatState, (key, values) => String(this.$t(key, values ?? {})))
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
      if (status.state === 'connected') return String(this.$t('editor:collaboration.editing', { count: status.participants }))
      if (status.state === 'connecting') return String(this.$t('editor:collaboration.connecting'))
      if (status.state === 'offline') return String(this.$t('editor:collaboration.offline'))
      return String(this.$t('editor:collaboration.stopped'))
    },
    collaborationIcon(): string {
      const state = this.collaborationStatus?.state
      if (state === 'connected') return 'mdi-account-multiple'
      if (state === 'connecting') return 'mdi-sync'
      if (state === 'offline') return 'mdi-cloud-off-outline'
      return 'mdi-alert-outline'
    },
    collaborationColor(): string | undefined {
      const state = this.collaborationStatus?.state
      if (state === 'connected') return 'success'
      if (state === 'conflict') return 'warning'
      return undefined
    },
  },
  watch: {
    '$vuetify.theme.current.dark' (newValue: boolean) {
      this.cm?.setDark(newValue)
    },
    wikiLinkOptions: {
      deep: true,
      handler () {
        this.markdownRenderer = markRaw(createEditorMarkdownRenderer(this.wikiLinkOptions))
        this.previewRevision += 1
        this.previewDirty = true
        stopPreviewAlignment(this)
        if (this.cm) this.processContent(this.cm.getValue())
      }
    },
    previewShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.debouncedProcessContent?.cancel()
        if (this.previewDirty) {
          this.processContent(requireEditor(this.cm).getValue())
          return
        }
        this.$nextTick(() => {
          if (this.editorDisposed || !this.previewShown) return
          const preview = this.$refs.editorPreview as HTMLElement | undefined
          if (preview) {
            enhanceWikiMarkdownPreview(preview, this.$vuetify.theme.current.dark)
            this.requestPreviewAlignment(true)
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
    toolLabel (toolId: FormattingToolId): string {
      return String(this.$t(FORMATTING_TOOLS[toolId].labelKey))
    },
    toolTooltipText (toolId: FormattingToolId): string {
      if (toolId === 'undo' && this.historyDepth.undo === 0) return String(this.$t('editor:markup.nothingToUndo'))
      if (toolId === 'redo' && this.historyDepth.redo === 0) return String(this.$t('editor:markup.nothingToRedo'))
      return toolTooltip(this.toolLabel(toolId), FORMATTING_TOOLS[toolId])
    },
    /** `aria-pressed` only for tools that toggle a state the syntax tree can report. */
    toolPressed (toolId: FormattingToolId): boolean | undefined {
      const modal = MODAL_TOOLS[toolId]
      if (modal) return this.activeModal === modal
      switch (toolId) {
        case 'bold':
        case 'italic':
        case 'strikethrough':
        case 'subscript':
        case 'superscript':
        case 'inlineCode':
        case 'blockquote':
        case 'unorderedList':
        case 'orderedList':
          return this.formatState[toolId]
        default:
          return undefined
      }
    },
    toolUnavailable (toolId: FormattingToolId): boolean {
      if (toolId === 'undo') return this.historyDepth.undo === 0
      if (toolId === 'redo') return this.historyDepth.redo === 0
      return false
    },
    runMarkdownTool (toolId: FormattingToolId) {
      // Undo/Redo stay focusable while empty so their tooltip can explain why.
      if (this.toolUnavailable(toolId)) return
      const modal = MODAL_TOOLS[toolId]
      if (modal) {
        this.toggleModal(modal)
        return
      }
      switch (toolId) {
        case 'undo':
          this.cm?.undo?.()
          break
        case 'redo':
          this.cm?.redo?.()
          break
        case 'bold':
          this.toggleMarkup({ start: '**' })
          break
        case 'italic':
          this.toggleMarkup({ start: '*' })
          break
        case 'strikethrough':
          this.toggleMarkup({ start: '~~' })
          break
        case 'highlight':
          this.toggleMarkup({ start: '==' })
          break
        case 'subscript':
          this.toggleMarkup({ start: '~' })
          break
        case 'superscript':
          this.toggleMarkup({ start: '^' })
          break
        case 'inlineCode':
          this.toggleMarkup({ start: '`' })
          break
        case 'keyboardKey':
          this.toggleMarkup({ start: '<kbd>', end: '</kbd>' })
          break
        case 'blockquote':
          this.insertBeforeEachLine({ content: '> ' })
          break
        case 'unorderedList':
          this.insertBeforeEachLine({ content: '- ' })
          break
        case 'orderedList':
          this.insertBeforeEachLine({ content: '1. ' })
          break
        case 'horizontalBar':
          this.insertAfter({ content: '---', newLine: true })
          break
        case 'link':
          this.insertLink()
          return
        case 'definitionList':
          this.insertDefinitionList()
          break
        case 'abbreviation':
          this.insertAbbreviation()
          break
        default:
          return
      }
      this.syncFormatState()
    },
    /** Read active formatting and undo depth from CodeMirror after any change. */
    syncFormatState () {
      const cm = this.cm
      if (!cm || this.editorDisposed) return
      this.formatState = cm.syntaxPath ? markdownFormatStateFromPath(cm.syntaxPath()) : EMPTY_MARKDOWN_FORMAT_STATE
      const depth = cm.historyDepth?.()
      if (depth && (depth.undo !== this.historyDepth.undo || depth.redo !== this.historyDepth.redo)) this.historyDepth = depth
    },
    focusEditor () {
      this.cm?.focus()
    },
    togglePreview () {
      this.previewShown = !this.previewShown
    },
    destroyMarkdownCollaboration() {
      const collaboration = collaborations.get(this)
      if (collaboration) {
        this.cm?.setHistory?.(null)
        this.syncFormatState()
        collaboration.destroy()
        collaborations.delete(this)
      }
      this.collaborationAbortController?.abort()
      this.collaborationAbortController = null
      this.$emit('collaboration-state', { active: false, discarded: false, generation: null })
      this.editorAdapter?.notifyState()
    },
    flushEligibleEditorText() {
      const editor = this.cm
      if (!editor) return
      wikiStore.editor.content = editor.getValue()
      collaborations.get(this)?.flushPending()
      this.editorAdapter?.notifyState()
    },
    clearEditorText() {
      this.destroyMarkdownCollaboration()
      this.cm?.setValue('')
      wikiStore.editor.content = ''
      this.previewHTML = ''
      this.previewDirty = true
      this.previewError = ''
      this.previewRevision += 1
    },
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
      this.previewRevision++
      stopPreviewAlignment(this)
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
      const revision = ++this.previewRevision
      this.previewDirty = true
      this.previewError = ''
      try {
        const previewHTML = sanitizeWikiMarkdownHtml(this.markdownRenderer.render(newContent, renderEnvironment))
        if (this.editorDisposed || !this.previewShown || revision !== this.previewRevision) return
        this.previewHTML = previewHTML
      } catch {
        if (this.editorDisposed || !this.previewShown || revision !== this.previewRevision) return
        this.previewError = this.$t('editor:previewRenderFailed')
        return
      }
      sourceLinesByEditor.set(this, renderEnvironment.sourceLines)
      this.$nextTick(() => {
        if (this.editorDisposed || !this.previewShown || revision !== this.previewRevision) return
        const preview = this.$refs.editorPreview as HTMLElement | undefined
        if (!preview) return
        enhanceWikiMarkdownPreview(preview, this.$vuetify.theme.current.dark)
        this.previewDirty = false
        this.requestPreviewAlignment(true)
      })
    },
    retryPreview () {
      this.processContent(requireEditor(this.cm).getValue())
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
      if (!end) end = start
      const changes: TextEditorOffsetChange[] = []
      const formattedRanges = new Set<string>()
      let missingWord = false
      let changed = false
      const formatSelection = (selection: TextEditorSelection): TextEditorSelectionChange | null => {
        const range = selection.empty ? cm.wordOffsetsAt(selection.from) : selection
        if (!range) {
          missingWord = true
          return null
        }
        const rangeKey = `${range.from}:${range.to}`
        if (formattedRanges.has(rangeKey)) return null
        formattedRanges.add(rangeKey)
        const selected = cm.slice(range.from, range.to)
        const backwards = selection.anchor > selection.head
        if (selected.startsWith(start) && selected.endsWith(end) && selected.length >= start.length + end.length) {
          const content = selected.slice(start.length, selected.length - end.length)
          const selectionFrom = range.from
          const selectionTo = selectionFrom + content.length
          changed = true
          return {
            content,
            from: range.from,
            to: range.to,
            anchor: backwards ? selectionTo : selectionFrom,
            head: backwards ? selectionFrom : selectionTo
          }
        }
        if (
          range.from >= start.length &&
          cm.slice(range.from - start.length, range.from) === start &&
          cm.slice(range.to, range.to + end.length) === end
        ) {
          const contentFrom = range.from - start.length
          const selectionFrom = contentFrom
          const selectionTo = selectionFrom + selected.length
          changed = true
          const cursor = selectionFrom + (selection.from - range.from)
          return {
            content: selected,
            from: contentFrom,
            to: range.to + end.length,
            anchor: selection.empty ? cursor : (backwards ? selectionTo : selectionFrom),
            head: selection.empty ? cursor : (backwards ? selectionFrom : selectionTo)
          }
        }
        const content = start + selected + end
        const selectionFrom = range.from + start.length
        const selectionTo = selectionFrom + selected.length
        changed = true
        const cursor = selectionFrom + (selection.from - range.from)
        return {
          content,
          from: range.from,
          to: range.to,
          anchor: selection.empty ? cursor : (backwards ? selectionTo : selectionFrom),
          head: selection.empty ? cursor : (backwards ? selectionFrom : selectionTo)
        }
      }
      if (cm.replaceSelections) {
        cm.replaceSelections(formatSelection)
      } else {
        for (const selection of cm.selectedOffsets()) {
          const result = formatSelection({
            anchor: selection.from,
            head: selection.to,
            from: selection.from,
            to: selection.to,
            empty: selection.from === selection.to
          })
          if (result) changes.push(result)
        }
        for (const change of [...changes].reverse()) cm.replaceOffsets(change.content, change.from, change.to)
      }
      if (missingWord) {
        wikiStore.showNotification({
          message: this.$t('editor:markup.noSelectionError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      if (changed) cm.focus()
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
    togglePreviewAlignment () {
      this.previewAlignmentEnabled = !this.previewAlignmentEnabled
      if (!this.previewAlignmentEnabled) {
        stopPreviewAlignment(this)
        return
      }
      this.$nextTick(() => this.requestPreviewAlignment(true))
    },
    requestPreviewAlignment (force = false) {
      let scheduler = previewAlignmentSchedulers.get(this)
      if (!scheduler) {
        scheduler = new PreviewAlignmentScheduler(
          () => !this.editorDisposed && this.previewAlignmentEnabled && this.previewShown && !this.previewDirty,
          force => this.alignPreviewToCursor(force)
        )
        previewAlignmentSchedulers.set(this, scheduler)
      }
      scheduler.request(force)
    },
    /** Follow the selection head without moving or focusing the source editor. */
    alignPreviewToCursor (_force = false) {
      if (this.editorDisposed || !this.previewAlignmentEnabled || !this.previewShown || this.previewDirty || !this.cm || this.previewHTML.trim().length === 0) return
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
      const mappedDestination = markedDestination ?? firstPreviewElement
      const destination = resolveVisiblePreviewTarget(mappedDestination)
      const previewRect = previewContainer.getBoundingClientRect()
      const destinationRect = destination.getBoundingClientRect()
      const maxScrollTop = Math.max(0, previewContainer.scrollHeight - previewContainer.clientHeight)
      const currentScrollTop = Math.min(Math.max(previewContainer.scrollTop, 0), maxScrollTop)
      const destinationViewportTop = destinationRect.top - previewRect.top
      const fallbackOffset = markedDestination ? 100 : 50
      let targetScrollTop = Math.min(
        Math.max(currentScrollTop + destinationViewportTop - fallbackOffset, 0),
        maxScrollTop
      )

      if (markedDestination) {
        const sourceContainer = this.$refs.cm as HTMLElement | undefined
        const sourceViewport = sourceContainer?.querySelector<HTMLElement>('.cm-scroller') ?? sourceContainer
        const cursorElement = sourceContainer?.querySelector<HTMLElement>('.cm-cursor-primary')
          ?? sourceContainer?.querySelector<HTMLElement>('.cm-cursor')
        if (sourceViewport && cursorElement) {
          const sourceRect = sourceViewport.getBoundingClientRect()
          const cursorRect = cursorElement.getBoundingClientRect()
          if (sourceRect.height > 0 && previewRect.height > 0 && cursorRect.height > 0) {
            targetScrollTop = calculatePreviewAlignment({
              sourceViewportTop: sourceRect.top,
              sourceViewportHeight: sourceRect.height,
              cursorTop: cursorRect.top,
              cursorBottom: cursorRect.bottom,
              previewViewportTop: previewRect.top,
              previewViewportHeight: previewRect.height,
              destinationTop: destinationRect.top,
              destinationBottom: destinationRect.bottom,
              currentScrollTop,
              maxScrollTop
            }).scrollTop
          }
        }
      }
      const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180

      stopPreviewAlignment(this)
      if (duration === 0) {
        previewContainer.scrollTop = targetScrollTop
        return
      }

      const animation: PreviewAlignmentAnimation = { destination, container: previewContainer }
      previewAlignmentAnimations.set(this, animation)
      velocityTween(previewContainer, { tween: [targetScrollTop, currentScrollTop] }, {
        duration,
        progress: (_elements, _complete, _remaining, _start, tweenValue) => {
          if (previewAlignmentAnimations.get(this) !== animation || typeof tweenValue !== 'number') return
          previewContainer.scrollTop = tweenValue
        },
        complete: () => {
          if (previewAlignmentAnimations.get(this) !== animation) return
          previewContainer.scrollTop = targetScrollTop
          previewAlignmentAnimations.delete(this)
        }
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
          const start = foundStart
          const end = line
          if (end - start === 2) {
            markers.push({
              from: { line: start, ch: 3 },
              to: { line: start, ch: 10 },
              text: String(this.$t('editor:markup.editDiagram')),
              action: () => {
                const editor = requireEditor(this.cm)
                editor.setSelection({ line: start, ch: 0 }, { line: end, ch: 3 })
                try {
                  wikiStore.editor.activeModalData = decodeBase64Text(editor.getLine(end - 1))
                  this.toggleModal(`editorModalDrawio`)
                } catch {
                  wikiStore.showNotification({
                    message: String(this.$t('editor:markup.diagramDataFailed')),
                    style: 'warning',
                    icon: 'warning'
                  })
                }
              }
            })
            cm.foldRange(
              { line: start, ch: cm.getLine(start).length },
              { line: end, ch: 0 }
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
      wikiStore.editor.content = this.$t('editor:editorMarkdown.headerContentHere')
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
          options: response.results.map(result => {
            const href = `${result.visibility === 'private' ? '/_private' : ''}/${siteLangs.length > 0 ? `${encodeURIComponent(result.locale)}/` : ''}${result.path.split('/').map(encodeURIComponent).join('/')}`
            return {
              label: `${href} - ${result.title}`,
              apply: (view: EditorView, completion: Completion, from: number, to: number) => {
                // Match the normal completion prefix at every cursor before consuming its own closer.
                const insertion = insertCompletionText(view.state, `${href})`, from, to)
                const insertions = view.state.changes(insertion.changes)
                const closers: Array<{ from: number; to: number }> = []
                insertions.iterChanges((_fromA, toA, _fromB, toB) => {
                  if (view.state.sliceDoc(toA, toA + 1) === ')') closers.push({ from: toB, to: toB + 1 })
                }, true)
                view.dispatch(
                  { ...insertion, changes: insertions, annotations: pickedCompletion.of(completion) },
                  { changes: closers, sequential: true }
                )
              }
            }
          })
        }
      } catch {
        return null
      }
    }

    const extensions = [
      markdownEditorInputTheme,
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
          onHistoryChange: () => this.syncFormatState(),
          onBaseline: baseline => {
            wikiStore.editor.checkoutDateActive = baseline.updatedAt
            wikiStore.page.sourceRevision = baseline.sourceRevision
          },
          onStatus: status => {
            if (this.editorDisposed) return
            const firstConflict = status.state === 'conflict' && this.collaborationStatus?.state !== 'conflict'
            this.collaborationStatus = status
            this.editorAdapter?.notifyState()
            if (status.state === 'conflict' && status.conflict === 'draft-discarded') {
              this.$emit('collaboration-state', { active: false, discarded: true, generation: null })
            }
            if (firstConflict) {
              wikiStore.showNotification({
                message: status.conflict === 'draft-discarded'
                  ? String(this.$t('editor:collaboration.draftDiscarded'))
                  : String(this.$t('editor:collaboration.accessChanged')),
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
      } catch {
        collaborationAbortController.abort()
        if (this.collaborationAbortController === collaborationAbortController) {
          this.collaborationAbortController = null
        }
        this.$emit('collaboration-state', { active: false, discarded: false, generation: null })
        if (!this.editorDisposed) {
          wikiStore.showNotification({
            message: String(this.$t('editor:collaboration.unavailable')),
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
      throw new Error(this.$t('editor:editorMarkdown.markdownEditorHostsUnavailable'))
    }
    const cm = new TextEditor({
      parent: container,
      ariaLabel: String(this.$t('editor:markup.sourceLabel')),
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      language: markdown({ base: markdownLanguage }),
      spellcheck: false,
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      extensions,
      history: collaborations.get(this),
      onChange: value => {
        wikiStore.editor.content = value
        this.editorAdapter?.noteTextChange()
        this.onCmInput(value)
        this.syncFormatState()
      },
      onCursor: position => {
        this.positionSync(position)
        this.syncFormatState()
        this.requestPreviewAlignment()
      },
      onClick: () => {
        this.requestPreviewAlignment()
      }
    })
    this.cm = markRaw(cm)
    this.syncFormatState()
    const adapter = new EditorAdapterController({
      readText: () => cm.getValue(),
      writeText: text => {
        cm.setValue(text)
        wikiStore.editor.content = text
        this.previewRevision += 1
        this.processContent(text)
      },
      clearText: () => {
        cm.setValue('')
        wikiStore.editor.content = ''
        this.previewHTML = ''
        this.previewDirty = true
        this.previewError = ''
        this.previewRevision += 1
      },
      flushText: () => this.flushEligibleEditorText(),
      destroyCollaboration: () => this.destroyMarkdownCollaboration(),
      collaborationBacklog: () => collaborations.get(this)?.pendingUpdateCount ?? 0
    })
    this.editorAdapter = markRaw(adapter)
    adapter.initialize()
    this.$emit('editor-adapter', adapter)
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
    const adapter = this.editorAdapter
    if (adapter) {
      this.$emit('editor-adapter-clear', adapter)
      adapter.destroy()
      this.editorAdapter = null
    }
    this.debouncedProcessContent?.cancel()
    stopPreviewAlignment(this)
    previewAlignmentSchedulers.delete(this)
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    const root = this.$refs.root
    if (root instanceof HTMLElement) delete (root as MarkdownEditorHost).__wikiSourceEditor
    this.destroyMarkdownCollaboration()
    this.cm?.destroy()
    this.cm = null
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
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  &-main {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    width: 100%;
  }

  &-editor {
    background: rgb(var(--v-theme-background));
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    position: relative;

    &.is-mobile-hidden {
      display: none;
    }

    @include until($tablet) {
      flex: 1 1 0;
      width: 100%;
    }

    > div {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    // CodeMirror paints selections in a z-index:-1 layer inside .cm-scroller.
    // Only the editor root carries a background; the scroller and content stay
    // transparent so nothing can cover the selection layer.
    .cm-editor {
      background: rgb(var(--v-theme-background));
    }

    .cm-scroller,
    .cm-content {
      background: transparent;
    }

    .cm-editor {
      flex: 1 1 auto;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }

    .cm-scroller {
      overflow: auto;
    }
  }

  &-preview {
    background: rgb(var(--v-theme-background));
    display: flex;
    flex: 1 1 0;
    flex-flow: column nowrap;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 1rem;
    position: relative;

    @include until($tablet) {
      flex: 1 1 0;
      max-width: 100%;
      padding: 12px;
      width: 100%;
    }

    &-content {
      background: rgb(var(--v-theme-background));
      flex: 1 1 auto;
      min-width: 0;
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
    max-width: 50%;
    transition: max-width .5s ease;

    .editor-markdown-preview-content {
      overflow: hidden;
      width: 100%;
    }
  }

  &-preview-enter-from,
  &-preview-leave-to {
    max-width: 0;
  }

  &-toolbar {
    background: var(--wiki-surface-raised) !important;
    border-bottom: 1px solid var(--wiki-surface-border);
    color: rgb(var(--v-theme-on-surface));
    flex: 0 0 auto;
    min-width: 0;
    overflow-x: auto !important;
    scrollbar-width: thin;

    .v-toolbar__content {
      min-width: max-content;
      padding-block: 2px;
      padding-inline: 8px;
      gap: 3px;

      .v-btn.v-btn--icon {
        width: 44px;
        height: 44px;
      }

      .v-btn {
        border-radius: var(--wiki-control-radius, 6px);
      }
    }
  }

  &-toolbar-inner {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    gap: 3px;
    min-width: max-content;

    > .editor-tool-group + .editor-tool-group {
      border-inline-start: 1px solid var(--wiki-surface-border);
      padding-inline-start: 3px;
    }
  }


  &-sidebar {
    background: var(--wiki-surface-sunken);
    border-inline-end: 1px solid var(--wiki-surface-border);
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding-block: 12px 16px;
    padding-inline: 0;
    width: 60px;
    flex: 0 0 60px;

    gap: 8px;

    .v-btn.v-btn--icon {
      width: 44px;
      height: 44px;
    }

    @include until($tablet) {
      display: none;
    }
  }
  &-sidebar-actions {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transform: translateY(-24px);
  }

  &-sysbar {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    position: static !important;
    inset: auto !important;
    width: auto !important;
    transform: none !important;
    z-index: auto !important;
    background: var(--wiki-surface-raised) !important;
    border-top: 1px solid var(--wiki-surface-border);
    color: var(--wiki-text-muted);
    flex: 0 0 calc(24px + env(safe-area-inset-bottom));
    min-width: 0;
    min-height: calc(24px + env(safe-area-inset-bottom));
    max-width: 100%;
    overflow: hidden;
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: 0;

    &-locale {
      align-items: center;
      background: rgba(var(--v-theme-primary), .14);
      color: var(--wiki-accent-ink);
      display: inline-flex;
      flex: 0 0 63px;
      font-weight: 700;
      height: 24px;
      justify-content: center;
      padding: 0 12px;
      width: 63px;
    }

    &-path {
      flex: 0 1 auto;
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

    &-mode {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    &-format {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      padding-inline-end: var(--wiki-space-3);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-position {
      flex: 0 0 auto;
      padding-inline-end: calc(var(--wiki-space-3) + env(safe-area-inset-right));
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

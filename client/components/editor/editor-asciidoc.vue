<template lang='pug'>
  .editor-asciidoc(ref='root')
    v-toolbar.editor-asciidoc-toolbar(density="compact", flat, role='toolbar', :aria-label='$t(`editor:editorAsciidoc.formattingTools`)', v-roving-toolbar='{ onEscape: focusEditor }')
      template(v-if='isModalShown')
        v-spacer
        v-btn(variant="text", @click='closeAllModal')
          v-icon(start) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      template(v-else)
        v-btn(v-for='action in formattingActions.emphasis', :key='action.label', icon, rounded='md', variant='text', :aria-label='$t(action.label)', @click='runFormattingAction(action)').mx-0
          v-icon {{ action.icon }}
          v-tooltip(activator='parent', location='bottom', color='primary', :text='$t(action.label)')
        v-menu(:open-on-hover='$vuetify.display.mdAndUp')
          template(v-slot:activator='{ props }')
            v-btn(icon, rounded='md', variant='text', v-bind='props', :aria-label='$t(`editor:editorAsciidoc.headingLevel`)').mx-0
              v-icon mdi-format-header-pound
          v-list.py-0
            template(v-for='(n, idx) in 6', :key='idx')
              v-list-item(@click='setHeaderLine(n)')
                template(v-slot:append)
                  v-icon(:size='24 - (idx - 1) * 2', :icon='`mdi-format-header-${n}`')
                v-list-item-title {{$t('editor:markup.heading', { level: n })}}
              v-divider(v-if='idx < 5')
        v-divider.editor-asciidoc-tool-separator(v-if='$vuetify.display.mdAndUp', vertical, aria-hidden='true')
        template(v-if='$vuetify.display.mdAndUp')
          v-btn(v-for='action in formattingActions.script', :key='action.label', icon, rounded='md', variant='text', :aria-label='$t(action.label)', @click='runFormattingAction(action)').mx-0
            v-icon {{ action.icon }}
            v-tooltip(activator='parent', location='bottom', color='primary', :text='$t(action.label)')
        v-menu(v-if='$vuetify.display.mdAndUp', open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn(icon, rounded='md', variant='text', v-bind='props', :aria-label='$t(`editor:editorAsciidoc.blockFormatting`)').mx-0
              v-icon mdi-alpha-t-box-outline
          v-list.py-0
            template(v-for='(action, index) in formattingActions.blocks', :key='action.label')
              v-divider(v-if='index > 0')
              v-list-item(@click='runFormattingAction(action)')
                template(v-slot:append)
                  v-icon(:color='action.color') {{ action.desktopIcon || action.icon }}
                v-list-item-title {{$t(action.label)}}
        v-divider.editor-asciidoc-tool-separator(v-if='$vuetify.display.mdAndUp', vertical, aria-hidden='true')
        v-spacer
        v-btn.mx-0(data-editor-contents-toggle, icon, rounded='md', variant='text', :aria-label='$t(`editor:contents.toggle`, { defaultValue: `Toggle contents pane` })', :aria-expanded='contentsShown && (!previewShown || $vuetify.display.mdAndUp)', aria-controls='editor-asciidoc-contents', @click='toggleContents')
          v-icon mdi-format-list-bulleted-square
        v-btn.mx-0(v-if='previewShown', icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.alignPreview`)', :aria-pressed='previewAlignmentEnabled', @click='togglePreviewAlignment')
          v-icon mdi-crosshairs-gps
        v-btn.mx-0(
          icon
          rounded='md'
          variant='text'
          :aria-label='$t($vuetify.display.mdAndUp ? `editor:markup.togglePreviewPane` : previewShown ? `editor:editorAsciidoc.showEditor` : `editor:editorAsciidoc.showPreview`)'
          :aria-pressed='previewShown'
          @click='togglePreview'
        )
          v-icon {{ previewShown ? 'mdi-pencil-outline' : 'mdi-book-open-outline' }}
          v-tooltip(activator='parent', location='bottom', color='primary', :text='$t($vuetify.display.smAndDown && previewShown ? `editor:editorAsciidoc.showEditor` : `editor:markup.togglePreviewPane`)')
        v-menu(v-if='$vuetify.display.smAndDown', location="left", min-width='260')
          template(v-slot:activator='{ props }')
            v-btn.mx-0(
              icon
              rounded='md'
              variant='text'
              v-bind='props'
              :aria-label='$t(`editor:editorAsciidoc.moreFormattingTools`)'
            )
              v-icon mdi-dots-horizontal
          v-list(nav)
            template(v-for='(group, index) in mobileFormattingGroups', :key='group[0].label')
              v-list-item(v-for='action in group', :key='action.label', @click='runFormattingAction(action)')
                template(v-slot:prepend)
                  v-icon.mr-3 {{ action.icon }}
                v-list-item-title {{$t(action.label)}}
              v-divider(v-if='index !== 1')
            v-list-item(@click='toggleFullscreen')
              template(v-slot:prepend)
                v-icon.mr-3 mdi-arrow-expand-all
              v-list-item-title {{$t('editor:markup.distractionFreeMode')}}

    .editor-asciidoc-main
      .editor-asciidoc-sidebar(role='toolbar', aria-orientation='vertical', :aria-label='$t(`editor:editorAsciidoc.toolbarInsertTools`)', v-roving-toolbar='{ onEscape: focusEditor }')
        v-btn(v-for='(action, index) in formattingActions.insert', :key='action.label', icon, rounded='md', variant='text', :class='{ "mt-3": index > 0 }', :aria-label='$t(action.label)', :aria-pressed='action.kind === `modal` ? activeModal === action.value : undefined', @click='runFormattingAction(action)').mx-0
          v-icon(:color='action.kind === `modal` && activeModal === action.value ? `primary` : undefined') {{ action.icon }}
          v-tooltip(activator='parent', location='right', :text='$t(action.label)')
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-btn.mt-3(icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.distractionFreeMode`)', @click='toggleFullscreen').mx-0
            v-icon mdi-arrow-expand-all
            v-tooltip(activator='parent', location='right', :text='$t(`editor:markup.distractionFreeMode`)')
      editor-contents-pane(v-if='contentsShown && (!previewShown || $vuetify.display.mdAndUp)', id='editor-asciidoc-contents', :headings='headings', :current-line='currentSectionLine', :line-count='cm?.lineCount ?? 1', :busy='outlineLoading', @jump='jumpToSource', @close='toggleContents')
      .editor-asciidoc-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        div(ref='cm')
      transition(name='editor-asciidoc-preview')
        .editor-asciidoc-preview(v-if='previewShown')
          .editor-asciidoc-preview-content.editor-page-canvas.contents(ref='editorPreviewContainer', tabindex='0', role='region', :aria-label='$t(`editor:contents.preview`, { defaultValue: `Page preview` })', :aria-busy='previewLoading', :lang='locale', :dir='contentDirection')
            v-alert(v-if='previewError', type='error', variant='tonal', density='compact', role='alert')
              span {{previewError}}
              v-btn.ml-2(size='small', variant='text', @click='retryPreview') {{ $t(`editor:editorAsciidoc.retry`) }}
            div(ref='editorPreview', v-html='previewHTML')

    v-system-bar.editor-status-bar.editor-asciidoc-sysbar(absolute)
      .text-body-small.editor-asciidoc-sysbar-locale {{locale.toUpperCase()}}
      .editor-status-path /{{path}}
        v-tooltip(activator='parent', location='top') /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small {{ $t(`editor:editorAsciidoc.asciidoc`) }}
        v-spacer
        .text-body-small {{ $t(`editor:editorAsciidoc.lnCol`, { line: cursorPos.line + 1, ch: cursorPos.ch + 1, interpolation: { escapeValue: false } }) }}
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
/* global siteLangs, siteConfig */
import { defineComponent, markRaw } from 'vue'
import type { Raw } from 'vue'
import { useDisplay } from 'vuetify'
import i18next from 'i18next'
import * as _ from 'lodash-es'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { createSourceImageAuthoring } from '../../helpers/editor-source-images'
import { createSourceAuthoring, type SourceAuthoring } from '../../helpers/editor-source-authoring'
import type { ContentInsertOptions, LineInsertOptions, MarkupOptions, MultiLineInsertOptions, PageLinkTarget } from './common/editor-types'
import DOMPurify from 'dompurify'
import { decodeBase64Text } from '../../helpers/base64'
import { load } from '@asciidoctor/core'
import EditorContentsPane from './editor-contents-pane.vue'
import { SourcePreviewSync } from './common/source-preview-sync'
import { mapAsciiDocDocument, readContentsPreference, writeContentsPreference, type SourceHeading } from './common/source-outline'

// ========================================
// IMPORTS
// ========================================

import { keymap } from '@codemirror/view'
import { TextEditor, type TextEditorHandle, type TextPosition } from './common/text-editor'
import { EditorAdapterController } from './common/editor-adapter'
import { vRovingToolbar } from './common/roving-toolbar'

// ========================================
// INIT
// ========================================



interface MarkerOptions {
  kind: 'diagram'
  from: TextPosition
  to: TextPosition
  text: string
  action: EventListener
}

type FormattingAction = {
  readonly label: string
  readonly icon: string
  readonly desktopIcon?: string
  readonly color?: string
} & (
  | { readonly kind: 'markup' | 'line' | 'modal'; readonly value: string }
  | { readonly kind: 'link' | 'code' | 'table'; readonly value?: never }
)

const formattingActions: Readonly<Record<'emphasis' | 'script' | 'blocks' | 'insert', readonly FormattingAction[]>> = {
  emphasis: [
    { kind: 'markup', value: '**', icon: 'mdi-format-bold', label: 'editor:markup.bold' },
    { kind: 'markup', value: '__', icon: 'mdi-format-italic', label: 'editor:markup.italic' }
  ],
  script: [
    { kind: 'markup', value: '~', icon: 'mdi-format-subscript', label: 'editor:markup.subscript' },
    { kind: 'markup', value: '^', icon: 'mdi-format-superscript', label: 'editor:markup.superscript' }
  ],
  blocks: [
    { kind: 'line', value: '> ', icon: 'mdi-format-quote-open', desktopIcon: 'mdi-alpha-t-box-outline', label: 'editor:markup.blockquote' },
    { kind: 'line', value: 'NOTE: ', icon: 'mdi-alpha-n-box-outline', color: 'blue', label: 'editor:editorAsciidoc.noteBlockquote' },
    { kind: 'line', value: 'TIP: ', icon: 'mdi-alpha-t-box-outline', color: 'success', label: 'editor:editorAsciidoc.tipBlockquote' },
    { kind: 'line', value: 'WARNING: ', icon: 'mdi-alpha-w-box-outline', color: 'warning', label: 'editor:markup.blockquoteWarning' },
    { kind: 'line', value: 'CAUTION: ', icon: 'mdi-alpha-c-box-outline', color: 'purple', label: 'editor:editorAsciidoc.cautionBlockquote' },
    { kind: 'line', value: 'IMPORTANT: ', icon: 'mdi-alpha-i-box-outline', color: 'error', label: 'editor:editorAsciidoc.importantBlockquote' }
  ],
  insert: [
    { kind: 'link', icon: 'mdi-link-plus', label: 'editor:markup.insertLink' },
    { kind: 'modal', value: 'editorModalMedia', icon: 'mdi-folder-multiple-image', label: 'editor:markup.insertAssets' },
    { kind: 'code', icon: 'mdi-code-braces', label: 'editor:markup.insertCodeBlock' },
    { kind: 'table', icon: 'mdi-table', label: 'editor:markup.tableHelper' },
    { kind: 'modal', value: 'editorModalDrawio', icon: 'mdi-chart-multiline', label: 'editor:markup.insertDiagram' }
  ]
}
const mobileFormattingGroups = [formattingActions.insert, formattingActions.script, formattingActions.blocks] as const
const previewSyncs = new WeakMap<object, SourcePreviewSync>()

// ========================================
// Vue Component
// ========================================

export default defineComponent({
  components: { EditorContentsPane },
  directives: {
    rovingToolbar: vRovingToolbar
  },
  emits: ['editor-adapter', 'editor-adapter-clear'],
  setup() {
    const { mdAndUp } = useDisplay()
    return { mdAndUp, formattingActions, mobileFormattingGroups }
  },
  data() {
    return {
      cm: null as TextEditorHandle | null,
      editorAdapter: null as EditorAdapterController | null,
      imageAuthoring: null as Raw<ReturnType<typeof createSourceImageAuthoring>> | null,
      sourceAuthoring: null as Raw<SourceAuthoring> | null,
      debouncedProcessContent: null as ReturnType<typeof _.debounce> | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: Boolean(this.mdAndUp),
      contentsShown: readContentsPreference(),
      headings: [] as SourceHeading[],
      currentSectionLine: 0,
      previewAlignmentEnabled: true,
      outlineLoading: false,
      editorDisposed: false,
      insertLinkDialog: false,
      previewHTML: '',
      previewDirty: true,
      previewLoading: false,
      previewError: '',
      previewRequestId: 0
    }
  },
  computed: {
    isModalShown() {
      return this.activeModal !== ''
    },
    locale() {
      return wikiStore.page.locale
    },
    contentDirection() {
      return i18next.dir(this.locale)
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
    '$vuetify.theme.current.dark' (newValue: boolean) {
      this.cm?.setDark(newValue)
    },
    previewShown (newValue: boolean) {
      previewSyncs.get(this)?.detach()
      if (newValue) {
        this.debouncedProcessContent?.cancel()
        if (this.previewDirty) void this.processContent(this.editor().getValue())
        else this.$nextTick(() => this.refreshPreviewSync())
      }
      this.$nextTick(() => this.cm?.requestMeasure())
    }
  },
  methods: {
    toggleContents () {
      this.contentsShown = !this.contentsShown || (this.previewShown && this.$vuetify.display.smAndDown)
      if (this.contentsShown && this.$vuetify.display.smAndDown) this.previewShown = false
      writeContentsPreference(this.contentsShown)
      this.$nextTick(() => this.cm?.requestMeasure())
      if (!this.contentsShown) this.$nextTick(() => {
        const root = this.$refs.root
        if (root instanceof HTMLElement) root.querySelector<HTMLElement>('[data-editor-contents-toggle]')?.focus()
      })
    },
    togglePreviewAlignment () {
      this.previewAlignmentEnabled = !this.previewAlignmentEnabled
      previewSyncs.get(this)?.cancel()
      if (this.previewAlignmentEnabled) previewSyncs.get(this)?.resumeFromLeader()
    },
    jumpToSource (line: number) {
      const editor = this.cm
      if (!editor) return
      if (this.$vuetify.display.smAndDown) {
        this.previewShown = false
        this.contentsShown = false
        writeContentsPreference(false)
      }
      previewSyncs.get(this)?.interact('source')
      editor.setSelection({ line, ch: 0 })
      this.currentSectionLine = line
      this.$nextTick(() => {
        editor.requestMeasure()
        editor.scrollToLine(line)
        editor.focus()
        this.refreshPreviewSync()
      })
    },
    refreshPreviewSync () {
      const preview = this.$refs.editorPreview
      const container = this.$refs.editorPreviewContainer
      if (preview instanceof HTMLElement && container instanceof HTMLElement) previewSyncs.get(this)?.attach(preview, container)
    },
    runFormattingAction(action: FormattingAction) {
      switch (action.kind) {
        case 'markup':
          this.toggleMarkup({ start: action.value })
          break
        case 'line':
          this.insertBeforeEachLine({ content: action.value })
          break
        case 'modal':
          this.toggleModal(action.value)
          break
        case 'link':
          this.insertLink()
          break
        case 'code':
          this.sourceAuthoring?.insertCodeBlock()
          break
        case 'table':
          this.sourceAuthoring?.insertTable()
          break
      }
    },
    focusEditor () {
      if (this.previewShown && this.$vuetify.display.smAndDown) {
        this.previewShown = false
        void this.$nextTick(() => this.cm?.focus())
        return
      }
      this.cm?.focus()
    },
    togglePreview () {
      this.previewShown = !this.previewShown
    },
    flushEligibleEditorText() {
      const editor = this.cm
      if (!editor) return
      wikiStore.editor.content = editor.getValue()
      this.editorAdapter?.notifyState()
    },
    clearEditorText() {
      if (this.cm?.reset) this.cm.reset('')
      else this.cm?.setValue('')
      wikiStore.editor.content = ''
      this.previewHTML = ''
      this.previewDirty = true
      this.previewError = ''
      this.previewRequestId += 1
      this.headings = []
      this.outlineLoading = false
      this.debouncedProcessContent?.cancel()
    },
    toggleModal(key: string) {
      if (key === 'editorModalMedia' && !this.activeModal && this.imageAuthoring?.open()) return
      this.activeModal = this.activeModal === key ? '' : key
    },
    handleEditorSaveConflict() {
      this.toggleModal('editorModalConflict')
    },
    handleEditorContentOverwrite() {
      this.editor().setValue(wikiStore.editor.content)
    },
    handleEditorInsert(opts: EditorInsertPayload) {
      switch (opts.kind) {
        case 'IMAGE':
          this.imageAuthoring?.insert(opts)
          break
        case 'BINARY':
          this.insertAtCursor({ content: `link:${opts.path}[${opts.text}]` })
          break
        case 'DIAGRAM': {
          const cm = this.editor()
          const selectionStart = cm.cursor('from').line
          const selectionEnd = cm.cursor('to').line + 1
          cm.replaceSelection('```diagram\n' + opts.text + '\n```\n')
          this.processMarkers(selectionStart, selectionEnd)
          break
        }
      }
    },
    closeAllModal() {
      this.activeModal = ''
    },
    editor(): TextEditorHandle {
      if (!this.cm) throw new Error(this.$t('editor:editorAsciidoc.codemirrorEditorNotInitialized'))
      return this.cm
    },
    async processContent(newContent: string) {
      const cm = this.editor()
      this.processMarkers(0, cm.lineCount)
      const requestId = ++this.previewRequestId
      this.previewLoading = this.previewShown
      this.outlineLoading = true
      this.previewError = ''
      try {
        const document = await load(newContent, {
          standalone: false,
          sourcemap: true,
          safe: 'secure',
          attributes: { showtitle: true, icons: 'font' }
        })
        if (this.editorDisposed || requestId !== this.previewRequestId) return
        this.headings = mapAsciiDocDocument(document)
        this.outlineLoading = false
        if (!this.previewShown) {
          this.previewDirty = true
          return
        }
        const html = await document.convert()
        if (this.editorDisposed || requestId !== this.previewRequestId || !this.previewShown) return
        // Template contents remain inert until the existing sanitizer has approved them.
        const fragment = window.document.createElement('template')
        fragment.innerHTML = html
        for (const element of fragment.content.querySelectorAll('[class]')) {
          for (const role of (element.getAttribute('class') ?? '').split(/\s+/)) {
            const match = /^editor-source-line-(\d+)$/.exec(role)
            if (!match) continue
            element.setAttribute('data-source-line', match[1])
            element.classList.remove(role)
          }
        }
        for (const element of fragment.content.querySelectorAll(this.$t('editor:editorAsciidoc.preHighlightCodeLanguage'))) {
          const diagramContent = decodeBase64Text(element.innerHTML)
          const replacement = window.document.createElement('template')
          replacement.innerHTML = this.$t('editor:editorAsciidoc.preClassDiagramPre', { diagramContent, interpolation: { escapeValue: false } })
          element.parentElement?.replaceWith(replacement.content)
        }
        this.previewHTML = DOMPurify.sanitize(fragment.innerHTML, {
          ADD_TAGS: ['foreignObject'],
          HTML_INTEGRATION_POINTS: { foreignobject: true }
        })
        this.previewDirty = false
        this.$nextTick(() => {
          if (!this.editorDisposed && requestId === this.previewRequestId) this.refreshPreviewSync()
        })
      } catch (err) {
        if (!this.editorDisposed && requestId === this.previewRequestId) {
          this.headings = []
          this.previewError = err instanceof Error ? err.message : this.$t('editor:editorAsciidoc.previewCouldNotRendered')
        }
      } finally {
        if (requestId === this.previewRequestId) {
          this.previewLoading = false
          this.outlineLoading = false
        }
      }
    },
    retryPreview() {
      void this.processContent(this.editor().getValue())
    },
    insertAtCursor({ content }: ContentInsertOptions) {
      const editor = this.editor()
      editor.replaceRange(content, editor.cursor())
    },
    insertAfter({ content, newLine }: LineInsertOptions) {
      const editor = this.editor()
      const line = editor.cursor('to').line
      editor.replaceRange(newLine ? `\n${content}\n` : content, { line, ch: editor.getLine(line).length })
    },
    insertBeforeEachLine({ content, after }: MultiLineInsertOptions) {
      const editor = this.editor()
      const lines = editor.selectedLines()
      for (const line of [...lines].reverse()) {
        const lineContent = editor.getLine(line)
        const replacement = _.startsWith(lineContent, content) ? lineContent.substring(content.length) : content + lineContent
        editor.replaceRange(replacement, { line, ch: 0 }, { line, ch: lineContent.length })
      }
      if (after) {
        const line = lines[lines.length - 1]
        editor.replaceRange(`\n${after}\n`, { line, ch: editor.getLine(line).length })
      }
    },
    positionSync(position: TextPosition) {
      this.cursorPos = position
      this.currentSectionLine = position.line
    },
    toggleMarkup({ start, end = start }: MarkupOptions) {
      const editor = this.editor()
      if (!editor.hasSelection()) {
        return wikiStore.showNotification({
          message: this.$t('editor:markup.noSelectionError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      for (const selection of editor.selectedOffsets().reverse()) {
        editor.replaceOffsets(start + editor.slice(selection.from, selection.to) + end, selection.from, selection.to)
      }
    },
    setHeaderLine(level: number) {
      const editor = this.editor()
      const line = editor.cursor().line
      let content = editor.getLine(line)
      const length = content.length
      if (_.startsWith(content, '=')) content = content.replace(/^(=+ )/, '')
      content = _.times(level, () => '=').join('') + ` ` + content
      editor.replaceRange(content, { line, ch: 0 }, { line, ch: length })
    },
    toggleFullscreen() {
      const root = this.$refs.root
      if (root instanceof HTMLElement) void root.requestFullscreen?.()
    },
    refresh() {
      this.$nextTick(() => this.cm?.requestMeasure())
    },
    insertLink() {
      this.insertLinkDialog = true
    },
    insertLinkHandler({ locale, path }: PageLinkTarget) {
      const lastPart = _.last(path.split('/'))
      this.insertAtCursor({
        content: siteLangs.length > 0 ? `link:/${locale}/${path}[${lastPart}]` : `link:/${path}[${lastPart}]`
      })
    },
    processMarkers(_from: number, _to: number) {
      const editor = this.editor()
      const markers: MarkerOptions[] = []
      let foundStart: number | null = null
      for (let line = 0; line < editor.lineCount; line++) {
        const text = editor.getLine(line)
        if (text.startsWith('```diagram')) {
          foundStart = line
        } else if (text === '```' && foundStart !== null) {
          const start = foundStart
          const end = line
          if (end - start === 2) {
            markers.push({
              kind: 'diagram',
              from: { line: start, ch: 3 },
              to: { line: start, ch: 10 },
              text: this.$t('editor:editorAsciidoc.editDiagram'),
              action: () => {
                editor.setSelection({ line: start, ch: 0 }, { line: end, ch: 3 })
                try {
                  wikiStore.editor.activeModalData = decodeBase64Text(editor.getLine(end - 1))
                  this.toggleModal('editorModalDrawio')
                } catch {
                  wikiStore.showNotification({
                    message: this.$t('editor:editorAsciidoc.failedProcessDiagramData'),
                    style: 'warning',
                    icon: 'warning'
                  })
                }
              }
            })
            editor.foldRange({ line: start, ch: editor.getLine(start).length }, { line: end, ch: 0 })
          }
          foundStart = null
        }
      }
      editor.setMarkers(markers)
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'asciidoc'

    if (this.mode === 'create' && !wikiStore.editor.content) {
      wikiStore.editor.content = this.$t('editor:editorAsciidoc.headerContent')
    }

    this.debouncedProcessContent = _.debounce((newContent: string) => {
      void this.processContent(newContent)
    }, 600)
    const container = this.$refs.cm
    if (!(container instanceof HTMLElement)) {
      throw new Error(this.$t('editor:editorAsciidoc.asciidocEditorHostUnavailable'))
    }
    this.imageAuthoring = markRaw(createSourceImageAuthoring(
      'asciidoc', () => wikiStore.user.authenticated,
      () => `${wikiStore.user.id}:${wikiStore.offlineIdentityEpoch}:${wikiStore.page.id}:${this.locale}:${this.path}`
    ))
    this.sourceAuthoring = markRaw(createSourceAuthoring(
      'asciidoc', () => wikiStore.user.authenticated,
      () => `${wikiStore.user.id}:${wikiStore.offlineIdentityEpoch}:${wikiStore.page.id}:${this.locale}:${this.path}`
    ))
    const cm = new TextEditor({
      parent: container,
      ariaLabel: this.$t('editor:editorAsciidoc.asciidocSource'),
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      direction: 'ltr',
      extensions: [
        this.imageAuthoring.extension,
        this.sourceAuthoring.extension,
        keymap.of([
          { key: 'F11', run: () => { this.toggleFullscreen(); return true } },
          { key: 'Mod-b', run: () => { this.toggleMarkup({ start: '**' }); return true } },
          { key: 'Mod-i', run: () => { this.toggleMarkup({ start: '__' }); return true } }
        ])
      ],
      onChange: value => {
        wikiStore.editor.content = value
        this.editorAdapter?.noteTextChange()
        this.previewDirty = true
        this.previewRequestId += 1
        this.outlineLoading = true
        previewSyncs.get(this)?.cancel()
        this.debouncedProcessContent?.(value)
      },
      onCursor: position => this.positionSync(position),
      onInteraction: () => previewSyncs.get(this)?.interact('source'),
      onScroll: () => previewSyncs.get(this)?.sourceScrolled(),
      onMeasure: () => previewSyncs.get(this)?.request()
    })
    this.cm = markRaw(cm)
    previewSyncs.set(this, new SourcePreviewSync(
      () => this.cm,
      () => !this.editorDisposed && this.previewAlignmentEnabled && this.previewShown && !this.previewDirty,
      line => { this.currentSectionLine = line }
    ))
    const adapter = new EditorAdapterController({
      readText: () => cm.getValue(),
      writeText: text => {
        cm.setValue(text)
        wikiStore.editor.content = text
        this.previewDirty = true
        void this.processContent(text)
      },
      clearText: () => this.clearEditorText(),
      flushText: () => this.flushEligibleEditorText()
    })
    this.editorAdapter = markRaw(adapter)
    adapter.initialize()
    this.$emit('editor-adapter', adapter)

    // Render initial preview
    void this.processContent(wikiStore.editor.content)

    onEditorInsert(this.handleEditorInsert)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount() {
    this.editorDisposed = true
    previewSyncs.get(this)?.detach()
    previewSyncs.delete(this)
    this.imageAuthoring?.destroy()
    this.imageAuthoring = null
    this.sourceAuthoring?.destroy()
    this.sourceAuthoring = null
    const adapter = this.editorAdapter
    if (adapter) {
      this.$emit('editor-adapter-clear', adapter)
      adapter.destroy()
      this.editorAdapter = null
    }
    this.previewRequestId += 1
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    this.debouncedProcessContent?.cancel()
    this.cm?.destroy()
    this.cm = null
  }
})
</script>

<style lang='scss'>
$editor-ascii-height: calc(100dvh - 137px);
$editor-ascii-height-mobile: calc(100dvh - 112px - 16px);

.editor-asciidoc {
  &-main {
    display: flex;
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
  }

  &-editor {
    background-color: rgb(var(--v-theme-background));
    flex: 1 1 50%;
    display: block;
    height: $editor-ascii-height;
    min-width: 0;
    min-height: 0;
    position: relative;

    @include until($tablet) {
      height: $editor-ascii-height-mobile;
    }

    &.is-mobile-hidden {
      display: none;
    }

    > div {
      height: 100%;
      direction: ltr;
    }
  }

  &-preview {
    flex: 1 1 50%;
    background-color: rgb(var(--v-theme-background));
    position: relative;
    height: $editor-ascii-height;
    overflow: hidden;
    padding: 1rem;


    @include until($tablet) {
      display: block;
      flex: 1 1 100%;
      width: 100%;
      max-width: 100vw !important;
      padding: 12px;
    }

    &-enter-active, &-leave-active {
      transition: max-width .5s ease;

      @media (prefers-reduced-motion: reduce) { transition: none; }
      max-width: 50vw;

      .editor-asciidoc-preview-content {
        width: 50vw;
        overflow: hidden;
      }
    }
    &-enter-from, &-leave-to {
      max-width: 0;
    }

    &-content {
      height: $editor-ascii-height;
      overflow-y: scroll;
      scroll-behavior: auto;
      padding: 0;
      width: calc(100% + 17px);
      // -ms-overflow-style: none;

      // &::-webkit-scrollbar {
      //   width: 0px;
      //   background: transparent;
      // }

      @include until($tablet) {
        height: $editor-ascii-height-mobile;
        width: 100%;
      }

      > div {
        outline: none;
      }
      :where(pre, code) {
        direction: ltr;
        unicode-bidi: isolate;
        text-align: start;
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
        border-start-start-radius: 5px;
        font-style: italic;

        &::after {
          display: none;
        }

        &-header {
          background-color: rgb(var(--v-theme-primary));
          color: rgb(var(--v-theme-on-primary)) !important;
          padding: 5px 12px;
          font-size: 14px;
          font-weight: 500;
          margin-block-start: 0 !important;

          &::after {
            display: none;
          }
        }

        &-content {
          border-inline-start: 4px solid rgb(var(--v-theme-primary));
          background-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, transparent);
          padding: 0 15px 15px;
          overflow: hidden;
        }
      }
    }
  }

  &-toolbar {
    background: var(--wiki-surface-raised) !important;
    border-block-end: 1px solid var(--wiki-surface-border);
    color: rgb(var(--v-theme-on-surface));
    min-width: 0;
    flex: 0 0 auto;

    .v-toolbar__content {
      padding-inline: 64px 8px;
      gap: 3px;
      flex-wrap: nowrap;

      @include until($tablet) {
        padding-inline: 8px;
      }
    }
  }

  &-tool-separator {
    align-self: center;
    flex: 0 0 auto;
    height: 24px;
    margin-inline: 4px;
    border-color: var(--wiki-surface-border);
    opacity: 1;
  }

  &-toolbar .v-btn,
  &-sidebar .v-btn {
    border-radius: var(--wiki-control-radius, 6px) !important;
    background: transparent;
    box-shadow: none;

    &.v-btn--icon {
      width: 44px;
      height: 44px;
      flex: 0 0 44px;
    }

    &[aria-pressed='true'] {
      background: rgba(var(--v-theme-primary), .1);
      color: var(--wiki-accent-ink);
    }

    &:focus-visible {
      outline: 2px solid var(--wiki-accent-ink);
      outline-offset: -2px;
    }
  }


  &-sidebar {
    background-color: var(--wiki-surface-sunken);
    border-inline-end: 1px solid var(--wiki-surface-border);
    width: 64px;
    flex: 0 0 64px;
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
    padding-inline-start: 0;
    background: var(--wiki-surface-raised) !important;
    border-top: 1px solid var(--wiki-surface-border);
    color: var(--wiki-text-muted);

    &-locale {
      background-color: rgba(var(--v-theme-primary), .14);
      color: var(--wiki-accent-ink);
      font-weight: 700;
      display:inline-flex;
      padding: 0 12px;
      height: 24px;
      width: 63px;
      justify-content: center;
      align-items: center;
    }
  }
  .editor-status-path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 12px;
  }

  // ==========================================
  // Fix FAB revealing under codemirror
  // ==========================================

  .speed-dial--fixed {
    z-index: 8;
  }

  @media (prefers-reduced-motion: reduce) {
    &,
    & * {
      animation: none !important;
      transition: none !important;
    }
  }

}
</style>

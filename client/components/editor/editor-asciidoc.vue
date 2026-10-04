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
      .editor-asciidoc-sidebar(role='toolbar', aria-orientation='horizontal', :aria-label='$t(`editor:editorAsciidoc.toolbarInsertTools`)', v-roving-toolbar='{ onEscape: focusEditor }')
        span.editor-insert-label {{ $t('editor:markup.insertGroup') }}
        v-btn(v-for='action in formattingActions.insert', :key='action.label', icon, rounded='md', variant='text', :aria-label='$t(action.label)', :aria-pressed='action.kind === `modal` ? activeModal === action.value : undefined', @click='runFormattingAction(action)').mx-0
          v-icon(:color='action.kind === `modal` && activeModal === action.value ? `primary` : undefined') {{ action.icon }}
          v-tooltip(activator='parent', location='right', :text='$t(action.label)')
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-btn.mt-3(icon, rounded='md', variant='text', :aria-label='$t(`editor:markup.distractionFreeMode`)', @click='toggleFullscreen').mx-0
            v-icon mdi-arrow-expand-all
            v-tooltip(activator='parent', location='right', :text='$t(`editor:markup.distractionFreeMode`)')
      .editor-asciidoc-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        .editor-pane-label {{ $t('editor:editor.source') }} · {{ $t('editor:editorAsciidoc.asciidoc') }}
        div(ref='cm')
      transition(name='editor-asciidoc-preview')
        .editor-asciidoc-preview(v-if='previewShown')
          .editor-pane-label {{ $t('editor:editorAsciidoc.showPreview') }}
          .editor-asciidoc-preview-content.editor-page-canvas.contents(ref='editorPreviewContainer', :aria-busy='previewLoading', :lang='locale', :dir='contentDirection')
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
import { useDisplay } from 'vuetify'
import i18next from 'i18next'
import * as _ from 'lodash-es'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import type { Element } from 'domhandler'
import type { ContentInsertOptions, LineInsertOptions, MarkupOptions, MultiLineInsertOptions, PageLinkTarget } from './common/editor-types'
import DOMPurify from 'dompurify'
import { decodeBase64Text } from '../../helpers/base64'
import { convert } from '@asciidoctor/core'

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
const cheerio = require('cheerio')



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
  | { readonly kind: 'link'; readonly value?: never }
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
    { kind: 'modal', value: 'editorModalDrawio', icon: 'mdi-chart-multiline', label: 'editor:markup.insertDiagram' }
  ]
}
const mobileFormattingGroups = [formattingActions.insert, formattingActions.script, formattingActions.blocks] as const

// ========================================
// Vue Component
// ========================================

export default defineComponent({
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
      debouncedProcessContent: null as ReturnType<typeof _.debounce> | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: Boolean(this.mdAndUp),
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
    previewShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.debouncedProcessContent?.cancel()
        if (this.previewDirty) {
          void this.processContent(this.editor().getValue())
        }
      } else if (!newValue && oldValue) {
        if (this.previewLoading) this.previewDirty = true
        this.previewRequestId += 1
        this.previewLoading = false
      }
    }
  },
  methods: {
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
    },
    toggleModal(key: string) {
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
          this.insertAtCursor({ content: `image::${opts.path}[${opts.text}]` })
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
      if (!this.previewShown) {
        this.previewDirty = true
        return
      }
      const requestId = ++this.previewRequestId
      this.previewLoading = true
      this.previewError = ''
      try {
        const html = await convert(newContent, {
          standalone: false,
          safe: 'secure',
          attributes: { showtitle: true, icons: 'font' }
        })
        if (requestId !== this.previewRequestId || !this.previewShown) return
        const $ = cheerio.load(html, { decodeEntities: true })
        $(this.$t('editor:editorAsciidoc.preHighlightCodeLanguage')).each((_index: number, element: Element) => {
          const diagramContent = decodeBase64Text($(element).html() ?? '')
          $(element).parent().replaceWith(this.$t('editor:editorAsciidoc.preClassDiagramPre', { diagramContent, interpolation: { escapeValue: false } }))
        })
        this.previewHTML = DOMPurify.sanitize($.html(), {
          ADD_TAGS: ['foreignObject'],
          HTML_INTEGRATION_POINTS: { foreignobject: true }
        })
        this.previewDirty = false
      } catch (err) {
        if (requestId === this.previewRequestId && this.previewShown) {
          this.previewError = err instanceof Error ? err.message : this.$t('editor:editorAsciidoc.previewCouldNotRendered')
        }
      } finally {
        if (requestId === this.previewRequestId) this.previewLoading = false
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
    const cm = new TextEditor({
      parent: container,
      ariaLabel: this.$t('editor:editorAsciidoc.asciidocSource'),
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      direction: 'ltr',
      extensions: [
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
        this.debouncedProcessContent?.(value)
      },
      onCursor: position => this.positionSync(position)
    })
    this.cm = markRaw(cm)
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

.editor-asciidoc {
  &-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);

    > .editor-asciidoc-sidebar { grid-column: 1 / -1; }
    > .editor-asciidoc-editor:last-child { grid-column: 1 / -1; }

    @include until($tablet) {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
    }
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
  }

  &-editor {
    background-color: rgb(var(--v-theme-background));
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    position: relative;

    &.is-mobile-hidden {
      display: none;
    }

    > div:not(.editor-pane-label) {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      direction: ltr;
      .cm-editor { height: 100%; }
    }
  }

  &-preview {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    border-inline-start: 1px solid var(--wiki-surface-border);
    flex-direction: column;
    background-color: rgb(var(--v-theme-background));
    position: relative;
    overflow: hidden;
    padding: 0;


    @include until($tablet) {
      display: flex;
      flex: 1 1 100%;
      width: 100%;
      max-width: 100vw !important;
      padding: 0;
    }

    &-enter-active, &-leave-active {
      transition: max-width .5s ease;
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
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: var(--wiki-space-4);
      width: 100%;

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
      padding-inline: 8px;
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
    border-block-end: 1px solid var(--wiki-surface-border);
    width: 100%;
    flex: 0 0 100%;
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    padding: var(--wiki-space-1) var(--wiki-space-3);

    @include until($tablet) {
      display: none;
    }
  }

  &-sysbar {
    position: static !important;
    flex: 0 0 24px;
    min-height: 24px;
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

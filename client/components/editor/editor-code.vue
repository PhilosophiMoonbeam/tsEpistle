<template lang='pug'>
  .editor-code(ref='root')
    .editor-code-main
      .editor-code-sidebar
        v-tooltip(location="right")
          template(v-slot:activator='{ props }')
            v-btn.mt-3(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:editorCode.insertAssets`)', :aria-pressed='activeModal === `editorModalMedia`', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `primary` : undefined') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right")
            template(v-slot:activator='{ props }')
              v-btn.mt-3(icon, rounded='0', v-bind='props', :aria-label='$t(`editor:editorCode.toggleDistractionFreeMode`)', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-code-editor
        div(ref='cm', role='region', :aria-label='$t(`editor:editorCode.codeEditor`)')
    v-system-bar.editor-status-bar.editor-code-sysbar(absolute)
      .text-body-small.editor-code-sysbar-locale {{locale.toUpperCase()}}
      .editor-status-path /{{path}}
        v-tooltip(activator='parent', location='top') /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small {{ $t(`editor:editorCode.code`) }}
        v-spacer
        .text-body-small {{ $t(`editor:editorCode.lnCol`, { line: cursorPos.line + 1, ch: cursorPos.ch + 1, interpolation: { escapeValue: false } }) }}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import type { ContentInsertOptions, LineInsertOptions, MultiLineInsertOptions } from './common/editor-types'
import { TextEditor, type TextEditorHandle, type TextPosition } from './common/text-editor'
import { EditorAdapterController } from './common/editor-adapter'
import { html } from '@codemirror/lang-html'
const HTML_ESCAPE_REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const IMAGE_ALIGNMENTS = new Set(['left', 'center', 'right', 'abstopright'])

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPE_REPLACEMENTS[character] ?? character)
}

// ========================================
// Vue Component
// ========================================

export default defineComponent({
  emits: ['editor-adapter', 'editor-adapter-clear'],
  data() {
    return {
      editorAdapter: null as EditorAdapterController | null,
      cm: null as TextEditorHandle | null,
      cursorPos: { ch: 0, line: 0 } as TextPosition
    }
  },
  computed: {
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
    '$vuetify.theme.current.dark' (newValue: boolean) {
      this.cm?.setDark(newValue)
    }
  },
  methods: {
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
    },
    toggleModal(key: string) {
      this.activeModal = (this.activeModal === key) ? '' : key
    },
    handleEditorSaveConflict() {
      this.toggleModal(`editorModalConflict`)
    },
    handleEditorContentOverwrite() {
      this.editor().setValue(wikiStore.editor.content)
    },
    handleEditorInsert(opts: EditorInsertPayload) {
      switch (opts.kind) {
        case 'IMAGE': {
          if (typeof opts.path !== 'string') break
          const text = typeof opts.text === 'string' ? opts.text : ''
          let img = this.$t('editor:editorCode.imgSrcAlt', { path: escapeHtml(opts.path), text: escapeHtml(text), interpolation: { escapeValue: false } })
          if (typeof opts.align === 'string' && IMAGE_ALIGNMENTS.has(opts.align)) {
            img += ` class="align-${opts.align}"`
          }
          img += ` />`
          this.insertAtCursor({
            content: img
          })
          break
        }
        case 'BINARY': {
          if (typeof opts.path !== 'string') break
          const text = typeof opts.text === 'string' && opts.text.length > 0 ? opts.text : opts.path
          this.insertAtCursor({
            content: this.$t('editor:editorCode.hrefTitle', { path: escapeHtml(opts.path), text: escapeHtml(text), text2: escapeHtml(text), interpolation: { escapeValue: false } })
          })
          break
        }
      }
    },
    editor(): TextEditorHandle {
      if (!this.cm) throw new Error(this.$t('editor:editorCode.codemirrorEditorNotInitialized'))
      return this.cm
    },
    /**
     * Insert content at cursor
     */
    insertAtCursor({ content }: ContentInsertOptions) {
      const editor = this.editor()
      editor.replaceRange(content, editor.cursor())
    },
    /**
     * Insert content after current line
     */
    insertAfter({ content, newLine }: LineInsertOptions) {
      const editor = this.editor()
      const line = editor.cursor('to').line
      editor.replaceRange(newLine ? `\n${content}\n` : content, { line, ch: editor.getLine(line).length })
    },
    /**
     * Insert content before current line
     */
    insertBeforeEachLine({ content, after }: MultiLineInsertOptions) {
      const editor = this.editor()
      const lines = editor.selectedLines()
      for (const line of [...lines].reverse()) {
        const lineContent = editor.getLine(line)
        const replacement = lineContent.startsWith(content) ? lineContent.substring(content.length) : content + lineContent
        editor.replaceRange(replacement, { line, ch: 0 }, { line, ch: lineContent.length })
      }
      if (after) {
        const line = lines[lines.length - 1]
        editor.replaceRange(`\n${after}\n`, { line, ch: editor.getLine(line).length })
      }
    },
    /**
     * Update cursor state
     */
    positionSync(position: TextPosition) {
      this.cursorPos = position
    },
    toggleFullscreen () {
      const root = this.$refs.root
      if (root instanceof HTMLElement) void root.requestFullscreen?.()
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'code'

    if (this.mode === 'create') {
      wikiStore.editor.content = this.$t('editor:editorCode.h1TitleH1P')
    }

    const parent = this.$refs.cm
    if (!(parent instanceof HTMLElement)) {
      throw new Error(this.$t('editor:editorCode.codemirrorEditorHostUnavailable'))
    }
    const cm = new TextEditor({
      parent,
      ariaLabel: this.$t('editor:editorCode.htmlSource'),
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      language: html(),
      onChange: value => {
        wikiStore.editor.content = value
        this.editorAdapter?.noteTextChange()
      },
      onCursor: position => this.positionSync(position)
    })
    this.cm = markRaw(cm)
    const adapter = new EditorAdapterController({
      readText: () => cm.getValue(),
      writeText: text => {
        cm.setValue(text)
        wikiStore.editor.content = text
      },
      clearText: () => this.clearEditorText(),
      flushText: () => this.flushEligibleEditorText()
    })
    this.editorAdapter = markRaw(adapter)
    adapter.initialize()
    this.$emit('editor-adapter', adapter)

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
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    this.cm?.destroy()
    this.cm = null
  }
})
</script>

<style lang='scss'>
$editor-height: calc(100dvh - 64px - 24px);
$editor-height-mobile: calc(100dvh - 56px - 16px);

.editor-code {
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
    height: $editor-height;
    min-width: 0;
    min-height: 0;
    position: relative;

    > div {
      height: 100%;
    }

    &-title {
      background-color: var(--wiki-surface-raised);
      border-bottom-left-radius: 5px;
      display: inline-flex;
      height: 30px;
      justify-content: center;
      align-items: center;
      padding: 0 1rem;
      color: var(--wiki-text-muted);
      position: absolute;
      top: 0;
      right: 0;
      z-index: 7;
      text-transform: uppercase;
      font-size: .7rem;
      cursor: pointer;

      @include until($tablet) {
        display: none;
      }
    }
    @include until($tablet) {
      height: $editor-height-mobile;
    }
  }

  &-sidebar {
    background-color: var(--wiki-surface-sunken);
    border-inline-end: 1px solid var(--wiki-surface-border);
    width: 64px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 24px 0;

    @include until($tablet) {
      width: 48px;
      padding: 12px 0;
    }
  }

  &-sysbar {
    padding-left: 0;
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


}
</style>

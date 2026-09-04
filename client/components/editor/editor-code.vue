<template lang='pug'>
  .editor-code(ref='root')
    .editor-code-main
      .editor-code-sidebar
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, rounded='0', v-bind='props', aria-label='Insert assets', :aria-pressed='activeModal === `editorModalMedia`', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p8s(icon, rounded='0', v-bind='props', aria-label='Toggle distraction-free mode', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-code-editor
        div(ref='cm', role='region', aria-label='Code editor')
    v-system-bar.editor-status-bar.editor-code-sysbar(absolute, color="grey-darken-3")
      .text-body-small.editor-code-sysbar-locale {{locale.toUpperCase()}}
      .editor-status-path(title='/' + path) /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small Code
        v-spacer
        .text-body-small Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import type { ContentInsertOptions, LineInsertOptions, MultiLineInsertOptions } from './common/editor-types'
import { TextEditor, type TextEditorHandle, type TextPosition } from './common/text-editor'
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
  data() {
    return {
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
          let img = `<img src="${escapeHtml(opts.path)}" alt="${escapeHtml(text)}"`
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
            content: `<a href="${escapeHtml(opts.path)}" title="${escapeHtml(text)}">${escapeHtml(text)}</a>`
          })
          break
        }
      }
    },
    editor(): TextEditorHandle {
      if (!this.cm) throw new Error('CodeMirror editor is not initialized')
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
      wikiStore.editor.content = '<h1>Title</h1>\n\n<p>Some text here</p>'
    }

    const parent = this.$refs.cm
    if (!(parent instanceof HTMLElement)) {
      throw new Error('CodeMirror editor host is unavailable')
    }
    const cm = new TextEditor({
      parent,
      ariaLabel: 'HTML source',
      dark: this.$vuetify.theme.current.dark,
      value: wikiStore.editor.content,
      language: html(),
      onChange: value => {
        wikiStore.editor.content = value
      },
      onCursor: position => this.positionSync(position)
    })
    this.cm = markRaw(cm)

    onEditorInsert(this.handleEditorInsert)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount() {
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
    background-color: darken(mc('grey', '900'), 4.5%);
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
      background-color: mc('grey', '800');
      border-bottom-left-radius: 5px;
      display: inline-flex;
      height: 30px;
      justify-content: center;
      align-items: center;
      padding: 0 1rem;
      color: mc('grey', '500');
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
    background-color: mc('grey', '900');
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

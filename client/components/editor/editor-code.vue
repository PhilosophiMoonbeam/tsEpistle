<template lang='pug'>
  .editor-code
    .editor-code-main
      .editor-code-sidebar
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInLeft(icon, rounded='0', v-bind='props', disabled).mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, rounded='0', v-bind='props', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p2s(icon, rounded='0', v-bind='props', @click='toggleModal(`editorModalBlocks`)', disabled).mx-0
              v-icon(:color='activeModal === `editorModalBlocks` ? `teal` : ``') mdi-view-dashboard-outline
          span {{$t('editor:markup.insertBlock')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, rounded='0', v-bind='props', disabled).mx-0
              v-icon mdi-code-braces
          span {{$t('editor:markup.insertCodeBlock')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, rounded='0', v-bind='props', disabled).mx-0
              v-icon mdi-library-video
          span {{$t('editor:markup.insertVideoAudio')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p5s(icon, rounded='0', v-bind='props', disabled).mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p6s(icon, rounded='0', v-bind='props', disabled).mx-0
              v-icon mdi-function-variant
          span {{$t('editor:markup.insertMathExpression')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p8s(icon, rounded='0', v-bind='props', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-code-editor
        div(ref='cm')
    v-system-bar.editor-status-bar.editor-code-sysbar(absolute, status, color="grey-darken-3")
      .text-body-small.editor-code-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small Code
        v-spacer
        .text-body-small Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import type { ContentInsertOptions, LineInsertOptions, MultiLineInsertOptions } from './common/editor-types'
import { TextEditor, type TextEditorHandle, type TextPosition } from './common/text-editor'
import { html } from '@codemirror/lang-html'


// ========================================
// Vue Component
// ========================================

export default defineComponent({
  data() {
    return {
      cm: null as TextEditorHandle | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      helpShown: false
    }
  },
  computed: {
    isMobile() {
      return this.$vuetify.display.smAndDown
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
  methods: {
    toggleModal(key: string) {
      this.activeModal = (this.activeModal === key) ? '' : key
      this.helpShown = false
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
          let img = `<img src="${opts.path}" alt="${opts.text}"`
          if (opts.align && opts.align !== '') {
            img += ` class="align-${opts.align}"`
          }
          img += ` />`
          this.insertAtCursor({
            content: img
          })
          break
        }
        case 'BINARY':
          this.insertAtCursor({
            content: `<a href="${opts.path}" title="${opts.text}">${opts.text}</a>`
          })
          break
      }
    },
    closeAllModal() {
      this.activeModal = ''
      this.helpShown = false
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
        const replacement = _.startsWith(lineContent, content) ? lineContent.substring(content.length) : content + lineContent
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
      this.$el.requestFullscreen?.()
    },
    refresh() {
      this.$nextTick(() => this.editor().requestMeasure())
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'code'

    if (this.mode === 'create') {
      wikiStore.editor.content = '<h1>Title</h1>\n\n<p>Some text here</p>'
    }

    const cm = new TextEditor({
      parent: this.$refs.cm as HTMLElement,
      value: wikiStore.editor.content,
      language: html(),
      onChange: value => {
        wikiStore.editor.content = value
      },
      onCursor: position => this.positionSync(position)
    })
    this.cm = cm

    // Render initial preview

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
$editor-height: calc(100vh - 64px - 24px);
$editor-height-mobile: calc(100vh - 56px - 16px);

.editor-code {
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


}
</style>

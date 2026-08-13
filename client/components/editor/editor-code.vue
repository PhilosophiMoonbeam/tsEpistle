<template lang='pug'>
  .editor-code
    .editor-code-main
      .editor-code-sidebar
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInLeft(icon, tile, v-bind='props', dark, disabled).mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, tile, v-bind='props', dark, @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p2s(icon, tile, v-bind='props', dark, @click='toggleModal(`editorModalBlocks`)', disabled).mx-0
              v-icon(:color='activeModal === `editorModalBlocks` ? `teal` : ``') mdi-view-dashboard-outline
          span {{$t('editor:markup.insertBlock')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p3s(icon, tile, v-bind='props', dark, disabled).mx-0
              v-icon mdi-code-braces
          span {{$t('editor:markup.insertCodeBlock')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p4s(icon, tile, v-bind='props', dark, disabled).mx-0
              v-icon mdi-library-video
          span {{$t('editor:markup.insertVideoAudio')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p5s(icon, tile, v-bind='props', dark, disabled).mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        v-tooltip(right, color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p6s(icon, tile, v-bind='props', dark, disabled).mx-0
              v-icon mdi-function-variant
          span {{$t('editor:markup.insertMathExpression')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(right, color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p8s(icon, tile, v-bind='props', dark, @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-code-editor
        textarea(ref='cm')
    v-system-bar.editor-code-sysbar(dark, status, color='grey darken-3')
      .caption.editor-code-sysbar-locale {{locale.toUpperCase()}}
      .caption.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .caption Code
        v-spacer
        .caption Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import type { ContentInsertOptions, LineInsertOptions, MultiLineInsertOptions } from './common/editor-types'

// ========================================
// IMPORTS
// ========================================

// Code Mirror
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'

// Language
import 'codemirror/mode/htmlmixed/htmlmixed.js'

// Addons
import 'codemirror/addon/selection/active-line.js'
import 'codemirror/addon/display/fullscreen.js'
import 'codemirror/addon/display/fullscreen.css'
import 'codemirror/addon/selection/mark-selection.js'
import 'codemirror/addon/search/searchcursor.js'

// ========================================
// INIT
// ========================================

// Platform detection
// const CtrlKey = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'

// ========================================
// Vue Component
// ========================================

export default defineComponent({
  data() {
    return {
      cm: null as CodeMirror.EditorFromTextArea | null,
      cursorPos: { ch: 0, line: 1 } as CodeMirror.Position,
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
    editor(): CodeMirror.EditorFromTextArea {
      if (!this.cm) {
        throw new Error('CodeMirror editor is not initialized')
      }
      return this.cm
    },
    /**
     * Insert content at cursor
     */
    insertAtCursor({ content }: ContentInsertOptions) {
      const doc = this.editor().getDoc()
      doc.replaceRange(content, doc.getCursor('head'))
    },
    /**
     * Insert content after current line
     */
    insertAfter({ content, newLine }: LineInsertOptions) {
      const doc = this.editor().getDoc()
      const line = doc.getCursor('to').line
      doc.replaceRange(newLine ? `\n${content}\n` : content, { line, ch: doc.getLine(line).length + 1 })
    },
    /**
     * Insert content before current line
     */
    insertBeforeEachLine({ content, after }: MultiLineInsertOptions) {
      const doc = this.editor().getDoc()
      let lines: number[] = []
      if (!doc.somethingSelected()) {
        lines.push(doc.getCursor('head').line)
      } else {
        lines = _.flatten(doc.listSelections().map((selection: CodeMirror.Range) => {
          const range = Math.abs(selection.anchor.line - selection.head.line) + 1
          const lowestLine = selection.anchor.line > selection.head.line ? selection.head.line : selection.anchor.line
          return _.times(range, offset => offset + lowestLine)
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
      if (after) {
        const line = lines[lines.length - 1]
        doc.replaceRange(`\n${after}\n`, { line, ch: doc.getLine(line).length + 1 })
      }
    },
    /**
     * Update cursor state
     */
    positionSync(cm: CodeMirror.Editor) {
      this.cursorPos = cm.getCursor('head')
    },
    toggleFullscreen () {
      this.editor().setOption('fullScreen', true)
    },
    refresh() {
      this.$nextTick(() => {
        this.editor().refresh()
      })
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'code'

    if (this.mode === 'create') {
      wikiStore.editor.content = '<h1>Title</h1>\n\n<p>Some text here</p>'
    }

    // Initialize CodeMirror

    const cm = CodeMirror.fromTextArea(this.$refs.cm as HTMLTextAreaElement, {
      tabSize: 2,
      mode: 'text/html',
      theme: 'wikijs-dark',
      lineNumbers: true,
      lineWrapping: true,
      line: true,
      styleActiveLine: true,
      highlightSelectionMatches: {
        annotateScrollbar: true
      },
      viewportMargin: 50,
      inputStyle: 'contenteditable',
      allowDropFileTypes: ['image/jpg', 'image/png', 'image/svg', 'image/jpeg', 'image/gif']
    } as CodeMirror.EditorConfiguration)
    this.cm = cm
    cm.setValue(wikiStore.editor.content)
    cm.on('change', (changedEditor: CodeMirror.Editor) => {
      wikiStore.editor.content = changedEditor.getValue()
    })
    if (this.$vuetify.display.mdAndUp) {
      cm.setSize(null, 'calc(100vh - 64px - 24px)')
    } else {
      cm.setSize(null, 'calc(100vh - 56px - 16px)')
    }

    // Set Keybindings

    const keyBindings: CodeMirror.KeyMap = {
      F11(editor: CodeMirror.Editor) {
        editor.setOption('fullScreen', !editor.getOption('fullScreen'))
      },
      Esc(editor: CodeMirror.Editor) {
        if (editor.getOption('fullScreen')) editor.setOption('fullScreen', false)
      }
    }
    cm.setOption('extraKeys', keyBindings)

    // Handle cursor movement

    cm.on('cursorActivity', (activeEditor: CodeMirror.Editor) => {
      this.positionSync(activeEditor)
    })

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
    this.cm?.toTextArea()
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
  // CODE MIRROR
  // ==========================================

  .CodeMirror {
    height: auto;

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

  .cm-s-wikijs-dark.CodeMirror {
    background: darken(mc('grey','900'), 3%);
    color: #e0e0e0;
  }
  .cm-s-wikijs-dark div.CodeMirror-selected {
    background: mc('blue','800');
  }
  .cm-s-wikijs-dark .cm-matchhighlight {
    background: mc('blue','800');
  }
  .cm-s-wikijs-dark .CodeMirror-line::selection, .cm-s-wikijs-dark .CodeMirror-line > span::selection, .cm-s-wikijs-dark .CodeMirror-line > span > span::selection {
    background: mc('amber', '500');
  }
  .cm-s-wikijs-dark .CodeMirror-line::-moz-selection, .cm-s-wikijs-dark .CodeMirror-line > span::-moz-selection, .cm-s-wikijs-dark .CodeMirror-line > span > span::-moz-selection {
    background: mc('amber', '500');
  }
  .cm-s-wikijs-dark .CodeMirror-gutters {
    background: darken(mc('grey','900'), 6%);
    border-right: 1px solid mc('grey','900');
  }
  .cm-s-wikijs-dark .CodeMirror-guttermarker {
    color: #ac4142;
  }
  .cm-s-wikijs-dark .CodeMirror-guttermarker-subtle {
    color: #505050;
  }
  .cm-s-wikijs-dark .CodeMirror-linenumber {
    color: mc('grey','800');
  }
  .cm-s-wikijs-dark .CodeMirror-cursor {
    border-left: 1px solid #b0b0b0;
  }
  .cm-s-wikijs-dark span.cm-comment {
    color: mc('orange','800');
  }
  .cm-s-wikijs-dark span.cm-atom {
    color: #aa759f;
  }
  .cm-s-wikijs-dark span.cm-number {
    color: #aa759f;
  }
  .cm-s-wikijs-dark span.cm-property, .cm-s-wikijs-dark span.cm-attribute {
    color: #90a959;
  }
  .cm-s-wikijs-dark span.cm-keyword {
    color: #ac4142;
  }
  .cm-s-wikijs-dark span.cm-string {
    color: #f4bf75;
  }
  .cm-s-wikijs-dark span.cm-variable {
    color: #90a959;
  }
  .cm-s-wikijs-dark span.cm-variable-2 {
    color: #6a9fb5;
  }
  .cm-s-wikijs-dark span.cm-def {
    color: #d28445;
  }
  .cm-s-wikijs-dark span.cm-bracket {
    color: #e0e0e0;
  }
  .cm-s-wikijs-dark span.cm-tag {
    color: #ac4142;
  }
  .cm-s-wikijs-dark span.cm-link {
    color: #aa759f;
  }
  .cm-s-wikijs-dark span.cm-error {
    background: #ac4142;
    color: #b0b0b0;
  }
  .cm-s-wikijs-dark .CodeMirror-activeline-background {
    background: mc('grey','900');
  }
  .cm-s-wikijs-dark .CodeMirror-matchingbracket {
    text-decoration: underline;
    color: white !important;
  }

}
</style>

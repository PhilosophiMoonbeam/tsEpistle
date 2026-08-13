<template lang='pug'>
  .editor-asciidoc
    v-toolbar.editor-asciidoc-toolbar(dense, color='primary', dark, flat, style='overflow-x: hidden;')
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
            v-btn.animated.fadeIn.wait-p1s(icon, tile, v-bind='props', @click='toggleMarkup({ start: `__` })').mx-0
              v-icon mdi-format-italic
          span {{$t('editor:markup.italic')}}
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
            v-list-item(@click='insertBeforeEachLine({ content: `NOTE: `})')
              div.v-list-item-action
                v-icon(color='blue') mdi-alpha-n-box-outline
              v-list-item-title {{'Note blockquote'}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `TIP: `})')
              div.v-list-item-action
                v-icon(color='success') mdi-alpha-t-box-outline
              v-list-item-title {{'Tip blockquote'}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `WARNING: `})')
              div.v-list-item-action
                v-icon(color='warning') mdi-alpha-w-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteWarning')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `CAUTION: `})')
              div.v-list-item-action
                v-icon(color='purple') mdi-alpha-c-box-outline
              v-list-item-title {{'Caution blockquote'}}
            v-list-item(@click='insertBeforeEachLine({ content: `IMPORTANT: `})')
              div.v-list-item-action
                v-icon(color='error') mdi-alpha-i-box-outline
              v-list-item-title {{'Important blockquote'}}
            v-divider
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(bottom, color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p2s(icon, tile, v-bind='props', @click='previewShown = !previewShown').mx-0
                v-icon mdi-book-open-outline
            span {{$t('editor:markup.togglePreviewPane')}}

    .editor-asciidoc-main
      .editor-asciidoc-sidebar
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
            v-btn.mt-3.animated.fadeInLeft.wait-p5s(icon, tile, v-bind='props', dark, @click='toggleModal(`editorModalDrawio`)').mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(right, color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p8s(icon, tile, v-bind='props', dark, @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-asciidoc-editor
        textarea(ref='cm')
      transition(name='editor-asciidoc-preview')
        .editor-asciidoc-preview(v-if='previewShown')
          .editor-asciidoc-preview-content.contents(ref='editorPreviewContainer')
            div(
              ref='editorPreview'
              v-html='previewHTML'
              )

    v-system-bar.editor-asciidoc-sysbar(dark, status, color='grey darken-3')
      .caption.editor-asciidoc-sysbar-locale {{locale.toUpperCase()}}
      .caption.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .caption AsciiDoc
        v-spacer
        .caption Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
/* global siteLangs, siteConfig */
import { defineComponent } from 'vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import type { Element } from 'domhandler'
import type { ContentInsertOptions, LineInsertOptions, MarkupOptions, MultiLineInsertOptions, PageLinkTarget } from './common/editor-types'
import DOMPurify from 'dompurify'

// ========================================
// IMPORTS
// ========================================

// Code Mirror
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'

// Language
import 'codemirror-asciidoc'

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
import cmFold from './common/cmFold'

// ========================================
// INIT
// ========================================
const asciidoctor = require('asciidoctor')()
const cheerio = require('cheerio')

// Platform detection
const CtrlKey = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'

// ========================================
// HELPER FUNCTIONS
// ========================================

cmFold.register('asciidoc')

type DiagramLineHandle = CodeMirror.LineHandle & {
  height: number
  lineNo(): number
}

type DiagramMarker = CodeMirror.TextMarker & {
  __kind?: 'diagram'
}

interface MarkerOptions {
  kind: 'diagram'
  from: CodeMirror.Position
  to: CodeMirror.Position
  text: string
  action: (event: MouseEvent) => void
}

// ========================================
// Vue Component
// ========================================

export default defineComponent({
  data() {
    return {
      cm: null as CodeMirror.EditorFromTextArea | null,
      cursorPos: { ch: 0, line: 1 } as CodeMirror.Position,
      previewShown: true,
      insertLinkDialog: false,
      helpShown: false,
      previewHTML: ''
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
  methods: {
    toggleModal(key: string) {
      this.activeModal = this.activeModal === key ? '' : key
      this.helpShown = false
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
          const doc = cm.getDoc()
          const selectionStart = doc.getCursor('from').line
          const selectionEnd = doc.getCursor('to').line + 1
          doc.replaceSelection('```diagram\n' + opts.text + '\n```\n', 'start')
          this.processMarkers(selectionStart, selectionEnd)
          break
        }
      }
    },
    closeAllModal() {
      this.activeModal = ''
      this.helpShown = false
    },
    editor(): CodeMirror.EditorFromTextArea {
      if (!this.cm) throw new Error('CodeMirror editor is not initialized')
      return this.cm
    },
    onCmInput: _.debounce(function (this: { processContent: (content: string) => void }, newContent: string) {
      this.processContent(newContent)
    }, 600),
    processContent(newContent: string) {
      const cm = this.editor()
      this.processMarkers(cm.firstLine(), cm.lastLine())
      const html = asciidoctor.convert(newContent, {
        standalone: false,
        safe: 'safe',
        attributes: { showtitle: true, icons: 'font' }
      })
      const $ = cheerio.load(html, { decodeEntities: true })
      $('pre.highlight > code.language-diagram').each((_index: number, element: Element) => {
        const diagramContent = Buffer.from($(element).html(), 'base64').toString()
        $(element).parent().replaceWith(`<pre class="diagram">${diagramContent}</div>`)
      })
      this.previewHTML = DOMPurify.sanitize($.html(), {
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true }
      })
    },
    insertAtCursor({ content }: ContentInsertOptions) {
      const doc = this.editor().getDoc()
      doc.replaceRange(content, doc.getCursor('head'))
    },
    insertAfter({ content, newLine }: LineInsertOptions) {
      const doc = this.editor().getDoc()
      const line = doc.getCursor('to').line
      doc.replaceRange(newLine ? `\n${content}\n` : content, { line, ch: doc.getLine(line).length + 1 })
    },
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
        if (_.startsWith(lineContent, content)) lineContent = lineContent.substring(content.length)
        doc.replaceRange(content + lineContent, { line, ch: 0 }, { line, ch: lineLength })
      })
      if (after) {
        const line = lines[lines.length - 1]
        doc.replaceRange(`\n${after}\n`, { line, ch: doc.getLine(line).length + 1 })
      }
    },
    positionSync(cm: CodeMirror.Editor) {
      this.cursorPos = cm.getCursor('head')
    },
    toggleMarkup({ start, end = start }: MarkupOptions) {
      const doc = this.editor().getDoc()
      if (!doc.somethingSelected()) {
        return wikiStore.showNotification({
          message: this.$t('editor:markup.noSelectionError'),
          style: 'warning',
          icon: 'warning'
        })
      }
      doc.replaceSelections(doc.getSelections().map((selection: string) => start + selection + end))
    },
    setHeaderLine(level: number) {
      const doc = this.editor().getDoc()
      const line = doc.getCursor('head').line
      let content = doc.getLine(line)
      const length = content.length
      if (_.startsWith(content, '=')) content = content.replace(/^(=+ )/, '')
      content = _.times(level, () => '=').join('') + ` ` + content
      doc.replaceRange(content, { line, ch: 0 }, { line, ch: length })
    },
    toggleFullscreen() {
      this.editor().setOption('fullScreen', true)
    },
    refresh() {
      this.$nextTick(() => this.editor().refresh())
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
    processMarkers(from: number, to: number) {
      const cm = this.editor()
      const doc = cm.getDoc()
      let found: 'diagram' | null = null
      let foundStart = 0
      ;(doc.getAllMarks() as DiagramMarker[]).forEach(marker => {
        if (marker.__kind) marker.clear()
      })
      cm.eachLine(from, to, (handle: CodeMirror.LineHandle) => {
        const line = handle as DiagramLineHandle
        const lineNumber = line.lineNo()
        if (line.text.startsWith('```diagram')) {
          found = 'diagram'
          foundStart = lineNumber
        } else if (line.text === '```' && found === 'diagram') {
          if (lineNumber - foundStart !== 2) return
          this.addMarker({
            kind: 'diagram',
            from: { line: foundStart, ch: 3 },
            to: { line: foundStart, ch: 10 },
            text: 'Edit Diagram',
            action: ((start: number, end: number) => (_event: MouseEvent) => {
              doc.setSelection({ line: start, ch: 0 }, { line: end, ch: 3 })
              try {
                const raw = doc.getLine(end - 1)
                wikiStore.editor.activeModalData = Buffer.from(raw, 'base64').toString()
                this.toggleModal('editorModalDrawio')
              } catch (err) {
                return wikiStore.showNotification({
                  message: 'Failed to process diagram data.',
                  style: 'warning',
                  icon: 'warning'
                })
              }
            })(foundStart, lineNumber)
          })
          if (line.height > 0) cm.foldCode(foundStart)
          found = null
        }
      })
    },
    addMarker({ kind, from, to, text, action }: MarkerOptions) {
      const marker = document.createElement('span')
      marker.appendChild(document.createTextNode(text))
      marker.className = 'CodeMirror-buttonmarker'
      marker.addEventListener('click', action)
      const options = { replacedWith: marker, __kind: kind } as CodeMirror.TextMarkerOptions & { __kind: 'diagram' }
      this.editor().markText(from, to, options)
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'asciidoc'

    if (this.mode === 'create') {
      wikiStore.editor.content = '== header\n\ncontent'
    }

    // Initialize CodeMirror

    const cm = CodeMirror.fromTextArea(this.$refs.cm as HTMLTextAreaElement, {
      tabSize: 2,
      mode: 'asciidoc',
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
      allowDropFileTypes: ['image/jpg', 'image/png', 'image/svg', 'image/jpeg', 'image/gif'],
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']
    } as CodeMirror.EditorConfiguration)
    this.cm = cm
    cm.setValue(wikiStore.editor.content)
    cm.on('change', (changedEditor: CodeMirror.Editor) => {
      wikiStore.editor.content = changedEditor.getValue()
      this.onCmInput(wikiStore.editor.content)
    })
    if (this.$vuetify.display.mdAndUp) {
      cm.setSize(null, 'calc(100vh - 137px)')
    } else {
      cm.setSize(null, 'calc(100vh - 112px - 16px)')
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
    keyBindings[`${CtrlKey}-B`] = () => {
      this.toggleMarkup({ start: '**' })
    }
    keyBindings[`${CtrlKey}-I`] = () => {
      this.toggleMarkup({ start: '__' })
    }

    cm.setOption('extraKeys', keyBindings)

    // Handle cursor movement

    cm.on('cursorActivity', (activeEditor: CodeMirror.Editor) => {
      this.positionSync(activeEditor)
    })

    // Render initial preview
    this.processContent(wikiStore.editor.content)

    onEditorInsert(this.handleEditorInsert)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount() {
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    this.onCmInput.cancel()
    this.cm?.toTextArea()
    this.cm = null
  }
})
</script>

<style lang='scss'>
$editor-ascii-height: calc(100vh - 137px);
$editor-ascii-height-mobile: calc(100vh - 112px - 16px);

.editor-asciidoc {
  &-main {
    display: flex;
    width: 100%;
  }

  &-editor {
    background-color: darken(mc('grey', '900'), 4.5%);
    flex: 1 1 50%;
    display: block;
    height: $editor-ascii-height;
    position: relative;

    @include until($tablet) {
      height: $editor-ascii-height-mobile;
    }
  }

  &-preview {
    flex: 1 1 50%;
    background-color: mc('grey', '100');
    position: relative;
    height: $editor-ascii-height;
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
      height: $editor-ascii-height;
      overflow-y: scroll;
      padding: 0;
      width: calc(100% + 17px);
      // -ms-overflow-style: none;

      // &::-webkit-scrollbar {
      //   width: 0px;
      //   background: transparent;
      // }

      @include until($tablet) {
        height: $editor-ascii-height-mobile;
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
</style>

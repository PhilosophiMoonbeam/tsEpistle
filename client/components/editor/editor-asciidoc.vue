<template lang='pug'>
  .editor-asciidoc
    v-toolbar.editor-asciidoc-toolbar(density="compact", color='primary', flat, style='overflow-x: hidden;', role='toolbar', aria-label='Formatting tools')
      template(v-if='isModalShown')
        v-spacer
        v-btn.animated.fadeInRight(variant="text", @click='closeAllModal')
          v-icon(start) mdi-arrow-left-circle
          span {{$t('editor:backToEditor')}}
      template(v-else)
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn(icon, rounded='0', v-bind='props', aria-label='Bold', @click='toggleMarkup({ start: `**` })').mx-0
              v-icon mdi-format-bold
          span {{$t('editor:markup.bold')}}
        v-tooltip(location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p1s(icon, rounded='0', v-bind='props', aria-label='Italic', @click='toggleMarkup({ start: `__` })').mx-0
              v-icon mdi-format-italic
          span {{$t('editor:markup.italic')}}
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
            v-btn.animated.fadeIn.wait-p4s(icon, rounded='0', v-bind='props', aria-label='Subscript', @click='toggleMarkup({ start: `~` })').mx-0
              v-icon mdi-format-subscript
          span {{$t('editor:markup.subscript')}}
        v-tooltip(v-if='$vuetify.display.mdAndUp', location="bottom", color='primary')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p5s(icon, rounded='0', v-bind='props', aria-label='Superscript', @click='toggleMarkup({ start: `^` })').mx-0
              v-icon mdi-format-superscript
          span {{$t('editor:markup.superscript')}}
        v-menu(v-if='$vuetify.display.mdAndUp', open-on-hover)
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeIn.wait-p6s(icon, rounded='0', v-bind='props', aria-label='Block formatting').mx-0
              v-icon mdi-alpha-t-box-outline
          v-list.py-0
            v-list-item(@click='insertBeforeEachLine({ content: `> `})')
              template(v-slot:append)
                v-icon mdi-alpha-t-box-outline
              v-list-item-title {{$t('editor:markup.blockquote')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `NOTE: `})')
              template(v-slot:append)
                v-icon(color='blue') mdi-alpha-n-box-outline
              v-list-item-title {{'Note blockquote'}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `TIP: `})')
              template(v-slot:append)
                v-icon(color='success') mdi-alpha-t-box-outline
              v-list-item-title {{'Tip blockquote'}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `WARNING: `})')
              template(v-slot:append)
                v-icon(color='warning') mdi-alpha-w-box-outline
              v-list-item-title {{$t('editor:markup.blockquoteWarning')}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `CAUTION: `})')
              template(v-slot:append)
                v-icon(color='purple') mdi-alpha-c-box-outline
              v-list-item-title {{'Caution blockquote'}}
            v-divider
            v-list-item(@click='insertBeforeEachLine({ content: `IMPORTANT: `})')
              template(v-slot:append)
                v-icon(color='error') mdi-alpha-i-box-outline
              v-list-item-title {{'Important blockquote'}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeIn.wait-p2s(icon, rounded='0', v-bind='props', :aria-label='previewShown ? `Show editor` : `Show preview`', :aria-pressed='previewShown', @click='previewShown = !previewShown').mx-0
                v-icon {{ previewShown ? 'mdi-pencil-outline' : 'mdi-book-open-outline' }}
            span {{$t('editor:markup.togglePreviewPane')}}
        template(v-else)
          v-spacer
          v-tooltip(location="bottom", color='primary')
            template(v-slot:activator='{ props }')
              v-btn.mx-0(
                icon
                rounded='0'
                v-bind='props'
                :aria-label='previewShown ? `Show editor` : `Show preview`'
                :aria-pressed='previewShown'
                @click='previewShown = !previewShown'
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
              v-divider
              v-list-item(@click='toggleMarkup({ start: `~` })')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-subscript
                v-list-item-title {{$t('editor:markup.subscript')}}
              v-list-item(@click='toggleMarkup({ start: `^` })')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-superscript
                v-list-item-title {{$t('editor:markup.superscript')}}
              v-list-item(@click='insertBeforeEachLine({ content: `> `})')
                template(v-slot:prepend)
                  v-icon.mr-3 mdi-format-quote-open
                v-list-item-title {{$t('editor:markup.blockquote')}}

    .editor-asciidoc-main
      .editor-asciidoc-sidebar
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.animated.fadeInLeft(icon, rounded='0', v-bind='props', aria-label='Insert link', @click='insertLink').mx-0
              v-icon mdi-link-plus
          span {{$t('editor:markup.insertLink')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p1s(icon, rounded='0', v-bind='props', aria-label='Insert assets', @click='toggleModal(`editorModalMedia`)').mx-0
              v-icon(:color='activeModal === `editorModalMedia` ? `teal` : ``') mdi-folder-multiple-image
          span {{$t('editor:markup.insertAssets')}}
        v-tooltip(location="right", color='teal')
          template(v-slot:activator='{ props }')
            v-btn.mt-3.animated.fadeInLeft.wait-p5s(icon, rounded='0', v-bind='props', aria-label='Insert diagram', @click='toggleModal(`editorModalDrawio`)').mx-0
              v-icon mdi-chart-multiline
          span {{$t('editor:markup.insertDiagram')}}
        template(v-if='$vuetify.display.mdAndUp')
          v-spacer
          v-tooltip(location="right", color='teal')
            template(v-slot:activator='{ props }')
              v-btn.mt-3.animated.fadeInLeft.wait-p8s(icon, rounded='0', v-bind='props', aria-label='Toggle distraction-free mode', @click='toggleFullscreen').mx-0
                v-icon mdi-arrow-expand-all
            span {{$t('editor:markup.distractionFreeMode')}}
      .editor-asciidoc-editor(:class='{ "is-mobile-hidden": previewShown && $vuetify.display.smAndDown }')
        div(ref='cm')
      transition(name='editor-asciidoc-preview')
        .editor-asciidoc-preview(v-if='previewShown')
          .editor-asciidoc-preview-content.contents(ref='editorPreviewContainer', :aria-busy='previewLoading')
            v-alert(v-if='previewError', type='error', variant='tonal', density='compact', role='status')
              span {{previewError}}
              v-btn.ml-2(size='small', variant='text', @click='retryPreview') Retry
            div(ref='editorPreview', v-html='previewHTML')

    v-system-bar.editor-status-bar.editor-asciidoc-sysbar(absolute, status, color="grey-darken-3")
      .text-body-small.editor-asciidoc-sysbar-locale {{locale.toUpperCase()}}
      .editor-status-path(title='/' + path) /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small AsciiDoc
        v-spacer
        .text-body-small Ln {{cursorPos.line + 1}}, Col {{cursorPos.ch + 1}}
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')</template>

<script lang='ts'>
/* global siteLangs, siteConfig */
import { defineComponent } from 'vue'
import { useDisplay } from 'vuetify'
import _ from 'lodash'
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

// ========================================
// Vue Component
// ========================================

export default defineComponent({
  setup() {
    const { mdAndUp } = useDisplay()
    return { mdAndUp }
  },
  data() {
    return {
      cm: null as TextEditorHandle | null,
      debouncedProcessContent: null as ReturnType<typeof _.debounce> | null,
      cursorPos: { ch: 0, line: 1 } as TextPosition,
      previewShown: this.mdAndUp,
      insertLinkDialog: false,
      helpShown: false,
      previewHTML: '',
      previewLoading: false,
      previewError: '',
      previewRequestId: 0
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
      this.helpShown = false
    },
    editor(): TextEditorHandle {
      if (!this.cm) throw new Error('CodeMirror editor is not initialized')
      return this.cm
    },
    async processContent(newContent: string) {
      const requestId = ++this.previewRequestId
      this.previewLoading = true
      this.previewError = ''
      try {
        const cm = this.editor()
        this.processMarkers(0, cm.lineCount)
        const html = await convert(newContent, {
          standalone: false,
          safe: 'safe',
          attributes: { showtitle: true, icons: 'font' }
        })
        if (requestId !== this.previewRequestId) return
        const $ = cheerio.load(html, { decodeEntities: true })
        $('pre.highlight > code.language-diagram').each((_index: number, element: Element) => {
          const diagramContent = decodeBase64Text($(element).html() ?? '')
          $(element).parent().replaceWith(`<pre class="diagram">${diagramContent}</div>`)
        })
        this.previewHTML = DOMPurify.sanitize($.html(), {
          ADD_TAGS: ['foreignObject'],
          HTML_INTEGRATION_POINTS: { foreignobject: true }
        })
      } catch (err) {
        if (requestId === this.previewRequestId) {
          this.previewError = err instanceof Error ? err.message : 'Preview could not be rendered.'
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
      this.$el.requestFullscreen?.()
    },
    refresh() {
      this.$nextTick(() => this.editor().requestMeasure())
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
          if (line - start === 2) {
            markers.push({
              kind: 'diagram',
              from: { line: start, ch: 3 },
              to: { line: start, ch: 10 },
              text: 'Edit Diagram',
              action: () => {
                editor.setSelection({ line: start, ch: 0 }, { line, ch: 3 })
                try {
                  wikiStore.editor.activeModalData = decodeBase64Text(editor.getLine(line - 1))
                  this.toggleModal('editorModalDrawio')
                } catch {
                  wikiStore.showNotification({
                    message: 'Failed to process diagram data.',
                    style: 'warning',
                    icon: 'warning'
                  })
                }
              }
            })
            editor.foldRange({ line: start, ch: editor.getLine(start).length }, { line, ch: 0 })
          }
          foundStart = null
        }
      }
      editor.setMarkers(markers)
    }
  },
  mounted() {
    wikiStore.editor.editorKey = 'asciidoc'

    if (this.mode === 'create') {
      wikiStore.editor.content = '== header\n\ncontent'
    }

    this.debouncedProcessContent = _.debounce((newContent: string) => {
      void this.processContent(newContent)
    }, 600)
    const container = this.$refs.cm as HTMLElement
    const cm = new TextEditor({
      parent: container,
      value: wikiStore.editor.content,
      direction: siteConfig.rtl ? 'rtl' : 'ltr',
      extensions: [
        keymap.of([
          { key: 'F11', run: () => { this.toggleFullscreen(); return true } },
          { key: 'Mod-b', run: () => { this.toggleMarkup({ start: '**' }); return true } },
          { key: 'Mod-i', run: () => { this.toggleMarkup({ start: '__' }); return true } }
        ])
      ],
      onChange: value => {
        wikiStore.editor.content = value
        this.debouncedProcessContent?.(value)
      },
      onCursor: position => this.positionSync(position)
    })
    this.cm = cm

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
    background-color: darken(mc('grey', '900'), 4.5%);
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
    }
  }

  &-preview {
    flex: 1 1 50%;
    background-color: mc('grey', '100');
    position: relative;
    height: $editor-ascii-height;
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

}
</style>

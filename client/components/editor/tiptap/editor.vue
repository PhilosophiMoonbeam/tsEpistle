<template lang='pug'>
  .editor-tiptap(ref='root')
    v-toolbar.editor-tiptap-toolbar(density='compact', color='grey-lighten-2', flat)
      v-btn(icon, title='Undo', aria-label='Undo', :disabled='!canUndo', @click='editor?.chain().focus().undo().run()')
        v-icon mdi-undo
      v-btn(icon, title='Redo', aria-label='Redo', :disabled='!canRedo', @click='editor?.chain().focus().redo().run()')
        v-icon mdi-redo
      v-divider(vertical)
      v-menu
        template(v-slot:activator='{ props }')
          v-btn(v-bind='props', title='Text style', aria-label='Text style')
            v-icon(start) mdi-format-header-pound
            | Style
        v-list(density='compact')
          v-list-item(@click='setParagraph') Paragraph
          v-list-item(v-for='level in 6', :key='level', @click='setHeading(level)') Heading {{level}}
      v-btn(icon, title='Bold', aria-label='Bold', :color='activeColor(`bold`)', @click='editor?.chain().focus().toggleBold().run()')
        v-icon mdi-format-bold
      v-btn(icon, title='Italic', aria-label='Italic', :color='activeColor(`italic`)', @click='editor?.chain().focus().toggleItalic().run()')
        v-icon mdi-format-italic
      v-btn(v-if='format === `html`', icon, title='Underline', aria-label='Underline', :color='activeColor(`underline`)', @click='editor?.chain().focus().toggleUnderline().run()')
        v-icon mdi-format-underline
      v-btn(icon, title='Strikethrough', aria-label='Strikethrough', :color='activeColor(`strike`)', @click='editor?.chain().focus().toggleStrike().run()')
        v-icon mdi-format-strikethrough
      template(v-if='format === `markdown`')
        v-btn(icon, title='Highlight', aria-label='Highlight', :color='activeColor(`highlight`)', @click='editor?.chain().focus().toggleHighlight().run()')
          v-icon mdi-format-color-highlight
        v-btn(icon, title='Subscript', aria-label='Subscript', :color='activeColor(`subscript`)', @click='editor?.chain().focus().toggleSubscript().run()')
          v-icon mdi-format-subscript
        v-btn(icon, title='Superscript', aria-label='Superscript', :color='activeColor(`superscript`)', @click='editor?.chain().focus().toggleSuperscript().run()')
          v-icon mdi-format-superscript
        v-btn(icon, title='Keyboard key', aria-label='Keyboard key', :color='activeColor(`keyboard`)', @click='editor?.chain().focus().toggleMark(`keyboard`).run()')
          v-icon mdi-keyboard-outline
        v-btn(icon, title='Inline code', aria-label='Inline code', :color='activeColor(`code`)', @click='editor?.chain().focus().toggleCode().run()')
          v-icon mdi-code-tags
      v-btn(icon, title='Link to page', aria-label='Link to page', :color='activeColor(`link`)', @click='insertLink')
        v-icon mdi-link-variant
      v-divider(vertical)
      v-btn(icon, title='Bulleted list', aria-label='Bulleted list', :color='activeColor(`bulletList`)', @click='editor?.chain().focus().toggleBulletList().run()')
        v-icon mdi-format-list-bulleted
      v-btn(icon, title='Numbered list', aria-label='Numbered list', :color='activeColor(`orderedList`)', @click='editor?.chain().focus().toggleOrderedList().run()')
        v-icon mdi-format-list-numbered
      v-btn(v-if='format === `markdown`', icon, title='Task list', aria-label='Task list', :color='activeColor(`taskList`)', @click='editor?.chain().focus().toggleTaskList().run()')
        v-icon mdi-format-list-checks
      v-btn(icon, title='Decrease indent', aria-label='Decrease indent', @click='liftListItem')
        v-icon mdi-format-indent-decrease
      v-btn(icon, title='Increase indent', aria-label='Increase indent', @click='sinkListItem')
        v-icon mdi-format-indent-increase
      v-divider(vertical)
      v-btn(icon, title='Block quote', aria-label='Block quote', :color='activeColor(`blockquote`)', @click='editor?.chain().focus().toggleBlockquote().run()')
        v-icon mdi-format-quote-open
      v-menu
        template(v-slot:activator='{ props }')
          v-btn(icon, v-bind='props', title='Code block', aria-label='Code block', :color='activeColor(`codeBlock`)')
            v-icon mdi-code-braces
        v-list(density='compact')
          v-list-item(v-for='language in codeBlockLanguages', :key='language.value', @click='setCodeBlock(language.value)') {{language.label}}
      v-btn(icon, title='Horizontal rule', aria-label='Horizontal rule', @click='editor?.chain().focus().setHorizontalRule().run()')
        v-icon mdi-minus
      v-menu
        template(v-slot:activator='{ props }')
          v-btn(icon, v-bind='props', title='Table', aria-label='Table', :color='activeColor(`table`)')
            v-icon mdi-table
        v-list(density='compact')
          v-list-item(@click='insertTable') Insert table
          template(v-if='isActive(`table`)')
            v-list-item(@click='editor?.chain().focus().addColumnAfter().run()') Add column
            v-list-item(@click='editor?.chain().focus().addRowAfter().run()') Add row
            v-list-item(@click='editor?.chain().focus().mergeOrSplit().run()') Merge or split cells
            v-list-item(@click='editor?.chain().focus().deleteTable().run()') Delete table
      template(v-if='format === `html`')
        v-btn(icon, title='Align left', aria-label='Align left', @click='editor?.chain().focus().setTextAlign(`left`).run()')
          v-icon mdi-format-align-left
        v-btn(icon, title='Align center', aria-label='Align center', @click='editor?.chain().focus().setTextAlign(`center`).run()')
          v-icon mdi-format-align-center
        v-btn(icon, title='Align right', aria-label='Align right', @click='editor?.chain().focus().setTextAlign(`right`).run()')
          v-icon mdi-format-align-right
      v-btn(v-if='hasSourceSelection', color='amber-darken-3', title='Edit preserved source', aria-label='Edit preserved source', @click='openSourceDialog')
        v-icon(start) mdi-code-block-tags
        | Edit source
    .editor-tiptap-markdown-tools(v-if='format === `markdown`')
      v-btn.editor-tiptap-extension-trigger(color='teal', rounded='0', @click='toggleExtensionDialog', aria-label='Insert content extension')
        v-icon(start) mdi-qrcode
        | Insert content extension
      v-btn(color='blue-grey', rounded='0', aria-label='Insert admonition', @click='openAdmonitionDialog')
        v-icon(start) mdi-alert-box-outline
        | Insert admonition
      v-btn(color='blue-grey', rounded='0', aria-label='Insert definition list', @click='insertDefinitionList')
        v-icon(start) mdi-format-list-group-plus
        | {{$t('editor:markup.insertDefinitionList')}}
      v-menu(:close-on-content-click='true')
        template(v-slot:activator='{ props }')
          v-btn(v-bind='props', color='blue-grey', rounded='0', aria-label='Insert icon or emoji')
            v-icon(start) mdi-emoticon-outline
            | Icon or emoji
        v-card.editor-tiptap-glyph-menu
          v-card-title Insert icon or emoji
          v-card-text.d-flex.flex-wrap
            v-btn.ma-1(v-for='glyph in glyphs', :key='`${glyph.category}:${glyph.label}`', icon, :aria-label='`Insert ${glyph.label}`', :title='glyph.label', @click='insertGlyph(glyph)') {{glyph.value}}
    editor-content.contents(:editor='editor')
    v-system-bar.editor-status-bar.editor-tiptap-sysbar(absolute, status, color='grey-darken-3')
      .text-body-small.editor-tiptap-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small {{definition.label}} · Tiptap
        v-spacer
        .text-body-small {{$t('editor:ckeditor.stats', { chars: stats.characters, words: stats.words })}}
    editor-conflict(v-model='isConflict', v-if='isConflict')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
    v-dialog(v-model='admonitionDialog', max-width='620', persistent)
      v-card
        v-card-title Insert admonition
        v-card-text
          v-form(@submit.prevent='insertAdmonition')
            v-select(v-model='admonitionKind', :items='admonitionKinds', label='Type')
            v-text-field.mt-3(v-model='admonitionTitle', label='Title', counter='120', required)
            v-textarea.mt-3(v-model='admonitionBody', label='Content', rows='5', auto-grow, counter='5000', required)
            v-alert.mt-3(v-if='admonitionError', type='error', variant='tonal') {{admonitionError}}
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='admonitionDialog = false') Cancel
          v-btn(color='teal', :disabled='!isAdmonitionValid', @click='insertAdmonition') Insert
    v-dialog(v-model='sourceDialog', max-width='760', persistent)
      v-card
        v-card-title Edit preserved {{sourceKind}} source
        v-card-text
          .text-body-small.mb-3 This construct is stored verbatim because it has no lossless rich-text representation.
          v-textarea(v-model='sourceValue', rows='12', auto-grow, spellcheck='false', label='Source')
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='sourceDialog = false') Cancel
          v-btn(color='teal', @click='saveSourceNode') Apply
</template>

<script lang='ts'>
import _ from 'lodash'
import { Editor, type JSONContent } from '@tiptap/core'
import { EditorContent } from '@tiptap/vue-3'
import { defineComponent, markRaw, type PropType } from 'vue'
import { wikiStore } from '@/store/index.ts'
import EditorConflict from './conflict.vue'
import {
  createTiptapExtensions,
  getVisualEditorDefinition,
  getVisualEditorStats,
  serializeVisualEditorData,
  type VisualEditorFormat,
  type VisualEditorStats
} from './editor-config.ts'
import {
  decodeWikiSource,
  encodeWikiSource,
  prepareTiptapHtml,
  prepareTiptapMarkdown
} from './dialect.ts'
import {
  ADMONITION_KINDS,
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  type AdmonitionKind,
  type VisualMarkdownGlyph
} from './visual-markdown-authoring.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../../helpers/editor-insert-events'
import { onEditorLinkToPage, offEditorLinkToPage } from '../../../helpers/editor-link-events'
import { contentExtensionFenceBody } from '../../../helpers/content-extension-insertion'

/* global siteLangs */

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>
type EditorMode = 'create' | 'update'
type EditorHost = HTMLElement & { __wikiEditor?: Editor }
type SourceNodeName = 'wikiSourceBlock' | 'wikiSourceInline'

type InsertLinkPayload = {
  id: number
  locale: string
  path: string
}

const CODE_BLOCK_LANGUAGES = [
  { value: 'plaintext', label: 'Plain text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'diagram', label: 'Draw.io diagram' },
  { value: 'mermaid', label: 'Mermaid diagram' },
  { value: 'plantuml', label: 'PlantUML diagram' },
  { value: 'kroki', label: 'Kroki diagram' },
  { value: 'wiki-extension', label: 'Wiki content extension' }
] as const

export default defineComponent({
  components: {
    EditorConflict,
    EditorContent
  },
  props: {
    format: {
      type: String as PropType<VisualEditorFormat>,
      required: true
    },
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    }
  },
  data () {
    return {
      editor: null as Editor | null,
      syncContent: null as _.DebouncedFunc<(editor: Editor) => void> | null,
      stats: { characters: 0, words: 0 } as VisualEditorStats,
      toolbarVersion: 0,
      isConflict: false,
      insertLinkDialog: false,
      admonitionDialog: false,
      admonitionKind: 'NOTE' as AdmonitionKind,
      admonitionTitle: '',
      admonitionBody: '',
      admonitionError: '',
      sourceDialog: false,
      sourceNodeName: null as SourceNodeName | null,
      sourceKind: '',
      sourceValue: '',
      admonitionKinds: ADMONITION_KINDS,
      glyphs: VISUAL_MARKDOWN_GLYPHS,
      codeBlockLanguages: CODE_BLOCK_LANGUAGES
    }
  },
  computed: {
    definition () {
      return getVisualEditorDefinition(this.format)
    },
    locale (): string {
      return wikiStore.page.locale
    },
    path (): string {
      return wikiStore.page.path
    },
    mode (): EditorMode {
      return wikiStore.editor.mode as EditorMode
    },
    activeModal: {
      get (): string {
        return wikiStore.editor.activeModal
      },
      set (value: string) {
        wikiStore.editor.activeModal = value
      }
    },
    isAdmonitionValid (): boolean {
      const titleLength = this.admonitionTitle.trim().length
      const bodyLength = this.admonitionBody.trim().length
      return titleLength >= 1 && titleLength <= 120 && bodyLength >= 1 && bodyLength <= 5000
    },
    canUndo (): boolean {
      void this.toolbarVersion
      return this.editor?.can().undo() ?? false
    },
    canRedo (): boolean {
      void this.toolbarVersion
      return this.editor?.can().redo() ?? false
    },
    hasSourceSelection (): boolean {
      void this.toolbarVersion
      return this.editor?.isActive('wikiSourceBlock') === true || this.editor?.isActive('wikiSourceInline') === true
    }
  },
  methods: {
    isActive (name: string, attributes?: Record<string, unknown>): boolean {
      void this.toolbarVersion
      return this.editor?.isActive(name, attributes) ?? false
    },
    activeColor (name: string): string | undefined {
      return this.isActive(name) ? 'teal' : undefined
    },
    setParagraph () {
      this.editor?.chain().focus().setParagraph().run()
    },
    setHeading (level: number) {
      this.editor?.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
    },
    setCodeBlock (language: string) {
      if (this.editor?.isActive('codeBlock')) {
        this.editor.chain().focus().updateAttributes('codeBlock', { language }).run()
      } else {
        this.editor?.chain().focus().setCodeBlock({ language }).run()
      }
    },
    liftListItem () {
      if (this.editor?.isActive('taskItem')) this.editor.chain().focus().liftListItem('taskItem').run()
      else this.editor?.chain().focus().liftListItem('listItem').run()
    },
    sinkListItem () {
      if (this.editor?.isActive('taskItem')) this.editor.chain().focus().sinkListItem('taskItem').run()
      else this.editor?.chain().focus().sinkListItem('listItem').run()
    },
    insertTable () {
      this.editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    },
    openAdmonitionDialog () {
      this.admonitionError = ''
      this.admonitionDialog = true
    },
    insertAdmonition () {
      if (!this.editor || !this.isAdmonitionValid) return
      this.admonitionError = ''
      try {
        insertVisualMarkdownAdmonition(this.editor as unknown as Editor, {
          kind: this.admonitionKind,
          title: this.admonitionTitle,
          body: this.admonitionBody
        })
        this.admonitionDialog = false
        this.admonitionTitle = ''
        this.admonitionBody = ''
      } catch (err) {
        this.admonitionError = err instanceof Error ? err.message : 'The admonition could not be inserted.'
      }
    },
    insertDefinitionList () {
      if (this.editor) insertVisualMarkdownDefinitionList(this.editor as unknown as Editor)
    },
    insertGlyph (glyph: VisualMarkdownGlyph) {
      if (!this.editor) return
      try {
        insertVisualMarkdownGlyph(this.editor as unknown as Editor, glyph)
      } catch (err) {
        wikiStore.showNotification({
          message: err instanceof Error ? err.message : 'The icon or emoji could not be inserted.',
          style: 'warning',
          icon: 'warning'
        })
      }
    },
    toggleExtensionDialog () {
      this.activeModal = this.activeModal === 'editorModalBlocks' ? '' : 'editorModalBlocks'
    },
    insertLink () {
      this.insertLinkDialog = true
    },
    insertLinkHandler ({ locale, path }: InsertLinkPayload) {
      if (!this.editor) return
      const href = siteLangs.length > 0 ? `/${locale}/${path}` : `/${path}`
      const { empty } = this.editor.state.selection
      if (empty) {
        this.editor.chain().focus().insertContent({
          type: 'text',
          text: path,
          marks: [{ type: 'link', attrs: { href } }]
        }).run()
      } else {
        this.editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      }
    },
    openSourceDialog () {
      if (!this.editor) return
      const nodeName: SourceNodeName | null = this.editor.isActive('wikiSourceBlock')
        ? 'wikiSourceBlock'
        : this.editor.isActive('wikiSourceInline') ? 'wikiSourceInline' : null
      if (!nodeName) return
      const attributes = this.editor.getAttributes(nodeName)
      this.sourceNodeName = nodeName
      this.sourceKind = typeof attributes.kind === 'string' ? attributes.kind : 'source'
      this.sourceValue = decodeWikiSource(attributes.source)
      this.sourceDialog = true
    },
    saveSourceNode () {
      if (!this.editor || !this.sourceNodeName) return
      this.editor.chain().focus().updateAttributes(this.sourceNodeName, {
        source: encodeWikiSource(this.sourceValue)
      }).run()
      this.sourceDialog = false
    },
    handleEditorSaveConflict () {
      this.isConflict = true
    },
    preparedContent (content: string): string {
      return this.format === 'markdown' ? prepareTiptapMarkdown(content) : prepareTiptapHtml(content)
    },
    handleEditorContentOverwrite () {
      this.editor?.commands.setContent(this.preparedContent(wikiStore.editor.content), {
        contentType: this.format,
        emitUpdate: false
      })
      if (this.editor) this.syncFromEditor(this.editor as unknown as Editor)
    },
    handleEditorLinkToPage () {
      this.insertLink()
    },
    insertCodeDocument (language: string, text: string) {
      const content: JSONContent = {
        type: 'codeBlock',
        attrs: { language },
        content: text.length > 0 ? [{ type: 'text', text }] : undefined
      }
      this.editor?.commands.insertContent(content)
    },
    handleEditorInsert (opts: EditorInsertPayload) {
      if (!this.editor) return
      switch (opts.kind) {
        case 'IMAGE':
          if (typeof opts.path === 'string') {
            this.editor.chain().focus().setImage({
              src: opts.path,
              alt: typeof opts.text === 'string' ? opts.text : undefined
            }).run()
          }
          break
        case 'BINARY':
          if (typeof opts.path === 'string') {
            const label = typeof opts.text === 'string' && opts.text.length > 0 ? opts.text : opts.path
            this.editor.chain().focus().insertContent({
              type: 'text',
              text: label,
              marks: [{ type: 'link', attrs: { href: opts.path, download: 'download' } }]
            }).run()
          }
          break
        case 'DIAGRAM':
          if (this.format === 'markdown' && typeof opts.text === 'string') {
            this.insertCodeDocument('diagram', opts.text)
          } else if (typeof opts.text === 'string') {
            this.editor.chain().focus().setImage({ src: `data:image/svg+xml;base64,${opts.text}` }).run()
          }
          break
        case 'EXTENSION':
          if (this.format === 'markdown' && typeof opts.text === 'string') {
            try {
              this.insertCodeDocument('wiki-extension', contentExtensionFenceBody(opts.text))
            } catch (err) {
              wikiStore.showNotification({
                message: err instanceof Error ? err.message : 'The content extension could not be inserted.',
                style: 'warning',
                icon: 'warning'
              })
            }
          }
          break
      }
    },
    syncFromEditor (editor: Editor) {
      wikiStore.editor.content = serializeVisualEditorData(this.format, editor)
      this.stats = getVisualEditorStats(editor)
      this.toolbarVersion += 1
    }
  },
  mounted () {
    wikiStore.editor.editorKey = this.definition.editorKey
    const initialContent = this.preparedContent(wikiStore.editor.content)
    if (this.format === 'html') {
      this.syncContent = _.debounce((editor: Editor) => this.syncFromEditor(editor), 300)
    }

    const editor = new Editor({
      content: initialContent,
      contentType: this.format,
      extensions: createTiptapExtensions(this.format),
      autofocus: false,
      editorProps: {
        handleKeyDown: (_view, event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void this.save()
            return true
          }
          return false
        }
      },
      onCreate: ({ editor }) => {
        this.stats = getVisualEditorStats(editor)
      },
      onUpdate: ({ editor }) => {
        if (this.format === 'markdown') this.syncFromEditor(editor)
        else this.syncContent?.(editor)
      },
      onSelectionUpdate: () => {
        this.toolbarVersion += 1
      }
    })
    this.editor = markRaw(editor)
    Object.defineProperty(this.$refs.root as EditorHost, '__wikiEditor', {
      configurable: true,
      value: editor
    })

    onEditorInsert(this.handleEditorInsert)
    onEditorLinkToPage(this.handleEditorLinkToPage)
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount () {
    this.syncContent?.flush()
    this.syncContent?.cancel()
    offEditorInsert(this.handleEditorInsert)
    offEditorLinkToPage(this.handleEditorLinkToPage)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    delete (this.$refs.root as EditorHost).__wikiEditor
    this.editor?.destroy()
    this.editor = null
  }
})
</script>

<style lang='scss'>
$editor-height: calc(100vh - 64px - 24px);
$editor-height-mobile: calc(100vh - 56px - 16px);

.editor-tiptap {
  background-color: mc('grey', '200');
  flex: 1 1 50%;
  display: flex;
  flex-flow: column nowrap;
  height: $editor-height;
  max-height: $editor-height;
  position: relative;

  @at-root .v-theme--dark & {
    background-color: mc('grey', '900');
  }

  @include until($tablet) {
    height: $editor-height-mobile;
    max-height: $editor-height-mobile;
  }

  &-toolbar {
    flex: 0 0 auto;
    overflow-x: auto;

    .v-toolbar__content {
      min-width: max-content;
      justify-content: center;
    }
  }

  &-sysbar {
    padding-left: 0;

    &-locale {
      background-color: rgba(255, 255, 255, .25);
      display: inline-flex;
      padding: 0 12px;
      height: 24px;
      width: 63px;
      justify-content: center;
      align-items: center;
    }
  }

  &-markdown-tools {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 1px;
    background: mc('blue-grey', '900');

    .v-btn {
      flex: 1 1 12rem;
    }
  }

  > .contents {
    background-color: mc('grey', '100');
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2rem;
    box-shadow: 0 0 5px hsla(0, 0%, 0%, .1);
    margin: 1rem auto 0;
    width: calc(100vw - 256px - 16vw);
    min-height: calc(100vh - 64px - 24px - 1rem - 40px);
    border-radius: 5px;

    @at-root .v-theme--dark & {
      background-color: #303030;
      color: #FFF;
    }

    @include until($widescreen) {
      width: calc(100vw - 2rem);
      margin: 1rem 1rem 0;
    }

    @include until($tablet) {
      width: 100%;
      margin: 0;
      min-height: calc(100vh - 56px - 24px - 76px);
      padding: 1rem;
    }
  }

  .tiptap {
    min-height: inherit;
    outline: none;

    > :first-child {
      margin-top: 0;
    }

    p.is-editor-empty:first-child::before {
      color: mc('grey', '500');
      content: attr(data-placeholder);
      float: left;
      height: 0;
      pointer-events: none;
    }

    dl {
      margin: 1em 0;
    }

    dt {
      font-weight: 600;
    }

    dd {
      margin: .25em 0 .75em 2em;
    }

    table {
      border-collapse: collapse;
      margin: 1em 0;
      table-layout: fixed;
      width: 100%;

      td,
      th {
        border: 1px solid mc('grey', '400');
        min-width: 1em;
        padding: .5em;
        position: relative;
        vertical-align: top;
      }

      th {
        background: mc('grey', '200');
        font-weight: 600;
      }

      .selectedCell::after {
        background: rgba(mc('teal', '500'), .2);
        content: '';
        inset: 0;
        pointer-events: none;
        position: absolute;
      }
    }

    ul[data-type='taskList'] {
      list-style: none;
      padding-left: 0;

      li {
        align-items: flex-start;
        display: flex;
        gap: .5em;

        > div {
          flex: 1;
        }
      }
    }

    pre {
      background: mc('blue-grey', '900');
      border-radius: 4px;
      color: #FFF;
      overflow-x: auto;
      padding: .8em 1em;
    }

    kbd {
      background: mc('grey', '200');
      border: 1px solid mc('grey', '400');
      border-radius: 3px;
      box-shadow: 0 1px 0 mc('grey', '500');
      font-family: monospace;
      padding: .1em .35em;
    }

    mark {
      background: #fff59d;
    }

    wiki-source-block,
    wiki-source-inline {
      background: rgba(mc('amber', '500'), .12);
      border: 1px solid mc('amber', '700');
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
    }

    wiki-source-block {
      display: block;
      margin: 1em 0;
      overflow-x: auto;
      padding: .75em;
      white-space: pre-wrap;

      .wiki-source-label {
        background: mc('amber', '800');
        border-radius: 3px;
        color: #FFF;
        display: inline-block;
        font-size: .7em;
        font-weight: 600;
        margin: 0 .7em .3em 0;
        padding: .1em .4em;
        text-transform: uppercase;
      }

      code {
        white-space: pre-wrap;
      }
    }

    wiki-source-inline {
      display: inline;
      font-family: monospace;
      padding: .1em .3em;
      white-space: pre-wrap;
    }

    .ProseMirror-selectednode {
      box-shadow: 0 0 0 3px rgba(mc('teal', '500'), .35);
    }
  }
}
</style>

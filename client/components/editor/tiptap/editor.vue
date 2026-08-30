<template lang='pug'>
  .editor-tiptap(ref='root')
    v-toolbar.editor-tiptap-toolbar(flat)
      .editor-tiptap-toolbar-inner(role='toolbar', aria-label='Formatting toolbar')
        .editor-tiptap-toolbar-group(role='group', aria-label='History')
          v-btn.editor-tiptap-tool(icon, size='small', title='Undo', aria-label='Undo', :disabled='!canUndo', @click='editor?.chain().focus().undo().run()')
            v-icon mdi-undo
          v-btn.editor-tiptap-tool(icon, size='small', title='Redo', aria-label='Redo', :disabled='!canRedo', @click='editor?.chain().focus().redo().run()')
            v-icon mdi-redo
        .editor-tiptap-toolbar-group(role='group', aria-label='Text formatting')
          v-menu
            template(v-slot:activator='{ props }')
              v-btn.editor-tiptap-style-trigger(v-bind='props', size='small', title='Text style', aria-label='Text style')
                v-icon(start) mdi-format-header-pound
                | Style
                v-icon(end, size='16') mdi-chevron-down
            v-list.editor-tiptap-menu-list(density='compact')
              v-list-item(@click='setParagraph')
                template(v-slot:prepend)
                  v-icon mdi-format-paragraph
                v-list-item-title Paragraph
              v-list-item(v-for='level in 6', :key='level', @click='setHeading(level)')
                template(v-slot:prepend)
                  v-icon mdi-format-header-{{level}}
                v-list-item-title Heading {{level}}
          v-btn.editor-tiptap-tool(icon, size='small', title='Bold', aria-label='Bold', :aria-pressed='isActive(`bold`)', :color='activeColor(`bold`)', @click='editor?.chain().focus().toggleBold().run()')
            v-icon mdi-format-bold
          v-btn.editor-tiptap-tool(icon, size='small', title='Italic', aria-label='Italic', :aria-pressed='isActive(`italic`)', :color='activeColor(`italic`)', @click='editor?.chain().focus().toggleItalic().run()')
            v-icon mdi-format-italic
          v-btn.editor-tiptap-tool(v-if='format === `html`', icon, size='small', title='Underline', aria-label='Underline', :aria-pressed='isActive(`underline`)', :color='activeColor(`underline`)', @click='editor?.chain().focus().toggleUnderline().run()')
            v-icon mdi-format-underline
          v-btn.editor-tiptap-tool(icon, size='small', title='Strikethrough', aria-label='Strikethrough', :aria-pressed='isActive(`strike`)', :color='activeColor(`strike`)', @click='editor?.chain().focus().toggleStrike().run()')
            v-icon mdi-format-strikethrough
          template(v-if='format === `markdown`')
            v-btn.editor-tiptap-tool(icon, size='small', title='Highlight', aria-label='Highlight', :aria-pressed='isActive(`highlight`)', :color='activeColor(`highlight`)', @click='editor?.chain().focus().toggleHighlight().run()')
              v-icon mdi-format-color-highlight
            v-btn.editor-tiptap-tool(icon, size='small', title='Subscript', aria-label='Subscript', :aria-pressed='isActive(`subscript`)', :color='activeColor(`subscript`)', @click='editor?.chain().focus().toggleSubscript().run()')
              v-icon mdi-format-subscript
            v-btn.editor-tiptap-tool(icon, size='small', title='Superscript', aria-label='Superscript', :aria-pressed='isActive(`superscript`)', :color='activeColor(`superscript`)', @click='editor?.chain().focus().toggleSuperscript().run()')
              v-icon mdi-format-superscript
            v-btn.editor-tiptap-tool(icon, size='small', title='Keyboard key', aria-label='Keyboard key', :aria-pressed='isActive(`keyboard`)', :color='activeColor(`keyboard`)', @click='editor?.chain().focus().toggleMark(`keyboard`).run()')
              v-icon mdi-keyboard-outline
            v-btn.editor-tiptap-tool(icon, size='small', title='Inline code', aria-label='Inline code', :aria-pressed='isActive(`code`)', :color='activeColor(`code`)', @click='editor?.chain().focus().toggleCode().run()')
              v-icon mdi-code-tags
          v-btn.editor-tiptap-tool(icon, size='small', title='Link to page', aria-label='Link to page', :color='activeColor(`link`)', @click='insertLink')
            v-icon mdi-link-variant
        .editor-tiptap-toolbar-group(role='group', aria-label='Lists and indentation')
          v-btn.editor-tiptap-tool(icon, size='small', title='Bulleted list', aria-label='Bulleted list', :aria-pressed='isActive(`bulletList`)', :color='activeColor(`bulletList`)', @click='editor?.chain().focus().toggleBulletList().run()')
            v-icon mdi-format-list-bulleted
          v-btn.editor-tiptap-tool(icon, size='small', title='Numbered list', aria-label='Numbered list', :aria-pressed='isActive(`orderedList`)', :color='activeColor(`orderedList`)', @click='editor?.chain().focus().toggleOrderedList().run()')
            v-icon mdi-format-list-numbered
          v-btn.editor-tiptap-tool(v-if='format === `markdown`', icon, size='small', title='Task list', aria-label='Task list', :aria-pressed='isActive(`taskList`)', :color='activeColor(`taskList`)', @click='editor?.chain().focus().toggleTaskList().run()')
            v-icon mdi-format-list-checks
          v-btn.editor-tiptap-tool(icon, size='small', title='Decrease indent', aria-label='Decrease indent', @click='liftListItem')
            v-icon mdi-format-indent-decrease
          v-btn.editor-tiptap-tool(icon, size='small', title='Increase indent', aria-label='Increase indent', @click='sinkListItem')
            v-icon mdi-format-indent-increase
        .editor-tiptap-toolbar-group(role='group', aria-label='Blocks and structure')
          v-btn.editor-tiptap-tool(icon, size='small', title='Block quote', aria-label='Block quote', :aria-pressed='isActive(`blockquote`)', :color='activeColor(`blockquote`)', @click='editor?.chain().focus().toggleBlockquote().run()')
            v-icon mdi-format-quote-open
          v-menu
            template(v-slot:activator='{ props }')
              v-btn.editor-tiptap-tool(icon, size='small', v-bind='props', title='Code block', aria-label='Code block', :aria-pressed='isActive(`codeBlock`)', :color='activeColor(`codeBlock`)')
                v-icon mdi-code-braces
            v-list.editor-tiptap-menu-list(density='compact')
              v-list-item(v-for='language in codeBlockLanguages', :key='language.value', @click='setCodeBlock(language.value)')
                template(v-slot:prepend)
                  v-icon mdi-code-tags
                v-list-item-title {{language.label}}
          v-btn.editor-tiptap-tool(icon, size='small', title='Horizontal rule', aria-label='Horizontal rule', @click='editor?.chain().focus().setHorizontalRule().run()')
            v-icon mdi-minus
          v-menu
            template(v-slot:activator='{ props }')
              v-btn.editor-tiptap-tool(icon, size='small', v-bind='props', title='Table', aria-label='Table', :aria-pressed='isActive(`table`)', :color='activeColor(`table`)')
                v-icon mdi-table
            v-list.editor-tiptap-menu-list(density='compact')
              v-list-item(@click='insertTable')
                template(v-slot:prepend)
                  v-icon mdi-table-plus
                v-list-item-title Insert table
              template(v-if='isActive(`table`)')
                v-list-item(@click='editor?.chain().focus().addColumnAfter().run()') Add column
                v-list-item(@click='editor?.chain().focus().addRowAfter().run()') Add row
                v-list-item(@click='editor?.chain().focus().mergeOrSplit().run()') Merge or split cells
                v-list-item(@click='editor?.chain().focus().deleteTable().run()') Delete table
          template(v-if='format === `html`')
            v-btn.editor-tiptap-tool(icon, size='small', title='Align left', aria-label='Align left', @click='editor?.chain().focus().setTextAlign(`left`).run()')
              v-icon mdi-format-align-left
            v-btn.editor-tiptap-tool(icon, size='small', title='Align center', aria-label='Align center', @click='editor?.chain().focus().setTextAlign(`center`).run()')
              v-icon mdi-format-align-center
            v-btn.editor-tiptap-tool(icon, size='small', title='Align right', aria-label='Align right', @click='editor?.chain().focus().setTextAlign(`right`).run()')
              v-icon mdi-format-align-right
        v-btn.editor-tiptap-source-trigger(v-if='hasSourceSelection', color='warning', variant='tonal', size='small', title='Edit preserved source', aria-label='Edit preserved source', @click='openSourceDialog')
          v-icon(start) mdi-code-block-tags
          | Edit source
    .editor-tiptap-markdown-tools(v-if='format === `markdown`', role='toolbar', aria-label='Insert content')
      .editor-tiptap-insert-label
        v-icon(size='18') mdi-plus-circle-outline
        span Insert
      v-btn.editor-tiptap-insert-button.editor-tiptap-extension-trigger(variant='tonal', size='small', @click='toggleExtensionDialog', aria-label='Insert content extension')
        v-icon(start) mdi-qrcode
        | Content
      v-btn.editor-tiptap-insert-button(variant='tonal', size='small', aria-label='Insert admonition', @click='openAdmonitionDialog')
        v-icon(start) mdi-alert-box-outline
        | Admonition
      v-btn.editor-tiptap-insert-button(variant='tonal', size='small', aria-label='Insert definition list', @click='insertDefinitionList')
        v-icon(start) mdi-format-list-group-plus
        | Definition list
      v-menu(v-model='glyphMenuOpen', :close-on-content-click='false', location='bottom end', :offset='8')
        template(v-slot:activator='{ props }')
          v-btn.editor-tiptap-insert-button(v-bind='props', variant='tonal', size='small', aria-label='Insert icon or emoji')
            v-icon(start) mdi-emoticon-outline
            | Icon & emoji
            v-icon(end, size='16') mdi-chevron-down
        v-card.editor-tiptap-glyph-menu(elevation='5', width='420')
          .editor-tiptap-glyph-header
            div
              .text-subtitle-1.font-weight-bold Icons & emoji
              .text-caption Search by name, meaning, or a close spelling
            v-btn(icon, size='small', variant='text', aria-label='Close icon and emoji picker', @click='glyphMenuOpen = false')
              v-icon mdi-close
          v-card-text.editor-tiptap-glyph-body
            v-text-field.editor-tiptap-glyph-search(
              v-model='glyphQuery'
              autofocus
              clearable
              density='compact'
              hide-details
              prepend-inner-icon='mdi-magnify'
              placeholder='Try “celebrte”, “deploy”, or “secure”'
              aria-label='Search icons and emoji'
              variant='outlined'
            )
            v-btn-toggle.editor-tiptap-glyph-filters.mt-3(
              v-model='glyphCategory'
              color='primary'
              density='compact'
              divided
              mandatory
              variant='outlined'
            )
              v-btn(value='all') All
              v-btn(value='icon')
                v-icon(start) mdi-shape-outline
                | Icons
              v-btn(value='emoji')
                v-icon(start) mdi-emoticon-outline
                | Emoji
            .editor-tiptap-glyph-grid.mt-3(v-if='filteredGlyphs.length > 0')
              v-btn.editor-tiptap-glyph-button(
                v-for='glyph in filteredGlyphs'
                :key='`${glyph.category}:${glyph.label}`'
                icon
                variant='text'
                :aria-label='`Insert ${glyph.label}`'
                :title='glyph.label'
                @click='insertGlyph(glyph)'
              )
                span {{glyph.value}}
            .editor-tiptap-glyph-empty(v-else)
              v-icon(size='32') mdi-emoticon-sad-outline
              .text-body-medium No matching icons or emoji
              .text-caption Try a shorter word or another meaning.
          .editor-tiptap-glyph-footer
            span {{filteredGlyphs.length}} of {{glyphs.length}}
            span Fuzzy search
    editor-content.contents(:editor='editor')
    v-system-bar.editor-status-bar.editor-tiptap-sysbar(status)
      .text-body-small.editor-tiptap-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.editor-tiptap-sysbar-path.px-3(:title='`/${path}`') /{{path}}
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
  searchVisualMarkdownGlyphs,
  type AdmonitionKind,
  type VisualMarkdownGlyph,
  type VisualMarkdownGlyphFilter
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
      glyphMenuOpen: false,
      glyphQuery: '',
      glyphCategory: 'all' as VisualMarkdownGlyphFilter,
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
    filteredGlyphs (): readonly VisualMarkdownGlyph[] {
      return searchVisualMarkdownGlyphs(this.glyphQuery, this.glyphCategory)
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
  watch: {
    glyphMenuOpen (isOpen: boolean) {
      if (!isOpen) this.glyphQuery = ''
    }
  },
  methods: {
    isActive (name: string, attributes?: Record<string, unknown>): boolean {
      void this.toolbarVersion
      return this.editor?.isActive(name, attributes) ?? false
    },
    activeColor (name: string): string | undefined {
      return this.isActive(name) ? 'primary' : undefined
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
        this.glyphMenuOpen = false
        this.glyphQuery = ''
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

.editor-tiptap {
  --editor-surface: rgb(var(--v-theme-surface));
  --editor-on-surface: rgb(var(--v-theme-on-surface));
  --editor-primary: rgb(var(--v-theme-primary));
  --editor-border: rgba(var(--v-theme-on-surface), .12);
  --editor-muted: rgba(var(--v-theme-on-surface), .62);
  background:
    radial-gradient(circle at 50% -20%, rgba(var(--v-theme-primary), .12), transparent 44%),
    color-mix(in srgb, rgb(var(--v-theme-background)) 92%, var(--editor-primary) 8%);
  color: var(--editor-on-surface);
  display: flex;
  flex: 1 1 auto;
  flex-flow: column nowrap;
  height: 100%;
  min-height: 0;
  position: relative;

  &-toolbar {
    background: color-mix(in srgb, var(--editor-surface) 94%, var(--editor-primary) 6%) !important;
    border-bottom: 1px solid var(--editor-border);
    box-shadow: 0 4px 18px rgba(0, 0, 0, .06);
    flex: 0 0 auto;
    overflow-x: auto;
    scrollbar-color: rgba(var(--v-theme-on-surface), .18) transparent;
    scrollbar-width: thin;

    .v-toolbar__content {
      justify-content: center;
      min-height: 54px;
      min-width: max-content;
      padding: 7px 12px;
    }
  }

  &-toolbar-inner {
    align-items: center;
    display: flex;
    gap: 7px;
    margin-inline: auto;
    width: max-content;
  }

  &-toolbar-group {
    align-items: center;
    background: rgba(var(--v-theme-on-surface), .045);
    border: 1px solid rgba(var(--v-theme-on-surface), .08);
    border-radius: 12px;
    display: inline-flex;
    gap: 1px;
    padding: 3px;
  }

  &-tool,
  &-style-trigger {
    border-radius: 8px !important;
    color: rgba(var(--v-theme-on-surface), .82);
    height: 32px !important;
    letter-spacing: 0;
    margin: 0;

    &:hover {
      background: rgba(var(--v-theme-primary), .1);
      color: var(--editor-primary);
    }

    &:focus-visible {
      outline: 2px solid rgba(var(--v-theme-primary), .7);
      outline-offset: 1px;
    }
  }

  &-tool {
    min-width: 32px !important;
    width: 32px;
  }

  &-style-trigger {
    min-width: 88px;
    padding-inline: 10px;
    text-transform: none;
  }

  &-source-trigger {
    border-radius: 9px !important;
    text-transform: none;
  }

  &-markdown-tools {
    align-items: center;
    background: color-mix(in srgb, var(--editor-surface) 97%, var(--editor-primary) 3%);
    border-bottom: 1px solid var(--editor-border);
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    justify-content: center;
    overflow-x: auto;
    padding: 8px 12px;
    scrollbar-width: thin;
  }

  &-insert-label {
    align-items: center;
    color: var(--editor-muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: .72rem;
    font-weight: 700;
    gap: 5px;
    letter-spacing: .08em;
    margin-right: 2px;
    text-transform: uppercase;
  }

  &-insert-button {
    border-radius: 10px !important;
    color: rgba(var(--v-theme-on-surface), .84);
    flex: 0 0 auto;
    letter-spacing: 0;
    text-transform: none;

    &:hover {
      color: var(--editor-primary);
    }
  }

  &-sysbar {
    background: color-mix(in srgb, var(--editor-surface) 90%, rgb(var(--v-theme-on-surface)) 10%) !important;
    border-top: 1px solid var(--editor-border);
    color: var(--editor-muted);
    flex: 0 0 calc(24px + env(safe-area-inset-bottom));
    min-height: calc(24px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: 0;
    &-locale {
      align-items: center;
      background: rgba(var(--v-theme-primary), .14);
      color: var(--editor-primary);
      display: inline-flex;
      font-weight: 700;
      height: 24px;
      justify-content: center;
      padding: 0 12px;
      width: 63px;
    }
    &-path {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  > .contents {
    background: var(--editor-surface);
    border: 1px solid var(--editor-border);
    border-radius: 16px;
    box-shadow:
      0 20px 55px rgba(0, 0, 0, .1),
      0 2px 8px rgba(0, 0, 0, .05);
    color: var(--editor-on-surface);
    flex: 1 1 auto;
    margin: 18px auto 24px;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: clamp(1.5rem, 4vw, 3.5rem);
    transition: border-color 160ms ease, box-shadow 160ms ease;
    width: min(920px, calc(100vw - 256px - 10vw));

    &:focus-within {
      border-color: rgba(var(--v-theme-primary), .45);
      box-shadow:
        0 22px 60px rgba(0, 0, 0, .12),
        0 0 0 3px rgba(var(--v-theme-primary), .08);
    }

    @include until($widescreen) {
      margin-inline: 1rem;
      width: calc(100vw - 2rem);
    }

    @include until($tablet) {
      border-left: 0;
      border-radius: 0;
      border-right: 0;
      margin: 0 0 24px;
      padding: 1.25rem;
      width: 100%;
    }
  }

  .tiptap {
    caret-color: var(--editor-primary);
    font-size: 1rem;
    line-height: 1.72;
    min-height: 100%;
    outline: none;
    overflow-wrap: anywhere;

    > :first-child {
      margin-top: 0;
    }

    > :last-child {
      margin-bottom: 0;
    }

    ::selection {
      background: rgba(var(--v-theme-primary), .24);
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      color: var(--editor-on-surface);
      font-weight: 720;
      letter-spacing: -.025em;
      line-height: 1.22;
      margin: 1.5em 0 .55em;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 2.55rem);
      letter-spacing: -.04em;
    }

    h2 {
      border-bottom: 1px solid var(--editor-border);
      font-size: clamp(1.55rem, 3vw, 1.9rem);
      padding-bottom: .25em;
    }

    h3 {
      font-size: 1.4rem;
    }

    p {
      margin: .8em 0;
    }

    a {
      color: var(--editor-primary);
      text-decoration-color: rgba(var(--v-theme-primary), .45);
      text-decoration-thickness: .08em;
      text-underline-offset: .18em;

      &:hover {
        text-decoration-color: currentColor;
      }
    }

    blockquote {
      background: rgba(var(--v-theme-primary), .055);
      border-left: 4px solid rgba(var(--v-theme-primary), .58);
      border-radius: 0 10px 10px 0;
      color: rgba(var(--v-theme-on-surface), .76);
      margin: 1.25em 0;
      padding: .75em 1.1em;
    }

    hr {
      border: 0;
      border-top: 1px solid var(--editor-border);
      margin: 2em 0;
    }

    img {
      border-radius: 10px;
      height: auto;
      max-width: 100%;
    }

    p.is-editor-empty:first-child::before {
      color: rgba(var(--v-theme-on-surface), .42);
      content: attr(data-placeholder);
      float: left;
      height: 0;
      pointer-events: none;
    }

    dl {
      margin: 1em 0;
    }

    dt {
      font-weight: 700;
    }

    dd {
      border-left: 2px solid var(--editor-border);
      margin: .25em 0 .9em .5em;
      padding-left: 1em;
    }

    table {
      border-collapse: separate;
      border-spacing: 0;
      margin: 1.25em 0;
      table-layout: fixed;
      width: 100%;

      td,
      th {
        border-bottom: 1px solid var(--editor-border);
        border-right: 1px solid var(--editor-border);
        min-width: 1em;
        padding: .65em .75em;
        position: relative;
        vertical-align: top;

        &:first-child {
          border-left: 1px solid var(--editor-border);
        }
      }

      tr:first-child {
        td,
        th {
          border-top: 1px solid var(--editor-border);
        }

        > :first-child {
          border-top-left-radius: 9px;
        }

        > :last-child {
          border-top-right-radius: 9px;
        }
      }

      tr:last-child {
        > :first-child {
          border-bottom-left-radius: 9px;
        }

        > :last-child {
          border-bottom-right-radius: 9px;
        }
      }

      th {
        background: rgba(var(--v-theme-on-surface), .055);
        font-weight: 700;
      }

      .selectedCell::after {
        background: rgba(var(--v-theme-primary), .18);
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
        gap: .6em;

        > label {
          margin-top: .18em;
        }

        > div {
          flex: 1;
        }
      }

      input[type='checkbox'] {
        accent-color: var(--editor-primary);
      }
    }

    pre {
      background: #17212b;
      border: 1px solid rgba(255, 255, 255, .08);
      border-radius: 11px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05);
      color: #f4f7fb;
      line-height: 1.6;
      overflow-x: auto;
      padding: 1em 1.15em;
    }

    code:not(pre code) {
      background: rgba(var(--v-theme-on-surface), .08);
      border: 1px solid rgba(var(--v-theme-on-surface), .09);
      border-radius: 5px;
      font-size: .88em;
      padding: .12em .34em;
    }

    kbd {
      background: rgba(var(--v-theme-on-surface), .08);
      border: 1px solid rgba(var(--v-theme-on-surface), .18);
      border-bottom-width: 2px;
      border-radius: 5px;
      box-shadow: 0 1px 0 rgba(0, 0, 0, .12);
      font-family: monospace;
      font-size: .85em;
      padding: .1em .38em;
    }

    mark {
      background: rgba(255, 193, 7, .32);
      border-radius: 3px;
      color: inherit;
      padding-inline: .08em;
    }

    wiki-source-block,
    wiki-source-inline {
      background: rgba(mc('amber', '500'), .12);
      border: 1px solid rgba(mc('amber', '700'), .7);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
    }

    wiki-source-block {
      display: block;
      margin: 1em 0;
      overflow-x: auto;
      padding: .8em;
      white-space: pre-wrap;

      .wiki-source-label {
        background: mc('amber', '800');
        border-radius: 4px;
        color: #FFF;
        display: inline-block;
        font-size: .7em;
        font-weight: 700;
        margin: 0 .7em .3em 0;
        padding: .12em .45em;
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
      box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), .35);
    }
  }
}

.editor-tiptap-menu-list {
  border: 1px solid rgba(var(--v-theme-on-surface), .1);
  border-radius: 12px !important;
  box-shadow: 0 16px 36px rgba(0, 0, 0, .16) !important;
  overflow: hidden;
  padding: 6px !important;

  .v-list-item {
    border-radius: 8px;
  }
}

.editor-tiptap-glyph-menu {
  background: rgb(var(--v-theme-surface)) !important;
  border: 1px solid rgba(var(--v-theme-on-surface), .12);
  border-radius: 18px !important;
  color: rgb(var(--v-theme-on-surface));
  max-width: calc(100vw - 24px);
  overflow: hidden;
  width: min(420px, calc(100vw - 24px)) !important;
}

.editor-tiptap-glyph-header {
  align-items: flex-start;
  background:
    radial-gradient(circle at 100% 0, rgba(var(--v-theme-primary), .16), transparent 52%),
    rgba(var(--v-theme-primary), .055);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), .09);
  display: flex;
  justify-content: space-between;
  padding: 16px 18px 14px;

  .text-caption {
    color: rgba(var(--v-theme-on-surface), .62);
    margin-top: 2px;
  }
}

.editor-tiptap-glyph-body {
  padding: 14px 18px 12px !important;
}

.editor-tiptap-glyph-search {
  .v-field {
    border-radius: 11px;
  }
}

.editor-tiptap-glyph-filters {
  border-radius: 10px !important;
  display: flex;
  width: 100%;

  .v-btn {
    flex: 1 1 0;
    letter-spacing: 0;
    min-width: 0;
    text-transform: none;
  }
}

.editor-tiptap-glyph-grid {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(38px, 1fr));
  max-height: 270px;
  overflow-x: auto;
  overflow-y: auto;
  padding: 2px 4px 6px 0;
  scrollbar-color: rgba(var(--v-theme-on-surface), .2) transparent;
  scrollbar-width: thin;
}

.editor-tiptap-glyph-button {
  border: 1px solid transparent;
  border-radius: 10px !important;
  font-size: 1.35rem;
  height: 38px !important;
  justify-self: center;
  min-width: 38px !important;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
  width: 38px;

  &:hover,
  &:focus-visible {
    background: rgba(var(--v-theme-primary), .1);
    border-color: rgba(var(--v-theme-primary), .24);
    transform: translateY(-1px);
  }
}

.editor-tiptap-glyph-empty {
  align-items: center;
  color: rgba(var(--v-theme-on-surface), .62);
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  min-height: 180px;
  text-align: center;
}

.editor-tiptap-glyph-footer {
  align-items: center;
  background: rgba(var(--v-theme-on-surface), .025);
  border-top: 1px solid rgba(var(--v-theme-on-surface), .08);
  color: rgba(var(--v-theme-on-surface), .52);
  display: flex;
  font-size: .68rem;
  font-weight: 700;
  justify-content: space-between;
  letter-spacing: .08em;
  padding: 8px 18px;
  text-transform: uppercase;
}


@media (prefers-reduced-motion: reduce) {
  .editor-tiptap,
  .editor-tiptap * {
    animation: none !important;
    transition: none !important;
  }
}
</style>

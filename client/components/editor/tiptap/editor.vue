<template lang='pug'>
  .editor-tiptap(ref='root')
    v-toolbar.editor-tiptap-toolbar(flat, density='compact')
      .editor-tiptap-toolbar-inner(
        role='toolbar'
        :aria-label='$t(`editor:markup.formattingTools`)'
        v-roving-toolbar='{ onEscape: focusEditor }'
      )
        .editor-tiptap-toolbar-group(
          v-for='group of toolbarGroups'
          :key='group.id'
          role='group'
          :aria-label='$t(group.labelKey)'
        )
          template(v-for='toolId of group.tools', :key='toolId')
            v-menu(v-if='toolId === `heading`')
              template(v-slot:activator='{ props: menuProps }')
                v-btn.editor-tiptap-style-trigger.editor-tool(
                  v-bind='menuProps'
                  size='small'
                  variant='text'
                  :class='{ "is-active": currentBlock.kind === `heading` }'
                  :aria-label='$t(`editor:markup.textStyleCurrent`, { style: currentBlock.label })'
                )
                  v-icon(start) {{ currentBlock.icon }}
                  | {{ currentBlock.label }}
                  v-icon(end, size='16') mdi-chevron-down
                  v-tooltip(activator='parent', location='bottom') {{ $t('editor:markup.textStyle') }}
              v-list.editor-tiptap-menu-list(density='compact')
                v-list-item(:active='currentBlock.kind === `paragraph`', @click='setParagraph')
                  template(v-slot:prepend)
                    v-icon mdi-format-paragraph
                  v-list-item-title {{ $t('editor:markup.paragraph') }}
                v-list-item(v-for='level in 6', :key='level', :active='currentBlock.level === level', @click='setHeading(level)')
                  template(v-slot:prepend)
                    v-icon {{ $t(`editor:editor.mdiFormatHeader`, { level, interpolation: { escapeValue: false } }) }}
                  v-list-item-title {{ $t('editor:markup.heading', { level }) }}
            v-menu(v-else-if='toolId === `codeBlock`')
              template(v-slot:activator='{ props: menuProps }')
                v-btn.editor-tiptap-tool.editor-tool(
                  v-bind='menuProps'
                  icon
                  size='small'
                  variant='text'
                  :class='{ "is-active": isActive(`codeBlock`) }'
                  :aria-label='toolLabel(toolId)'
                )
                  v-icon {{ tools.codeBlock.icon }}
                  v-tooltip(activator='parent', location='bottom') {{ toolLabel(toolId) }}
              v-list.editor-tiptap-menu-list(density='compact')
                v-list-item(v-for='language in codeBlockLanguages', :key='language.value', @click='setCodeBlock(language.value)')
                  template(v-slot:prepend)
                    v-icon mdi-code-tags
                  v-list-item-title {{language.label}}
            v-menu(v-else-if='toolId === `table`')
              template(v-slot:activator='{ props: menuProps }')
                v-btn.editor-tiptap-tool.editor-tool(
                  v-bind='menuProps'
                  icon
                  size='small'
                  variant='text'
                  :class='{ "is-active": isActive(`table`) }'
                  :aria-label='toolLabel(toolId)'
                )
                  v-icon {{ tools.table.icon }}
                  v-tooltip(activator='parent', location='bottom') {{ toolLabel(toolId) }}
              v-list.editor-tiptap-menu-list(density='compact')
                v-list-item(@click='insertTable')
                  template(v-slot:prepend)
                    v-icon mdi-table-plus
                  v-list-item-title {{ $t('editor:markup.insertTable') }}
                template(v-if='isActive(`table`)')
                  v-list-item(@click='editor?.chain().focus().addColumnAfter().run()')
                    v-list-item-title {{ $t('editor:markup.addColumn') }}
                  v-list-item(@click='editor?.chain().focus().addRowAfter().run()')
                    v-list-item-title {{ $t('editor:markup.addRow') }}
                  v-list-item(@click='editor?.chain().focus().mergeOrSplit().run()')
                    v-list-item-title {{ $t('editor:markup.mergeOrSplit') }}
                  v-list-item.wiki-purpose-control(data-purpose='error', @click='editor?.chain().focus().deleteTable().run()')
                    v-list-item-title {{ $t('editor:markup.deleteTable') }}
            v-btn.editor-tiptap-tool.editor-tool(
              v-else
              icon
              size='small'
              variant='text'
              :aria-label='toolLabel(toolId)'
              :aria-pressed='toolPressed(toolId)'
              :aria-disabled='toolUnavailable(toolId) ? `true` : undefined'
              @click='runTool(toolId)'
            )
              v-icon {{ tools[toolId].icon }}
              v-tooltip(activator='parent', location='bottom') {{ toolTooltipText(toolId) }}
        v-btn.editor-tiptap-source-trigger.editor-tool(v-if='hasSourceSelection', variant='text', size='small', @click='openSourceDialog')
          v-icon(start) mdi-code-block-tags
          | {{ $t('editor:markup.editSource') }}
    .editor-tiptap-markdown-tools(
      v-if='format === `markdown`'
      role='toolbar'
      :aria-label='$t(`editor:markup.insertTools`)'
      v-roving-toolbar='{ onEscape: focusEditor }'
    )
      .editor-tiptap-insert-label(aria-hidden='true')
        v-icon(size='18') mdi-plus-circle-outline
        span {{ $t('editor:markup.insertGroup') }}
      v-btn.editor-tiptap-insert-button.editor-tiptap-extension-trigger.editor-tool(variant='text', size='small', :aria-pressed='activeModal === `editorModalBlocks`', :aria-label='$t(`editor:markup.insertContentExtension`)', @click='toggleExtensionDialog')
        v-icon(start) {{ tools.contentExtension.icon }}
        | {{ $t('editor:markup.contentExtensionShort') }}
      v-btn.editor-tiptap-insert-button.editor-tool(variant='text', size='small', :aria-label='$t(`editor:markup.insertAdmonition`)', @click='openAdmonitionDialog')
        v-icon(start) mdi-alert-box-outline
        | {{ $t('editor:markup.admonitionShort') }}
      v-btn.editor-tiptap-insert-button.editor-tool(variant='text', size='small', :aria-label='$t(`editor:markup.insertDefinitionList`)', @click='insertDefinitionList')
        v-icon(start) {{ tools.definitionList.icon }}
        | {{ $t('editor:markup.definitionListShort') }}
      v-menu(v-model='glyphMenuOpen', :close-on-content-click='false', location='bottom end', :offset='8', :activator-props='glyphMenuActivatorProps', :content-props='glyphMenuContentProps')
        template(v-slot:activator='{ props }')
          v-btn.editor-tiptap-insert-button.editor-tool(v-bind='props', variant='text', size='small', :aria-label='$t(`editor:markup.insertGlyph`)')
            v-icon(start) mdi-emoticon-outline
            | {{ $t('editor:markup.glyphShort') }}
            v-icon(end, size='16') mdi-chevron-down
        v-card.editor-tiptap-glyph-menu(elevation='5', width='420')
          .editor-tiptap-glyph-header
            div
              #editor-tiptap-glyph-title.text-body-large.font-weight-bold {{ $t(`editor:editor.iconsEmoji`) }}
              .text-body-small {{ $t(`editor:editor.searchNameMeaningClose`) }}
            v-btn.wiki-close-control.wiki-purpose-control(icon, size='small', data-purpose='error', variant='text', :aria-label='$t(`editor:editor.closeIconEmojiPicker`)', @click='glyphMenuOpen = false')
              v-icon mdi-close
          v-card-text.editor-tiptap-glyph-body
            v-text-field.editor-tiptap-glyph-search(
              v-model='glyphQuery'
              autofocus
              clearable
              density='compact'
              hide-details
              prepend-inner-icon='mdi-magnify'
              :placeholder='$t(`editor:editor.tryCelebrteDeploySecure`)'
              :aria-label='$t(`editor:editor.searchIconsEmoji`)'
              variant='outlined'
            )
            v-btn-toggle.editor-tiptap-glyph-filters.mt-3(
              v-model='glyphCategory'
              density='compact'
              divided
              mandatory
              variant='outlined'
              :aria-label='$t(`editor:editor.iconEmojiCategory`)'
            )
              v-btn.wiki-purpose-control(data-purpose='success', value='all') {{ $t(`editor:editor.all`) }}
              v-btn.wiki-purpose-control(data-purpose='success', value='icon')
                v-icon(start) mdi-shape-outline
                | {{ $t(`editor:editor.icons`) }}
              v-btn.wiki-purpose-control(data-purpose='success', value='emoji')
                v-icon(start) mdi-emoticon-outline
                | {{ $t(`editor:editor.emoji`) }}
            .editor-tiptap-glyph-grid.mt-3(v-if='filteredGlyphs.length > 0')
              v-btn.editor-tiptap-glyph-button.wiki-purpose-control(
                v-for='glyph in filteredGlyphs'
                :key='`${glyph.category}:${glyph.label}`'
                icon
                variant='text'
                :aria-label='$t(`editor:editor.insert`, { label: glyph.label, interpolation: { escapeValue: false } })'
                :title='glyph.label'
                @click='insertGlyph(glyph)'
                data-purpose='success'
              )
                span {{glyph.value}}
            .editor-tiptap-glyph-empty(v-else)
              v-icon(size='32') mdi-emoticon-sad-outline
              .text-body-medium {{ $t(`editor:editor.noMatchingIconsEmoji`) }}
              .text-body-small {{ $t(`editor:editor.tryShorterWordAnother`) }}
          .editor-tiptap-glyph-footer
            span {{ $t(`editor:editor.of`, { filteredGlyphsCount: filteredGlyphs.length, glyphsCount: glyphs.length, interpolation: { escapeValue: false } }) }}
            span {{ $t(`editor:editor.fuzzySearch`) }}
    .editor-pane-label {{ $t('editor:editor.tiptap', { label: definition.label, interpolation: { escapeValue: false } }) }}
    .editor-tiptap-page-canvas.editor-page-canvas
      editor-content.contents(:editor='editor ?? undefined')
    .v-system-bar.editor-status-bar.editor-tiptap-sysbar
      .text-body-small.editor-tiptap-sysbar-locale {{locale.toUpperCase()}}
      .text-body-small.editor-tiptap-sysbar-path.px-3 /{{path}}
        v-tooltip(activator='parent', location='top') /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small {{ $t(`editor:editor.tiptap`, { label: definition.label, interpolation: { escapeValue: false } }) }}
        v-spacer
        .text-body-small {{$t('editor:ckeditor.stats', { chars: stats.characters, words: stats.words })}}
    editor-conflict(v-model='isConflict', v-if='isConflict')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
    v-dialog(v-model='admonitionDialog', max-width='620', persistent, aria-labelledby='editor-tiptap-admonition-title')
      v-card
        v-card-title#editor-tiptap-admonition-title {{ $t(`editor:editor.insertAdmonition`) }}
        v-card-text
          v-form(@submit.prevent='insertAdmonition')
            v-select(v-model='admonitionKind', :items='admonitionKinds', :label='$t(`editor:editor.type`)')
            v-text-field.mt-3(v-model='admonitionTitle', :label='$t(`editor:editor.title`)', counter='120', required)
            v-textarea.mt-3(v-model='admonitionBody', :label='$t(`editor:editor.content`)', rows='5', auto-grow, counter='5000', required)
            v-alert.mt-3(v-if='admonitionError', type='error', variant='tonal') {{admonitionError}}
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='admonitionDialog = false') {{ $t('common:actions.cancel') }}
          v-btn(color='primary', variant='flat', :disabled='!isAdmonitionValid', @click='insertAdmonition') {{ $t('common:actions.insert') }}
    v-dialog(v-model='sourceDialog', max-width='760', persistent, aria-labelledby='editor-tiptap-source-title')
      v-card
        v-card-title#editor-tiptap-source-title {{ $t(`editor:editor.editPreservedSource`, { sourceKind, interpolation: { escapeValue: false } }) }}
        v-card-text
          .text-body-small.mb-3 {{ $t(`editor:editor.constructStoredVerbatimBecause`) }}
          v-textarea(v-model='sourceValue', rows='12', auto-grow, spellcheck='false', :label='$t(`editor:editor.source`)')
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='sourceDialog = false') {{ $t('common:actions.cancel') }}
          v-btn(color='primary', variant='flat', @click='saveSourceNode') {{ $t('common:actions.apply') }}
</template>

<script lang='ts'>
import {
  Editor,
  EditorContent,
  type EditorEvents,
  type JSONContent
} from '@tiptap/vue-3'
import { defineComponent, markRaw, type PropType, type Raw } from 'vue'
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
import { contentExtensionFenceBody } from '../../../helpers/content-extension-insertion'
import { EditorAdapterController } from '../common/editor-adapter'
import { FORMATTING_TOOLS, toolTooltip, type FormattingToolId } from '../common/formatting-tools'
import { vRovingToolbar } from '../common/roving-toolbar'
import { WIKI_LINKS_DISABLED, type WikiLinkOptions } from '../../../../shared/wikilinks.ts'

/* global siteLangs */

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>
type EditorEventInstance = EditorEvents['update']['editor']
type EditorHost = HTMLElement & { __wikiEditor?: Editor }
type SourceNodeName = 'wikiSourceBlock' | 'wikiSourceInline'

type TiptapToolbarGroup = {
  id: string
  labelKey: string
  tools: FormattingToolId[]
}

type CurrentBlock = {
  kind: 'paragraph' | 'heading' | 'codeBlock' | 'other'
  level: number
  label: string
  icon: string
}

// Tiptap mark/node names for tools whose pressed state the editor can report.
const TIPTAP_ACTIVE_NAMES: Partial<Record<FormattingToolId, string>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strike',
  highlight: 'highlight',
  subscript: 'subscript',
  superscript: 'superscript',
  keyboardKey: 'keyboard',
  inlineCode: 'code',
  link: 'link',
  unorderedList: 'bulletList',
  orderedList: 'orderedList',
  taskList: 'taskList',
  blockquote: 'blockquote'
}

const TIPTAP_ALIGNMENTS: Partial<Record<FormattingToolId, 'left' | 'center' | 'right'>> = {
  alignLeft: 'left',
  alignCenter: 'center',
  alignRight: 'right'
}

type InsertLinkPayload = {
  id: number
  locale: string
  path: string
}

const CODE_BLOCK_LANGUAGES = Object.freeze([
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
] as const)
const ADMONITION_KIND_OPTIONS = Object.freeze([...ADMONITION_KINDS])
const GLYPH_MENU_ACTIVATOR_PROPS = Object.freeze({ 'aria-haspopup': 'dialog' })
const GLYPH_MENU_CONTENT_PROPS = Object.freeze({
  role: 'dialog',
  'aria-labelledby': 'editor-tiptap-glyph-title'
})


export default defineComponent({
  components: {
    EditorConflict,
    EditorContent
  },
  directives: {
    rovingToolbar: vRovingToolbar
  },
  emits: ['editor-adapter', 'editor-adapter-clear'],
  props: {
    format: {
      type: String as PropType<VisualEditorFormat>,
      required: true
    },
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    },
    wikiLinkOptions: {
      type: Object as PropType<WikiLinkOptions>,
      default: () => WIKI_LINKS_DISABLED
    }
  },
  data () {
    return {
      editorAdapter: null as EditorAdapterController | null,
      editor: null as Raw<Editor> | null,
      stats: { characters: 0, words: 0 } as VisualEditorStats,
      toolbarVersion: 0,
      tools: FORMATTING_TOOLS,
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
      admonitionKinds: ADMONITION_KIND_OPTIONS,
      glyphs: VISUAL_MARKDOWN_GLYPHS,
      glyphMenuOpen: false,
      glyphQuery: '',
      glyphCategory: 'all' as VisualMarkdownGlyphFilter,
      codeBlockLanguages: CODE_BLOCK_LANGUAGES.map(item => ({ ...item, label: this.$t(`editor:tiptapEditor.language_${item.value}`) })),
      glyphMenuActivatorProps: GLYPH_MENU_ACTIVATOR_PROPS,
      glyphMenuContentProps: GLYPH_MENU_CONTENT_PROPS
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
    toolbarGroups (): TiptapToolbarGroup[] {
      const markdown = this.format === 'markdown'
      const html = this.format === 'html'
      const text: FormattingToolId[] = ['heading', 'bold', 'italic']
      if (html) text.push('underline')
      text.push('strikethrough')
      if (markdown) text.push('highlight', 'subscript', 'superscript', 'keyboardKey', 'inlineCode')
      text.push('link')
      const lists: FormattingToolId[] = ['unorderedList', 'orderedList']
      if (markdown) lists.push('taskList')
      lists.push('outdent', 'indent')
      const blocks: FormattingToolId[] = ['blockquote', 'codeBlock', 'horizontalBar', 'table']
      if (html) blocks.push('alignLeft', 'alignCenter', 'alignRight')
      return [
        { id: 'history', labelKey: 'editor:markup.historyGroup', tools: ['undo', 'redo'] },
        { id: 'text', labelKey: 'editor:markup.textGroup', tools: text },
        { id: 'lists', labelKey: 'editor:markup.listGroup', tools: lists },
        { id: 'blocks', labelKey: 'editor:markup.structureGroup', tools: blocks }
      ]
    },
    /** Block type at the cursor, shown on the Style trigger instead of a fixed label. */
    currentBlock (): CurrentBlock {
      void this.toolbarVersion
      const editor = this.editor
      for (let level = 1; level <= 6; level++) {
        if (editor?.isActive('heading', { level })) {
          return { kind: 'heading', level, label: String(this.$t('editor:markup.heading', { level })), icon: `mdi-format-header-${level}` }
        }
      }
      if (editor?.isActive('codeBlock')) {
        return { kind: 'codeBlock', level: 0, label: String(this.$t('editor:markup.codeBlock')), icon: 'mdi-code-braces' }
      }
      if (editor?.isActive('paragraph')) {
        return { kind: 'paragraph', level: 0, label: String(this.$t('editor:markup.paragraph')), icon: 'mdi-format-paragraph' }
      }
      return { kind: 'other', level: 0, label: String(this.$t('editor:markup.textStyle')), icon: 'mdi-format-header-pound' }
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
    toolLabel (toolId: FormattingToolId): string {
      return String(this.$t(FORMATTING_TOOLS[toolId].labelKey))
    },
    toolTooltipText (toolId: FormattingToolId): string {
      if (toolId === 'undo' && !this.canUndo) return String(this.$t('editor:markup.nothingToUndo'))
      if (toolId === 'redo' && !this.canRedo) return String(this.$t('editor:markup.nothingToRedo'))
      return toolTooltip(this.toolLabel(toolId), FORMATTING_TOOLS[toolId])
    },
    toolPressed (toolId: FormattingToolId): boolean | undefined {
      const alignment = TIPTAP_ALIGNMENTS[toolId]
      if (alignment) return this.isTextAligned(alignment)
      const name = TIPTAP_ACTIVE_NAMES[toolId]
      return name ? this.isActive(name) : undefined
    },
    toolUnavailable (toolId: FormattingToolId): boolean {
      if (toolId === 'undo') return !this.canUndo
      if (toolId === 'redo') return !this.canRedo
      return false
    },
    runTool (toolId: FormattingToolId) {
      // Empty Undo/Redo stay focusable so the tooltip can explain why nothing happens.
      if (this.toolUnavailable(toolId)) return
      const chain = () => this.editor?.chain().focus()
      const alignment = TIPTAP_ALIGNMENTS[toolId]
      if (alignment) {
        chain()?.setTextAlign(alignment).run()
        return
      }
      switch (toolId) {
        case 'undo': chain()?.undo().run(); break
        case 'redo': chain()?.redo().run(); break
        case 'bold': chain()?.toggleBold().run(); break
        case 'italic': chain()?.toggleItalic().run(); break
        case 'underline': chain()?.toggleUnderline().run(); break
        case 'strikethrough': chain()?.toggleStrike().run(); break
        case 'highlight': chain()?.toggleHighlight().run(); break
        case 'subscript': chain()?.toggleSubscript().run(); break
        case 'superscript': chain()?.toggleSuperscript().run(); break
        case 'keyboardKey': chain()?.toggleMark('keyboard').run(); break
        case 'inlineCode': chain()?.toggleCode().run(); break
        case 'link': this.insertLink(); break
        case 'unorderedList': chain()?.toggleBulletList().run(); break
        case 'orderedList': chain()?.toggleOrderedList().run(); break
        case 'taskList': chain()?.toggleTaskList().run(); break
        case 'outdent': this.liftListItem(); break
        case 'indent': this.sinkListItem(); break
        case 'blockquote': chain()?.toggleBlockquote().run(); break
        case 'horizontalBar': chain()?.setHorizontalRule().run(); break
        default: break
      }
    },
    focusEditor () {
      this.editor?.commands.focus()
    },
    isActive (name: string, attributes?: Record<string, unknown>): boolean {
      void this.toolbarVersion
      return this.editor?.isActive(name, attributes) ?? false
    },
    isTextAligned (alignment: 'left' | 'center' | 'right'): boolean {
      void this.toolbarVersion
      return this.editor?.isActive({ textAlign: alignment }) ?? false
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
        insertVisualMarkdownAdmonition(this.editor, {
          kind: this.admonitionKind,
          title: this.admonitionTitle,
          body: this.admonitionBody
        })
        this.admonitionDialog = false
        this.admonitionTitle = ''
        this.admonitionBody = ''
      } catch (err) {
        this.admonitionError = err instanceof Error ? err.message : this.$t('editor:editor.admonitionCouldNotInserted')
      }
    },
    insertDefinitionList () {
      if (this.editor) insertVisualMarkdownDefinitionList(this.editor)
    },
    insertGlyph (glyph: VisualMarkdownGlyph) {
      if (!this.editor) return
      try {
        insertVisualMarkdownGlyph(this.editor, glyph)
        this.glyphMenuOpen = false
        this.glyphQuery = ''
      } catch (err) {
        wikiStore.showNotification({
          message: err instanceof Error ? err.message : this.$t('editor:editor.iconEmojiCouldNot'),
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
      if (this.editor) this.syncFromEditor(this.editor)
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
                message: err instanceof Error ? err.message : this.$t('editor:editor.contentExtensionCouldNot'),
                style: 'warning',
                icon: 'warning'
              })
            }
          }
          break
      }
    },
    flushEligibleEditorText () {
      const editor = this.editor
      if (!editor) return
      this.syncFromEditor(editor)
      this.editorAdapter?.notifyState()
    },
    clearEditorText () {
      const editor = this.editor
      if (!editor) return
      editor.commands.setContent(this.preparedContent(''), {
        contentType: this.format,
        emitUpdate: false
      })
      this.syncFromEditor(editor)
    },
    syncFromEditor (editor: EditorEventInstance) {
      wikiStore.editor.content = serializeVisualEditorData(this.format, editor)
      this.stats = getVisualEditorStats(editor)
      this.toolbarVersion += 1
    }
  },
  mounted () {
    wikiStore.editor.editorKey = this.definition.editorKey
    const initialContent = this.preparedContent(wikiStore.editor.content)

    const editor = new Editor({
      content: initialContent,
      contentType: this.format,
      extensions: createTiptapExtensions(this.format, this.wikiLinkOptions),
      autofocus: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': this.$t('editor:editor.documentEditor', { label: this.definition.label, interpolation: { escapeValue: false } }),
          'aria-multiline': 'true'
        },
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
        this.syncFromEditor(editor)
        this.editorAdapter?.noteTextChange()
      },
      onSelectionUpdate: () => {
        this.toolbarVersion += 1
      }
    })
    this.editor = markRaw(editor)
    const adapter = new EditorAdapterController({
      readText: () => serializeVisualEditorData(this.format, editor),
      writeText: text => {
        editor.commands.setContent(this.preparedContent(text), {
          contentType: this.format,
          emitUpdate: false
        })
        this.syncFromEditor(editor)
      },
      clearText: () => this.clearEditorText(),
      flushText: () => this.flushEligibleEditorText()
    })
    this.editorAdapter = markRaw(adapter)
    adapter.initialize()
    this.$emit('editor-adapter', adapter)
    const root = this.$refs.root
    if (root instanceof HTMLElement) {
      Object.defineProperty(root as EditorHost, '__wikiEditor', {
        configurable: true,
        value: editor
      })
    }

    onEditorInsert(this.handleEditorInsert)
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount () {
    const adapter = this.editorAdapter
    if (adapter) {
      this.$emit('editor-adapter-clear', adapter)
      adapter.destroy()
      this.editorAdapter = null
    }
    offEditorInsert(this.handleEditorInsert)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    const root = this.$refs.root
    if (root instanceof HTMLElement) delete (root as EditorHost).__wikiEditor
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
  --editor-border: var(--wiki-surface-border);
  --editor-muted: var(--wiki-text-muted);
  background: rgb(var(--v-theme-background));
  color: var(--editor-on-surface);
  display: flex;
  flex: 1 1 auto;
  flex-flow: column nowrap;
  height: 100%;
  min-height: 0;
  position: relative;

  &-toolbar {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    border-bottom: 1px solid var(--editor-border);
    background: var(--wiki-surface-raised) !important;
    box-shadow: none;
    scrollbar-color: rgba(var(--v-theme-on-surface), .18) transparent;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;

    .v-toolbar__content {
      min-width: max-content;
      min-height: calc(var(--wiki-control-height) + var(--wiki-space-1));
      justify-content: flex-start;
      padding: var(--wiki-space-1) var(--wiki-space-3);

      @include until($tablet) {
        justify-content: flex-start;
        padding-inline: var(--wiki-space-2);
      }
    }
  }

  &-toolbar-inner {
    display: flex;
    width: max-content;
    align-items: center;
    gap: var(--wiki-space-1);
    margin-inline: 0;
  }

  &-toolbar-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding-inline: var(--wiki-space-1);
    border-inline-end: 1px solid var(--wiki-surface-border);
    background: transparent;
  }

  &-tool,
  &-style-trigger {
    height: 44px !important;
    margin: 0;
    border-radius: var(--wiki-control-radius) !important;
    letter-spacing: 0;


  }

  &-tool {
    width: 44px;
    min-width: 44px !important;
  }

  &-style-trigger {
    min-width: calc(var(--wiki-control-height) * 2);
    padding-inline: var(--wiki-space-2);
    text-transform: none;
  }

  &-source-trigger {
    border-radius: var(--wiki-control-radius) !important;
    text-transform: none;
  }

  &-markdown-tools {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-start;
    gap: var(--wiki-space-2);
    min-height: var(--wiki-control-height);
    padding: var(--wiki-space-1) var(--wiki-space-3);
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    border-bottom: 1px solid var(--editor-border);
    background: var(--wiki-surface-raised);
    scrollbar-color: rgba(var(--v-theme-on-surface), .18) transparent;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;

    @include until($tablet) {
      justify-content: flex-start;
      padding-inline: var(--wiki-space-2);
    }
  }

  &-insert-label {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--wiki-space-1);
    color: var(--editor-muted);
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  &-insert-button {
    flex: 0 0 auto;
    min-height: 44px;
    border-radius: var(--wiki-control-radius) !important;
    letter-spacing: 0;
    text-transform: none;


  }
  &-sysbar {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    background: var(--wiki-surface-raised) !important;
    border-top: 1px solid var(--editor-border);
    color: var(--editor-muted);
    flex: 0 0 calc(24px + env(safe-area-inset-bottom));
    min-height: calc(24px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: 0;
    &-locale {
      align-items: center;
      background: rgba(var(--v-theme-primary), .14);
      color: var(--wiki-accent-ink);
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

  > .editor-tiptap-page-canvas {
    position: relative;
    isolation: isolate;
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    margin: 0;
    padding: clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8));
    overflow-x: auto;
    overflow-y: auto;
    border: 0;
    border-radius: 0;
    background: var(--wiki-surface-raised);
    box-shadow: none;

    &:focus-within {
      outline: 2px solid var(--wiki-focus-color);
      outline-offset: -2px;
    }


    @include until($tablet) {
      padding: var(--wiki-space-4);
    }
  }

  .tiptap {
    max-width: 76ch;
    margin-inline: auto;
    min-height: 100%;
    caret-color: var(--wiki-accent-ink);
    outline: none;
    overflow-wrap: anywhere;

    ::selection {
      // Same selection token as the Markdown source editor (common/text-editor.ts).
      background: var(--wiki-editor-selection, color-mix(in srgb, color-mix(in srgb, rgb(var(--v-theme-primary)) 75%, rgb(var(--v-theme-on-surface))) 42%, transparent));
    }

    p.is-editor-empty:first-child::before {
      float: left;
      height: 0;
      color: var(--wiki-text-muted);
      content: attr(data-placeholder);
      pointer-events: none;
    }

    table .selectedCell {
      position: relative;

      &::after {
        position: absolute;
        inset: 0;
        background: color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
        content: '';
        pointer-events: none;
      }
    }

    ul[data-type='taskList'] {
      padding-inline-start: 0;
      list-style: none;

      li {
        display: flex;
        align-items: flex-start;
        gap: var(--wiki-space-2);

        > label {
          margin-block-start: var(--wiki-space-1);
        }

        > div {
          flex: 1;
        }
      }

      input[type='checkbox'] {
        accent-color: var(--editor-primary);
      }
    }

    wiki-source-block,
    wiki-source-inline {
      border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 36%, var(--wiki-surface-border));
      border-radius: var(--wiki-radius-xs);
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, var(--wiki-surface-sunken));
      color: inherit;
      cursor: pointer;
    }

    wiki-source-block {
      display: block;
      margin: var(--wiki-space-4) 0;
      padding: var(--wiki-space-3);
      overflow-x: auto;
      white-space: pre-wrap;

      .wiki-source-label {
        display: inline-block;
        margin: 0 var(--wiki-space-2) var(--wiki-space-1) 0;
        padding: 0 var(--wiki-space-1);
        border-radius: var(--wiki-radius-xs);
        background: color-mix(in srgb, var(--wiki-accent-warm) 82%, rgb(var(--v-theme-surface)));
        color: rgb(var(--v-theme-on-primary));
        font-size: .7em;
        font-weight: 700;
        text-transform: uppercase;
      }

      code {
        white-space: pre-wrap;
      }
    }

    wiki-source-inline {
      display: inline;
      padding: 0 var(--wiki-space-1);
      font-family: var(--wiki-font-mono);
      white-space: pre-wrap;
    }

    .ProseMirror-selectednode {
      box-shadow: 0 0 0 var(--wiki-space-1) color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, transparent);
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

  .text-body-small {
    color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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
  color: var(--wiki-text-muted);
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

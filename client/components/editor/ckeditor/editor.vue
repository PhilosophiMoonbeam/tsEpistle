<template lang='pug'>
  .editor-ckeditor
    div(ref='toolbarContainer')
    div.contents(ref='editor')
    v-system-bar.editor-status-bar.editor-ckeditor-sysbar(absolute, dark, status, color='grey darken-3')
      .caption.editor-ckeditor-sysbar-locale {{locale.toUpperCase()}}
      .caption.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .caption {{definition.label}}
        v-spacer
        .caption {{$t('editor:ckeditor.stats', { chars: stats.characters, words: stats.words })}}
    editor-conflict(v-model='isConflict', v-if='isConflict')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
import _ from 'lodash'
import { defineComponent, markRaw, type PropType } from 'vue'
import { DecoupledEditor } from 'ckeditor5'
import 'ckeditor5/ckeditor5.css'
import { wikiStore } from '@/store/index.ts'
import { findVisualMarkdownIssue } from '../../../../shared/visual-markdown.ts'
import EditorConflict from './conflict.vue'
import {
  createVisualEditorConfig,
  getVisualEditorDefinition,
  serializeVisualEditorData,
  type VisualEditorFormat,
  type VisualEditorStats
} from './editor-config.ts'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../../helpers/editor-insert-events'
import { onEditorLinkToPage, offEditorLinkToPage } from '../../../helpers/editor-link-events'

/* global siteLangs */

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>
type EditorMode = 'create' | 'update'

type InsertLinkPayload = {
  id: number
  locale: string
  path: string
}

export default defineComponent({
  components: {
    EditorConflict
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
  data() {
    return {
      editor: null as DecoupledEditor | null,
      syncContent: null as _.DebouncedFunc<() => void> | null,
      stats: {
        characters: 0,
        words: 0
      } as VisualEditorStats,
      isConflict: false,
      insertLinkDialog: false
    }
  },
  computed: {
    definition() {
      return getVisualEditorDefinition(this.format)
    },
    locale(): string {
      return wikiStore.page.locale
    },
    path(): string {
      return wikiStore.page.path
    },
    mode(): EditorMode {
      return wikiStore.editor.mode as EditorMode
    }
  },
  methods: {
    insertLink () {
      this.insertLinkDialog = true
    },
    insertLinkHandler ({ locale, path }: InsertLinkPayload) {
      this.editor?.execute('link', siteLangs.length > 0 ? `/${locale}/${path}` : `/${path}`)
    },
    handleEditorSaveConflict () {
      this.isConflict = true
    },
    handleEditorContentOverwrite () {
      this.editor?.setData(wikiStore.editor.content)
    },
    handleEditorLinkToPage () {
      this.insertLink()
    },
    handleEditorInsert (opts: EditorInsertPayload) {
      const editor = this.editor
      if (!editor) return

      switch (opts.kind) {
        case 'IMAGE':
          if (typeof opts.path === 'string') {
            editor.execute('imageInsert', { source: opts.path })
          }
          break
        case 'BINARY':
          if (typeof opts.path === 'string') {
            editor.execute('link', opts.path, this.format === 'html' ? { linkIsDownloadable: true } : {})
          }
          break
        case 'DIAGRAM':
          if (this.format === 'markdown') {
            wikiStore.showNotification({
              message: 'Diagrams are not supported by Visual Markdown. Use the Markdown source editor to preserve diagram syntax.',
              style: 'warning',
              icon: 'warning'
            })
          } else if (typeof opts.text === 'string') {
            editor.execute('imageInsert', { source: `data:image/svg+xml;base64,${opts.text}` })
          }
          break
      }
    }
  },
  async mounted () {
    if (this.format === 'markdown') {
      const issue = findVisualMarkdownIssue(wikiStore.editor.content)
      if (issue) {
        wikiStore.showNotification({
          message: `${issue.message} Found on line ${issue.line}. Opened the Markdown source editor instead.`,
          style: 'warning',
          icon: 'warning'
        })
        wikiStore.editor.editor = 'editorMarkdown'
        return
      }
    }

    wikiStore.editor.editorKey = this.definition.editorKey

    const editorElement = this.$refs.editor as HTMLElement
    const toolbarContainer = this.$refs.toolbarContainer as HTMLElement
    const editor = await DecoupledEditor.create(editorElement, createVisualEditorConfig(
      this.format,
      this.locale,
      stats => {
        this.stats = stats
      }
    ))
    this.editor = markRaw(editor)

    const toolbarElement = editor.ui.view.toolbar.element
    if (toolbarElement) toolbarContainer.appendChild(toolbarElement)

    if (this.mode !== 'create' || (this.format === 'markdown' && wikiStore.editor.content.length > 0)) {
      editor.setData(wikiStore.editor.content)
    }

    const updateContent = () => {
      wikiStore.editor.content = serializeVisualEditorData(this.format, editor.getData())
    }
    if (this.format === 'markdown') {
      editor.model.document.on('change:data', updateContent)
    } else {
      this.syncContent = _.debounce(updateContent, 300)
      editor.model.document.on('change:data', this.syncContent)
    }

    onEditorInsert(this.handleEditorInsert)
    onEditorLinkToPage(this.handleEditorLinkToPage)
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount () {
    this.syncContent?.cancel()
    offEditorInsert(this.handleEditorInsert)
    offEditorLinkToPage(this.handleEditorLinkToPage)
    offEditorSaveConflict(this.handleEditorSaveConflict)
    offEditorContentOverwrite(this.handleEditorContentOverwrite)
    if (this.editor) {
      void this.editor.destroy()
      this.editor = null
    }
  }
})
</script>

<style lang="scss">

$editor-height: calc(100vh - 64px - 24px);
$editor-height-mobile: calc(100vh - 56px - 16px);

.editor-ckeditor {
  background-color: mc('grey', '200');
  flex: 1 1 50%;
  display: flex;
  flex-flow: column nowrap;
  height: $editor-height;
  max-height: $editor-height;
  position: relative;

  @at-root .theme--dark & {
    background-color: mc('grey', '900');
  }

  @include until($tablet) {
    height: $editor-height-mobile;
    max-height: $editor-height-mobile;
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

  .contents {
    table {
      margin: inherit;
    }
    pre > code {
      background-color: unset;
      color: unset;
      padding: .15em;
    }
  }

  .ck.ck-toolbar {
    border: none;
    justify-content: center;
    background-color: mc('grey', '300');
    color: #FFF;
  }

  .ck.ck-toolbar__items {
    justify-content: center;
  }

  > .ck-editor__editable {
    background-color: mc('grey', '100');
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2rem;
    box-shadow: 0 0 5px hsla(0, 0%, 0%, .1);
    margin: 1rem auto 0;
    width: calc(100vw - 256px - 16vw);
    min-height: calc(100vh - 64px - 24px - 1rem - 40px);
    border-radius: 5px;

    @at-root .theme--dark & {
      background-color: #303030;
      color: #FFF;
    }

    @include until($widescreen) {
      width: calc(100vw - 2rem);
      margin: 1rem 1rem 0 1rem;
      min-height: calc(100vh - 64px - 24px - 1rem - 40px);
    }

    @include until($tablet) {
      width: 100%;
      margin: 0;
      min-height: calc(100vh - 56px - 24px - 76px);
      padding: 1rem;
    }

    &.ck.ck-editor__editable:not(.ck-editor__nested-editable).ck-focused {
      border-color: #FFF;
      box-shadow: 0 0 10px rgba(mc('blue', '700'), .25);

      @at-root .theme--dark & {
        border-color: #444;
        border-bottom: none;
        box-shadow: 0 0 10px rgba(#000, 0.25);
      }
    }

    &.ck .ck-editor__nested-editable.ck-editor__nested-editable_focused,
    &.ck .ck-editor__nested-editable:focus,
    .ck-widget.table td.ck-editor__nested-editable.ck-editor__nested-editable_focused,
    .ck-widget.table th.ck-editor__nested-editable.ck-editor__nested-editable_focused {
      background-color: mc('grey', '100');

      @at-root .theme--dark & {
        background-color: mc('grey', '900');
      }
    }
  }
}
</style>

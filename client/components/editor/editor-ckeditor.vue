<template lang='pug'>
  .editor-ckeditor
    div(ref='toolbarContainer')
    div.contents(ref='editor')
    v-system-bar.editor-status-bar.editor-ckeditor-sysbar(absolute, dark, status, color='grey darken-3')
      .caption.editor-ckeditor-sysbar-locale {{locale.toUpperCase()}}
      .caption.px-3 /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .caption Visual Editor
        v-spacer
        .caption {{$t('editor:ckeditor.stats', { chars: stats.characters, words: stats.words })}}
    editor-conflict(v-model='isConflict', v-if='isConflict')
    page-selector(mode='select', v-model='insertLinkDialog', :open-handler='insertLinkHandler', :path='path', :locale='locale')
</template>

<script lang='ts'>
import _ from 'lodash'
import { defineComponent, markRaw, type PropType } from 'vue'
import { wikiStore } from '@/store/index.ts'
import {
  Autoformat,
  BlockQuote,
  Bold,
  CodeBlock,
  DecoupledEditor,
  Essentials,
  Heading,
  Image,
  ImageCaption,
  ImageInsert,
  ImageResize,
  ImageStyle,
  ImageToolbar,
  Indent,
  IndentBlock,
  Italic,
  Link,
  List,
  ListProperties,
  Paragraph,
  PasteFromOffice,
  Strikethrough,
  Table,
  TableToolbar,
  Underline,
  WordCount
} from 'ckeditor5'
import 'ckeditor5/ckeditor5.css'
import { html as beautify } from 'js-beautify'
import EditorConflict from './ckeditor/conflict.vue'
import { onEditorSaveConflict, onEditorContentOverwrite, offEditorSaveConflict, offEditorContentOverwrite } from '../../helpers/editor-conflict-events'
import { onEditorInsert, offEditorInsert, type EditorInsertPayload } from '../../helpers/editor-insert-events'
import { onEditorLinkToPage, offEditorLinkToPage } from '../../helpers/editor-link-events'

/* global siteLangs */

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>

type EditorMode = 'create' | 'update'

type EditorStats = {
  characters: number
  words: number
}

type InsertLinkPayload = {
  id: number
  locale: string
  path: string
}

type LinkAttributes = {
  linkIsDownloadable: boolean
}

type ImageInsertOptions = {
  source: string
}


export default defineComponent({
  components: {
    EditorConflict
  },
  props: {
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    }
  },
  data() {
    return {
      editor: null as DecoupledEditor | null,
      stats: {
        characters: 0,
        words: 0
      } as EditorStats,
      isConflict: false,
      insertLinkDialog: false
    }
  },
  computed: {
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
      const content = wikiStore.editor.content
      this.editor?.setData(content)
    },
    handleEditorLinkToPage () {
      this.insertLink()
    },
    handleEditorInsert (opts: EditorInsertPayload) {
      const editor = this.editor
      if (!editor) {
        return
      }

      switch (opts.kind) {
        case 'IMAGE':
          if (typeof opts.path === 'string') {
            editor.execute('imageInsert', {
              source: opts.path
            })
          }
          break
        case 'BINARY':
          if (typeof opts.path === 'string') {
            editor.execute('link', opts.path, {
              linkIsDownloadable: true
            })
          }
          break
        case 'DIAGRAM':
          if (typeof opts.text === 'string') {
            editor.execute('imageInsert', {
              source: `data:image/svg+xml;base64,${opts.text}`
            })
          }
          break
      }
    }
  },
  async mounted () {
    wikiStore.editor.editorKey = 'ckeditor'

    const editorElement = this.$refs.editor as HTMLElement
    const toolbarContainer = this.$refs.toolbarContainer as HTMLElement
    const editor = await DecoupledEditor.create(editorElement, {
      licenseKey: 'GPL',
      plugins: [
        Essentials,
        Paragraph,
        Heading,
        Bold,
        Italic,
        Underline,
        Strikethrough,
        Link,
        List,
        ListProperties,
        BlockQuote,
        CodeBlock,
        Image,
        ImageInsert,
        ImageCaption,
        ImageResize,
        ImageStyle,
        ImageToolbar,
        Table,
        TableToolbar,
        WordCount,
        Autoformat,
        Indent,
        IndentBlock,
        PasteFromOffice
      ],
      toolbar: {
        items: [
          'undo',
          'redo',
          '|',
          'heading',
          '|',
          'bold',
          'italic',
          'underline',
          'strikethrough',
          'link',
          '|',
          'bulletedList',
          'numberedList',
          'outdent',
          'indent',
          '|',
          'blockQuote',
          'codeBlock',
          'insertTable'
        ]
      },
      image: {
        toolbar: ['imageTextAlternative', 'toggleImageCaption', 'imageStyle:inline', 'imageStyle:block', 'imageStyle:side']
      },
      table: {
        contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells']
      },
      link: {
        addTargetToExternalLinks: true,
        decorators: {
          isDownloadable: {
            mode: 'manual',
            label: 'Downloadable',
            attributes: {
              download: 'download'
            }
          }
        }
      },
      language: this.locale,
      placeholder: 'Type the page content here',
      wordCount: {
        onUpdate: stats => {
          this.stats = stats
        }
      }
    })
    this.editor = markRaw(editor)
    const toolbarElement = editor.ui.view.toolbar.element
    if (toolbarElement) {
      toolbarContainer.appendChild(toolbarElement)
    }

    if (this.mode !== 'create') {
      editor.setData(wikiStore.editor.content)
    }

    editor.model.document.on('change:data', _.debounce(() => {
      wikiStore.editor.content = beautify(editor.getData(), { indent_size: 2, end_with_newline: true })
    }, 300))

    onEditorInsert(this.handleEditorInsert)
    onEditorLinkToPage(this.handleEditorLinkToPage)

    // Handle save conflict
    onEditorSaveConflict(this.handleEditorSaveConflict)
    onEditorContentOverwrite(this.handleEditorContentOverwrite)
  },
  beforeUnmount () {
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
    }

    &.ck.ck-editor__editable:not(.ck-editor__nested-editable).ck-focused {
      border-color: #FFF;
      box-shadow: 0 0 10px rgba(mc('blue', '700'), .25);

      @at-root .theme--dark & {
        border-color: #444;
        border-bottom: none;
        box-shadow: 0 0 10px rgba(#000, .25);
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

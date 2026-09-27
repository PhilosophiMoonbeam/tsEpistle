<template lang='pug'>
  tiptap-editor(:key='wikiLinkOptionsKey', format='markdown', :save='save', :wiki-link-options='wikiLinkOptions', @editor-adapter='forwardAdapter', @editor-adapter-clear='forwardAdapterClear')
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import TiptapEditor from './tiptap/editor.vue'
import type { EditorAdapter } from './common/editor-adapter'
import { WIKI_LINKS_DISABLED, type WikiLinkOptions } from '../../../shared/wikilinks.ts'

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>

export default defineComponent({
  components: {
    TiptapEditor
  },
  emits: ['editor-adapter', 'editor-adapter-clear'],
  props: {
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    },
    wikiLinkOptions: {
      type: Object as PropType<WikiLinkOptions>,
      default: () => WIKI_LINKS_DISABLED
    }
  },
  computed: {
    wikiLinkOptionsKey(): string {
      return JSON.stringify(this.wikiLinkOptions)
    }
  },
  methods: {
    forwardAdapter(adapter: EditorAdapter) {
      this.$emit('editor-adapter', adapter)
    },
    forwardAdapterClear(adapter: EditorAdapter) {
      this.$emit('editor-adapter-clear', adapter)
    }
  }
})
</script>

<template lang='pug'>
  tiptap-editor(format='markdown', :save='save', @editor-adapter='forwardAdapter', @editor-adapter-clear='forwardAdapterClear')
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import TiptapEditor from './tiptap/editor.vue'
import type { EditorAdapter } from './common/editor-adapter'

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

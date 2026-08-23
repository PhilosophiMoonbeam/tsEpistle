<template lang='pug'>
  tiptap-editor(format='markdown', :save='save')
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import TiptapEditor from './tiptap/editor.vue'

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>

export default defineComponent({
  components: {
    TiptapEditor
  },
  props: {
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    }
  }
})
</script>

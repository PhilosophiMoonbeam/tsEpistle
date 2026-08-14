<template lang='pug'>
  ckeditor-editor(format='markdown', :save='save')
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import CkeditorEditor from './ckeditor/editor.vue'

type EditorSaveOptions = {
  rethrow?: boolean
  overwrite?: boolean
}

type EditorSaveHandler = (options?: EditorSaveOptions) => void | Promise<void>

export default defineComponent({
  components: {
    CkeditorEditor
  },
  props: {
    save: {
      type: Function as PropType<EditorSaveHandler>,
      default: () => {}
    }
  }
})
</script>

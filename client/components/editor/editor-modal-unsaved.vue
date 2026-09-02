<template lang="pug">
  v-dialog(v-model='isShown', max-width='550', role='alertdialog', aria-labelledby='unsaved-dialog-title', aria-describedby='unsaved-dialog-description')
    v-card
      .dialog-header.is-short.is-red
        v-icon.mr-2(color='white', aria-hidden='true') mdi-alert
        span#unsaved-dialog-title {{$t('editor:unsaved.title')}}
      v-card-text.pt-4#unsaved-dialog-description
        .text-body-medium {{$t('editor:unsaved.body')}}
      v-card-chin
        v-spacer
        v-btn(variant="text", @click='isShown = false') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='red', @click='discard') {{$t('common:actions.discardChanges')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'

export default defineComponent({
  emits: ['discard', 'update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  methods: {
    discard() {
      this.isShown = false
      this.$emit('discard', true)
    }
  }
})
</script>

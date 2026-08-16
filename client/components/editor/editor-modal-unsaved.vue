<template lang="pug">
  v-dialog(v-model='isShown', max-width='550')
    v-card
      .dialog-header.is-short.is-red
        v-icon.mr-2(color='white') mdi-alert
        span {{$t('editor:unsaved.title')}}
      v-card-text.pt-4
        .text-body-medium {{$t('editor:unsaved.body')}}
      div.v-card-chin
        v-spacer
        v-btn(variant="text", @click='isShown = false') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='red', @click='discard') {{$t('common:actions.discardChanges')}}
</template>

<script lang='ts'>

export default {
  emits: ['discard', 'update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return { }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  methods: {
    async discard() {
      this.isShown = false
      this.$emit('discard', true)
    }
  }
}
</script>

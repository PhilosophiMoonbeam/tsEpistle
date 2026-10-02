<template lang="pug">
  v-dialog(v-model='isShown', :persistent='busy || discarding', max-width='550', role='alertdialog', aria-labelledby='unsaved-dialog-title', aria-describedby='unsaved-dialog-description')
    v-card(:aria-busy='busy || discarding')
      .dialog-header.is-short.is-red
        v-icon.me-2(color='white', aria-hidden='true') mdi-alert
        span#unsaved-dialog-title {{$t('editor:unsaved.title')}}
      v-card-text.pt-4#unsaved-dialog-description
        .text-body-medium {{$t('editor:unsaved.body')}}
      v-alert.mt-4(
        v-if='error'
        type='error'
        variant='tonal'
        role='alert'
        aria-live='polite'
      ) {{error}}
      //- The destructive action sits apart at the start; each busy action shows its own spinner.
      v-card-chin
        v-btn.px-4.editor-unsaved-discard(
          color='error'
          variant='text'
          prepend-icon='mdi-delete-outline'
          :loading='discarding'
          :disabled='busy || discarding'
          @click='discard'
        ) {{$t('common:actions.discardChanges')}}
        v-spacer
        v-btn(variant="text", :disabled='busy || discarding', @click='isShown = false') {{$t('common:actions.cancel')}}
        v-btn.px-4(
          color='primary'
          variant='flat'
          :loading='busy'
          :disabled='busy || discarding'
          @click='save'
        ) {{$t('editor:save.saveAndClose')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'

export default defineComponent({
  emits: ['discard', 'save', 'update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    busy: {
      type: Boolean,
      default: false
    },
    error: {
      type: String,
      default: ''
    },
    discarding: {
      type: Boolean,
      default: false
    }
  },
  data () {
    return {
      returnFocus: null as HTMLElement | null
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  mounted () {
    this.returnFocus = document.activeElement as HTMLElement | null
  },
  beforeUnmount () {
    const target = this.returnFocus
    queueMicrotask(() => {
      if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert], [aria-hidden="true"]')) {
        target.focus({ preventScroll: true })
      }
    })
  },
  methods: {
    discard() {
      this.$emit('discard')
    },
    save() {
      this.$emit('save')
    }
  }
})
</script>

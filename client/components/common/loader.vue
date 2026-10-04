<template lang='pug'>
  v-dialog(
    :model-value='modelValue'
    :persistent='mode === `loading`'
    max-width='380'
    :aria-labelledby='titleId'
    :aria-describedby='subtitleId'
    @update:model-value='updateModelValue'
  )
    v-card.loader-dialog
      v-card-text.text-center
        .loader-dialog-illustration(v-if='$slots.illustration')
          slot(name='illustration')
        v-progress-circular.loader-dialog-progress(
          v-else-if='mode === `loading`'
          indeterminate
          :size='32'
          :width='3'
          :color='color'
          aria-hidden='true'
        )
        img(v-else-if='mode === `icon`', :src='`/_assets/svg/icon-` + icon + `.svg`', alt='', aria-hidden='true')
        .loader-dialog-message(
          role='status'
          aria-live='polite'
          aria-atomic='true'
        )
          h2.loader-dialog-title(:id='titleId') {{ title }}
          p.loader-dialog-subtitle(:id='subtitleId') {{ subtitle }}
        v-btn.loader-dialog-close(
          v-if='mode === `icon`'
          variant='text'
          @click='close'
        ) {{$t('common:actions.close')}}
</template>

<script lang='ts'>
import { defineComponent, useId, type PropType } from 'vue'
import { translate } from '../../modules/localization.ts'

type LoaderMode = 'loading' | 'icon'

export default defineComponent({
  emits: {
    'update:modelValue': (value: boolean) => typeof value === 'boolean'
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    color: {
      type: String,
      default: 'blue-darken-3'
    },
    title: {
      type: String,
      default: 'Working...'
    },
    subtitle: {
      type: String,
      default: () => translate('common:loader.pleaseWait')
    },
    mode: {
      type: String as PropType<LoaderMode>,
      default: 'loading',
      validator: (value: string): value is LoaderMode => value === 'loading' || value === 'icon'
    },
    icon: {
      type: String,
      default: 'checkmark'
    }
  },
  setup() {
    const id = useId()
    return {
      titleId: `${id}-title`,
      subtitleId: `${id}-subtitle`
    }
  },
  methods: {
    close(): void {
      this.$emit('update:modelValue', false)
    },
    updateModelValue(value: boolean): void {
      this.$emit('update:modelValue', value)
    }
  }
})
</script>

<style lang='scss'>
.loader-dialog {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  box-shadow: var(--wiki-shadow-sm);
}
.loader-dialog .v-card-text { padding: var(--wiki-space-6) !important; }
.loader-dialog-illustration { display: flex; justify-content: center; margin-block-end: var(--wiki-space-3); }
.loader-dialog-progress, .loader-dialog img { width: 32px; height: 32px; margin-block-end: var(--wiki-space-3); }
.loader-dialog-title { font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere; }
.loader-dialog-subtitle { margin-block-start: var(--wiki-space-2); color: var(--wiki-text-muted); font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.loader-dialog-close { margin-block-start: var(--wiki-space-4); }
@media (max-width: 600px) { .loader-dialog-close { min-height: 44px; } }
</style>

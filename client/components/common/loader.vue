<template lang='pug'>
  v-dialog(
    :model-value='modelValue'
    :persistent='mode === `loading`'
    max-width='380'
    :scrim='color'
    style='--v-overlay-opacity: .68'
    :aria-labelledby='titleId'
    :aria-describedby='subtitleId'
    @update:model-value='updateModelValue'
  )
    v-card.loader-dialog(
      :color='color'
      role='status'
      aria-live='polite'
    )
      v-card-text.text-center
        atom-spinner.is-inline(
          v-if='mode === `loading`'
          :animation-duration='1000'
          :size='52'
          color='#FFF'
          aria-hidden='true'
          )
        img(v-else-if='mode === `icon`', :src='`/_assets/svg/icon-` + icon + `.svg`', alt='', aria-hidden='true')
        h2.loader-dialog-title(:id='titleId') {{ title }}
        p.loader-dialog-subtitle(:id='subtitleId') {{ subtitle }}
        v-btn.loader-dialog-close(
          v-if='mode === `icon`'
          variant='text'
          color='white'
          @click='close'
        ) {{$t('common:actions.close')}}
</template>

<script lang='ts'>
import { defineComponent, useId, type PropType } from 'vue'
import { AtomSpinner } from 'epic-spinners'

type LoaderMode = 'loading' | 'icon'

export default defineComponent({
  components: {
    AtomSpinner
  },
  emits: ['update:modelValue'],
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
      default: 'Please wait'
    },
    mode: {
      type: String as PropType<LoaderMode>,
      default: 'loading'
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
  overflow: hidden;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
  border-radius: var(--wiki-panel-radius, 18px) !important;
  box-shadow: 0 24px 72px color-mix(in srgb, rgb(var(--v-theme-on-surface)) 28%, transparent);
  transition: transform .22s ease, opacity .22s ease;

  .v-card-text {
    padding: 30px 24px 28px !important;
  }

  .atom-spinner.is-inline {
    display: inline-block;
    margin-bottom: 10px;
  }

  img {
    width: 72px;
    margin-bottom: 10px;
  }
}

.loader-dialog-title {
  color: rgb(var(--v-theme-on-surface));
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -.015em;
}

.loader-dialog-subtitle {
  margin-top: 3px;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  font-size: .82rem;
}

.loader-dialog-close {
  margin-top: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .loader-dialog {
    transition: none;
  }
}
</style>

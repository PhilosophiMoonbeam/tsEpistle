<template lang='pug'>
  v-dialog(:model-value='modelValue', persistent, max-width='380', :scrim='color', style='--v-overlay-opacity: .68')
    v-card.loader-dialog(:color='color', role='status', aria-live='polite', aria-busy='true')
      v-card-text.text-center
        atom-spinner.is-inline(
          v-if='mode === `loading`'
          :animation-duration='1000'
          :size='52'
          color='#FFF'
          )
        img(v-else-if='mode === `icon`', :src='`/_assets/svg/icon-` + icon + `.svg`', :alt='icon')
        .loader-dialog-title {{ title }}
        .loader-dialog-subtitle {{ subtitle }}
</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import { AtomSpinner } from 'epic-spinners'

type LoaderMode = 'loading' | 'icon'

export default defineComponent({
  components: {
    AtomSpinner
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
  }
})
</script>

<style lang='scss'>
.loader-dialog {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 18px !important;
  box-shadow: 0 24px 72px rgba(3, 7, 18, .28);
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
  color: #fff;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -.015em;
}

.loader-dialog-subtitle {
  margin-top: 3px;
  color: rgba(255, 255, 255, .7);
  font-size: .82rem;
}

@media (prefers-reduced-motion: reduce) {
  .loader-dialog {
    transition: none;
  }
}
</style>

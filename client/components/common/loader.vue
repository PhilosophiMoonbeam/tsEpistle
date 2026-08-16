<template lang='pug'>
  v-dialog(:model-value='modelValue', persistent, max-width='350', :scrim='color', style='--v-overlay-opacity: .7')
    v-card.loader-dialog.radius-7(:color='color')
      v-card-text.text-center.py-4
        atom-spinner.is-inline(
          v-if='mode === `loading`'
          :animation-duration='1000'
          :size='60'
          color='#FFF'
          )
        img(v-else-if='mode === `icon`', :src='`/_assets/svg/icon-` + icon + `.svg`', :alt='icon')
        .text-body-large.text-white {{ title }}
        .text-body-small {{ subtitle }}</template>

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
    transition: all .4s ease;

    .atom-spinner.is-inline {
      display: inline-block;
    }
    .caption {
      color: rgba(255,255,255,.7);
    }

    img {
      width: 80px;
    }
  }
</style>

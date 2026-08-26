<template lang='pug'>
  v-app
    .newpage
      .newpage-content
        img.animated.fadeIn(src='/_assets/svg/icon-file.svg', alt='')
        .text-headline-medium {{ $t('newpage.title') }}
        .text-body-large.mt-3 {{ $t('newpage.subtitle') }}
        .newpage-actions
          v-btn(:href='`/e/` + locale + `/` + path', size='large', color='primary', variant='flat')
            v-icon(start) mdi-plus
            span {{ $t('newpage.create') }}
          v-btn(color='primary', @click='goBack', variant='outlined', size='large')
            v-icon(start) mdi-arrow-left
            span {{ $t('newpage.goback') }}
</template>

<script lang='ts'>

export default {
  props: {
    locale: {
      type: String,
      default: 'en'
    },
    path: {
      type: String,
      default: 'home'
    }
  },
  methods: {
    goBack () {
      window.history.back()
    }
  }
}
</script>

<style lang='scss'>

</style>

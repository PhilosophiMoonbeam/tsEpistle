<template lang='pug'>
  v-app
    .newpage
      .newpage-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-file.svg', alt='Not Found')
        .text-headline-medium {{ $t('newpage.title') }}
        .text-body-large.mt-3 {{ $t('newpage.subtitle') }}
        v-btn.mt-5(:href='`/e/` + locale + `/` + path', size="x-large")
          v-icon(start) mdi-plus
          span {{ $t('newpage.create') }}
        v-btn.mt-5(color="purple-lighten-3", href='javascript:window.history.go(-1);', variant="outlined")
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
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>

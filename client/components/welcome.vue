<template lang='pug'>
  v-app
    .onboarding
      .onboarding-content
        img.animated.fadeIn(src='/_assets/svg/logo-tsfranki.svg', alt='tsFranki')
        .text-headline-medium.animated.fadeInUp {{ $t('welcome.title') }}
        .text-body-large.mt-3.animated.fadeInUp.wait-p1s {{ $t('welcome.subtitle') }}
        div
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p2s(color='primary', :href='`/e/` + locale + `/home`', size="x-large")
            v-icon(start) mdi-plus
            span {{ $t('welcome.createhome') }}
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p3s(color='primary', href='/a', size="x-large")
            v-icon(start) mdi-view-dashboard
            span {{ $t('welcome.goadmin') }}

</template>

<script lang='ts'>

export default {
  props: {
    locale: {
      type: String,
      default: 'en'
    }
  },
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>

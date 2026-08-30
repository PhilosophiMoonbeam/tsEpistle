<template lang='pug'>
  v-app
    main.onboarding
      .onboarding-content
        img.animated.fadeIn(src='/_assets/svg/logo-tsfranki.svg', alt='tsFranki')
        h1.text-headline-medium.animated.fadeInUp {{ $t('welcome.title') }}
        .text-body-large.mt-3.animated.fadeInUp.wait-p1s {{ $t('welcome.subtitle') }}
        div
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p2s(color='primary', :href='`/e/` + locale + `/home`', size="x-large")
            v-icon(start) mdi-plus
            span {{ $t('welcome.createhome') }}
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p3s(color='primary', variant='outlined', href='/a', size="x-large")
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

@media (max-height: 500px) and (min-width: 600px) {
  .onboarding {
    padding-block: var(--wiki-space-3);

    &-content {
      min-height: 0;
      height: calc(100dvh - var(--wiki-space-6));
      padding: var(--wiki-space-4) var(--wiki-space-6);
    }

    img {
      height: 96px;
      margin-bottom: var(--wiki-space-2);
    }

    .text-body-large {
      line-height: 1.3;
    }

    .v-btn.mt-5 {
      margin-top: var(--wiki-space-2) !important;
    }
  }
}
</style>

<template lang='pug'>
  v-app
    main.newpage
      .newpage-content
        img.animated.fadeIn(src='/_assets/svg/icon-file.svg', alt='')
        h1.text-headline-medium {{ $t('newpage.title') }}
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

@media (max-height: 500px) and (min-width: 600px) {
  .newpage {
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
  }
}
</style>

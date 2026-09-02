<template lang='pug'>
  v-app
    main.unauthorized
      .unauthorized-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-shield.svg', alt='')
        h1.text-headline-medium.ma-0 {{$t('unauthorized.title')}}
        .text-body-large.mt-3 {{$t('unauthorized.action.' + action)}}
        v-btn.mt-5(href='/login', size="x-large")
          v-icon(start) mdi-login
          span {{$t('unauthorized.login')}}
        v-btn.mt-5(color="primary", @click='goBack', variant="outlined")
          v-icon(start) mdi-arrow-left
          span {{$t('unauthorized.goback')}}
</template>

<script lang='ts'>

export default {
  props: {
    action: {
      type: String,
      default: 'view'
    }
  },
  methods: {
    goBack () {
      if (window.history.length > 1) {
        window.history.back()
        return
      }
      window.location.assign('/')
    }
  }
}
</script>


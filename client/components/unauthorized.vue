<template lang='pug'>
  v-app
    .unauthorized
      .unauthorized-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-shield.svg', alt='Unauthorized')
        .text-headline-medium {{$t('unauthorized.title')}}
        .text-body-large.mt-3 {{$t('unauthorized.action.' + action)}}
        v-btn.mt-5(href='/login', size="x-large")
          v-icon(start) mdi-login
          span {{$t('unauthorized.login')}}
        v-btn.mt-5(color="red-lighten-4", href='javascript:window.history.go(-1);', variant="outlined")
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
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>

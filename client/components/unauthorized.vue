<template lang='pug'>
  v-app
    main.unauthorized
      .unauthorized-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-shield.svg', alt='')
        h1.text-headline-medium.ma-0 {{$t('unauthorized.title')}}
        .text-body-large.mt-3 {{$t('unauthorized.action.' + action)}}
        v-btn.mt-5(href='/login', size="x-large", prepend-icon='mdi-login') {{$t('unauthorized.login')}}
        v-btn.mt-5(color="primary", @click='goBack', variant="outlined", prepend-icon='mdi-arrow-left') {{$t('unauthorized.goback')}}
</template>

<script setup lang='ts'>
const {
  action = 'view'
} = defineProps<{
  action?: string
}>()

const goBack = () => {
  if (window.history.length > 1) {
    window.history.back()
    return
  }
  window.location.assign('/')
}
</script>


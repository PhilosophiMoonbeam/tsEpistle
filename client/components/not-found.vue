<template lang='pug'>
  v-app
    .notfound
      .notfound-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-file.svg', alt='Not Found')
        .text-headline-medium {{$t('notfound.title')}}
        .text-body-large.mt-3 {{$t('notfound.subtitle')}}
        v-btn.mt-5(color="red-lighten-4", href='/', size="large", variant="outlined")
          v-icon(start) mdi-home
          span {{$t('notfound.gohome')}}
</template>

<script lang='ts'>

export default {
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>

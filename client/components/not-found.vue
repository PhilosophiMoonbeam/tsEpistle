<template lang='pug'>
  v-app
    main.notfound
      .notfound-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-file.svg', alt='')
        h1.text-headline-medium.ma-0 {{$t('notfound.title')}}
        .text-body-large.mt-3 {{$t('notfound.subtitle')}}
        v-btn.mt-5(color="primary", href='/', size="large", variant="tonal")
          v-icon(start) mdi-home
          span {{$t('notfound.gohome')}}
</template>


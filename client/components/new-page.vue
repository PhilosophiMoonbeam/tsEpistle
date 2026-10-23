<template lang='pug'>
  v-app
    main.newpage(aria-labelledby='newpage-title')
      .newpage-content
        .newpage-mark(aria-hidden='true')
          img(src='/_assets/svg/icon-file.svg', alt='')
        header.newpage-copy
          h1#newpage-title.text-headline-medium {{ $t('newpage.title') }}
          p.text-body-large.mt-3 {{ $t('newpage.subtitle') }}
        .newpage-path
          v-icon(size='small', aria-hidden='true') mdi-map-marker-path
          span.d-sr-only {{ $t('newpage.destination') }}
          code
            bdi(dir='ltr') /{{ locale }}/{{ path }}
        .newpage-actions(role='group', :aria-label='$t(`newpage.title`)')
          v-btn.newpage-action.newpage-action--create(
            :href='`/e/` + locale + `/` + path'
            size='large'
            color='primary'
            variant='flat'
            prepend-icon='mdi-plus'
          ) {{ $t('newpage.create') }}
          v-btn.newpage-action.newpage-action--back(
            color='primary'
            @click='goBack'
            variant='outlined'
            size='large'
            :prepend-icon='$vuetify.locale.isRtl ? "mdi-arrow-right" : "mdi-arrow-left"'
          ) {{ $t('newpage.goback') }}
        AuthorizedFolderChildren(:locale='locale', :path='path')
</template>

<script setup lang='ts'>
import AuthorizedFolderChildren from './common/authorized-folder-children.vue'
import { goBackOrHome } from '../helpers/state-page-actions'

const {
  locale = 'en',
  path = 'home'
} = defineProps<{
  locale?: string
  path?: string
}>()

const goBack = (): void => goBackOrHome('/')
</script>

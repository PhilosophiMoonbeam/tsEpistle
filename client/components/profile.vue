<template lang='pug'>
  v-app(:dark='$vuetify.theme.current.dark').profile
    nav-header
    v-navigation-drawer.pb-0(v-model='profileDrawerShown', app, fixed, clipped, left, permanent)
      v-list(dense, nav)
        v-list-item(to='/profile', color='primary')
          div.v-list-item-action: v-icon mdi-face-profile
          div.v-list-item-content
            v-list-item-title {{$t('profile:title')}}
        //- v-list-item(to='/preferences', disabled)
        //-   v-list-item-action: v-icon(color='grey lighten-1') mdi-cog-outline
        //-   v-list-item-content
        //-     v-list-item-title Preferences
        //-     v-list-item-subtitle.caption.grey--text.text--lighten-1 Coming soon
        v-list-item(to='/pages', color='primary')
          div.v-list-item-action: v-icon mdi-file-document-outline
          div.v-list-item-content
            v-list-item-title {{$t('profile:pages.title')}}
        //- v-list-item(to='/comments', disabled)
        //-   v-list-item-action: v-icon(color='grey lighten-1') mdi-message-reply-text
        //-   v-list-item-content
        //-     v-list-item-title {{$t('profile:comments.title')}}
        //-     v-list-item-subtitle.caption.grey--text.text--lighten-1 Coming soon

    v-main(:class='$vuetify.theme.current.dark ? "grey darken-4" : "grey lighten-5"')
      transition(name='profile-router')
        router-view

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'

export default {
  i18nOptions: { namespaces: 'profile' },
  data() {
    return {
      profileDrawerShown: true
    }
  },
  created() {
    wikiStore.page.mode = 'profile'
  }
}
</script>

<style lang='scss'>

.profile-router {
  &-enter-active, &-leave-active {
    transition: opacity .25s ease;
    opacity: 1;
  }
  &-enter-active {
    transition-delay: .25s;
  }
  &-enter, &-leave-to {
    opacity: 0;
  }
}

.profile-header {
  display: flex;
  justify-content: flex-start;
  align-items: center;

  &-title {
    margin-left: 1rem;
  }
}

</style>

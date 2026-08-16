<template lang='pug'>
  v-app().profile
    nav-header
    v-navigation-drawer.pb-0(v-model='profileDrawerShown', left, permanent)
      v-list(density="compact", nav)
        v-list-item(to='/profile', color='primary')
          template(v-slot:append): v-icon mdi-face-profile
          v-list-item-title {{$t('profile:title')}}
        v-list-item(to='/pages', color='primary')
          template(v-slot:append): v-icon mdi-file-document-outline
          v-list-item-title {{$t('profile:pages.title')}}

    v-main(:class='$vuetify.theme.current.dark ? "bg-grey-darken-4" : "bg-grey-lighten-5"')
      transition(name='profile-router')
        router-view

    nav-footer
    notify
    search-results</template>

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

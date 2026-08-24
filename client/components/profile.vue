<template lang='pug'>
  v-app().profile
    nav-header
      template(v-slot:actions)
        v-btn.profile-nav-toggle(
          v-if='$vuetify.display.smAndDown'
          icon
          @click='profileDrawerShown = !profileDrawerShown'
          :aria-expanded='profileDrawerShown'
          aria-controls='profile-navigation'
          aria-label='Profile navigation'
        )
          v-icon mdi-menu
    v-navigation-drawer#profile-navigation.pb-0.profile-sidebar(
      v-model='profileDrawerShown'
      :location="$vuetify.locale.isRtl ? 'right' : undefined"
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 320 : 256'
    )
      .profile-sidebar-mobile-header(v-if='$vuetify.display.smAndDown')
        .text-label-large Profile
        v-spacer
        v-btn(
          icon
          @click='profileDrawerShown = false'
          aria-label='Close profile navigation'
        )
          v-icon mdi-close
      v-list(density="compact", nav, role='navigation', aria-label='Profile sections')
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
import { defineComponent, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
import { wikiStore } from '@/store/index.ts'

export default defineComponent({
  i18nOptions: { namespaces: 'profile' },
  setup() {
    const { mdAndUp } = useDisplay()
    const profileDrawerShown = ref(mdAndUp.value)
    watch(mdAndUp, isDesktop => {
      profileDrawerShown.value = isDesktop
    })
    return { profileDrawerShown }
  },
  created() {
    wikiStore.page.mode = 'profile'
  },
  watch: {
    '$route.fullPath' () {
      if (this.$vuetify.display.smAndDown) {
        this.profileDrawerShown = false
      }
    }
  }
})
</script>

<style lang='scss'>

.profile-sidebar-mobile-header {
  display: flex;
  align-items: center;
  min-height: 56px;
  padding: 8px 12px 8px 24px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.profile-router {
  &-enter-active, &-leave-active {
    transition: opacity .25s ease;
    opacity: 1;
  }
  &-enter-active {
    transition-delay: .25s;
  }
  &-enter-from, &-leave-to {
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

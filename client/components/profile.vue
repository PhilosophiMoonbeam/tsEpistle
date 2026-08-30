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
        .text-label-large {{ $t('profile:workspace', { defaultValue: 'Profile' }) }}
        v-spacer
        v-btn(
          icon
          @click='profileDrawerShown = false'
          aria-label='Close profile navigation'
        )
          v-icon mdi-close
      nav.profile-navigation(aria-label='Profile sections')
        v-list(density="compact" nav)
          v-list-subheader.profile-navigation-label {{ $t('profile:workspace', { defaultValue: 'Your workspace' }) }}
          v-list-item(to='/profile' color='primary')
            template(v-slot:prepend): v-icon mdi-face-profile-outline
            v-list-item-title {{$t('profile:title')}}
          v-list-item(to='/pages' color='primary')
            template(v-slot:prepend): v-icon mdi-file-document-outline
            v-list-item-title {{$t('profile:pages.title')}}
    v-main.profile-main
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
.profile {
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;
}

.profile-sidebar {
  border-inline-end: 1px solid rgba(var(--v-border-color), .11) !important;
  background:
    linear-gradient(180deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, rgb(var(--v-theme-surface))) 0, rgb(var(--v-theme-surface)) 180px) !important;
}

.profile-sidebar-mobile-header {
  display: flex;
  min-height: 64px;
  align-items: center;
  padding: 8px 12px 8px 22px;
  border-bottom: 1px solid rgba(var(--v-border-color), .09);
}

.profile-navigation {
  display: block;
  padding: 18px 12px;

  .profile-navigation-label {
    margin: 0 10px 12px;
    padding: 0;
    color: rgb(var(--v-theme-primary));
    font-size: .66rem;
    font-weight: 760;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .v-list {
    background: transparent;
  }

  .v-list-item {
    min-height: 46px;
    margin-block: 3px;
    border-radius: 11px;
    color: rgb(var(--v-theme-on-surface));
    opacity: .74;

    &--active {
      background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, transparent);
      color: rgb(var(--v-theme-primary));
      font-weight: 670;
      opacity: 1;
    }
  }
}

.profile-main {
  background:
    radial-gradient(circle at 88% 0%, rgba(var(--v-theme-primary), .07), transparent 30rem),
    rgb(var(--v-theme-background));

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: 28px var(--wiki-page-gutter) 48px;
  }

  .profile-header {
    display: flex;
    min-height: 80px;
    align-items: center;
    margin-bottom: 14px;
    padding: 4px 2px;

    > img {
      width: 64px !important;
      height: 64px !important;
      padding: 9px;
      border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
      border-radius: 18px;
      background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
      box-shadow: 0 12px 30px rgba(var(--v-theme-primary), .1);
    }

    &-title {
      min-width: 0;
      margin-inline: 18px;

      > .text-headline-medium {
        color: rgb(var(--v-theme-on-surface)) !important;
        font-size: clamp(1.65rem, 2vw, 2.1rem) !important;
        font-weight: 720;
        letter-spacing: -.035em !important;
        line-height: 1.15;
      }

      > .text-body-large {
        margin-top: 5px;
        color: rgb(var(--v-theme-on-surface)) !important;
        font-size: .98rem !important;
        line-height: 1.45;
        opacity: .68;
      }
    }
  }

  .v-card:not(.v-card--flat) {
    overflow: hidden;
    border: 1px solid rgba(var(--v-border-color), .13);
    border-radius: 16px;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 97%, rgb(var(--v-theme-background)));
    box-shadow: 0 8px 28px rgba(20, 28, 50, .055);
  }

  .v-card > .v-toolbar {
    min-height: 56px;
    border-bottom: 1px solid rgba(var(--v-border-color), .09);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, rgb(var(--v-theme-surface))) !important;
    color: rgb(var(--v-theme-on-surface)) !important;

    .v-toolbar-title,
    .v-icon {
      color: rgb(var(--v-theme-on-surface)) !important;
    }
  }

  .v-list {
    padding-block: 6px;
  }

  .v-list-item {
    min-height: 58px;
  }

  .v-field {
    border-radius: 11px;
  }

  .v-btn:not(.v-btn--icon) {
    border-radius: 10px;
    font-weight: 650;
    text-transform: none;
  }
}

.profile-router {
  &-enter-active {
    transition: opacity .2s ease, transform .2s ease;
  }

  &-leave-active {
    position: absolute;
    transition: opacity .12s ease;
  }

  &-enter-from {
    opacity: 0;
    transform: translateY(5px);
  }

  &-leave-to {
    opacity: 0;
  }
}

@media (max-width: 959px) {
  .profile-main {
    > .v-container {
      padding: 20px 14px 42px;
    }

    .profile-header {
      flex-wrap: wrap;
      gap: 10px;
      min-height: auto;

      > img {
        width: 52px !important;
        height: 52px !important;
        border-radius: 15px;
      }

      &-title {
        flex: 1 1 calc(100% - 72px);
        margin-inline: 4px;

        > .text-headline-medium {
          font-size: 1.5rem !important;
        }
      }

      > .v-spacer {
        display: none;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .profile-router-enter-active,
  .profile-router-leave-active,
  .profile .animated {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    transition-delay: 0s !important;
  }
}
</style>

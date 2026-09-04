<template lang='pug'>
  v-app().profile
    nav-header
      template(v-slot:mobileBrand)
        .profile-mobile-brand
          v-btn.profile-nav-toggle(
            icon
            size='small'
            @click='profileDrawerShown = !profileDrawerShown'
            :aria-expanded='profileDrawerShown'
            aria-controls='profile-navigation'
            :aria-label='profileDrawerShown ? `Close profile navigation` : `Open profile navigation`'
          )
            v-icon {{ profileDrawerShown ? 'mdi-close' : 'mdi-menu' }}
          span {{ $t('profile:title') }}
    v-navigation-drawer#profile-navigation.pb-0.profile-sidebar(
      v-model='profileDrawerShown'
      location='start'
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 320 : 256'
    )
      .profile-sidebar-header
        .profile-sidebar-mark(aria-hidden='true')
          v-icon(size='24') mdi-account-circle-outline
        .profile-sidebar-copy
          .profile-sidebar-eyebrow {{ $t('profile:workspace', { defaultValue: 'Your workspace' }) }}
          .profile-sidebar-title {{ $t('profile:title') }}
        v-spacer
        v-btn(
          v-if='$vuetify.display.smAndDown'
          icon
          variant='text'
          size='small'
          @click='profileDrawerShown = false'
          aria-label='Close profile navigation'
        )
          v-icon mdi-close
      nav.profile-navigation(aria-label='Profile sections')
        v-list.profile-navigation-list(density="compact" nav)
          v-list-subheader.profile-navigation-label {{ $t('profile:workspace', { defaultValue: 'Your workspace' }) }}
          v-list-item.profile-navigation-item(to='/profile' color='primary')
            template(v-slot:prepend): v-icon mdi-face-profile-outline
            v-list-item-title {{$t('profile:title')}}
          v-list-item.profile-navigation-item(to='/pages' color='primary')
            template(v-slot:prepend): v-icon mdi-file-document-outline
            v-list-item-title {{$t('profile:pages.title')}}
    v-main.profile-main(ref='profileMain' tabindex='-1')
      router-view(v-slot='{ Component }')
        transition(name='profile-router')
          component(:is='Component')

    nav-footer
    notify
    search-results
</template>

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
      this.$nextTick(() => {
        const main = ((this.$refs.profileMain as { $el?: HTMLElement })?.$el || this.$refs.profileMain) as HTMLElement | undefined
        const heading = main?.querySelector('h1') as HTMLElement | null
        if (heading) {
          heading.setAttribute('tabindex', '-1')
          heading.focus({ preventScroll: true })
        }
      })
      if (this.$vuetify.display.smAndDown) {
        this.profileDrawerShown = false
      }
    }
  }
})
</script>

<style lang='scss'>
.profile {
  font-family: var(--wiki-font-body);

  .nav-header {
    border-bottom: 1px solid var(--wiki-surface-border) !important;
    background: var(--wiki-surface-raised) !important;
    box-shadow: var(--wiki-shadow-xs) !important;
  }
}

.profile-nav-toggle {
  color: var(--wiki-accent-warm);
}

.profile-mobile-brand {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  color: rgb(var(--v-theme-on-surface));

  > span {
    overflow: hidden;
    font-size: .875rem;
    font-weight: 680;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.profile-sidebar {
  border-inline-end: 1px solid var(--wiki-surface-border) !important;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--wiki-accent-spectral) 7%, var(--wiki-surface-raised)),
      var(--wiki-surface-raised) 18rem
    ) !important;
  box-shadow: var(--wiki-shadow-sm);
}

.profile-sidebar-header {
  display: flex;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-8));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.profile-sidebar-mark {
  display: grid;
  width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  flex: 0 0 var(--wiki-control-height);
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-warm);
  box-shadow: var(--wiki-shadow-inset);
}

.profile-sidebar-copy {
  min-width: 0;
}

.profile-sidebar-eyebrow {
  overflow: hidden;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .08em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.profile-sidebar-title {
  overflow: hidden;
  margin-top: var(--wiki-space-1);
  color: rgb(var(--v-theme-on-surface));
  font-size: 1rem;
  font-weight: 720;
  letter-spacing: -.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-navigation {
  display: block;
  padding: var(--wiki-space-4) var(--wiki-space-3);

  .profile-navigation-list {
    padding: 0;
    background: transparent;
  }

  .profile-navigation-label {
    min-height: auto;
    margin: 0 var(--wiki-space-2) var(--wiki-space-2);
    padding: var(--wiki-space-2) 0;
    color: var(--wiki-accent-warm);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  .profile-navigation-item {
    min-height: var(--wiki-control-height);
    margin-block: var(--wiki-space-1);
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 74%, transparent);
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      border-color: var(--wiki-surface-border);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, transparent);
      color: rgb(var(--v-theme-on-surface));
    }

    &.v-list-item--active {
      border-color: color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent);
      background: color-mix(in srgb, var(--wiki-accent-warm) 10%, transparent);
      color: var(--wiki-accent-warm);
      font-weight: 680;
    }

    .v-icon {
      opacity: .82;
    }
  }
}

.profile-main {
  min-width: 0;
  background:
    radial-gradient(circle at 88% 0, color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent), transparent 34rem),
    rgb(var(--v-theme-background));

  h1[tabindex='-1']:focus {
    outline: none;
    box-shadow: none;
  }

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: var(--wiki-space-8) var(--wiki-page-gutter) var(--wiki-space-12);
  }

  .profile-header {
    display: flex;
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-8));
    align-items: center;
    margin-bottom: var(--wiki-space-4);
    padding: var(--wiki-space-1);

    > img {
      width: calc(var(--wiki-control-height) + var(--wiki-space-5)) !important;
      height: calc(var(--wiki-control-height) + var(--wiki-space-5)) !important;
      padding: var(--wiki-space-2);
      border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 22%, transparent);
      border-radius: var(--wiki-panel-radius);
      background:
        linear-gradient(145deg, color-mix(in srgb, var(--wiki-accent-spectral) 9%, var(--wiki-surface-raised)), var(--wiki-surface-raised));
      box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
      object-fit: contain;
    }

    &-title {
      min-width: 0;
      margin-inline: var(--wiki-space-5);

      > .text-headline-medium {
        color: rgb(var(--v-theme-on-surface)) !important;
        font-size: clamp(1.65rem, 2vw, 2.1rem) !important;
        font-weight: 740;
        letter-spacing: -.035em !important;
        line-height: var(--wiki-leading-heading);
      }

      > .text-body-large {
        margin-top: var(--wiki-space-1);
        color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent) !important;
        font-size: .98rem !important;
        line-height: 1.45;
      }
    }

    > .v-btn {
      min-height: var(--wiki-control-height);
      box-shadow: var(--wiki-shadow-xs);
    }
  }

  .v-card:not(.v-card--flat, .v-card--variant-flat) {
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-sm);
  }

  .v-card > .v-toolbar {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
    border-bottom: 1px solid var(--wiki-surface-border);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, var(--wiki-surface-raised)) !important;
    color: rgb(var(--v-theme-on-surface)) !important;

    .v-toolbar-title,
    .v-icon {
      color: rgb(var(--v-theme-on-surface)) !important;
    }
  }

  .v-list {
    padding-block: var(--wiki-space-2);
  }

  .v-list-item {
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-3));
  }

  .v-list-item-subtitle {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
    opacity: 1;
  }

  .v-field {
    border-radius: var(--wiki-control-radius);
  }

  .v-btn:not(.v-btn--icon) {
    border-radius: var(--wiki-control-radius);
    font-weight: 650;
    text-transform: none;
  }

  .v-data-table {
    background: transparent;

    thead th {
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    tbody tr {
      transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease);

      &:hover {
        background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, transparent);
      }
    }
  }

  .async-state {
    margin: var(--wiki-space-2);
  }
}

.profile-router {
  &-enter-active {
    transition:
      opacity var(--wiki-motion-normal) var(--wiki-motion-ease),
      transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
  }

  &-leave-active {
    position: absolute;
    transition: opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
  }

  &-enter-from {
    opacity: 0;
    transform: translateY(var(--wiki-space-1));
  }

  &-leave-to {
    opacity: 0;
  }
}

@media (max-width: 959px) {
  .profile-sidebar {
    border-inline-end: 0 !important;
    box-shadow: var(--wiki-shadow-lg);
  }

  .profile-main {
    > .v-container {
      padding: var(--wiki-space-5) var(--wiki-page-gutter) var(--wiki-space-10);
    }

    .profile-header {
      min-height: auto;
      flex-wrap: wrap;
      gap: var(--wiki-space-3);

      > img {
        width: calc(var(--wiki-control-height) + var(--wiki-space-2)) !important;
        height: calc(var(--wiki-control-height) + var(--wiki-space-2)) !important;
        border-radius: var(--wiki-control-radius);
      }

      &-title {
        flex: 1 1 calc(100% - 4.5rem);
        margin-inline: var(--wiki-space-1);

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

@media (max-width: 599px) {
  .profile-sidebar-header {
    padding: var(--wiki-space-3);
  }

  .profile-main {
    > .v-container {
      padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-10);
    }

    .profile-header {
      > .v-btn:not(.v-btn--icon) {
        width: 100%;
      }
    }

    .v-card:not(.v-card--flat, .v-card--variant-flat) {
      border-radius: var(--wiki-control-radius);
    }

    .v-list-item {
      min-height: calc(var(--wiki-control-height) + var(--wiki-space-2));
    }
  }
}

@media (forced-colors: active) {
  .profile-sidebar,
  .profile-sidebar-mark,
  .profile-main .v-card:not(.v-card--flat, .v-card--variant-flat) {
    border-color: CanvasText !important;
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

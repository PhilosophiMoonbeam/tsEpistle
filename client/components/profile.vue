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
            :aria-label='profileDrawerShown ? $t("profile:nav.close", { defaultValue: "Close profile navigation" }) : $t("profile:nav.open", { defaultValue: "Open profile navigation" })'
          )
            v-icon {{ profileDrawerShown ? 'mdi-close' : 'mdi-menu' }}
          span {{ $t('profile:title') }}
    v-navigation-drawer#profile-navigation.pb-0.profile-sidebar(
      v-model='profileDrawerShown'
      location='start'
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 304 : 264'
    )
      .profile-sidebar__inner
        .profile-sidebar__brand
          .profile-sidebar__brand-icon(aria-hidden='true')
            v-icon(size='24') mdi-account-circle-outline
          .profile-sidebar__copy
            .profile-sidebar__eyebrow {{ $t('profile:workspace', { defaultValue: 'Your workspace' }) }}
            .profile-sidebar__title {{ $t('profile:title') }}
          v-spacer
          v-btn(
            v-if='$vuetify.display.smAndDown'
            icon
            variant='text'
            size='small'
            @click='profileDrawerShown = false'
            :aria-label='$t("profile:nav.close", { defaultValue: "Close profile navigation" })'
          )
            v-icon mdi-close
        nav.profile-nav(:aria-label='$t("profile:nav.label", { defaultValue: "Profile sections" })')
          v-list.profile-nav__list(density='compact' nav)
            v-list-item.profile-nav__item(to='/profile' color='primary' rounded='lg' exact)
              template(v-slot:prepend): v-icon mdi-card-account-details-outline
              v-list-item-title {{ $t('profile:title') }}
            v-list-item.profile-nav__item(to='/pages' color='primary' rounded='lg')
              template(v-slot:prepend): v-icon mdi-file-document-outline
              v-list-item-title {{ $t('profile:pages.title') }}
            v-list-item.profile-nav__item(to='/offline' color='primary' rounded='lg')
              template(v-slot:prepend): v-icon mdi-cloud-check-outline
              v-list-item-title {{ $t('profile:nav.offline', { defaultValue: 'Offline access' }) }}
        .profile-sidebar__footer
          a.profile-sidebar__return(href='/')
            v-icon(size='18' aria-hidden='true') mdi-arrow-top-left
            span {{ $t('profile:nav.backToWiki', { defaultValue: 'Back to wiki' }) }}
    v-main.profile-main(ref='profileMain' tabindex='-1')
      router-view(v-slot='{ Component }')
        transition(name='profile-router' mode='out-in' @after-enter='focusRouteHeading')
          component(:is='Component' @vue:mounted='focusMountedRoute')

    nav-footer
    notify
    search-results
    confirm-dialog-host
</template>

<script lang='ts'>
import { defineComponent, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
import { wikiStore } from '@/store/index.ts'
import ConfirmDialogHost from './common/confirm-dialog-host.vue'

export default defineComponent({
  i18nOptions: { namespaces: 'profile' },
  components: { ConfirmDialogHost },
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
    '$route.fullPath' (nextPath: string, previousPath: string) {
      if (this.$vuetify.display.smAndDown) {
        this.profileDrawerShown = false
      }
      if (this.$route.hash && nextPath.split(/[?#]/u)[0] === previousPath.split(/[?#]/u)[0]) {
        void this.$nextTick(() => this.focusRouteHeading())
      }
    }
  },
  methods: {
    async focusMountedRoute () {
      const route = this.$route.fullPath
      await this.$nextTick()
      if (this.$route.fullPath === route && this.$route.hash) this.focusRouteHeading()
    },
    focusRenderedFragment (): boolean {
      const main = ((this.$refs.profileMain as { $el?: HTMLElement })?.$el || this.$refs.profileMain) as HTMLElement | undefined
      if (!main || !this.$route.hash) return false
      let id: string
      try {
        id = decodeURIComponent(this.$route.hash.slice(1))
      } catch {
        return false
      }
      const target = document.getElementById(id)
      if (!target || !main.contains(target) || target.closest('[hidden], [inert]')) return false
      for (let ancestor = target.parentElement; ancestor && main.contains(ancestor); ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
      }
      target.setAttribute('tabindex', '-1')
      target.scrollIntoView({ block: 'start' })
      target.focus({ preventScroll: true })
      return true
    },
    focusRouteHeading () {
      if (this.focusRenderedFragment()) return
      const main = ((this.$refs.profileMain as { $el?: HTMLElement })?.$el || this.$refs.profileMain) as HTMLElement | undefined
      const heading = main?.querySelector('h1') as HTMLElement | null
      if (!heading) return
      heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
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

  .profile-main a:focus-visible,
  .profile-sidebar a:focus-visible {
    outline: 2px solid var(--wiki-focus-color);
    outline-offset: 3px;
  }
}

.profile-nav-toggle {
  min-width: 44px !important;
  min-height: 44px !important;
  color: var(--wiki-accent-ink);
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
  border-inline-end: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-raised);

  &__inner {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
  }

  &__brand {
    display: flex;
    align-items: center;
    gap: var(--wiki-space-3);
    padding: 1.5rem 1rem 1rem;
  }

  &__brand-icon {
    display: grid;
    width: var(--wiki-control-height);
    height: var(--wiki-control-height);
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 28%, transparent);
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 11%, var(--wiki-surface-raised));
    color: var(--wiki-accent-ink);
  }

  &__copy {
    min-width: 0;
  }

  &__eyebrow {
    overflow: hidden;
    margin-bottom: var(--wiki-space-1);
    color: var(--wiki-accent-ink);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  &__title {
    overflow: hidden;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.05rem;
    font-weight: 720;
    letter-spacing: -.015em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__footer {
    margin-top: auto;
    padding: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-3);
    border-top: 1px solid var(--wiki-surface-border);
  }

  &__return {
    display: flex;
    min-height: 2.75rem;
    align-items: center;
    gap: .5rem;
    padding: .5rem;
    border-radius: var(--wiki-control-radius);
    color: var(--wiki-text-muted);
    font-size: .78rem;
    text-decoration: none;

    &:hover {
      color: var(--wiki-accent-ink);
    }
  }
}

.profile-nav {
  display: block;
  padding: var(--wiki-space-1) var(--wiki-space-3) var(--wiki-space-4);

  &__list {
    padding: 0;
    background: transparent;
  }

  &__item {
    min-height: 2.75rem;
    margin: .125rem 0;
    color: rgb(var(--v-theme-on-surface));

    .v-list-item-title {
      font-size: .8rem;
    }

    .v-list-item__prepend > .v-icon {
      font-size: 1.1875rem;
      opacity: 1;
    }

    &.v-list-item--active {
      background: color-mix(in srgb, var(--wiki-ambient-accent) 12%, transparent);
      color: var(--wiki-accent-ink);
      box-shadow: inset .1875rem 0 0 var(--wiki-ambient-accent);
      font-weight: 680;

      .v-locale--is-rtl & {
        box-shadow: inset -.1875rem 0 0 var(--wiki-ambient-accent);
      }

      .v-icon {
        color: var(--wiki-accent-ink);
      }
    }
  }
}

.profile-main {
  min-width: 0;
  background: var(--wiki-surface-sunken);

  h1[tabindex='-1']:focus {
    outline: none;
    box-shadow: none;
  }

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: var(--wiki-space-6) var(--wiki-page-gutter) var(--wiki-space-12);
  }

  .v-card:not(.v-card--flat, .v-card--variant-flat) {
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-raised);
    box-shadow: none;
  }

  .v-field,
  .v-btn:not(.v-btn--icon) {
    border-radius: var(--wiki-control-radius);
  }

  .v-btn:not(.v-btn--icon) {
    font-weight: 650;
    letter-spacing: .01em;
    text-transform: none;
  }

  .v-data-table {
    background: transparent;

    thead th {
      color: var(--wiki-text-muted);
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      letter-spacing: .055em;
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


@media (max-width: 959px) {
  .profile-main > .v-container {
    padding: var(--wiki-space-5) var(--wiki-page-gutter) var(--wiki-space-10);
  }
}

@media (max-width: 599px) {
  .profile-main {
    > .v-container {
      padding: var(--wiki-space-4) var(--wiki-space-3) var(--wiki-space-10);
    }

    .v-card:not(.v-card--flat, .v-card--variant-flat) {
      border-radius: var(--wiki-control-radius);
    }
  }
}

@media (forced-colors: active) {
  .profile-sidebar,
  .profile-sidebar__brand-icon,
  .profile-main .v-card:not(.v-card--flat, .v-card--variant-flat) {
    border-color: CanvasText !important;
  }
}

</style>

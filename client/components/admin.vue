<template lang='pug'>
  v-app.admin
    nav-header(hide-search)
      template(v-slot:mid)
        v-spacer
      template(v-slot:mobileBrand)
        v-btn.admin-nav-toggle(
          icon
          @click='adminDrawerShown = !adminDrawerShown'
          :aria-expanded='adminDrawerShown'
          aria-controls='admin-navigation'
          :aria-label='adminDrawerShown ? $t(`admin:shell.closeNavigation`) : $t(`admin:shell.openNavigation`)'
        )
          v-icon {{ adminDrawerShown ? 'mdi-close' : 'mdi-menu' }}
        .admin-context.admin-context--mobile
          v-icon(size='16') {{ currentRouteIcon }}
          strong.admin-context__current {{ currentRouteLabel }}
    v-navigation-drawer#admin-navigation.pb-0.admin-sidebar(
      v-model='adminDrawerShown'
      location='start'
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 304 : 264'
    )
      .admin-sidebar__inner
        .admin-sidebar__brand
          .admin-sidebar__brand-icon(aria-hidden='true')
            v-icon(size='22') mdi-shield-crown-outline
          .admin-sidebar__brand-copy
            .admin-sidebar__eyebrow {{ siteTitle }}
            .admin-sidebar__title {{ $t('admin:shell.title') }}
          v-spacer
          v-btn(
            v-if='$vuetify.display.smAndDown'
            icon
            variant='text'
            size='small'
            @click='adminDrawerShown = false'
            :aria-label='$t(`admin:shell.closeNavigation`)'
          )
            v-icon mdi-close
        .admin-sidebar__search
          v-text-field(
            v-model='navSearch'
            prepend-inner-icon='mdi-magnify'
            :placeholder='$t(`admin:shell.findSetting`)'
            :aria-label='$t(`admin:shell.findSettingLabel`)'
            variant='solo-filled'
            density='compact'
            hide-details
            flat
            clearable
            @keydown.esc='navSearch = ``'
          )
        vue-scroll.admin-sidebar__scroll(:ops='scrollStyle')
          nav.admin-nav(:aria-label='$t(`admin:shell.sections`)')
            v-list-item.admin-nav__dashboard(
              to='/dashboard'
              color='primary'
              prepend-icon='mdi-view-dashboard-variant-outline'
              rounded='lg'
              nav
            )
              v-list-item-title {{ $t('admin:dashboard.title') }}
            .admin-nav__label {{ $t('admin:shell.settings') }}
            template(v-if='filteredNavGroups.length')
              .admin-nav__group(
                v-for='group in filteredNavGroups'
                :key='group.key'
              )
                button.admin-nav__section(
                  type='button'
                  @click='toggleSection(group.key)'
                  :aria-expanded='isSectionOpen(group.key)'
                  :aria-controls='`admin-section-${group.key}`'
                )
                  v-icon.admin-nav__section-icon(size='16') {{ group.icon }}
                  span {{ group.label }}
                  v-icon.admin-nav__section-chevron(size='18') {{ isSectionOpen(group.key) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
                v-expand-transition
                  .admin-nav__items(
                    v-show='isSectionOpen(group.key)'
                    :id='`admin-section-${group.key}`'
                  )
                    v-list-item.admin-nav__item(
                      v-for='item in group.items'
                      :key='item.key'
                      :to='item.to'
                      :href='item.href'
                      :active='currentRouteItem?.key === item.key'
                      :aria-current='currentRouteItem?.key === item.key ? `page` : undefined'
                      color='primary'
                      :prepend-icon='item.icon'
                      rounded='lg'
                      nav
                    )
                      v-list-item-title {{ item.label }}
                      template(v-slot:append v-if='item.count !== undefined')
                        v-chip.admin-nav__count(size='x-small' variant='tonal' color='primary') {{ item.count }}
            .admin-nav__empty(v-else)
              v-icon(size='28' aria-hidden='true') mdi-magnify-close
              .text-body-medium {{ $t('admin:shell.noResults') }}
              .text-body-small {{ $t('admin:shell.noResultsHint') }}
              v-btn.mt-2(variant='text' size='small' @click='navSearch = ``') {{ $t('admin:shell.clearSearch') }}
        .admin-sidebar__footer
          a.admin-sidebar__return(href='/')
            v-icon(size='18' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-arrow-right' : 'mdi-arrow-left' }}
            span {{ $t('admin:shell.backToWiki') }}

    v-main.admin-main(ref='adminMain' tabindex='-1')
      .admin-route-bar
        nav.admin-route-bar__crumbs(:aria-label='$t(`admin:shell.breadcrumb`)')
          template(v-if='isDashboard')
            strong(aria-current='page') {{ $t('admin:dashboard.title') }}
          template(v-else)
            router-link.admin-route-bar__home(to='/dashboard') {{ $t('admin:dashboard.title') }}
            v-icon(size='14' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
            span.admin-route-bar__group(v-if='currentRouteGroup') {{ currentRouteGroup.label }}
            v-icon(v-if='currentRouteGroup' size='14' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
            strong(aria-current='page') {{ currentRouteLabel }}
      v-defaults-provider(:defaults='{ VDialog: { class: "admin-dialog", VDialog: { class: "admin-dialog" } } }')
        router-view(v-slot='{ Component }')
          transition(name='admin-router' mode='out-in' @after-enter='onRouteEntered')
            component(:is='Component')

    nav-footer
    notify
    search-results
    v-defaults-provider(:defaults='{ VDialog: { class: "admin-dialog", VDialog: { class: "admin-dialog" } } }')
      confirm-dialog-host
</template>

<script lang='ts'>
import { defineComponent, provide, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
import { wikiStore } from '@/store/index.ts'

import { adminSummaryKey } from '../helpers/admin-summary'
import { fetchSystemSummary } from '../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop } from '../helpers/root-ui-store'
import { useTranslate } from '../helpers/use-translate'

import { buildAdminNavigation, filterAdminNavigation, type AdminNavGroup, type AdminNavItem } from '../helpers/admin-navigation'
import ConfirmDialogHost from './common/confirm-dialog-host.vue'
import { focusRouteHeading } from './common/route-heading-focus.ts'

export default defineComponent({
  i18nOptions: { namespaces: 'admin' },
  components: { ConfirmDialogHost },
  setup() {
    const t = useTranslate()
    const summaryLoading = ref(false)
    const summaryError = ref('')
    async function loadInfo() {
      if (summaryLoading.value) return
      summaryLoading.value = true
      summaryError.value = ''
      loadingStart(wikiStore, 'admin-stats-refresh')
      try {
        wikiStore.admin.info = await fetchSystemSummary(window.fetch.bind(window), t('common:adminShell.systemSummaryInvalid'))
      } catch (err) {
        summaryError.value = getErrorMessage(err)
      } finally {
        summaryLoading.value = false
        loadingStop(wikiStore, 'admin-stats-refresh')
      }
    }
    provide(adminSummaryKey, { loading: summaryLoading, error: summaryError, refresh: loadInfo })
    const { mdAndUp } = useDisplay()
    const adminDrawerShown = ref(mdAndUp.value)
    const navSearch = ref<string | null>('')
    const openedSections = ref<string[]>([])
    const sectionsBeforeSearch = ref<string[] | null>(null)

    watch(mdAndUp, isDesktop => {
      adminDrawerShown.value = isDesktop
    })
    watch(navSearch, query => {
      if ((query || '').trim()) {
        if (sectionsBeforeSearch.value === null) {
          sectionsBeforeSearch.value = [...openedSections.value]
        }
        openedSections.value = ['knowledge', 'people', 'intelligence', 'workspace', 'operations']
      } else if (sectionsBeforeSearch.value !== null) {
        openedSections.value = sectionsBeforeSearch.value
        sectionsBeforeSearch.value = null
      }
    }, { flush: 'sync' })

    const scrollStyle = {
      scrollPanel: {
        scrollingX: false
      }
    }

    return { adminDrawerShown, navSearch, openedSections, scrollStyle, loadInfo }
  },
  data() {
    return {
      // Set by in-app navigation only; the first route never moves focus.
      focusAfterEnter: false,
      removeAfterEach: null as (() => void) | null
    }
  },
  computed: {
    info: {
      get(): typeof wikiStore.admin.info { return wikiStore.admin.info },
      set(value: typeof wikiStore.admin.info) { wikiStore.admin.info = value }
    },
    permissions(): string[] { return wikiStore.user.permissions },
    siteTitle(): string { return wikiStore.site.title },
    isDashboard(): boolean { return this.$route.path === '/dashboard' },
    navGroups(): AdminNavGroup[] {
      return buildAdminNavigation(key => this.$t(key), this.permissions, this.info)
    },
    filteredNavGroups(): AdminNavGroup[] {
      return filterAdminNavigation(this.navGroups, this.navSearch || '')
    },
    currentRouteGroup(): AdminNavGroup | undefined {
      const currentPath = this.$route.path
      return this.navGroups.find(group =>
        group.items.some(item => item.to && (currentPath === item.to || currentPath.startsWith(`${item.to}/`)))
      )
    },
    currentRouteItem(): AdminNavItem | undefined {
      const currentPath = this.$route.path
      return this.currentRouteGroup?.items.find(item =>
        item.to && (currentPath === item.to || currentPath.startsWith(`${item.to}/`))
      )
    },
    currentRouteLabel(): string {
      if (this.$route.path === '/dashboard') return this.$t('admin:dashboard.title')
      if (this.$route.path === '/agents') return this.$t('admin:agents.title')
      return this.currentRouteItem?.label || this.$t('admin:shell.title')
    },
    currentRouteIcon(): string {
      if (this.$route.path === '/dashboard') return 'mdi-view-dashboard-variant-outline'
      if (this.$route.path === '/agents') return 'mdi-robot-outline'
      return this.currentRouteItem?.icon || 'mdi-shield-crown-outline'
    }
  },
  created() {
    wikiStore.page.mode = 'admin'
    this.loadInfo()
    this.syncOpenedSection()
  },
  mounted() {
    this.removeAfterEach = this.$router.afterEach((to, from, failure) => {
      // The initial navigation starts from a route with no matched records.
      if (failure || from.matched.length === 0 || to.path === from.path) return
      const incoming = to.matched[to.matched.length - 1]?.components?.default
      const outgoing = from.matched[from.matched.length - 1]?.components?.default
      if (incoming && incoming === outgoing) {
        // The same view is reused (for example /users/1 → /users/2): no transition runs.
        this.$nextTick(() => this.focusHeading())
      } else {
        this.focusAfterEnter = true
      }
    })
  },
  beforeUnmount() {
    this.removeAfterEach?.()
    this.removeAfterEach = null
  },
  watch: {
    '$route.path' () {
      window.scrollTo({ top: 0, behavior: 'instant' })
      this.navSearch = ''
      this.syncOpenedSection()
      if (this.$vuetify.display.smAndDown) {
        this.adminDrawerShown = false
      }
    }
  },
  methods: {
    onRouteEntered() {
      if (!this.focusAfterEnter) return
      this.focusAfterEnter = false
      this.$nextTick(() => this.focusHeading())
    },
    focusHeading() {
      const main = ((this.$refs.adminMain as { $el?: HTMLElement })?.$el || this.$refs.adminMain) as HTMLElement | undefined
      focusRouteHeading(main)
    },
    isSectionOpen(key: string) {
      return this.openedSections.includes(key)
    },
    toggleSection(key: string) {
      this.openedSections = this.isSectionOpen(key)
        ? this.openedSections.filter(section => section !== key)
        : [...this.openedSections, key]
    },
    syncOpenedSection() {
      if ((this.navSearch || '').trim()) {
        return
      }
      const currentPath = this.$route.path
      const currentGroup = this.navGroups.find(group =>
        group.items.some(item => item.to && (currentPath === item.to || currentPath.startsWith(`${item.to}/`)))
      )
      this.openedSections = currentGroup ? [currentGroup.key] : []
    }
  }
})
</script>

<style lang='scss'>
.admin {
  --admin-radius: .65rem;
  --admin-muted: var(--wiki-text-muted);
  --wiki-content-max: 92rem;

  .animated { animation: none !important; }

  .admin-main a:focus-visible,
  .admin-sidebar a:focus-visible,
  .admin-nav__section:focus-visible {
    outline: 2px solid var(--wiki-focus-color);
    outline-offset: 3px;
  }

  // Shared adjustments for admin page content.
  .admin-main .v-toolbar__content { flex-wrap: wrap; height: auto !important; min-height: 3rem; gap: .3rem; padding-block: .65rem; }
  .admin-main .v-toolbar__content > .text-body-large { padding-inline: 1rem; font-size: .9rem !important; font-weight: 600; }
  .admin-main .v-toolbar__content > .text-body-small { padding-inline: 1rem; }
  .admin-main .v-card-title { white-space: normal; }
  .admin-main .v-list-item-subtitle { -webkit-line-clamp: 3; }
  .admin-main .v-card-info { gap: 1rem; padding: 1.25rem; }
  .admin-search .v-list-item-title { white-space: normal; line-height: 1.45; }

  // Focusable "disabled" buttons keep their tooltip; the click handler blocks the action.
  .admin-main .v-btn[aria-disabled='true'] { opacity: .62; cursor: default; }
}

:is(.admin .admin-main, .admin-dialog) .v-text-field .v-field:not(.v-field--no-label, .v-field--active) input::placeholder {
  opacity: 0;
}

:is(.admin .admin-main, .admin-dialog) .v-input .v-messages__message {
  line-height: inherit;
}

.admin-dialog .v-card-actions {
  flex-wrap: wrap;
}

@media (max-width: 599px) {
  .admin .admin-main .v-card-info { flex-wrap: wrap; }
}

// Kept for account-area save flows that reuse the admin save grammar.
.admin-save-dock {
  position: sticky;
  bottom: calc(var(--wiki-footer-height) + .75rem);
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .75rem;
  margin-top: 1.5rem;
  padding: .8rem 1rem;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--admin-radius);
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg);

  &__copy { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--wiki-text-muted); }
}

.admin-nav-toggle {
  min-width: 44px !important;
  min-height: 44px !important;
}

// Mobile header chip: names the current page while the drawer is closed.
.admin-context {
  display: none;
  max-width: min(12rem, 48vw);
  align-items: center;
  gap: var(--wiki-space-2);
  margin-inline-start: var(--wiki-space-1);
  padding: var(--wiki-space-1) var(--wiki-space-2);
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;

  &__current {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.admin-sidebar {
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
    width: 2.25rem;
    height: 2.25rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 28%, transparent);
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 11%, var(--wiki-surface-raised));
    color: var(--wiki-accent-ink);
  }

  &__brand-copy {
    min-width: 0;
  }

  &__eyebrow {
    overflow: hidden;
    margin-bottom: var(--wiki-space-1);
    color: var(--wiki-text-muted);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  &__title {
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.05rem;
    font-weight: 650;
    letter-spacing: -.015em;
  }

  &__search {
    padding: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-3);

    .v-field {
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-control-radius);
      background: var(--wiki-surface-sunken) !important;
      box-shadow: none;
      font-size: .82rem;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, var(--wiki-focus-color) 56%, transparent);
      background: rgb(var(--v-theme-surface)) !important;
    }
  }

  &__scroll {
    min-height: 0;
    flex: 1 1 auto;
  }

  &__footer {
    padding: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-3);
    border-top: 1px solid var(--wiki-surface-border);
  }

  &__return {
    display: flex;
    min-height: 2.75rem;
    align-items: center;
    gap: .5rem;
    padding: .65rem .5rem;
    border-radius: var(--wiki-control-radius);
    color: var(--wiki-text-muted);
    font-size: .8125rem;
    text-decoration: none;

    &:hover {
      color: var(--wiki-accent-ink);
    }
  }
}

.admin-nav {
  padding: var(--wiki-space-1) var(--wiki-space-3) var(--wiki-space-4);
  background: transparent;

  .v-list-item-title {
    font-size: .8125rem;
  }

  &__dashboard {
    min-height: 2.75rem;
    margin-bottom: 1rem;
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 18%, transparent);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent);
    font-weight: 680;

    .v-list-item__prepend > .v-icon {
      font-size: 1.2rem;
    }
  }

  &__dashboard,
  &__item {
    .v-list-item__spacer {
      width: .75rem;
    }
  }

  &__label {
    margin-top: .5rem;
    padding: 0 var(--wiki-space-2) var(--wiki-space-2);
    color: var(--wiki-text-muted);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  &__group + &__group {
    margin-top: .45rem;
  }

  &__section {
    display: flex;
    width: 100%;
    min-height: var(--wiki-control-height);
    align-items: center;
    gap: .5rem;
    margin: var(--wiki-space-1) 0;
    padding: 0 .5rem;
    border: 0;
    border-radius: var(--wiki-control-radius);
    background: transparent;
    color: rgb(var(--v-theme-on-surface));
    cursor: pointer;
    font: inherit;
    font-size: .75rem;
    font-weight: 650;
    text-align: start;
    transition:
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 6%, transparent);
    }
  }

  &__section-icon {
    flex: 0 0 auto;
    color: color-mix(in srgb, var(--wiki-ambient-accent) 68%, rgb(var(--v-theme-on-surface)));
  }

  &__section-chevron {
    margin-inline-start: auto;
    color: var(--wiki-text-subtle);
  }

  &__items {
    margin-inline-start: .25rem;
    padding-inline-start: 0;
  }

  &__item {
    min-height: 2.5rem;
    margin: .125rem 0;
    padding-inline-start: var(--wiki-space-3) !important;
    color: rgb(var(--v-theme-on-surface));
    opacity: 1;

    .v-list-item__prepend > .v-icon {
      margin-inline-end: 0;
      font-size: 1.1875rem;
      opacity: 1;
    }
  }

  &__count {
    min-width: var(--wiki-space-6);
    justify-content: center;
    font-weight: 700;
  }

  &__empty {
    display: grid;
    justify-items: center;
    gap: var(--wiki-space-1);
    padding: var(--wiki-space-10) var(--wiki-space-4);
    color: var(--wiki-text-muted);
    text-align: center;
  }

  .v-list-item--active {
    opacity: 1;
    background: color-mix(in srgb, var(--wiki-ambient-accent) 12%, transparent);
    color: var(--wiki-accent-ink);
    box-shadow: inset .1875rem 0 0 var(--wiki-ambient-accent);

    .v-locale--is-rtl & {
      box-shadow: inset -.1875rem 0 0 var(--wiki-ambient-accent);
    }

    .v-icon {
      color: var(--wiki-accent-ink);
      opacity: 1;
    }
  }
}

.admin-main {
  min-width: 0;
  background: var(--wiki-surface-sunken);

  h1[tabindex='-1']:focus {
    outline: none;
    box-shadow: none;
  }

  > .admin-route-bar {
    display: flex;
    width: min(100%, var(--wiki-content-max));
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-4);
    margin: 0 auto;
    padding: .75rem var(--wiki-page-gutter) 0;
  }

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: 1.5rem var(--wiki-page-gutter) var(--wiki-space-12);
  }

  > .v-container:not(.admin-agents) {

    .v-card:not(.v-card--flat, .v-card--variant-flat) {
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--admin-radius);
      background: var(--wiki-surface-raised);
      box-shadow: none;
    }

    .v-card > .v-toolbar:not(.bg-error):not(.bg-warning) {
      border-bottom: 1px solid var(--wiki-surface-border);
      background: transparent !important;
      color: rgb(var(--v-theme-on-surface)) !important;

      .v-toolbar-title,
      .text-body-large,
      .v-icon {
        color: rgb(var(--v-theme-on-surface)) !important;
      }
    }

    .v-card-title {
      min-height: 3.625rem;
      padding: var(--wiki-space-4) var(--wiki-space-5);
      font-size: 1rem;
      font-weight: 680;
      letter-spacing: -.01em;
    }

    .v-card-text {
      padding: var(--wiki-space-5);
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

    .v-alert {
      border-radius: var(--wiki-control-radius);
    }

    .v-tabs {
      border-radius: var(--wiki-control-radius) var(--wiki-control-radius) 0 0;
    }

    .v-data-table {
      border-radius: 0 0 var(--wiki-panel-radius) var(--wiki-panel-radius);

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

    .v-card-info {
      border: 0;
      border-bottom: 1px solid var(--wiki-surface-border);
      background: color-mix(in srgb, rgb(var(--v-theme-info)) 8%, var(--wiki-surface-raised));
      color: rgb(var(--v-theme-on-surface));
    }

    .wiki-form .v-input + .v-input {
      margin-top: var(--wiki-space-1);
    }
  }
}

.admin-route-bar {
  &__crumbs {
    display: flex;
    overflow: hidden;
    min-width: 0;
    align-items: center;
    gap: var(--wiki-space-2);
    color: var(--wiki-text-muted);
    font-size: .78rem;

    > * {
      flex: 0 0 auto;
    }

    strong {
      overflow: hidden;
      min-width: 0;
      flex: 0 1 auto;
      color: rgb(var(--v-theme-on-surface));
      font-weight: 680;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &__home {
    color: inherit;
    text-decoration: none;

    &:hover {
      color: var(--wiki-accent-ink);
      text-decoration: underline;
    }
  }
}

.admin-record-link,
.admin-mobile-record-title {
  color: var(--wiki-accent-ink);
  font-weight: 650;
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
    text-underline-offset: .18em;
  }
}

.admin-router {
  &-enter-active,
  &-leave-active {
    transition: opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
  }

  &-enter-from,
  &-leave-to {
    opacity: 0;
  }
}

.v-application.admin code {
  box-shadow: none;
  color: var(--wiki-accent-spectral);
  font-family: var(--wiki-font-mono);
}

@media (max-width: 839.98px) {
  .admin-context--mobile {
    display: inline-flex;
  }

  .admin-sidebar {
    max-width: calc(100vw - var(--wiki-space-8));
  }

  .admin-main {
    > .admin-route-bar {
      padding: var(--wiki-space-2) var(--wiki-page-gutter);
    }

    > .v-container {
      padding: var(--wiki-space-4) var(--wiki-page-gutter) var(--wiki-space-10);
    }

    > .v-container:not(.admin-agents) {

      .v-card-text {
        padding: var(--wiki-space-4);
      }
    }
  }

  .admin-route-bar {
    &__group,
    &__group + .v-icon {
      display: none;
    }
  }

  .v-dialog.admin-dialog:not(.v-dialog--fullscreen) > .v-overlay__content {
    width: calc(100vw - var(--wiki-space-6));
    max-width: calc(100vw - var(--wiki-space-6)) !important;
    max-height: calc(100dvh - var(--wiki-space-6));
    margin: var(--wiki-space-3);
  }
}

@media print {
  .admin-route-bar {
    display: none !important;
  }

  .admin-main {
    background: transparent !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-router-enter-active,
  .admin-router-leave-active {
    transition: none;
  }
}
</style>

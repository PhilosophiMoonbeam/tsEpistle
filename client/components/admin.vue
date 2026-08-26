<template lang='pug'>
  v-app.admin
    nav-header(hide-search)
      template(v-slot:mid)
        v-spacer
        .admin-context
          v-icon(size='16') mdi-shield-crown-outline
          span Administration
        v-spacer
      template(v-slot:actions)
        v-btn.admin-nav-toggle(
          v-if='$vuetify.display.smAndDown'
          icon
          @click='adminDrawerShown = !adminDrawerShown'
          :aria-expanded='adminDrawerShown'
          aria-controls='admin-navigation'
          aria-label='Administration navigation'
        )
          v-icon mdi-menu
    v-navigation-drawer#admin-navigation.pb-0.admin-sidebar(
      v-model='adminDrawerShown'
      :location="$vuetify.locale.isRtl ? 'right' : undefined"
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 336 : 304'
    )
      .admin-sidebar__inner
        .admin-sidebar__brand
          .admin-sidebar__brand-icon
            v-icon(size='24') mdi-view-dashboard-variant-outline
          div
            .admin-sidebar__eyebrow Control center
            .admin-sidebar__title Administration
          v-spacer
          v-btn(
            v-if='$vuetify.display.smAndDown'
            icon
            variant='text'
            size='small'
            @click='adminDrawerShown = false'
            aria-label='Close administration navigation'
          )
            v-icon mdi-close
        .admin-sidebar__search
          v-text-field(
            v-model='navSearch'
            prepend-inner-icon='mdi-magnify'
            placeholder='Find a setting'
            aria-label='Find an administration setting'
            variant='solo-filled'
            density='compact'
            hide-details
            flat
            clearable
            @keydown.esc='navSearch = ``'
          )
        vue-scroll.admin-sidebar__scroll(:ops='scrollStyle')
          nav.admin-nav(aria-label='Administration sections')
            v-list-item.admin-nav__dashboard(
              to='/dashboard'
              color='primary'
              prepend-icon='mdi-view-dashboard-variant-outline'
              rounded='lg'
              nav
            )
              v-list-item-title {{ $t('admin:dashboard.title') }}
              template(v-slot:append)
                v-icon(size='18') mdi-arrow-right
            .admin-nav__label Settings
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
                  v-icon.admin-nav__section-icon(size='21') {{ group.icon }}
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
                      color='primary'
                      :prepend-icon='item.icon'
                      rounded='lg'
                      nav
                    )
                      v-list-item-title {{ item.label }}
                      template(v-slot:append v-if='item.count !== undefined')
                        v-chip.admin-nav__count(size='x-small' variant='tonal' color='primary') {{ item.count }}
            .admin-nav__empty(v-else)
              v-icon(size='28') mdi-magnify-close
              .text-body-medium No settings found
              .text-body-small.text-medium-emphasis Try a different search
        .admin-sidebar__footer
          nav(aria-label='Administration support')
            v-list-item(
              to='/contribute'
              color='primary'
              prepend-icon='mdi-heart-outline'
              rounded='lg'
              nav
            )
              v-list-item-title {{ $t('admin:contribute.title') }}
              template(v-slot:append)
                v-icon(size='16') mdi-arrow-top-right

    v-main.admin-main
      transition(name='admin-router')
        router-view

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import _ from 'lodash'
import { defineComponent, ref, watch } from 'vue'
import { useDisplay, useLocale } from 'vuetify'
import { wikiStore } from '@/store/index.ts'

import { fetchSystemSummary } from '../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../helpers/root-ui-store'

type AdminNavItem = {
  key: string
  label: string
  icon: string
  to?: string
  href?: string
  permission?: string | string[]
  count?: number
  enabled?: boolean
}

type AdminNavGroup = {
  key: string
  label: string
  icon: string
  items: AdminNavItem[]
}

export default defineComponent({
  i18nOptions: { namespaces: 'admin' },
  setup() {
    const { mdAndUp } = useDisplay()
    const { isRtl } = useLocale()
    const adminDrawerShown = ref(mdAndUp.value)
    const navSearch = ref('')
    const openedSections = ref<string[]>([])

    watch(mdAndUp, isDesktop => {
      adminDrawerShown.value = isDesktop
    })
    watch(navSearch, query => {
      if (query.trim()) {
        openedSections.value = ['content', 'people', 'experience', 'operations']
      }
    })

    const scrollStyle = {
      vuescroll: {},
      scrollPanel: {
        initialScrollY: 0,
        initialScrollX: 0,
        scrollingX: false,
        easing: 'easeOutQuad',
        speed: 400,
        verticalNativeBarPos: isRtl.value ? 'left' : 'right'
      },
      rail: {
        gutterOfEnds: '4px'
      },
      bar: {
        onlyShowBarOnScroll: true,
        background: 'rgba(var(--v-theme-on-surface), .22)',
        hoverStyle: {
          background: 'rgba(var(--v-theme-on-surface), .4)'
        }
      }
    }

    return { adminDrawerShown, navSearch, openedSections, scrollStyle }
  },
  computed: {
    info: {
      get(): typeof wikiStore.admin.info { return wikiStore.admin.info },
      set(value: typeof wikiStore.admin.info) { wikiStore.admin.info = value }
    },
    permissions(): string[] { return wikiStore.user.permissions },
    agentsEnabled(): boolean { return siteConfig.agentsEnabled },
    navGroups(): AdminNavGroup[] {
      const groups: AdminNavGroup[] = [
        {
          key: 'content',
          label: 'Content & appearance',
          icon: 'mdi-shape-outline',
          items: [
            { key: 'general', label: this.$t('admin:general.title'), icon: 'mdi-tune-variant', to: '/general', permission: 'manage:system' },
            { key: 'locale', label: this.$t('admin:locale.title'), icon: 'mdi-translate', to: '/locale', permission: 'manage:system' },
            { key: 'navigation', label: this.$t('admin:navigation.title'), icon: 'mdi-navigation-variant-outline', to: '/navigation', permission: ['manage:system', 'manage:navigation'] },
            { key: 'pages', label: this.$t('admin:pages.title'), icon: 'mdi-file-document-multiple-outline', to: '/pages', permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages'], count: this.info.pagesTotal },
            { key: 'tags', label: this.$t('admin:tags.title'), icon: 'mdi-tag-multiple-outline', to: '/tags', permission: 'manage:system', count: this.info.tagsTotal },
            { key: 'theme', label: this.$t('admin:theme.title'), icon: 'mdi-palette-outline', to: '/theme', permission: ['manage:system', 'manage:theme'] }
          ]
        },
        {
          key: 'people',
          label: 'People & access',
          icon: 'mdi-account-multiple-outline',
          items: [
            { key: 'users', label: this.$t('admin:users.title'), icon: 'mdi-account-outline', to: '/users', permission: ['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users'], count: this.info.usersTotal },
            { key: 'groups', label: this.$t('admin:groups.title'), icon: 'mdi-account-group-outline', to: '/groups', permission: ['manage:system', 'manage:groups', 'write:groups'], count: this.info.groupsTotal },
            { key: 'auth', label: this.$t('admin:auth.title'), icon: 'mdi-shield-account-outline', to: '/auth', permission: 'manage:system' }
          ]
        },
        {
          key: 'experience',
          label: 'Features & integrations',
          icon: 'mdi-puzzle-outline',
          items: [
            { key: 'analytics', label: this.$t('admin:analytics.title'), icon: 'mdi-chart-areaspline', to: '/analytics', permission: 'manage:system' },
            { key: 'comments', label: this.$t('admin:comments.title'), icon: 'mdi-comment-text-multiple-outline', to: '/comments', permission: 'manage:system' },
            { key: 'rendering', label: this.$t('admin:rendering.title'), icon: 'mdi-text-box-edit-outline', to: '/rendering', permission: 'manage:system' },
            { key: 'editor', label: 'Editors', icon: 'mdi-pencil-ruler', to: '/editor', permission: 'manage:system' },
            { key: 'search', label: this.$t('admin:search.title'), icon: 'mdi-text-search-variant', to: '/search', permission: 'manage:system' },
            { key: 'storage', label: this.$t('admin:storage.title'), icon: 'mdi-database-outline', to: '/storage', permission: 'manage:system' },
            { key: 'extensions', label: this.$t('admin:extensions.title'), icon: 'mdi-puzzle-plus-outline', to: '/extensions', permission: 'manage:system' },
            { key: 'agents', label: this.$t('admin:agents.title'), icon: 'mdi-robot-outline', to: '/agents', permission: 'manage:system', enabled: this.agentsEnabled }
          ]
        },
        {
          key: 'operations',
          label: 'System & operations',
          icon: 'mdi-server-outline',
          items: [
            { key: 'system', label: this.$t('admin:system.title'), icon: 'mdi-monitor-dashboard', to: '/system', permission: 'manage:system' },
            { key: 'security', label: this.$t('admin:security.title'), icon: 'mdi-shield-lock-outline', to: '/security', permission: 'manage:system' },
            { key: 'ssl', label: this.$t('admin:ssl.title'), icon: 'mdi-certificate-outline', to: '/ssl', permission: 'manage:system' },
            { key: 'mail', label: this.$t('admin:mail.title'), icon: 'mdi-email-outline', to: '/mail', permission: 'manage:system' },
            { key: 'logging', label: 'Logging', icon: 'mdi-text-box-search-outline', to: '/logging', permission: 'manage:system' },
            { key: 'api', label: this.$t('admin:api.title'), icon: 'mdi-api', to: '/api', permission: ['manage:system', 'manage:api'] },
            { key: 'webhooks', label: 'Webhooks', icon: 'mdi-webhook', to: '/webhooks', permission: 'manage:system' },
            { key: 'utilities', label: this.$t('admin:utilities.title'), icon: 'mdi-toolbox-outline', to: '/utilities', permission: 'manage:system' },
            { key: 'dev-flags', label: this.$t('admin:dev.flags.title'), icon: 'mdi-toggle-switch-off-outline', to: '/dev-flags', permission: ['manage:system', 'manage:api'] },
            { key: 'graphql', label: 'GraphQL explorer', icon: 'mdi-graphql', href: '/graphql', permission: ['manage:system', 'manage:api'] }
          ]
        }
      ]

      return groups
        .map(group => ({
          ...group,
          items: group.items.filter(item => item.enabled !== false && (!item.permission || this.hasPermission(item.permission)))
        }))
        .filter(group => group.items.length > 0)
    },
    filteredNavGroups(): AdminNavGroup[] {
      const query = this.navSearch.trim().toLocaleLowerCase()
      if (!query) {
        return this.navGroups
      }
      return this.navGroups
        .map(group => ({
          ...group,
          items: group.label.toLocaleLowerCase().includes(query)
            ? group.items
            : group.items.filter(item => item.label.toLocaleLowerCase().includes(query))
        }))
        .filter(group => group.items.length > 0)
    }
  },
  created() {
    wikiStore.page.mode = 'admin'
    this.loadInfo()
    this.syncOpenedSection()
  },
  watch: {
    '$route.path' () {
      this.syncOpenedSection()
      if (this.$vuetify.display.smAndDown) {
        this.adminDrawerShown = false
      }
    }
  },
  methods: {
    isSectionOpen(key: string) {
      return this.openedSections.includes(key)
    },
    toggleSection(key: string) {
      this.openedSections = this.isSectionOpen(key)
        ? this.openedSections.filter(section => section !== key)
        : [...this.openedSections, key]
    },
    syncOpenedSection() {
      const currentPath = this.$route.path
      const currentGroup = this.navGroups.find(group =>
        group.items.some(item => item.to && (currentPath === item.to || currentPath.startsWith(`${item.to}/`)))
      )
      if (currentGroup && !this.openedSections.includes(currentGroup.key)) {
        this.openedSections = [currentGroup.key]
      }
    },
    async loadInfo() {
      loadingStart(wikiStore, 'admin-stats-refresh')
      try {
        this.info = await fetchSystemSummary(window.fetch.bind(window), 'System summary response is invalid')
      } catch (err) {
        showNotification(wikiStore, {
          style: 'error',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      loadingStop(wikiStore, 'admin-stats-refresh')
    },
    hasPermission(prm: string | string[]) {
      if (_.isArray(prm)) {
        return _.some(prm, p => _.includes(this.permissions, p))
      }
      return _.includes(this.permissions, prm)
    }
  }
})
</script>

<style lang='scss'>
.admin-context {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 7%, transparent);
  color: rgb(var(--v-theme-primary));
  font-size: .72rem;
  font-weight: 680;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.admin-sidebar {
  border-right: 1px solid rgba(var(--v-border-color), .12);
  background:
    linear-gradient(180deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, rgb(var(--v-theme-surface))) 0, rgb(var(--v-theme-surface)) 190px);

  &__inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  &__brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 22px 18px 14px;
  }

  &__brand-icon {
    display: grid;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    place-items: center;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, rgb(var(--v-theme-surface)));
    color: rgb(var(--v-theme-primary));
    box-shadow: 0 8px 24px rgba(var(--v-theme-primary), .1);
  }

  &__eyebrow {
    margin-bottom: 2px;
    color: rgb(var(--v-theme-primary));
    font-size: .67rem;
    font-weight: 750;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  &__title {
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.05rem;
    font-weight: 720;
    letter-spacing: -.015em;
  }

  &__search {
    padding: 6px 14px 12px;

    .v-field {
      border: 1px solid rgba(var(--v-border-color), .12);
      border-radius: 12px;
      background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 4%, transparent) !important;
      box-shadow: none;
    }

    .v-field--focused {
      border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 55%, transparent);
      background: rgb(var(--v-theme-surface)) !important;
      box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), .1);
    }
  }

  &__scroll {
    flex: 1 1 auto;
    min-height: 0;
  }

  &__footer {
    padding: 8px 12px 12px;
    border-top: 1px solid rgba(var(--v-border-color), .1);
    background: rgb(var(--v-theme-surface));

    .v-list {
      padding: 0;
      background: transparent;
    }
  }
}

.admin-nav {
  padding: 2px 12px 16px;
  background: transparent;

  &__dashboard {
    min-height: 46px;
    margin-bottom: 16px;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, transparent);
    font-weight: 650;
  }

  &__label {
    padding: 0 10px 7px;
    color: rgb(var(--v-theme-on-surface));
    opacity: .62;
    font-size: .65rem;
    font-weight: 750;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  &__section {
    display: flex;
    width: 100%;
    min-height: 44px;
    align-items: center;
    gap: 14px;
    margin: 3px 0;
    padding: 0 12px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: rgb(var(--v-theme-on-surface));
    cursor: pointer;
    font: inherit;
    font-weight: 620;
    text-align: start;
    transition: background-color .16s ease, color .16s ease;

    &:hover {
      background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
    }
  }

  &__section-icon {
    flex: 0 0 auto;
    opacity: .82;
  }

  &__section-chevron {
    margin-inline-start: auto;
    opacity: .58;
  }

  &__items {
    margin-inline-start: 23px;
    padding-inline-start: 5px;
    border-inline-start: 1px solid rgba(var(--v-border-color), .14);
  }

  &__item {
    min-height: 42px;
    margin: 2px 0;
    padding-inline-start: 14px !important;
    color: rgb(var(--v-theme-on-surface));
    opacity: .74;

    .v-list-item__prepend > .v-icon {
      margin-inline-end: 14px;
      font-size: 19px;
      opacity: .72;
    }
  }

  &__count {
    min-width: 24px;
    justify-content: center;
    font-weight: 700;
  }

  &__empty {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 36px 16px;
    color: rgb(var(--v-theme-on-surface));
    opacity: .64;
    text-align: center;
  }

  .v-list-item--active {
    opacity: 1;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, transparent);
    color: rgb(var(--v-theme-primary));

    .v-icon {
      color: rgb(var(--v-theme-primary));
      opacity: 1;
    }
  }
}

.admin-main {
  background:
    radial-gradient(circle at 85% -10%, rgba(var(--v-theme-primary), .08), transparent 34rem),
    rgb(var(--v-theme-background));

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: 28px var(--wiki-page-gutter) 48px;
  }

  .admin-header {
    display: flex;
    align-items: center;
    min-height: 80px;
    margin-bottom: 14px;
    padding: 4px 2px;

    > img {
      width: 64px !important;
      height: 64px !important;
      padding: 9px;
      border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 20%, transparent);
      border-radius: 18px;
      background:
        linear-gradient(145deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 13%, rgb(var(--v-theme-surface))), rgb(var(--v-theme-surface)));
      object-fit: contain;
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
        opacity: .68;
        font-size: .98rem !important;
        line-height: 1.45;
      }
    }
  }

  .v-card:not(.v-card--flat) {
    border: 1px solid rgba(var(--v-border-color), .13);
    border-radius: 16px;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 97%, rgb(var(--v-theme-background)));
    box-shadow: 0 8px 28px rgba(20, 28, 50, .055);
  }

  .v-card > .v-toolbar:not(.bg-error):not(.bg-warning) {
    border-bottom: 1px solid rgba(var(--v-border-color), .1);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, rgb(var(--v-theme-surface))) !important;
    color: rgb(var(--v-theme-on-surface)) !important;

    .v-toolbar-title,
    .text-body-large,
    .v-icon {
      color: rgb(var(--v-theme-on-surface)) !important;
    }
  }

  .v-card-title {
    min-height: 58px;
    padding: 16px 20px;
    font-size: 1rem;
    font-weight: 680;
    letter-spacing: -.01em;
  }

  .v-card-text {
    padding: 20px;
  }

  .v-field {
    border-radius: 11px;
  }

  .v-btn:not(.v-btn--icon) {
    border-radius: 10px;
    font-weight: 650;
    letter-spacing: .01em;
    text-transform: none;
  }

  .v-alert {
    border-radius: 13px;
  }

  .v-tabs {
    border-radius: 13px 13px 0 0;
  }

  .v-data-table {
    border-radius: 0 0 16px 16px;

    thead th {
      color: rgb(var(--v-theme-on-surface));
      opacity: .66;
      font-size: .7rem;
      font-weight: 750;
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    tbody tr {
      transition: background-color .16s ease;

      &:hover {
        background: color-mix(in srgb, rgb(var(--v-theme-primary)) 4%, transparent);
      }
    }
  }

  .v-card-info {
    border: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), .1);
    background: color-mix(in srgb, rgb(var(--v-theme-info)) 8%, rgb(var(--v-theme-surface)));
    color: rgb(var(--v-theme-on-surface));
  }

  .wiki-form .v-input + .v-input {
    margin-top: 4px;
  }
}

.admin-router {
  &-enter-active {
    transition: opacity .22s ease, transform .22s ease;
  }

  &-leave-active {
    position: absolute;
    transition: opacity .14s ease;
  }

  &-enter-from {
    opacity: 0;
    transform: translateY(6px);
  }

  &-leave-to {
    opacity: 0;
  }
}

.admin-providerlogo {
  display: flex;
  width: 220px;
  height: 48px;
  float: right;
  justify-content: flex-end;
  align-items: center;
  margin-left: 16px;

  img {
    max-width: 100%;
    max-height: 48px;
  }
}

.v-application.admin code {
  box-shadow: none;
  color: mc('pink', '500');
  font-family: 'Roboto Mono', monospace;
}

@media (max-width: 959px) {
  .admin-context {
    display: none;
  }

  .admin-sidebar {
    max-width: calc(100vw - 32px);
  }

  .admin-main {
    min-width: 0;

    > .v-container {
      padding: 18px 14px 36px;
    }

    .admin-header {
      flex-wrap: wrap;
      gap: 10px;
      min-height: auto;
      margin-bottom: 8px;

      > img {
        width: 50px !important;
        height: 50px !important;
        padding: 7px;
        border-radius: 14px;
      }

      &-title {
        flex: 1 1 calc(100% - 72px);
        margin-inline: 4px;

        > .text-headline-medium {
          font-size: 1.5rem !important;
        }

        > .text-body-large {
          font-size: .88rem !important;
        }
      }

      > .v-spacer {
        display: none;
      }

      > .v-btn,
      > .v-dialog {
        margin-top: 2px;
      }
    }

    .v-card-text {
      padding: 16px;
    }
  }

  .admin-filter-bar {
    flex-wrap: wrap;
    gap: 8px;

    > .v-spacer {
      display: none;
    }

    .v-input {
      flex: 1 1 100%;
      max-width: none !important;
      margin-left: 0 !important;
    }
  }

  .admin-responsive-table .v-table__wrapper {
    overflow-x: hidden;
  }

  .admin-mobile-table-row > td {
    height: auto !important;
    padding: 0 !important;
  }

  .admin-mobile-record {
    padding: 14px 16px;
    border-bottom: 1px solid rgba(var(--v-border-color), .12);

    &-title {
      overflow: hidden;
      font-size: 1rem;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-subtitle {
      overflow: hidden;
      margin-top: 3px;
      color: rgb(var(--v-theme-on-surface));
      opacity: .72;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-meta {
      overflow: hidden;
      margin-top: 6px;
      color: rgb(var(--v-theme-on-surface));
      opacity: .72;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .admin-dialog-actions {
    position: sticky;
    bottom: 0;
    z-index: 2;
    flex-wrap: wrap;
    min-height: 64px;
  }

  .v-dialog > .v-overlay__content {
    width: calc(100vw - 24px);
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100dvh - 24px);
    margin: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-router-enter-active,
  .admin-router-leave-active {
    transition: none;
  }
}
</style>

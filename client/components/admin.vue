<template lang='pug'>
  v-app.admin
    nav-header(hide-search)
      template(v-slot:mid)
        v-spacer
        .admin-context
          v-icon(size='16') mdi-shield-crown-outline
          span.admin-context__root Administration
          v-icon.admin-context__separator(size='14') mdi-chevron-right
          strong.admin-context__current {{ currentRouteLabel }}
        v-spacer
      template(v-slot:mobileBrand)
        v-btn.admin-nav-toggle(
          icon
          @click='adminDrawerShown = !adminDrawerShown'
          :aria-expanded='adminDrawerShown'
          aria-controls='admin-navigation'
          :aria-label='adminDrawerShown ? `Close administration navigation` : `Open administration navigation`'
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
                v-icon(size='18') {{ $vuetify.locale.isRtl ? 'mdi-arrow-left' : 'mdi-arrow-right' }}
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

    v-main.admin-main(ref='adminMain' tabindex='-1')
      .admin-route-bar
        nav.admin-route-bar__crumbs(aria-label='Breadcrumb')
          router-link.admin-route-bar__home(to='/dashboard') Administration
          v-icon(size='14') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
          span.admin-route-bar__group(v-if='currentRouteGroup') {{ currentRouteGroup.label }}
          v-icon(v-if='currentRouteGroup' size='14') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
          strong(aria-current='page') {{ currentRouteLabel }}
        .admin-route-bar__section(v-if='currentRouteGroup')
          v-icon(size='16') {{ currentRouteGroup.icon }}
          span {{ currentRouteGroup.label }}
      router-view(v-slot='{ Component }')
        transition(name='admin-router')
          component(:is='Component')

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import { defineComponent, ref, watch } from 'vue'
import { useDisplay } from 'vuetify'
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
    const adminDrawerShown = ref(mdAndUp.value)
    const navSearch = ref('')
    const openedSections = ref<string[]>([])
    const sectionsBeforeSearch = ref<string[] | null>(null)

    watch(mdAndUp, isDesktop => {
      adminDrawerShown.value = isDesktop
    })
    watch(navSearch, query => {
      if (query.trim()) {
        if (sectionsBeforeSearch.value === null) {
          sectionsBeforeSearch.value = [...openedSections.value]
        }
        openedSections.value = ['content', 'people', 'experience', 'operations']
      } else if (sectionsBeforeSearch.value !== null) {
        openedSections.value = sectionsBeforeSearch.value
        sectionsBeforeSearch.value = null
      }
    })

    const scrollStyle = {
      scrollPanel: {
        scrollingX: false
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
      return this.currentRouteItem?.label || 'Administration'
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
  watch: {
    '$route.path' () {
      this.syncOpenedSection()
      this.$nextTick(() => {
        const main = ((this.$refs.adminMain as { $el?: HTMLElement })?.$el || this.$refs.adminMain) as HTMLElement | undefined
        const heading = main?.querySelector('h1') as HTMLElement | null
        if (heading) {
          heading.setAttribute('tabindex', '-1')
          heading.focus({ preventScroll: true })
        }
      })
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
      if (this.navSearch.trim()) {
        return
      }
      const currentPath = this.$route.path
      const currentGroup = this.navGroups.find(group =>
        group.items.some(item => item.to && (currentPath === item.to || currentPath.startsWith(`${item.to}/`)))
      )
      if (currentGroup) {
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
      } finally {
        loadingStop(wikiStore, 'admin-stats-refresh')
      }
    },
    hasPermission(prm: string | string[]) {
      return Array.isArray(prm)
        ? prm.some(permission => this.permissions.includes(permission))
        : this.permissions.includes(prm)
    }
  }
})
</script>

<style lang='scss'>
.admin-nav-toggle {
  min-width: 44px !important;
  min-height: 44px !important;
}

.admin-context--mobile {
  display: none;
}

.admin-context {
  display: inline-flex;
  max-width: min(34rem, 50vw);
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-1) var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent);
  border-radius: var(--wiki-radius-pill);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent);
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .055em;
  text-transform: uppercase;

  &__root {
    color: var(--wiki-accent-ink);
  }

  &__separator {
    flex: 0 0 auto;
    opacity: .38;
  }

  &__current {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.admin-sidebar {
  border-inline-end: 1px solid var(--wiki-surface-border);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--wiki-ambient-accent) 6%, var(--wiki-surface-raised)) 0, rgb(var(--v-theme-surface)) 12rem);

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
    padding: var(--wiki-space-5) var(--wiki-space-4) var(--wiki-space-3);
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
    box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  }

  &__eyebrow {
    margin-bottom: var(--wiki-space-1);
    color: var(--wiki-accent-ink);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  &__title {
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.05rem;
    font-weight: 720;
    letter-spacing: -.015em;
  }

  &__search {
    padding: var(--wiki-space-2) var(--wiki-space-3) var(--wiki-space-3);

    .v-field {
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-control-radius);
      background: var(--wiki-surface-sunken) !important;
      box-shadow: var(--wiki-shadow-inset);
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
    background: var(--wiki-surface-raised);

    .v-list {
      padding: 0;
      background: transparent;
    }
  }
}

.admin-nav {
  padding: var(--wiki-space-1) var(--wiki-space-3) var(--wiki-space-4);
  background: transparent;

  &__dashboard {
    min-height: var(--wiki-control-height);
    margin-bottom: var(--wiki-space-4);
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 18%, transparent);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 8%, transparent);
    font-weight: 680;
  }

  &__label {
    padding: 0 var(--wiki-space-2) var(--wiki-space-2);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  &__section {
    display: flex;
    width: 100%;
    min-height: var(--wiki-control-height);
    align-items: center;
    gap: var(--wiki-space-3);
    margin: var(--wiki-space-1) 0;
    padding: 0 var(--wiki-space-3);
    border: 0;
    border-radius: var(--wiki-control-radius);
    background: transparent;
    color: rgb(var(--v-theme-on-surface));
    cursor: pointer;
    font: inherit;
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
    opacity: .52;
  }

  &__items {
    margin-inline-start: var(--wiki-space-6);
    padding-inline-start: var(--wiki-space-1);
    border-inline-start: 1px solid var(--wiki-surface-border);
  }

  &__item {
    min-height: var(--wiki-control-height);
    margin: var(--wiki-space-1) 0;
    padding-inline-start: var(--wiki-space-3) !important;
    color: rgb(var(--v-theme-on-surface));
    opacity: .72;

    .v-list-item__prepend > .v-icon {
      margin-inline-end: var(--wiki-space-3);
      font-size: 1.1875rem;
      opacity: .72;
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
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
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
  background:
    radial-gradient(circle at 88% -8%, color-mix(in srgb, var(--wiki-ambient-accent) 10%, transparent), transparent 34rem),
    var(--wiki-surface-sunken);

  h1[tabindex='-1']:focus {
    outline: none;
    box-shadow: none;
  }

  > .admin-route-bar {
    display: flex;
    width: min(100%, var(--wiki-content-max));
    min-height: var(--wiki-control-height);
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-4);
    margin: 0 auto;
    padding: var(--wiki-space-3) var(--wiki-page-gutter);
    border-bottom: 1px solid var(--wiki-surface-border);
  }

  > .v-container {
    width: min(100%, var(--wiki-content-max));
    margin: 0 auto;
    padding: var(--wiki-space-6) var(--wiki-page-gutter) var(--wiki-space-12);
  }

  > .v-container:not(.admin-agents) {

    .v-card:not(.v-card--flat) {
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-panel-radius);
      background: var(--wiki-surface-raised);
      box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
    }

    .v-card > .v-toolbar:not(.bg-error):not(.bg-warning) {
      border-bottom: 1px solid var(--wiki-surface-border);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, var(--wiki-surface-raised)) !important;
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
        color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, transparent);
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
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
    font-size: .78rem;

    > * {
      flex: 0 0 auto;
    }

    strong {
      overflow: hidden;
      min-width: 0;
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
    }
  }

  &__section {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--wiki-space-2);
    padding: var(--wiki-space-1) var(--wiki-space-3);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-radius-pill);
    background: var(--wiki-surface-raised);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .055em;
    text-transform: uppercase;
    box-shadow: var(--wiki-shadow-xs);
  }
}

.admin-filter-bar {
  gap: var(--wiki-space-2);
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, var(--wiki-surface-raised));

  .v-input {
    max-width: 25rem;
    flex: 1 1 13.75rem;
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

.admin-status {
  color: rgb(var(--v-theme-success));
  font-size: .78rem;
  font-weight: 650;
}

.admin-status--inactive {
  color: rgb(var(--v-theme-error));
}

.admin-router {
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
    transform: translateY(var(--wiki-space-2));
  }

  &-leave-to {
    opacity: 0;
  }
}

.admin-providerlogo {
  display: flex;
  width: 13.75rem;
  height: 3rem;
  float: inline-end;
  justify-content: flex-end;
  margin-inline-start: var(--wiki-space-4);

  img {
    max-width: 100%;
    max-height: 3rem;
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
    max-width: min(12rem, 48vw);
    margin-inline-start: var(--wiki-space-1);
    padding: var(--wiki-space-1) var(--wiki-space-2);
  }

  .admin-context:not(.admin-context--mobile) {
    display: none;
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
    &__group + .v-icon,
    &__section {
      display: none;
    }
  }

  .admin-filter-bar {
    flex-wrap: wrap;
    gap: var(--wiki-space-2);

    > .v-spacer {
      display: none;
    }

    .v-input {
      flex: 1 1 100%;
      margin-inline-start: 0 !important;
    }
  }

  .admin-responsive-table .v-table__wrapper {
    overflow-x: auto;
  }

  .admin-mobile-table-row > td {
    height: auto !important;
    padding: 0 !important;
  }

  .admin-mobile-record {
    padding: var(--wiki-space-3) var(--wiki-space-4);
    border-bottom: 1px solid var(--wiki-surface-border);

    &-title {
      overflow: hidden;
      font-size: 1rem;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-subtitle {
      overflow: hidden;
      margin-top: var(--wiki-space-1);
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-meta {
      overflow: hidden;
      margin-top: var(--wiki-space-2);
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  .admin-dialog--scrollable {
    display: flex;
    max-height: calc(100dvh - var(--wiki-space-6));
    min-height: 0;
    flex-direction: column;
    overflow: hidden;

    > .dialog-header,
    > .v-card-chin.admin-dialog-actions {
      flex: 0 0 auto;
    }

    > .admin-dialog--scrollable__body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
  }

  .admin-dialog-actions {
    position: sticky;
    bottom: 0;
    z-index: 2;
    min-height: 4rem;
    flex-wrap: wrap;
  }

  .v-dialog > .v-overlay__content {
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

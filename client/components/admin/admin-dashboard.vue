<template lang="pug">
  v-container.admin-dashboard(fluid)
    admin-hero(
      :title='$t(`admin:dashboard.title`)'
      :description='$t(`admin:dashboard.description`)'
      icon='mdi-view-dashboard-variant-outline'
      :eyebrow='siteTitle'
    )
      template(#actions)
        v-btn(variant='outlined' prepend-icon='mdi-refresh' :loading='summaryLoading' @click='refreshSummary') {{ $t(`common:actions.refresh`) }}
        v-btn(href='/' variant='flat' color='primary' prepend-icon='mdi-home-outline') {{ $t(`admin:dashboard.openWiki`) }}

    .dashboard-inventory(v-if='dashboardStats.length' :aria-label='$t(`admin:dashboard.inventory`)' :aria-busy='summaryLoading')
      router-link.admin-stat(v-for='stat in dashboardStats' :key='stat.key' :to='stat.to' :aria-label='stat.ariaLabel')
        .admin-stat__top
          v-icon(size='19') {{ stat.icon }}
          span {{ stat.label }}
          v-icon.admin-stat__arrow(size='16' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
        strong.admin-stat__value
          template(v-if='summaryLoading || summaryError') —
          animated-number(v-else :value='Number(stat.value) || 0' :duration='600' :format-value='formatInteger')
        span.admin-stat__hint {{ stat.hint }}
    v-alert.mt-3(v-if='summaryError' type='warning' variant='tonal' density='compact')
      span {{ $t(`admin:dashboard.inventoryUnavailable`) }}
      v-btn.ms-2(variant='text' size='small' @click='refreshSummary') {{ $t(`admin:dashboard.retry`) }}

    section.dashboard-connections(v-if='connections.length' aria-labelledby='dashboard-connections-title')
      .dashboard-section-heading
        h2#dashboard-connections-title {{ $t(`admin:dashboard.connectionsTitle`) }}
      .dashboard-connections__grid
        router-link.dashboard-connection(v-for='item in connections' :key='item.key' :to='item.to')
          v-icon(size='22' aria-hidden='true') {{ item.icon }}
          .dashboard-connection__copy
            h3 {{ item.title }}
            p {{ item.description }}
          span.dashboard-connection__link {{ item.action }}
            v-icon(size='16' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}

    section.dashboard-settings(v-if='taskGroups.length')
      .dashboard-section-heading
        h2 {{ $t(`admin:shell.settings`) }}
      .dashboard-settings__groups
        section.dashboard-settings__group(v-for='group in taskGroups' :key='group.key')
          h3
            v-icon(size='18' aria-hidden='true') {{ group.icon }}
            span {{ group.label }}
          v-list(bg-color='transparent' density='compact')
            v-list-item(v-for='item in group.items' :key='item.key' :to='item.to' :href='item.href' :prepend-icon='item.icon' :title='item.label')
              template(#append v-if='item.count !== undefined')
                v-chip(size='x-small' variant='tonal') {{ item.count }}

    .dashboard-section-heading(v-if='canViewRecentPages || canViewLastLogins')
      h2 {{ $t(`admin:dashboard.activityTitle`) }}
    v-row.dashboard-activity-grid(v-if='canViewRecentPages || canViewLastLogins')
      v-col(cols='12' :lg='canViewLastLogins ? 7 : 12' v-if='canViewRecentPages')
        v-card.dashboard-panel.dashboard-activity.fill-height
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon
                v-icon(size='21') mdi-file-clock-outline
              div
                h2 {{ $t('admin:dashboard.recentPages') }}
                p {{ $t(`admin:dashboard.recentPagesHint`) }}
            v-btn(to='/pages' variant='text' size='small' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') {{ $t(`admin:dashboard.viewAll`) }}
          async-state(v-if='recentPagesLoading' state='loading' :title='$t(`admin:dashboard.recentPagesLoading`)' :message='$t(`admin:dashboard.recentPagesLoadingHint`)')
          async-state(v-else-if='recentPagesError' state='error' :title='$t(`admin:dashboard.recentPagesError`)' :message='recentPagesError' :retry-label='$t(`admin:dashboard.tryAgain`)' @retry='loadRecentPages')
          async-state(v-else-if='recentPages.length === 0' state='empty' :title='$t(`admin:dashboard.recentPagesEmpty`)' :message='$t(`admin:dashboard.recentPagesEmptyHint`)')
          v-list.dashboard-mobile-list(v-else-if='$vuetify.display.smAndDown' lines='three')
            v-list-item(v-for='page in recentPages' :key='page.id' rounded='lg')
              template(v-slot:prepend)
                v-avatar(color='primary' variant='tonal' rounded='lg')
                  v-icon mdi-file-document-outline
              v-list-item-title
                router-link.admin-record-link(:to='`/pages/${page.id}`') {{ page.title }}
              v-list-item-subtitle
                v-chip.me-2(size='x-small' color='primary' variant='tonal') {{ page.locale }}
                span /{{ page.path }}
              .text-body-small.text-medium-emphasis {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
          v-data-table.dashboard-data-table(v-else :items='recentPages' :headers='recentPagesHeaders' hide-default-footer)
            template(v-slot:item='props')
              tr
                td
                  router-link.admin-record-link(:to='`/pages/${props.item.id}`') {{ props.item.title }}
                td
                  v-chip(size='small' color='primary' variant='tonal') {{ props.item.locale }}
                  span.ms-2.text-medium-emphasis /{{ props.item.path }}
                td.text-end.text-body-small(width='200') {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
      v-col(cols='12' :lg='canViewRecentPages ? 5 : 12' v-if='canViewLastLogins')
        v-card.dashboard-panel.dashboard-activity.fill-height
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon.dashboard-panel__icon--violet
                v-icon(size='21') mdi-account-clock-outline
              div
                h2 {{ $t('admin:dashboard.lastLogins') }}
                p {{ $t(`admin:dashboard.lastLoginsHint`) }}
            v-btn(to='/users' variant='text' size='small' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') {{ $t(`admin:dashboard.viewAll`) }}
          async-state(v-if='lastLoginsLoading' state='loading' :title='$t(`admin:dashboard.lastLoginsLoading`)' :message='$t(`admin:dashboard.lastLoginsLoadingHint`)')
          async-state(v-else-if='lastLoginsError' state='error' :title='$t(`admin:dashboard.lastLoginsError`)' :message='lastLoginsError' :retry-label='$t(`admin:dashboard.tryAgain`)' @retry='loadLastLogins')
          async-state(v-else-if='lastLogins.length === 0' state='empty' :title='$t(`admin:dashboard.lastLoginsEmpty`)' :message='$t(`admin:dashboard.lastLoginsEmptyHint`)')
          v-list.dashboard-mobile-list(v-else-if='$vuetify.display.smAndDown' lines='two')
            v-list-item(v-for='user in lastLogins' :key='user.id' rounded='lg')
              template(v-slot:prepend)
                v-avatar(color='secondary' variant='tonal')
                  v-icon mdi-account-outline
              v-list-item-title
                router-link.admin-record-link(:to='`/users/${user.id}`') {{ user.name }}
              v-list-item-subtitle {{ $helpers.formatMoment(user.lastLoginAt, 'calendar') }}
          v-data-table.dashboard-data-table(v-else :items='lastLogins' :headers='lastLoginsHeaders' hide-default-footer)
            template(v-slot:item='props')
              tr
                td
                  router-link.admin-record-link(:to='`/users/${props.item.id}`') {{ props.item.name }}
                td.text-end.text-body-small(width='200') {{ $helpers.formatMoment(props.item.lastLoginAt, 'calendar') }}

    .dashboard-footnote
      span tsEpistle {{ info.product.version }}
      span {{ $t(`admin:dashboard.footnote`) }}
</template>

<script lang="ts">
import { markRaw, inject } from 'vue'
import { adminSummaryKey } from '../../helpers/admin-summary'
import { buildAdminNavigation } from '../../helpers/admin-navigation'
import AsyncState from '@/components/common/async-state.vue'
import AnimatedNumber from '@/components/common/animated-number.vue'
import { wikiStore } from '@/store/index.ts'
import { fetchRecentPages, type RecentPageRow } from '../../helpers/pages-api'
import { fetchLastLogins, type LastLoginRow } from '../../helpers/users-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

const integerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const formatInteger = (value: number): string => integerFormatter.format(Math.round(value))


export default {
  components: { AsyncState, AnimatedNumber },
  setup() {
    const summary = inject(adminSummaryKey)
    return {
      summaryLoading: summary?.loading,
      summaryError: summary?.error,
      refreshSummary: () => summary?.refresh(),
      formatInteger
    }
  },
  data() {
    return {
      recentPages: [] as RecentPageRow[],
      recentPagesLoading: false,
      recentPagesError: '',
      recentPagesRequestId: 0,
      recentPagesAbortController: null as AbortController | null,
      lastLogins: [] as LastLoginRow[],
      lastLoginsLoading: false,
      lastLoginsError: '',
      lastLoginsRequestId: 0,
      lastLoginsAbortController: null as AbortController | null
    }
  },
  computed: {
    recentPagesHeaders() {
      return [
        { title: this.$t('admin:dashboard.columnTitle'), value: 'title' },
        { title: this.$t('admin:dashboard.columnPath'), value: 'path' },
        { title: this.$t('admin:dashboard.columnUpdated'), value: 'updatedAt', width: 250 }
      ]
    },
    lastLoginsHeaders() {
      return [
        { title: this.$t('admin:dashboard.columnUser'), value: 'name' },
        { title: this.$t('admin:dashboard.columnLastLogin'), value: 'lastLoginAt', width: 250 }
      ]
    },
    canViewRecentPages() {
      return this.hasPermission(['manage:system', 'write:pages', 'manage:pages', 'delete:pages'])
    },
    canViewLastLogins() {
      return this.hasPermission(['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users'])
    },
    info() {
      return wikiStore.admin.info
    },
    siteTitle() {
      return wikiStore.site.title?.trim() || 'tsEpistle'
    },
    permissions() {
      return wikiStore.user.permissions
    },
    taskGroups() {
      return buildAdminNavigation(key => this.$t(key), this.permissions, this.info)
    },
    dashboardStats() {
      return [
        {
          key: 'pages',
          label: this.$t('admin:dashboard.pages'),
          value: this.info.pagesTotal,
          hint: this.$t('admin:dashboard.pagesHint'),
          icon: 'mdi-file-document-multiple-outline',
          to: '/pages',
          permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages']
        },
        {
          key: 'tags',
          label: this.$t('admin:tags.title'),
          value: this.info.tagsTotal,
          hint: this.$t('admin:dashboard.tagsHint'),
          icon: 'mdi-tag-multiple-outline',
          to: '/tags',
          permission: 'manage:system'
        },
        {
          key: 'users',
          label: this.$t('admin:dashboard.users'),
          value: this.info.usersTotal,
          hint: this.$t('admin:dashboard.usersHint'),
          icon: 'mdi-account-multiple-outline',
          to: '/users',
          permission: ['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users']
        },
        {
          key: 'groups',
          label: this.$t('admin:dashboard.groups'),
          value: this.info.groupsTotal,
          hint: this.$t('admin:dashboard.groupsHint'),
          icon: 'mdi-account-key-outline',
          to: '/groups',
          permission: ['manage:system', 'manage:groups', 'write:groups']
        }
      ]
        .filter((stat) => this.hasPermission(stat.permission))
        .map((stat) => ({
          ...stat,
          ariaLabel: `${this.summaryLoading ? this.$t('admin:dashboard.loading') : this.summaryError ? this.$t('admin:dashboard.unavailable') : stat.value} ${stat.label}. ${stat.hint}.`
        }))
    },
    connections() {
      return [
        {
          key: 'search',
          title: this.$t('admin:dashboard.searchTitle'),
          kind: this.$t('admin:dashboard.searchKind'),
          description: this.$t('admin:dashboard.searchDescription'),
          icon: 'mdi-text-search-variant',
          action: this.$t('admin:dashboard.searchAction'),
          to: '/search',
          permission: 'manage:system'
        },
        {
          key: 'agents',
          title: this.$t('admin:dashboard.agentsTitle'),
          kind: this.$t('admin:dashboard.agentsKind'),
          description: siteConfig.agentsEnabled
            ? this.$t('admin:dashboard.agentsDescriptionEnabled')
            : this.$t('admin:dashboard.agentsDescriptionDisabled'),
          icon: 'mdi-creation-outline',
          action: this.$t('admin:dashboard.agentsAction'),
          to: '/agents',
          permission: 'manage:system'
        },
        {
          key: 'api',
          title: this.$t('admin:dashboard.apiTitle'),
          kind: this.$t('admin:dashboard.apiKind'),
          description: this.$t('admin:dashboard.apiDescription'),
          icon: 'mdi-connection',
          action: this.$t('admin:dashboard.apiAction'),
          to: '/api',
          permission: ['manage:system', 'manage:api']
        }
      ].filter((item) => this.hasPermission(item.permission))
    }
  },
  watch: {
    canViewRecentPages(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) this.loadRecentPages()
      else if (!newValue) {
        this.recentPagesAbortController?.abort()
        this.recentPagesAbortController = null
        this.recentPagesRequestId++
        this.recentPages = []
        this.recentPagesError = ''
        this.recentPagesLoading = false
      }
    },
    canViewLastLogins(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) this.loadLastLogins()
      else if (!newValue) {
        this.lastLoginsAbortController?.abort()
        this.lastLoginsAbortController = null
        this.lastLoginsRequestId++
        this.lastLogins = []
        this.lastLoginsError = ''
        this.lastLoginsLoading = false
      }
    }
  },
  created() {
    if (this.canViewRecentPages) this.loadRecentPages()
    if (this.canViewLastLogins) this.loadLastLogins()
  },
  methods: {
    hasPermission(prm: string | string[]) {
      return Array.isArray(prm) ? prm.some((permission) => this.permissions.includes(permission)) : this.permissions.includes(prm)
    },
    async loadRecentPages() {
      this.recentPagesAbortController?.abort()
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      this.recentPagesAbortController = controller
      const requestId = ++this.recentPagesRequestId
      this.recentPagesLoading = true
      this.recentPagesError = ''
      loadingStart(wikiStore, 'admin-dashboard-recentpages')
      try {
        const fetchImpl = (url: string, init: any) =>
          window.fetch(url, controller ? { ...init, signal: controller.signal } : init)
        const pages = await fetchRecentPages(fetchImpl as any, this.$t('admin:dashboard.recentPagesResponseInvalid'))
        if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false
        this.recentPages = markRaw(pages)
        return true
      } catch (err) {
        if (controller?.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
          return false
        }
        if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false
        this.recentPagesError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.recentPagesError, style: 'error', icon: 'alert' })
        return false
      } finally {
        if (this.recentPagesAbortController === controller) {
          this.recentPagesAbortController = null
        }
        loadingStop(wikiStore, 'admin-dashboard-recentpages')
        if (requestId === this.recentPagesRequestId) this.recentPagesLoading = false
      }
    },
    async loadLastLogins() {
      this.lastLoginsAbortController?.abort()
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      this.lastLoginsAbortController = controller
      const requestId = ++this.lastLoginsRequestId
      this.lastLoginsLoading = true
      this.lastLoginsError = ''
      loadingStart(wikiStore, 'admin-dashboard-lastlogins')
      try {
        const fetchImpl = (url: string, init: any) =>
          window.fetch(url, controller ? { ...init, signal: controller.signal } : init)
        const users = await fetchLastLogins(fetchImpl as any, this.$t('admin:dashboard.lastLoginsResponseInvalid'))
        if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false
        this.lastLogins = markRaw(users)
        return true
      } catch (err) {
        if (controller?.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
          return false
        }
        if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false
        this.lastLoginsError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.lastLoginsError, style: 'error', icon: 'alert' })
        return false
      } finally {
        if (this.lastLoginsAbortController === controller) {
          this.lastLoginsAbortController = null
        }
        loadingStop(wikiStore, 'admin-dashboard-lastlogins')
        if (requestId === this.lastLoginsRequestId) this.lastLoginsLoading = false
      }
    }
  },
  beforeUnmount() {
    this.recentPagesAbortController?.abort()
    this.recentPagesAbortController = null
    this.lastLoginsAbortController?.abort()
    this.lastLoginsAbortController = null
    this.recentPagesRequestId++
    this.lastLoginsRequestId++
  }
}
</script>
<style lang="scss">
.admin-dashboard {
  container-type: inline-size;
  .v-list-item-subtitle { opacity: 1; color: var(--wiki-text-muted); }
  .dashboard-mobile-list .admin-record-link { display: block; white-space: normal; overflow-wrap: anywhere; }
}
.dashboard-inventory {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}
.admin-stat {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: .35rem;
  padding: 1rem;
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  + .admin-stat { border-inline-start: 1px solid var(--wiki-surface-border); }
  &:hover { background: var(--wiki-surface-sunken); }
  &:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -3px; }
  &__top { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
  &__arrow { margin-inline-start: auto; }
  &__value { font-size: 1.75rem; font-weight: 650; line-height: 1.25; font-variant-numeric: tabular-nums; }
  &__hint { font-size: .75rem; color: var(--wiki-text-muted); overflow-wrap: anywhere; }
}
.dashboard-section-heading {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-block: 1.5rem .75rem;
  h2 { font-size: 1rem; font-weight: 650; line-height: 1.4; }
}
.dashboard-connections__grid {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  overflow: hidden;
  background: var(--wiki-surface-raised);
}
.dashboard-connection {
  display: flex;
  align-items: center;
  gap: 1rem;
  min-width: 0;
  padding: .875rem 1rem;
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  + .dashboard-connection { border-top: 1px solid var(--wiki-surface-border); }
  &:hover { background: var(--wiki-surface-sunken); }
  &:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -3px; }
  &__copy { min-width: 0; flex: 1; }
  h3 { font-size: .9375rem; font-weight: 650; overflow-wrap: anywhere; }
  p { margin: .2rem 0 0; color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; overflow-wrap: anywhere; }
  &__link { display: flex; align-items: center; gap: .5rem; color: var(--wiki-accent-ink); font-size: .8125rem; font-weight: 600; }
}
.dashboard-settings__groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.dashboard-settings__group {
  min-width: 0;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  overflow: hidden;
  h3 { display: flex; align-items: center; gap: .5rem; padding: .875rem 1rem; border-bottom: 1px solid var(--wiki-surface-border); font-size: .875rem; font-weight: 650; }
  .v-list { padding: .25rem; }
  .v-list-item { min-height: 44px; }
  .v-list-item-title { white-space: normal; overflow-wrap: anywhere; font-size: .8125rem; }
}
.dashboard-panel {
  overflow: hidden;
  &__header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid var(--wiki-surface-border); }
  &__heading { display: flex; align-items: center; gap: .75rem; min-width: 0; h2 { font-size: .9375rem; font-weight: 650; } p { font-size: .75rem; color: var(--wiki-text-muted); margin: .2rem 0 0; } }
  &__icon { color: var(--wiki-text-muted); }
  .v-table { background: transparent; }
  td { font-size: .8125rem; max-width: 18rem; overflow-wrap: anywhere; }
}
.dashboard-footnote { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--wiki-surface-border); color: var(--wiki-text-muted); font-size: .75rem; }
@container (max-width: 900px) { .dashboard-settings__groups { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 550px) {
  .dashboard-settings__groups { grid-template-columns: 1fr; }
  .dashboard-connection { flex-wrap: wrap; gap: .75rem; }
  .dashboard-connection__link { flex: 1 1 100%; padding-inline-start: 2.125rem; min-height: 2.75rem; }
}
@media (max-width: 699px) {
  .dashboard-inventory { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .admin-stat:nth-child(3) { border-inline-start: 0; }
  .admin-stat:nth-child(n + 3) { border-top: 1px solid var(--wiki-surface-border); }
  .dashboard-panel__header { flex-wrap: wrap; }
  .dashboard-panel__header .v-btn { min-height: 44px; }
}
</style>

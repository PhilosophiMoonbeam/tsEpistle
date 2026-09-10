<template lang="pug">
  v-container.admin-dashboard(fluid)
    admin-hero(
      title='Workspace overview'
      description='Shared knowledge. Connected intelligence. A place to keep both in good order.'
      icon='mdi-book-open-page-variant-outline'
      :eyebrow='siteTitle'
    )
      template(#actions)
        v-btn(href='/' variant='flat' color='primary' prepend-icon='mdi-arrow-top-right') Open wiki

    .dashboard-inventory(v-if='dashboardStats.length' aria-label='Workspace inventory' :aria-busy='summaryLoading')
      router-link.admin-stat(v-for='stat in dashboardStats' :key='stat.key' :to='stat.to' :aria-label='stat.ariaLabel')
        .admin-stat__top
          v-icon(size='19') {{ stat.icon }}
          span {{ stat.label }}
          v-icon.admin-stat__arrow(size='16') mdi-arrow-top-right
        strong.admin-stat__value
          template(v-if='summaryLoading || summaryError') —
          animated-number(v-else :value='Number(stat.value) || 0' :duration='600' :format-value='formatInteger')
        span.admin-stat__hint {{ stat.hint }}
    v-alert.mt-3(v-if='summaryError' type='warning' variant='tonal' density='compact')
      span Workspace inventory is unavailable.
      v-btn.ms-2(variant='text' size='small' @click='refreshSummary') Retry

    section.dashboard-connections(v-if='connections.length' aria-labelledby='dashboard-connections-title')
      .dashboard-section-heading
        div
          .dashboard-section-heading__eyebrow Knowledge in motion
          h2#dashboard-connections-title Discovery & intelligence
        .dashboard-section-heading__rule
      .dashboard-connections__grid
        router-link.dashboard-connection(v-for='item in connections' :key='item.key' :to='item.to')
          .dashboard-connection__top
            v-icon(size='24') {{ item.icon }}
            span.dashboard-connection__kind {{ item.kind }}
            v-icon(size='18') mdi-arrow-top-right
          h3 {{ item.title }}
          p {{ item.description }}
          span.dashboard-connection__link {{ item.action }}
            v-icon(size='16') {{ $vuetify.locale.isRtl ? 'mdi-arrow-left' : 'mdi-arrow-right' }}

    .dashboard-section-heading(v-if='canViewRecentPages || canViewLastLogins')
      div
        .dashboard-section-heading__eyebrow Workspace pulse
        h2 Recent activity
      .dashboard-section-heading__rule
    v-row.dashboard-activity-grid(v-if='canViewRecentPages || canViewLastLogins')
      v-col(cols='12' :lg='canViewLastLogins ? 7 : 12' v-if='canViewRecentPages')
        v-card.dashboard-panel.dashboard-activity.fill-height
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon
                v-icon(size='21') mdi-file-clock-outline
              div
                h2 {{ $t('admin:dashboard.recentPages') }}
                p Recently updated content.
            v-btn(to='/pages' variant='text' size='small' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') View all
          async-state(v-if='recentPagesLoading' state='loading' title='Loading recent pages' message='Fetching recently updated content.')
          async-state(v-else-if='recentPagesError' state='error' title='Recent pages could not be loaded' :message='recentPagesError' retry-label='Try again' @retry='loadRecentPages')
          async-state(v-else-if='recentPages.length === 0' state='empty' title='No recent pages' message='Updated pages will appear here.')
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
                p Recent access to the workspace.
            v-btn(to='/users' variant='text' size='small' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') View all
          async-state(v-if='lastLoginsLoading' state='loading' title='Loading recent logins' message='Fetching recent workspace access.')
          async-state(v-else-if='lastLoginsError' state='error' title='Recent logins could not be loaded' :message='lastLoginsError' retry-label='Try again' @retry='loadLastLogins')
          async-state(v-else-if='lastLogins.length === 0' state='empty' title='No recent logins' message='Recent access will appear here.')
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

    section#settings.dashboard-directory(aria-labelledby='dashboard-settings-title')
      .dashboard-section-heading
        div
          .dashboard-section-heading__eyebrow Control index
          h2#dashboard-settings-title All settings
        .dashboard-section-heading__rule
        v-text-field.dashboard-directory__search(v-model='settingsSearch' prepend-inner-icon='mdi-magnify' label='Find a setting' variant='outlined' density='compact' hide-details clearable)
      .dashboard-directory__grid(v-if='settingsGroups.length')
        section.dashboard-directory__group(v-for='group in settingsGroups' :key='group.key' :aria-labelledby='`directory-${group.key}`')
          .dashboard-directory__heading
            v-icon(size='22') {{ group.icon }}
            h3(:id='`directory-${group.key}`') {{ group.label }}
          p {{ group.description }}
          .dashboard-directory__links
            component.dashboard-directory__link(v-for='item in group.items' :key='item.key' :is='item.to ? `router-link` : `a`' v-bind='item.to ? { to: item.to } : { href: item.href }')
              span
                strong {{ item.label }}
                small {{ item.description }}
              v-icon(size='17') {{ item.href ? 'mdi-arrow-top-right' : $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
      .dashboard-directory__empty(v-else)
        async-state(state='empty' title='No matching settings' message='Try another topic, or clear your search.')
        v-btn(variant='text' @click='settingsSearch = ``') Clear search
    .dashboard-footnote
      span tsEpistle {{ info.product.version }}
      span Built for people and agents.
</template>

<script lang="ts">
import { markRaw, inject } from 'vue'
import { buildAdminNavigation, filterAdminNavigation } from '../../helpers/admin-navigation'
import { adminSummaryKey } from '../../helpers/admin-summary'
import AsyncState from '@/components/common/async-state.vue'
import AnimatedNumber from '@/components/common/animated-number.vue'
import { wikiStore } from '@/store/index.ts'
import { fetchRecentPages, type RecentPageRow } from '../../helpers/pages-api'
import { fetchLastLogins, type LastLoginRow } from '../../helpers/users-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

const RECENT_PAGES_HEADERS = markRaw([
  { title: 'Title', value: 'title' },
  { title: 'Path', value: 'path' },
  { title: 'Last Updated', value: 'updatedAt', width: 250 }
])

const LAST_LOGINS_HEADERS = markRaw([
  { title: 'User', value: 'name' },
  { title: 'Last Login', value: 'lastLoginAt', width: 250 }
])
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
      settingsSearch: '',
      recentPages: [] as RecentPageRow[],
      recentPagesLoading: false,
      recentPagesError: '',
      recentPagesRequestId: 0,
      recentPagesAbortController: null as AbortController | null,
      recentPagesHeaders: RECENT_PAGES_HEADERS,
      lastLogins: [] as LastLoginRow[],
      lastLoginsLoading: false,
      lastLoginsError: '',
      lastLoginsRequestId: 0,
      lastLoginsAbortController: null as AbortController | null,
      lastLoginsHeaders: LAST_LOGINS_HEADERS
    }
  },
  computed: {
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
    dashboardStats() {
      return [
        {
          key: 'pages',
          label: this.$t('admin:dashboard.pages'),
          value: this.info.pagesTotal,
          hint: 'Pages in the workspace',
          icon: 'mdi-file-document-multiple-outline',
          to: '/pages',
          permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages']
        },
        {
          key: 'tags',
          label: this.$t('admin:tags.title'),
          value: this.info.tagsTotal,
          hint: 'Topics connecting knowledge',
          icon: 'mdi-tag-multiple-outline',
          to: '/tags',
          permission: 'manage:system'
        },
        {
          key: 'users',
          label: this.$t('admin:dashboard.users'),
          value: this.info.usersTotal,
          hint: 'Workspace accounts',
          icon: 'mdi-account-multiple-outline',
          to: '/users',
          permission: ['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users']
        },
        {
          key: 'groups',
          label: this.$t('admin:dashboard.groups'),
          value: this.info.groupsTotal,
          hint: 'Roles and permission sets',
          icon: 'mdi-account-key-outline',
          to: '/groups',
          permission: ['manage:system', 'manage:groups', 'write:groups']
        }
      ]
        .filter((stat) => this.hasPermission(stat.permission))
        .map((stat) => ({
          ...stat,
          ariaLabel: `${this.summaryLoading ? 'Loading' : this.summaryError ? 'Unavailable' : stat.value} ${stat.label}. ${stat.hint}.`
        }))
    },
    settingsGroups() {
      return filterAdminNavigation(
        buildAdminNavigation((key) => this.$t(key), this.permissions, this.info),
        this.settingsSearch || ''
      )
    },
    connections() {
      return [
        {
          key: 'search',
          title: 'Make knowledge discoverable',
          kind: 'Search',
          description: 'Choose your search engine and maintain the index that helps readers find answers.',
          icon: 'mdi-text-search-variant',
          action: 'Configure search',
          to: '/search',
          permission: 'manage:system'
        },
        {
          key: 'agents',
          title: 'Give your wiki an agent',
          kind: 'Wiki Agent',
          description: siteConfig.agentsEnabled
            ? 'Manage models, approved skills and the boundaries of your built-in assistant.'
            : 'Explore agent administration and the deployment settings needed to enable it.',
          icon: 'mdi-creation-outline',
          action: 'Manage agents',
          to: '/agents',
          permission: 'manage:system'
        },
        {
          key: 'api',
          title: 'Connect your ecosystem',
          kind: 'API & MCP',
          description: 'Manage integration keys and connect external tools to your shared knowledge.',
          icon: 'mdi-connection',
          action: 'Explore integrations',
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
        const pages = await fetchRecentPages(fetchImpl as any, 'Recent pages response is invalid')
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
        const users = await fetchLastLogins(fetchImpl as any, 'Last logins response is invalid')
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
  .v-list-item-subtitle {
    opacity: 1;
    color: var(--admin-muted);
  }
  .dashboard-mobile-list .admin-record-link {
    display: block;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .admin-hero {
    padding-block: 0.25rem 1rem;
    margin-bottom: 0;
    border-bottom: 0;
  }
}
.dashboard-inventory {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-block: 1px solid var(--wiki-surface-border);
}
.admin-stat {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 1rem 1.5rem;
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: var(--admin-radius);
  background: var(--wiki-surface-raised);
  transition:
    background var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);

  + .admin-stat {
    border-inline-start-color: var(--wiki-surface-border);
  }

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(
      115deg,
      color-mix(in srgb, var(--wiki-accent-ink) 16%, transparent),
      transparent 58%
    );
    opacity: 0;
    transition: opacity var(--wiki-motion-normal) var(--wiki-motion-ease);
  }

  &:is(:hover, :focus-visible) {
    border-color: var(--wiki-surface-border-strong);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 6%, var(--wiki-surface-raised));
    box-shadow: var(--wiki-shadow-xs);

    &::before {
      opacity: 1;
    }

    .admin-stat__top > .v-icon:first-child {
      transform: scale(1.05);
    }
    .admin-stat__arrow {
      transform: translate(3px, -3px);
    }
  }

  &:active {
    background: color-mix(in srgb, var(--wiki-ambient-accent) 10%, var(--wiki-surface-raised));
    box-shadow: var(--wiki-shadow-inset);
  }

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color);
    outline-offset: var(--wiki-focus-offset);
  }

  &__top {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--admin-muted);
    font-size: 0.8rem;
    > .v-icon:first-child {
      transition: transform var(--wiki-motion-normal) var(--wiki-motion-ease);
    }
  }
  &__arrow {
    position: relative;
    z-index: 1;
    margin-inline-start: auto;
    transition: transform var(--wiki-motion-normal) var(--wiki-motion-ease);
  }
  &__value {
    position: relative;
    z-index: 1;
    margin-top: 0.8rem;
    font-size: 2.5rem;
    font-weight: 550;
    letter-spacing: -0.06em;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  &__hint {
    position: relative;
    z-index: 1;
    margin-top: 0.4rem;
    font-size: 0.75rem;
    color: var(--admin-muted);
  }
}
@media (forced-colors: active) {
  .admin-stat:focus-visible,
  .dashboard-connection:focus-visible {
    outline-color: Highlight;
  }
}
.dashboard-section-heading {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-block: 1.5rem 0.8rem;
  h2 {
    margin-top: 0.3rem;
    font-size: 1.4rem;
    font-weight: 560;
    letter-spacing: -0.025em;
    line-height: 1.25;
  }
  &__eyebrow {
    color: var(--wiki-accent-ink);
    font-size: 0.65rem;
    font-weight: 650;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }
  &__rule {
    height: 1px;
    flex: 1;
    background: var(--wiki-surface-border);
  }
}
.dashboard-connections__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
.dashboard-connection {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 1.15rem;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--admin-radius);
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
  transition:
    background var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(
      115deg,
      color-mix(in srgb, var(--wiki-accent-ink) 16%, transparent),
      transparent 58%
    );
    opacity: 0;
    transition: opacity var(--wiki-motion-normal) var(--wiki-motion-ease);
  }

  &:is(:hover, :focus-visible) {
    border-color: var(--wiki-accent-ink);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 5%, var(--wiki-surface-raised));
    box-shadow: var(--wiki-shadow-xs);

    &::before {
      opacity: 1;
    }

    .dashboard-connection__top > .v-icon:first-child {
      transform: scale(1.05);
    }
    .dashboard-connection__top > .v-icon:last-child {
      transform: translate(3px, -3px);
    }
  }

  &:active {
    background: color-mix(in srgb, var(--wiki-ambient-accent) 9%, var(--wiki-surface-raised));
    box-shadow: var(--wiki-shadow-inset);
  }

  &:focus-visible {
    outline: 2px solid var(--wiki-focus-color);
    outline-offset: var(--wiki-focus-offset);
  }

  &__top {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--wiki-accent-ink);
    > .v-icon:first-child {
      transition: transform var(--wiki-motion-normal) var(--wiki-motion-ease);
    }
    > .v-icon:last-child {
      margin-inline-start: auto;
      transition: transform var(--wiki-motion-normal) var(--wiki-motion-ease);
    }
  }
  &__kind {
    font-size: 0.7rem;
    font-weight: 650;
    letter-spacing: 0.065em;
    text-transform: uppercase;
  }
  h3 {
    position: relative;
    z-index: 1;
    margin-block: 1rem 0.5rem;
    font-size: 1.15rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.3;
  }
  p {
    position: relative;
    z-index: 1;
    flex: 1;
    margin: 0 0 1rem;
    color: var(--admin-muted);
    font-size: 0.82rem;
    line-height: 1.55;
  }
  &__link {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    font-weight: 650;
    color: var(--wiki-accent-ink);
  }
}
.dashboard-panel {
  overflow: hidden;
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.1rem 1.25rem;
    border-bottom: 1px solid var(--wiki-surface-border);
  }
  &__heading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    h2 {
      font-size: 0.95rem;
      font-weight: 620;
    }
    p {
      font-size: 0.75rem;
      color: var(--admin-muted);
      margin: 0.2rem 0 0;
    }
  }
  &__icon {
    color: var(--admin-muted);
  }
  .v-table {
    background: transparent;
  }
  td {
    font-size: 0.8rem;
  }
  .v-table__wrapper {
    padding-inline: 0.5rem;
  }
  .dashboard-data-table td {
    max-width: 18rem;
    overflow-wrap: anywhere;
  }
}
.dashboard-directory {
  scroll-margin-top: calc(var(--wiki-header-height, 64px) + 1rem);
  &__search {
    flex: 0 1 18rem;
    min-width: 12rem;
  }
  &__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.5rem;
  }
  &__group {
    min-width: 0;
    padding: 1.25rem;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--admin-radius);
    background: var(--wiki-surface-raised);
    > p {
      color: var(--admin-muted);
      font-size: 0.78rem;
      margin-block: 0.55rem 1rem;
    }
  }
  &__heading {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--wiki-accent-ink);
    h3 {
      color: rgb(var(--v-theme-on-surface));
      font-size: 1rem;
      font-weight: 620;
    }
  }
  &__link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding-block: 0.8rem;
    color: rgb(var(--v-theme-on-surface));
    text-decoration: none;
    border-top: 1px solid var(--wiki-surface-border);
    strong {
      display: block;
      font-size: 0.82rem;
      font-weight: 570;
    }
    small {
      display: block;
      margin-top: 0.2rem;
      color: var(--admin-muted);
      font-size: 0.73rem;
      line-height: 1.4;
    }
    &:hover strong {
      color: var(--wiki-accent-ink);
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }
    > .v-icon {
      color: var(--admin-muted);
    }
  }
}
.dashboard-footnote {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--wiki-surface-border);
  color: var(--admin-muted);
  font-size: 0.72rem;
}
@media (max-width: 1199px) {
  .dashboard-directory__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 699px) {
  .dashboard-inventory {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .admin-stat {
    padding: 1rem;
    &:nth-child(3) {
      border-inline-start: 0;
    }
    &:nth-child(n + 3) {
      border-top: 1px solid var(--wiki-surface-border);
    }
  }
  .dashboard-connections__grid,
  .dashboard-directory__grid {
    grid-template-columns: 1fr;
  }
  .dashboard-connection {
    padding: 1.1rem;
    h3 {
      margin-top: 0.8rem;
    }
    p {
      margin-bottom: 1rem;
    }
  }
  .dashboard-section-heading {
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .dashboard-directory__search {
    flex-basis: 100%;
  }
  .dashboard-panel__header {
    flex-wrap: wrap;
  }
}
@media (prefers-reduced-motion: reduce) {
  .admin-stat,
  .dashboard-connection {
    transition: none !important;
    &::before {
      transition: none !important;
    }
  }
  .admin-stat:hover .admin-stat__top > .v-icon:first-child,
  .admin-stat:focus-visible .admin-stat__top > .v-icon:first-child,
  .admin-stat:hover .admin-stat__arrow,
  .admin-stat:focus-visible .admin-stat__arrow,
  .dashboard-connection:hover .dashboard-connection__top > .v-icon:first-child,
  .dashboard-connection:focus-visible .dashboard-connection__top > .v-icon:first-child,
  .dashboard-connection:hover .dashboard-connection__top > .v-icon:last-child,
  .dashboard-connection:focus-visible .dashboard-connection__top > .v-icon:last-child {
    transform: none !important;
    transition: none !important;
  }
}
@container (max-width: 760px) {
  .dashboard-connections__grid,
  .dashboard-directory__grid {
    grid-template-columns: 1fr;
  }
}
</style>

<template lang='pug'>
  v-container.admin-dashboard(fluid)
    admin-hero(
      :title='$t(`admin:dashboard.title`)'
      :description='siteTitle'
      icon='/_assets/svg/icon-features-list.svg'
      eyebrow='Control room'
    )
      template(#status)
        .admin-dashboard__build
          span Deployed build
          v-chip(size='small' variant='tonal' color='primary' prepend-icon='mdi-source-fork') {{ siteTitle }} {{ info.product.version }}

    .dashboard-section-heading.dashboard-section-heading--compact(v-if='dashboardStats.length')
      div
        .dashboard-section-heading__eyebrow Workspace inventory
        h2 Key signals
      .dashboard-section-heading__rule
    v-row.admin-dashboard__stats(v-if='dashboardStats.length')
      v-col(v-for='stat in dashboardStats' :key='stat.key' cols='12' sm='6' xl='3' class='d-flex')
        v-card.admin-stat(:class='`admin-stat--${stat.tone}`' :to='stat.to' :aria-label='stat.ariaLabel' flat)
          .admin-stat__icon
            v-icon(size='23') {{ stat.icon }}
          dl.admin-stat__body
            dt.admin-stat__label {{ stat.label }}
            dd.admin-stat__value
              animated-number(v-if='stat.value !== undefined' :value='stat.value' :duration='1200' :formatValue='round')
              span.admin-stat__value--text(v-else) {{ stat.textValue }}
            dd.admin-stat__hint {{ stat.hint }}
          v-icon.admin-stat__arrow(size='18') mdi-arrow-up-right

    v-row.admin-dashboard__workspace
      v-col(v-if='quickActions.length' cols='12' lg='8')
        v-card.dashboard-panel.fill-height
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon
                v-icon(size='21') mdi-lightning-bolt-outline
              div
                h2 Start with an outcome
                p Jump directly to the work you want to complete.
          v-card-text
            .dashboard-actions
              v-card.dashboard-action(v-for='action in quickActions' :key='action.key' :to='action.to' flat)
                .dashboard-action__icon(:class='`dashboard-action__icon--${action.tone}`')
                  v-icon(size='22') {{ action.icon }}
                .dashboard-action__copy
                  .dashboard-action__title {{ action.title }}
                  .dashboard-action__description {{ action.description }}
                v-icon.dashboard-action__arrow(size='18') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
      v-col(cols='12' :lg='quickActions.length ? 4 : 12')
        v-card.dashboard-panel.dashboard-overview.fill-height
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon.dashboard-panel__icon--success
                v-icon(size='21') mdi-check-decagram-outline
              div
                h2 At a glance
                p The essentials for this workspace.
          v-card-text
            .dashboard-overview__product
              .dashboard-overview__product-icon
                v-icon(size='26') mdi-book-open-page-variant-outline
              div
                .dashboard-overview__product-name {{ siteTitle }}
                .dashboard-overview__product-version Version {{ info.product.version }}
            .dashboard-overview__list
              .dashboard-overview__row
                span Content
                strong {{ info.pagesTotal }} pages · {{ info.tagsTotal }} tags
              .dashboard-overview__row
                span Access
                strong {{ info.usersTotal }} users · {{ info.groupsTotal }} groups
              .dashboard-overview__row
                span Platform
                strong tsFranki {{ info.product.version }}
            v-btn.dashboard-overview__button(v-if='hasPermission(`manage:system`)' to='/system' variant='tonal' color='primary' block prepend-icon='mdi-monitor-dashboard' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') Open system details

    .dashboard-section-heading(v-if='canViewRecentPages || canViewLastLogins')
      div
        .dashboard-section-heading__eyebrow Activity
        h2 What changed recently
      .dashboard-section-heading__rule

    v-row(v-if='canViewRecentPages || canViewLastLogins')
      v-col(cols='12' :xl='canViewLastLogins ? 6 : 12' v-if='canViewRecentPages')
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
      v-col(cols='12' :xl='canViewRecentPages ? 6 : 12' v-if='canViewLastLogins')
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

</template>

<script lang='ts'>
import AnimatedNumber from '@/components/common/animated-number.vue'
import AsyncState from '@/components/common/async-state.vue'
import { wikiStore } from '@/store/index.ts'
import { fetchRecentPages, type RecentPageRow } from '../../helpers/pages-api'
import { fetchLastLogins, type LastLoginRow } from '../../helpers/users-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

export default {
  components: { AnimatedNumber, AsyncState },
  data() {
    return {
      recentPages: [] as RecentPageRow[],
      recentPagesLoading: false,
      recentPagesError: '',
      recentPagesRequestId: 0,
      recentPagesHeaders: [
        { title: 'Title', value: 'title' },
        { title: 'Path', value: 'path' },
        { title: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      lastLogins: [] as LastLoginRow[],
      lastLoginsLoading: false,
      lastLoginsError: '',
      lastLoginsRequestId: 0,
      lastLoginsHeaders: [
        { title: 'User', value: 'displayName' },
        { title: 'Last Login', value: 'lastLoginAt', width: 250 }
      ]
    }
  },
  computed: {
    canViewRecentPages() { return this.hasPermission(['manage:system', 'read:pages']) },
    canViewLastLogins() { return this.hasPermission(['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users']) },
    info() { return wikiStore.admin.info },
    siteTitle() { return wikiStore.site.title?.trim() || 'tsFranki' },
    permissions() { return wikiStore.user.permissions },
    dashboardStats() {
      return [
        { key: 'pages', label: this.$t('admin:dashboard.pages'), value: this.info.pagesTotal, hint: 'Published content', icon: 'mdi-file-document-multiple-outline', tone: 'primary', to: '/pages', permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages'], ariaLabel: `${this.info.pagesTotal} pages. Open page management.` },
        { key: 'users', label: this.$t('admin:dashboard.users'), value: this.info.usersTotal, hint: 'People with access', icon: 'mdi-account-multiple-outline', tone: 'secondary', to: '/users', permission: ['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users'], ariaLabel: `${this.info.usersTotal} users. Open user management.` },
        { key: 'groups', label: this.$t('admin:dashboard.groups'), value: this.info.groupsTotal, hint: 'Permission sets', icon: 'mdi-account-key-outline', tone: 'info', to: '/groups', permission: ['manage:system', 'manage:groups', 'write:groups'], ariaLabel: `${this.info.groupsTotal} groups. Open group management.` },
        { key: 'version', label: 'Current build', textValue: this.info.product.version, hint: 'System information', icon: 'mdi-source-fork', tone: 'warning', to: '/system', permission: 'manage:system', ariaLabel: `Version ${this.info.product.version}. Open system information.` }
      ].filter(stat => this.hasPermission(stat.permission))
    },
    quickActions() {
      return [
        { key: 'pages', title: 'Organize content', description: 'Review pages, ownership and publication.', icon: 'mdi-file-tree-outline', tone: 'primary', to: '/pages', permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages'] },
        { key: 'general', title: 'Shape the workspace', description: 'Identity, metadata and editing behavior.', icon: 'mdi-tune-variant', tone: 'secondary', to: '/general', permission: 'manage:system' },
        { key: 'users', title: 'Manage people', description: 'Invite, suspend and support members.', icon: 'mdi-account-supervisor-outline', tone: 'info', to: '/users', permission: ['manage:system', 'manage:users', 'write:users'] },
        { key: 'theme', title: 'Refine appearance', description: 'Typography, colors and presentation.', icon: 'mdi-palette-outline', tone: 'primary', to: '/theme', permission: ['manage:system', 'manage:theme'] },
        { key: 'search', title: 'Tune discovery', description: 'Configure how readers find knowledge.', icon: 'mdi-text-search-variant', tone: 'warning', to: '/search', permission: 'manage:system' },
        { key: 'security', title: 'Review security', description: 'Protect sessions, access and content.', icon: 'mdi-shield-check-outline', tone: 'success', to: '/security', permission: 'manage:system' }
      ].filter(action => this.hasPermission(action.permission))
    }
  },
  watch: {
    canViewRecentPages(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) this.loadRecentPages()
      else if (!newValue) {
        this.recentPagesRequestId++
        this.recentPages = []
        this.recentPagesError = ''
        this.recentPagesLoading = false
      }
    },
    canViewLastLogins(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) this.loadLastLogins()
      else if (!newValue) {
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
    round(val: number) { return Math.round(val) },
    hasPermission(prm: string | string[]) {
      return Array.isArray(prm) ? prm.some(permission => this.permissions.includes(permission)) : this.permissions.includes(prm)
    },
    async loadRecentPages() {
      const requestId = ++this.recentPagesRequestId
      this.recentPagesLoading = true
      this.recentPagesError = ''
      loadingStart(wikiStore, 'admin-dashboard-recentpages')
      try {
        const pages = await fetchRecentPages(window.fetch.bind(window), 'Recent pages response is invalid')
        if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false
        this.recentPages = pages
        return true
      } catch (err) {
        if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false
        this.recentPagesError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.recentPagesError, style: 'error', icon: 'alert' })
        return false
      } finally {
        loadingStop(wikiStore, 'admin-dashboard-recentpages')
        if (requestId === this.recentPagesRequestId) this.recentPagesLoading = false
      }
    },
    async loadLastLogins() {
      const requestId = ++this.lastLoginsRequestId
      this.lastLoginsLoading = true
      this.lastLoginsError = ''
      loadingStart(wikiStore, 'admin-dashboard-lastlogins')
      try {
        const users = await fetchLastLogins(window.fetch.bind(window), 'Last logins response is invalid')
        if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false
        this.lastLogins = users
        return true
      } catch (err) {
        if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false
        this.lastLoginsError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.lastLoginsError, style: 'error', icon: 'alert' })
        return false
      } finally {
        loadingStop(wikiStore, 'admin-dashboard-lastlogins')
        if (requestId === this.lastLoginsRequestId) this.lastLoginsLoading = false
      }
    }
  },
  beforeUnmount() {
    this.recentPagesRequestId++
    this.lastLoginsRequestId++
  }
}
</script>
<style lang='scss'>
.admin-dashboard {
  &__build {
    display: grid;
    justify-items: end;
    gap: var(--wiki-space-1);

    > span {
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      letter-spacing: .055em;
      text-transform: uppercase;
    }
  }

  &__stats {
    margin-bottom: var(--wiki-space-1);
  }

  &__workspace {
    margin-top: var(--wiki-space-1);
  }
}

.admin-stat {
  --stat-color: var(--wiki-accent-warm);
  position: relative;
  display: flex;
  overflow: hidden;
  width: 100%;
  min-height: calc(var(--wiki-control-height) + var(--wiki-space-10));
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3) var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border) !important;
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);
  transition:
    border-color var(--wiki-motion-normal) var(--wiki-motion-ease),
    box-shadow var(--wiki-motion-normal) var(--wiki-motion-ease),
    transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);

  &::before {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: .1875rem;
    background: var(--stat-color);
    content: '';
    opacity: .78;
  }

  &:hover {
    border-color: color-mix(in srgb, var(--stat-color) 36%, transparent) !important;
    box-shadow: var(--wiki-shadow-md), var(--wiki-shadow-inset);
    transform: translateY(-.125rem);
  }

  &--primary { --stat-color: rgb(var(--v-theme-primary)); }
  &--secondary { --stat-color: rgb(var(--v-theme-secondary)); }
  &--info { --stat-color: rgb(var(--v-theme-info)); }
  &--warning { --stat-color: rgb(var(--v-theme-warning)); }

  &__icon {
    display: grid;
    width: var(--wiki-control-height);
    height: var(--wiki-control-height);
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--stat-color) 12%, transparent);
    color: var(--stat-color);
    box-shadow: var(--wiki-shadow-inset);
  }

  &__body {
    min-width: 0;
    margin: 0;
  }

  &__label {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .055em;
    text-transform: uppercase;
  }

  &__value {
    display: block;
    min-width: 0;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 2rem;
    font-weight: 760;
    letter-spacing: -.045em;
    line-height: 1;

    &--text {
      display: block;
      overflow: hidden;
      max-width: 11rem;
      font-size: 1.25rem;
      line-height: 1.72;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &__hint {
    margin: 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
    font-size: .77rem;
  }

  &__arrow {
    position: absolute !important;
    inset-block-start: var(--wiki-space-3);
    inset-inline-end: var(--wiki-space-3);
    color: var(--stat-color);
    opacity: .58;
  }
}

.dashboard-panel {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border) !important;
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset) !important;

  &__header {
    display: flex;
    min-height: 4.875rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-4);
    padding: var(--wiki-space-4) var(--wiki-space-5);
    border-bottom: 1px solid var(--wiki-surface-border);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 4%, transparent);
  }

  &__heading {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--wiki-space-3);

    h2 {
      margin: 0;
      color: rgb(var(--v-theme-on-surface));
      font-size: 1rem;
      font-weight: 720;
      letter-spacing: -.015em;
    }

    p {
      margin: var(--wiki-space-1) 0 0;
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
      font-size: .78rem;
    }
  }

  &__icon {
    display: grid;
    width: 2.625rem;
    height: 2.625rem;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, transparent);
    color: rgb(var(--v-theme-primary));

    &--success {
      background: color-mix(in srgb, rgb(var(--v-theme-success)) 11%, transparent);
      color: rgb(var(--v-theme-success));
    }

    &--violet {
      background: color-mix(in srgb, rgb(var(--v-theme-secondary)) 11%, transparent);
      color: rgb(var(--v-theme-secondary));
    }
  }
}

.dashboard-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--wiki-space-2);
}

.dashboard-action {
  display: flex;
  min-height: 5.5rem;
  align-items: center;
  gap: var(--wiki-space-3);
  padding: var(--wiki-space-3);
  border: 1px solid transparent !important;
  border-radius: var(--wiki-control-radius) !important;
  background: var(--wiki-surface-sunken) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: var(--wiki-shadow-inset);
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);

  &:hover {
    border-color: color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent) !important;
    background: color-mix(in srgb, var(--wiki-ambient-accent) 7%, var(--wiki-surface-sunken)) !important;
    transform: translateY(-.0625rem);

    .dashboard-action__arrow {
      color: var(--wiki-accent-warm);
      transform: translateX(var(--wiki-space-1));
    }
  }

  @at-root .v-locale--is-rtl & {
    &:hover .dashboard-action__arrow {
      transform: translateX(calc(var(--wiki-space-1) * -1));
    }
  }

  &__icon {
    display: grid;
    width: var(--wiki-control-height);
    height: var(--wiki-control-height);
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--wiki-control-radius);

    &--primary { background: color-mix(in srgb, rgb(var(--v-theme-primary)) 11%, transparent); color: rgb(var(--v-theme-primary)); }
    &--secondary { background: color-mix(in srgb, rgb(var(--v-theme-secondary)) 11%, transparent); color: rgb(var(--v-theme-secondary)); }
    &--info { background: color-mix(in srgb, rgb(var(--v-theme-info)) 11%, transparent); color: rgb(var(--v-theme-info)); }
    &--warning { background: color-mix(in srgb, rgb(var(--v-theme-warning)) 11%, transparent); color: rgb(var(--v-theme-warning)); }
    &--success { background: color-mix(in srgb, rgb(var(--v-theme-success)) 11%, transparent); color: rgb(var(--v-theme-success)); }
  }

  &__copy {
    min-width: 0;
    flex: 1 1 auto;
  }

  &__title {
    margin-bottom: var(--wiki-space-1);
    font-size: .9rem;
    font-weight: 680;
  }

  &__description {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    font-size: .76rem;
    line-height: 1.4;
  }

  &__arrow {
    flex: 0 0 auto;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
    transition:
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      transform var(--wiki-motion-fast) var(--wiki-motion-ease-out);
  }
}

.dashboard-overview {
  &__product {
    display: flex;
    align-items: center;
    gap: var(--wiki-space-3);
    padding: var(--wiki-space-1) 0 var(--wiki-space-4);
  }

  &__product-icon {
    display: grid;
    width: 3.125rem;
    height: 3.125rem;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-ambient-accent) 13%, transparent);
    color: var(--wiki-accent-warm);
    box-shadow: var(--wiki-shadow-inset);
  }

  &__product-name {
    font-size: .95rem;
    font-weight: 720;
  }

  &__product-version {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);
    font-size: .78rem;
  }

  &__list {
    border-block: 1px solid var(--wiki-surface-border);
  }

  &__row {
    display: flex;
    justify-content: space-between;
    gap: var(--wiki-space-4);
    padding: var(--wiki-space-3) 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 65%, transparent);
    font-size: .8rem;

    + .dashboard-overview__row {
      border-top: 1px solid var(--wiki-surface-border);
    }

    strong {
      overflow-wrap: anywhere;
      color: rgb(var(--v-theme-on-surface));
      font-weight: 680;
      text-align: end;
    }
  }

  &__button {
    margin-top: var(--wiki-space-4);
  }
}

.dashboard-section-heading {
  display: flex;
  align-items: flex-end;
  gap: var(--wiki-space-5);
  margin: var(--wiki-space-8) var(--wiki-space-1) var(--wiki-space-1);

  &--compact {
    margin-top: var(--wiki-space-3);
  }

  h2 {
    margin: var(--wiki-space-1) 0 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.3rem;
    font-weight: 720;
    letter-spacing: -.025em;
  }

  &__eyebrow {
    color: var(--wiki-accent-warm);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  &__rule {
    height: 1px;
    margin-bottom: var(--wiki-space-2);
    flex: 1 1 auto;
    background: linear-gradient(90deg, var(--wiki-surface-border-strong), transparent);
  }
}

.dashboard-activity {
  min-height: 20.625rem;

  .v-table {
    background: transparent;
  }

  .v-table__wrapper {
    padding: var(--wiki-space-1) var(--wiki-space-3) var(--wiki-space-3);
  }

  td {
    border-color: var(--wiki-surface-border) !important;
  }
}

.dashboard-data-table,
.dashboard-mobile-list {
  min-height: 15rem;
}

.dashboard-mobile-list {
  background: transparent;
}

@include until($tablet) {
  .admin-dashboard {
    &__build {
      width: 100%;
      align-items: center;
      grid-template-columns: auto minmax(0, 1fr);
      justify-items: start;

      .v-chip {
        max-width: 100%;
      }
    }
  }

  .dashboard-actions {
    grid-template-columns: 1fr;
  }

  .dashboard-panel__header {
    align-items: flex-start;
  }
}

@media (max-width: 599px) {

  .dashboard-panel {
    &__header {
      flex-wrap: wrap;
      padding: var(--wiki-space-4);

      > .v-btn {
        margin-inline-start: calc(var(--wiki-control-height) + var(--wiki-space-3));
      }
    }
  }

  .dashboard-overview__row {
    align-items: flex-start;
  }

  .dashboard-section-heading {
    margin-top: var(--wiki-space-6);
  }
}

@media print {
  .admin-stat,
  .dashboard-panel {
    break-inside: avoid;
    box-shadow: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-stat,
  .dashboard-action {
    transition: none;
  }
}
</style>


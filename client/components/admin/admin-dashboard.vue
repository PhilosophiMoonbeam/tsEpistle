<template lang='pug'>
  v-container.admin-dashboard(fluid)
    .admin-header
      img(src='/_assets/svg/icon-features-list.svg' alt='' style='width: 80px;')
      .admin-header-title
        h1.text-headline-medium.text-primary(tabindex='-1') {{ $t('admin:dashboard.title') }}
        .text-body-large.text-medium-emphasis {{ $t('admin:dashboard.subtitle') }}
      v-spacer
      v-chip(size='small' variant='tonal' color='primary' prepend-icon='mdi-source-fork') {{ info.product.name }} {{ info.product.version }}

    v-row.admin-dashboard__stats
      v-col(v-for='stat in dashboardStats' :key='stat.key' cols='12' sm='6' xl='3' class='d-flex')
        v-card.admin-stat(:class='`admin-stat--${stat.tone}`' :to='stat.to' :aria-label='stat.ariaLabel' flat)
          .admin-stat__icon
            v-icon(size='23') {{ stat.icon }}
          .admin-stat__body
            .admin-stat__label {{ stat.label }}
            animated-number.admin-stat__value(v-if='stat.value !== undefined' :value='stat.value' :duration='1200' :formatValue='round' easing='easeOutQuint')
            .admin-stat__value.admin-stat__value--text(v-else) {{ stat.textValue }}
            .admin-stat__hint {{ stat.hint }}
          v-icon.admin-stat__arrow(size='18') mdi-arrow-up-right

    v-row.admin-dashboard__workspace
      v-col(cols='12' lg='8')
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
      v-col(cols='12' lg='4')
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
                .dashboard-overview__product-name {{ info.product.name }}
                .dashboard-overview__product-version Version {{ info.product.version }}
            .dashboard-overview__list
              .dashboard-overview__row
                span Content
                strong {{ info.pagesTotal }} pages · {{ info.tagsTotal }} tags
              .dashboard-overview__row
                span Access
                strong {{ info.usersTotal }} users · {{ info.groupsTotal }} groups
              .dashboard-overview__row
                span Foundation
                strong {{ info.product.upstreamBase }}
            v-btn.dashboard-overview__button(v-if='hasPermission(`manage:system`)' to='/system' variant='tonal' color='primary' block prepend-icon='mdi-monitor-dashboard' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') Open system details

    .dashboard-section-heading
      div
        .dashboard-section-heading__eyebrow Activity
        h2 What changed recently
      .dashboard-section-heading__rule

    v-row
      v-col(cols='12' xl='6' v-if='canViewRecentPages')
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
      v-col(cols='12' xl='6' v-if='canViewLastLogins')
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

    v-card.dashboard-contribute(flat)
      .dashboard-contribute__art
        img(src='/_assets/svg/icon-heart-health.svg' alt='')
      .dashboard-contribute__copy
        .dashboard-contribute__eyebrow Open source, made together
        h2 {{ $t('admin:dashboard.contributeSubtitle') }}
        p {{ $t('admin:dashboard.contributeHelp') }}
      v-btn(color='primary' variant='tonal' to='/contribute' :append-icon='$vuetify.locale.isRtl ? `mdi-arrow-left` : `mdi-arrow-right`') {{ $t('admin:dashboard.contributeLearnMore') }}
</template>

<script lang='ts'>
import _ from 'lodash'
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
      recentPagesHeaders: [
        { title: 'Title', value: 'title' },
        { title: 'Path', value: 'path' },
        { title: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      lastLogins: [] as LastLoginRow[],
      lastLoginsLoading: false,
      lastLoginsError: '',
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
      else if (!newValue) this.recentPages = []
    },
    canViewLastLogins(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) this.loadLastLogins()
      else if (!newValue) this.lastLogins = []
    }
  },
  created() {
    if (this.canViewRecentPages) this.loadRecentPages()
    if (this.canViewLastLogins) this.loadLastLogins()
  },
  methods: {
    round(val: number) { return Math.round(val) },
    hasPermission(prm: string | string[]) {
      return _.isArray(prm) ? _.some(prm, p => _.includes(this.permissions, p)) : _.includes(this.permissions, prm)
    },
    async loadRecentPages() {
      this.recentPagesLoading = true
      this.recentPagesError = ''
      loadingStart(wikiStore, 'admin-dashboard-recentpages')
      try {
        this.recentPages = await fetchRecentPages(window.fetch.bind(window), 'Recent pages response is invalid')
        return true
      } catch (err) {
        this.recentPagesError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.recentPagesError, style: 'error', icon: 'alert' })
        return false
      } finally {
        this.recentPagesLoading = false
        loadingStop(wikiStore, 'admin-dashboard-recentpages')
      }
    },
    async loadLastLogins() {
      this.lastLoginsLoading = true
      this.lastLoginsError = ''
      loadingStart(wikiStore, 'admin-dashboard-lastlogins')
      try {
        this.lastLogins = await fetchLastLogins(window.fetch.bind(window), 'Last logins response is invalid')
        return true
      } catch (err) {
        this.lastLoginsError = getErrorMessage(err)
        showNotification(wikiStore, { message: this.lastLoginsError, style: 'error', icon: 'alert' })
        return false
      } finally {
        this.lastLoginsLoading = false
        loadingStop(wikiStore, 'admin-dashboard-lastlogins')
      }
    }
  }
}
</script>
<style lang='scss'>
.admin-dashboard {
  &__stats {
    margin-bottom: 6px;
  }

  &__workspace {
    margin-top: 2px;
  }
}

.admin-stat {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 134px;
  align-items: flex-start;
  gap: 15px;
  padding: 20px;
  border: 1px solid rgba(var(--v-border-color), .12) !important;
  border-radius: var(--wiki-panel-radius, 16px) !important;
  background: rgb(var(--v-theme-surface)) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: 0 8px 26px rgba(20, 28, 50, .045);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--stat-color) 34%, transparent) !important;
    box-shadow: 0 14px 34px rgba(20, 28, 50, .09);
    transform: translateY(-2px);
  }

  &--primary { --stat-color: rgb(var(--v-theme-primary)); }
  &--secondary { --stat-color: rgb(var(--v-theme-secondary)); }
  &--info { --stat-color: rgb(var(--v-theme-info)); }
  &--warning { --stat-color: rgb(var(--v-theme-warning)); }

  &__icon {
    display: grid;
    flex: 0 0 auto;
    width: 46px;
    height: 46px;
    place-items: center;
    border-radius: var(--wiki-control-radius, 11px);
    background: color-mix(in srgb, var(--stat-color) 12%, transparent);
    color: var(--stat-color);
  }

  &__body {
    min-width: 0;
  }

  &__label {
    color: rgb(var(--v-theme-on-surface));
    opacity: .62;
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  &__value {
    display: block;
    margin: 2px 0 1px;
    color: rgb(var(--v-theme-on-surface));
    font-size: 2rem;
    font-weight: 740;
    letter-spacing: -.045em;
    line-height: 1.1;

    &--text {
      overflow: hidden;
      max-width: 170px;
      font-size: 1.25rem;
      line-height: 1.65;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &__hint {
    color: rgb(var(--v-theme-on-surface));
    opacity: .64;
    font-size: .77rem;
  }

  &__arrow {
    position: absolute !important;
    inset-block-start: 16px;
    inset-inline-end: 16px;
    color: rgb(var(--v-theme-on-surface));
    opacity: .6;
  }
}

.dashboard-panel {
  overflow: hidden;

  &__header {
    display: flex;
    min-height: 78px;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 18px 20px;
    border-bottom: 1px solid rgba(var(--v-border-color), .1);
  }

  &__heading {
    display: flex;
    align-items: center;
    gap: 13px;

    h2 {
      margin: 0;
      color: rgb(var(--v-theme-on-surface));
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: -.015em;
    }

    p {
      margin: 2px 0 0;
      color: rgb(var(--v-theme-on-surface));
      opacity: .65;
      font-size: .78rem;
    }
  }

  &__icon {
    display: grid;
    flex: 0 0 auto;
    width: 42px;
    height: 42px;
    place-items: center;
    border-radius: var(--wiki-control-radius, 11px);
    background: rgba(var(--v-theme-primary), .1);
    color: rgb(var(--v-theme-primary));

    &--success {
      background: rgba(var(--v-theme-success), .11);
      color: rgb(var(--v-theme-success));
    }

    &--violet {
      background: rgba(var(--v-theme-secondary), .11);
      color: rgb(var(--v-theme-secondary));
    }
  }
}

.dashboard-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.dashboard-action {
  display: flex;
  min-height: 88px;
  align-items: center;
  gap: 13px;
  padding: 14px;
  border: 1px solid transparent !important;
  border-radius: var(--wiki-control-radius, 11px) !important;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 3%, transparent) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  transition: border-color .16s ease, background-color .16s ease, transform .16s ease;

  &:hover {
    border-color: rgba(var(--v-theme-primary), .2) !important;
    background: rgba(var(--v-theme-primary), .055) !important;
    transform: translateY(-1px);

    .dashboard-action__arrow {
      color: rgb(var(--v-theme-primary));
      transform: translateX(2px);
    }
  }

  @at-root .v-locale--is-rtl & {
    &:hover .dashboard-action__arrow {
      transform: translateX(-2px);
    }
  }

  &__icon {
    display: grid;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    place-items: center;
    border-radius: var(--wiki-control-radius, 11px);

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
    margin-bottom: 3px;
    font-size: .9rem;
    font-weight: 680;
  }

  &__description {
    color: rgb(var(--v-theme-on-surface));
    opacity: .68;
    font-size: .76rem;
    line-height: 1.35;
  }

  &__arrow {
    flex: 0 0 auto;
    color: rgb(var(--v-theme-on-surface));
    opacity: .64;
    transition: color .16s ease, transform .16s ease;
  }
}

.dashboard-overview {
  &__product {
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 2px 0 18px;
  }

  &__product-icon {
    display: grid;
    width: 50px;
    height: 50px;
    place-items: center;
    border-radius: var(--wiki-control-radius, 11px);
    background: linear-gradient(145deg, rgba(var(--v-theme-primary), .16), rgba(var(--v-theme-secondary), .08));
    color: rgb(var(--v-theme-primary));
  }

  &__product-name {
    font-size: .95rem;
    font-weight: 700;
  }

  &__product-version {
    color: rgb(var(--v-theme-on-surface));
    opacity: .64;
    font-size: .78rem;
  }

  &__list {
    border-block: 1px solid rgba(var(--v-border-color), .1);
  }

  &__row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    color: rgb(var(--v-theme-on-surface));
    opacity: .65;
    font-size: .8rem;

    + .dashboard-overview__row {
      border-top: 1px solid rgba(var(--v-border-color), .08);
    }

    strong {
      color: rgb(var(--v-theme-on-surface));
      font-weight: 650;
      text-align: end;
    }
  }

  &__button {
    margin-top: 18px;
  }
}

.dashboard-section-heading {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  margin: 30px 2px 4px;

  h2 {
    margin: 2px 0 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.3rem;
    font-weight: 710;
    letter-spacing: -.025em;
  }

  &__eyebrow {
    color: rgb(var(--v-theme-primary));
    font-size: .67rem;
    font-weight: 760;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  &__rule {
    height: 1px;
    margin-bottom: 6px;
    flex: 1;
    background: linear-gradient(90deg, rgba(var(--v-border-color), .2), transparent);
  }
}

.dashboard-activity {
  min-height: 330px;

  .v-table {
    background: transparent;
  }

  .v-table__wrapper {
    padding: 4px 12px 12px;
  }

  td {
    border-color: rgba(var(--v-border-color), .08) !important;
  }
}

.dashboard-data-table,
.dashboard-mobile-list {
  min-height: 15rem;
}

.dashboard-contribute {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 26px;
  padding: 22px 24px;
  border: 1px solid rgba(var(--v-theme-primary), .14) !important;
  border-radius: var(--wiki-panel-radius, 16px) !important;
  background:
    linear-gradient(110deg, rgba(var(--v-theme-primary), .09), rgba(var(--v-theme-secondary), .045), transparent) !important;
  color: rgb(var(--v-theme-on-surface)) !important;

  &__art {
    display: grid;
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    place-items: center;
    border-radius: var(--wiki-control-radius, 11px);
    background: rgb(var(--v-theme-surface));

    img {
      width: 46px;
      height: 46px;
    }
  }

  &__copy {
    min-width: 0;
    flex: 1 1 auto;

    h2 {
      margin: 2px 0;
      font-size: 1rem;
      font-weight: 700;
    }

    p {
      margin: 0;
      color: rgb(var(--v-theme-on-surface));
      opacity: .68;
      font-size: .82rem;
    }
  }

  &__eyebrow {
    color: rgb(var(--v-theme-primary));
    font-size: .65rem;
    font-weight: 750;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
}

@include until($tablet) {
  .dashboard-actions {
    grid-template-columns: 1fr;
  }

  .dashboard-panel__header {
    align-items: flex-start;
  }

  .dashboard-contribute {
    flex-wrap: wrap;

    &__copy {
      flex: 1 1 calc(100% - 90px);
    }

    > .v-btn {
      width: 100%;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-stat,
  .dashboard-action {
    transition: none;
  }
}
</style>


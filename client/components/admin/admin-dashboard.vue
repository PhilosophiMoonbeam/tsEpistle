<template lang='pug'>
  v-container.admin-dashboard(fluid)
    section.admin-dashboard__hero.animated.fadeInUp
      .admin-dashboard__hero-copy
        .admin-dashboard__eyebrow
          span.admin-dashboard__pulse
          span Workspace overview
        h1 {{ $t('admin:dashboard.title') }}
        p {{ $t('admin:dashboard.subtitle') }}
        .admin-dashboard__hero-meta
          v-chip(size='small' variant='tonal' color='primary' prepend-icon='mdi-source-fork') {{ info.product.name }} {{ info.product.version }}
          v-chip(size='small' variant='outlined' prepend-icon='mdi-clock-outline') Updated just now
      .admin-dashboard__hero-art(aria-hidden='true')
        .admin-dashboard__hero-orbit
        v-icon mdi-view-dashboard-variant-outline

    v-row.admin-dashboard__stats
      v-col(
        v-for='stat in dashboardStats'
        :key='stat.key'
        cols='12'
        sm='6'
        xl='3'
        class='d-flex'
      )
        v-card.admin-stat(
          :class='`admin-stat--${stat.tone}`'
          :to='stat.to'
          :aria-label='stat.ariaLabel'
          flat
        )
          .admin-stat__icon
            v-icon(size='23') {{ stat.icon }}
          .admin-stat__body
            .admin-stat__label {{ stat.label }}
            animated-number.admin-stat__value(
              v-if='stat.value !== undefined'
              :value='stat.value'
              :duration='1200'
              :formatValue='round'
              easing='easeOutQuint'
            )
            .admin-stat__value.admin-stat__value--text(v-else) {{ stat.textValue }}
            .admin-stat__hint {{ stat.hint }}
          v-icon.admin-stat__arrow(size='18') mdi-arrow-up-right

    v-row.admin-dashboard__workspace
      v-col(cols='12' lg='8')
        v-card.dashboard-panel.fill-height.animated.fadeInUp.wait-p2s
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon
                v-icon(size='21') mdi-lightning-bolt-outline
              div
                h2 Start with an outcome
                p Jump directly to the work you want to complete.
          v-card-text
            .dashboard-actions
              v-card.dashboard-action(
                v-for='action in quickActions'
                :key='action.key'
                :to='action.to'
                flat
              )
                .dashboard-action__icon(:class='`dashboard-action__icon--${action.tone}`')
                  v-icon(size='22') {{ action.icon }}
                .dashboard-action__copy
                  .dashboard-action__title {{ action.title }}
                  .dashboard-action__description {{ action.description }}
                v-icon.dashboard-action__arrow(size='18') mdi-chevron-right
      v-col(cols='12' lg='4')
        v-card.dashboard-panel.dashboard-overview.fill-height.animated.fadeInUp.wait-p3s
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
            v-btn.dashboard-overview__button(
              v-if='hasPermission(`manage:system`)'
              to='/system'
              variant='tonal'
              color='primary'
              block
              prepend-icon='mdi-monitor-dashboard'
              append-icon='mdi-arrow-right'
            ) Open system details

    .dashboard-section-heading
      div
        .dashboard-section-heading__eyebrow Activity
        h2 What changed recently
      .dashboard-section-heading__rule

    v-row
      v-col(cols='12' xl='6' v-if='canViewRecentPages')
        v-card.dashboard-panel.dashboard-activity.fill-height.animated.fadeInUp.wait-p2s
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon
                v-icon(size='21') mdi-file-clock-outline
              div
                h2 {{ $t('admin:dashboard.recentPages') }}
                p Recently updated content.
            v-btn(to='/pages' variant='text' size='small' append-icon='mdi-arrow-right') View all
          v-list.dashboard-mobile-list(v-if='$vuetify.display.smAndDown' lines='three')
            v-list-item(
              v-for='page in recentPages'
              :key='page.id'
              @click='$router.push(`/pages/` + page.id)'
              rounded='lg'
            )
              template(v-slot:prepend)
                v-avatar(color='primary' variant='tonal' rounded='lg')
                  v-icon mdi-file-document-outline
              v-list-item-title: strong {{ page.title }}
              v-list-item-subtitle
                v-chip.mr-2(size='x-small' color='secondary' variant='tonal') {{ page.locale }}
                span /{{ page.path }}
              .text-body-small.text-medium-emphasis {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
            v-list-item(v-if='!recentPagesLoading && recentPages.length === 0')
              v-list-item-title.text-medium-emphasis No recent pages
          v-data-table.dashboard-data-table(
            v-else
            :items='recentPages'
            :headers='recentPagesHeaders'
            :loading='recentPagesLoading'
            hide-default-footer
            hide-default-header
          )
            template(v-slot:item='props')
              tr.is-clickable(@click='$router.push(`/pages/` + props.item.id)')
                td
                  .text-body-medium: strong {{ props.item.title }}
                td.admin-pages-path
                  v-chip(size='small' color='secondary' variant='tonal') {{ props.item.locale }}
                  span.ml-2.text-medium-emphasis /{{ props.item.path }}
                td.text-right.text-body-small(width='200') {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
      v-col(cols='12' xl='6' v-if='canViewLastLogins')
        v-card.dashboard-panel.dashboard-activity.fill-height.animated.fadeInUp.wait-p3s
          .dashboard-panel__header
            .dashboard-panel__heading
              .dashboard-panel__icon.dashboard-panel__icon--violet
                v-icon(size='21') mdi-account-clock-outline
              div
                h2 {{ $t('admin:dashboard.lastLogins') }}
                p Recent access to the workspace.
            v-btn(to='/users' variant='text' size='small' append-icon='mdi-arrow-right') View all
          v-list.dashboard-mobile-list(v-if='$vuetify.display.smAndDown' lines='two')
            v-list-item(
              v-for='user in lastLogins'
              :key='user.id'
              @click='$router.push(`/users/` + user.id)'
              rounded='lg'
            )
              template(v-slot:prepend)
                v-avatar(color='secondary' variant='tonal')
                  v-icon mdi-account-outline
              v-list-item-title: strong {{ user.name }}
              v-list-item-subtitle {{ $helpers.formatMoment(user.lastLoginAt, 'calendar') }}
            v-list-item(v-if='!lastLoginsLoading && lastLogins.length === 0')
              v-list-item-title.text-medium-emphasis No recent logins
          v-data-table.dashboard-data-table(
            v-else
            :items='lastLogins'
            :headers='lastLoginsHeaders'
            :loading='lastLoginsLoading'
            hide-default-footer
            hide-default-header
          )
            template(v-slot:item='props')
              tr.is-clickable(@click='$router.push(`/users/` + props.item.id)')
                td
                  .d-flex.align-center.ga-3
                    v-avatar(color='secondary' variant='tonal' size='34')
                      v-icon(size='18') mdi-account-outline
                    .text-body-medium: strong {{ props.item.name }}
                td.text-right.text-body-small(width='200') {{ $helpers.formatMoment(props.item.lastLoginAt, 'calendar') }}

    v-card.dashboard-contribute.animated.fadeInUp.wait-p4s(flat)
      .dashboard-contribute__art
        img(src='/_assets/svg/icon-heart-health.svg' alt='')
      .dashboard-contribute__copy
        .dashboard-contribute__eyebrow Open source, made together
        h2 {{ $t('admin:dashboard.contributeSubtitle') }}
        p {{ $t('admin:dashboard.contributeHelp') }}
      v-btn(color='primary' variant='tonal' to='/contribute' append-icon='mdi-arrow-right')
        span {{ $t('admin:dashboard.contributeLearnMore') }}
</template>

<script lang='ts'>
import _ from 'lodash'
import AnimatedNumber from '@/components/common/animated-number.vue'
import { wikiStore } from '@/store/index.ts'
import { fetchRecentPages, type RecentPageRow } from '../../helpers/pages-api'
import { fetchLastLogins, type LastLoginRow } from '../../helpers/users-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

export default {
  components: {
    AnimatedNumber
  },
  data() {
    return {
      recentPages: [] as RecentPageRow[],
      recentPagesLoading: false,
      recentPagesHeaders: [
        { title: 'Title', value: 'title' },
        { title: 'Path', value: 'path' },
        { title: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      lastLogins: [] as LastLoginRow[],
      lastLoginsLoading: false,
      lastLoginsHeaders: [
        { title: 'User', value: 'displayName' },
        { title: 'Last Login', value: 'lastLoginAt', width: 250 }
      ]
    }
  },
  computed: {
    canViewRecentPages() {
      return this.hasPermission(['manage:system', 'read:pages'])
    },
    canViewLastLogins() {
      return this.hasPermission(['manage:system', 'manage:groups', 'write:groups', 'manage:users', 'write:users'])
    },
    info() {
      return wikiStore.admin.info
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
          hint: 'Published content',
          icon: 'mdi-file-document-multiple-outline',
          tone: 'blue',
          to: '/pages',
          ariaLabel: `${this.info.pagesTotal} pages. Open page management.`
        },
        {
          key: 'users',
          label: this.$t('admin:dashboard.users'),
          value: this.info.usersTotal,
          hint: 'People with access',
          icon: 'mdi-account-multiple-outline',
          tone: 'violet',
          to: '/users',
          ariaLabel: `${this.info.usersTotal} users. Open user management.`
        },
        {
          key: 'groups',
          label: this.$t('admin:dashboard.groups'),
          value: this.info.groupsTotal,
          hint: 'Permission sets',
          icon: 'mdi-account-key-outline',
          tone: 'teal',
          to: '/groups',
          ariaLabel: `${this.info.groupsTotal} groups. Open group management.`
        },
        {
          key: 'version',
          label: 'Current build',
          textValue: this.info.product.version,
          hint: 'System information',
          icon: 'mdi-source-fork',
          tone: 'amber',
          to: '/system',
          ariaLabel: `Version ${this.info.product.version}. Open system information.`
        }
      ]
    },
    quickActions() {
      return [
        {
          key: 'pages',
          title: 'Organize content',
          description: 'Review pages, ownership and publication.',
          icon: 'mdi-file-tree-outline',
          tone: 'blue',
          to: '/pages',
          permission: ['manage:system', 'write:pages', 'manage:pages', 'delete:pages']
        },
        {
          key: 'general',
          title: 'Shape the workspace',
          description: 'Identity, metadata and editing behavior.',
          icon: 'mdi-tune-variant',
          tone: 'violet',
          to: '/general',
          permission: 'manage:system'
        },
        {
          key: 'users',
          title: 'Manage people',
          description: 'Invite, suspend and support members.',
          icon: 'mdi-account-supervisor-outline',
          tone: 'teal',
          to: '/users',
          permission: ['manage:system', 'manage:users', 'write:users']
        },
        {
          key: 'theme',
          title: 'Refine appearance',
          description: 'Typography, colors and presentation.',
          icon: 'mdi-palette-outline',
          tone: 'pink',
          to: '/theme',
          permission: ['manage:system', 'manage:theme']
        },
        {
          key: 'search',
          title: 'Tune discovery',
          description: 'Configure how readers find knowledge.',
          icon: 'mdi-text-search-variant',
          tone: 'amber',
          to: '/search',
          permission: 'manage:system'
        },
        {
          key: 'security',
          title: 'Review security',
          description: 'Protect sessions, access and content.',
          icon: 'mdi-shield-check-outline',
          tone: 'green',
          to: '/security',
          permission: 'manage:system'
        }
      ].filter(action => this.hasPermission(action.permission))
    },
  },
  watch: {
    canViewRecentPages(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.loadRecentPages()
      } else if (!newValue) {
        this.recentPages = []
      }
    },
    canViewLastLogins(newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.loadLastLogins()
      } else if (!newValue) {
        this.lastLogins = []
      }
    }
  },
  created() {
    if (this.canViewRecentPages) {
      this.loadRecentPages()
    }
    if (this.canViewLastLogins) {
      this.loadLastLogins()
    }
  },
  methods: {
    round(val: number) { return Math.round(val) },
    hasPermission(prm: string | string[]) {
      if (_.isArray(prm)) {
        return _.some(prm, p => {
          return _.includes(this.permissions, p)
        })
      } else {
        return _.includes(this.permissions, prm)
      }
    },
    async loadRecentPages() {
      this.recentPagesLoading = true
      loadingStart(wikiStore, 'admin-dashboard-recentpages')

      try {
        this.recentPages = await fetchRecentPages(window.fetch.bind(window), 'Recent pages response is invalid')
        return true
      } catch (err) {
        this.recentPages = []
        showNotification(wikiStore, {
          message: getErrorMessage(err),
          style: 'error',
          icon: 'alert'
        })
        return false
      } finally {
        this.recentPagesLoading = false
        loadingStop(wikiStore, 'admin-dashboard-recentpages')
      }
    },
    async loadLastLogins() {
      this.lastLoginsLoading = true
      loadingStart(wikiStore, 'admin-dashboard-lastlogins')

      try {
        this.lastLogins = await fetchLastLogins(window.fetch.bind(window), 'Last logins response is invalid')
        return true
      } catch (err) {
        this.lastLogins = []
        showNotification(wikiStore, {
          message: getErrorMessage(err),
          style: 'error',
          icon: 'alert'
        })
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
  &__hero {
    position: relative;
    display: flex;
    overflow: hidden;
    align-items: center;
    min-height: 220px;
    margin-bottom: 22px;
    padding: clamp(28px, 5vw, 54px);
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 18%, transparent);
    border-radius: 24px;
    background:
      radial-gradient(circle at 88% 20%, rgba(var(--v-theme-primary), .2), transparent 18rem),
      linear-gradient(135deg, color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface))), rgb(var(--v-theme-surface)) 58%);
    box-shadow: 0 18px 55px rgba(20, 28, 50, .08);
  }

  &__hero-copy {
    position: relative;
    z-index: 2;
    max-width: 760px;

    h1 {
      margin: 12px 0 8px;
      color: rgb(var(--v-theme-on-surface));
      font-size: clamp(2.1rem, 4vw, 3.65rem);
      font-weight: 760;
      letter-spacing: -.055em;
      line-height: 1;
    }

    p {
      max-width: 620px;
      margin: 0;
      color: rgb(var(--v-theme-on-surface));
      opacity: .68;
      font-size: 1.08rem;
      line-height: 1.55;
    }
  }

  &__eyebrow {
    display: flex;
    align-items: center;
    gap: 9px;
    color: rgb(var(--v-theme-primary));
    font-size: .7rem;
    font-weight: 780;
    letter-spacing: .13em;
    text-transform: uppercase;
  }

  &__pulse {
    width: 8px;
    height: 8px;
    border: 2px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 30%, transparent);
    border-radius: 50%;
    background: rgb(var(--v-theme-primary));
    box-shadow: 0 0 0 5px rgba(var(--v-theme-primary), .1);
  }

  &__hero-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 22px;
  }

  &__hero-art {
    position: absolute;
    right: clamp(24px, 7vw, 110px);
    display: grid;
    width: 150px;
    height: 150px;
    place-items: center;
    border: 1px solid rgba(var(--v-theme-primary), .16);
    border-radius: 38px;
    background: rgba(var(--v-theme-surface), .54);
    color: rgb(var(--v-theme-primary));
    box-shadow:
      0 30px 70px rgba(var(--v-theme-primary), .15),
      inset 0 1px 0 rgba(255, 255, 255, .4);
    transform: rotate(5deg);
    backdrop-filter: blur(14px);

    > .v-icon {
      font-size: 68px;
      transform: rotate(-5deg);
    }
  }

  &__hero-orbit {
    position: absolute;
    width: 210px;
    height: 210px;
    border: 1px dashed rgba(var(--v-theme-primary), .18);
    border-radius: 50%;
  }

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
  border-radius: 17px !important;
  background: rgb(var(--v-theme-surface)) !important;
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: 0 8px 26px rgba(20, 28, 50, .045);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--stat-color) 34%, transparent) !important;
    box-shadow: 0 14px 34px rgba(20, 28, 50, .09);
    transform: translateY(-2px);
  }

  &--blue { --stat-color: #3b82f6; }
  &--violet { --stat-color: #8b5cf6; }
  &--teal { --stat-color: #0d9488; }
  &--amber { --stat-color: #d97706; }

  &__icon {
    display: grid;
    flex: 0 0 auto;
    width: 46px;
    height: 46px;
    place-items: center;
    border-radius: 14px;
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
    top: 16px;
    right: 16px;
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
    border-radius: 13px;
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
  border-radius: 14px !important;
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

  &__icon {
    display: grid;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    place-items: center;
    border-radius: 13px;

    &--blue { background: rgba(59, 130, 246, .11); color: #3b82f6; }
    &--violet { background: rgba(139, 92, 246, .11); color: #8b5cf6; }
    &--teal { background: rgba(13, 148, 136, .11); color: #0d9488; }
    &--pink { background: rgba(219, 39, 119, .1); color: #db2777; }
    &--amber { background: rgba(217, 119, 6, .11); color: #d97706; }
    &--green { background: rgba(22, 163, 74, .11); color: #16a34a; }
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
    border-radius: 15px;
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
      text-align: right;
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
  border-radius: 18px !important;
  background:
    linear-gradient(110deg, rgba(var(--v-theme-primary), .09), rgba(var(--v-theme-secondary), .045), transparent) !important;
  color: rgb(var(--v-theme-on-surface)) !important;

  &__art {
    display: grid;
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    place-items: center;
    border-radius: 17px;
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
  .admin-dashboard {
    &__hero {
      min-height: 240px;
      padding: 28px 22px;
    }

    &__hero-copy {
      padding-right: 0;

      h1 {
        font-size: 2.25rem;
      }

      p {
        font-size: .95rem;
      }
    }

    &__hero-art {
      right: -44px;
      bottom: -52px;
      width: 140px;
      height: 140px;
      opacity: .38;
    }
  }

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

<style lang='scss'>

.dashboard-card {
  display: flex;
  width: 100%;
  border-radius: 12px;

  .v-card-text {
    overflow: hidden;
    position: relative;
  }
}

.dashboard-section-toolbar {
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, rgb(var(--v-theme-surface))) !important;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  .text-label-small {
    color: rgb(var(--v-theme-on-surface)) !important;
    opacity: 1;
  }
}

.dashboard-data-table td,
.dashboard-data-table td strong {
  color: rgb(var(--v-theme-on-surface)) !important;
  opacity: 1;
}

.dashboard-mobile-list .v-list-item-subtitle {
  color: rgb(var(--v-theme-on-surface)) !important;
  opacity: 1;
}

.dashboard-contribute {
  background-color: rgb(var(--v-theme-surface));
  background-image: linear-gradient(
    145deg,
    rgb(var(--v-theme-surface)) 0%,
    color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface))) 100%
  );
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;

  .v-card-text {
    display: flex;
    align-items: center;
    color: rgb(var(--v-theme-on-surface)) !important;
  }
}

.v-icon.dashboard-icon {
  position: absolute !important;
  right: 0;
  top: 12px;
  font-size: 100px !important;
  opacity: .25;

  @at-root .v-locale--is-rtl & {
    left: 0;
    right: initial;
  }
}

</style>

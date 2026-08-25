<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-browse-page.svg', alt='Dashboard', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:dashboard.title') }}
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p2s {{ $t('admin:dashboard.subtitle') }}
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.bg-primary.dashboard-card.animated.fadeInUp
          v-card-text
            v-icon.dashboard-icon mdi-file-document-outline
            .text-label-small {{$t('admin:dashboard.pages')}}
            animated-number.text-headline-large(
              :value='info.pagesTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.bg-secondary.dashboard-card.animated.fadeInUp.wait-p2s
          v-card-text
            v-icon.dashboard-icon mdi-account
            .text-label-small {{$t('admin:dashboard.users')}}
            animated-number.text-headline-large(
              :value='info.usersTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.bg-accent.dashboard-card.animated.fadeInUp.wait-p4s
          v-card-text
            v-icon.dashboard-icon mdi-account-group
            .text-label-small {{$t('admin:dashboard.groups')}}
            animated-number.text-headline-large(
              :value='info.groupsTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='12' xl='3' class='d-flex')
        v-card.dashboard-card.animated.fadeInUp.wait-p6s.bg-info
          v-btn(icon, absolute, location='top end', size="small", color='on-info', variant='text', to='system', v-if='hasPermission(`manage:system`)', aria-label='System information')
            v-icon(size="small") mdi-information-outline
          v-card-text
            v-icon.dashboard-icon mdi-source-fork
            .text-body-large {{ info.product.name }} {{ info.product.version }}
            .text-body-medium Preview update checks are unavailable
            .text-body-small {{ info.product.upstreamBase }}
      v-col(cols='12', xl='6')
        v-card.radius-7.animated.fadeInUp.wait-p2s
          v-toolbar.dashboard-section-toolbar(density="compact", flat)
            v-spacer
            .text-label-small {{$t('admin:dashboard.recentPages')}}
            v-spacer
          v-list.dashboard-mobile-list(v-if='$vuetify.display.smAndDown', lines='three')
            v-list-item(
              v-for='page in recentPages'
              :key='page.id'
              @click='$router.push(`/pages/` + page.id)'
            )
              v-list-item-title: strong {{ page.title }}
              v-list-item-subtitle
                v-chip.mr-2(label, size="x-small", color='secondary', variant='tonal') {{ page.locale }}
                span /{{ page.path }}
              .text-body-small.text-medium-emphasis {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
            v-list-item(v-if='!recentPagesLoading && recentPages.length === 0')
              v-list-item-title.text-medium-emphasis No recent pages
          v-data-table.dashboard-data-table.pb-2(
            v-else
            :items='recentPages'
            :headers='recentPagesHeaders'
            :loading='recentPagesLoading'
            hide-default-footer
            hide-default-header
            )
            template(v-slot:item='props')
              tr.is-clickable(:active='props.selected', @click='$router.push(`/pages/` + props.item.id)')
                td
                  .text-body-medium: strong {{ props.item.title }}
                td.admin-pages-path
                  v-chip(label, size="small", color='secondary', variant='tonal') {{ props.item.locale }}
                  span.ml-2.text-medium-emphasis / {{ props.item.path }}
                td.text-right.text-body-small(width='250') {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
      v-col(cols='12', xl='6')
        v-card.radius-7.animated.fadeInUp.wait-p4s
          v-toolbar.dashboard-section-toolbar(density="compact", flat)
            v-spacer
            .text-label-small {{$t('admin:dashboard.lastLogins')}}
            v-spacer
          v-list.dashboard-mobile-list(v-if='$vuetify.display.smAndDown', lines='two')
            v-list-item(
              v-for='user in lastLogins'
              :key='user.id'
              @click='$router.push(`/users/` + user.id)'
            )
              v-list-item-title: strong {{ user.name }}
              v-list-item-subtitle {{ $helpers.formatMoment(user.lastLoginAt, 'calendar') }}
            v-list-item(v-if='!lastLoginsLoading && lastLogins.length === 0')
              v-list-item-title.text-medium-emphasis No recent logins
          v-data-table.dashboard-data-table.pb-2(
            v-else
            :items='lastLogins'
            :headers='lastLoginsHeaders'
            :loading='lastLoginsLoading'
            hide-default-footer
            hide-default-header
            )
            template(v-slot:item='props')
              tr.is-clickable(:active='props.selected', @click='$router.push(`/users/` + props.item.id)')
                td
                  .text-body-medium: strong {{ props.item.name }}
                td.text-right.text-body-small(width='250') {{ $helpers.formatMoment(props.item.lastLoginAt, 'calendar') }}

      v-col(cols='12')
        v-card.dashboard-contribute.animated.fadeInUp.wait-p4s
          v-card-text
            img(src='/_assets/svg/icon-heart-health.svg', alt='Contribute', style='height: 80px;')
            .pl-5
              .text-body-large {{$t('admin:contribute.title')}}
              .text-body-medium.mt-3: strong {{$t('admin:dashboard.contributeSubtitle')}}
              .text-body-medium {{$t('admin:dashboard.contributeHelp')}}
              v-btn.mx-0.mt-4(color='primary', variant="outlined", size="small", to='/contribute')
                .text-body-small: strong {{$t('admin:dashboard.contributeLearnMore')}}
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
    }
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
<style scoped>
.dashboard-data-table,
.dashboard-mobile-list {
  min-height: 16rem;
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

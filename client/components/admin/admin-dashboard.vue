<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-browse-page.svg', alt='Dashboard', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:dashboard.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s {{ $t('admin:dashboard.subtitle') }}
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.primary.dashboard-card.animated.fadeInUp(dark)
          v-card-text
            v-icon.dashboard-icon mdi-file-document-outline
            .overline {{$t('admin:dashboard.pages')}}
            animated-number.display-1(
              :value='info.pagesTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.blue.darken-3.dashboard-card.animated.fadeInUp.wait-p2s(dark)
          v-card-text
            v-icon.dashboard-icon mdi-account
            .overline {{$t('admin:dashboard.users')}}
            animated-number.display-1(
              :value='info.usersTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='4' xl='3' class='d-flex')
        v-card.blue.darken-4.dashboard-card.animated.fadeInUp.wait-p4s(dark)
          v-card-text
            v-icon.dashboard-icon mdi-account-group
            .overline {{$t('admin:dashboard.groups')}}
            animated-number.display-1(
              :value='info.groupsTotal'
              :duration='2000'
              :formatValue='round'
              easing='easeOutQuint'
              )
      v-col(cols='12' md='6' lg='12' xl='3' class='d-flex')
        v-card.dashboard-card.animated.fadeInUp.wait-p6s.indigo(dark)
          v-btn(fab, absolute, :right='!$vuetify.locale.isRtl', :left='$vuetify.locale.isRtl', top, small, light, to='system', v-if='hasPermission(`manage:system`)', aria-label='System information')
            v-icon(color='indigo', small) mdi-information-outline
          v-card-text
            v-icon.dashboard-icon mdi-source-fork
            .subtitle-1 {{ info.product.name }} {{ info.product.version }}
            .body-2 Preview update checks are unavailable
            .caption {{ info.product.upstreamBase }}
      v-col(cols='12', xl='6')
        v-card.radius-7.animated.fadeInUp.wait-p2s
          v-toolbar.dashboard-section-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-2` : `grey-lighten-5`', dense, flat)
            v-spacer
            .overline {{$t('admin:dashboard.recentPages')}}
            v-spacer
          v-list.dashboard-mobile-list(v-if='$vuetify.display.smAndDown', lines='three')
            v-list-item(
              v-for='page in recentPages'
              :key='page.id'
              @click='$router.push(`/pages/` + page.id)'
            )
              v-list-item-title: strong {{ page.title }}
              v-list-item-subtitle
                v-chip.mr-2(label, x-small, :color='$vuetify.theme.current.dark ? `grey darken-4` : `grey lighten-4`') {{ page.locale }}
                span /{{ page.path }}
              .caption.grey--text {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
            v-list-item(v-if='!recentPagesLoading && recentPages.length === 0')
              v-list-item-title.grey--text No recent pages
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
                  .body-2: strong {{ props.item.title }}
                td.admin-pages-path
                  v-chip(label, small, :color='$vuetify.theme.current.dark ? `grey darken-4` : `grey lighten-4`') {{ props.item.locale }}
                  span.ml-2.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-2`') / {{ props.item.path }}
                td.text-right.caption(width='250') {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
      v-col(cols='12', xl='6')
        v-card.radius-7.animated.fadeInUp.wait-p4s
          v-toolbar.dashboard-section-toolbar(:color='$vuetify.theme.current.dark ? `grey-darken-2` : `grey-lighten-5`', dense, flat)
            v-spacer
            .overline {{$t('admin:dashboard.lastLogins')}}
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
              v-list-item-title.grey--text No recent logins
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
                  .body-2: strong {{ props.item.name }}
                td.text-right.caption(width='250') {{ $helpers.formatMoment(props.item.lastLoginAt, 'calendar') }}

      v-col(cols='12')
        v-card.dashboard-contribute.animated.fadeInUp.wait-p4s
          v-card-text
            img(src='/_assets/svg/icon-heart-health.svg', alt='Contribute', style='height: 80px;')
            .pl-5
              .subtitle-1 {{$t('admin:contribute.title')}}
              .body-2.mt-3: strong {{$t('admin:dashboard.contributeSubtitle')}}
              .body-2 {{$t('admin:dashboard.contributeHelp')}}
              v-btn.mx-0.mt-4(:color='$vuetify.theme.current.dark ? `indigo lighten-3` : `indigo`', outlined, small, to='/contribute')
                .caption: strong {{$t('admin:dashboard.contributeLearnMore')}}

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
  border-radius: 7px;

  .v-card__text {
    overflow: hidden;
    position: relative;
  }
}

.dashboard-section-toolbar .overline,
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
  background-color: #FFF;
  background-image: linear-gradient(to bottom, #FFF 0%, lighten(mc('indigo', '50'), 3%) 100%);
  border-radius: 7px;

  @at-root .theme--dark & {
    background-color: mc('grey', '800');
    background-image: linear-gradient(to bottom, mc('grey', '800') 0%, darken(mc('grey', '800'), 6%) 100%);
  }

  .v-card__text {
    display: flex;
    align-items: center;
    color: mc('indigo', '500') !important;

    @at-root .theme--dark & {
      color: mc('grey', '300') !important;
    }
  }
}

.v-icon.dashboard-icon {
  position: absolute !important;
  right: 0;
  top: 12px;
  font-size: 100px !important;
  opacity: .25;

  @at-root .v-application--is-rtl & {
    left: 0;
    right: initial;
  }
}

</style>

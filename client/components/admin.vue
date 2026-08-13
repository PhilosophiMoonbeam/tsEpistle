<template lang='pug'>
  v-app.admin
    nav-header(hide-search)
      template(v-slot:mid)
        v-spacer
        .overline.grey--text {{$t('admin:adminArea')}}
        v-spacer
    v-navigation-drawer.pb-0.admin-sidebar(v-model='adminDrawerShown', app, fixed, clipped, :right='$vuetify.locale.isRtl', permanent, width='300', :class='$vuetify.theme.current.dark ? `grey darken-4` : ``')
      vue-scroll(:ops='scrollStyle')
        v-list.radius-0(dense, nav)
          v-list-item(to='/dashboard', color='primary')
            v-avatar(size='24', tile): v-icon mdi-view-dashboard-variant
            v-list-item-title {{ $t('admin:dashboard.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:navigation`, `write:pages`, `manage:pages`, `delete:pages`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.site') }}
            v-list-item(to='/general', color='primary', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-widgets
              v-list-item-title {{ $t('admin:general.title') }}
            v-list-item(to='/locale', color='primary', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-web
              v-list-item-title {{ $t('admin:locale.title') }}
            v-list-item(to='/navigation', color='primary', v-if='hasPermission([`manage:system`, `manage:navigation`])')
              v-avatar(size='24', tile): v-icon mdi-near-me
              v-list-item-title {{ $t('admin:navigation.title') }}
            v-list-item(to='/pages', color='primary', v-if='hasPermission([`manage:system`, `write:pages`, `manage:pages`, `delete:pages`])')
              v-avatar(size='24', tile): v-icon mdi-file-document-outline
              v-list-item-title {{ $t('admin:pages.title') }}
              div.v-list-item-action(style='min-width:auto;')
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-5`')
                  .caption.grey--text {{ info.pagesTotal }}
            v-list-item(to='/tags', v-if='hasPermission([`manage:system`])')
              v-avatar(size='24', tile): v-icon mdi-tag-multiple
              v-list-item-title {{ $t('admin:tags.title') }}
              div.v-list-item-action(style='min-width:auto;')
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-5`')
                  .caption.grey--text {{ info.tagsTotal }}
            v-list-item(to='/theme', color='primary', v-if='hasPermission([`manage:system`, `manage:theme`])')
              v-avatar(size='24', tile): v-icon mdi-palette-outline
              v-list-item-title {{ $t('admin:theme.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`, `manage:users`, `write:users`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.users') }}
            v-list-item(to='/groups', color='primary', v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`])')
              v-avatar(size='24', tile): v-icon mdi-account-group
              v-list-item-title {{ $t('admin:groups.title') }}
              div.v-list-item-action(style='min-width:auto;')
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-4`')
                  .caption.grey--text {{ info.groupsTotal }}
            v-list-item(to='/users', color='primary', v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`, `manage:users`, `write:users`])')
              v-avatar(size='24', tile): v-icon mdi-account-box
              v-list-item-title {{ $t('admin:users.title') }}
              div.v-list-item-action(style='min-width:auto;')
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-4`')
                  .caption.grey--text {{ info.usersTotal }}
          template(v-if='hasPermission(`manage:system`)')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.modules') }}
            v-list-item(to='/analytics', color='primary')
              v-avatar(size='24', tile): v-icon mdi-chart-timeline-variant
              v-list-item-title {{ $t('admin:analytics.title') }}
            v-list-item(to='/auth', color='primary')
              v-avatar(size='24', tile): v-icon mdi-lock-outline
              v-list-item-title {{ $t('admin:auth.title') }}
            v-list-item(to='/comments')
              v-avatar(size='24', tile): v-icon mdi-comment-text-outline
              v-list-item-title {{ $t('admin:comments.title') }}
            v-list-item(to='/rendering', color='primary')
              v-avatar(size='24', tile): v-icon mdi-cogs
              v-list-item-title {{ $t('admin:rendering.title') }}
            v-list-item(to='/search', color='primary')
              v-avatar(size='24', tile): v-icon mdi-cloud-search-outline
              v-list-item-title {{ $t('admin:search.title') }}
            v-list-item(to='/storage', color='primary')
              v-avatar(size='24', tile): v-icon mdi-harddisk
              v-list-item-title {{ $t('admin:storage.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:api`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.system') }}
            v-list-item(to='/api', v-if='hasPermission([`manage:system`, `manage:api`])')
              v-avatar(size='24', tile): v-icon mdi-call-split
              v-list-item-title {{ $t('admin:api.title') }}
            v-list-item(to='/mail', color='primary', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-email-multiple-outline
              v-list-item-title {{ $t('admin:mail.title') }}
            v-list-item(to='/security', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-lock-check
              v-list-item-title {{ $t('admin:security.title') }}
            v-list-item(to='/ssl', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-cloud-lock-outline
              v-list-item-title {{ $t('admin:ssl.title') }}
            v-list-item(to='/system', color='primary', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-tune
              v-list-item-title {{ $t('admin:system.title') }}
            v-list-item(to='/utilities', color='primary', v-if='hasPermission(`manage:system`)')
              v-avatar(size='24', tile): v-icon mdi-wrench-outline
              v-list-item-title {{ $t('admin:utilities.title') }}
            v-list-group(
              to='/dev'
              no-action
              v-if='hasPermission([`manage:system`, `manage:api`])'
              )
              template(v-slot:activator='{ props }')
                v-list-item(v-bind='props')
                  v-avatar(size='24', tile): v-icon mdi-dev-to
                  v-list-item-title {{ $t('admin:dev.title') }}

              v-list-item(to='/dev-flags', color='primary')
                v-list-item-title {{ $t('admin:dev.flags.title') }}
              v-list-item(href='/graphql', color='primary')
                v-list-item-title GraphQL
              //- v-list-item(to='/dev-graphiql')
              //-   v-list-item-title {{ $t('admin:dev.graphiql.title') }}
              //- v-list-item(to='/dev-voyager')
              //-   v-list-item-title {{ $t('admin:dev.voyager.title') }}
            v-divider.my-2
          v-list-item(to='/contribute', color='primary')
            v-avatar(size='24', tile): v-icon mdi-heart-outline
            v-list-item-title {{ $t('admin:contribute.title') }}

    v-main(:class='$vuetify.theme.current.dark ? "grey darken-5" : "grey lighten-5"')
      transition(name='admin-router')
        router-view

    nav-footer
    notify
    search-results
</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'

import { fetchSystemSummary } from '../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../helpers/root-ui-store'


export default {
  i18nOptions: { namespaces: 'admin' },
  data() {
    return {
      adminDrawerShown: true,
      scrollStyle: {
        vuescroll: {},
        scrollPanel: {
          initialScrollY: 0,
          initialScrollX: 0,
          scrollingX: false,
          easing: 'easeOutQuad',
          speed: 1000,
          verticalNativeBarPos: this.$vuetify.locale.isRtl ? `left` : `right`
        },
        rail: {
          gutterOfEnds: '2px'
        },
        bar: {
          onlyShowBarOnScroll: false,
          background: '#CCC',
          hoverStyle: {
            background: '#999'
          }
        }
      }
    }
  },
  computed: {
    info: {
      get(): typeof wikiStore.admin.info { return wikiStore.admin.info },
      set(value: typeof wikiStore.admin.info) { wikiStore.admin.info = value }
    },
    permissions(): string[] { return wikiStore.user.permissions }
  },
  created() {
    wikiStore.page.mode = 'admin'
    this.loadInfo()
  },
  methods: {
    async loadInfo() {
      loadingStart(wikiStore, 'admin-stats-refresh')
      try {
        this.info = await fetchSystemSummary(window.fetch.bind(window), 'System summary response is invalid')
      } catch (err) {
        showNotification(wikiStore, {
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      loadingStop(wikiStore, 'admin-stats-refresh')
    },
    hasPermission(prm: string | string[]) {
      if (_.isArray(prm)) {
        return _.some(prm, p => {
          return _.includes(this.permissions, p)
        })
      } else {
        return _.includes(this.permissions, prm)
      }
    }
  }
}
</script>

<style lang='scss'>

.admin {
  &.theme--light .application--wrap {
    background-color: lighten(mc('grey', '200'), 2%);
  }
}

.admin-router {
  &-enter-active, &-leave-active {
    transition: opacity .25s ease;
    opacity: 1;
  }
  &-enter-active {
    transition-delay: .25s;
  }
  &-enter, &-leave-to {
    opacity: 0;
  }
}

.admin-sidebar {
  .v-list__tile--active {
    background-color: rgba(mc('theme', 'primary'), .1);

    .v-icon {
      color: mc('theme', 'primary');
    }
  }

  .v-list-group > .v-list-item {
    padding-left: 0;
  }
}

.theme--dark {
  .admin-sidebar .v-list__tile--active {
    background-color: rgba(0,0,0, .2);
    color: mc('blue', '500') !important;

    .v-icon {
      color: mc('blue', '500');
    }
  }
}

.admin-header {
  display: flex;
  justify-content: flex-start;
  align-items: center;

  &-title {
    margin-left: 1rem;
  }
}

.admin-providerlogo {
  width: 250px;
  height: 50px;
  float: right;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-left: 16px;

  img {
    max-width: 100%;
    max-height: 50px;
  }
}

.v-application.admin {
  code {
    box-shadow: none;
    font-family: 'Roboto Mono', monospace;
    color: mc('pink', '500');
  }
}

</style>

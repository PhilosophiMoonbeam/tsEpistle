<template lang='pug'>
  v-app.admin
    nav-header(hide-search)
      template(v-slot:mid)
        v-spacer
        .overline.grey--text {{$t('admin:adminArea')}}
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
      app
      fixed
      clipped
      :right='$vuetify.locale.isRtl'
      :permanent='$vuetify.display.mdAndUp'
      :temporary='$vuetify.display.smAndDown'
      :width='$vuetify.display.smAndDown ? 320 : 300'
      :class='$vuetify.theme.current.dark ? `grey darken-4` : ``'
    )
      .admin-sidebar-mobile-header(v-if='$vuetify.display.smAndDown')
        .subtitle-2 Administration
        v-spacer
        v-btn(
          icon
          @click='adminDrawerShown = false'
          aria-label='Close administration navigation'
        )
          v-icon mdi-close
      vue-scroll(:ops='scrollStyle')
        v-list.radius-0(dense, nav, role='navigation', aria-label='Administration sections')
          v-list-item(to='/dashboard', color='primary', prepend-icon='mdi-view-dashboard-variant')
            v-list-item-title {{ $t('admin:dashboard.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:navigation`, `write:pages`, `manage:pages`, `delete:pages`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.site') }}
            v-list-item(to='/general', color='primary', prepend-icon='mdi-widgets', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:general.title') }}
            v-list-item(to='/locale', color='primary', prepend-icon='mdi-web', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:locale.title') }}
            v-list-item(to='/navigation', color='primary', prepend-icon='mdi-near-me', v-if='hasPermission([`manage:system`, `manage:navigation`])')
              v-list-item-title {{ $t('admin:navigation.title') }}
            v-list-item(to='/pages', color='primary', prepend-icon='mdi-file-document-outline', v-if='hasPermission([`manage:system`, `write:pages`, `manage:pages`, `delete:pages`])')
              v-list-item-title {{ $t('admin:pages.title') }}
              template(v-slot:append)
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-5`')
                  .caption.grey--text {{ info.pagesTotal }}
            v-list-item(to='/tags', prepend-icon='mdi-tag-multiple', v-if='hasPermission([`manage:system`])')
              v-list-item-title {{ $t('admin:tags.title') }}
              template(v-slot:append)
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-5`')
                  .caption.grey--text {{ info.tagsTotal }}
            v-list-item(to='/theme', color='primary', prepend-icon='mdi-palette-outline', v-if='hasPermission([`manage:system`, `manage:theme`])')
              v-list-item-title {{ $t('admin:theme.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`, `manage:users`, `write:users`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.users') }}
            v-list-item(to='/groups', color='primary', prepend-icon='mdi-account-group', v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`])')
              v-list-item-title {{ $t('admin:groups.title') }}
              template(v-slot:append)
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-4`')
                  .caption.grey--text {{ info.groupsTotal }}
            v-list-item(to='/users', color='primary', prepend-icon='mdi-account-box', v-if='hasPermission([`manage:system`, `manage:groups`, `write:groups`, `manage:users`, `write:users`])')
              v-list-item-title {{ $t('admin:users.title') }}
              template(v-slot:append)
                v-chip(x-small, :color='$vuetify.theme.current.dark ? `grey darken-3-d4` : `grey lighten-4`')
                  .caption.grey--text {{ info.usersTotal }}
          template(v-if='hasPermission(`manage:system`)')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.modules') }}
            v-list-item(to='/analytics', color='primary', prepend-icon='mdi-chart-timeline-variant')
              v-list-item-title {{ $t('admin:analytics.title') }}
            v-list-item(to='/auth', color='primary', prepend-icon='mdi-lock-outline')
              v-list-item-title {{ $t('admin:auth.title') }}
            v-list-item(to='/comments', prepend-icon='mdi-comment-text-outline')
              v-list-item-title {{ $t('admin:comments.title') }}
            v-list-item(to='/rendering', color='primary', prepend-icon='mdi-cogs')
              v-list-item-title {{ $t('admin:rendering.title') }}
            v-list-item(to='/logging', color='primary', prepend-icon='mdi-text-box-search-outline')
              v-list-item-title Logging
            v-list-item(to='/search', color='primary', prepend-icon='mdi-cloud-search-outline')
              v-list-item-title {{ $t('admin:search.title') }}
            v-list-item(to='/storage', color='primary', prepend-icon='mdi-harddisk')
              v-list-item-title {{ $t('admin:storage.title') }}
          template(v-if='hasPermission([`manage:system`, `manage:api`])')
            v-divider.my-2
            v-list-subheader.pl-4 {{ $t('admin:nav.system') }}
            v-list-item(to='/api', prepend-icon='mdi-call-split', v-if='hasPermission([`manage:system`, `manage:api`])')
              v-list-item-title {{ $t('admin:api.title') }}
            v-list-item(to='/mail', color='primary', prepend-icon='mdi-email-multiple-outline', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:mail.title') }}
            v-list-item(to='/security', prepend-icon='mdi-lock-check', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:security.title') }}
            v-list-item(to='/ssl', prepend-icon='mdi-cloud-lock-outline', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:ssl.title') }}
            v-list-item(to='/system', color='primary', prepend-icon='mdi-tune', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:system.title') }}
            v-list-item(to='/utilities', color='primary', prepend-icon='mdi-wrench-outline', v-if='hasPermission(`manage:system`)')
              v-list-item-title {{ $t('admin:utilities.title') }}
            v-list-group(
              to='/dev'
              no-action
              v-if='hasPermission([`manage:system`, `manage:api`])'
              )
              template(v-slot:activator='{ props }')
                v-list-item(v-bind='props', prepend-icon='mdi-dev-to', role='button')
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
          v-list-item(to='/contribute', color='primary', prepend-icon='mdi-heart-outline')
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
      adminDrawerShown: this.$vuetify.display.mdAndUp,
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
  watch: {
    '$route.fullPath' () {
      if (this.$vuetify.display.smAndDown) {
        this.adminDrawerShown = false
      }
    },
    '$vuetify.display.mdAndUp' (isDesktop: boolean) {
      this.adminDrawerShown = isDesktop
    }
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

.admin-sidebar-mobile-header {
  display: flex;
  align-items: center;
  min-height: 56px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid rgba(127, 127, 127, .2);
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

@include until($tablet) {
  .admin-sidebar {
    max-width: calc(100vw - 48px);
  }

  .admin {
    .v-main {
      min-width: 0;
    }

    .v-container {
      padding: 12px;
    }
  }

    .admin-filter-bar {
      gap: 8px;
      flex-wrap: wrap;

      > .v-spacer {
        display: none;
      }

      .v-input {
        flex: 1 1 100%;
        max-width: none !important;
        margin-left: 0 !important;
      }
    }

    .admin-responsive-table {
      .v-table__wrapper {
        overflow-x: hidden;
      }
    }

    .admin-mobile-table-row {
      > td {
        height: auto !important;
        padding: 0 !important;
      }
    }

    .admin-mobile-record {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(127, 127, 127, .2);

      &-title {
        overflow: hidden;
        font-size: 1rem;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      &-meta {
        overflow: hidden;
        margin-top: 6px;
        color: rgb(var(--v-theme-on-surface));
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

  .admin-header {
    flex-wrap: wrap;
    gap: 8px;

    > img {
      width: 48px !important;
      height: 48px;
      object-fit: contain;
    }

    &-title {
      flex: 1 1 calc(100% - 64px);
      min-width: 0;
      margin-left: 8px;
    }
  }

  .admin-dialog-actions {
    position: sticky;
    bottom: 0;
    z-index: 2;
    flex-wrap: wrap;
    min-height: 64px;
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

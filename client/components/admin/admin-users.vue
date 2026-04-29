<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-layout(row, wrap)
      v-flex(xs12)
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-customer.svg', alt='Users', style='width: 80px;')
          .admin-header-title
            .headline.blue--text.text--darken-2.animated.fadeInLeft Users
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s Manage users
          v-spacer
          v-btn.animated.fadeInDown.wait-p2s.mr-3(outlined, color='grey', icon, @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='primary', large, depressed, @click='createUser')
            v-icon(left) mdi-plus
            span New User
        v-card.mt-3.animated.fadeInUp
          .pa-2.d-flex.align-center(:class='$vuetify.theme.dark ? `grey darken-3-d5` : `grey lighten-3`')
            v-text-field(
              solo
              flat
              v-model='search'
              prepend-inner-icon='mdi-account-search-outline'
              label='Search Users...'
              hide-details
              style='max-width: 400px;'
              dense
              )
            v-spacer
            v-select(
              solo
              flat
              hide-details
              label='Identity Provider'
              :items='strategyOptions'
              v-model='filterStrategy'
              item-text='displayName'
              item-value='key'
              style='max-width: 300px;'
              dense
            )
          v-divider
          v-data-table(
            v-model='selected'
            :items='users'
            :headers='headers'
            :page.sync='pagination'
            :sort-by.sync='sortBy'
            :sort-desc.sync='sortDesc'
            :items-per-page='15'
            :loading='loading'
            hide-default-footer
            )
            template(slot='item', slot-scope='props')
              tr.is-clickable(:active='props.selected', @click='$router.push("/users/" + props.item.id)')
                //- td
                  v-checkbox(hide-details, :input-value='props.selected', color='blue darken-2', @click='props.selected = !props.selected')
                td {{ props.item.id }}
                td: strong {{ props.item.name }}
                td {{ props.item.email }}
                td {{ getStrategyName(props.item.providerKey) }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                td
                  span(v-if='props.item.lastLoginAt') {{ $helpers.formatMoment(props.item.lastLoginAt, 'from') }}
                  em.grey--text(v-else) Never
                td.text-right
                  v-icon.mr-3(v-if='props.item.isSystem') mdi-lock-outline
                  status-indicator(positive, pulse, v-if='props.item.isActive')
                  status-indicator(negative, pulse, v-else)
            template(slot='no-data')
              .pa-3
                v-alert.text-left(icon='mdi-alert', outlined, color='grey')
                  em.body-2 No users to display!
          v-card-chin(v-if='pageCount > 1')
            v-spacer
            v-pagination(v-model='pagination', :length='pageCount')
            v-spacer

    user-create(v-model='isCreateDialogShown', @refresh='refresh(false)')
</template>

<script>
import _ from 'lodash'
import gql from 'graphql-tag'

import { fetchAdminAuthProviders } from '../../helpers/auth-api'

import { StatusIndicator } from 'vue-status-indicator'
import UserCreate from './admin-users-create.vue'

export default {
  components: {
    StatusIndicator,
    UserCreate
  },
  data() {
    return {
      selected: [],
      pagination: 1,
      pageCount: 0,
      sortBy: 'name',
      sortDesc: false,
      users: [],
      headers: [
        { text: 'ID', value: 'id', width: 80, sortable: true },
        { text: 'Name', value: 'name', sortable: true },
        { text: 'Email', value: 'email', sortable: true },
        { text: 'Provider', value: 'provider', sortable: true },
        { text: 'Created', value: 'createdAt', sortable: true },
        { text: 'Last Login', value: 'lastLoginAt', sortable: true },
        { text: '', value: 'actions', sortable: false, width: 80 }
      ],
      strategies: [],
      filterStrategy: 'all',
      search: '',
      loading: false,
      loadRequestId: 0,
      searchDebounce: null,
      isCreateDialogShown: false
    }
  },
  computed: {
    strategyOptions() {
      return this.strategies.map(strategy => ({
        ...strategy,
        displayName: strategy.key !== 'all' && strategy.isEnabled === false ? `${strategy.displayName} (disabled)` : strategy.displayName
      }))
    }
  },
  watch: {
    search () {
      clearTimeout(this.searchDebounce)
      this.searchDebounce = setTimeout(() => {
        if (this.pagination !== 1) {
          this.pagination = 1
        } else {
          this.loadUsers()
        }
      }, 300)
    },
    filterStrategy () {
      if (this.pagination !== 1) {
        this.pagination = 1
      } else {
        this.loadUsers()
      }
    },
    sortBy () {
      this.loadUsers()
    },
    sortDesc () {
      this.loadUsers()
    },
    pagination () {
      this.loadUsers()
    }
  },
  methods: {
    createUser() {
      this.isCreateDialogShown = true
    },
    async loadStrategies() {
      this.$store.commit('loadingStart', 'admin-users-strategies-refresh')
      try {
        const providers = await fetchAdminAuthProviders(window.fetch.bind(window), 'Admin authentication providers response is invalid')
        this.strategies = _.concat({
          key: 'all',
          displayName: 'All Providers'
        }, providers.map(provider => ({
          key: provider.key,
          displayName: provider.displayName,
          isEnabled: provider.isEnabled
        })))

        if (!this.strategies.some(strategy => strategy.key === this.filterStrategy)) {
          this.filterStrategy = 'all'
        }
        return true
      } catch (err) {
        this.$store.commit('showNotification', {
          style: 'red',
          message: err.message,
          icon: 'alert'
        })
        return false
      } finally {
        this.$store.commit('loadingStop', 'admin-users-strategies-refresh')
      }
    },
    async loadUsers () {
      const requestId = ++this.loadRequestId
      if (!this.loading) {
        this.loading = true
        this.$store.commit('loadingStart', 'admin-users-refresh')
      }

      try {
        const resp = await this.$apollo.query({
          query: gql`
            query ($page: Int, $pageSize: Int, $filter: String, $providerKey: String, $orderBy: String, $orderByDirection: String) {
              users {
                list(page: $page, pageSize: $pageSize, filter: $filter, providerKey: $providerKey, orderBy: $orderBy, orderByDirection: $orderByDirection) {
                  total
                  users {
                    id
                    name
                    email
                    providerKey
                    isSystem
                    isActive
                    createdAt
                    lastLoginAt
                  }
                }
              }
            }
          `,
          fetchPolicy: 'network-only',
          variables: {
            page: this.pagination,
            pageSize: 15,
            filter: this.search,
            providerKey: this.filterStrategy,
            orderBy: this.sortBy,
            orderByDirection: this.sortDesc ? 'desc' : 'asc'
          }
        })

        if (requestId !== this.loadRequestId) {
          return
        }

        const result = _.get(resp, 'data.users.list', { users: [], total: 0 })
        this.users = result.users
        this.pageCount = Math.max(1, Math.ceil(result.total / 15))
      } catch (err) {
        if (requestId === this.loadRequestId) {
          this.users = []
          this.pageCount = 0
          this.$store.commit('showNotification', {
            message: 'Failed to load users list.',
            style: 'error',
            icon: 'alert'
          })
        }
      } finally {
        if (requestId === this.loadRequestId) {
          this.loading = false
          this.$store.commit('loadingStop', 'admin-users-refresh')
        }
      }
    },
    async refresh(notify = true) {
      const strategiesLoaded = await this.loadStrategies()
      await this.loadUsers()
      if (notify && strategiesLoaded) {
        this.$store.commit('showNotification', {
          message: 'Users list has been refreshed.',
          style: 'success',
          icon: 'cached'
        })
      }
    },
    getStrategyName(key) {
      return (_.find(this.strategies, ['key', key]) || {}).displayName || key
    }
  },
  mounted () {
    this.loadStrategies()
    this.loadUsers()
  },
  beforeDestroy () {
    clearTimeout(this.searchDebounce)
  }
}
</script>

<style lang='scss'>

</style>

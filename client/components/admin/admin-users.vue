<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
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
          .pa-2.d-flex.align-center(:class='$vuetify.theme.current.dark ? `grey darken-3-d5` : `grey lighten-3`')
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
              item-title='displayName'
              item-value='key'
              style='max-width: 300px;'
              dense
            )
          v-divider
          v-data-table(
            v-model='selected'
            :items='users'
            :headers='headers'
            v-model:page='pagination'
            v-model:sort-by='sortBy'
            v-model:sort-desc='sortDesc'
            :items-per-page='15'
            :loading='loading'
            hide-default-footer
            )
            template(v-slot:item='props')
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
            template(v-slot:no-data)
              .pa-3
                v-alert.text-left(icon='mdi-alert', outlined, color='grey')
                  em.body-2 No users to display!
          div.v-card-chin(v-if='pageCount > 1')
            v-spacer
            v-pagination(v-model='pagination', :length='pageCount')
            v-spacer

    user-create(v-model='isCreateDialogShown', @refresh='refresh(false)')
</template>

<script lang='ts'>

import { fetchAdminAuthProviders, type AdminAuthProviderSummary } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchAdminUsersList, type AdminUserListRow } from '../../helpers/users-api'

import StatusIndicator from '@/components/common/status-indicator.vue'
import UserCreate from './admin-users-create.vue'
import { wikiStore } from '@/store/index.ts'

type AuthStrategySummary = Pick<AdminAuthProviderSummary, 'key' | 'displayName'> & {
  isEnabled?: boolean
}

type UserTableHeader = {
  text: string
  value: string
  sortable: boolean
  width?: number
}

export default {
  components: {
    StatusIndicator,
    UserCreate
  },
  data() {
    return {
      selected: [] as AdminUserListRow[],
      pagination: 1,
      pageCount: 0,
      sortBy: 'name',
      sortDesc: false,
      users: [] as AdminUserListRow[],
      headers: [
        { text: 'ID', value: 'id', width: 80, sortable: true },
        { text: 'Name', value: 'name', sortable: true },
        { text: 'Email', value: 'email', sortable: true },
        { text: 'Provider', value: 'providerKey', sortable: true },
        { text: 'Created', value: 'createdAt', sortable: true },
        { text: 'Last Login', value: 'lastLoginAt', sortable: true },
        { text: '', value: 'actions', sortable: false, width: 80 }
      ] as UserTableHeader[],
      strategies: [] as AuthStrategySummary[],
      filterStrategy: 'all',
      search: '',
      loading: false,
      loadRequestId: 0,
      searchDebounce: null as ReturnType<typeof setTimeout> | null,
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
      if (this.searchDebounce !== null) {
        clearTimeout(this.searchDebounce)
      }
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
      wikiStore.startLoading('admin-users-strategies-refresh')
      try {
        const providers = await fetchAdminAuthProviders(window.fetch.bind(window), 'Admin authentication providers response is invalid')
        this.strategies = [{
          key: 'all',
          displayName: 'All Providers'
        }, ...providers.map(provider => ({
          key: provider.key,
          displayName: provider.displayName,
          isEnabled: provider.isEnabled
        }))]

        if (!this.strategies.some(strategy => strategy.key === this.filterStrategy)) {
          this.filterStrategy = 'all'
        }
        return true
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        return false
      } finally {
        wikiStore.stopLoading('admin-users-strategies-refresh')
      }
    },
    async loadUsers () {
      const requestId = ++this.loadRequestId
      if (!this.loading) {
        this.loading = true
        wikiStore.startLoading('admin-users-refresh')
      }

      try {
        const result = await fetchAdminUsersList(window.fetch.bind(window), {
          page: this.pagination,
          pageSize: 15,
          filter: this.search,
          providerKey: this.filterStrategy,
          orderBy: this.sortBy,
          orderByDirection: this.sortDesc ? 'desc' : 'asc'
        }, 'Users list response is invalid')

        if (requestId !== this.loadRequestId) {
          return
        }

        this.users = result.users
        this.pageCount = Math.max(1, Math.ceil(result.total / 15))
      } catch (err) {
        if (requestId === this.loadRequestId) {
          this.users = []
          this.pageCount = 0
          wikiStore.showNotification({
            message: 'Failed to load users list.',
            style: 'error',
            icon: 'alert'
          })
        }
      } finally {
        if (requestId === this.loadRequestId) {
          this.loading = false
          wikiStore.stopLoading('admin-users-refresh')
        }
      }
    },
    async refresh(notify = true) {
      const strategiesLoaded = await this.loadStrategies()
      await this.loadUsers()
      if (notify && strategiesLoaded) {
        wikiStore.showNotification({
          message: 'Users list has been refreshed.',
          style: 'success',
          icon: 'cached'
        })
      }
    },
    getStrategyName(key: string) {
      return this.strategies.find(strategy => strategy.key === key)?.displayName || key
    }
  },
  mounted () {
    this.loadStrategies()
    this.loadUsers()
  },
  beforeUnmount () {
    if (this.searchDebounce !== null) {
      clearTimeout(this.searchDebounce)
    }
  }
}
</script>

<style lang='scss'>

</style>

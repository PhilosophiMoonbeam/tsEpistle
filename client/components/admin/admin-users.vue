<template lang='pug'>
  v-container.admin-users(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          title='Users'
          description='Manage users'
          icon='/_assets/svg/icon-customer.svg'
          heading-id='admin-users-heading'
        )
          template(v-slot:actions)
            v-btn(
              icon
              variant="outlined"
              color='grey'
              :loading='loading || strategiesLoading'
              :disabled='loading || strategiesLoading'
              @click='refresh'
              aria-label='Refresh users'
            )
              v-icon mdi-refresh
            v-btn(color='primary' size="large" variant="flat" @click='createUser' :icon='$vuetify.display.smAndDown' aria-label='New user')
              v-icon(:start='$vuetify.display.mdAndUp') mdi-plus
              span(v-if='$vuetify.display.mdAndUp') New User
        v-card.mt-3.animated.fadeInUp
          .admin-filter-bar.pa-2.d-flex.align-center
            v-text-field.admin-users-filter-search(
              variant="solo"
              flat
              v-model='search'
              prepend-inner-icon='mdi-account-search-outline'
              label='Search users'
              hide-details
              density="compact"
            )
            v-spacer
            v-select.admin-users-filter-provider(
              variant="solo"
              flat
              hide-details
              label='Identity Provider'
              :items='strategyOptions'
              v-model='filterStrategy'
              item-title='displayName'
              item-value='key'
              density="compact"
            )
            v-btn.admin-users-filter-clear(v-if='hasActiveFilters' variant='text' size='small' color='primary' @click='clearFilters') Clear filters
          v-alert(v-if='errorMessage && users.length' type='error' variant='tonal' class='ma-3')
            .d-flex.align-center
              span {{ errorMessage }}
              v-spacer
              v-btn(variant='text' color='primary' @click='loadUsers') Try again
          v-divider
          v-data-table-server.admin-responsive-table(
            :items='users'
            :items-length='totalUsers'
            :headers='responsiveHeaders'
            :hide-default-header='$vuetify.display.smAndDown'
            v-model:page='pagination'
            v-model:sort-by='sortBy'
            :items-per-page='15'
            :loading='loading'
            hide-default-footer
          )
            template(v-slot:item='props')
              tr(v-if='$vuetify.display.mdAndUp')
                td {{ props.item.id }}
                td
                  router-link.admin-record-link(:to='`/users/${props.item.id}`') {{ props.item.name }}
                td {{ props.item.email }}
                td {{ getStrategyName(props.item.providerKey) }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'from') }}
                td
                  span(v-if='props.item.lastLoginAt') {{ $helpers.formatMoment(props.item.lastLoginAt, 'from') }}
                  em.text-medium-emphasis(v-else) Never
                td
                  v-icon.me-2(v-if='props.item.isSystem' size='18' aria-label='System user') mdi-lock-outline
                  span.admin-status(v-if='props.item.isActive') Active
                  span.admin-status.admin-status--inactive(v-else) Inactive
              tr.admin-mobile-table-row(v-else)
                td(:colspan='responsiveHeaders.length')
                  .admin-mobile-record
                    .d-flex.align-center
                      router-link.admin-mobile-record-title(:to='`/users/${props.item.id}`') {{ props.item.name }}
                      v-spacer
                      v-icon.me-2(v-if='props.item.isSystem' size="small" aria-label='System user') mdi-lock-outline
                      span.admin-status(v-if='props.item.isActive') Active
                      span.admin-status.admin-status--inactive(v-else) Inactive
                    .admin-users-email.text-body-medium {{ props.item.email }}
                    .admin-mobile-record-meta {{ getStrategyName(props.item.providerKey) }}
                    .text-body-small.text-medium-emphasis.mt-2
                      span(v-if='props.item.lastLoginAt') Last login {{ $helpers.formatMoment(props.item.lastLoginAt, 'from') }}
                      em(v-else) Never logged in
            template(v-slot:no-data)
              async-state(v-if='loading' state='loading' title='Loading users' message='Fetching the latest user list.')
              async-state(v-else-if='errorMessage' state='error' title='Users could not be loaded' :message='errorMessage' retry-label='Try again' @retry='loadUsers')
              async-state(v-else-if='hasActiveFilters' state='empty' title='No users match these filters' message='Clear the filters to see all users.')
              async-state(v-else state='empty' title='No users yet' message='Create a user to grant access.')
          div.v-card-chin(v-if='pageCount > 1')
            v-spacer
            v-pagination(v-model='pagination' :length='pageCount')
            v-spacer
    user-create(v-model='isCreateDialogShown' @refresh='refresh(false)')
</template>

<script lang='ts'>
import { fetchAdminAuthProviders, type AdminAuthProviderSummary } from '../../helpers/auth-api'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchAdminUsersList, type AdminUserListRow } from '../../helpers/users-api'
import UserCreate from './admin-users-create.vue'
import { wikiStore } from '@/store/index.ts'

type AuthStrategySummary = Pick<AdminAuthProviderSummary, 'key' | 'displayName'> & {
  isEnabled?: boolean
}
type UserTableHeader = { title: string, value: string, sortable: boolean, width?: number }
type UserTableSort = { key: string, order: 'asc' | 'desc' }

export default {
  components: { AsyncState, UserCreate },
  data() {
    return {
      pagination: 1,
      pageCount: 0,
      totalUsers: 0,
      sortBy: [{ key: 'name', order: 'asc' }] as UserTableSort[],
      users: [] as AdminUserListRow[],
      headers: [
        { title: 'ID', value: 'id', width: 80, sortable: true },
        { title: 'Name', value: 'name', sortable: true },
        { title: 'Email', value: 'email', sortable: true },
        { title: 'Provider', value: 'providerKey', sortable: true },
        { title: 'Created', value: 'createdAt', sortable: true },
        { title: 'Last Login', value: 'lastLoginAt', sortable: true },
        { title: 'Status', value: 'actions', sortable: false, width: 110 }
      ] as UserTableHeader[],
      strategies: [] as AuthStrategySummary[],
      filterStrategy: 'all',
      search: '',
      loading: false,
      strategiesLoading: false,
      errorMessage: '',
      loadRequestId: 0,
      strategiesRequestId: 0,
      searchDebounce: null as ReturnType<typeof setTimeout> | null,
      isCreateDialogShown: false,
      isDisposed: false,
      isClearingFilters: false
    }
  },
  computed: {
    responsiveHeaders() {
      return this.$vuetify.display.smAndDown ? this.headers.filter(header => header.value === 'name') : this.headers
    },
    strategyOptions() {
      return this.strategies.map(strategy => ({
        ...strategy,
        displayName: strategy.key !== 'all' && strategy.isEnabled === false ? `${strategy.displayName} (disabled)` : strategy.displayName
      }))
    },
    hasActiveFilters() {
      return Boolean(this.search.trim() || this.filterStrategy !== 'all')
    }
  },
  watch: {
    search() {
      if (this.isClearingFilters) return
      if (this.searchDebounce !== null) clearTimeout(this.searchDebounce)
      this.searchDebounce = setTimeout(() => {
        this.searchDebounce = null
        if (this.pagination !== 1) this.pagination = 1
        else this.loadUsers()
      }, 300)
    },
    filterStrategy() {
      if (this.isClearingFilters) return
      if (this.pagination !== 1) this.pagination = 1
      else this.loadUsers()
    },
    sortBy: { handler() { this.loadUsers() }, deep: true },
    pagination() { this.loadUsers() }
  },
  methods: {
    createUser() { this.isCreateDialogShown = true },
    clearFilters() {
      if (this.searchDebounce !== null) {
        clearTimeout(this.searchDebounce)
        this.searchDebounce = null
      }
      this.isClearingFilters = true
      this.search = ''
      this.filterStrategy = 'all'
      this.$nextTick(() => {
        if (this.isDisposed) return
        this.isClearingFilters = false
        if (this.pagination !== 1) this.pagination = 1
        else this.loadUsers()
      })
    },
    async loadStrategies() {
      if (this.isDisposed) return false
      const requestId = ++this.strategiesRequestId
      this.strategiesLoading = true
      wikiStore.startLoading('admin-users-strategies-refresh')
      try {
        const providers = await fetchAdminAuthProviders(window.fetch.bind(window), 'Admin authentication providers response is invalid')
        if (requestId !== this.strategiesRequestId) return false
        this.strategies = [{ key: 'all', displayName: 'All Providers' }, ...providers.map(provider => ({ key: provider.key, displayName: provider.displayName, isEnabled: provider.isEnabled }))]
        if (!this.strategies.some(strategy => strategy.key === this.filterStrategy)) this.filterStrategy = 'all'
        return true
      } catch (err) {
        if (requestId !== this.strategiesRequestId) return false
        wikiStore.showNotification({ style: 'red', message: getErrorMessage(err), icon: 'alert' })
        return false
      } finally {
        wikiStore.stopLoading('admin-users-strategies-refresh')
        if (requestId === this.strategiesRequestId) this.strategiesLoading = false
      }
    },
    async loadUsers() {
      if (this.isDisposed) return false
      const requestId = ++this.loadRequestId
      this.loading = true
      this.errorMessage = ''
      wikiStore.startLoading('admin-users-refresh')
      try {
        const result = await fetchAdminUsersList(window.fetch.bind(window), {
          page: this.pagination,
          pageSize: 15,
          filter: this.search.trim(),
          providerKey: this.filterStrategy,
          orderBy: this.sortBy[0]?.key ?? 'name',
          orderByDirection: this.sortBy[0]?.order ?? 'asc'
        }, 'Users list response is invalid')
        if (requestId !== this.loadRequestId) return false
        this.users = result.users
        this.totalUsers = result.total
        this.pageCount = Math.max(1, Math.ceil(result.total / 15))
        return true
      } catch (err) {
        if (requestId !== this.loadRequestId) return false
        this.errorMessage = getErrorMessage(err)
        this.pageCount = 0
        wikiStore.showNotification({ message: this.errorMessage, style: 'error', icon: 'alert' })
        return false
      } finally {
        wikiStore.stopLoading('admin-users-refresh')
        if (requestId === this.loadRequestId) this.loading = false
      }
    },
    async refresh(notify = true) {
      if (this.isDisposed) return
      const strategiesLoaded = await this.loadStrategies()
      if (this.isDisposed) return
      const usersLoaded = await this.loadUsers()
      if (notify && strategiesLoaded && usersLoaded) wikiStore.showNotification({ message: 'Users list has been refreshed.', style: 'success', icon: 'cached' })
    },
    getStrategyName(key: string) {
      return this.strategies.find(strategy => strategy.key === key)?.displayName || key
    }
  },
  mounted() {
    this.loadStrategies()
    this.loadUsers()
  },
  beforeUnmount() {
    this.isDisposed = true
    this.loadRequestId++
    this.strategiesRequestId++
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce)
  }
}
</script>

<style lang='scss'>
.v-application.admin .admin-main > .v-container.admin-users .admin-filter-bar {
  display: grid !important;
  grid-template-columns: minmax(14rem, 1fr) minmax(12rem, 16rem) auto;
  align-items: center;

  > .v-spacer {
    display: none;
  }

  > .v-input {
    width: 100%;
    min-width: 0;
    max-width: none;
    margin-inline-start: 0 !important;
  }
}

.v-application.admin .admin-main > .v-container.admin-users .admin-users-email {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (min-width: 840px) and (max-width: 959px) {
  .v-application.admin .admin-main > .v-container.admin-users .admin-filter-bar {
    grid-template-columns: minmax(13rem, 2fr) minmax(11rem, 14rem) auto;
  }
}

@media (min-width: 600px) and (max-width: 839px) {
  .v-application.admin .admin-main > .v-container.admin-users .admin-filter-bar {
    grid-template-columns: minmax(0, 1fr) minmax(10rem, 14rem);

    > .admin-users-filter-clear {
      grid-column: 1 / -1;
      justify-self: start;
    }
  }
}

@media (max-width: 599px) {
  .v-application.admin .admin-main > .v-container.admin-users .admin-filter-bar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>


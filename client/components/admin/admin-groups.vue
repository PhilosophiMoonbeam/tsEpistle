<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          title='Groups'
          description='Manage groups and their permissions'
          icon='/_assets/svg/icon-people.svg'
          heading-id='admin-groups-heading'
        )
          template(v-slot:actions)
            v-btn(
              icon
              variant="outlined"
              color='grey'
              href='https://docs.requarks.io/groups'
              target='_blank'
              rel='noopener'
              aria-label='Group documentation — opens in a new tab'
            )
              v-icon mdi-help-circle
            v-btn(
              icon
              color='grey'
              variant="outlined"
              @click='refresh'
              :loading='loading'
              :disabled='loading'
              aria-label='Refresh groups'
            )
              v-icon mdi-refresh
            v-dialog(v-model='newGroupDialog' max-width='500' :fullscreen='$vuetify.display.smAndDown' :persistent='creating' aria-labelledby='new-group-title')
              template(v-slot:activator='{ props }')
                v-btn(color='primary' variant="flat" v-bind='props' size="large" :icon='$vuetify.display.smAndDown' aria-label='New group')
                  v-icon(:start='$vuetify.display.mdAndUp') mdi-plus
                  span(v-if='$vuetify.display.mdAndUp') New Group
              v-card
                .dialog-header.is-short
                  h2#new-group-title New Group
                v-card-text.pt-5
                  v-alert(v-if='createError' type='error' variant='tonal' class='mb-3') {{ createError }}
                  v-text-field(variant="outlined" prepend-icon='mdi-account-group' v-model='newGroupName' label='Group Name' counter='255' maxlength='255' @keydown.enter.prevent='createGroup' @update:model-value='createError = ``' ref='groupNameIpt')
                div.admin-dialog-actions.v-card-chin
                  v-spacer
                  v-btn(variant="text" @click='newGroupDialog = false' :disabled='creating') Cancel
                  v-btn(color='primary' @click='createGroup' :loading='creating' :disabled='creating') Create
        v-card.mt-3.animated.fadeInUp
          .admin-filter-bar.pa-2.d-flex.align-center
            v-text-field(variant="solo" flat v-model='search' prepend-inner-icon='mdi-account-search-outline' label='Search groups' hide-details density="compact" @update:model-value='pagination = 1')
            v-spacer
            v-btn(v-if='hasActiveFilters' variant='text' size='small' color='primary' @click='clearFilters') Clear filters
          v-alert(v-if='errorMessage && groups.length' type='error' variant='tonal' class='ma-3')
            .d-flex.align-center
              span {{ errorMessage }}
              v-spacer
              v-btn(variant='text' color='primary' @click='loadGroups') Try again
          v-divider
          v-data-table.admin-responsive-table(
            :items='groups'
            :headers='responsiveHeaders'
            :hide-default-header='$vuetify.display.smAndDown'
            :search='search'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort
            hide-default-footer
            aria-label='Groups'
          )
            template(v-slot:item='props')
              tr(v-if='$vuetify.display.mdAndUp')
                td {{ props.item.id }}
                td
                  router-link.admin-record-link(:to='`/groups/${props.item.id}`') {{ props.item.name }}
                td {{ props.item.userCount }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
                td
                  span.admin-status.admin-status--system(v-if='props.item.isSystem') System group
                  span.text-medium-emphasis(v-else) Custom group
              tr.admin-mobile-table-row(v-else)
                td(:colspan='responsiveHeaders.length')
                  .admin-mobile-record
                    .d-flex.align-center
                      router-link.admin-mobile-record-title(:to='`/groups/${props.item.id}`') {{ props.item.name }}
                      v-spacer
                      span.admin-status.admin-status--system(v-if='props.item.isSystem') System
                      span.text-medium-emphasis(v-else) Custom
                    .admin-mobile-record-meta {{ props.item.userCount }} users
                    .text-body-small.text-medium-emphasis.mt-2 Updated {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              async-state(v-if='loading' state='loading' title='Loading groups' message='Fetching the latest group list.')
              async-state(v-else-if='errorMessage' state='error' title='Groups could not be loaded' :message='errorMessage' retry-label='Try again' @retry='loadGroups')
              async-state(v-else-if='hasActiveFilters' state='empty' title='No groups match this search' message='Clear the search to see all groups.')
              async-state(v-else state='empty' title='No groups yet' message='Create a group to organize access.')
            template(v-slot:bottom='{ pageCount }')
              nav(v-if='pageCount > 1' aria-label='Groups pagination')
                .text-center.py-2
                  v-pagination(v-model='pagination' :length='pageCount')
</template>

<script lang='ts'>
import { markRaw } from 'vue'
import AsyncState from '@/components/common/async-state.vue'
import { createGroup, fetchGroupsList, type GroupListRow } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  components: { AsyncState },
  data() {
    return {
      newGroupDialog: false,
      newGroupName: '',
      pagination: 1,
      groups: [] as GroupListRow[],
      headers: markRaw([
        { title: 'ID', key: 'id', value: 'id', width: 80, sortable: true },
        { title: 'Name', key: 'name', value: 'name' },
        { title: 'Users', key: 'userCount', value: 'userCount', width: 200 },
        { title: 'Created', key: 'createdAt', value: 'createdAt', width: 250 },
        { title: 'Last Updated', key: 'updatedAt', value: 'updatedAt', width: 250 },
        { title: 'Status', key: 'isSystem', value: 'isSystem', width: 120, sortable: false }
      ]),
      search: '',
      loading: false,
      errorMessage: '',
      creating: false,
      createError: '',
      isDisposed: false
    }
  },
  computed: {
    responsiveHeaders() {
      return this.$vuetify.display.smAndDown ? this.headers.filter(header => (header.key ?? header.value) === 'name') : this.headers
    },
    hasActiveFilters() {
      return Boolean(this.search.trim())
    }
  },
  watch: {
    newGroupDialog(newValue: boolean) {
      if (newValue) {
        this.createError = ''
        this.$nextTick(() => {
          const input = this.$refs.groupNameIpt
          if (typeof input === 'object' && input !== null && 'focus' in input && typeof input.focus === 'function') input.focus()
        })
      }
    }
  },
  methods: {
    clearFilters() {
      this.search = ''
      this.pagination = 1
    },
    async loadGroups() {
      if (this.isDisposed) return false
      this.loading = true
      this.errorMessage = ''
      wikiStore.startLoading('admin-groups-refresh')
      try {
        const groups = await fetchGroupsList(window.fetch.bind(window), 'Groups list response is invalid')
        if (this.isDisposed) return false
        this.groups = markRaw(groups)
        return true
      } catch (err) {
        if (this.isDisposed) return false
        this.errorMessage = getErrorMessage(err)
        wikiStore.showNotification({ style: 'red', message: this.errorMessage, icon: 'alert' })
        return false
      } finally {
        if (!this.isDisposed) this.loading = false
        wikiStore.stopLoading('admin-groups-refresh')
      }
    },
    async refresh() {
      if (await this.loadGroups()) wikiStore.showNotification({ message: 'Groups have been refreshed.', style: 'success', icon: 'cached' })
    },
    async createGroup() {
      if (this.creating || this.isDisposed) return
      if (this.newGroupName.trim().length < 1) {
        this.createError = 'Enter a group name.'
        return
      }
      this.newGroupName = this.newGroupName.trim()
      this.creating = true
      this.createError = ''
      wikiStore.startLoading('admin-groups-create')
      try {
        const data = await createGroup(window.fetch.bind(window), this.newGroupName)
        if (this.isDisposed) return
        if (data.succeeded !== true) throw new Error(data.message || 'An unexpected error occurred.')
        this.newGroupName = ''
        this.newGroupDialog = false
        if (await this.loadGroups()) wikiStore.showNotification({ style: 'success', message: 'Group has been created successfully.', icon: 'check' })
      } catch (err) {
        if (this.isDisposed) return
        this.createError = getErrorMessage(err)
        wikiStore.showError(err)
      } finally {
        if (!this.isDisposed) this.creating = false
        wikiStore.stopLoading('admin-groups-create')
      }
    }
  },
  created() {
    this.loadGroups()
  },
  beforeUnmount() {
    this.isDisposed = true
  }
}
</script>

<style lang='scss'>

</style>

<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-people.svg', alt='Groups', style='width: 80px;')
          .admin-header-title
            .headline.blue--text.text--darken-2.animated.fadeInLeft Groups
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p4s Manage groups and their permissions
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(icon, outlined, color='grey', href='https://docs.requarks.io/groups', target='_blank')
            v-icon mdi-help-circle
          v-btn.animated.fadeInDown.wait-p2s.mx-3(color='grey', outlined, @click='refresh', icon)
            v-icon mdi-refresh
          v-dialog(v-model='newGroupDialog', max-width='500')
            template(v-slot:activator='{ props }')
              v-btn.animated.fadeInDown(color='primary', depressed, v-bind='props', large)
                v-icon(left) mdi-plus
                span New Group
            v-card
              .dialog-header.is-short New Group
              v-card-text.pt-5
                v-text-field.md2(
                  outlined
                  prepend-icon='mdi-account-group'
                  v-model='newGroupName'
                  label='Group Name'
                  counter='255'
                  @keyup.enter='createGroup'
                  @keyup.esc='newGroupDialog = false'
                  ref='groupNameIpt'
                  )
              div.v-card-chin
                v-spacer
                v-btn(text, @click='newGroupDialog = false') Cancel
                v-btn(color='primary', @click='createGroup') Create
        v-card.mt-3.animated.fadeInUp
          v-data-table(
            :items='groups'
            :headers='headers'
            :search='search'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            @page-count='pageCount = $event'
            must-sort,
            hide-default-footer
          )
            template(v-slot:item='props')
              tr.is-clickable(:active='props.selected', @click='$router.push("/groups/" + props.item.id)')
                td {{ props.item.id }}
                td: strong {{ props.item.name }}
                td {{ props.item.userCount }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
                td
                  v-tooltip(left, v-if='props.item.isSystem')
                    template(v-slot:activator='{ props }')
                      v-icon(v-bind='props') mdi-lock-outline
                    span System Group
            template(v-slot:no-data)
              v-alert.ma-3(icon='mdi-alert', :value='true', outline) No groups to display.
          .text-xs-center.py-2(v-if='pageCount > 1')
            v-pagination(v-model='pagination', :length='pageCount')
</template>

<script lang='ts'>
import _ from 'lodash'

import { createGroup, fetchGroupsList, type GroupListRow } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      newGroupDialog: false,
      newGroupName: '',
      pagination: 1,
      pageCount: 0,
      groups: [] as GroupListRow[],
      headers: [
        { title: 'ID', value: 'id', width: 80, sortable: true },
        { title: 'Name', value: 'name' },
        { title: 'Users', value: 'userCount', width: 200 },
        { title: 'Created', value: 'createdAt', width: 250 },
        { title: 'Last Updated', value: 'updatedAt', width: 250 },
        { title: '', value: 'isSystem', width: 20, sortable: false }
      ],
      search: '',
      loading: false
    }
  },
  watch: {
    newGroupDialog(newValue: boolean) {
      if (newValue) {
        this.$nextTick(() => {
          ;(this.$refs.groupNameIpt as { focus: () => void }).focus()
        })
      }
    }
  },
  methods: {
    async loadGroups() {
      this.loading = true
      wikiStore.startLoading('admin-groups-refresh')
      try {
        this.groups = await fetchGroupsList(window.fetch.bind(window), 'Groups list response is invalid')
        return true
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        return false
      } finally {
        this.loading = false
        wikiStore.stopLoading('admin-groups-refresh')
      }
    },
    async refresh() {
      if (await this.loadGroups()) {
        wikiStore.showNotification({
          message: 'Groups have been refreshed.',
          style: 'success',
          icon: 'cached'
        })
      }
    },
    async createGroup() {
      if (_.trim(this.newGroupName).length < 1) {
        wikiStore.showNotification({
          style: 'red',
          message: 'Enter a group name.',
          icon: 'warning'
        })
        return
      }
      this.newGroupDialog = false
      wikiStore.startLoading('admin-groups-create')
      try {
        const data = await createGroup(window.fetch.bind(window), this.newGroupName)
        if (data.succeeded === true) {
          this.newGroupName = ''
          if (await this.loadGroups()) {
            wikiStore.showNotification({
              style: 'success',
              message: 'Group has been created successfully.',
              icon: 'check'
            })
          }
        } else {
          throw new Error(data.message || 'An unexpected error occurred.')
        }
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-groups-create')
      }
    }
  },
  created() {
    this.loadGroups()
  }
}
</script>

<style lang='scss'>

</style>

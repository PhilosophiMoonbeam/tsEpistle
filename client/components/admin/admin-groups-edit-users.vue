<template lang="pug">
  v-card(flat)
    v-card-title.pb-4(:class='$vuetify.theme.current.dark ? `bg-grey-darken-3-d3` : `bg-grey-lighten-5`')
      v-text-field(
        variant="outlined"
        flat
        prepend-inner-icon='mdi-magnify'
        v-model='search'
        label='Search Group Users...'
        hide-details
        density="compact"
        style='max-width: 450px;'
      )
      v-spacer
      v-btn(color='primary', variant="flat", @click='searchUserDialog = true', :disabled='group.id === 2')
        v-icon(start) mdi-clipboard-account
        | Assign User
    v-data-table(
      :items='group.users',
      :headers='headers',
      :search='search'
      v-model:page='pagination'
      :items-per-page='15'
      @page-count='pageCount = $event'
      must-sort,
      hide-default-footer
    )
      template(v-slot:item.actions='{ item }')
        v-menu(location="bottom right", min-width='200')
          template(v-slot:activator='{ props }')
            v-btn(icon, v-bind='props', size="small")
              v-icon.text-grey-darken-1 mdi-dots-horizontal
          v-list(density="compact", nav)
            v-list-item(:to='`/users/` + item.id')
              template(v-slot:append): v-icon(color='primary') mdi-account-outline
              v-list-item-title View User Profile
            template(v-if='item.id !== 2')
              v-list-item(@click='unassignUser(item.id)')
                template(v-slot:append): v-icon(color='orange') mdi-account-remove-outline
                v-list-item-title Unassign
      template(v-slot:no-data)
        v-alert.ma-3(icon='mdi-alert', variant="outlined") No users to display.
    .text-center.py-2(v-if='group.users.length > 15')
      v-pagination(v-model='pagination', :length='pageCount')

    user-search(v-model='searchUserDialog', @select='assignUser')
</template>

<script lang='ts'>
import type { PropType } from 'vue'

import UserSearch from '../common/user-search.vue'

import { assignGroupUser, createEmptyGroupEditorState, unassignGroupUser, type GroupEditorState } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import type { UserSearchRow } from '../../helpers/users-api'

export default {
  emits: ['refresh', 'update:modelValue'],
  props: {
    modelValue: {
      type: Object as PropType<GroupEditorState>,
      default: createEmptyGroupEditorState
    }
  },
  components: {
    UserSearch
  },
  data() {
    return {
      headers: [
        { title: 'ID', value: 'id', width: 70 },
        { title: 'Name', value: 'name' },
        { title: 'Email', value: 'email' },
        { title: 'Actions', value: 'actions', sortable: false, width: 50 }
      ],
      searchUserDialog: false,
      pagination: 1,
      pageCount: 0,
      search: ''
    }
  },
  computed: {
    group: {
      get(): GroupEditorState { return this.modelValue },
      set(val: GroupEditorState) { this.$emit('update:modelValue', val) }
    }
  },
  methods: {
    async assignUser(user: UserSearchRow) {
      wikiStore.startLoading('admin-groups-assign')
      try {
        await assignGroupUser(window.fetch.bind(window), this.group.id, user.id)
        wikiStore.showNotification({
          style: 'success',
          message: `User has been assigned to ${this.group.name}.`,
          icon: 'assignment_ind'
        })
        this.$emit('refresh')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-groups-assign')
      }
    },
    async unassignUser(id: number) {
      wikiStore.startLoading('admin-groups-unassign')
      try {
        await unassignGroupUser(window.fetch.bind(window), this.group.id, id)
        wikiStore.showNotification({
          style: 'success',
          message: `User has been unassigned from ${this.group.name}.`,
          icon: 'assignment_ind'
        })
        this.$emit('refresh')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'warning'
        })
      } finally {
        wikiStore.stopLoading('admin-groups-unassign')
      }
    }
  }
}
</script>

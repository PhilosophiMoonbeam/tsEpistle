<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-social-group.svg', alt='Edit Group', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary Edit Group
            .text-body-large.text-medium-emphasis {{group.name}}
          v-spacer
          v-btn(color='grey', icon, variant="outlined", to='/groups', aria-label='Back to groups')
            v-icon mdi-arrow-left
          v-dialog(v-model='deleteGroupDialog', max-width='500', :fullscreen='$vuetify.display.smAndDown', v-if='!group.isSystem')
            template(v-slot:activator='{ props }')
              v-btn.ml-3(color='red', icon, variant="outlined", v-bind='props', aria-label='Delete group')
                v-icon(color='red') mdi-trash-can-outline
            v-card
              .dialog-header.is-red Delete Group?
              v-card-text.pa-4 Are you sure you want to delete group #[strong {{ group.name }}]? All users will be unassigned from this group.
              v-card-actions
                v-spacer
                v-btn(variant="text", @click='deleteGroupDialog = false') Cancel
                v-btn(color='red', @click='deleteGroup') Delete
          v-btn.ml-3(
            color='success'
            size="large"
            variant="flat"
            @click='updateGroup'
            :icon='$vuetify.display.smAndDown'
            aria-label='Update group'
          )
            v-icon(:start='$vuetify.display.mdAndUp') mdi-check
            span(v-if='$vuetify.display.mdAndUp') Update Group
        v-card.mt-3
          v-tabs.grad-tabs(v-model='tab', :color='$vuetify.theme.current.dark ? `blue` : `primary`', fixed-tabs, show-arrows, stacked)
            v-tab(value='settings')
              span Settings
              v-icon mdi-cog-box
            v-tab(value='permissions')
              span Permissions
              v-icon mdi-lock-pattern
            v-tab(value='rules')
              span Page Rules
              v-icon mdi-file-lock
            v-tab(value='users')
              span Users
              v-icon mdi-account-group

          v-tabs-window(v-model='tab')
            v-tabs-window-item(value='settings', :transition='false', :reverse-transition='false')
              v-card(flat)
                template(v-if='group.id <= 2')
                  v-card-text
                    v-alert.radius-7.mb-0(
                      color="orange-darken-2"
                      :class='$vuetify.theme.current.dark ? "bg-grey-darken-4" : "bg-orange-lighten-5"'
                      variant="outlined"
                      :model-value='true'
                      icon='mdi-lock-outline'
                      ) This is a system group and its settings cannot be modified.
                  v-divider
                v-card-text
                  v-text-field(
                    variant="outlined"
                    v-model='group.name'
                    label='Group Name'
                    hide-details
                    prepend-icon='mdi-account-group'
                    style='max-width: 600px;'
                    :disabled='group.id <= 2'
                  )
                template(v-if='group.id !== 2')
                  v-divider
                  v-card-text
                    v-text-field(
                      variant="outlined"
                      v-model='group.redirectOnLogin'
                      label='Redirect on Login'
                      persistent-hint
                      hint='The path / URL where the user will be redirected upon successful login.'
                      prepend-icon='mdi-arrow-top-left-thick'
                      append-icon='mdi-folder-search'
                      @click:append='selectPage'
                      style='max-width: 850px;'
                      :counter='255'
                    )

            v-tabs-window-item(value='permissions', :transition='false', :reverse-transition='false')
              group-permissions(v-model='group', @refresh='refresh')

            v-tabs-window-item(value='rules', :transition='false', :reverse-transition='false')
              group-rules(v-model='group', @refresh='refresh')

            v-tabs-window-item(value='users', :transition='false', :reverse-transition='false')
              group-users(v-model='group', @refresh='refresh')

          div.v-card-chin
            v-spacer
            .text-body-small.text-grey.pr-2 Group ID #[strong {{group.id}}]

    page-selector(mode='select', v-model='selectPageModal', :open-handler='selectPageHandle', path='home', :locale='currentLang')</template>

<script lang='ts'>
import _ from 'lodash'
import { createEmptyGroupEditorState, deleteGroup, fetchGroupDetails, updateGroup } from '../../helpers/groups-api'
import { wikiStore } from '@/store/index.ts'

import GroupPermissions from './admin-groups-edit-permissions.vue'
import GroupRules from './admin-groups-edit-rules.vue'
import GroupUsers from './admin-groups-edit-users.vue'

type PageSelection = {
  path: string
  locale: string
}

/* global siteConfig */

export default {
  components: {
    GroupPermissions,
    GroupRules,
    GroupUsers
  },
  data() {
    return {
      group: createEmptyGroupEditorState(),
      groupLoadRequestId: 0,
      deleteGroupDialog: false,
      tab: 'settings',
      selectPageModal: false,
      currentLang: siteConfig.lang
    }
  },
  watch: {
    '$route.params.id' () {
      this.group = createEmptyGroupEditorState()
      this.loadGroup()
    }
  },
  methods: {
    async loadGroup () {
      const requestId = ++this.groupLoadRequestId
      const routeGroupId = _.toSafeInteger(this.$route.params.id)

      wikiStore.startLoading('admin-groups-refresh')
      try {
        const group = await fetchGroupDetails(window.fetch.bind(window), routeGroupId, 'Group detail response is invalid')
        if (requestId !== this.groupLoadRequestId || routeGroupId !== _.toSafeInteger(this.$route.params.id)) {
          return false
        }
        this.group = group
        return true
      } catch (err) {
        if (requestId !== this.groupLoadRequestId || routeGroupId !== _.toSafeInteger(this.$route.params.id)) {
          return false
        }
        this.group = createEmptyGroupEditorState()
        wikiStore.showError(err)
        return false
      } finally {
        wikiStore.stopLoading('admin-groups-refresh')
      }
    },
    selectPage () {
      this.selectPageModal = true
    },
    selectPageHandle ({ path, locale }: PageSelection) {
      this.group.redirectOnLogin = `/${locale}/${path}`
    },
    async updateGroup() {
      wikiStore.startLoading('admin-groups-update')
      try {
        await updateGroup(window.fetch.bind(window), this.group.id, {
          name: this.group.name,
          redirectOnLogin: this.group.redirectOnLogin,
          permissions: this.group.permissions,
          pageRules: this.group.pageRules
        })
        wikiStore.showNotification({
          style: 'success',
          message: `Group changes have been saved.`,
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-groups-update')
      }
    },
    async deleteGroup() {
      this.deleteGroupDialog = false
      wikiStore.startLoading('admin-groups-delete')
      try {
        await deleteGroup(window.fetch.bind(window), this.group.id)
        wikiStore.showNotification({
          style: 'success',
          message: `Group ${this.group.name} has been deleted.`,
          icon: 'delete'
        })
        this.$router.replace('/groups')
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-groups-delete')
      }
    },
    async refresh() {
      return this.loadGroup()
    }
  },
  created () {
    this.loadGroup()
  }
}
</script>

<style lang='scss'>

</style>

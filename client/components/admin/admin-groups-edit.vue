<template lang='pug'>
  v-container(fluid)
    v-row(v-if='groupLoadState !== `ready`')
      v-col(cols='12')
        v-alert(v-if='groupLoadState === `loading`', type='info', variant='tonal', role='status') Loading group details...
        v-alert(v-else, type='error', variant='tonal', role='alert')
          span Unable to load this group.
          v-btn.ml-2(variant="text", @click='loadGroup') Retry
        v-skeleton-loader.mt-3(v-if='groupLoadState === `loading`', type='article')
    v-row(v-if='groupReady')
      v-col(cols='12')
        AdminHero(
          title='Edit Group'
          :description='group.name'
          icon='/_assets/svg/icon-social-group.svg'
          heading-id='admin-groups-edit-heading'
        )
          template(v-slot:extra)
            .text-body-small.text-orange Settings, permissions, and page rules are staged until Update Group.
            .text-body-small.text-orange(v-if='group.isSystem') System group — settings are protected
          template(v-slot:actions)
            v-btn(color='grey' icon variant="outlined" to='/groups' aria-label='Back to groups')
              v-icon mdi-arrow-left
            v-dialog(v-model='deleteGroupDialog' max-width='500' :fullscreen='$vuetify.display.smAndDown' v-if='!group.isSystem' :persistent='groupAction === `delete`' aria-labelledby='delete-group-dialog-title')
              template(v-slot:activator='{ props }')
                v-btn(color='red' icon variant="outlined" v-bind='props' aria-label='Delete group' :disabled='!groupReady || groupAction !== ``')
                  v-icon(color='red') mdi-trash-can-outline
              v-card
                .dialog-header.is-red#delete-group-dialog-title Delete Group?
                v-card-text.pa-4 Are you sure you want to delete group #[strong {{ group.name }}]? All users will be unassigned from this group.
                v-card-actions
                  v-spacer
                  v-btn(variant="text" @click='deleteGroupDialog = false' :disabled='groupAction !== ``') Cancel
                  v-btn(color='red' @click='deleteGroup' :disabled='groupAction !== ``' :loading='groupAction === `delete`') Delete
            v-btn(
              color='success'
              size="large"
              variant="flat"
              @click='updateGroup'
              :icon='$vuetify.display.smAndDown'
              :disabled='!groupReady || !groupNameValid || !groupRedirectValid || groupAction !== ``'
              :loading='groupAction === `update`'
              aria-label='Update group'
            )
              v-icon(:start='$vuetify.display.mdAndUp') mdi-check
              span(v-if='$vuetify.display.mdAndUp') Update Group
        v-card.mt-3
          v-tabs.grad-tabs(v-model='tab', color='primary', fixed-tabs, show-arrows, stacked)
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
                      type="warning"
                      variant="tonal"
                      icon='mdi-lock-outline'
                      ) This is a system group and its settings cannot be modified.
                  v-divider
                v-card-text
                  v-text-field(
                    variant="outlined"
                    v-model='group.name'
                    label='Group Name'
                    :rules='[groupNameRule]'
                    :counter='255'
                    maxlength='255'
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
                      maxlength='255'
                      :rules='[groupRedirectRule]'
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
import { createEmptyGroupEditorState, deleteGroup, fetchGroupDetails, updateGroup } from '../../helpers/groups-api'
import { wikiStore } from '@/store/index.ts'

import GroupPermissions from './admin-groups-edit-permissions.vue'
import GroupRules from './admin-groups-edit-rules.vue'
import GroupUsers from './admin-groups-edit-users.vue'

type PageSelection = {
  path: string
  locale: string
}

function toRouteGroupId (value: unknown): number {
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : 0
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
      groupLoadState: 'loading' as 'loading' | 'ready' | 'error',
      groupAction: '',
      deleteGroupDialog: false,
      tab: 'settings',
      selectPageModal: false,
      currentLang: siteConfig.lang
    }
  },
  computed: {
    groupReady(): boolean { return this.groupLoadState === 'ready' && this.group.id > 0 },
    groupNameValid(): boolean {
      return this.group.name.trim().length > 0 && this.group.name.length <= 255
    },
    groupRedirectValid(): boolean { return this.group.redirectOnLogin.length <= 255 }
  },
  watch: {
    '$route.params.id' () {
      this.group = createEmptyGroupEditorState()
      this.groupLoadState = 'loading'
      this.groupAction = ''
      this.loadGroup()
    }
  },
  methods: {
    groupNameRule (value: unknown): true | string {
      if (typeof value !== 'string' || value.trim().length === 0) return 'Group name is required.'
      return value.length <= 255 || 'Group name must be 255 characters or fewer.'
    },
    groupRedirectRule (value: unknown): true | string {
      return typeof value !== 'string' || value.length <= 255 || 'Redirect must be 255 characters or fewer.'
    },
    async loadGroup () {
      const requestId = ++this.groupLoadRequestId
      const routeGroupId = toRouteGroupId(this.$route.params.id)
      this.groupLoadState = 'loading'

      wikiStore.startLoading('admin-groups-refresh')
      try {
        const group = await fetchGroupDetails(window.fetch.bind(window), routeGroupId, 'Group detail response is invalid')
        if (requestId !== this.groupLoadRequestId || routeGroupId !== toRouteGroupId(this.$route.params.id)) return false
        this.group = group
        this.groupLoadState = group.id > 0 ? 'ready' : 'error'
        return this.groupReady
      } catch (err) {
        if (requestId !== this.groupLoadRequestId || routeGroupId !== toRouteGroupId(this.$route.params.id)) return false
        this.group = createEmptyGroupEditorState()
        this.groupLoadState = 'error'
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
      if (!this.groupReady) return
      this.group.redirectOnLogin = `/${locale}/${path}`
    },
    async updateGroup() {
      if (!this.groupReady || this.groupAction !== '') return
      if (!this.groupNameValid) return
      if (!this.groupRedirectValid) return
      const requestId = this.groupLoadRequestId
      const groupId = this.group.id
      this.groupAction = 'update'
      wikiStore.startLoading('admin-groups-update')
      try {
        await updateGroup(window.fetch.bind(window), groupId, {
          name: this.group.name,
          redirectOnLogin: this.group.redirectOnLogin,
          permissions: this.group.permissions,
          pageRules: this.group.pageRules
        })
        if (requestId !== this.groupLoadRequestId || groupId !== this.group.id) return
        wikiStore.showNotification({
          style: 'success',
          message: `Group changes have been saved.`,
          icon: 'check'
        })
      } catch (err) {
        if (requestId === this.groupLoadRequestId && groupId === this.group.id) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('admin-groups-update')
        if (requestId === this.groupLoadRequestId && groupId === this.group.id) {
          this.groupAction = ''
        }
      }
    },
    async deleteGroup() {
      if (!this.groupReady || this.groupAction !== '') return
      const requestId = this.groupLoadRequestId
      const groupId = this.group.id
      const groupName = this.group.name
      this.groupAction = 'delete'
      wikiStore.startLoading('admin-groups-delete')
      try {
        await deleteGroup(window.fetch.bind(window), groupId)
        if (requestId !== this.groupLoadRequestId || groupId !== this.group.id) return
        wikiStore.showNotification({
          style: 'success',
          message: `Group ${groupName} has been deleted.`,
          icon: 'delete'
        })
        this.deleteGroupDialog = false
        this.$router.replace('/groups')
      } catch (err) {
        if (requestId === this.groupLoadRequestId && groupId === this.group.id) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('admin-groups-delete')
        if (requestId === this.groupLoadRequestId && groupId === this.group.id) {
          this.groupAction = ''
        }
      }
    },
    async refresh() {
      return this.loadGroup()
    }
  },
  created () {
    this.loadGroup()
  },
  beforeUnmount () {
    this.groupLoadRequestId++
  }
}
</script>

<style lang='scss'>

</style>

<template lang="pug">
  div
    v-dialog(v-model='isShown', max-width='650', persistent)
      v-card
        .dialog-header.is-short
          v-icon.mr-3(color='white') mdi-plus
          span {{$t('admin:api.newKeyTitle')}}
        v-card-text.pt-5
          v-text-field(
            variant="outlined"
            prepend-icon='mdi-format-title'
            v-model='name'
            :label='$t(`admin:api.newKeyName`)'
            persistent-hint
            ref='keyNameInput'
            :hint='$t(`admin:api.newKeyNameHint`)'
            counter='255'
            )
          v-select.mt-3(
            :items='expirations'
            variant="outlined"
            prepend-icon='mdi-clock'
            v-model='expiration'
            :label='$t(`admin:api.newKeyExpiration`)'
            :hint='$t(`admin:api.newKeyExpirationHint`)'
            persistent-hint
            )
          v-divider.mt-4
          v-list-subheader.pl-2: strong.text-indigo {{$t('admin:api.newKeyPermissionScopes')}}
          v-list.pl-8(nav)
            v-checkbox(
              v-model='fullAccess'
              color='indigo'
              hide-details
              :label='$t(`admin:api.newKeyFullAccess`)'
            )
            v-divider.mt-3
            v-list-subheader.text-body-small.text-indigo {{$t('admin:api.newKeyGroupPermissions')}}
            v-list-item
              v-select(
                :disabled='fullAccess'
                :items='groups'
                item-title='name'
                item-value='id'
                variant="outlined"
                color='indigo'
                v-model='group'
                :label='$t(`admin:api.newKeyGroup`)'
                :hint='$t(`admin:api.newKeyGroupHint`)'
                persistent-hint
                )
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='isShown = false', :disabled='loading') {{$t('common:actions.cancel')}}
          v-btn.px-3(variant="flat", color='primary', @click='generate', :loading='loading')
            v-icon(start) mdi-chevron-right
            span {{$t('common:actions.generate')}}

    v-dialog(
      v-model='isCopyKeyDialogShown'
      max-width='750'
      persistent
      scrim='blue-darken-5'
      style='--v-overlay-opacity: .9'
      )
      v-card
        v-toolbar(density="compact", flat, color='primary') {{$t('admin:api.newKeyTitle')}}
        v-card-text.pt-5
          .text-body-medium.text-center
            i18next(tag='span', path='admin:api.newKeyCopyWarn')
              strong(place='bold') {{$t('admin:api.newKeyCopyWarnBold')}}
          v-textarea.mt-3(
            ref='keyContentsIpt'
            variant="filled"
            no-resize
            readonly
            v-model='key'
            :rows='10'
            hide-details
          )
        div.v-card-chin
          v-spacer
          v-btn.px-3(variant="flat", color='primary', @click='isCopyKeyDialogShown = false') {{$t('common:actions.close')}}</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'

import { createAdminApiKey } from '../../helpers/auth-api'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'

export default {
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    refreshApiKeys: {
      type: Function,
      default: null
    }
  },
  data() {
    return {
      loading: false,
      name: '',
      expiration: '1y',
      fullAccess: true,
      groups: [] as GroupOption[],
      group: null as number | null,
      isCopyKeyDialogShown: false,
      key: ''
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    expirations() {
      return [
        { value: '30d', text: this.$t('admin:api.expiration30d') },
        { value: '90d', text: this.$t('admin:api.expiration90d') },
        { value: '180d', text: this.$t('admin:api.expiration180d') },
        { value: '1y', text: this.$t('admin:api.expiration1y') },
        { value: '3y', text: this.$t('admin:api.expiration3y') }
      ]
    }
  },
  watch: {
    value (newValue, oldValue) {
      if (newValue) {
        setTimeout(() => {
          ;(this.$refs.keyNameInput as { focus: () => void }).focus()
        }, 400)
      }
    }
  },
  methods: {
    async loadGroups() {
      wikiStore.startLoading('admin-api-groups-refresh')
      try {
        this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-api-groups-refresh')
    },
    async generate () {
      try {
        if (_.trim(this.name).length < 2 || this.name.length > 255) {
          throw new Error(this.$t('admin:api.newKeyNameError'))
        } else if (!this.fullAccess && !this.group) {
          throw new Error(this.$t('admin:api.newKeyGroupError'))
        } else if (!this.fullAccess && this.group === 2) {
          throw new Error(this.$t('admin:api.newKeyGuestGroupError'))
        }
      } catch (err) {
        return wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }

      this.loading = true
      wikiStore.startLoading('admin-api-create')

      try {
        const resp = await createAdminApiKey(window.fetch.bind(window), {
          name: this.name,
          expiration: this.expiration,
          fullAccess: (this.fullAccess === true),
          group: this.group
        })
        const refreshed = this.refreshApiKeys ? await (this.refreshApiKeys as (notify: boolean) => Promise<boolean>)(false) : true

        this.name = ''
        this.expiration = '1y'
        this.fullAccess = true
        this.group = null
        this.isShown = false

        this.key = resp.key
        this.isCopyKeyDialogShown = true

        if (refreshed) {
          wikiStore.showNotification({
            style: 'success',
            message: this.$t('admin:api.newKeySuccess'),
            icon: 'check'
          })
        }

        setTimeout(() => {
          ;(this.$refs.keyContentsIpt as { $refs: { input: HTMLInputElement } }).$refs.input.select()
        }, 400)
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-create')
        this.loading = false
      }
    }
  },
  created() {
    this.loadGroups()
  }
}
</script>

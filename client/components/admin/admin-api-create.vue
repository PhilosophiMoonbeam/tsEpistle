<template lang="pug">
  div
    v-dialog(v-model='isShown', max-width='650', persistent, aria-labelledby='api-key-create-title')
      v-card.admin-dialog--scrollable
        .dialog-header.is-short
          v-icon.mr-3(color='white') mdi-plus
          span#api-key-create-title {{$t('admin:api.newKeyTitle')}}
        v-card-text.pt-5.admin-dialog--scrollable__body
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
            item-title='title'
            item-value='value'
            variant="outlined"
            prepend-icon='mdi-clock'
            v-model='expiration'
            :label='$t(`admin:api.newKeyExpiration`)'
            :hint='$t(`admin:api.newKeyExpirationHint`)'
            persistent-hint
            )
          v-divider.mt-4
          v-list-subheader.pl-2: strong.text-indigo {{$t('admin:api.newKeyPermissionScopes')}}
          v-radio-group.pl-4(v-model='scope', :rules='[scopeRule]')
            v-radio(value='full', color='indigo', label='System administrator permissions', aria-describedby='api-key-full-scope-description')
            #api-key-full-scope-description.text-body-small.text-medium-emphasis.ml-10.mb-3 Grants the key unrestricted system-administrator authority.
            v-radio(value='group', color='indigo', label='Use a group’s permissions', aria-describedby='api-key-group-scope-description')
            #api-key-group-scope-description.text-body-small.text-medium-emphasis.ml-10 The key is limited to the selected group’s permissions and page rules.
          v-select.ml-8.mt-2(
            v-if='scope === `group`'
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
        div.v-card-chin.admin-dialog-actions
          v-spacer
          v-btn(variant="text", @click='isShown = false', :disabled='loading') {{$t('common:actions.cancel')}}
          v-btn.px-3(variant="flat", color='primary', @click='generate', :loading='loading')
            v-icon(start) mdi-chevron-right
            span {{$t('common:actions.generate')}}

    v-dialog(
      v-model='isCopyKeyDialogShown'
      max-width='750'
      persistent
      aria-labelledby='api-key-copy-title'
      )
      v-card
        v-toolbar(density="compact", flat, color='primary')
          v-toolbar-title#api-key-copy-title 2. Copy key
        v-card-text.pt-5
          .text-body-medium.text-center
            i18next(tag='span', path='admin:api.newKeyCopyWarn')
              strong(place='bold') {{$t('admin:api.newKeyCopyWarnBold')}}
          v-textarea.mt-3(
            ref='keyContentsIpt'
            variant="outlined"
            no-resize
            readonly
            aria-label='Generated API key'
            :model-value='key'
            :rows='5'
            hide-details
            class='api-key-value'
          )
          .d-flex.align-center.flex-wrap.ga-2.mt-3
            v-btn(variant="outlined", color='primary', @click='copyKey')
              v-icon(start) mdi-content-copy
              span {{ copied ? 'Copied' : 'Copy key' }}
            span.text-body-small.text-medium-emphasis(v-if='copied', role='status', aria-live='polite') Key copied. Store it somewhere safe before continuing.
        div.v-card-chin
          v-spacer
          v-btn.px-3(variant="flat", color='primary', @click='finishCopyKey') I’ve saved this key
</template>

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
      scope: null as 'full' | 'group' | null,
      groups: [] as GroupOption[],
      group: null as number | null,
      isCopyKeyDialogShown: false,
      key: '',
      copied: false
    }
  },
  computed: {
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    expirations() {
      return [
        { value: '30d', title: this.$t('admin:api.expiration30d') },
        { value: '90d', title: this.$t('admin:api.expiration90d') },
        { value: '180d', title: this.$t('admin:api.expiration180d') },
        { value: '1y', title: this.$t('admin:api.expiration1y') },
        { value: '3y', title: this.$t('admin:api.expiration3y') }
      ]
    },
    scopeRule (): (value: string | null) => true | string {
      return (value: string | null) => Boolean(value) || 'Choose a permission scope.'
    }
  },
  watch: {
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          this.$nextTick(() => {
            if (this.modelValue) {
              ;(this.$refs.keyNameInput as { focus?: () => void } | undefined)?.focus?.()
            }
          })
        }
      }
    },
    isCopyKeyDialogShown (newValue: boolean) {
      if (newValue) this.copied = false
    }
  },
  methods: {
    async copyKey () {
      try {
        await navigator.clipboard.writeText(this.key)
        this.copied = true
      } catch {
        const input = this.$refs.keyContentsIpt as { select: () => void } | undefined
        input?.select()
        wikiStore.showNotification({ style: 'red', message: 'Copy failed. Select the key and copy it manually.', icon: 'alert' })
      }
    },
    finishCopyKey () {
      this.isCopyKeyDialogShown = false
      this.copied = false
      this.key = ''
    },
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
      } finally {
        wikiStore.stopLoading('admin-api-groups-refresh')
      }
    },
    async generate () {
      if (this.loading) return
      try {
        if (_.trim(this.name).length < 2 || this.name.length > 255) {
          throw new Error(this.$t('admin:api.newKeyNameError'))
        } else if (!this.scope) {
          throw new Error('Choose a permission scope.')
        } else if (this.scope === 'group' && !this.group) {
          throw new Error(this.$t('admin:api.newKeyGroupError'))
        } else if (this.scope === 'group' && this.group === 2) {
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
          fullAccess: this.scope === 'full',
          group: this.scope === 'group' ? this.group : null
        })
        const refreshed = this.refreshApiKeys ? await (this.refreshApiKeys as (notify: boolean) => Promise<boolean>)(false) : true

        this.name = ''
        this.expiration = '1y'
        this.scope = null
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

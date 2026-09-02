<template lang="pug">
  div
    v-dialog(v-model='isShown', max-width='650', persistent, aria-labelledby='api-key-create-title')
      v-form(ref='createForm', @submit.prevent='generate')
        v-card.admin-dialog--scrollable
          .dialog-header.is-short
            v-icon.mr-3(color='white') mdi-plus
            span#api-key-create-title {{$t('admin:api.newKeyTitle')}}
          v-card-text.pt-5.admin-dialog--scrollable__body
            v-text-field(
              ref='keyNameInput'
              v-model='name'
              variant='outlined'
              prepend-icon='mdi-format-title'
              :label='$t(`admin:api.newKeyName`)'
              :hint='$t(`admin:api.newKeyNameHint`)'
              :rules='nameRules'
              :disabled='loading'
              persistent-hint
              counter='255'
              autocomplete='off'
            )
            v-select.mt-3(
              ref='expirationInput'
              v-model='expiration'
              :items='expirations'
              item-title='title'
              item-value='value'
              variant='outlined'
              prepend-icon='mdi-clock'
              :label='$t(`admin:api.newKeyExpiration`)'
              :hint='$t(`admin:api.newKeyExpirationHint`)'
              :rules='[requiredRule]'
              :disabled='loading'
              persistent-hint
            )
            v-divider.mt-4
            v-list-subheader.pl-2: strong.text-indigo {{$t('admin:api.newKeyPermissionScopes')}}
            v-radio-group.pl-4(
              ref='scopeInput'
              v-model='scope'
              :rules='[scopeRule]'
              :disabled='loading'
            )
              v-radio(value='full', color='indigo', label='System administrator permissions', aria-describedby='api-key-full-scope-description')
              #api-key-full-scope-description.text-body-small.text-medium-emphasis.ml-10.mb-3 Grants the key unrestricted system-administrator authority.
              v-radio(value='group', color='indigo', label='Use a group’s permissions', aria-describedby='api-key-group-scope-description')
              #api-key-group-scope-description.text-body-small.text-medium-emphasis.ml-10 The key is limited to the selected group’s permissions and page rules.
            v-alert.ml-8.mt-2(
              v-if='scope === `group` && groupLoadState === `error`'
              type='error'
              variant='tonal'
              density='compact'
              icon='mdi-alert-circle-outline'
            )
              .text-body-small {{ groupLoadError }}
              v-btn.mt-2(
                type='button'
                size='small'
                variant='outlined'
                prepend-icon='mdi-refresh'
                @click='loadGroups'
              ) Retry groups
            v-select.ml-8.mt-2(
              v-if='scope === `group`'
              ref='groupInput'
              v-model='group'
              :items='groups'
              item-title='name'
              item-value='id'
              variant='outlined'
              color='indigo'
              :label='$t(`admin:api.newKeyGroup`)'
              :hint='$t(`admin:api.newKeyGroupHint`)'
              :rules='groupRules'
              :loading='groupLoadState === `loading`'
              :disabled='loading || groupLoadState !== `success`'
              persistent-hint
            )
          div.v-card-chin.admin-dialog-actions
            v-spacer
            v-btn(type='button', variant='text', @click='isShown = false', :disabled='loading') {{$t('common:actions.cancel')}}
            v-btn.px-3(
              type='submit'
              variant='flat'
              color='primary'
              :loading='loading'
              :disabled='loading || (scope === `group` && groupLoadState !== `success`)'
            )
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
      groupLoadState: 'idle' as 'idle' | 'loading' | 'success' | 'error',
      groupLoadError: '',
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
    requiredRule (): (value: unknown) => true | string {
      return (value: unknown) => Boolean(value) || 'This field is required.'
    },
    nameRules (): Array<(value: string) => true | string> {
      return [
        (value: string) => {
          const length = value?.trim().length ?? 0
          return (length >= 2 && length <= 255) || String(this.$t('admin:api.newKeyNameError'))
        }
      ]
    },
    scopeRule (): (value: string | null) => true | string {
      return (value: string | null) => Boolean(value) || 'Choose a permission scope.'
    },
    groupRules (): Array<(value: number | null) => true | string> {
      return [
        (value: number | null) => {
          if (this.scope !== 'group') return true
          if (value === null) return String(this.$t('admin:api.newKeyGroupError'))
          return value !== 2 || String(this.$t('admin:api.newKeyGuestGroupError'))
        }
      ]
    }
  },
  watch: {
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          if (this.scope === 'group') void this.loadGroups()
          this.$nextTick(() => {
            if (this.modelValue) this.focusFormControl('keyNameInput')
          })
        } else {
          const form = this.$refs.createForm as { resetValidation?: () => void } | undefined
          form?.resetValidation?.()
        }
      }
    },
    scope (newValue: 'full' | 'group' | null) {
      if (newValue === 'group' && this.modelValue) void this.loadGroups()
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
        const input = this.$refs.keyContentsIpt as { select?: () => void } | undefined
        input?.select?.()
        wikiStore.showNotification({ style: 'red', message: 'Copy failed. Select the key and copy it manually.', icon: 'alert' })
      }
    },
    finishCopyKey () {
      this.isCopyKeyDialogShown = false
      this.copied = false
      this.key = ''
    },
    focusFormControl (refName: string) {
      const control = this.$refs[refName] as {
        focus?: () => void
        $el?: HTMLElement
      } | undefined
      if (control?.focus) {
        control.focus()
        return
      }
      control?.$el?.querySelector<HTMLElement>('input:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
    },
    async loadGroups() {
      if (!this.modelValue || this.scope !== 'group' || this.groupLoadState === 'loading' || this.groupLoadState === 'success') return
      this.groupLoadState = 'loading'
      this.groupLoadError = ''
      wikiStore.startLoading('admin-api-groups-refresh')
      try {
        this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
        this.groupLoadState = 'success'
      } catch (err) {
        this.groups = []
        this.groupLoadState = 'error'
        this.groupLoadError = getErrorMessage(err)
      } finally {
        wikiStore.stopLoading('admin-api-groups-refresh')
      }
    },
    async generate () {
      if (this.loading) return
      const form = this.$refs.createForm as {
        validate?: () => Promise<{ valid: boolean }>
      } | undefined
      const validation = await form?.validate?.()
      if (!validation?.valid) {
        const normalizedName = this.name.trim()
        let firstInvalid = 'keyNameInput'
        if (normalizedName.length >= 2 && normalizedName.length <= 255) {
          if (!this.expiration) firstInvalid = 'expirationInput'
          else if (!this.scope) firstInvalid = 'scopeInput'
          else if (this.scope === 'group' && (this.group === null || this.group === 2)) firstInvalid = 'groupInput'
        }
        this.$nextTick(() => this.focusFormControl(firstInvalid))
        return
      }
      this.name = this.name.trim()

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
}
</script>

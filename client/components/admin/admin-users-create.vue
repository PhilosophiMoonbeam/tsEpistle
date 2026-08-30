<template lang="pug">
  v-dialog(v-model='isShown', max-width='650', persistent, :fullscreen='$vuetify.display.smAndDown')
    v-card
      .dialog-header.is-short
        v-icon.mr-3 mdi-plus
        span New User
        v-spacer
        v-btn.mx-0(v-if='$vuetify.display.mdAndUp', variant="outlined", disabled, aria-label='Bulk import unavailable')
          v-icon(start) mdi-database-import
          span Bulk Import unavailable
      v-card-text.pt-5
        v-alert.mb-4(v-if='providerLoadError', type='error', variant='tonal', density='compact')
          span {{providerLoadError}}
          template(v-slot:append)
            v-btn(variant="text", size="small", @click='loadProviders', :loading='providerLoading') Retry
        v-alert.mb-4(v-else-if='!providersLoaded', type='info', variant='tonal', density='compact') Loading authentication providers...
        v-select(
          :items='availableProviders'
          item-title='displayName'
          item-value='key'
          variant="outlined"
          prepend-icon='mdi-domain'
          v-model='provider'
          label='Provider *'
          :disabled='!providersLoaded || submitting'
          )
        v-text-field(
          variant="outlined"
          prepend-icon='mdi-at'
          v-model='email'
          label='Email Address *'
          key='newUserEmail'
          persistent-hint
          ref='emailInput'
          :disabled='!providersLoaded || submitting'
          )
        v-text-field(
          v-if='provider === `local`'
          variant="outlined"
          prepend-icon='mdi-lock-outline'
          v-model='password'
          :label='mustChangePwd ? `Temporary Password *` : `Password *`'
          counter='255'
          key='newUserPassword'
          persistent-hint
          :disabled='!providersLoaded || submitting'
          )
          template(v-slot:append-inner)
            v-tooltip(location="top")
              template(v-slot:activator='{ props }')
                v-btn(icon, variant="text", size="small", v-bind='props', aria-label='Generate password', @click='generatePwd')
                  v-icon mdi-dice-5
              span Generate password
        v-text-field(
          variant="outlined"
          prepend-icon='mdi-account-outline'
          v-model='name'
          label='Name *'
          :hint='provider === `local` ? `Can be changed by the user.` : `May be overwritten by the provider during login.`'
          key='newUserName'
          persistent-hint
          :disabled='!providersLoaded || submitting'
          )
        v-select.mt-2(
          :items='groups'
          item-title='name'
          item-value='id'
          :item-props='group => ({ disabled: group.isSystem })'
          variant="outlined"
          prepend-icon='mdi-account-group'
          v-model='group'
          label='Assign to Group(s)...'
          hint='Note that you cannot assign users to the Administrators or Guests groups from this dialog.'
          persistent-hint
          clearable
          multiple
          :disabled='!providersLoaded || submitting'
          )
        v-divider
        v-checkbox(
          color='primary'
          label='Require password change on first login'
          v-if='provider === `local`'
          v-model='mustChangePwd'
          hide-details
          :disabled='submitting'
        )
        v-checkbox(
          color='primary'
          label='Send a welcome email'
          hide-details
          v-model='sendWelcomeEmail'
          :disabled='submitting'
        )
      div.v-card-chin.admin-dialog-actions
        v-spacer
        v-btn(variant="text", @click='isShown = false', :disabled='submitting') Cancel
        v-btn.px-3(
          variant="flat"
          color='primary'
          @click='newUser(true)'
          :disabled='!providersLoaded || availableProviders.length < 1 || submitting'
          :loading='submitting'
          )
          v-icon(start) mdi-check
          span Create
        v-btn.px-3(
          variant="outlined"
          color='primary'
          @click='newUser(false)'
          :disabled='!providersLoaded || availableProviders.length < 1 || submitting'
          :loading='submitting'
          )
          v-icon(start) mdi-plus
          span Create another
</template>

<script lang='ts'>
import _ from 'lodash'
import validateValues from '../../../shared/validation'

import { fetchAdminAuthProviders, type AdminAuthProviderSummary } from '../../helpers/auth-api'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { createAdminUser } from '../../helpers/users-api'
import { wikiStore } from '@/store/index.ts'

type AuthProviderSummary = Pick<AdminAuthProviderSummary, 'key' | 'displayName' | 'isEnabled'>

type FocusableRef = {
  focus: () => void
}

type UserFieldConstraint = {
  presence: {
    allowEmpty: boolean
  }
  email?: boolean
  length?: {
    minimum: number
    maximum: number
  }
}

type UserValidationSchema = {
  email: UserFieldConstraint
  name: UserFieldConstraint
  password?: UserFieldConstraint
}

export default {
  emits: ['refresh', 'update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      providers: [] as AuthProviderSummary[],
      provider: 'local',
      email: '',
      password: '',
      name: '',
      groups: [] as GroupOption[],
      group: [] as number[],
      mustChangePwd: false,
      sendWelcomeEmail: false,
      providersLoaded: false,
      providerLoading: false,
      providerLoadError: '',
      submitting: false
    }
  },
  computed: {
    availableProviders() {
      return this.providers.filter(provider => provider.isEnabled === true)
    },
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  watch: {
    modelValue(newValue: boolean) {
      if (newValue) {
        if (!this.providersLoaded) {
          this.loadProviders()
        }
        this.$nextTick(() => {
          ;(this.$refs.emailInput as FocusableRef).focus()
        })
      }
    }
  },
  methods: {
    async loadProviders() {
      this.providerLoading = true
      this.providerLoadError = ''
      wikiStore.startLoading('admin-users-strategies-refresh')
      try {
        this.providers = (await fetchAdminAuthProviders(window.fetch.bind(window), 'Admin authentication providers response is invalid')).map(strategy => ({
          key: strategy.key,
          displayName: strategy.displayName,
          isEnabled: strategy.isEnabled
        }))

        if (!this.availableProviders.some(strategy => strategy.key === this.provider) && this.availableProviders.length > 0) {
          this.provider = this.availableProviders[0].key
        }
        this.providersLoaded = true
      } catch (err) {
        this.providersLoaded = false
        this.providerLoadError = getErrorMessage(err)
        wikiStore.showNotification({
          style: 'red',
          message: this.providerLoadError,
          icon: 'alert'
        })
      } finally {
        this.providerLoading = false
        wikiStore.stopLoading('admin-users-strategies-refresh')
      }
    },
    async loadGroups() {
      wikiStore.startLoading('admin-auth-groups-refresh')
      try {
        this.groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      wikiStore.stopLoading('admin-auth-groups-refresh')
    },
    async newUser(close = false) {
      if (this.submitting) return
      if (!this.providersLoaded || this.availableProviders.length < 1) {
        wikiStore.showNotification({
          style: 'red',
          message: 'Authentication providers are not available.',
          icon: 'alert'
        })
        return
      }

      const rules: UserValidationSchema = {
        email: {
          presence: {
            allowEmpty: false
          },
          email: true
        },
        name: {
          presence: {
            allowEmpty: false
          },
          length: {
            minimum: 2,
            maximum: 255
          }
        }
      }
      if (this.provider === `local`) {
        rules.password = {
          presence: {
            allowEmpty: false
          },
          length: {
            minimum: 6,
            maximum: 255
          }
        }
      }
      const validationResults = validateValues({
        email: this.email,
        password: this.password,
        name: this.name
      }, rules, { format: 'flat' }) as string[] | undefined

      if (validationResults) {
        wikiStore.showNotification({
          style: 'red',
          message: validationResults[0],
          icon: 'alert'
        })
        return
      }

      this.submitting = true
      wikiStore.startLoading('admin-users-create')
      try {
        const resp = await createAdminUser(window.fetch.bind(window), {
          providerKey: this.provider,
          email: this.email,
          passwordRaw: this.password,
          name: this.name,
          groups: this.group,
          mustChangePassword: this.mustChangePwd,
          sendWelcomeEmail: this.sendWelcomeEmail
        }, 'User create response is invalid')

        if (!resp.succeeded) {
          wikiStore.showNotification({
            style: 'red',
            message: resp.message || 'An unexpected error occurred.',
            icon: 'alert'
          })
          return
        }

        wikiStore.showNotification({
          style: 'success',
          message: 'New user created successfully.',
          icon: 'check'
        })
        if (resp.welcomeEmailError) {
          wikiStore.showNotification({
            style: 'warning',
            message: `The user was created, but the welcome email could not be sent: ${resp.welcomeEmailError}`,
            icon: 'email-alert'
          })
        }
        this.$emit('refresh')
        this.email = ''
        this.password = ''
        this.name = ''
        this.group = []
        this.mustChangePwd = false
        this.sendWelcomeEmail = false

        if (close) {
          this.isShown = false
        } else {
          ;(this.$refs.emailInput as FocusableRef).focus()
        }
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        this.submitting = false
        wikiStore.stopLoading('admin-users-create')
      }
    },
    generatePwd() {
      const pwdChars = 'abcdefghkmnpqrstuvwxyzABCDEFHJKLMNPQRSTUVWXYZ23456789_*=?#!()+'
      this.password = _.sampleSize(pwdChars, 12).join('')
    }
  },
  created() {
    this.loadProviders()
    this.loadGroups()
  }
}
</script>

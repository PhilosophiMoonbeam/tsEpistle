<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='650'
    :persistent='submitting'
    :fullscreen='$vuetify.display.smAndDown'
    aria-labelledby='admin-user-create-title'
    @after-enter='focusEmail'
  )
    v-card.admin-dialog--scrollable(tag='form', @submit.prevent='submitUser')
      .dialog-header.is-short
        v-icon.mr-3 mdi-plus
        span#admin-user-create-title New User
        v-spacer
        v-btn.mx-0(v-if='$vuetify.display.mdAndUp', variant="outlined", disabled, aria-label='Bulk import unavailable')
          v-icon(start) mdi-database-import
          span Bulk Import unavailable
      v-card-text.pt-5.admin-dialog--scrollable__body
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
          required
          :disabled='!providersLoaded || submitting'
          )
        v-text-field(
          variant="outlined"
          prepend-icon='mdi-at'
          v-model='email'
          :rules='emailRules'
          type='email'
          required
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
          ref='passwordInput'
          type='password'
          :rules='passwordRules'
          minlength='6'
          maxlength='255'
          autocomplete='new-password'
          required
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
          ref='nameInput'
          :rules='nameRules'
          minlength='2'
          maxlength='255'
          required
          label='Name *'
          :hint='provider === `local` ? `Can be changed by the user.` : `May be overwritten by the provider during login.`'
          key='newUserName'
          persistent-hint
          :disabled='!providersLoaded || submitting'
          )
        v-alert.mb-3(v-if='groupsLoadError', type='warning', variant='tonal', density='compact')
          span {{groupsLoadError}}
          template(v-slot:append)
            v-btn(type='button', variant='text', size='small', @click='loadGroups', :loading='groupsLoading', :disabled='submitting') Retry
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
          :loading='groupsLoading'
          :disabled='!providersLoaded || submitting || groupsLoading'
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
      v-card-chin.admin-dialog-actions
        v-spacer
        v-btn(type='button', variant="text", @click='isShown = false', :disabled='submitting') Cancel
        v-btn.px-3(
          type='submit'
          value='close'
          variant="flat"
          color='primary'
          prepend-icon='mdi-check'
          :disabled='!providersLoaded || availableProviders.length < 1 || submitting'
          :loading='submitting'
          ) Create
        v-btn.px-3(
          type='submit'
          value='another'
          variant="outlined"
          color='primary'
          :disabled='!providersLoaded || availableProviders.length < 1 || submitting'
          :loading='submitting'
          )
          v-icon(start) mdi-plus
          span Create another
</template>

<script lang='ts'>
import validateValues from '../../../shared/validation'

import { fetchAdminAuthProviders, type AdminAuthProviderSummary } from '../../helpers/auth-api'
import { fetchGroupOptions, type GroupOption } from '../../helpers/groups-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { createAdminUser } from '../../helpers/users-api'
import { wikiStore } from '@/store/index.ts'

type AuthProviderSummary = Pick<AdminAuthProviderSummary, 'key' | 'displayName' | 'isEnabled'>

type FocusableRef = {
  focus: () => void
  resetValidation?: () => void
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

const EMAIL_CONSTRAINT: UserFieldConstraint = {
  presence: { allowEmpty: false },
  email: true
}

const NAME_CONSTRAINT: UserFieldConstraint = {
  presence: { allowEmpty: false },
  length: { minimum: 2, maximum: 255 }
}

const PASSWORD_CONSTRAINT: UserFieldConstraint = {
  presence: { allowEmpty: false },
  length: { minimum: 6, maximum: 255 }
}

const validateField = (field: string, value: string, constraint: UserFieldConstraint): true | string => {
  const results = validateValues({ [field]: value }, { [field]: constraint }, { format: 'flat' })
  return results?.[0] ?? true
}

const PASSWORD_CHARS = 'abcdefghkmnpqrstuvwxyzABCDEFHJKLMNPQRSTUVWXYZ23456789_*=?#!()+'
const PASSWORD_LENGTH = 12
const MAX_UNBIASED_BYTE = Math.floor(256 / PASSWORD_CHARS.length) * PASSWORD_CHARS.length

const generatePassword = (): string => {
  const randomBytes = new Uint8Array(PASSWORD_LENGTH)
  let password = ''
  while (password.length < PASSWORD_LENGTH) {
    window.crypto.getRandomValues(randomBytes)
    for (const byte of randomBytes) {
      if (byte >= MAX_UNBIASED_BYTE) continue
      password += PASSWORD_CHARS[byte % PASSWORD_CHARS.length]
      if (password.length === PASSWORD_LENGTH) break
    }
  }
  return password
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
      providerLoadRequestId: 0,
      groupsLoadRequestId: 0,
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
      groupsLoading: false,
      groupsLoadError: '',
      submitting: false,
      isUnmounted: false
    }
  },
  computed: {
    availableProviders() {
      return this.providers.filter(provider => provider.isEnabled === true)
    },
    emailRules() {
      return [(value: string) => validateField('email', value, EMAIL_CONSTRAINT)]
    },
    passwordRules() {
      return [(value: string) => validateField('password', value, PASSWORD_CONSTRAINT)]
    },
    nameRules() {
      return [(value: string) => validateField('name', value, NAME_CONSTRAINT)]
    },
    isShown: {
      get() { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    }
  },
  watch: {
    modelValue: {
      immediate: true,
      handler (newValue: boolean) {
        if (newValue) {
          if (!this.providersLoaded) {
            this.loadProviders()
          }
        } else {
          this.resetValidation()
        }
      }
    }
  },
  methods: {
    focusEmail() {
      ;(this.$refs.emailInput as FocusableRef | undefined)?.focus()
    },
    resetValidation() {
      for (const refName of ['emailInput', 'passwordInput', 'nameInput']) {
        ;(this.$refs[refName] as FocusableRef | undefined)?.resetValidation?.()
      }
    },
    focusFirstInvalidField() {
      let refName = 'emailInput'
      if (validateField('email', this.email, EMAIL_CONSTRAINT) === true) {
        refName = this.provider === 'local' && validateField('password', this.password, PASSWORD_CONSTRAINT) !== true
          ? 'passwordInput'
          : 'nameInput'
      }
      this.$nextTick(() => {
        ;(this.$refs[refName] as FocusableRef | undefined)?.focus()
      })
    },
    async loadProviders() {
      if (this.providerLoading) return
      const requestId = ++this.providerLoadRequestId
      this.providerLoading = true
      this.providerLoadError = ''
      wikiStore.startLoading('admin-users-strategies-refresh')
      try {
        const providers = (await fetchAdminAuthProviders(window.fetch.bind(window), 'Admin authentication providers response is invalid')).map(strategy => ({
          key: strategy.key,
          displayName: strategy.displayName,
          isEnabled: strategy.isEnabled
        }))
        if (requestId !== this.providerLoadRequestId) return
        this.providers = providers

        if (!this.availableProviders.some(strategy => strategy.key === this.provider) && this.availableProviders.length > 0) {
          this.provider = this.availableProviders[0].key
        }
        this.providersLoaded = true
        if (this.modelValue) {
          this.$nextTick(() => {
            if (this.modelValue) this.focusEmail()
          })
        }
      } catch (err) {
        if (requestId !== this.providerLoadRequestId) return
        this.providersLoaded = false
        this.providerLoadError = getErrorMessage(err)
        wikiStore.showNotification({
          style: 'red',
          message: this.providerLoadError,
          icon: 'alert'
        })
      } finally {
        if (requestId === this.providerLoadRequestId && !this.isUnmounted) {
          this.providerLoading = false
        }
        wikiStore.stopLoading('admin-users-strategies-refresh')
      }
    },
    async loadGroups() {
      if (this.groupsLoading) return
      const requestId = ++this.groupsLoadRequestId
      this.groupsLoading = true
      this.groupsLoadError = ''
      wikiStore.startLoading('admin-auth-groups-refresh')
      try {
        const groups = await fetchGroupOptions(window.fetch.bind(window), 'Groups response is invalid')
        if (requestId !== this.groupsLoadRequestId) return
        this.groups = groups
      } catch (err) {
        if (requestId !== this.groupsLoadRequestId) return
        this.groupsLoadError = getErrorMessage(err)
        wikiStore.showNotification({
          style: 'red',
          message: this.groupsLoadError,
          icon: 'alert'
        })
      } finally {
        if (requestId === this.groupsLoadRequestId && !this.isUnmounted) {
          this.groupsLoading = false
        }
        wikiStore.stopLoading('admin-auth-groups-refresh')
      }
    },
    submitUser(event: SubmitEvent) {
      const submitter = event.submitter
      void this.newUser(!(submitter instanceof HTMLButtonElement) || submitter.value !== 'another')
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

      this.email = this.email.trim()
      this.name = this.name.trim()
      const rules: UserValidationSchema = {
        email: EMAIL_CONSTRAINT,
        name: NAME_CONSTRAINT
      }
      if (this.provider === 'local') {
        rules.password = PASSWORD_CONSTRAINT
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
        this.focusFirstInvalidField()
        return
      }

      this.submitting = true
      wikiStore.startLoading('admin-users-create')
      try {
        const resp = await createAdminUser(window.fetch.bind(window), {
          providerKey: this.provider,
          email: this.email,
          passwordRaw: this.provider === 'local' ? this.password : '',
          name: this.name,
          groups: this.group,
          mustChangePassword: this.provider === 'local' && this.mustChangePwd,
          sendWelcomeEmail: this.sendWelcomeEmail
        }, 'User create response is invalid')
        if (this.isUnmounted) return

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
        }
        this.$nextTick(() => {
          this.resetValidation()
          if (!close && this.modelValue) this.focusEmail()
        })
      } catch (err) {
        if (!this.isUnmounted) {
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
      } finally {
        if (!this.isUnmounted) this.submitting = false
        wikiStore.stopLoading('admin-users-create')
      }
    },
    generatePwd() {
      this.password = generatePassword()
    }
  },
  created() {
    this.loadProviders()
    this.loadGroups()
  },
  beforeUnmount() {
    this.isUnmounted = true
    this.providerLoadRequestId++
    this.groupsLoadRequestId++
  }
}
</script>

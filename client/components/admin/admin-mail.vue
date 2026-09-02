<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:mail.title`)'
          :description='$t(`admin:mail.subtitle`)'
          icon='/_assets/svg/icon-new-post.svg'
          heading-id='admin-mail-heading'
        )
          template(v-slot:status)
            .d-flex.align-center
              v-chip(v-if='loadState === `loading`', label, size='small', color='info')
                v-icon(start, size='small') mdi-loading
                span Loading
              v-chip(v-else-if='loadState === `error`', label, size='small', color='error')
                v-icon(start, size='small') mdi-alert
                span Load failed
              v-chip(v-else-if='isDirty', label, size='small', color='warning')
                v-icon(start, size='small') mdi-content-save-alert
                span Unsaved changes
              v-chip(v-else-if='testState === `passed`', label, size='small', color='success')
                v-icon(start, size='small') mdi-email-check
                span Test passed
              v-chip(v-else-if='testState === `failed`', label, size='small', color='error')
                v-icon(start, size='small') mdi-email-alert
                span Test failed
              v-chip(v-else-if='isConfigured', label, size='small', color='success')
                v-icon(start, size='small') mdi-check-circle
                span Saved
              v-chip(v-else-if='hasLoaded', label, size='small', color='warning')
                v-icon(start, size='small') mdi-alert-circle-outline
                span Not configured
          template(v-slot:actions)
            v-btn(
              v-if='hasLoaded'
              color='success'
              variant='flat'
              size='large'
              @click='save'
              :loading='saveLoading'
              :disabled='!isDirty || !isConfigValid || loadState !== `success` || testLoading'
            )
              v-icon(start) mdi-check
              span {{ $t('common:actions.apply') }}
        v-alert.mt-3(v-if='loadState === `error`', type='error', variant='tonal', icon='mdi-alert')
          span Unable to load the mail configuration. Existing values have been preserved.
          v-btn.ml-2(variant='text', size='small', @click='loadConfig') Retry
        v-skeleton-loader.mt-3(v-if='loadState === `loading` && !hasLoaded', type='card, card')

        v-form.pt-3(v-if='hasLoaded', ref='configForm', :disabled='saveLoading || loadState === `loading`', @submit.prevent='save')
          v-row
            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp(:loading='saveLoading')
                v-toolbar(color='primary', density='compact', flat)
                  v-toolbar-title.text-body-large {{ $t('admin:mail.configuration') }}
                .text-label-small.pa-4.text-grey {{ $t('admin:mail.sender') }}
                .px-4
                  v-text-field(
                    variant='outlined'
                    v-model='config.senderName'
                    :label='$t(`admin:mail.senderName`)'
                    :counter='255'
                    prepend-icon='mdi-mailbox'
                    :rules='[requiredRule]'
                  )
                  v-text-field(
                    variant='outlined'
                    v-model='config.senderEmail'
                    :label='$t(`admin:mail.senderEmail`)'
                    type='email'
                    :counter='255'
                    prepend-icon='mdi-email-outline'
                    :rules='[emailRule]'
                  )
                v-divider
                .text-label-small.pa-4.text-grey {{ $t('admin:mail.smtp') }}
                .px-4
                  v-text-field(
                    variant='outlined'
                    v-model='config.host'
                    :label='$t(`admin:mail.smtpHost`)'
                    :counter='255'
                    prepend-icon='mdi-memory'
                    :rules='[requiredRule]'
                  )
                  v-text-field.mail-port-field(
                    variant='outlined'
                    :model-value='config.port'
                    @update:model-value='updatePort'
                    :label='$t(`admin:mail.smtpPort`)'
                    type='number'
                    min='1'
                    max='65535'
                    prepend-icon='mdi-serial-port'
                    persistent-hint
                    :hint='$t(`admin:mail.smtpPortHint`)'
                    :rules='[portRule]'
                  )
                  v-text-field(
                    variant='outlined'
                    v-model='config.name'
                    :label='$t(`admin:mail.smtpName`)'
                    :counter='255'
                    prepend-icon='mdi-server'
                    persistent-hint
                    :hint='$t(`admin:mail.smtpNameHint`)'
                    :rules='[requiredRule]'
                  )
                  v-switch(
                    v-model='config.secure'
                    :label='$t(`admin:mail.smtpTLS`)'
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:mail.smtpTLSHint`)'
                    prepend-icon='mdi-security-network'
                    inset
                  )
                  v-switch(
                    v-model='config.verifySSL'
                    :label='$t(`admin:mail.smtpVerifySSL`)'
                    color='primary'
                    persistent-hint
                    :hint='$t(`admin:mail.smtpVerifySSLHint`)'
                    prepend-icon='mdi-security-network'
                    inset
                  )
                v-divider
                .pa-4
                  .text-label-small.text-grey Authentication
                  .text-body-small.text-medium-emphasis.mb-4 Optional SMTP credentials. Stored passwords are never displayed.
                  v-text-field(
                    variant='outlined'
                    v-model='config.user'
                    :label='$t(`admin:mail.smtpUser`)'
                    :counter='255'
                    prepend-icon='mdi-shield-account-outline'
                    :rules='[smtpUserRule]'
                  )
                  template(v-if='smtpPasswordMode === `keep`')
                    .mail-secret-row.d-flex.align-center.flex-wrap.ga-2.mb-4
                      v-icon(color='success') mdi-lock-check
                      strong SMTP password
                      v-chip(label, size='small', color='success') Stored
                      v-spacer
                      v-btn(variant='outlined', size='small', :disabled='saveLoading || loadState === `loading`', @click='replaceSmtpPassword') Replace
                      v-btn(variant='text', size='small', color='error', :disabled='saveLoading || loadState === `loading`', @click='requestSecretClear(`smtp`)') Clear
                  template(v-else-if='smtpPasswordMode === `clear`')
                    v-alert.mb-4(type='warning', variant='tonal') The stored SMTP password will be cleared when changes are applied.
                    .d-flex.flex-wrap.ga-2.mb-4
                      v-btn(variant='outlined', size='small', :disabled='saveLoading || loadState === `loading`', @click='replaceSmtpPassword') Use replacement instead
                      v-btn(v-if='smtpPasswordStored', variant='text', size='small', :disabled='saveLoading || loadState === `loading`', @click='keepSmtpPassword') Keep stored password
                  v-text-field(
                    v-else
                    variant='outlined'
                    v-model='config.pass'
                    :label='smtpPasswordStored ? `Replacement SMTP password` : $t(`admin:mail.smtpPwd`)'
                    prepend-icon='mdi-form-textbox-password'
                    type='password'
                    autocomplete='new-password'
                    :rules='[smtpPasswordRule]'
                  )
                  v-btn.mb-4(
                    v-if='smtpPasswordMode === `replace` && smtpPasswordStored'
                    variant='text'
                    size='small'
                    :disabled='saveLoading || loadState === `loading`'
                    @click='keepSmtpPassword'
                  ) Keep stored password

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p2s(:loading='saveLoading')
                v-toolbar(color='primary', density='compact', flat)
                  v-toolbar-title.text-body-large {{ $t('admin:mail.dkim') }}
                div.v-card-info
                  span {{ $t('admin:mail.dkimHint') }}
                .pa-4
                  v-switch(
                    v-model='config.useDKIM'
                    :label='$t(`admin:mail.dkimUse`)'
                    color='primary'
                    prepend-icon='mdi-key'
                    inset
                  )
                  v-text-field(
                    variant='outlined'
                    v-model='config.dkimDomainName'
                    :label='$t(`admin:mail.dkimDomainName`)'
                    :counter='255'
                    prepend-icon='mdi-key'
                    :disabled='!config.useDKIM'
                    :rules='[dkimTextRule]'
                  )
                  v-text-field(
                    variant='outlined'
                    v-model='config.dkimKeySelector'
                    :label='$t(`admin:mail.dkimKeySelector`)'
                    :counter='255'
                    prepend-icon='mdi-key'
                    :disabled='!config.useDKIM'
                    :rules='[dkimTextRule]'
                  )
                  template(v-if='dkimKeyMode === `keep`')
                    .mail-secret-row.d-flex.align-center.flex-wrap.ga-2.mb-4
                      v-icon(color='success') mdi-lock-check
                      strong DKIM private key
                      v-chip(label, size='small', color='success') Stored
                      v-spacer
                      v-btn(variant='outlined', size='small', :disabled='saveLoading || loadState === `loading` || !config.useDKIM', @click='replaceDkimKey') Replace
                      v-btn(variant='text', size='small', color='error', :disabled='saveLoading || loadState === `loading`', @click='requestSecretClear(`dkim`)') Clear
                  template(v-else-if='dkimKeyMode === `clear`')
                    v-alert.mb-4(type='warning', variant='tonal') The stored DKIM private key will be cleared when changes are applied.
                    .d-flex.flex-wrap.ga-2.mb-4
                      v-btn(variant='outlined', size='small', :disabled='saveLoading || loadState === `loading` || !config.useDKIM', @click='replaceDkimKey') Use replacement instead
                      v-btn(v-if='storedDkimPrivateKey', variant='text', size='small', :disabled='saveLoading || loadState === `loading`', @click='keepDkimKey') Keep stored key
                  v-textarea(
                    v-else
                    variant='outlined'
                    v-model='config.dkimPrivateKey'
                    :label='storedDkimPrivateKey ? `Replacement DKIM private key` : $t(`admin:mail.dkimPrivateKey`)'
                    prepend-icon='mdi-key'
                    persistent-hint
                    :hint='$t(`admin:mail.dkimPrivateKeyHint`)'
                    :disabled='!config.useDKIM'
                    :rules='[dkimKeyRule]'
                    autocomplete='off'
                  )
                  v-btn.mb-4(
                    v-if='dkimKeyMode === `replace` && storedDkimPrivateKey'
                    variant='text'
                    size='small'
                    :disabled='saveLoading || loadState === `loading`'
                    @click='keepDkimKey'
                  ) Keep stored key


          .mail-action-footer.d-flex.justify-end.mt-3
            v-btn(
              color='success'
              variant='flat'
              size='large'
              type='submit'
              :loading='saveLoading'
              :disabled='!isDirty || !isConfigValid || loadState !== `success` || testLoading'
            )
              v-icon(start) mdi-check
              span {{ $t('common:actions.apply') }}

        v-row(v-if='hasLoaded')
          v-col(cols='12', lg='6', offset-lg='6')
            v-form(ref='testForm', @submit.prevent='sendTest')
              v-card.animated.fadeInUp.wait-p3s
                v-toolbar(color='teal', density='compact', flat)
                  v-toolbar-title.text-body-large {{ $t('admin:mail.test') }}
                .pa-4
                  .text-body-medium.text-grey-darken-2 {{ $t('admin:mail.testHint') }}
                  v-alert.mt-3(v-if='isDirty', type='info', variant='tonal') Save changes before sending a test.
                  v-text-field.mt-3(
                    variant='outlined'
                    v-model='testEmail'
                    :label='$t(`admin:mail.testRecipient`)'
                    type='email'
                    :counter='255'
                    prepend-icon='mdi-email-outline'
                    :disabled='testLoading'
                    :rules='[emailRule]'
                  )
                div.v-card-chin
                  v-spacer
                  v-btn.px-4(
                    color='teal'
                    type='submit'
                    :loading='testLoading'
                    :disabled='testUnavailable || !isEmail(testEmail)'
                  )
                    v-icon(start) mdi-send
                    span {{ $t('admin:mail.testSend') }}

    v-dialog(v-model='secretClearDialog', max-width='500', persistent, aria-labelledby='mail-secret-clear-title')
      v-card
        .dialog-header.is-red#mail-secret-clear-title Clear stored credential?
        v-card-text {{ secretClearTarget === 'smtp' ? 'Clearing the SMTP password can stop authenticated mail delivery.' : 'Clearing the DKIM private key will stop DKIM signing until a replacement is saved.' }}
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='secretClearDialog = false') Keep credential
          v-btn(color='error', @click='confirmSecretClear') Clear credential
</template>

<script lang='ts'>
import _ from 'lodash'

import { fetchMailConfig, saveMailConfig, sendMailTest } from '../../helpers/mail-api'
import { wikiStore } from '@/store/index.ts'

const createAbortableFetch = (signal: AbortSignal) => (
  input: RequestInfo | URL,
  init?: RequestInit
) => window.fetch(input, { ...init, signal })

export default {
  data() {
    return {
      config: {
        senderName: '',
        senderEmail: '',
        host: '',
        port: 0,
        name: '',
        secure: false,
        verifySSL: false,
        user: '',
        pass: '',
        useDKIM: false,
        dkimDomainName: '',
        dkimKeySelector: '',
        dkimPrivateKey: ''
      },
      hasLoaded: false,
      loadState: 'loading' as 'loading' | 'success' | 'error',
      saveLoading: false,
      savedSignature: '',
      smtpPasswordStored: false,
      smtpPasswordMode: 'replace' as 'keep' | 'replace' | 'clear',
      storedDkimPrivateKey: '',
      dkimKeyMode: 'replace' as 'keep' | 'replace' | 'clear',
      secretClearDialog: false,
      secretClearTarget: null as 'smtp' | 'dkim' | null,
      testEmail: '',
      testLoading: false,
      testState: 'idle' as 'idle' | 'passed' | 'failed',
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      testController: null as AbortController | null,
      isUnmounted: false
    }
  },
  computed: {
    configurationSignature (): string {
      return JSON.stringify({
        config: this.config,
        smtpPasswordStored: this.smtpPasswordStored,
        smtpPasswordMode: this.smtpPasswordMode,
        dkimKeyStored: Boolean(this.storedDkimPrivateKey),
        dkimKeyMode: this.dkimKeyMode
      })
    },
    isDirty (): boolean {
      return this.hasLoaded && Boolean(this.savedSignature) && this.configurationSignature !== this.savedSignature
    },
    smtpPasswordAvailable (): boolean {
      if (this.smtpPasswordMode === 'keep') return this.smtpPasswordStored
      if (this.smtpPasswordMode === 'replace') return this.config.pass.trim().length > 0
      return false
    },
    dkimKeyAvailable (): boolean {
      if (this.dkimKeyMode === 'keep') return Boolean(this.storedDkimPrivateKey)
      if (this.dkimKeyMode === 'replace') return this.config.dkimPrivateKey.trim().length > 0
      return false
    },
    isConfigValid (): boolean {
      const baseValid = (
        this.config.senderName.trim().length > 0 &&
        this.isEmail(this.config.senderEmail) &&
        this.config.host.trim().length > 0 &&
        Number.isInteger(this.config.port) &&
        this.config.port >= 1 &&
        this.config.port <= 65535 &&
        this.config.name.trim().length > 0
      )
      const authenticationValid = (
        (!this.config.user.trim() && !this.smtpPasswordAvailable) ||
        (Boolean(this.config.user.trim()) && this.smtpPasswordAvailable)
      )
      const dkimValid = !this.config.useDKIM || (
        this.config.dkimDomainName.trim().length > 0 &&
        this.config.dkimKeySelector.trim().length > 0 &&
        this.dkimKeyAvailable
      )
      return baseValid && authenticationValid && dkimValid
    },
    isConfigured (): boolean {
      return this.hasLoaded && !this.isDirty && this.isConfigValid
    },
    testUnavailable (): boolean {
      return this.loadState !== 'success' || this.isDirty || !this.isConfigured ||
        this.saveLoading || this.testLoading
    },
    requiredRule (): (value: string) => true | string {
      return (value: string) => Boolean(value && value.trim()) || 'This field is required.'
    },
    emailRule (): (value: string) => true | string {
      return (value: string) => this.isEmail(value) || 'Enter a valid email address.'
    },
    portRule (): (value: number) => true | string {
      return (value: number) => (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535) || 'Enter a port from 1 to 65535.'
    },
    smtpUserRule (): (value: string) => true | string {
      return (value: string) => (!this.smtpPasswordAvailable || Boolean(value && value.trim())) || 'Enter a username for the stored password.'
    },
    smtpPasswordRule (): () => true | string {
      return () => (!this.config.user.trim() || this.smtpPasswordAvailable) || 'Enter an SMTP password or clear the username.'
    },
    dkimTextRule (): (value: string) => true | string {
      return (value: string) => (!this.config.useDKIM || Boolean(value && value.trim())) || 'This DKIM field is required.'
    },
    dkimKeyRule (): () => true | string {
      return () => (!this.config.useDKIM || this.dkimKeyAvailable) || 'Enter a DKIM private key.'
    }
  },
  methods: {
    isEmail (value: string): boolean {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim())
    },
    updatePort (value: string | number) {
      this.config.port = value === '' ? 0 : Number(value)
    },
    replaceSmtpPassword () {
      this.smtpPasswordMode = 'replace'
      this.config.pass = ''
    },
    keepSmtpPassword () {
      this.smtpPasswordMode = 'keep'
      this.config.pass = ''
    },
    replaceDkimKey () {
      this.dkimKeyMode = 'replace'
      this.config.dkimPrivateKey = ''
    },
    keepDkimKey () {
      this.dkimKeyMode = 'keep'
      this.config.dkimPrivateKey = ''
    },
    requestSecretClear (target: 'smtp' | 'dkim') {
      this.secretClearTarget = target
      this.secretClearDialog = true
    },
    confirmSecretClear () {
      if (this.secretClearTarget === 'smtp') {
        this.smtpPasswordMode = 'clear'
        this.config.pass = ''
      } else if (this.secretClearTarget === 'dkim') {
        this.dkimKeyMode = 'clear'
        this.config.dkimPrivateKey = ''
        this.config.useDKIM = false
      }
      this.secretClearTarget = null
      this.secretClearDialog = false
    },
    async save () {
      if (this.saveLoading || this.testLoading) return
      this.saveLoading = true
      const form = this.$refs.configForm as { validate?: () => Promise<{ valid: boolean }> }
      const validation = await form.validate?.()
      if (this.isUnmounted || !validation?.valid || !this.isConfigValid || this.loadState !== 'success') {
        if (!this.isUnmounted) {
          this.saveLoading = false
        }
        return
      }

      const pass = this.smtpPasswordMode === 'keep'
        ? (this.smtpPasswordStored ? '********' : '')
        : (this.smtpPasswordMode === 'replace' ? this.config.pass : '')
      const dkimPrivateKey = this.dkimKeyMode === 'keep'
        ? this.storedDkimPrivateKey
        : (this.dkimKeyMode === 'replace' ? this.config.dkimPrivateKey : '')
      const controller = new AbortController()
      this.saveController = controller
      wikiStore.startLoading('admin-mail-update')
      try {
        await saveMailConfig(createAbortableFetch(controller.signal), {
          senderName: this.config.senderName.trim(),
          senderEmail: this.config.senderEmail.trim(),
          host: this.config.host.trim(),
          port: _.toSafeInteger(this.config.port),
          name: this.config.name.trim(),
          secure: Boolean(this.config.secure),
          verifySSL: Boolean(this.config.verifySSL),
          user: this.config.user.trim(),
          pass,
          useDKIM: Boolean(this.config.useDKIM),
          dkimDomainName: this.config.dkimDomainName.trim(),
          dkimKeySelector: this.config.dkimKeySelector.trim(),
          dkimPrivateKey
        }, 'Mail configuration update failed')
        if (controller.signal.aborted) {
          return
        }

        this.config.senderName = this.config.senderName.trim()
        this.config.senderEmail = this.config.senderEmail.trim()
        this.config.host = this.config.host.trim()
        this.config.port = _.toSafeInteger(this.config.port)
        this.config.name = this.config.name.trim()
        this.config.user = this.config.user.trim()
        this.config.dkimDomainName = this.config.dkimDomainName.trim()
        this.config.dkimKeySelector = this.config.dkimKeySelector.trim()

        this.smtpPasswordStored = Boolean(pass)
        this.smtpPasswordMode = this.smtpPasswordStored ? 'keep' : 'replace'
        this.config.pass = ''
        this.storedDkimPrivateKey = dkimPrivateKey
        this.dkimKeyMode = dkimPrivateKey ? 'keep' : 'replace'
        this.config.dkimPrivateKey = ''
        this.testState = 'idle'
        await this.$nextTick()
        if (controller.signal.aborted) {
          return
        }
        this.savedSignature = this.configurationSignature

        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:mail.saveSuccess'),
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          wikiStore.showError(err)
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) {
            this.saveLoading = false
          }
        }
        wikiStore.stopLoading('admin-mail-update')
      }
    },
    async loadConfig () {
      this.loadController?.abort()
      const controller = new AbortController()
      this.loadController = controller
      this.loadState = 'loading'
      wikiStore.startLoading('admin-mail-refresh')
      try {
        const loaded = _.cloneDeep(await fetchMailConfig(createAbortableFetch(controller.signal)))
        if (controller.signal.aborted) {
          return
        }
        this.smtpPasswordStored = loaded.pass === '********'
        this.smtpPasswordMode = this.smtpPasswordStored ? 'keep' : 'replace'
        this.storedDkimPrivateKey = loaded.dkimPrivateKey
        this.dkimKeyMode = loaded.dkimPrivateKey ? 'keep' : 'replace'
        this.config = {
          ...loaded,
          pass: '',
          dkimPrivateKey: ''
        }
        this.hasLoaded = true
        this.loadState = 'success'
        this.testState = 'idle'
        await this.$nextTick()
        if (controller.signal.aborted) {
          return
        }
        this.savedSignature = this.configurationSignature
      } catch (err) {
        if (!controller.signal.aborted) {
          this.loadState = 'error'
          wikiStore.showError(err)
        }
      } finally {
        if (this.loadController === controller) {
          this.loadController = null
        }
        wikiStore.stopLoading('admin-mail-refresh')
      }
    },
    async sendTest () {
      if (this.testLoading || this.saveLoading) return
      this.testLoading = true
      const form = this.$refs.testForm as { validate?: () => Promise<{ valid: boolean }> }
      const validation = await form.validate?.()
      if (
        this.isUnmounted ||
        !validation?.valid ||
        this.loadState !== 'success' ||
        this.isDirty ||
        !this.isConfigured ||
        !this.isEmail(this.testEmail)
      ) {
        if (!this.isUnmounted) {
          this.testLoading = false
        }
        return
      }

      const controller = new AbortController()
      this.testController = controller
      wikiStore.startLoading('admin-mail-test')
      try {
        await sendMailTest(
          createAbortableFetch(controller.signal),
          this.testEmail.trim(),
          'An unexpected error occurred.'
        )
        if (controller.signal.aborted) {
          return
        }
        this.testEmail = ''
        this.testState = 'passed'
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('admin:mail.sendTestSuccess'),
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          this.testState = 'failed'
          wikiStore.showError(err)
        }
      } finally {
        if (this.testController === controller) {
          this.testController = null
          if (!this.isUnmounted) {
            this.testLoading = false
          }
        }
        wikiStore.stopLoading('admin-mail-test')
      }
    }
  },
  created () {
    this.loadConfig()
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
    this.testController?.abort()
  }
}
</script>

<style lang='scss'>
.mail-port-field {
  max-width: 300px;
}


@media (max-width: 599px) {
  .mail-port-field {
    max-width: none;
  }

  .mail-action-footer .v-btn {
    width: 100%;
  }
}
</style>

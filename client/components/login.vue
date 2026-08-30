<template lang="pug">
  v-app
    .login(:style='`background-image: url(` + bgUrl + `);`')
      main.login-sd(:aria-busy='isLoading', aria-labelledby='login-site-title')
        .login-brand
          .login-logo
            v-avatar(rounded='0', size='34')
              img(:src='logoUrl', alt='')
          .login-title
            .login-eyebrow {{ $t('auth:loginRequired') }}
            h1#login-site-title {{ siteTitle }}
        v-alert.mb-0(
          v-model='errorShown'
          color="error"
          rounded='lg'
          variant='tonal'
          icon='mdi-alert'
          role='alert'
          )
          .text-body-medium {{errorMessage}}
        template(v-if='screen === `login` && filteredStrategies.length > 1')
          .login-subtitle
            h2#login-provider-title(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:selectAuthProvider')}}
          .login-list
            v-list.elevation-1.radius-7(nav aria-labelledby='login-provider-title')
              v-list-item(
                v-for='stg of filteredStrategies'
                :key='stg.key'
                :value='stg.key'
                role='button'
                :color='stg.strategy.color'
                :active='selectedStrategyKey === stg.key'
                :aria-pressed='selectedStrategyKey === stg.key'
                @click='selectedStrategyKey = stg.key'
                )
                template(v-slot:prepend)
                  v-avatar.mr-3(rounded='0', size='24')
                    v-icon(v-if='stg.strategy.icon') {{ stg.strategy.icon }}
                span.text-none {{stg.displayName}}
        template(v-if='screen === `login` && selectedStrategy.strategy.useForm')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:enterCredentials')}}
          form.login-form(@submit.prevent='login', :aria-busy='isLoading')
            v-text-field(
              variant="outlined"
              prepend-inner-icon='mdi-email-outline'
              bg-color='surface'
              color="primary"
              ref='iptEmail'
              v-model='username'
              :label='isUsernameEmail ? $t(`auth:fields.email`) : $t(`auth:fields.username`)'
              :placeholder='isUsernameEmail ? $t(`auth:fields.email`) : $t(`auth:fields.username`)'
              :type='isUsernameEmail ? `email` : `text`'
              :autocomplete='isUsernameEmail ? `email` : `username`'
              :error-messages='fieldErrors.username'
              required
              )
            v-text-field.mt-2(
              variant="outlined"
              prepend-inner-icon='mdi-lock-outline'
              bg-color='surface'
              color="primary"
              ref='iptPassword'
              v-model='password'
              :type='hidePassword ? "password" : "text"'
              :label='$t("auth:fields.password")'
              :placeholder='$t("auth:fields.password")'
              autocomplete='current-password'
              :error-messages='fieldErrors.password'
              required
            )
              template(v-slot:append-inner)
                v-btn(
                  icon
                  type='button'
                  variant='text'
                  size='small'
                  :aria-label='hidePassword ? `Show password` : `Hide password`'
                  @click='hidePassword = !hidePassword'
                  )
                  v-icon(:icon='hidePassword ? `mdi-eye-off` : `mdi-eye`')
            v-btn.mt-2.text-none(
              width='100%'
              size="large"
              color="primary"
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:actions.login') }}
            .text-center.mt-5
              v-btn.text-none(
                variant="text"
                rounded
                color="primary"
                @click.stop.prevent='forgotPassword'
                href='#forgot'
                ): .text-body-small {{ $t('auth:forgotPasswordLink') }}
              v-btn.text-none(
                v-if='selectedStrategyKey === `local` && selectedStrategy.selfRegistration'
                color="indigo-darken-2"
                variant="text"
                rounded
                href='/register'
                ): .text-body-small {{ $t('auth:switchToRegister.link') }}
        template(v-if='screen === `forgot`')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:forgotPasswordTitle')}}
          .login-info {{ $t('auth:forgotPasswordSubtitle') }}
          form.login-form(@submit.prevent='forgotPasswordSubmit', :aria-busy='isLoading')
            v-text-field(
              variant="outlined"
              prepend-inner-icon='mdi-email-outline'
              bg-color='surface'
              color="primary"
              ref='iptForgotPwdEmail'
              v-model='username'
              :label='$t(`auth:fields.email`)'
              :placeholder='$t(`auth:fields.email`)'
              type='email'
              autocomplete='email'
              :error-messages='fieldErrors.username'
              required
              )
            v-btn.mt-2.text-none(
              width='100%'
              size="large"
              color="primary"
              type="submit"
              :loading='isLoading'
              ) {{ $t('auth:sendResetPassword') }}
            .text-center.mt-5
              v-btn.text-none(
                variant="text"
                rounded
                color="primary"
                @click.stop.prevent='screen = `login`'
                href='#forgot'
                ): .text-body-small {{ $t('auth:forgotPasswordCancel') }}
        template(v-if='screen === `verifyEmail`')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:verifyEmail.title') }}
          .login-info {{ $t('auth:verifyEmail.instructions') }}
          v-btn.mt-3.text-none(
            width='100%'
            size='large'
            color='primary'
            :loading='isLoading'
            @click='confirmEmail'
            ) {{ $t('auth:verifyEmail.proceed') }}
        template(v-if='screen === `resetPwd`')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:resetPwd.title') }}
          .login-info {{ $t('auth:resetPwd.instructions') }}
          form.login-form(@submit.prevent='resetPassword', :aria-busy='isLoading')
            v-text-field.mt-2(
              variant='outlined'
              prepend-inner-icon='mdi-lock-outline'
              bg-color='surface'
              color='primary'
              ref='iptNewPassword'
              v-model='newPassword'
              :type='hideNewPassword ? "password" : "text"'
              :label='$t(`auth:changePwd.newPasswordPlaceholder`)'
              :placeholder='$t(`auth:changePwd.newPasswordPlaceholder`)'
              autocomplete='new-password'
              :error-messages='fieldErrors.newPassword'
              required
              )
              template(v-slot:append-inner)
                v-btn(icon type='button' variant='text' size='small' :aria-label='hideNewPassword ? `Show password` : `Hide password`' @click='hideNewPassword = !hideNewPassword')
                  v-icon(:icon='hideNewPassword ? `mdi-eye-off` : `mdi-eye`')
              template(v-slot:loader)
                password-strength(v-model='newPassword')
            v-text-field.mt-2(
              variant='outlined'
              prepend-inner-icon='mdi-lock-check-outline'
              bg-color='surface'
              color='primary'
              ref='iptNewPasswordVerify'
              v-model='newPasswordVerify'
              :type='hideNewPasswordVerify ? "password" : "text"'
              :label='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
              :placeholder='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
              autocomplete='new-password'
              :error-messages='fieldErrors.newPasswordVerify'
              required
              )
              template(v-slot:append-inner)
                v-btn(icon type='button' variant='text' size='small' :aria-label='hideNewPasswordVerify ? `Show password` : `Hide password`' @click='hideNewPasswordVerify = !hideNewPasswordVerify')
                  v-icon(:icon='hideNewPasswordVerify ? `mdi-eye-off` : `mdi-eye`')
            v-btn.mt-2.text-none(
              width='100%'
              size='large'
              color='primary'
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:resetPwd.proceed') }}
        template(v-if='screen === `changePwd`')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:changePwd.subtitle') }}
          form.login-form(@submit.prevent='changePassword', :aria-busy='isLoading')
            v-text-field.mt-2(
              variant='outlined'
              prepend-inner-icon='mdi-lock-outline'
              bg-color='surface'
              color='primary'
              ref='iptNewPassword'
              v-model='newPassword'
              :type='hideNewPassword ? "password" : "text"'
              :label='$t(`auth:changePwd.newPasswordPlaceholder`)'
              :placeholder='$t(`auth:changePwd.newPasswordPlaceholder`)'
              autocomplete='new-password'
              :error-messages='fieldErrors.newPassword'
              required
              )
              template(v-slot:append-inner)
                v-btn(icon type='button' variant='text' size='small' :aria-label='hideNewPassword ? `Show password` : `Hide password`' @click='hideNewPassword = !hideNewPassword')
                  v-icon(:icon='hideNewPassword ? `mdi-eye-off` : `mdi-eye`')
              template(v-slot:loader)
                password-strength(v-model='newPassword')
            v-text-field.mt-2(
              variant='outlined'
              prepend-inner-icon='mdi-lock-check-outline'
              bg-color='surface'
              color='primary'
              ref='iptNewPasswordVerify'
              v-model='newPasswordVerify'
              :type='hideNewPasswordVerify ? "password" : "text"'
              :label='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
              :placeholder='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
              autocomplete='new-password'
              :error-messages='fieldErrors.newPasswordVerify'
              required
              )
              template(v-slot:append-inner)
                v-btn(icon type='button' variant='text' size='small' :aria-label='hideNewPasswordVerify ? `Show password` : `Hide password`' @click='hideNewPasswordVerify = !hideNewPasswordVerify')
                  v-icon(:icon='hideNewPasswordVerify ? `mdi-eye-off` : `mdi-eye`')
            v-btn.mt-2.text-none(
              width='100%'
              size='large'
              color='primary'
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:changePwd.proceed') }}
        template(v-if='screen === `success`')
          .login-success.text-center(role='status')
            v-icon.login-success-icon(color='success', icon='mdi-check-circle-outline')
            .text-title-large.mt-3 {{ successMessage }}
          v-btn.mt-5.text-none(
            width='100%'
            size='large'
            color='primary'
            variant='outlined'
            @click='screen = `login`'
            ) {{ $t('auth:switchToLogin.link') }}
    v-dialog(v-model='isTFAShown', max-width='500', persistent, aria-labelledby='login-tfa-title')
      v-card.login-dialog-card(variant='flat', :aria-busy='isLoading')
        .login-tfa.text-center.pa-5
          h2#login-tfa-title.text-label-large {{$t('auth:tfaFormTitle')}}
          img(src='_assets/svg/icon-pin-pad.svg', alt='')
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='surface'
            color="primary"
            ref='iptTFA'
            v-model='securityCode'
            :label='$t("auth:tfa.placeholder")'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            inputmode='numeric'
            maxlength='6'
            required
            @keyup.enter='verifySecurityCode(false)'
          )
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="primary"
            @click='verifySecurityCode(false)'
            :loading='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}
    v-dialog(v-model='isTFASetupShown', max-width='600', persistent, aria-labelledby='login-tfa-setup-title')
      v-card.login-dialog-card(variant='flat', :aria-busy='isLoading')
        .login-tfa.text-center.pa-5
          h2#login-tfa-setup-title.text-body-large.text-primary {{$t('auth:tfaSetupTitle')}}
          v-divider.my-5
          .text-label-large {{$t('auth:tfaSetupInstrFirst')}}
          .text-body-small (#[a(href='https://authy.com/', target='_blank', rel='noopener noreferrer') Authy], #[a(href='https://support.google.com/accounts/answer/1066447', target='_blank', rel='noopener noreferrer') Google Authenticator], #[a(href='https://www.microsoft.com/en-us/account/authenticator', target='_blank', rel='noopener noreferrer') Microsoft Authenticator], etc.)
          .login-tfa-qr.mt-5(v-if='isTFASetupShown', v-html='tfaQRImage', aria-hidden='true')
          .text-body-small.mt-3 Manual setup key
          code.login-tfa-secret {{tfaSecret}}
          .text-label-large.mt-5 {{$t('auth:tfaSetupInstrSecond')}}
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='surface'
            color="primary"
            ref='iptTFASetup'
            v-model='securityCode'
            :label='$t("auth:tfa.placeholder")'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            inputmode='numeric'
            maxlength='6'
            required
            @keyup.enter='verifySecurityCode(true)'
          )
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="primary"
            @click='verifySecurityCode(true)'
            :loading='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}
    loader(v-model='isLoading', :color='loaderColor', :title='loaderTitle', :subtitle='$t(`auth:pleaseWait`)')
    notify.login-notify
</template>


<script lang='ts'>
/* global siteConfig */

// <span>Photo by <a href="https://unsplash.com/@isaacquesada?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Isaac Quesada</a> on <a href="/t/textures-patterns?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Unsplash</a></span>

import _ from 'lodash'
import Cookies from 'js-cookie'
import { wikiStore } from '@/store/index.ts'
import { fetchAuthStrategies, submitAuthRequest, submitStatusRequest, type AuthResponse, type AuthStrategy } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'

type LoginScreen = 'login' | 'forgot' | 'verifyEmail' | 'resetPwd' | 'changePwd' | 'success'

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
}

export default {
  i18nOptions: { namespaces: 'auth' },
  props: {
    bgUrl: {
      type: String,
      default: ''
    },
    hideLocal: {
      type: Boolean,
      default: false
    },
    changePwdContinuationToken: {
      type: String,
      default: null
    },
    verificationToken: {
      type: String,
      default: null
    },
    resetPasswordToken: {
      type: String,
      default: null
    }
  },
  data () {
    return {
      error: false,
      strategies: [] as AuthStrategy[],
      selectedStrategyKey: 'unselected',
      selectedStrategy: { key: 'unselected', displayName: '', order: 0, selfRegistration: false, strategy: { useForm: false, usernameType: 'email', color: '', icon: '' } } as AuthStrategy,
      screen: 'login' as LoginScreen,
      username: '',
      password: '',
      hidePassword: true,
      hideNewPassword: true,
      hideNewPasswordVerify: true,
      securityCode: '',
      continuationToken: '',
      isLoading: false,
      loaderColor: 'grey-darken-4',
      loaderTitle: 'Working...',
      isShown: false,
      newPassword: '',
      newPasswordVerify: '',
      isTFAShown: false,
      isTFASetupShown: false,
      tfaQRImage: '',
      tfaSecret: '',
      errorShown: false,
      errorMessage: '',
      successMessage: '',
      fieldErrors: {
        username: '',
        password: '',
        newPassword: '',
        newPasswordVerify: ''
      }
    }
  },
  computed: {
    activeModal: {
      get(): string { return wikiStore.editor.activeModal },
      set(value: string) { wikiStore.editor.activeModal = value }
    },
    siteTitle () {
      return siteConfig.title
    },
    isSocialShown () {
      return this.strategies.length > 1
    },
    logoUrl () { return siteConfig.logoUrl },
    filteredStrategies () {
      const qParams = new URLSearchParams(window.location.search)
      if (this.hideLocal && !qParams.has('all')) {
        return _.reject(this.strategies, ['key', 'local'])
      } else {
        return this.strategies
      }
    },
    isUsernameEmail () {
      return this.selectedStrategy.strategy.usernameType === `email`
    },
  },
  watch: {
    screen () {
      this.$nextTick(() => {
        focusComponent(this.$refs.loginHeading)
      })
    },
    selectedStrategyKey (newValue: string) {
      this.selectedStrategy = _.find(this.strategies, ['key', newValue]) || { key: 'unselected', displayName: '', order: 0, selfRegistration: false, strategy: { useForm: false, usernameType: 'email', color: '', icon: '' } }
      if (['changePwd', 'verifyEmail', 'resetPwd', 'success'].includes(this.screen)) {
        return
      }
      this.screen = 'login'
      if (!this.selectedStrategy.strategy.useForm) {
        this.isLoading = true
        window.location.assign('/login/' + newValue)
      } else {
        this.$nextTick(() => {
          focusComponent(this.$refs.iptEmail)
        })
      }
    }
  },
  mounted () {
    this.isShown = true
    if (this.verificationToken) {
      this.screen = 'verifyEmail'
    } else if (this.resetPasswordToken) {
      this.screen = 'resetPwd'
    } else if (this.changePwdContinuationToken) {
      this.screen = 'changePwd'
      this.continuationToken = this.changePwdContinuationToken
    }
    this.loadStrategies()
  },
  methods: {
    showError (error: unknown) {
      this.errorMessage = typeof error === 'string' ? error : getErrorMessage(error)
      this.errorShown = true
    },
    clearError () {
      this.errorShown = false
      this.errorMessage = ''
      this.fieldErrors = {
        username: '',
        password: '',
        newPassword: '',
        newPasswordVerify: ''
      }
    },
    showSuccess (message: string) {
      this.clearError()
      this.successMessage = message
      this.screen = 'success'
    },
    async loadStrategies () {
      wikiStore.startLoading('login-strategies-refresh')
      try {
        this.strategies = await fetchAuthStrategies(window.fetch.bind(window), this.$t('auth:genericError'))

        if (this.filteredStrategies.length === 0) {
          this.errorMessage = this.$t('auth:genericError')
          this.errorShown = true
        } else if (this.screen === 'login' && this.filteredStrategies.length === 1) {
          this.selectedStrategyKey = this.filteredStrategies[0].key
        }
      } catch (err) {
        console.error(err)
        this.showError(err)
      } finally {
        wikiStore.stopLoading('login-strategies-refresh')
      }
    },
    /**
     * LOGIN
     */
    async login () {
      this.clearError()
      if (this.username.length < 2) {
        this.errorMessage = this.$t('auth:invalidEmailUsername')
        this.fieldErrors.username = this.errorMessage
        this.errorShown = true
        focusComponent(this.$refs.iptEmail)
      } else if (this.password.length < 2) {
        this.errorMessage = this.$t('auth:invalidPassword')
        this.fieldErrors.password = this.errorMessage
        this.errorShown = true
        focusComponent(this.$refs.iptPassword)
      } else {
        this.loaderColor = 'grey-darken-4'
        this.loaderTitle = this.$t('auth:signingIn')
        this.isLoading = true
        try {
          const respObj = await submitAuthRequest(window.fetch.bind(window), '/_api/auth/login', {
            username: this.username,
            password: this.password,
            strategy: this.selectedStrategy.key
          }, this.$t('auth:genericError'))
          this.handleLoginResponse(respObj)
        } catch (err) {
          console.error(err)
          this.showError(err)
          this.isLoading = false
        }
      }
    },
    /**
     * VERIFY TFA CODE
     */
    async verifySecurityCode (setup = false) {
      if (this.securityCode.length !== 6) {
        wikiStore.showNotification({
          style: 'red',
          message: 'Enter a valid security code.',
          icon: 'alert'
        })
        if (setup) {
          ;(this.$refs.iptTFASetup as { focus: () => void }).focus()
        } else {
          ;(this.$refs.iptTFA as { focus: () => void }).focus()
        }
      } else {
        this.loaderColor = 'grey-darken-4'
        this.loaderTitle = this.$t('auth:signingIn')
        this.isLoading = true
        try {
          const respObj = await submitAuthRequest(window.fetch.bind(window), '/_api/auth/login/tfa', {
            continuationToken: this.continuationToken,
            securityCode: this.securityCode,
            setup
          }, this.$t('auth:genericError'))
          this.handleLoginResponse(respObj)
        } catch (err) {
          if (!setup) {
            this.isTFAShown = false
          }
          console.error(err)
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
          this.isLoading = false
        }
      }
    },
    validatePasswordPair () {
      if (this.newPassword.length < 6) {
        this.errorMessage = this.$t('auth:passwordTooShort')
        this.fieldErrors.newPassword = this.errorMessage
        this.errorShown = true
        this.$nextTick(() => focusComponent(this.$refs.iptNewPassword))
        return false
      }
      if (this.newPassword !== this.newPasswordVerify) {
        this.errorMessage = this.$t('auth:passwordNotMatch')
        this.fieldErrors.newPasswordVerify = this.errorMessage
        this.errorShown = true
        this.$nextTick(() => focusComponent(this.$refs.iptNewPasswordVerify))
        return false
      }
      return true
    },
    /**
     * CHANGE PASSWORD
     */
    async changePassword () {
      this.clearError()
      if (!this.validatePasswordPair()) return
      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:changePwd.loading')
      this.isLoading = true
      try {
        const respObj = await submitAuthRequest(window.fetch.bind(window), '/_api/auth/login/change-password', {
          continuationToken: this.continuationToken,
          newPassword: this.newPassword
        }, this.$t('auth:genericError'))
        this.handleLoginResponse(respObj)
      } catch (err) {
        console.error(err)
        this.showError(err)
        this.isLoading = false
      }
    },
    /**
     * SWITCH TO FORGOT PASSWORD SCREEN
     */
    forgotPassword () {
      this.clearError()
      this.screen = 'forgot'
      this.$nextTick(() => {
        ;(this.$refs.iptForgotPwdEmail as { focus: () => void }).focus()
      })
    },
    /**
     * FORGOT PASSWORD SUBMIT
     */
    async forgotPasswordSubmit () {
      this.clearError()
      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:forgotPasswordLoading')
      this.isLoading = true
      try {
        await submitStatusRequest(window.fetch.bind(window), '/_api/auth/forgot-password', {
          email: this.username
        }, this.$t('auth:genericError'))
        this.showSuccess(this.$t('auth:forgotPasswordSuccess'))
      } catch (err) {
        console.error(err)
        this.showError(err)
      }
      this.isLoading = false
    },
    async confirmEmail () {
      this.clearError()
      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:verifyEmail.loading')
      this.isLoading = true
      try {
        await submitStatusRequest(window.fetch.bind(window), '/_api/auth/verify-email', {
          token: this.verificationToken
        }, this.$t('auth:genericError'))
        window.history.replaceState({}, '', '/login')
        this.showSuccess(this.$t('auth:verifyEmail.success'))
      } catch (err) {
        console.error(err)
        this.showError(err)
      }
      this.isLoading = false
    },
    async resetPassword () {
      this.clearError()
      if (!this.validatePasswordPair()) return
      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:changePwd.loading')
      this.isLoading = true
      try {
        await submitStatusRequest(window.fetch.bind(window), '/_api/auth/reset-password', {
          token: this.resetPasswordToken,
          newPassword: this.newPassword
        }, this.$t('auth:genericError'))
        this.newPassword = ''
        this.newPasswordVerify = ''
        window.history.replaceState({}, '', '/login')
        this.showSuccess(this.$t('auth:resetPwd.success'))
      } catch (err) {
        console.error(err)
        this.showError(err)
      }
      this.isLoading = false
    },
    handleLoginResponse (respObj: AuthResponse) {
      this.continuationToken = respObj.continuationToken || ''
      if (respObj.mustChangePwd === true) {
        this.screen = 'changePwd'
        this.$nextTick(() => {
          ;(this.$refs.iptNewPassword as { focus: () => void }).focus()
        })
        this.isLoading = false
      } else if (respObj.mustProvideTFA === true) {
        this.securityCode = ''
        this.isTFAShown = true
        setTimeout(() => {
          ;(this.$refs.iptTFA as { focus: () => void }).focus()
        }, 500)
        this.isLoading = false
      } else if (respObj.mustSetupTFA === true) {
        this.securityCode = ''
        this.isTFASetupShown = true
        this.tfaQRImage = respObj.tfaQRImage || ''
        this.tfaSecret = respObj.tfaSecret || ''
        setTimeout(() => {
          ;(this.$refs.iptTFASetup as { focus: () => void }).focus()
        }, 500)
        this.isLoading = false
      } else {
        this.loaderColor = 'green-darken-1'
        this.loaderTitle = this.$t('auth:loginSuccess')
        if (!respObj.jwt) throw new Error('Authentication response did not include a token.')
        Cookies.set('jwt', respObj.jwt, { expires: 365, secure: window.location.protocol === 'https:' })
        _.delay(() => {
          const loginRedirect = Cookies.get('loginRedirect')
          const isValidRedirect = loginRedirect && loginRedirect.startsWith('/') && !loginRedirect.startsWith('//') && !loginRedirect.includes('://')
          if (loginRedirect === '/' && respObj.redirect) {
            Cookies.remove('loginRedirect')
            window.location.replace(respObj.redirect)
          } else if (isValidRedirect) {
            Cookies.remove('loginRedirect')
            window.location.replace(loginRedirect)
          } else {
            if (loginRedirect) {
              Cookies.remove('loginRedirect')
            }
            if (respObj.redirect) {
              window.location.replace(respObj.redirect)
            } else {
              window.location.replace('/')
            }
          }
        }, 1000)
      }
    }
  }
}
</script>

<style lang="scss">
.login {
  position: relative;
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  align-items: center;
  overflow: hidden auto;
  padding: var(--wiki-space-10) clamp(var(--wiki-space-6), 6vw, var(--wiki-space-12));
  background-color: rgb(var(--v-theme-background));
  background-position: center;
  background-size: cover;
  color: rgb(var(--v-theme-on-background));
  font-family: var(--wiki-font-body);
  isolation: isolate;

  &::before {
    position: absolute;
    z-index: -2;
    inset: 0;
    background:
      radial-gradient(
        circle at 78% 16%,
        color-mix(in srgb, var(--wiki-accent-spectral) 24%, transparent),
        transparent 34rem
      ),
      linear-gradient(
        108deg,
        color-mix(in srgb, rgb(var(--v-theme-background)) 94%, transparent),
        color-mix(in srgb, rgb(var(--v-theme-background)) 76%, transparent) 62%,
        color-mix(in srgb, rgb(var(--v-theme-background)) 90%, transparent)
      );
    content: '';
    pointer-events: none;
  }

  &::after {
    position: absolute;
    z-index: -1;
    inset: var(--wiki-space-8);
    border: 1px solid color-mix(in srgb, var(--wiki-accent-spectral) 14%, transparent);
    border-radius: var(--wiki-hero-radius);
    background-image:
      linear-gradient(var(--wiki-surface-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--wiki-surface-border) 1px, transparent 1px);
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(90deg, transparent 38%, rgb(var(--v-theme-on-surface)));
    opacity: .42;
    pointer-events: none;
  }

  &-sd {
    position: relative;
    width: min(100%, 30rem);
    max-height: calc(100dvh - var(--wiki-space-12));
    margin: 0;
    padding: var(--wiki-space-8);
    overflow-y: auto;
    border: 1px solid var(--wiki-surface-border-strong);
    border-radius: var(--wiki-hero-radius);
    background: color-mix(
      in srgb,
      rgb(var(--v-theme-surface)) 96%,
      rgb(var(--v-theme-background))
    );
    box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
  }

  &-brand {
    display: flex;
    gap: var(--wiki-space-4);
    align-items: center;
    margin-bottom: var(--wiki-space-5);
  }

  &-logo {
    display: grid;
    flex: 0 0 3.25rem;
    width: 3.25rem;
    height: 3.25rem;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, transparent);
    border-radius: var(--wiki-panel-radius);
    background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
    box-shadow: var(--wiki-shadow-sm);

    > .v-avatar > img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
    }
  }

  &-title {
    min-width: 0;

    h1 {
      margin: var(--wiki-space-1) 0 0;
      overflow-wrap: anywhere;
      color: rgb(var(--v-theme-on-surface));
      font-size: 1.25rem;
      font-weight: 720;
      letter-spacing: -.035em;
      line-height: var(--wiki-leading-heading);
    }
  }

  &-eyebrow {
    color: var(--wiki-accent-warm);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .1em;
    line-height: 1rem;
    text-transform: uppercase;
  }

  & > &-sd > .v-alert {
    margin-bottom: var(--wiki-space-4) !important;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  }

  &-subtitle {
    padding: var(--wiki-space-4) var(--wiki-space-1) var(--wiki-space-2);
    color: rgb(var(--v-theme-on-surface));
    text-align: start;

    .text-body-large {
      margin: 0;
      font-size: 1rem !important;
      font-weight: 680;
      letter-spacing: -.015em;
    }
  }

  &-info {
    margin-block: var(--wiki-space-1) var(--wiki-space-3);
    padding: var(--wiki-space-3) var(--wiki-space-4);
    border: 1px solid var(--wiki-surface-border);
    border-inline-start: var(--wiki-space-1) solid var(--wiki-accent-spectral);
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, var(--wiki-accent-spectral) 7%, var(--wiki-surface-raised));
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 78%, transparent);
    font-size: .8125rem;
    line-height: 1.55;
    text-align: start;
  }

  &-success {
    padding: var(--wiki-space-8) var(--wiki-space-2) var(--wiki-space-3);
    color: rgb(var(--v-theme-on-surface));

    &-icon {
      font-size: 4rem;
      filter: drop-shadow(0 var(--wiki-space-1) var(--wiki-space-3) color-mix(in srgb, rgb(var(--v-theme-success)) 18%, transparent));
    }
  }

  &-list,
  &-form {
    padding-top: var(--wiki-space-1);
  }

  &-list {
    .v-list {
      padding: var(--wiki-space-2);
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-panel-radius) !important;
      background: var(--wiki-surface-sunken);
      box-shadow: none !important;
    }

    .v-list-item {
      min-height: var(--wiki-control-height);
      margin-block: var(--wiki-space-1);
      border-radius: var(--wiki-control-radius);
      transition:
        background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        color var(--wiki-motion-fast) var(--wiki-motion-ease);

      &--active {
        background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent);
        font-weight: 650;
      }
    }
  }

  &-form {
    .v-input + .v-input {
      margin-top: var(--wiki-space-2) !important;
    }

    > .v-btn {
      min-height: var(--wiki-control-height);
      border-radius: var(--wiki-control-radius);
      font-weight: 680;
      letter-spacing: .01em;
    }

    > .text-center {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wiki-space-1);
      justify-content: center;

      .v-btn {
        min-height: var(--wiki-control-height);
      }
    }
  }
}

.login-dialog-card {
  max-height: calc(100dvh - var(--wiki-space-8));
  overflow-y: auto;
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised) !important;
  box-shadow: var(--wiki-shadow-lg) !important;
}

.login-tfa {
  background: var(--wiki-surface-raised);
  color: rgb(var(--v-theme-on-surface)) !important;

  > img {
    width: 5.5rem;
    margin-bottom: var(--wiki-space-3);
  }

  &-field input {
    text-align: center;
  }

  &-secret {
    display: block;
    margin-top: var(--wiki-space-1);
    padding: var(--wiki-space-2);
    overflow-wrap: anywhere;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-radius-xs);
    background: var(--wiki-surface-sunken);
    user-select: all;
  }

  &-qr {
    width: 12.5rem;
    height: 12.5rem;
    margin: 0 auto;
    padding: var(--wiki-space-2);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: rgb(var(--v-theme-on-primary));
  }
}

.login-notify {
  padding-top: var(--wiki-footer-height);
}

@media (max-width: 599px) {
  .login {
    align-items: stretch;
    padding: 0;
    background-image: none !important;

    &::after {
      inset: 0;
      border: 0;
      border-radius: 0;
      opacity: .2;
    }

    &-sd {
      width: 100%;
      max-height: none;
      min-height: 100dvh;
      padding: var(--wiki-space-6) var(--wiki-space-5);
      border: 0;
      border-radius: 0;
      background: color-mix(
        in srgb,
        rgb(var(--v-theme-surface)) 96%,
        rgb(var(--v-theme-background))
      );
      box-shadow: none;
    }

    &-brand {
      margin-bottom: var(--wiki-space-4);
    }
  }
}

@media (max-height: 650px) and (min-width: 600px) {
  .login {
    align-items: flex-start;
    padding-block: var(--wiki-space-3);

    &-sd {
      max-height: calc(100dvh - var(--wiki-space-6));
      padding: var(--wiki-space-4) var(--wiki-space-6);
    }

    &-brand {
      margin-bottom: var(--wiki-space-1);
    }

    &-logo {
      flex-basis: 2.5rem;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: var(--wiki-control-radius);
    }

    &-subtitle {
      padding-block: var(--wiki-space-2) var(--wiki-space-1);
    }

    &-form {
      padding-top: 0;

      .v-field__input {
        min-height: var(--wiki-control-height);
        padding-block: var(--wiki-space-2);
      }

      > .text-center {
        margin-top: var(--wiki-space-1) !important;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .login *,
  .login *::before,
  .login *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}

@media print {
  .login {
    padding: 0;
    background: transparent !important;

    &::before,
    &::after {
      display: none;
    }

    &-sd {
      max-height: none;
      border: 0;
      box-shadow: none;
    }
  }
}
</style>

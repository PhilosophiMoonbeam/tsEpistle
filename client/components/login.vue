<template lang="pug">
  v-app
    .login(:style='`background-image: url(` + bgUrl + `);`')
      main.login-sd
        .login-brand
          .login-logo
            v-avatar(rounded='0', size='34')
              img(:src='logoUrl', :alt='siteTitle')
          .login-title
            .login-eyebrow {{ $t('auth:loginRequired') }}
            h1 {{ siteTitle }}
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
            h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:selectAuthProvider')}}
          .login-list
            v-list.elevation-1.radius-7(nav)
              v-list-item(
                v-for='stg of filteredStrategies'
                :key='stg.key'
                :value='stg.key'
                :color='stg.strategy.color'
                :active='selectedStrategyKey === stg.key'
                @click='selectedStrategyKey = stg.key'
                )
                template(v-slot:prepend)
                  v-avatar.mr-3(rounded='0', size='24')
                    v-icon(v-if='stg.strategy.icon') {{ stg.strategy.icon }}
                span.text-none {{stg.displayName}}
        template(v-if='screen === `login` && selectedStrategy.strategy.useForm')
          .login-subtitle
            h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:enterCredentials')}}
          form.login-form(@submit.prevent='login')
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
          form.login-form(@submit.prevent='forgotPasswordSubmit')
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
          form.login-form(@submit.prevent='resetPassword')
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
                v-btn(icon variant='text' size='small' :aria-label='hideNewPassword ? `Show password` : `Hide password`' @click='hideNewPassword = !hideNewPassword')
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
                v-btn(icon variant='text' size='small' :aria-label='hideNewPasswordVerify ? `Show password` : `Hide password`' @click='hideNewPasswordVerify = !hideNewPasswordVerify')
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
          form.login-form(@submit.prevent='changePassword')
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
                v-btn(icon variant='text' size='small' :aria-label='hideNewPassword ? `Show password` : `Hide password`' @click='hideNewPassword = !hideNewPassword')
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
                v-btn(icon variant='text' size='small' :aria-label='hideNewPasswordVerify ? `Show password` : `Hide password`' @click='hideNewPasswordVerify = !hideNewPasswordVerify')
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
      v-card
        .login-tfa.text-center.pa-5.text-grey-darken-3
          h2#login-tfa-title.text-label-large {{$t('auth:tfaFormTitle')}}
          img(src='_assets/svg/icon-pin-pad.svg', alt='')
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='white'
            color="primary"
            ref='iptTFA'
            v-model='securityCode'
            :label='$t("auth:tfa.placeholder")'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
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
      v-card
        .login-tfa.text-center.pa-5.text-grey-darken-3
          h2#login-tfa-setup-title.text-body-large.text-primary {{$t('auth:tfaSetupTitle')}}
          v-divider.my-5
          .text-label-large {{$t('auth:tfaSetupInstrFirst')}}
          .text-body-small (#[a(href='https://authy.com/', target='_blank', noopener) Authy], #[a(href='https://support.google.com/accounts/answer/1066447', target='_blank', noopener) Google Authenticator], #[a(href='https://www.microsoft.com/en-us/account/authenticator', target='_blank', noopener) Microsoft Authenticator], etc.)
          .login-tfa-qr.mt-5(v-if='isTFASetupShown', v-html='tfaQRImage', aria-hidden='true')
          .text-body-small.mt-3 Manual setup key
          code.login-tfa-secret {{tfaSecret}}
          .text-label-large.mt-5 {{$t('auth:tfaSetupInstrSecond')}}
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='white'
            color="primary"
            ref='iptTFASetup'
            v-model='securityCode'
            :label='$t("auth:tfa.placeholder")'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
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
    notify(style='padding-top: 64px;')
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
  padding: 40px clamp(24px, 6vw, 88px);
  background-color: #111827;
  background-position: center;
  background-size: cover;
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;

  &::before {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 72% 18%, rgba(var(--v-theme-primary), .26), transparent 32rem),
      linear-gradient(110deg, rgba(3, 7, 18, .84), rgba(15, 23, 42, .5) 55%, rgba(3, 7, 18, .72));
    content: '';
  }

  &::after {
    position: absolute;
    inset: auto 8vw 7vh auto;
    width: min(30vw, 420px);
    aspect-ratio: 1;
    border: 1px solid rgba(255, 255, 255, .08);
    border-radius: 50%;
    box-shadow:
      0 0 0 54px rgba(255, 255, 255, .025),
      0 0 0 108px rgba(255, 255, 255, .018);
    content: '';
  }

  &-sd {
    position: relative;
    z-index: 1;
    width: min(100%, 480px);
    max-height: calc(100dvh - 80px);
    margin: 0;
    padding: 30px;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, .28);
    border-radius: 28px;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 91%, transparent);
    box-shadow: 0 28px 80px rgba(0, 0, 0, .28);
    backdrop-filter: blur(24px) saturate(145%);
    -webkit-backdrop-filter: blur(24px) saturate(145%);

    @at-root .no-backdropfilter & {
      background: rgb(var(--v-theme-surface));
    }
  }
  &-brand {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-bottom: 18px;
  }
  &-logo {
    display: grid;
    flex: 0 0 52px;
    width: 52px;
    height: 52px;
    place-items: center;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
    box-shadow: 0 9px 24px rgba(var(--v-theme-primary), .13);
  }

  &-title {
    min-width: 0;

    h1 {
      overflow-wrap: anywhere;
      margin: 3px 0 0;
      color: rgb(var(--v-theme-on-surface));
      font-size: 1.28rem;
      font-weight: 740;
      letter-spacing: -.035em;
      line-height: 1.15;
    }
  }

  &-subtitle {
    padding: 18px 2px 9px;
    color: rgb(var(--v-theme-on-surface));
    font-weight: 680;
    text-align: start;

    .text-body-large {
      font-size: 1.05rem !important;
      letter-spacing: -.015em;
    }
  }

  &-info {
    margin-block: 4px 10px;
    padding: 13px 14px;
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: 12px;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 5%, transparent);
    color: rgb(var(--v-theme-on-surface));
    font-size: .82rem;
    line-height: 1.5;
    opacity: .8;
    text-align: start;
  }

  &-success {
    padding: 28px 8px 12px;
    color: rgb(var(--v-theme-on-surface));

    &-icon {
      font-size: 4.5rem;
    }
  }

  &-list,
  &-form {
    padding: 6px 0 0;
  }

  &-list {
    .v-list {
      padding: 7px;
      border: 1px solid rgba(var(--v-border-color), .1);
      border-radius: 14px !important;
      background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 3%, transparent);
      box-shadow: none !important;
    }

    .v-list-item {
      min-height: 46px;
      margin-block: 2px;
      border-radius: 10px;
    }
  }

  &-form {
    .v-field {
      border-radius: 13px;
      background: color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, transparent) !important;
    }

    > .v-btn {
      min-height: 48px;
      border-radius: 12px;
      font-weight: 680;
      letter-spacing: .01em;
    }
  }

  &-tfa {
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: 20px;
    background: rgb(var(--v-theme-surface));
    color: rgb(var(--v-theme-on-surface)) !important;

    > img {
      width: 86px;
      margin-bottom: 12px;
    }

    .v-field {
      border-radius: 12px;
    }

    &-field input {
      text-align: center;
    }

    &-secret {
      display: block;
      overflow-wrap: anywhere;
      user-select: all;
    }

    &-qr {
      width: 200px;
      height: 200px;
      margin: 0 auto;
      padding: 5px;
      border: 1px solid rgba(var(--v-border-color), .1);
      border-radius: 12px;
      background: #fff;
    }
  }
}

@media (max-width: 599px) {
  .login {
    align-items: stretch;
    padding: 0;
    background-image: none !important;

    &::after {
      display: none;
    }

    &-sd {
      width: 100%;
      max-height: none;
      min-height: 100dvh;
      padding: 28px 20px;
      border: 0;
      border-radius: 0;
      background: rgb(var(--v-theme-surface));
      box-shadow: none;
    }
  }
}

@media (max-height: 650px) and (min-width: 600px) {
  .login {
    align-items: flex-start;
    padding-block: 12px;

    &-sd {
      max-height: calc(100dvh - 24px);
      padding: 16px 24px;
    }

    &-brand {
      margin-bottom: 4px;
    }

    &-logo {
      flex-basis: 40px;
      width: 40px;
      height: 40px;
      border-radius: 12px;
    }

    &-subtitle {
      padding: 6px 2px 4px;
    }

    &-form {
      padding-top: 2px;

      .v-field__input {
        min-height: 44px;
        padding-block: 8px;
      }

      > .v-btn {
        min-height: 40px;
      }

      > .text-center {
        margin-top: 6px !important;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .login * {
    transition-duration: .01ms !important;
  }
}
</style>

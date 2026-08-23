<template lang="pug">
  v-app
    .login(:style='`background-image: url(` + bgUrl + `);`')
      .login-sd
        .d-flex.mb-5
          .login-logo
            v-avatar(rounded='0', size='34')
              img(:src='logoUrl', :alt='siteTitle')
          .login-title
            .text-h6.text-grey-darken-4 {{ siteTitle }}
        v-alert.mb-0(
          v-model='errorShown'
          color="red-darken-2"
          rounded='0'
          density="compact"
          icon='mdi-alert'
          )
          .text-body-medium {{errorMessage}}
        //-------------------------------------------------
        //- PROVIDERS LIST
        //-------------------------------------------------
        template(v-if='screen === `login` && filteredStrategies.length > 1')
          .login-subtitle
            .text-subtitle-1 {{$t('auth:selectAuthProvider')}}
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
        //-------------------------------------------------
        //- LOGIN FORM
        //-------------------------------------------------
        template(v-if='screen === `login` && selectedStrategy.strategy.useForm')
          .login-subtitle
            .text-subtitle-1 {{$t('auth:enterCredentials')}}
          form.login-form(@submit.prevent='login')
            v-text-field(
              variant="solo"
              flat
              prepend-inner-icon='mdi-clipboard-account'
              bg-color='white'
              color="blue-darken-2"
              hide-details
              ref='iptEmail'
              v-model='username'
              :placeholder='isUsernameEmail ? $t(`auth:fields.email`) : $t(`auth:fields.username`)'
              :type='isUsernameEmail ? `email` : `text`'
              :autocomplete='isUsernameEmail ? `email` : `username`'
              )
            v-text-field.mt-2(
              variant="solo"
              flat
              prepend-inner-icon='mdi-form-textbox-password'
              bg-color='white'
              color="blue-darken-2"
              hide-details
              ref='iptPassword'
              v-model='password'
              :append-icon='hidePassword ? "mdi-eye-off" : "mdi-eye"'
              @click:append='() => (hidePassword = !hidePassword)'
              :type='hidePassword ? "password" : "text"'
              :placeholder='$t("auth:fields.password")'
              autocomplete='current-password'
            )
            v-btn.mt-2.text-none(
              width='100%'
              size="large"
              color="blue-darken-2"
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:actions.login') }}
            .text-center.mt-5
              v-btn.text-none(
                variant="text"
                rounded
                color="grey-darken-3"
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
        //-------------------------------------------------
        //- FORGOT PASSWORD FORM
        //-------------------------------------------------
        template(v-if='screen === `forgot`')
          .login-subtitle
            .text-subtitle-1 {{$t('auth:forgotPasswordTitle')}}
          .login-info {{ $t('auth:forgotPasswordSubtitle') }}
          form.login-form(@submit.prevent='forgotPasswordSubmit')
            v-text-field(
              variant="solo"
              flat
              prepend-inner-icon='mdi-clipboard-account'
              bg-color='white'
              color="blue-darken-2"
              hide-details
              ref='iptForgotPwdEmail'
              v-model='username'
              :placeholder='$t(`auth:fields.email`)'
              type='email'
              autocomplete='email'
              )
            v-btn.mt-2.text-none(
              width='100%'
              size="large"
              color="blue-darken-2"
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:sendResetPassword') }}
            .text-center.mt-5
              v-btn.text-none(
                variant="text"
                rounded
                color="grey-darken-3"
                @click.stop.prevent='screen = `login`'
                href='#forgot'
                ): .text-body-small {{ $t('auth:forgotPasswordCancel') }}
        //-------------------------------------------------
        //- CHANGE PASSWORD FORM
        //-------------------------------------------------
        template(v-if='screen === `changePwd`')
          .login-subtitle
            .text-subtitle-1 {{ $t('auth:changePwd.subtitle') }}
          form.login-form(@submit.prevent='changePassword')
            v-text-field.mt-2(
              type='password'
              variant="solo"
              flat
              prepend-inner-icon='mdi-form-textbox-password'
              bg-color='white'
              color="blue-darken-2"
              hide-details
              ref='iptNewPassword'
              v-model='newPassword'
              :placeholder='$t(`auth:changePwd.newPasswordPlaceholder`)'
              autocomplete='new-password'
              )
              template(v-slot:loader)
                password-strength(v-model='newPassword')
            v-text-field.mt-2(
              type='password'
              variant="solo"
              flat
              prepend-inner-icon='mdi-form-textbox-password'
              bg-color='white'
              color="blue-darken-2"
              hide-details
              v-model='newPasswordVerify'
              :placeholder='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
              autocomplete='new-password'
            )
            v-btn.mt-2.text-none(
              width='100%'
              size="large"
              color="blue-darken-2"
              type='submit'
              :loading='isLoading'
              ) {{ $t('auth:changePwd.proceed') }}

    //-------------------------------------------------
    //- TFA FORM
    //-------------------------------------------------
    v-dialog(v-model='isTFAShown', max-width='500', persistent)
      v-card
        .login-tfa.text-center.pa-5.text-grey-darken-3
          img(src='_assets/svg/icon-pin-pad.svg')
          .text-label-large {{$t('auth:tfaFormTitle')}}
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='white'
            color="blue-darken-2"
            hide-details
            ref='iptTFA'
            v-model='securityCode'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            @keyup.enter='verifySecurityCode(false)'
          )
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="blue-darken-2"
            @click='verifySecurityCode(false)'
            :loading='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}

    //-------------------------------------------------
    //- SETUP TFA FORM
    //-------------------------------------------------
    v-dialog(v-model='isTFASetupShown', max-width='600', persistent)
      v-card
        .login-tfa.text-center.pa-5.text-grey-darken-3
          .text-body-large.text-primary {{$t('auth:tfaSetupTitle')}}
          v-divider.my-5
          .text-label-large {{$t('auth:tfaSetupInstrFirst')}}
          .text-body-small (#[a(href='https://authy.com/', target='_blank', noopener) Authy], #[a(href='https://support.google.com/accounts/answer/1066447', target='_blank', noopener) Google Authenticator], #[a(href='https://www.microsoft.com/en-us/account/authenticator', target='_blank', noopener) Microsoft Authenticator], etc.)
          .login-tfa-qr.mt-5(v-if='isTFASetupShown', v-html='tfaQRImage')
          .text-body-small.mt-3 Manual setup key
          code.login-tfa-secret {{tfaSecret}}
          .text-label-large.mt-5 {{$t('auth:tfaSetupInstrSecond')}}
          v-text-field.login-tfa-field.mt-2(
            variant="solo"
            flat
            bg-color='white'
            color="blue-darken-2"
            hide-details
            ref='iptTFASetup'
            v-model='securityCode'
            :placeholder='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            @keyup.enter='verifySecurityCode(true)'
          )
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="blue-darken-2"
            @click='verifySecurityCode(true)'
            :loading='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}

    loader(v-model='isLoading', :color='loaderColor', :title='loaderTitle', :subtitle='$t(`auth:pleaseWait`)')
    notify(style='padding-top: 64px;')</template>

<script lang='ts'>
/* global siteConfig */

// <span>Photo by <a href="https://unsplash.com/@isaacquesada?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Isaac Quesada</a> on <a href="/t/textures-patterns?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Unsplash</a></span>

import _ from 'lodash'
import Cookies from 'js-cookie'
import { wikiStore } from '@/store/index.ts'
import { fetchAuthStrategies, submitAuthRequest, submitStatusRequest, type AuthResponse, type AuthStrategy } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'

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
    }
  },
  data () {
    return {
      error: false,
      strategies: [] as AuthStrategy[],
      selectedStrategyKey: 'unselected',
      selectedStrategy: { key: 'unselected', displayName: '', order: 0, selfRegistration: false, strategy: { useForm: false, usernameType: 'email', color: '', icon: '' } } as AuthStrategy,
      screen: 'login',
      username: '',
      password: '',
      hidePassword: true,
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
      errorMessage: ''
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
    }
  },
  watch: {
    filteredStrategies (newValue: AuthStrategy[]) {
      const firstStrategy = _.head(newValue)
      if (firstStrategy && _.get(firstStrategy, 'strategy.useForm')) {
        this.selectedStrategyKey = firstStrategy.key
      }
    },
    selectedStrategyKey (newValue: string) {
      this.selectedStrategy = _.find(this.strategies, ['key', newValue]) || { key: 'unselected', displayName: '', order: 0, selfRegistration: false, strategy: { useForm: false, usernameType: 'email', color: '', icon: '' } }
      if (this.screen === 'changePwd') {
        return
      }
      this.screen = 'login'
      if (!this.selectedStrategy.strategy.useForm) {
        this.isLoading = true
        window.location.assign('/login/' + newValue)
      } else {
        this.$nextTick(() => {
          ;(this.$refs.iptEmail as { focus: () => void }).focus()
        })
      }
    }
  },
  mounted () {
    this.isShown = true
    if (this.changePwdContinuationToken) {
      this.screen = 'changePwd'
      this.continuationToken = this.changePwdContinuationToken
    }
    this.loadStrategies()
  },
  methods: {
    async loadStrategies () {
      wikiStore.startLoading('login-strategies-refresh')
      try {
        this.strategies = await fetchAuthStrategies(window.fetch.bind(window), this.$t('auth:genericError'))

        if (this.filteredStrategies.length === 0) {
          this.errorMessage = this.$t('auth:genericError')
          this.errorShown = true
        } else if (this.screen !== 'changePwd' && this.filteredStrategies.length === 1) {
          this.selectedStrategyKey = this.filteredStrategies[0].key
        }
      } catch (err) {
        console.error(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        wikiStore.stopLoading('login-strategies-refresh')
      }
    },
    /**
     * LOGIN
     */
    async login () {
      this.errorShown = false
      if (this.username.length < 2) {
        this.errorMessage = this.$t('auth:invalidEmailUsername')
        this.errorShown = true
        ;(this.$refs.iptEmail as { focus: () => void }).focus()
      } else if (this.password.length < 2) {
        this.errorMessage = this.$t('auth:invalidPassword')
        this.errorShown = true
        ;(this.$refs.iptPassword as { focus: () => void }).focus()
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
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
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
    /**
     * CHANGE PASSWORD
     */
    async changePassword () {
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
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        this.isLoading = false
      }
    },
    /**
     * SWITCH TO FORGOT PASSWORD SCREEN
     */
    forgotPassword () {
      this.screen = 'forgot'
      this.$nextTick(() => {
        ;(this.$refs.iptForgotPwdEmail as { focus: () => void }).focus()
      })
    },
    /**
     * FORGOT PASSWORD SUBMIT
     */
    async forgotPasswordSubmit () {
      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:forgotPasswordLoading')
      this.isLoading = true
      try {
        await submitStatusRequest(window.fetch.bind(window), '/_api/auth/forgot-password', {
          email: this.username
        }, this.$t('auth:genericError'))
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('auth:forgotPasswordSuccess'),
          icon: 'email'
        })
        this.screen = 'login'
      } catch (err) {
        console.error(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
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
    // background-image: url('/_assets/img/splash/1.jpg');
    background-color: mc('grey', '900');
    background-size: cover;
    background-position: center center;
    width: 100%;
    height: 100%;

    &-sd {
      background-color: rgba(255,255,255,.8);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-left: 1px solid rgba(255,255,255,.85);
      border-right: 1px solid rgba(255,255,255,.85);
      width: 450px;
      height: 100%;
      margin-left: 5vw;

      @at-root .no-backdropfilter & {
        background-color: rgba(255,255,255,.95);
      }

      @include until($tablet) {
        margin-left: 0;
        width: 100%;
      }
    }

    &-logo {
      padding: 12px 0 0 12px;
      width: 58px;
      height: 58px;
      background-color: #222;
      margin-left: 12px;
      border-bottom-left-radius: 7px;
      border-bottom-right-radius: 7px;
    }

    &-title {
      height: 58px;
      padding-left: 12px;
      display: flex;
      align-items: center;
      text-shadow: .5px .5px #FFF;
    }

    &-subtitle {
      padding: 24px 12px 12px 12px;
      color: #111;
      font-weight: 500;
      text-shadow: 1px 1px rgba(255,255,255,.5);
      background-image: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,.15));
      text-align: center;
      border-bottom: 1px solid rgba(0,0,0,.3);
    }

    &-info {
      border-top: 1px solid rgba(255,255,255,.85);
      background-color: rgba(255,255,255,.15);
      border-bottom: 1px solid rgba(0,0,0,.15);
      padding: 12px;
      font-size: 13px;
      text-align: center;
      color: mc('grey', '900');
    }

    &-list {
      border-top: 1px solid rgba(255,255,255,.85);
      padding: 12px;
    }

    &-form {
      padding: 12px;
      border-top: 1px solid rgba(255,255,255,.85);
    }

    &-main {
      flex: 1 0 100vw;
      height: 100vh;
    }

    &-tfa {
      background-color: #EEE;
      border: 7px solid #FFF;

      &-field input {
        text-align: center;
      }

      &-secret {
        display: block;
        overflow-wrap: anywhere;
        user-select: all;
      }

      &-qr {
        background-color: #FFF;
        padding: 5px;
        border-radius: 5px;
        width: 200px;
        height: 200px;
        margin: 0 auto;
      }
    }
  }
</style>

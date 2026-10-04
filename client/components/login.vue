<template lang="pug">
  v-app
    auth-shell.login(
      :title='siteTitle'
      :form-title='entryTitle'
      heading-id='login-site-title'
      :logo-url='logoUrl'
      :background-url='backgroundUrl'
      :busy='isLoading || strategiesLoading'
      :footer-sentence='showRegisterLink ? $t(`auth:switchToRegister.text`, { link: `{{link}}` }) : ``'
      :footer-link-label='showRegisterLink ? $t(`auth:switchToRegister.link`) : ``'
      footer-href='/register'
      :footer-disabled='isLoading'
    )
      v-alert.mb-0(
        v-model='errorShown'
        color="error"
        variant='tonal'
        icon='mdi-alert'
        role='alert'
        )
        .text-body-medium {{errorMessage}}
      .login-info(v-if='screen === `login` && strategiesLoading', role='status', aria-live='polite') {{ $t('auth:pleaseWait') }}
      v-btn.login-link.mb-3(
        v-if='screen === `login` && errorShown && filteredStrategies.length === 0'
        variant='outlined'
        :loading='strategiesLoading'
        :disabled='strategiesLoading || isLoading'
        @click='loadStrategies'
      ) {{ $t('common:actions.retry') }}
      template(v-if='screen === `login` && filteredStrategies.length > 1')
        .login-subtitle
          h2#login-provider-title(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:selectAuthProvider')}}
        .login-list
          v-list(
            v-model:selected='selectedStrategyKeys'
            select-strategy='single-independent'
            selectable
            nav
            :disabled='isLoading'
            aria-labelledby='login-provider-title'
          )
            v-list-item(
              v-for='stg of filteredStrategies'
              :key='stg.key'
              :value='stg.key'
              :color='stg.strategy.color'
              )
              template(v-slot:prepend)
                v-avatar.mr-3(rounded='0', size='24')
                  img(v-if='stg.strategy.logo' :src='stg.strategy.logo' width='24' height='24' alt='')
                  v-icon(v-else-if='stg.strategy.icon') {{ stg.strategy.icon }}
              span.text-none {{stg.displayName}}
      template(v-if='screen === `login` && selectedStrategy.strategy.useForm')
        .login-subtitle
          h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:enterCredentials')}}
        form.login-form(@submit.prevent='login', :aria-busy='isLoading')
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-email-outline'
            bg-color='surface'
            color="primary"
            ref='iptEmail'
            v-model='username'
            name='username'
            :label='isUsernameEmail ? $t(`auth:fields.email`) : $t(`auth:fields.username`)'
            :type='isUsernameEmail ? `email` : `text`'
            autocomplete='username'
            :error-messages='fieldErrors.username'
            :disabled='isLoading'
            required
            )
          v-text-field.mt-2(
            variant="outlined"
            active
            prepend-inner-icon='mdi-lock-outline'
            bg-color='surface'
            color="primary"
            ref='iptPassword'
            v-model='password'
            name='password'
            :type='showPassword ? "text" : "password"'
            :label='$t("auth:fields.password")'
            autocomplete='current-password'
            :error-messages='fieldErrors.password'
            :disabled='isLoading'
            required
          )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showPassword', :field='$t(`common:password.fields.password`)', :disabled='isLoading')
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="primary"
            type='submit'
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:actions.login') }}
          .login-links.mt-4
            v-btn.login-link.text-none(
              type='button'
              variant="text"
              :disabled='isLoading'
              @click='forgotPassword'
              ) {{ $t('auth:forgotPasswordLink') }}
      template(v-if='screen === `forgot`')
        .login-subtitle
          h2(tabindex='-1', ref='loginHeading').text-body-large {{$t('auth:forgotPasswordTitle')}}
        .login-info {{ $t('auth:forgotPasswordSubtitle') }}
        form.login-form(@submit.prevent='forgotPasswordSubmit', :aria-busy='isLoading')
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-email-outline'
            bg-color='surface'
            color="primary"
            ref='iptForgotPwdEmail'
            v-model='username'
            name='email'
            :label='$t(`auth:fields.email`)'
            type='email'
            autocomplete='email'
            :error-messages='fieldErrors.username'
            :disabled='isLoading'
            required
            )
          v-btn.mt-2.text-none(
            width='100%'
            size="large"
            color="primary"
            type="submit"
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:sendResetPassword') }}
          .login-links.mt-4
            v-btn.login-link.text-none(
              type='button'
              variant="text"
              :disabled='isLoading'
              @click='screen = `login`'
              ) {{ $t('auth:forgotPasswordCancel') }}
      template(v-if='screen === `verifyEmail`')
        .login-subtitle
          h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:verifyEmail.title') }}
        .login-info {{ $t('auth:verifyEmail.instructions') }}
        v-btn.mt-3.text-none(
          width='100%'
          size='large'
          color='primary'
          :loading='isLoading'
          :disabled='isLoading'
          @click='confirmEmail'
          ) {{ $t('auth:verifyEmail.proceed') }}
      template(v-if='screen === `resetPwd`')
        .login-subtitle
          h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:resetPwd.title') }}
        .login-info {{ $t('auth:resetPwd.instructions') }}
        form.login-form(@submit.prevent='resetPassword', :aria-busy='isLoading')
          v-text-field.mt-2(
            variant='outlined'
            active
            prepend-inner-icon='mdi-lock-outline'
            bg-color='surface'
            color='primary'
            ref='iptNewPassword'
            v-model='newPassword'
            name='new-password'
            :type='showNewPassword ? "text" : "password"'
            :label='$t(`auth:changePwd.newPasswordPlaceholder`)'
            autocomplete='new-password'
            :error-messages='fieldErrors.newPassword'
            :hint='passwordHint'
            persistent-hint
            :disabled='isLoading'
            required
            )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showNewPassword', :field='$t(`common:password.fields.newPassword`)', :disabled='isLoading')
            template(v-slot:loader)
              password-strength(:model-value='newPassword')
          v-text-field.mt-2(
            variant='outlined'
            active
            prepend-inner-icon='mdi-lock-check-outline'
            bg-color='surface'
            color='primary'
            ref='iptNewPasswordVerify'
            v-model='newPasswordVerify'
            name='new-password-confirmation'
            :type='showNewPasswordVerify ? "text" : "password"'
            :label='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
            autocomplete='new-password'
            :error-messages='fieldErrors.newPasswordVerify'
            :disabled='isLoading'
            required
            )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showNewPasswordVerify', :field='$t(`common:password.fields.newPasswordConfirmation`)', :disabled='isLoading')
          v-btn.mt-2.text-none(
            width='100%'
            size='large'
            color='primary'
            type='submit'
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:resetPwd.proceed') }}
      template(v-if='screen === `changePwd`')
        .login-subtitle
          h2(tabindex='-1', ref='loginHeading').text-body-large {{ $t('auth:changePwd.subtitle') }}
        form.login-form(@submit.prevent='changePassword', :aria-busy='isLoading')
          v-text-field.mt-2(
            variant='outlined'
            active
            prepend-inner-icon='mdi-lock-outline'
            bg-color='surface'
            color='primary'
            ref='iptNewPassword'
            v-model='newPassword'
            name='new-password'
            :type='showNewPassword ? "text" : "password"'
            :label='$t(`auth:changePwd.newPasswordPlaceholder`)'
            autocomplete='new-password'
            :error-messages='fieldErrors.newPassword'
            :hint='passwordHint'
            persistent-hint
            :disabled='isLoading'
            required
            )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showNewPassword', :field='$t(`common:password.fields.newPassword`)', :disabled='isLoading')
            template(v-slot:loader)
              password-strength(:model-value='newPassword')
          v-text-field.mt-2(
            variant='outlined'
            active
            prepend-inner-icon='mdi-lock-check-outline'
            bg-color='surface'
            color='primary'
            ref='iptNewPasswordVerify'
            v-model='newPasswordVerify'
            name='new-password-confirmation'
            :type='showNewPasswordVerify ? "text" : "password"'
            :label='$t(`auth:changePwd.newPasswordVerifyPlaceholder`)'
            autocomplete='new-password'
            :error-messages='fieldErrors.newPasswordVerify'
            :disabled='isLoading'
            required
            )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showNewPasswordVerify', :field='$t(`common:password.fields.newPasswordConfirmation`)', :disabled='isLoading')
          v-btn.mt-2.text-none(
            width='100%'
            size='large'
            color='primary'
            type='submit'
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:changePwd.proceed') }}
          .login-links.mt-4
            v-btn.login-link.text-none(
              type='button'
              variant='text'
              :disabled='isLoading'
              @click='cancelContinuation'
              ) {{ $t('auth:tfaRecovery.cancel') }}
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
      template(#aside)
        LoginParticleLogo(:effect='logoEffect')
    v-dialog(v-model='isTFAShown', max-width='500', persistent, aria-labelledby='login-tfa-title', @keydown.esc='cancelContinuation')
      v-card.login-dialog-card(variant='flat', :aria-busy='isLoading')
        form.login-tfa.text-center.pa-5(novalidate, @submit.prevent='verifySecurityCode(false)')
          h2#login-tfa-title.text-label-large {{$t('auth:tfaFormTitle')}}
          img(src='_assets/svg/icon-pin-pad.svg', alt='')
          v-text-field.login-tfa-field.mt-2(
            variant="outlined"
            active
            bg-color='surface'
            color="primary"
            ref='iptTFA'
            v-model='securityCode'
            name='security-code'
            :label='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            inputmode='numeric'
            pattern='[0-9]{6}'
            maxlength='6'
            required
            :error-messages='securityCodeError'
            :disabled='isLoading'
          )
          v-btn.mt-2.text-none(
            width='100%'
            type='submit'
            size="large"
            color="primary"
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}
          p.login-tfa-help.mt-4 {{ $t('auth:tfaRecovery.lostDevice') }}
          v-btn.login-link.mt-1.text-none(
            type='button'
            variant='text'
            :disabled='isLoading'
            @click='cancelContinuation'
            ) {{ $t('auth:tfaRecovery.cancel') }}
    v-dialog(v-model='isTFASetupShown', max-width='600', persistent, aria-labelledby='login-tfa-setup-title', @keydown.esc='cancelContinuation')
      v-card.login-dialog-card(variant='flat', :aria-busy='isLoading')
        form.login-tfa.text-center.pa-5(novalidate, @submit.prevent='verifySecurityCode(true)')
          h2#login-tfa-setup-title.text-body-large {{$t('auth:tfaSetupTitle')}}
          v-divider.my-5
          .text-label-large {{$t('auth:tfaSetupInstrFirst')}}
          .login-tfa-help {{ $t('auth:tfaRecovery.setupApps') }}
          .login-tfa-qr.mt-5(v-if='isTFASetupShown', v-html='tfaQRImage', aria-hidden='true')
          .text-body-small.mt-3 {{$t('auth:tfaSetupInstrManual')}}
          .login-tfa-secret-row.mt-1
            code.login-tfa-secret(ref='tfaSecret') {{groupedTfaSecret}}
            v-btn(
              type='button'
              icon='mdi-content-copy'
              variant='text'
              size='small'
              color='primary'
              :disabled='isLoading || !tfaSecret'
              :aria-label='$t(`auth:tfaSetupCopyKey`)'
              @click='copyTfaSecret'
            )
          .text-body-small.mt-1(role='status', aria-live='polite') {{tfaCopyStatus}}
          .text-label-large.mt-5 {{$t('auth:tfaSetupInstrSecond')}}
          v-text-field.login-tfa-field.mt-2(
            variant="outlined"
            active
            bg-color='surface'
            color="primary"
            ref='iptTFASetup'
            v-model='securityCode'
            name='security-code'
            :label='$t("auth:tfa.placeholder")'
            autocomplete='one-time-code'
            inputmode='numeric'
            pattern='[0-9]{6}'
            maxlength='6'
            required
            :error-messages='securityCodeError'
            :disabled='isLoading'
          )
          v-btn.mt-2.text-none(
            width='100%'
            type='submit'
            size="large"
            color="primary"
            :loading='isLoading'
            :disabled='isLoading'
            ) {{ $t('auth:tfa.verifyToken') }}
          v-btn.login-link.mt-3.text-none(
            type='button'
            variant='text'
            :disabled='isLoading'
            @click='cancelContinuation'
            ) {{ $t('auth:tfaRecovery.cancel') }}
    loader(v-model='isLoading', :color='loaderColor', :title='loaderTitle', :subtitle='$t(`auth:pleaseWait`)')
    notify.login-notify
</template>


<script lang='ts'>
import { passwordPolicyMixin } from '../helpers/password-policy.ts'
import { newPasswordIssue } from '../../shared/security-policy.ts'
/* global siteConfig */


import { defineComponent } from 'vue'
import Cookies from 'js-cookie'
import { wikiStore, resolvePendingOfflineLogoutAfterExplicitSignIn } from '@/store/index.ts'
import { fetchAuthStrategies, submitAuthRequest, submitStatusRequest, type AuthResponse, type AuthStrategy } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'
import { sanitizeTfaQrImage } from '../helpers/tfa-qr'
import AuthShell from './common/auth-shell.vue'
import PasswordStrength from './common/password-strength.vue'
import PasswordVisibilityToggle from './common/password-visibility-toggle.vue'
import LoginParticleLogo from './login-logo/LoginParticleLogo.vue'
import { isLogoEffectDescriptor, type LogoEffectDescriptor } from './login-logo/particle-logo'

type LoginScreen = 'login' | 'forgot' | 'verifyEmail' | 'resetPwd' | 'changePwd' | 'success'

/** True when the visitor was sent here to reach a protected page, not when they chose to sign in. */
export function isRedirectedToLogin (loginRedirect: string | undefined, search: string): boolean {
  if (loginRedirect && loginRedirect !== '/') return true
  const query = new URLSearchParams(search)
  return query.has('redirect') || query.has('next')
}

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
}


export default defineComponent({
  mixins: [passwordPolicyMixin],
  i18nOptions: { namespaces: 'auth' },
  components: {
    AuthShell,
    LoginParticleLogo,
    PasswordStrength,
    PasswordVisibilityToggle
  },
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
      strategies: [] as AuthStrategy[],
      selectedStrategyKey: 'unselected',
      screen: 'login' as LoginScreen,
      username: '',
      password: '',
      showPassword: false,
      showNewPassword: false,
      showNewPasswordVerify: false,
      wasRedirected: false,
      securityCode: '',
      securityCodeError: '',
      continuationToken: '',
      isLoading: false,
      strategiesLoading: false,
      loaderColor: 'surface',
      loaderTitle: 'Working...',
      newPassword: '',
      newPasswordVerify: '',
      isTFAShown: false,
      isTFASetupShown: false,
      tfaQRImage: '',
      tfaSecret: '',
      tfaCopyStatus: '',
      focusTimer: null as number | null,
      redirectTimer: null as number | null,
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
    selectedStrategyKeys: {
      get(): string[] {
        return this.selectedStrategyKey === 'unselected' ? [] : [this.selectedStrategyKey]
      },
      set(keys: string[]) {
        const [key] = keys
        if (key) this.selectedStrategyKey = key
      }
    },
    selectedStrategy (): AuthStrategy {
      return this.strategies.find(strategy => strategy.key === this.selectedStrategyKey) ||
        { key: 'unselected', displayName: '', order: 0, selfRegistration: false, strategy: { useForm: false, usernameType: 'email', color: '', icon: '' } } as AuthStrategy
    },
    siteTitle () {
      return siteConfig.title
    },
    logoUrl () { return siteConfig.logoUrl },
    logoEffect (): LogoEffectDescriptor | null {
      const candidate = (siteConfig as { logoEffect?: unknown }).logoEffect
      return isLogoEffectDescriptor(candidate) && candidate.logoUrl === siteConfig.logoUrl ? candidate : null
    },
    backgroundUrl (): string {
      const stockBackground = this.bgUrl === '/_assets/img/splash/tsepistle-orbit.svg'
      return this.bgUrl && !(this.logoEffect && stockBackground) ? this.bgUrl : ''
    },
    eyebrow (): string {
      return this.wasRedirected ? this.$t('auth:loginRequired') : this.$t('auth:signIn')
    },
    entryTitle (): string {
      switch (this.screen) {
        case 'forgot': return this.$t('auth:forgotPasswordTitle')
        case 'verifyEmail': return this.$t('auth:verifyEmail.title')
        case 'resetPwd': return this.$t('auth:resetPwd.title')
        case 'changePwd': return this.$t('auth:changePwd.subtitle')
        case 'success': return this.successMessage
        default: return this.eyebrow
      }
    },
    showRegisterLink (): boolean {
      return this.screen === 'login' && this.selectedStrategyKey === 'local' && this.selectedStrategy.selfRegistration
    },
    filteredStrategies () {
      const qParams = new URLSearchParams(window.location.search)
      if (this.hideLocal && !qParams.has('all')) {
        return this.strategies.filter(strategy => strategy.key !== 'local')
      }
      return this.strategies
    },
    groupedTfaSecret (): string {
      return this.tfaSecret.replace(/.{4}(?=.)/g, '$& ')
    },
    isUsernameEmail () {
      return this.selectedStrategy.strategy.usernameType === `email`
    },
  },
  watch: {
    screen (screen: LoginScreen) {
      if (screen === 'login' && this.filteredStrategies.length === 1) {
        this.selectedStrategyKey = this.filteredStrategies[0].key
      }
      this.$nextTick(() => {
        focusComponent(this.$refs.loginHeading)
      })
    },
    selectedStrategyKey (newValue: string) {
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
    this.wasRedirected = isRedirectedToLogin(Cookies.get('loginRedirect'), window.location.search)
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
  beforeUnmount () {
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
    if (this.redirectTimer !== null) window.clearTimeout(this.redirectTimer)
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
    async copyTfaSecret () {
      this.tfaCopyStatus = ''
      try {
        if (!navigator.clipboard?.writeText) throw new Error(this.$t('common:login.clipboardApiUnavailable'))
        await navigator.clipboard.writeText(this.tfaSecret)
        this.tfaCopyStatus = this.$t('auth:tfaSetupKeyCopied')
      } catch {
        const secret = this.$refs.tfaSecret
        if (secret instanceof HTMLElement) {
          const range = document.createRange()
          range.selectNodeContents(secret)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        this.tfaCopyStatus = this.$t('auth:tfaSetupKeyCopyFailed')
      }
    },
    async loadStrategies () {
      if (this.strategiesLoading) return
      this.strategiesLoading = true
      this.clearError()
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
        this.strategiesLoading = false
      }
    },
    /**
     * LOGIN
     */
    async login () {
      if (this.isLoading) return
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
        this.loaderColor = 'surface'
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
      if (this.isLoading) return
      this.securityCodeError = ''
      if (!/^\d{6}$/.test(this.securityCode)) {
        this.securityCodeError = this.$t('auth:tfaRecovery.invalidCode')
        focusComponent(setup ? this.$refs.iptTFASetup : this.$refs.iptTFA)
        return
      }

      this.loaderColor = 'surface'
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
        console.error(err)
        this.isLoading = false
        if (setup) {
          this.securityCodeError = getErrorMessage(err)
          this.$nextTick(() => {
            focusComponent(this.$refs.iptTFASetup)
          })
        } else {
          this.isTFAShown = false
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
      }
    },
    /**
     * Leave a pending 2FA or forced password-change step. No session exists yet:
     * the server only issued a single-purpose continuation token, so dropping
     * it from memory (with the code, setup secret and password) ends the attempt.
     */
    cancelContinuation () {
      if (this.isLoading) return
      if (this.focusTimer !== null) {
        window.clearTimeout(this.focusTimer)
        this.focusTimer = null
      }
      this.isTFAShown = false
      this.isTFASetupShown = false
      this.continuationToken = ''
      this.securityCode = ''
      this.securityCodeError = ''
      this.tfaQRImage = ''
      this.tfaSecret = ''
      this.tfaCopyStatus = ''
      this.password = ''
      this.newPassword = ''
      this.newPasswordVerify = ''
      this.clearError()
      this.screen = 'login'
      this.$nextTick(() => {
        focusComponent(this.selectedStrategy.strategy.useForm ? this.$refs.iptPassword : this.$refs.loginHeading)
      })
    },
    validatePasswordPair () {
      const passwordIssue = newPasswordIssue(this.newPassword, this.passwordMinimum)
      if (passwordIssue) {
        this.errorMessage = passwordIssue
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
      if (this.isLoading) return
      this.clearError()
      if (!this.validatePasswordPair()) return
      this.loaderColor = 'surface'
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
      if (this.isLoading) return
      this.clearError()
      this.screen = 'forgot'
      this.$nextTick(() => {
        focusComponent(this.$refs.iptForgotPwdEmail)
      })
    },
    /**
     * FORGOT PASSWORD SUBMIT
     */
    async forgotPasswordSubmit () {
      if (this.isLoading) return
      this.clearError()
      this.loaderColor = 'surface'
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
      if (this.isLoading) return
      this.clearError()
      this.loaderColor = 'surface'
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
      if (this.isLoading) return
      this.clearError()
      if (!this.validatePasswordPair()) return
      this.loaderColor = 'surface'
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
          focusComponent(this.$refs.iptNewPassword)
        })
        this.isLoading = false
      } else if (respObj.mustProvideTFA === true) {
        this.securityCode = ''
        this.securityCodeError = ''
        this.isTFAShown = true
        if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
        this.focusTimer = window.setTimeout(() => {
          focusComponent(this.$refs.iptTFA)
          this.focusTimer = null
        }, 500)
        this.isLoading = false
      } else if (respObj.mustSetupTFA === true) {
        const tfaQRImage = sanitizeTfaQrImage(respObj.tfaQRImage || '')
        if (!tfaQRImage) {
          this.tfaQRImage = ''
          this.tfaSecret = ''
          this.isLoading = false
          this.showError(this.$t('auth:genericError'))
          return
        }
        this.securityCode = ''
        this.securityCodeError = ''
        this.tfaQRImage = tfaQRImage
        this.tfaSecret = respObj.tfaSecret || ''
        this.tfaCopyStatus = ''
        this.isTFASetupShown = true
        if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
        this.focusTimer = window.setTimeout(() => {
          focusComponent(this.$refs.iptTFASetup)
          this.focusTimer = null
        }, 500)
        this.isLoading = false
      } else if (respObj.authenticated === true) {
        try {
          resolvePendingOfflineLogoutAfterExplicitSignIn()
        } catch (err) {
          console.error(err)
          this.isLoading = false
          this.showError(this.$t('auth:genericError'))
          return
        }
        this.loaderColor = 'success'
        this.loaderTitle = this.$t('auth:loginSuccess')
        if (this.redirectTimer !== null) window.clearTimeout(this.redirectTimer)
        this.redirectTimer = window.setTimeout(() => {
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
          this.redirectTimer = null
        }, 1000)
      } else {
        this.isLoading = false
        this.showError(this.$t('auth:genericError'))
      }
    }
  }
})
</script>

<style lang="scss">
.login {
  &-subtitle {
    padding: var(--wiki-space-4) 0 var(--wiki-space-3);
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
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);
    color: var(--wiki-text-muted);
    font-size: .9375rem;
    line-height: 1.6;
    text-align: start;
  }

  &-success {
    padding: var(--wiki-space-8) var(--wiki-space-2) var(--wiki-space-3);
    color: rgb(var(--v-theme-on-surface));

    &-icon {
      font-size: 4rem;
    }
  }

  &-list,
  &-form {
    padding-top: var(--wiki-space-1);
  }

  &-list {
    max-height: 20rem;
    overflow-y: auto;
    .v-list {
      padding: var(--wiki-space-2);
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-panel-radius) !important;
      background: var(--wiki-surface-sunken);
      box-shadow: none !important;
    }

    .v-list-item {
      min-height: var(--wiki-control-height);
      white-space: normal;
      overflow-wrap: anywhere;
      margin-block: var(--wiki-space-1);
      border-radius: var(--wiki-control-radius);
      transition:
        background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        color var(--wiki-motion-fast) var(--wiki-motion-ease);

      &--active {
        background: var(--wiki-surface-raised);
        font-weight: 650;
      }
    }
  }

  &-form {
    --login-field-autofill-surface: rgb(var(--v-theme-surface));

    .v-field {
      border-radius: var(--wiki-control-radius);
      background: var(--login-field-autofill-surface);
      isolation: isolate;
    }

    .v-field__overlay {
      border-radius: inherit;
    }

    .v-field__outline {
      z-index: 3;
    }

    .v-field__prepend-inner,
    .v-field__append-inner,
    .v-field__input {
      position: relative;
      z-index: 2;
    }

    .v-field:has(input:-webkit-autofill),
    .v-field:has(input:autofill) {
      background: var(--login-field-autofill-surface);
    }

    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    input:-webkit-autofill:active {
      border-radius: 0;
      -webkit-box-shadow: inset 0 0 0 100vmax var(--login-field-autofill-surface);
      box-shadow: inset 0 0 0 100vmax var(--login-field-autofill-surface);
      caret-color: rgb(var(--v-theme-on-surface));
      -webkit-text-fill-color: rgb(var(--v-theme-on-surface));
    }

    input:autofill {
      border-radius: 0;
      box-shadow: inset 0 0 0 100vmax var(--login-field-autofill-surface);
      caret-color: rgb(var(--v-theme-on-surface));
      color: rgb(var(--v-theme-on-surface));
    }

    .v-input + .v-input {
      margin-top: var(--wiki-space-2) !important;
    }

    > .v-btn {
      min-height: var(--wiki-control-height);
      border-radius: var(--wiki-control-radius);
      font-weight: 680;
      letter-spacing: .01em;
    }

  }

  &-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-1);
    justify-content: center;
  }
}

// Text-only auth actions use the readable accent ink, not the raw primary color.
.login-link.v-btn {
  min-height: var(--wiki-control-height);
  color: var(--wiki-accent-ink);
  font-size: .875rem;
  font-weight: 650;
  letter-spacing: 0;
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
    width: 3rem;
    margin-bottom: var(--wiki-space-3);
  }

  &-field input {
    text-align: center;
  }

  &-help {
    margin: var(--wiki-space-1) 0 0;
    color: var(--wiki-text-muted);
    font-size: .9375rem;
    line-height: 1.6;
  }

  &-secret-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--wiki-space-1);
  }

  &-secret {
    display: block;
    min-width: 0;
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
    // QR contrast is independent of the site's primary foreground color.
    background: #fff;

    svg {
      width: 100%;
      height: 100%;
      fill: #000;
    }
  }
}

.login-notify {
  padding-top: var(--wiki-footer-height);
}

@media (max-height: 650px) and (min-width: 600px) {
  .login {
    &-subtitle {
      padding-block: var(--wiki-space-2) var(--wiki-space-1);
    }

    &-form {
      padding-top: 0;

      .v-field__input {
        min-height: var(--wiki-control-height);
        padding-block: var(--wiki-space-2);
      }

    }

    &-links {
      margin-top: var(--wiki-space-1) !important;
    }
  }
}
</style>

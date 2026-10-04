<template lang="pug">
  v-app
    auth-shell.register(
      :title='siteTitle'
      heading-id='register-site-title'
      :eyebrow='$t(`auth:registerTitle`)'
      :logo-url='logoUrl'
      :background-url='bgUrl'
      :busy='isLoading'
      :footer-sentence='$t(`auth:switchToLogin.text`, { link: `{{link}}` })'
      :footer-link-label='$t(`auth:switchToLogin.link`)'
      footer-href='/login'
      :footer-disabled='isLoading'
    )
      template(#lead, v-if='!registered')
        p {{ $t('auth:registerSubTitle') }}
      template(v-if='registered')
        .register-success(role='status')
          v-icon.register-success__icon(color='success', icon='mdi-email-check-outline', aria-hidden='true')
          h2.register-success__title(ref='successHeading', tabindex='-1') {{ $t('auth:registerSuccess') }}
          p.register-success__copy {{ $t('auth:registerCheckEmail') }}
      template(v-else)
        v-alert.mb-3(
          v-model='errorShown'
          type='error'
          variant='tonal'
          density='compact'
          role='alert'
        ) {{ errorMessage }}
        form.register-form(@submit.prevent='register', :aria-busy='isLoading', novalidate)
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-account-outline'
            bg-color='surface'
            ref='iptName'
            v-model='name'
            name='name'
            :label='$t("auth:fields.name")'
            autocomplete='name'
            :error-messages='fieldErrors.name'
            color='primary'
            :disabled='isLoading'
            counter='255'
            required
          )
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-email-outline'
            bg-color='surface'
            ref='iptEmail'
            v-model='email'
            name='email'
            :label='$t("auth:fields.email")'
            type='email'
            autocomplete='email'
            :error-messages='fieldErrors.email'
            color='primary'
            :disabled='isLoading'
            required
          )
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-lock-outline'
            bg-color='surface'
            ref='iptPassword'
            v-model='password'
            name='new-password'
            :type='showPassword ? "text" : "password"'
            :label='$t("auth:fields.password")'
            autocomplete='new-password'
            :error-messages='fieldErrors.password'
            :hint='passwordHint'
            persistent-hint
            :disabled='isLoading'
            color='primary'
            loading
            counter='255'
            required
          )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showPassword', :field='$t(`common:password.fields.password`)', :disabled='isLoading')
            template(v-slot:loader)
              password-strength(:model-value='password')
          v-text-field(
            variant="outlined"
            active
            prepend-inner-icon='mdi-lock-check-outline'
            bg-color='surface'
            ref='iptVerifyPassword'
            v-model='verifyPassword'
            name='new-password-confirmation'
            :type='showVerifyPassword ? "text" : "password"'
            :label='$t("auth:fields.verifyPassword")'
            autocomplete='new-password'
            :error-messages='fieldErrors.verifyPassword'
            :disabled='isLoading'
            color='primary'
            required
          )
            template(v-slot:append-inner)
              password-visibility-toggle(v-model:visible='showVerifyPassword', :field='$t(`common:password.fields.passwordConfirmation`)', :disabled='isLoading')
          v-btn.register-submit(
            width='100%'
            size="large"
            color='primary'
            type='submit'
            :loading='isLoading'
            :disabled='isLoading'
          ) {{ $t('auth:actions.register') }}
    loader(v-model='isLoading', mode='loading', color='surface', :title='$t(`auth:registering`)', :subtitle='$t(`auth:pleaseWait`)')
    nav-footer
    notify.register-notify
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { passwordPolicyMixin } from '../helpers/password-policy.ts'
import { newPasswordIssue } from '../../shared/security-policy.ts'
import { wikiStore } from '@/store/index.ts'

import validateValues from '../../shared/validation'
import AuthShell from './common/auth-shell.vue'
import PasswordStrength from './common/password-strength.vue'
import PasswordVisibilityToggle from './common/password-visibility-toggle.vue'
import { registerAccount } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'

/** Field order on screen; the first invalid field in this order receives focus. */
export const REGISTER_FIELDS = ['name', 'email', 'password', 'verifyPassword'] as const
type RegisterField = typeof REGISTER_FIELDS[number]
const FIELD_REFS: Record<RegisterField, string> = {
  name: 'iptName',
  email: 'iptEmail',
  password: 'iptPassword',
  verifyPassword: 'iptVerifyPassword'
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
    PasswordStrength,
    PasswordVisibilityToggle
  },
  props: {
    bgUrl: {
      type: String,
      default: ''
    }
  },
  data () {
    return {
      email: '',
      password: '',
      verifyPassword: '',
      name: '',
      showPassword: false,
      showVerifyPassword: false,
      isLoading: false,
      registered: false,
      errorShown: false,
      errorMessage: '',
      fieldErrors: {
        email: '',
        password: '',
        verifyPassword: '',
        name: ''
      } as Record<RegisterField, string>
    }
  },
  computed: {
    siteTitle (): string {
      return wikiStore.site.title
    },
    logoUrl (): string {
      return wikiStore.site.logoUrl
    }
  },
  mounted () {
    this.$nextTick(() => {
      focusComponent(this.$refs.iptName)
    })
  },
  methods: {
    clearError () {
      this.errorShown = false
      this.errorMessage = ''
      this.fieldErrors = {
        email: '',
        password: '',
        verifyPassword: '',
        name: ''
      }
    },
    showFieldError (field: RegisterField, message: string) {
      this.fieldErrors[field] = message
      this.errorMessage = message
      this.errorShown = true
      focusComponent(this.$refs[FIELD_REFS[field]])
    },
    /**
     * REGISTER
     */
    async register () {
      if (this.isLoading || this.registered) return
      this.clearError()
      const validation = validateValues({
        email: this.email,
        password: this.password,
        verifyPassword: this.verifyPassword,
        name: this.name
      }, {
        email: {
          presence: {
            message: this.$t('auth:missingEmail'),
            allowEmpty: false
          },
          email: {
            message: this.$t('auth:invalidEmail')
          }
        },
        password: {
          presence: {
            message: this.$t('auth:missingPassword'),
            allowEmpty: false
          },
          length: {
            minimum: this.passwordMinimum,
            tooShort: this.passwordHint
          }
        },
        verifyPassword: {
          equality: {
            attribute: 'password',
            message: this.$t('auth:passwordNotMatch')
          }
        },
        name: {
          presence: {
            message: this.$t('auth:missingName'),
            allowEmpty: false
          },
          length: {
            minimum: 2,
            maximum: 255,
            tooShort: this.$t('auth:nameTooShort'),
            tooLong: this.$t('auth:nameTooLong')
          }
        }
      }, { fullMessages: false })

      if (validation) {
        const field = REGISTER_FIELDS.find(key => validation[key])
        if (field) {
          this.showFieldError(field, validation[field][0])
          return
        }
      }
      const passwordIssue = newPasswordIssue(this.password, this.passwordMinimum)
      if (passwordIssue) {
        this.showFieldError('password', passwordIssue)
        return
      }

      this.isLoading = true
      try {
        await registerAccount(window.fetch.bind(window), {
          email: this.email,
          password: this.password,
          name: this.name
        }, this.$t('auth:genericError'))
        this.password = ''
        this.verifyPassword = ''
        this.registered = true
        this.$nextTick(() => focusComponent(this.$refs.successHeading))
      } catch (err) {
        console.error(err)
        this.errorMessage = getErrorMessage(err)
        this.errorShown = true
      } finally {
        this.isLoading = false
      }
    }
  }
})
</script>

<style lang="scss">
.register-form {
  padding-top: var(--wiki-space-2);
  .v-input + .v-input {
    margin-top: var(--wiki-space-3);
  }
}

.register-submit.v-btn {
  min-height: var(--wiki-control-height);
  margin-top: var(--wiki-space-3);
  border-radius: var(--wiki-control-radius);
  font-weight: 680;
  text-transform: none;
}

.register-success {
  padding: var(--wiki-space-6) 0;
  text-align: center;

  &__icon {
    font-size: 3.5rem;
  }

  &__title {
    margin: var(--wiki-space-3) 0 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: 1.125rem;
    font-weight: 700;

    &:focus {
      outline: none;
    }
  }

  &__copy {
    margin: var(--wiki-space-2) 0 0;
    color: var(--wiki-text-muted);
    font-size: .9375rem;
    line-height: 1.55;
  }
}

.register-notify {
  padding-top: var(--wiki-footer-height);
}
</style>

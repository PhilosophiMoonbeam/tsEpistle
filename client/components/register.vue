<template lang="pug">
  v-app
    main.register(:style='registerStyle', aria-labelledby='register-site-title')
      v-container
        v-row
          v-col(
            cols='12'
            sm='10'
            offset-sm='1'
            md='8'
            offset-md='2'
            lg='6'
            offset-lg='3'
            xl='4'
            offset-xl='4'
            )
            transition(name='fadeUp')
              v-card.register-card(v-show='isShown' variant='flat')
                form.register-form(@submit.prevent='register', :aria-busy='isLoading')
                  v-card-text
                    .register-brand
                      .register-logo
                        v-avatar(rounded='0', size='34')
                          img(:src='logoUrl', alt='')
                      .register-brand-copy
                        .register-eyebrow {{ $t('auth:registerTitle') }}
                        h1#register-site-title.register-site-title {{ siteTitle }}
                    p.register-subtitle {{ $t('auth:registerSubTitle') }}
                    v-alert.mb-3(
                      v-model='errorShown'
                      type='error'
                      variant='tonal'
                      density='compact'
                      role='alert'
                    ) {{ errorMessage }}
                    v-text-field.mt-3(
                      variant="outlined"
                      prepend-inner-icon='mdi-email-outline'
                      bg-color='surface'
                      ref='iptEmail'
                      v-model='email'
                      name='email'
                      :label='$t("auth:fields.email")'
                      :placeholder='$t("auth:fields.email")'
                      type='email'
                      autocomplete='email'
                      :error-messages='fieldErrors.email'
                      color='primary'
                      :disabled='isLoading'
                      required
                    )
                    v-text-field.mt-2(
                      variant="outlined"
                      prepend-inner-icon='mdi-lock-outline'
                      bg-color='surface'
                      ref='iptPassword'
                      v-model='password'
                      name='new-password'
                      :type='hidePassword ? "password" : "text"'
                      :label='$t("auth:fields.password")'
                      :placeholder='$t("auth:fields.password")'
                      autocomplete='new-password'
                      :error-messages='fieldErrors.password'
                      :disabled='isLoading'
                      color='primary'
                      loading
                      counter='255'
                      required
                    )
                      template(v-slot:append-inner)
                        v-btn.auth-password-toggle(icon type='button' variant='text' size='small' :aria-label='(hidePassword ? $t(`common:header.view`) : $t(`common:actions.close`)) + ` ` + $t(`auth:fields.password`)' :disabled='isLoading' @click='hidePassword = !hidePassword')
                          v-icon(:icon='hidePassword ? `mdi-eye` : `mdi-eye-off`')
                      template(v-slot:loader)
                        password-strength(:model-value='password')
                    v-text-field.mt-2(
                      variant="outlined"
                      prepend-inner-icon='mdi-lock-check-outline'
                      bg-color='surface'
                      ref='iptVerifyPassword'
                      v-model='verifyPassword'
                      name='new-password-confirmation'
                      :type='hideVerifyPassword ? "password" : "text"'
                      :label='$t("auth:fields.verifyPassword")'
                      :placeholder='$t("auth:fields.verifyPassword")'
                      autocomplete='new-password'
                      :error-messages='fieldErrors.verifyPassword'
                      :disabled='isLoading'
                      color='primary'
                      required
                    )
                      template(v-slot:append-inner)
                        v-btn.auth-password-toggle(icon type='button' variant='text' size='small' :aria-label='(hideVerifyPassword ? $t(`common:header.view`) : $t(`common:actions.close`)) + ` ` + $t(`auth:fields.verifyPassword`)' :disabled='isLoading' @click='hideVerifyPassword = !hideVerifyPassword')
                          v-icon(:icon='hideVerifyPassword ? `mdi-eye` : `mdi-eye-off`')
                    v-text-field.mt-2(
                      variant="outlined"
                      prepend-inner-icon='mdi-account-outline'
                      bg-color='surface'
                      ref='iptName'
                      v-model='name'
                      name='name'
                      :label='$t("auth:fields.name")'
                      :placeholder='$t("auth:fields.name")'
                      autocomplete='name'
                      :error-messages='fieldErrors.name'
                      color='primary'
                      :disabled='isLoading'
                      counter='255'
                      required
                    )
                  v-card-actions.register-actions
                    v-btn(
                      width='100%'
                      size="large"
                      color='primary'
                      type='submit'
                      :loading='isLoading'
                      :disabled='isLoading'
                    ) {{ $t('auth:actions.register') }}
                v-divider
                v-card-actions.register-card-footer.py-3
                  i18next.text-body-small(path='auth:switchToLogin.text', tag='div')
                    a.text-body-small(
                      href='/login'
                      place='link'
                      :aria-disabled='isLoading'
                      :tabindex='isLoading ? -1 : undefined'
                      @click='isLoading && $event.preventDefault()'
                    ) {{ $t('auth:switchToLogin.link') }}
    loader(v-model='isLoading', :mode='loaderMode', :icon='loaderIcon', :color='loaderColor', :title='loaderTitle', :subtitle='loaderSubtitle')
    nav-footer
    notify.register-notify
</template>

<script lang='ts'>
/* global siteConfig */

import validateValues from '../../shared/validation'
import PasswordStrength from './common/password-strength.vue'
import { registerAccount } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'

function focusComponent (ref: unknown): void {
  if (!ref || typeof ref !== 'object') return
  const candidate = ref as { focus?: unknown }
  if (typeof candidate.focus === 'function') candidate.focus()
}

export default {
  i18nOptions: { namespaces: 'auth' },
  components: {
    PasswordStrength
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
      hidePassword: true,
      hideVerifyPassword: true,
      isLoading: false,
      isShown: false,
      loaderColor: 'grey-darken-4',
      loaderTitle: 'Working...',
      loaderSubtitle: 'Please wait',
      loaderMode: 'icon',
      loaderIcon: 'checkmark',
      errorShown: false,
      errorMessage: '',
      fieldErrors: {
        email: '',
        password: '',
        verifyPassword: '',
        name: ''
      }
    }
  },
  computed: {
    siteTitle () {
      return siteConfig.title
    },
    logoUrl () {
      return siteConfig.logoUrl
    },
    registerStyle () {
      return this.bgUrl ? { backgroundImage: `url(${this.bgUrl})` } : {}
    }
  },
  mounted () {
    this.isShown = true
    this.$nextTick(() => {
      focusComponent(this.$refs.iptEmail)
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
    /**
     * REGISTER
     */
    async register () {
      if (this.isLoading) return
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
            minimum: 6,
            tooShort: this.$t('auth:passwordTooShort')
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
        const fields = ['email', 'password', 'verifyPassword', 'name'] as const
        const field = fields.find(key => validation[key])
        if (field) {
          this.fieldErrors[field] = validation[field][0]
          this.errorMessage = validation[field][0]
          this.errorShown = true
          focusComponent(this.$refs[field === 'email' ? 'iptEmail' : field === 'password' ? 'iptPassword' : field === 'verifyPassword' ? 'iptVerifyPassword' : 'iptName'])
        }
        return
      }

      this.loaderColor = 'grey-darken-4'
      this.loaderTitle = this.$t('auth:registering')
      this.loaderSubtitle = this.$t(`auth:pleaseWait`)
      this.loaderMode = 'loading'
      this.isLoading = true
      try {
        await registerAccount(window.fetch.bind(window), {
          email: this.email,
          password: this.password,
          name: this.name
        }, this.$t('auth:genericError'))
        this.loaderColor = 'grey-darken-4'
        this.loaderTitle = this.$t('auth:registerSuccess')
        this.loaderSubtitle = this.$t(`auth:registerCheckEmail`)
        this.loaderMode = 'icon'
        this.isShown = false
      } catch (err) {
        console.error(err)
        this.errorMessage = getErrorMessage(err)
        this.errorShown = true
        this.isLoading = false
      }
    }
  }
}
</script>

<style lang="scss">
.auth-password-toggle {
  width: 44px !important;
  height: 44px !important;
  min-width: 44px !important;
  min-height: 44px !important;
  padding: 0;
}
.register {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden auto;
  background:
    radial-gradient(
      circle at 16% 12%,
      color-mix(in srgb, var(--wiki-accent-warm) 18%, transparent),
      transparent 30rem
    ),
    radial-gradient(
      circle at 86% 84%,
      color-mix(in srgb, var(--wiki-accent-spectral) 14%, transparent),
      transparent 34rem
    ),
    linear-gradient(
      145deg,
      var(--wiki-surface-sunken),
      rgb(var(--v-theme-background))
    );
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  color: rgb(var(--v-theme-on-background));
  font-family: var(--wiki-font-body);
  isolation: isolate;

  &::before {
    position: absolute;
    z-index: -1;
    inset: 0;
    background-image:
      linear-gradient(var(--wiki-surface-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--wiki-surface-border) 1px, transparent 1px);
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(to bottom, rgb(var(--v-theme-on-surface)), transparent 82%);
    opacity: .48;
    pointer-events: none;
  }

  > .v-container {
    display: flex;
    min-height: 100dvh;
    align-items: center;
    padding-block: var(--wiki-space-10);
  }

  > .v-container > .v-row {
    width: 100%;
  }
}

.register-card {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border-strong) !important;
  border-radius: var(--wiki-hero-radius) !important;
  background: color-mix(
    in srgb,
    rgb(var(--v-theme-surface)) 97%,
    rgb(var(--v-theme-background))
  ) !important;
  box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset) !important;

  .v-card-text {
    padding: var(--wiki-space-8) var(--wiki-space-8) var(--wiki-space-4);
  }
}

.register-brand {
  display: flex;
  gap: var(--wiki-space-4);
  align-items: center;
}

.register-logo {
  display: grid;
  flex: 0 0 3.25rem;
  width: 3.25rem;
  height: 3.25rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 24%, transparent);
  border-radius: var(--wiki-panel-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
  box-shadow: var(--wiki-shadow-sm);
}

.register-brand-copy {
  min-width: 0;
}

.register-eyebrow {
  color: var(--wiki-accent-warm);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  letter-spacing: .1em;
  line-height: 1rem;
  text-transform: uppercase;
}

.register-site-title {
  margin: var(--wiki-space-1) 0 0;
  overflow-wrap: anywhere;
  color: rgb(var(--v-theme-on-surface));
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 740;
  letter-spacing: -.045em;
  line-height: var(--wiki-leading-heading);
}

.register-subtitle {
  margin: var(--wiki-space-4) 0 var(--wiki-space-5);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
  line-height: 1.55;
}

.register-form {
  .v-alert {
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  }

  .v-input + .v-input {
    margin-top: var(--wiki-space-2) !important;
  }
}

.register-actions {
  padding: 0 var(--wiki-space-8) var(--wiki-space-6);

  .v-btn {
    min-height: var(--wiki-control-height);
    border-radius: var(--wiki-control-radius);
    font-weight: 680;
  }
}

.register-card-footer {
  min-height: var(--wiki-footer-height);
  justify-content: center;
  padding: var(--wiki-space-3) var(--wiki-space-8) !important;
  background: var(--wiki-surface-sunken);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  text-align: center;

  a {
    color: var(--wiki-accent-warm);
    font-weight: 650;
    text-decoration-thickness: .0625rem;
    text-underline-offset: var(--wiki-space-1);

    &:hover {
      text-decoration-thickness: .125rem;
    }
  }
}

.register-notify {
  padding-top: var(--wiki-footer-height);
}

@media (max-width: 599px) {
  .register {
    background-color: color-mix(
      in srgb,
      rgb(var(--v-theme-surface)) 96%,
      rgb(var(--v-theme-background))
    );

    > .v-container {
      padding: 0;
    }

    .v-row,
    .v-col {
      margin: 0;
      padding: 0;
    }
  }

  .register-card {
    min-height: 100dvh;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;

    .v-card-text {
      padding: var(--wiki-space-6) var(--wiki-space-5) var(--wiki-space-4);
    }
  }

  .register-actions {
    padding: 0 var(--wiki-space-5) var(--wiki-space-5);
  }

  .register-card-footer {
    padding-inline: var(--wiki-space-5) !important;
  }
}

@media (max-height: 700px) and (min-width: 600px) {
  .register {
    > .v-container {
      align-items: flex-start;
      padding-block: var(--wiki-space-3);
    }
  }

  .register-card {
    .v-card-text {
      padding-block: var(--wiki-space-4) var(--wiki-space-2);
    }
  }

  .register-subtitle {
    margin-block: var(--wiki-space-2) var(--wiki-space-3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .register *,
  .register *::before,
  .register *::after {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}

@media print {
  .register {
    background: transparent !important;

    &::before {
      display: none;
    }
  }

  .register-card {
    border: 0 !important;
    box-shadow: none !important;
  }
}
</style>

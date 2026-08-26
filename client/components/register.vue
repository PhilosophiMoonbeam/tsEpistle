<template lang="pug">
  v-app
    .register
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
                v-toolbar.register-card-header(color='surface' flat)
                  v-spacer
                  .text-body-large {{ $t('auth:registerTitle') }}
                  v-spacer
                v-card-text.text-center
                  h1.register-site-title {{ siteTitle }}
                  .register-subtitle {{ $t('auth:registerSubTitle') }}
                  v-text-field.mt-3(
                    variant="outlined"
                    prepend-inner-icon='mdi-email-outline'
                    bg-color='surface'
                    hide-details
                    ref='iptEmail'
                    v-model='email'
                    :placeholder='$t("auth:fields.email")'
                    color='primary'
                    )
                  v-text-field.mt-2(
                    variant="outlined"
                    prepend-inner-icon='mdi-lock-outline'
                    bg-color='surface'
                    ref='iptPassword'
                    v-model='password'
                    :type='hidePassword ? "password" : "text"'
                    :placeholder='$t("auth:fields.password")'
                    color='primary'
                    loading
                    counter='255'
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
                    template(v-slot:loader)
                      password-strength(v-model='password')
                  v-text-field.mt-2(
                    variant="outlined"
                    prepend-inner-icon='mdi-lock-check-outline'
                    bg-color='surface'
                    hide-details
                    ref='iptVerifyPassword'
                    v-model='verifyPassword'
                    @click:append='() => (hidePassword = !hidePassword)'
                    type='password'
                    :placeholder='$t("auth:fields.verifyPassword")'
                    color='primary'
                  )
                  v-text-field.mt-2(
                    variant="outlined"
                    prepend-inner-icon='mdi-account-outline'
                    bg-color='surface'
                    ref='iptName'
                    v-model='name'
                    :placeholder='$t("auth:fields.name")'
                    @keyup.enter='register'
                    color='primary'
                    counter='255'
                    )
                v-card-actions.pb-4
                  v-spacer
                  v-btn(
                    width='100%'
                    max-width='250px'
                    size="large"
                    color='primary'
                    @click='register'
                    rounded='lg'
                    :loading='isLoading'
                    ) {{ $t('auth:actions.register') }}
                  v-spacer
                v-divider
                v-card-actions.register-card-footer.py-3
                  v-spacer
                  i18next.text-body-small(path='auth:switchToLogin.text', tag='div')
                    a.text-body-small(href='/login', place='link') {{ $t('auth:switchToLogin.link') }}
                  v-spacer

    loader(v-model='isLoading', :mode='loaderMode', :icon='loaderIcon', :color='loaderColor', :title='loaderTitle', :subtitle='loaderSubtitle')
    nav-footer(color='grey-darken-4', dark-color='grey-darken-4')
    notify(style='padding-top: 64px;')</template>

<script lang='ts'>
/* global siteConfig */

import validateValues from '../../shared/validation'
import PasswordStrength from './common/password-strength.vue'
import { registerAccount } from '../helpers/auth-api'
import { getErrorMessage } from '../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

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
  data () {
    return {
      email: '',
      password: '',
      verifyPassword: '',
      name: '',
      hidePassword: true,
      isLoading: false,
      isShown: false,
      loaderColor: 'grey-darken-4',
      loaderTitle: 'Working...',
      loaderSubtitle: 'Please wait',
      loaderMode: 'icon',
      loaderIcon: 'checkmark'
    }
  },
  computed: {
    siteTitle () {
      return siteConfig.title
    }
  },
  mounted () {
    this.isShown = true
    this.$nextTick(() => {
      focusComponent(this.$refs.iptEmail)
    })
  },
  methods: {
    /**
     * REGISTER
     */
    async register () {
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
        if (validation.email) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.email[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptEmail)
        } else if (validation.password) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.password[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptPassword)
        } else if (validation.verifyPassword) {
          wikiStore.showNotification({
            style: 'red',
            message: validation.verifyPassword[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptVerifyPassword)
        } else {
          wikiStore.showNotification({
            style: 'red',
            message: validation.name[0],
            icon: 'warning'
          })
          focusComponent(this.$refs.iptName)
        }
      } else {
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
          wikiStore.showNotification({
            style: 'red',
            message: getErrorMessage(err),
            icon: 'warning'
          })
          this.isLoading = false
        }
      }
    }
  }
}
</script>

<style lang="scss">
.register {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden auto;
  background:
    radial-gradient(circle at 18% 14%, rgba(var(--v-theme-primary), .3), transparent 28rem),
    radial-gradient(circle at 84% 82%, rgba(99, 102, 241, .24), transparent 32rem),
    linear-gradient(145deg, #0b1220, #172033 58%, #101827);
  font-family: 'WikiAgentSans', 'Roboto', sans-serif;

  &::before {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, .025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, .025) 1px, transparent 1px);
    background-size: 42px 42px;
    mask-image: linear-gradient(to bottom, rgba(0, 0, 0, .8), transparent 78%);
    content: '';
  }

  > .v-container {
    position: relative;
    z-index: 1;
    display: flex;
    min-height: 100dvh;
    align-items: center;
    padding-block: 40px;
  }

  > .v-container > .v-row {
    width: 100%;
  }

  .v-field {
    border-radius: 13px;
  }
}

.register-card {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .24) !important;
  border-radius: 26px !important;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, transparent) !important;
  box-shadow: 0 30px 80px rgba(0, 0, 0, .3) !important;
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);

  &-header {
    min-height: 64px;
    border-bottom: 1px solid rgba(var(--v-border-color), .09);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, rgb(var(--v-theme-surface))) !important;
    color: rgb(var(--v-theme-on-surface));

    .text-body-large {
      font-weight: 690;
      letter-spacing: -.015em;
    }
  }

  .v-card-text {
    padding: 30px 34px 22px;
  }

  .v-card-actions {
    padding-inline: 34px;

    .v-btn {
      min-height: 48px;
      border-radius: 12px !important;
      font-weight: 680;
    }
  }
}

.register-site-title {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-size: clamp(1.9rem, 4vw, 2.6rem);
  font-weight: 760;
  letter-spacing: -.055em;
  line-height: 1.1;
}

.register-subtitle {
  margin: 8px 0 22px;
  color: rgb(var(--v-theme-on-surface));
  line-height: 1.55;
  opacity: .62;
}

.register-card-footer {
  min-height: 58px;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 3%, rgb(var(--v-theme-surface)));
  color: rgb(var(--v-theme-on-surface));

  a {
    color: rgb(var(--v-theme-primary));
    font-weight: 650;
    text-decoration: none;
  }
}

@media (max-width: 599px) {
  .register {
    background: rgb(var(--v-theme-background));

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
      padding: 28px 20px 20px;
    }

    .v-card-actions {
      padding-inline: 20px;
    }
  }
}
</style>

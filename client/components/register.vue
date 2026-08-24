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
              v-card.elevation-5(v-show='isShown')
                v-toolbar(color='indigo', flat, density="compact")
                  v-spacer
                  .text-body-large {{ $t('auth:registerTitle') }}
                  v-spacer
                v-card-text.text-center
                  h1.text-headline-large.text-indigo.py-2 {{ siteTitle }}
                  .text-body-medium {{ $t('auth:registerSubTitle') }}
                  v-text-field.mt-3(
                    variant="solo"
                    flat
                    prepend-icon='mdi-email'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-3` : `grey-lighten-4`'
                    hide-details
                    ref='iptEmail'
                    v-model='email'
                    :placeholder='$t("auth:fields.email")'
                    color='indigo'
                    )
                  v-text-field.mt-2(
                    variant="solo"
                    flat
                    prepend-icon='mdi-form-textbox-password'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-3` : `grey-lighten-4`'
                    ref='iptPassword'
                    v-model='password'
                    :append-icon='hidePassword ? "mdi-eye-off" : "mdi-eye"'
                    @click:append='() => (hidePassword = !hidePassword)'
                    :type='hidePassword ? "password" : "text"'
                    :placeholder='$t("auth:fields.password")'
                    color='indigo'
                    loading
                    counter='255'
                    )
                    template(v-slot:loader)
                      password-strength(v-model='password')
                  v-text-field.mt-2(
                    variant="solo"
                    flat
                    prepend-icon='mdi-form-textbox-password'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-3` : `grey-lighten-4`'
                    hide-details
                    ref='iptVerifyPassword'
                    v-model='verifyPassword'
                    @click:append='() => (hidePassword = !hidePassword)'
                    type='password'
                    :placeholder='$t("auth:fields.verifyPassword")'
                    color='indigo'
                  )
                  v-text-field.mt-2(
                    variant="solo"
                    flat
                    prepend-icon='mdi-account'
                    :bg-color='$vuetify.theme.current.dark ? `grey-darken-3` : `grey-lighten-4`'
                    ref='iptName'
                    v-model='name'
                    :placeholder='$t("auth:fields.name")'
                    @keyup.enter='register'
                    color='indigo'
                    counter='255'
                    )
                v-card-actions.pb-4
                  v-spacer
                  v-btn(
                    width='100%'
                    max-width='250px'
                    size="large"
                    color='indigo'
                    @click='register'
                    rounded
                    :loading='isLoading'
                    ) {{ $t('auth:actions.register') }}
                  v-spacer
                v-divider
                v-card-actions.py-3(:class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-4`')
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
    background-color: mc('indigo', '900');
    background-image: url('../static/svg/motif-blocks.svg');
    background-repeat: repeat;
    background-size: 200px;
    width: 100%;
    height: 100%;
    animation: loginBgReveal 20s linear infinite;

    @include keyframes(loginBgReveal) {
      0% {
        background-position-x: 0;
      }
      100% {
        background-position-x: 800px;
      }
    }

    &::before {
      content: '';
      position: absolute;
      background-image: url('../static/svg/motif-overlay.svg');
      background-attachment: fixed;
      background-size: cover;
      opacity: .5;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh;
    }

    > .container {
      height: 100%;
      align-items: center;
      display: flex;
    }

    .v-text-field.centered input {
      text-align: center;
    }
  }
</style>

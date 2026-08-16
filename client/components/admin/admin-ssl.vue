<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-validation.svg', alt='SSL', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:ssl.title') }}
            .text-body-large.text-grey.animated.fadeInLeft {{ $t('admin:ssl.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown(
            v-if='info.sslProvider === `letsencrypt` && info.httpsPort > 0'
            color='black'
            variant="flat"
            @click='renewCertificate'
            size="large"
            :loading='loadingRenew'
            )
            v-icon(start) mdi-cached
            span {{$t('admin:ssl.renewCertificate')}}
        v-form.pt-3
          v-row
            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp
                v-list-subheader {{ $t('admin:ssl.currentState') }}
                v-list(lines="two", density="compact")
                  v-list-item
                    template(v-slot:prepend)
                      v-avatar
                        v-icon.bg-indigo.text-white mdi-handshake
                    v-list-item-title {{ $t(`admin:ssl.provider`) }}
                    v-list-item-subtitle {{ providerTitle }}
                  template(v-if='info.sslProvider === `letsencrypt` && info.httpsPort > 0')
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-indigo.text-white mdi-application
                      v-list-item-title {{ $t(`admin:ssl.domain`) }}
                      v-list-item-subtitle {{ info.sslDomain }}
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-indigo.text-white mdi-at
                      v-list-item-title {{ $t('admin:ssl.subscriberEmail') }}
                      v-list-item-subtitle {{ info.sslSubscriberEmail }}
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-indigo.text-white mdi-calendar-remove-outline
                      v-list-item-title {{ $t('admin:ssl.expiration') }}
                      v-list-item-subtitle {{ $helpers.formatMoment(info.sslExpirationDate, 'calendar') }}
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-indigo.text-white mdi-traffic-light
                      v-list-item-title {{ $t(`admin:ssl.status`) }}
                      v-list-item-subtitle {{ info.sslStatus }}

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p2s
                v-list-subheader {{ $t('admin:ssl.ports') }}
                v-list(lines="two", density="compact")
                  v-list-item
                    template(v-slot:prepend)
                      v-avatar
                        v-icon.bg-blue.text-white mdi-lock-open-variant
                    v-list-item-title {{ $t(`admin:ssl.httpPort`) }}
                    v-list-item-subtitle {{ info.httpPort }}
                  template(v-if='info.httpsPort > 0')
                    v-divider
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-green.text-white mdi-lock
                      v-list-item-title {{ $t(`admin:ssl.httpsPort`) }}
                      v-list-item-subtitle {{ info.httpsPort }}
                    v-divider
                    v-list-item
                      template(v-slot:prepend)
                        v-avatar
                          v-icon.bg-indigo.text-white mdi-sign-direction
                      v-list-item-title {{ $t(`admin:ssl.httpPortRedirect`) }}
                      v-list-item-subtitle {{ info.httpRedirection }}
                      template(v-slot:append)
                        v-btn.text-red(
                          v-if='info.httpRedirection'
                          variant="flat"
                          :color='$vuetify.theme.current.dark ? `red-darken-4` : `red-lighten-5`'
                          :class='$vuetify.theme.current.dark ? `text-red-lighten-5` : `text-red-darken-2`'
                          @click='toggleRedir'
                          :loading='loadingRedir'
                          )
                          v-icon(start) mdi-power
                          span {{$t('admin:ssl.httpPortRedirectTurnOff')}}
                        v-btn.text-green(
                          v-else
                          variant="flat"
                          :color='$vuetify.theme.current.dark ? `green-darken-4` : `green-lighten-5`'
                          :class='$vuetify.theme.current.dark ? `text-green-lighten-5` : `text-green-darken-2`'
                          @click='toggleRedir'
                          :loading='loadingRedir'
                          )
                          v-icon(start) mdi-power
                          span {{$t('admin:ssl.httpPortRedirectTurnOn')}}

    v-dialog(
      v-model='loadingRenew'
      persistent
      max-width='450'
      )
      v-card(color='black')
        v-card-text.pa-10.text-center
          semipolar-spinner.animated.fadeIn(
            :animation-duration='1500'
            :size='65'
            color='#FFF'
            style='margin: 0 auto;'
          )
          .mt-5.text-body-large.text-white {{$t('admin:ssl.renewCertificateLoadingTitle')}}
          .text-body-small.mt-4 {{$t('admin:ssl.renewCertificateLoadingSubtitle')}}
</template>

<script lang='ts'>
import _ from 'lodash'
import { SemipolarSpinner } from 'epic-spinners'
import { wikiStore } from '@/store/index.ts'
import { fetchSystemSsl, renewSystemSslCertificate, updateSystemSslRedirection } from '../../helpers/system-api'
import type { SystemSslInfo } from '../../helpers/system-api'
import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const makeDefaultSslInfo = (): SystemSslInfo => ({
  sslDomain: null,
  sslProvider: null,
  sslSubscriberEmail: null,
  sslExpirationDate: null,
  sslStatus: '',
  httpPort: 0,
  httpRedirection: false,
  httpsPort: 0
})

export default {
  components: {
    SemipolarSpinner
  },
  data() {
    return {
      loadingRenew: false,
      loadingRedir: false,
      info: makeDefaultSslInfo()
    }
  },
  created () {
    this.loadInfo().catch(() => {})
  },
  computed: {
    providerTitle () {
      switch (this.info.sslProvider) {
        case 'custom':
          return this.$t('admin:ssl.providerCustomCertificate')
        case 'letsencrypt':
          return this.$t('admin:ssl.providerLetsEncrypt')
        default:
          return this.$t('admin:ssl.providerDisabled')
      }
    }
  },
  methods: {
    async loadInfo ({ notifyError = true } = {}) {
      loadingStart(wikiStore, 'admin-ssl-refresh')
      try {
        this.info = await fetchSystemSsl(window.fetch.bind(window), 'SSL status response is invalid')
      } catch (err) {
        this.info = makeDefaultSslInfo()
        if (notifyError) {
          pushGraphError(wikiStore, err)
        }
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-ssl-refresh')
      }
    },
    async toggleRedir () {
      this.loadingRedir = true
      loadingStart(wikiStore, 'admin-ssl-toggleRedirection')
      try {
        this.info.httpRedirection = !this.info.httpRedirection
        await updateSystemSslRedirection(
          window.fetch.bind(window),
          _.get(this.info, 'httpRedirection', false)
        )
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('admin:ssl.httpPortRedirectSaveSuccess'),
          icon: 'check'
        })
      } catch (err) {
        this.info.httpRedirection = !this.info.httpRedirection
        pushGraphError(wikiStore, err)
      } finally {
        loadingStop(wikiStore, 'admin-ssl-toggleRedirection')
        this.loadingRedir = false
      }
    },
    async renewCertificate () {
      this.loadingRenew = true
      loadingStart(wikiStore, 'admin-ssl-renew')
      try {
        await renewSystemSslCertificate(window.fetch.bind(window))
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('admin:ssl.renewCertificateSuccess'),
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      } finally {
        loadingStop(wikiStore, 'admin-ssl-renew')
        this.loadingRenew = false
      }
    }
  }
}
</script>

<style lang='scss'>

</style>

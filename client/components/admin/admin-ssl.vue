<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:ssl.title`)'
          :description='$t(`admin:ssl.subtitle`)'
          icon='/_assets/svg/icon-validation.svg'
          heading-id='admin-ssl-heading'
        )
          template(v-slot:actions)
            v-btn(
              v-if='infoLoaded && info.sslProvider === `letsencrypt` && info.httpsPort > 0'
              color='primary'
              variant="outlined"
              @click='renewCertificate'
              size="small"
              :loading='loadingRenew'
              :disabled='loadingRedir || loading || !infoLoaded'
            )
              v-icon(start) mdi-cached
              span {{$t('admin:ssl.renewCertificate')}}
        async-state(
          v-if='loading'
          state='loading'
          title='Loading SSL status'
          message='Fetching certificate and port diagnostics.'
        )
        async-state(
          v-else-if='errorMessage'
          state='error'
          title='SSL status could not be loaded'
          :message='errorMessage'
          retry-label='Try again'
          @retry='loadInfo'
        )
        .pt-3(v-else-if='infoLoaded')
          v-row
            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp
                v-card-title.text-title-medium {{ $t('admin:ssl.currentState') }}
                v-list(lines="two", density="compact")
                  v-list-item
                    template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-handshake
                    v-list-item-title {{ $t(`admin:ssl.provider`) }}
                    v-list-item-subtitle {{ providerTitle }}
                  template(v-if='info.sslProvider === `letsencrypt` && info.httpsPort > 0')
                    v-list-item
                      template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-application
                      v-list-item-title {{ $t(`admin:ssl.domain`) }}
                      v-list-item-subtitle {{ info.sslDomain }}
                    v-list-item
                      template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-at
                      v-list-item-title {{ $t('admin:ssl.subscriberEmail') }}
                      v-list-item-subtitle {{ info.sslSubscriberEmail }}
                    v-list-item
                      template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-calendar-remove-outline
                      v-list-item-title {{ $t('admin:ssl.expiration') }}
                      v-list-item-subtitle
                        v-chip(size='small', variant='tonal', :color='expirationColor') {{ expirationLabel }}
                  v-list-item
                    template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-traffic-light
                    v-list-item-title {{ $t(`admin:ssl.status`) }}
                    v-list-item-subtitle
                      v-chip(size='small', variant='tonal', :color='sslStatusColor') {{ sslStatusLabel }}

            v-col(lg='6' cols='12')
              v-card.animated.fadeInUp.wait-p2s
                v-card-title.text-title-medium {{ $t('admin:ssl.ports') }}
                v-list(lines="two", density="compact")
                  v-list-item
                    template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-lock-open-variant
                    v-list-item-title {{ $t(`admin:ssl.httpPort`) }}
                    v-list-item-subtitle
                      v-chip(size='small', variant='tonal', :color='info.httpPort > 0 ? `success` : `grey`') {{ info.httpPort > 0 ? `Port ${info.httpPort}` : 'Unavailable' }}
                  v-divider
                  v-list-item
                    template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-lock
                    v-list-item-title {{ $t(`admin:ssl.httpsPort`) }}
                    v-list-item-subtitle
                      v-chip(size='small', variant='tonal', :color='info.httpsPort > 0 ? `success` : `grey`') {{ info.httpsPort > 0 ? `Port ${info.httpsPort}` : 'Disabled' }}
                  v-divider
                  v-list-item
                    template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-sign-direction
                    v-list-item-title {{ $t(`admin:ssl.httpPortRedirect`) }}
                    v-list-item-subtitle
                      v-chip(size='small', variant='tonal', :color='info.httpRedirection ? `success` : `grey`') {{ info.httpRedirection ? 'Enabled' : 'Disabled' }}
                v-card-actions.ssl-redirect-action
                  v-spacer
                  v-btn(
                    variant="outlined"
                    color='primary'
                    @click='toggleRedir'
                    :loading='loadingRedir'
                    :disabled='loadingRenew || loading || !infoLoaded'
                  )
                    v-icon(start) mdi-power
                    span {{info.httpRedirection ? $t('admin:ssl.httpPortRedirectTurnOff') : $t('admin:ssl.httpPortRedirectTurnOn')}}

        v-dialog(
          v-model='loadingRenew'
          persistent
          max-width='450'
          width='calc(100vw - 2rem)'
        )
          v-card
            v-card-text.pa-8.text-center
              v-progress-circular.animated.fadeIn(
                indeterminate
                color='primary'
                :size='56'
                :width='4'
                aria-label='Renewing certificate'
              )
              .mt-5.text-body-large {{$t('admin:ssl.renewCertificateLoadingTitle')}}
              .text-body-small.text-medium-emphasis.mt-4 {{$t('admin:ssl.renewCertificateLoadingSubtitle')}}</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { wikiStore } from '@/store/index.ts'
import { fetchSystemSsl, renewSystemSslCertificate, updateSystemSslRedirection } from '../../helpers/system-api'
import type { SystemSslInfo } from '../../helpers/system-api'
import { loadingStart, loadingStop, showNotification, pushGraphError, getErrorMessage } from '../../helpers/root-ui-store'

const createAbortableFetch = (signal: AbortSignal) => (
  input: RequestInfo | URL,
  init?: RequestInit
) => window.fetch(input, { ...init, signal })

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
    AsyncState
  },
  data() {
    return {
      loading: false,
      loadingRenew: false,
      loadingRedir: false,
      infoLoaded: false,
      errorMessage: '',
      info: makeDefaultSslInfo(),
      loadController: null as AbortController | null,
      redirectionController: null as AbortController | null,
      renewalController: null as AbortController | null,
      isUnmounted: false
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
    },
    sslStatusLabel () {
      return this.info.sslProvider ? (this.info.sslStatus || 'Unknown') : 'Disabled'
    },
    sslStatusColor () {
      if (!this.info.sslProvider) {
        return 'grey'
      }
      const status = this.info.sslStatus.toLowerCase()
      if (status.includes('error') || status.includes('fail') || status.includes('expired')) {
        return 'error'
      }
      if (status.includes('warn') || status.includes('expir')) {
        return 'warning'
      }
      if (status === 'ok' || status.includes('active') || status.includes('valid')) {
        return 'success'
      }
      return 'info'
    },
    expirationLabel () {
      return this.info.sslExpirationDate
        ? this.$helpers.formatMoment(this.info.sslExpirationDate, 'calendar')
        : 'Not available'
    },
    expirationColor () {
      if (!this.info.sslExpirationDate) {
        return 'grey'
      }
      const expiry = new Date(this.info.sslExpirationDate).getTime()
      const daysRemaining = (expiry - Date.now()) / 86400000
      if (daysRemaining < 0) {
        return 'error'
      }
      if (daysRemaining < 30) {
        return 'warning'
      }
      return 'success'
    }
  },
  methods: {
    async loadInfo ({ notifyError = true } = {}) {
      this.loadController?.abort()
      const controller = new AbortController()
      this.loadController = controller
      this.loading = true
      this.errorMessage = ''
      this.infoLoaded = false
      loadingStart(wikiStore, 'admin-ssl-refresh')
      try {
        const info = await fetchSystemSsl(
          createAbortableFetch(controller.signal),
          'SSL status response is invalid'
        )
        if (controller.signal.aborted) {
          return false
        }
        this.info = info
        this.infoLoaded = true
        return true
      } catch (err) {
        if (controller.signal.aborted) {
          return false
        }
        this.info = makeDefaultSslInfo()
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        if (notifyError) {
          pushGraphError(wikiStore, err)
        }
        throw err
      } finally {
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) {
            this.loading = false
          }
        }
        loadingStop(wikiStore, 'admin-ssl-refresh')
      }
    },
    async toggleRedir () {
      if (this.loadingRedir || this.loadingRenew || !this.infoLoaded) return
      const previousValue = this.info.httpRedirection
      const controller = new AbortController()
      this.redirectionController = controller
      this.loadingRedir = true
      loadingStart(wikiStore, 'admin-ssl-toggleRedirection')
      try {
        this.info.httpRedirection = !previousValue
        await updateSystemSslRedirection(
          createAbortableFetch(controller.signal),
          this.info.httpRedirection
        )
        if (controller.signal.aborted) {
          return
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('admin:ssl.httpPortRedirectSaveSuccess'),
          icon: 'check'
        })
      } catch (err) {
        if (controller.signal.aborted) {
          return
        }
        this.info.httpRedirection = previousValue
        pushGraphError(wikiStore, err)
      } finally {
        if (this.redirectionController === controller) {
          this.redirectionController = null
          if (!this.isUnmounted) {
            this.loadingRedir = false
          }
        }
        loadingStop(wikiStore, 'admin-ssl-toggleRedirection')
      }
    },
    async renewCertificate () {
      if (
        this.loadingRenew ||
        this.loadingRedir ||
        !this.infoLoaded ||
        this.info.sslProvider !== 'letsencrypt' ||
        this.info.httpsPort <= 0
      ) return
      const controller = new AbortController()
      this.renewalController = controller
      this.loadingRenew = true
      loadingStart(wikiStore, 'admin-ssl-renew')
      try {
        await renewSystemSslCertificate(createAbortableFetch(controller.signal))
        if (controller.signal.aborted) {
          return
        }
        showNotification(wikiStore, {
          style: 'success',
          message: this.$t('admin:ssl.renewCertificateSuccess'),
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          pushGraphError(wikiStore, err)
        }
      } finally {
        if (this.renewalController === controller) {
          this.renewalController = null
          if (!this.isUnmounted) {
            this.loadingRenew = false
          }
        }
        loadingStop(wikiStore, 'admin-ssl-renew')
      }
    }
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.loadController?.abort()
    this.redirectionController?.abort()
    this.renewalController?.abort()
  }
}
</script>

<style lang='scss'>


.ssl-redirect-action {
  flex-wrap: wrap;
  gap: .5rem;
}

@media (max-width: 599.98px) {
  .ssl-redirect-action .v-btn {
    width: 100%;
  }
}
</style>

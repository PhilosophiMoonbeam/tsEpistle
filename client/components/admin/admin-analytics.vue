<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-line-chart.svg', alt='Analytics', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:analytics.title') }}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{ $t('admin:analytics.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown.wait-p2s.mr-3(icon, variant="outlined", color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large")
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:analytics.providers')}}
          v-list(lines="two", density="compact").py-0
            template(v-for='(str, idx) in providers', :key='str.key')
              v-list-item(@click='selectedProvider = str.key', :disabled='!str.isAvailable')
                template(v-slot:prepend)
                  v-avatar(size='24')
                    v-icon(color='grey', v-if='!str.isAvailable') mdi-minus-box-outline
                    v-icon(color='primary', v-else-if='str.isEnabled', v-ripple, @click='str.isEnabled = false') mdi-checkbox-marked-outline
                    v-icon(color='grey', v-else, v-ripple, @click='str.isEnabled = true') mdi-checkbox-blank-outline
                v-list-item-title.text-body-medium(:class='!str.isAvailable ? `text-grey` : (selectedProvider === str.key ? `text-primary` : ``)') {{ str.title }}
                v-list-item-subtitle: .text-body-small(:class='!str.isAvailable ? `text-grey-lighten-1` : (selectedProvider === str.key ? `text-blue ` : ``)') {{ str.description }}
                template(v-slot:append)
                  v-avatar(v-if='selectedProvider === str.key', size='24')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < providers.length - 1')

      v-col(cols='12', lg='9')

        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{provider.title}}
            v-spacer
            v-switch(
              color="blue-lighten-5"
              label='Active'
              v-model='provider.isEnabled'
              hide-details
              inset
              )
          div.v-card-info(color='blue')
            div
              div {{provider.description}}
              span.text-body-small: a(:href='provider.website') {{provider.website}}
            v-spacer
            .admin-providerlogo
              img(:src='provider.logo', :alt='provider.title')
          v-card-text
            v-form
              .text-label-small.pb-5 {{$t('admin:analytics.providerConfiguration')}}
              .text-body-large.ml-3(v-if='!provider.config || provider.config.length < 1'): em {{$t('admin:analytics.providerNoConfiguration')}}
              template(v-else, v-for='cfg in provider.config', :key='cfg.key')
                v-select(
                  v-if='cfg.value.type === "string" && cfg.value.enum'
                  variant="outlined"
                  :items='cfg.value.enum'
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                )
                v-switch.mb-3(
                  v-else-if='cfg.value.type === "boolean"'
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  color='primary'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  inset
                  )
                v-textarea(
                  v-else-if='cfg.value.type === "string" && cfg.value.multiline'
                  variant="outlined"
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                  )
                v-text-field(
                  v-else
                  variant="outlined"
                  :label='cfg.value.title'
                  v-model='cfg.value.value'
                  prepend-icon='mdi-cog-box'
                  :hint='cfg.value.hint ? cfg.value.hint : ""'
                  persistent-hint
                  :class='cfg.value.hint ? "mb-2" : ""'
                  )
</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'

import { fetchAnalyticsProviders, saveAnalyticsProviders, type AnalyticsProvider } from '../../helpers/analytics-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      providers: [] as AnalyticsProvider[],
      selectedProvider: '',
      provider: {} as Partial<AnalyticsProvider>
    }
  },
  watch: {
    selectedProvider(newValue, oldValue) {
      this.provider = _.find(this.providers, ['key', newValue]) || {}
    },
    providers(newValue, oldValue) {
      this.selectedProvider = 'google'
    }
  },
  created() {
    this.loadProviders().catch(() => {})
  },
  methods: {
    async loadProviders({ notifyError = true }: { notifyError?: boolean } = {}) {
      loadingStart(wikiStore, 'admin-analytics-refresh')
      try {
        this.providers = await fetchAnalyticsProviders(window.fetch.bind(window), 'Analytics providers response is invalid')
        return true
      } catch (err) {
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err),
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-analytics-refresh')
      }
    },
    async refresh() {
      await this.loadProviders()
      showNotification(wikiStore, {
        message: this.$t('admin:analytics.refreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      loadingStart(wikiStore, 'admin-analytics-saveproviders')
      try {
        await saveAnalyticsProviders(window.fetch.bind(window), this.providers.map(str => _.pick(str, [
          'isEnabled',
          'key',
          'config'
        ])).map(str => ({...str, config: str.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))})), 'Analytics providers save response is invalid')
        await this.loadProviders({ notifyError: false })
        showNotification(wikiStore, {
          message: this.$t('admin:analytics.saveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      }
      loadingStop(wikiStore, 'admin-analytics-saveproviders')
    }
  }
}
</script>

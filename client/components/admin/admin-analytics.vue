<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-line-chart.svg', alt='', style='width: 80px;', width='80', height='80')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:analytics.title') }}
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p4s {{ $t('admin:analytics.subtitle') }}
          v-spacer
          v-btn.animated.fadeInDown.wait-p2s.mr-3(
            icon
            variant="outlined"
            color='grey'
            @click='refresh'
            :loading='refreshing'
            :disabled='refreshing || saving'
            aria-label='Refresh analytics providers'
          )
            v-icon mdi-refresh
          v-btn.animated.fadeInDown(
            color='success'
            @click='save'
            variant="flat"
            size="large"
            :loading='saving'
            :disabled='!canSave'
          )
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}
      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:analytics.providers')}}
          async-state(v-if='loading', state='loading', title='Loading analytics providers', message='Fetching available analytics integrations.')
          async-state(v-else-if='errorMessage', state='error', title='Analytics providers could not be loaded', :message='errorMessage', retry-label='Try again', @retry='loadProviders')
          async-state(v-else-if='providers.length < 1', state='empty', title='No analytics providers available', message='No analytics integration is configured.')
          template(v-else)
            v-list(lines="two", density="compact", role='listbox', aria-label='Analytics providers').py-0
              template(v-for='(str, idx) in providers', :key='str.key')
                v-list-item(@click='selectedProvider = str.key', :disabled='!str.isAvailable', :aria-selected='str.key === selectedProvider')
                  template(v-slot:prepend)
                    v-checkbox-btn(
                      v-if='str.isAvailable'
                      v-model='str.isEnabled'
                      color='primary'
                      :aria-label='`${str.title} active`'
                      @click.stop
                    )
                    v-icon(color='grey', v-else) mdi-minus-box-outline
                  v-list-item-title.text-body-medium(:class='!str.isAvailable ? `text-medium-emphasis` : (selectedProvider === str.key ? `text-primary` : ``)') {{ str.title }}
                  v-list-item-subtitle: .text-body-small {{ str.description }}
                  template(v-slot:append)
                    v-avatar(v-if='selectedProvider === str.key', size='24')
                      v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
                v-divider(v-if='idx < providers.length - 1')

      v-col(cols='12', lg='9')
        v-card.animated.fadeInUp.wait-p2s(v-if='!loading && !errorMessage && provider.key')
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{provider.title}}
            v-spacer
            v-switch(
              color="primary"
              label='Active'
              v-model='provider.isEnabled'
              hide-details
              inset
              :disabled='!provider.isAvailable || saving'
            )
          v-card-info(color='info')
            div
              div {{provider.description}}
              span.text-body-small: a(:href='provider.website', style='overflow-wrap:anywhere') {{provider.website}}
            v-spacer
            .admin-providerlogo
              img(:src='provider.logo', :alt='provider.title')
          v-card-text
            v-form
              .text-label-small.pb-5 {{$t('admin:analytics.providerConfiguration')}}
              .text-body-large.ml-3(v-if='!provider.isAvailable') Provider unavailable. Choose an available provider.
              .text-body-large.ml-3(v-else-if='!provider.config || provider.config.length < 1'): em {{$t('admin:analytics.providerNoConfiguration')}}
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
                  :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                  :disabled='!provider.isAvailable || saving'
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
                  :disabled='!provider.isAvailable || saving'
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
                  :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                  :disabled='!provider.isAvailable || saving'
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
                  :style='(cfg.value.maxWidth || 0) > 0 ? `max-width:` + cfg.value.maxWidth + `px;` : ``'
                  :disabled='!provider.isAvailable || saving'
                )
        async-state(v-else-if='!loading && !errorMessage && providers.length > 0', state='empty', title='Select an analytics provider', message='Choose an available provider to review its configuration.')
</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'
import { fetchAnalyticsProviders, saveAnalyticsProviders, type AnalyticsProvider } from '../../helpers/analytics-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

export default {
  components: {
    AsyncState
  },
  data() {
    return {
      providers: [] as AnalyticsProvider[],
      selectedProvider: '',
      provider: {} as Partial<AnalyticsProvider>,
      loading: false,
      errorMessage: '',
      refreshing: false,
      saving: false
    }
  },
  computed: {
    canSave (): boolean {
      return !this.loading && !this.refreshing && !this.saving && this.providers.length > 0 &&
        Boolean(_.find(this.providers, ['key', this.selectedProvider])?.isAvailable)
    }
  },
  watch: {
    selectedProvider(newValue: string) {
      this.provider = _.find(this.providers, ['key', newValue]) || {}
    },
    providers() {
      const selected = _.find(this.providers, provider => provider.isAvailable && provider.isEnabled) ||
        _.find(this.providers, 'isAvailable')
      this.selectedProvider = selected?.key || ''
    }
  },
  created() {
    this.loadProviders().catch(() => {})
  },
  methods: {
    async loadProviders({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.loading = true
      this.errorMessage = ''
      this.refreshing = notifyError
      loadingStart(wikiStore, 'admin-analytics-refresh')
      try {
        this.providers = await fetchAnalyticsProviders(window.fetch.bind(window), 'Analytics providers response is invalid')
        return true
      } catch (err) {
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        if (notifyError) {
          showNotification(wikiStore, {
            message: this.errorMessage,
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        this.loading = false
        this.refreshing = false
        loadingStop(wikiStore, 'admin-analytics-refresh')
      }
    },
    async refresh() {
      if (this.refreshing || this.saving) return
      try {
        await this.loadProviders()
      } catch {
        return
      }
      showNotification(wikiStore, {
        message: this.$t('admin:analytics.refreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      if (!this.canSave) return
      this.saving = true
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
      } finally {
        this.saving = false
        loadingStop(wikiStore, 'admin-analytics-saveproviders')
      }
    }
  }
}
</script>
<style lang='scss' scoped>
.admin-providerlogo {
  max-width: min(220px, 35vw);

  img {
    max-width: 100%;
    height: auto;
  }
}

@media (max-width: 599.98px) {
  .admin-providerlogo {
    max-width: 100%;
  }
}
</style>

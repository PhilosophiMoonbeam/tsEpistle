<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      h2.text-body-large.ma-0 {{ $t('admin:utilities.telemetryTitle') }}
    v-form(@submit.prevent='updateTelemetry')
      v-card-text
        h3.text-label-large.ma-0 What is telemetry?
        .text-body-medium.mt-3 Telemetry sends basic anonymized instance and host information to the configured GraphQL endpoint. #[br] It is optional, disabled by default, and never includes wiki content or personal data.
        .text-body-medium.mt-3 For maximum privacy, a random client ID is generated during setup. This ID is used to group requests together while keeping complete anonymity. You can reset and generate a new one below at any time.
        v-divider.my-4
        h3.text-label-large.ma-0 What is collected?
        .text-body-medium.mt-3 When telemetry is enabled, only the following data is transmitted:
        v-list
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-information-outline
            v-list-item-title.text-body-medium Installed tsEpistle version
            v-list-item-subtitle.text-body-small: em e.g. v0.1.0
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-information-outline
            v-list-item-title.text-body-medium Basic OS information
            v-list-item-subtitle.text-body-small: em Platform (Linux, macOS or Windows), total CPU cores and PostgreSQL version
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-information-outline
            v-list-item-title.text-body-medium Crash debug data
            v-list-item-subtitle.text-body-small: em Stack trace of the error
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-information-outline
            v-list-item-title.text-body-medium Setup analytics
            v-list-item-subtitle.text-body-small: em Installation checkpoint reached
        .text-body-medium Note that crash debug data is stored for a maximum of 30 days while analytics are stored for a maximum of 16 months, after which it is permanently deleted.
        v-divider.my-4
        h3.text-label-large.ma-0 What is it used for?
        .text-body-medium.mt-3 Telemetry can help maintainers understand deployment health and prioritize compatibility work:
        v-list(density="compact")
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-chevron-right
            v-list-item-title: .text-body-medium Identify critical bugs more easily and fix them in a timely manner.
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-chevron-right
            v-list-item-title: .text-body-medium Understand the upgrade rate of current installations.
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-chevron-right
            v-list-item-title: .text-body-medium  Optimize performance and testing scenarios based on most popular environments.
        .text-body-medium Only enable telemetry when you trust the configured GraphQL endpoint and its data-retention policy.
        v-divider.my-4
        h3.text-label-large.ma-0 Settings
        async-state(
          v-if='!loaded && !loadError'
          state='loading'
          title='Loading telemetry settings'
          message='Fetching current telemetry settings.'
        )
        .mt-3
          v-switch.mt-0(
            v-model='telemetry',
            label='Enable Telemetry',
            color='primary',
            hint='Allow tsEpistle to transmit telemetry data to the configured GraphQL endpoint.',
            persistent-hint
            :disabled='!loaded || loading'
          )
        async-state(
          v-if='loadError'
          state='error'
          title='Telemetry settings could not be loaded'
          :message='loadError'
          retry-label='Try again'
          @retry='retryLoadTelemetry'
        )
        v-divider.my-4
        h3.text-label-large.mt-3.mb-0 Client ID
        .d-flex.align-center.ga-2.mt-2
          code.telemetry-client-id {{ clientId }}
          v-btn(
            type='button'
            size='small'
            variant='outlined'
            color='primary'
            :disabled='!loaded || loading || clientId === "N/A"'
            @click='copyClientId'
            aria-label='Copy telemetry client ID'
          )
            v-icon(start, aria-hidden='true') mdi-content-copy
            span Copy
        .text-body-small.text-medium-emphasis.mt-2 This identifier groups telemetry requests and can be reset to generate a new one.
      v-card-chin.admin-dialog-actions
        v-btn.px-3(type='submit', variant="flat", color='primary', :loading='loading && activeMutation === `save`', :disabled='!loaded || loading')
          v-icon(start, aria-hidden='true') mdi-content-save
          | Save Changes
        v-spacer
        v-btn.px-3(type='button', variant="outlined", color='warning', @click='resetDialog = true', :loading='loading && activeMutation === `reset`', :disabled='!loaded || loading')
          v-icon(start, aria-hidden='true') mdi-autorenew
          span Reset Client ID
    v-dialog(v-model='resetDialog', max-width='500', persistent, aria-labelledby='telemetry-reset-dialog-title')
      v-card
        v-card-title#telemetry-reset-dialog-title Reset telemetry client ID?
        v-card-text Resetting breaks continuity with prior telemetry and cannot be undone. A new anonymous identifier will be generated.
        v-card-actions
          v-spacer
          v-btn(type='button', variant='text', :disabled='loading', @click='resetDialog = false') {{ $t('common:actions.cancel') }}
          v-btn(type='button', color='warning', variant='flat', :loading='loading && activeMutation === `reset`', :disabled='loading', @click='resetClientId') Reset Client ID
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { fetchSystemTelemetry, resetSystemTelemetryClientId, updateSystemTelemetry } from '../../helpers/system-api'
import { wikiStore } from '@/store/index.ts'

export default defineComponent({
  data() {
    return {
      loading: false,
      loaded: false,
      loadError: '',
      activeMutation: '' as '' | 'save' | 'reset',
      telemetry: false,
      clientId: 'N/A',
      resetDialog: false,
      isDisposed: false
    }
  },
  beforeUnmount () {
    this.isDisposed = true
  },
  methods: {
    async loadTelemetry({ notifyError = true } = {}) {
      if (this.isDisposed) {
        return
      }
      this.loaded = false
      this.loadError = ''
      wikiStore.startLoading('admin-utilities-telemetry-refresh')

      try {
        const telemetryState = await fetchSystemTelemetry(window.fetch.bind(window))
        if (this.isDisposed) {
          return
        }
        this.telemetry = telemetryState.telemetry
        this.clientId = telemetryState.telemetryClientId || 'N/A'
        this.loaded = true
      } catch (err) {
        if (this.isDisposed) {
          return
        }
        this.loadError = err instanceof Error ? err.message : String(err)
        if (notifyError) {
          wikiStore.showError(err)
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-refresh')
      }
    },
    retryLoadTelemetry () {
      this.loadTelemetry().catch(() => {})
    },
    async updateTelemetry() {
      if (!this.loaded || this.loading) {
        return
      }
      this.loading = true
      this.activeMutation = 'save'
      wikiStore.startLoading('admin-utilities-telemetry-set')

      try {
        await updateSystemTelemetry(window.fetch.bind(window), this.telemetry)
        if (this.isDisposed) {
          return
        }
        wikiStore.showNotification({
          message: 'Telemetry updated successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!this.isDisposed) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-set')
        if (!this.isDisposed) {
          this.loading = false
          this.activeMutation = ''
        }
      }
    },
    async resetClientId() {
      if (!this.loaded || this.loading) {
        return
      }
      this.resetDialog = false
      this.loading = true
      this.activeMutation = 'reset'
      wikiStore.startLoading('admin-utilities-telemetry-resetid')

      try {
        await resetSystemTelemetryClientId(window.fetch.bind(window))
        if (this.isDisposed) {
          return
        }
        await this.loadTelemetry({ notifyError: false })
        if (this.isDisposed) {
          return
        }
        wikiStore.showNotification({
          message: 'Telemetry Client ID reset successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!this.isDisposed) {
          wikiStore.showError(err)
        }
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-resetid')
        if (!this.isDisposed) {
          this.loading = false
          this.activeMutation = ''
        }
      }
    },
    async copyClientId() {
      try {
        await navigator.clipboard.writeText(this.clientId)
        if (this.isDisposed) {
          return
        }
        wikiStore.showNotification({
          message: 'Telemetry Client ID copied.',
          style: 'success',
          icon: 'content-copy'
        })
      } catch (err) {
        if (!this.isDisposed) {
          wikiStore.showError(err)
        }
      }
    },
  },
  created () {
    this.loadTelemetry().catch(() => {})
  }
})
</script>

<style lang='scss'>
.telemetry-client-id {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: text;
}

.admin-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
}
</style>

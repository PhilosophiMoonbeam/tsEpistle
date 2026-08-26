<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.telemetryTitle') }}
    v-form
      v-card-text
        .text-label-large What is telemetry?
        .text-body-medium.mt-3 Telemetry sends basic anonymized instance and host information to the configured GraphQL endpoint. #[br] It is optional, disabled by default, and never includes wiki content or personal data.
        .text-body-medium.mt-3 For maximum privacy, a random client ID is generated during setup. This ID is used to group requests together while keeping complete anonymity. You can reset and generate a new one below at any time.
        v-divider.my-4
        .text-label-large What is collected?
        .text-body-medium.mt-3 When telemetry is enabled, only the following data is transmitted:
        v-list
          v-list-item
            template(v-slot:prepend)
              v-avatar: v-icon mdi-information-outline
            v-list-item-title.text-body-medium Installed tsFranki version
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
        .text-label-large What is it used for?
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
        .text-label-large Settings
        .mt-3
          v-switch.mt-0(
            v-model='telemetry',
            label='Enable Telemetry',
            color='primary',
            hint='Allow tsFranki to transmit telemetry data to the configured GraphQL endpoint.',
            persistent-hint
          )
        v-divider.my-4
        .text-label-large.mt-3.text-grey-darken-1 Client ID
        .text-body-medium.mt-2 {{clientId}}
      div.v-card-chin
        v-btn.px-3(variant="flat", color='success', @click='updateTelemetry')
          v-icon(start) mdi-chevron-right
          | Save Changes
        v-spacer
        v-btn.px-3(variant="outlined", color='grey', @click='resetClientId')
          v-icon(start) mdi-autorenew
          span Reset Client ID
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { fetchSystemTelemetry, resetSystemTelemetryClientId, updateSystemTelemetry } from '../../helpers/system-api'
import { wikiStore } from '@/store/index.ts'

export default defineComponent({
  data() {
    return {
      loading: false,
      telemetry: false,
      clientId: 'N/A'
    }
  },
  methods: {
    async loadTelemetry({ notifyError = true } = {}) {
      wikiStore.startLoading('admin-utilities-telemetry-refresh')

      try {
        const telemetryState = await fetchSystemTelemetry(window.fetch.bind(window))
        this.telemetry = telemetryState.telemetry
        this.clientId = telemetryState.telemetryClientId || 'N/A'
      } catch (err) {
        if (notifyError) {
          wikiStore.showError(err)
        }
        throw err
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-refresh')
      }
    },
    async updateTelemetry() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-telemetry-set')

      try {
        await updateSystemTelemetry(window.fetch.bind(window), this.telemetry)
        wikiStore.showNotification({
          message: 'Telemetry updated successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-set')
        this.loading = false
      }
    },
    async resetClientId() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-telemetry-resetid')

      try {
        await resetSystemTelemetryClientId(window.fetch.bind(window))
        await this.loadTelemetry({ notifyError: false })
        wikiStore.showNotification({
          message: 'Telemetry Client ID reset successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-utilities-telemetry-resetid')
        this.loading = false
      }
    }
  },
  created () {
    this.loadTelemetry().catch(() => {})
  }
})
</script>

<style lang='scss'>

</style>

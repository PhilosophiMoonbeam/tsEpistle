<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          title='Logging'
          description='Configure system loggers and inspect the live trail'
          icon='/_assets/svg/icon-registry-editor.svg'
        )
          template(v-slot:actions)
            .admin-logging-actions
              v-btn(variant="outlined", color='primary', @click='refresh', size="small", :loading='loading', :disabled='saving')
                v-icon(start) mdi-refresh
                span Refresh
              v-btn(variant="tonal", color='primary', @click='toggleConsole', size="small")
                v-icon(start) mdi-console
                span Live Trail
              v-btn(color='success', @click='save', variant="flat", size="small", :disabled='!loggersLoaded || loading', :loading='saving')
                v-icon(start) mdi-check
                span {{$t('common:actions.apply')}}
        v-card.mt-3
          v-tabs(v-model='tab', color='primary', show-arrows)
            v-tab(value='settings')
              v-icon(start) mdi-cog
              span Settings
            v-tab(v-for='logger in activeLoggers', :key='logger.key', :value='logger.key') {{ logger.title }}

          v-tabs-window(v-model='tab')
            v-tabs-window-item(value='settings', :transition='false', :reverse-transition='false')
              async-state(
                v-if='loading'
                state='loading'
                title='Loading logging services'
                message='Fetching the available logger configuration.'
              )
              async-state(
                v-else-if='errorMessage'
                state='error'
                title='Logging services could not be loaded'
                :message='errorMessage'
                retry-label='Try again'
                @retry='retryLoad'
              )
              async-state(
                v-else-if='loggers.length === 0'
                state='empty'
                title='No logging services available'
                message='There are no logger integrations configured for this installation.'
              )
              v-card.pa-3(flat, rounded='0', v-else)
                .text-body-medium.text-grey-darken-1 Select which logging service to enable:
                .text-body-small.text-grey.pb-2 Some loggers require additional configuration in their dedicated tab (when selected).
                div(role='group', aria-label='Logging services')
                  v-checkbox.my-0(
                    v-for='logger in loggers'
                    v-model='logger.isEnabled'
                    :key='logger.key'
                    :label='logger.title'
                    color='primary'
                    :disabled='saving'
                    hide-details
                  )

            v-tabs-window-item(v-for='logger in activeLoggers', :key='logger.key', :value='logger.key', :transition='false', :reverse-transition='false')
              v-card.wiki-form.pa-3(flat, rounded='0')
                div(role='group', :aria-label='`${logger.title} configuration`')
                  .logger-provider-info
                    .loggerlogo
                      img(:src='logger.logo', :alt='logger.title')
                    .logger-provider-copy
                      .text-title-medium {{logger.title}}
                      .text-body-small {{logger.description}}
                      .text-body-small: a(:href='logger.website') {{logger.website}}
                  v-divider.mt-3
                  .text-title-small.font-weight-medium.mt-3 Configuration
                  .text-body-large.ml-3(v-if='!logger.config || logger.config.length < 1') This logger has no configuration options you can modify.
                  template(v-else, v-for='cfg in logger.config', :key='cfg.key')
                    v-select(
                      v-if='cfg.value.type === "string" && cfg.value.enum'
                      variant="outlined"
                      :items='cfg.value.enum'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :class='cfg.value.hint ? "mb-2" : ""'
                      :disabled='saving'
                    )
                    v-switch(
                      v-else-if='cfg.value.type === "boolean"'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      color='primary'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :disabled='saving'
                      )
                    v-text-field(
                      v-else
                      variant="outlined"
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :class='cfg.value.hint ? "mb-2" : ""'
                      :disabled='saving'
                      )
                  v-divider.mt-3
                  .text-title-small.font-weight-medium.mt-3 Log Level
                  .text-body-large.ml-3 Select the minimum error level that will be reported to this logger.
                  v-row
                    v-col(cols='12', md='6', lg='4')
                      .pt-3
                        v-select(
                          single-line
                          variant="outlined"
                          :items='levels'
                          item-title='title'
                          item-value='value'
                          label='Level'
                          v-model='logger.level'
                          hint='Default: warn'
                          persistent-hint
                          :disabled='saving'
                        )
    logging-console(v-model='showConsole')
</template>


<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'

import LoggingConsole from './admin-logging-console.vue'

import { fetchLoggingLoggers, saveLoggingLoggers, type Logger } from '../../helpers/logging-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

const createAbortableFetch = (signal: AbortSignal) => (
  url: string,
  options: Record<string, unknown>
) => window.fetch(url, { ...options, signal } as RequestInit)

export default {
  components: {
    LoggingConsole,
    AsyncState
  },
  data() {
    return {
      tab: 'settings',
      showConsole: false,
      loggers: [] as Logger[],
      levels: [
        { title: 'Error', value: 'error' },
        { title: 'Warn', value: 'warn' },
        { title: 'Info', value: 'info' },
        { title: 'Debug', value: 'debug' },
        { title: 'Verbose', value: 'verbose' }
      ],
      loading: false,
      saving: false,
      loggersLoaded: false,
      errorMessage: '',
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      isUnmounted: false
    }
  },
  computed: {
    activeLoggers() {
      return this.loggers.filter(logger => logger.isEnabled)
    }
  },
  watch: {
    activeLoggers(activeLoggers: Logger[]) {
      if (this.tab !== 'settings' && !activeLoggers.some(logger => logger.key === this.tab)) {
        this.tab = 'settings'
      }
    }
  },
  created() {
    this.loadLoggers().catch(() => {})
  },
  methods: {
    async loadLoggers({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.loadController?.abort()
      const controller = new AbortController()
      this.loadController = controller
      this.loading = true
      this.errorMessage = ''
      this.loggersLoaded = false
      this.loggers = []
      wikiStore.startLoading('admin-logging-refresh')
      try {
        const loggers = await fetchLoggingLoggers(
          createAbortableFetch(controller.signal),
          'Logging loggers response is invalid'
        )
        if (controller.signal.aborted) {
          return false
        }
        this.loggers = loggers
        this.loggersLoaded = true
        return true
      } catch (err) {
        if (controller.signal.aborted) {
          return false
        }
        this.errorMessage = getErrorMessage(err)
        if (notifyError) {
          wikiStore.showNotification({
            message: getErrorMessage(err),
            style: 'red',
            icon: 'warning'
          })
        }
        throw err
      } finally {
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) {
            this.loading = false
          }
        }
        wikiStore.stopLoading('admin-logging-refresh')
      }
    },
    async retryLoad() {
      await this.loadLoggers().catch(() => {})
    },
    async refresh() {
      if (this.loading || this.saving) return
      try {
        const loaded = await this.loadLoggers()
        if (!loaded) return
        wikiStore.showNotification({
          message: 'List of loggers has been refreshed.',
          style: 'success',
          icon: 'cached'
        })
      } catch {
        // loadLoggers reports the request error.
      }
    },
    async save() {
      if (this.saving || this.loading || !this.loggersLoaded) return
      const controller = new AbortController()
      this.saveController = controller
      this.saving = true
      wikiStore.startLoading('admin-logging-saveloggers')
      try {
        await saveLoggingLoggers(createAbortableFetch(controller.signal), this.loggers.map(tgt => ({
          isEnabled: tgt.isEnabled,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })})),
          level: tgt.level
        })), 'Logging loggers update failed')
        if (controller.signal.aborted) {
          return
        }
        const loaded = await this.loadLoggers({ notifyError: false })
        if (!loaded || controller.signal.aborted) {
          return
        }
        wikiStore.showNotification({
          message: 'Logging configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          wikiStore.showError(err)
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) {
            this.saving = false
          }
        }
        wikiStore.stopLoading('admin-logging-saveloggers')
      }
    },
    toggleConsole() {
      this.showConsole = !this.showConsole
    }
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
  }
}
</script>

<style lang='scss' scoped>
.admin-logging-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .5rem;
}

.logger-provider-info {
  display: flex;
  align-items: center;
  gap: 1rem;
  min-width: 0;
}

.logger-provider-copy {
  min-width: 0;
}

.logger-provider-copy > * {
  overflow-wrap: anywhere;
}

.loggerlogo {
  display: flex;
  flex: 0 0 8rem;
  align-items: center;
  justify-content: center;
  min-width: 0;

  img {
    max-width: 100%;
    max-height: 4rem;
    object-fit: contain;
  }
}

@media (max-width: 599.98px) {
  .admin-logging-actions {
    flex: 1 1 100%;
  }

  .admin-logging-actions .v-btn {
    flex: 1 1 auto;
  }

  .logger-provider-info {
    align-items: flex-start;
    flex-direction: column;
  }

  .loggerlogo {
    flex-basis: auto;
    justify-content: flex-start;
  }
}

</style>

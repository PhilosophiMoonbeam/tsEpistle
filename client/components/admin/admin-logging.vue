<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-registry-editor.svg', alt='Logging', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary Logging
            .text-body-large.text-grey Configure system loggers and inspect the live trail
          v-spacer
          .admin-header-actions
            v-btn(variant="outlined", color='primary', @click='refresh', size="small", :loading='loading')
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
              v-icon(start) settings
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
                @retry='loadLoggers'
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
                v-form
                  v-checkbox.my-0(
                    v-for='logger in loggers'
                    v-model='logger.isEnabled'
                    :key='logger.key'
                    :label='logger.title'
                    color='primary'
                    hide-details
                  )

            v-tabs-window-item(v-for='logger in activeLoggers', :key='logger.key', :value='logger.key', :transition='false', :reverse-transition='false')
              v-card.wiki-form.pa-3(flat, rounded='0')
                v-form
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
                  template(v-else, v-for='cfg in logger.config')
                    v-select(
                      v-if='cfg.value.type === "string" && cfg.value.enum'
                      variant="outlined"
                      :items='cfg.value.enum'
                      :key='cfg.key'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :class='cfg.value.hint ? "mb-2" : ""'
                    )
                    v-switch(
                      v-else-if='cfg.value.type === "boolean"'
                      :key='cfg.key'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      color='primary'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      )
                    v-text-field(
                      v-else
                      variant="outlined"
                      :key='cfg.key'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :class='cfg.value.hint ? "mb-2" : ""'
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
                        )
    logging-console(v-model='showConsole')
</template>


<script lang='ts'>
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'

import LoggingConsole from './admin-logging-console.vue'

import { fetchLoggingLoggers, saveLoggingLoggers, type Logger } from '../../helpers/logging-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

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
      errorMessage: ''
    }
  },
  computed: {
    activeLoggers() {
      return _.filter(this.loggers, 'isEnabled')
    }
  },
  created() {
    this.loadLoggers().catch(() => {})
  },
  methods: {
    async loadLoggers({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.loading = true
      this.errorMessage = ''
      this.loggersLoaded = false
      this.loggers = []
      wikiStore.startLoading('admin-logging-refresh')
      try {
        this.loggers = await fetchLoggingLoggers(window.fetch.bind(window), 'Logging loggers response is invalid')
        this.loggersLoaded = true
        return true
      } catch (err) {
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
        this.loading = false
        wikiStore.stopLoading('admin-logging-refresh')
      }
    },
    async refresh() {
      await this.loadLoggers()
      wikiStore.showNotification({
        message: 'List of loggers has been refreshed.',
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      this.saving = true
      wikiStore.startLoading('admin-logging-saveloggers')
      try {
        await saveLoggingLoggers(window.fetch.bind(window), this.loggers.map(tgt => _.pick(tgt, [
          'isEnabled',
          'key',
          'config',
          'level'
        ])).map(str => ({...str, config: str.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))})), 'Logging loggers update failed')
        await this.loadLoggers({ notifyError: false })
        wikiStore.showNotification({
          message: 'Logging configuration saved successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.saving = false
        wikiStore.stopLoading('admin-logging-saveloggers')
      }
    },
    toggleConsole() {
      this.showConsole = !this.showConsole
    }
  }
}
</script>

<style lang='scss' scoped>
.admin-header-actions {
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
  .admin-header-actions {
    flex: 1 1 100%;
  }

  .admin-header-actions .v-btn {
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

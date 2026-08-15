<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-registry-editor.svg', alt='Logging', style='width: 80px;')
          .admin-header-title
            .headline.primary--text Logging
            .subtitle-1.grey--text Configure system loggers and inspect the live trail
          v-spacer
          v-btn(outline, color='grey', @click='refresh', large)
            v-icon refresh
          v-btn(color='black', depressed, @click='toggleConsole', large)
            v-icon check
            span Live Trail
          v-btn(color='success', @click='save', depressed, large)
            v-icon(left) check
            span {{$t('common:actions.apply')}}

        v-card.mt-3
          v-tabs.text-white(v-model='tab', bg-color='grey-darken-2', color='white', fixed-tabs, slider-color='white', show-arrows)
            v-tab(value='settings'): v-icon settings
            v-tab(v-for='logger in activeLoggers', :key='logger.key', :value='logger.key') {{ logger.title }}

          v-tabs-window(v-model='tab')
            v-tabs-window-item(value='settings', :transition='false', :reverse-transition='false')
              v-card.pa-3(flat, tile)
                .body-2.grey--text.text--darken-1 Select which logging service to enable:
                .caption.grey--text.pb-2 Some loggers require additional configuration in their dedicated tab (when selected).
                v-form
                  v-checkbox.my-0(
                    v-for='(logger, n) in loggers'
                    v-model='logger.isEnabled'
                    :key='logger.key'
                    :label='logger.title'
                    color='primary'
                    hide-details
                  )

            v-tabs-window-item(v-for='logger in activeLoggers', :key='logger.key', :value='logger.key', :transition='false', :reverse-transition='false')
              v-card.wiki-form.pa-3(flat, tile)
                v-form
                  .loggerlogo
                    img(:src='logger.logo', :alt='logger.title')
                  v-list-subheader.pl-0 {{logger.title}}
                  .caption {{logger.description}}
                  .caption: a(:href='logger.website') {{logger.website}}
                  v-divider.mt-3
                  v-list-subheader.pl-0 Logger Configuration
                  .body-1.ml-3(v-if='!logger.config || logger.config.length < 1') This logger has no configuration options you can modify.
                  template(v-else, v-for='cfg in logger.config')
                    v-select(
                      v-if='cfg.value.type === "string" && cfg.value.enum'
                      outline
                      background-color='grey lighten-2'
                      :items='cfg.value.enum'
                      :key='cfg.key'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      prepend-icon='settings_applications'
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
                      prepend-icon='settings_applications'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      )
                    v-text-field(
                      v-else
                      outline
                      background-color='grey lighten-2'
                      :key='cfg.key'
                      :label='cfg.value.title'
                      v-model='cfg.value.value'
                      prepend-icon='settings_applications'
                      :hint='cfg.value.hint ? cfg.value.hint : ""'
                      persistent-hint
                      :class='cfg.value.hint ? "mb-2" : ""'
                      )
                  v-divider.mt-3
                  v-list-subheader.pl-0 Log Level
                  .body-1.ml-3 Select the minimum error level that will be reported to this logger.
                  v-row
                    v-col(cols='12', md='6', lg='4')
                      .pt-3
                        v-select(
                          single-line
                          outline
                          background-color='grey lighten-2'
                          :items='levels'
                          label='Level'
                          v-model='logger.level'
                          prepend-icon='graphic_eq'
                          hint='Default: warn'
                          persistent-hint
                        )

    logging-console(v-model='showConsole')
</template>

<script lang='ts'>
import _ from 'lodash'

import LoggingConsole from './admin-logging-console.vue'

import { fetchLoggingLoggers, saveLoggingLoggers, type Logger } from '../../helpers/logging-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  components: {
    LoggingConsole
  },
  data() {
    return {
      tab: 'settings',
      showConsole: false,
      loggers: [] as Logger[],
      levels: ['error', 'warn', 'info', 'debug', 'verbose']
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
      wikiStore.startLoading('admin-logging-refresh')
      try {
        this.loggers = await fetchLoggingLoggers(window.fetch.bind(window), 'Logging loggers response is invalid')
        return true
      } catch (err) {
        if (notifyError) {
          wikiStore.showNotification({
            message: getErrorMessage(err),
            style: 'red',
            icon: 'warning'
          })
        }
        throw err
      } finally {
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
      }
      wikiStore.stopLoading('admin-logging-saveloggers')
    },
    toggleConsole() {
      this.showConsole = !this.showConsole
    }
  }
}
</script>

<style lang='scss' scoped>

.loggerlogo {
  width: 250px;
  height: 85px;
  float:right;
  display: flex;
  justify-content: flex-end;
  align-items: center;

  img {
    max-width: 100%;
    max-height: 50px;
  }
}

</style>

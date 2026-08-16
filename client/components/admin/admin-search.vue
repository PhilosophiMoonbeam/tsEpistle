<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-search.svg', alt='Search Engine', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:search.title')}}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p2s {{$t('admin:search.subtitle')}}
          v-spacer
          v-btn.mr-3.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/search', target='_blank')
            v-icon mdi-help-circle
          v-btn.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh')
            v-icon mdi-refresh
          v-btn.mx-3.animated.fadeInDown.wait-p1s(color='black', variant="flat", @click='rebuild')
            v-icon(start) mdi-cached
            span {{$t('admin:search.rebuildIndex')}}
          v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large")
            v-icon(start) mdi-check
            span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large {{$t('admin:search.searchEngine')}}
          v-list.py-0(lines="two", density="compact")
            template(v-for='(eng, idx) in engines', :key='eng.key')
              v-list-item(@click='selectedEngine = eng.key', :disabled='!eng.isAvailable')
                template(v-slot:prepend)
                  v-avatar(size='24')
                    v-icon(color='grey', v-if='!eng.isAvailable') mdi-minus-box-outline
                    v-icon(color='primary', v-else-if='eng.key === selectedEngine') mdi-checkbox-marked-circle-outline
                    v-icon(color='grey', v-else) mdi-checkbox-blank-circle-outline
                v-list-item-title.text-body-medium(:class='!eng.isAvailable ? `text-grey` : (selectedEngine === eng.key ? `text-primary` : ``)') {{ eng.title }}
                v-list-item-subtitle: .text-body-small(:class='!eng.isAvailable ? `text-grey-lighten-1` : (selectedEngine === eng.key ? `text-blue ` : ``)') {{ eng.description }}
                template(v-slot:append)
                  v-avatar(v-if='selectedEngine === eng.key', size='24')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < engines.length - 1')

      v-col(lg='9', cols='12')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{engine.title}}
          div.v-card-info(color='blue')
            div
              div {{engine.description}}
              span.text-body-small: a(:href='engine.website') {{engine.website}}
            v-spacer
            .admin-providerlogo
              img(:src='engine.logo', :alt='engine.title')
          v-card-text
            .text-label-small.mb-5 {{$t('admin:search.engineConfig')}}
            .text-body-medium.ml-3(v-if='!engine.config || engine.config.length < 1'): em {{$t('admin:search.engineNoConfig')}}
            template(v-else, v-for='cfg in engine.config', :key='cfg.key')
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
                )</template>

<script lang='ts'>
import _ from 'lodash'
import { wikiStore } from '@/store/index.ts'

import { fetchSearchEngines, rebuildSearchIndex, saveSearchEngines, type SearchEngine } from '../../helpers/search-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const createEmptySearchEngine = (): SearchEngine => ({
  isEnabled: false,
  key: '',
  title: '',
  description: '',
  logo: '',
  website: '',
  isAvailable: false,
  config: []
})

export default {
  data() {
    return {
      engines: [] as SearchEngine[],
      selectedEngine: '',
      engine: createEmptySearchEngine()
    }
  },
  watch: {
    selectedEngine(newValue: string) {
      this.engine = _.find(this.engines, ['key', newValue]) || createEmptySearchEngine()
    },
    engines(newValue: SearchEngine[]) {
      this.selectedEngine = _.find(newValue, 'isEnabled')?.key || 'db'
    }
  },
  created() {
    this.loadEngines().catch(() => {})
  },
  methods: {
    async loadEngines({ notifyError = true }: { notifyError?: boolean } = {}) {
      loadingStart(wikiStore, 'admin-search-refresh')
      try {
        this.engines = await fetchSearchEngines(window.fetch.bind(window), 'Search engines response is invalid')
      } catch (err) {
        this.engines = []
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err),
            style: 'error',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        loadingStop(wikiStore, 'admin-search-refresh')
      }
    },
    async refresh() {
      await this.loadEngines()
      showNotification(wikiStore, {
        message: this.$t('admin:search.listRefreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    async save() {
      loadingStart(wikiStore, 'admin-search-saveengines')
      try {
        await saveSearchEngines(window.fetch.bind(window), this.engines.map(tgt => ({
          isEnabled: tgt.key === this.selectedEngine,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))
        })), this.$t('common:error.unexpected'))
        await this.loadEngines({ notifyError: false })
        showNotification(wikiStore, {
          message: this.$t('admin:search.configSaveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      }
      loadingStop(wikiStore, 'admin-search-saveengines')
    },
    async rebuild () {
      loadingStart(wikiStore, 'admin-search-rebuildindex')
      try {
        await rebuildSearchIndex(window.fetch.bind(window), this.$t('common:error.unexpected'))
        showNotification(wikiStore, {
          message: this.$t('admin:search.indexRebuildSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        pushGraphError(wikiStore, err)
      }
      loadingStop(wikiStore, 'admin-search-rebuildindex')
    }
  }
}
</script>

<style lang='scss' scoped>

.enginelogo {
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

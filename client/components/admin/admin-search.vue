<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t(`admin:search.title`)'
          :description='$t(`admin:search.subtitle`)'
          icon='/_assets/svg/icon-search.svg'
        )
          template(v-slot:actions)
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn.mr-3.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/search', target='_blank', v-bind='props', aria-label='Search documentation — opens in a new tab')
                  v-icon mdi-help-circle
              span Search documentation — opens in a new tab
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh', v-bind='props', aria-label='Refresh search engines')
                  v-icon mdi-refresh
              span Refresh search engines
            .admin-action-group.ml-3
              .text-body-small.text-medium-emphasis Index maintenance
              v-btn.animated.fadeInDown.wait-p1s(color='primary', variant="outlined", @click='rebuild', :loading='rebuilding')
                v-icon(start) mdi-cached
                span {{$t('admin:search.rebuildIndex')}}
              .text-caption.text-medium-emphasis Rebuilds the search index immediately.
            v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large", :disabled='!enginesLoaded')
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large Active search engine (saved when Apply is selected)
          v-list.py-0(lines="two", density="compact", role='radiogroup')
            v-list-item(v-if='enginesLoading')
              v-progress-circular(indeterminate, size='20', width='2', color='primary', aria-label='Loading search engines')
              span.ml-3 Loading search engines
            v-list-item(v-else-if='enginesLoadError')
              v-list-item-title Search engines could not be loaded.
              v-btn.mt-2(variant='outlined', color='primary', size='small', @click='retryLoad') Retry
            v-list-item(v-else-if='enginesLoaded && engines.length < 1')
              em No search engines are installed.
            template(v-else, v-for='(eng, idx) in engines', :key='eng.key')
              v-list-item(
                @click='selectedEngine = eng.key'
                :disabled='!eng.isAvailable'
                role='radio'
                :aria-checked='selectedEngine === eng.key'
                :active='selectedEngine === eng.key'
              )
                template(v-slot:prepend)
                  v-avatar(size='24')
                    v-icon(color='grey', v-if='!eng.isAvailable') mdi-minus-box-outline
                    v-icon(color='primary', v-else-if='eng.key === selectedEngine') mdi-radiobox-marked
                    v-icon(color='grey', v-else) mdi-radiobox-blank
                v-list-item-title.text-body-medium(:class='!eng.isAvailable ? `text-grey` : (selectedEngine === eng.key ? `text-primary` : ``)') {{ eng.title }}
                v-list-item-subtitle: .text-body-small(:class='!eng.isAvailable ? `text-grey-lighten-1` : (selectedEngine === eng.key ? `text-primary` : ``)') {{ eng.description }}
                template(v-slot:append)
                  v-avatar(v-if='selectedEngine === eng.key', size='24')
                    v-icon.animated.fadeInLeft(color='primary', size="large") mdi-chevron-right
              v-divider(v-if='idx < engines.length - 1')

      v-col(lg='9', cols='12')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            .text-body-large {{engine.title || 'Search engine configuration'}}
            .text-caption.text-medium-emphasis(v-if='engine.key') Pending changes are saved when Apply is selected.
          div.v-card-info(v-if='engine.key', color='info')
            div
              div {{engine.description}}
              span.text-body-small.provider-url: a(:href='engine.website') {{engine.website}}
            v-spacer
            .admin-providerlogo
              img(:src='engine.logo', :alt='engine.title')
          v-card-text(v-if='enginesLoading')
            v-progress-circular(indeterminate, color='primary', aria-label='Loading search engine configuration')
            span.ml-3 Loading search engine configuration
          v-card-text(v-else-if='enginesLoadError')
            v-alert(variant='outlined', color='error') Search engine configuration could not be loaded.
            v-btn(variant='outlined', color='primary', @click='retryLoad') Retry
          v-card-text(v-else-if='!engine.key')
            em Select an available search engine to configure it.
          v-card-text(v-else)
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
      engine: createEmptySearchEngine(),
      enginesLoading: false,
      enginesLoaded: false,
      enginesLoadError: false,
      rebuilding: false
    }
  },
  watch: {
    selectedEngine(newValue: string) {
      this.engine = _.find(this.engines, ['key', newValue]) || createEmptySearchEngine()
    },
    engines(newValue: SearchEngine[]) {
      this.selectedEngine = _.find(newValue, 'isEnabled')?.key || 'postgres'
    }
  },
  created() {
    this.loadEngines().catch(() => {})
  },
  methods: {
    async loadEngines({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.enginesLoading = true
      this.enginesLoadError = false
      loadingStart(wikiStore, 'admin-search-refresh')
      try {
        this.engines = await fetchSearchEngines(window.fetch.bind(window), 'Search engines response is invalid')
        this.enginesLoaded = true
      } catch (err) {
        this.engines = []
        this.engine = createEmptySearchEngine()
        this.enginesLoaded = false
        this.enginesLoadError = true
        if (notifyError) {
          showNotification(wikiStore, {
            message: getErrorMessage(err),
            style: 'error',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        this.enginesLoading = false
        loadingStop(wikiStore, 'admin-search-refresh')
      }
    },
    async retryLoad() {
      await this.loadEngines().catch(() => {})
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
      this.rebuilding = true
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
      } finally {
        this.rebuilding = false
        loadingStop(wikiStore, 'admin-search-rebuildindex')
      }
    }
  }
}
</script>

<style lang='scss' scoped>

.admin-action-group {
  display: flex;
  align-items: center;
  gap: .5rem;
  flex-wrap: wrap;
}

.provider-url {
  overflow-wrap: anywhere;
}

@media (max-width: 959px) {
  .admin-action-group {
    flex: 1 0 100%;
    margin-left: 0 !important;
  }
}
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

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
                v-btn.mr-3.animated.fadeInDown.wait-p3s(icon, variant="outlined", color='grey', href='https://docs.requarks.io/search', target='_blank', rel='noopener', v-bind='props', aria-label='Search documentation — opens in a new tab')
                  v-icon mdi-help-circle
              span Search documentation — opens in a new tab
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn.animated.fadeInDown.wait-p2s(icon, variant="outlined", color='grey', @click='refresh', v-bind='props', aria-label='Refresh search engines', :loading='enginesLoading', :disabled='saving || rebuilding')
                  v-icon mdi-refresh
              span Refresh search engines
            .admin-action-group.ml-3
              .text-body-small.text-medium-emphasis Index maintenance
              v-btn.animated.fadeInDown.wait-p1s(color='primary', variant="outlined", @click='rebuild', :loading='rebuilding', :disabled='saving || enginesLoading')
                v-icon(start) mdi-cached
                span {{$t('admin:search.rebuildIndex')}}
              .text-body-small.text-medium-emphasis Rebuilds the search index immediately.
            v-btn.animated.fadeInDown(color='success', @click='save', variant="flat", size="large", :disabled='!canSave', :loading='saving')
              v-icon(start) mdi-check
              span {{$t('common:actions.apply')}}

      v-col(lg='3', cols='12')
        v-card.animated.fadeInUp
          v-toolbar(flat, color='primary', density="compact")
            .text-body-large Active search engine (saved when Apply is selected)
          v-list.py-0(lines="two", density="compact", :role='enginesLoaded && engines.length ? `radiogroup` : undefined', aria-label='Active search engine', :aria-busy='enginesLoading')
            v-list-item(v-if='enginesLoading')
              v-progress-circular(indeterminate, size='20', width='2', color='primary', aria-label='Loading search engines')
              span.ml-3 Loading search engines
            v-list-item(v-else-if='enginesLoadError')
              v-list-item-title Search engines could not be loaded.
              v-btn.mt-2(variant='outlined', color='primary', size='small', @click='retryLoad') Retry
            v-list-item(v-else-if='enginesLoaded && engines.length < 1')
              em No search engines are installed.
            template(v-else)
              template(v-for='(eng, idx) in engines', :key='eng.key')
                v-list-item(
                  @click='selectedEngine = eng.key'
                  link
                  :disabled='!eng.isAvailable || saving'
                  :aria-disabled='!eng.isAvailable || saving ? `true` : undefined'
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
            .text-body-small.text-medium-emphasis(v-if='engine.key') Pending changes are saved when Apply is selected.
          div.v-card-info(v-if='engine.key')
            div
              div {{engine.description}}
              span.text-body-small.provider-url: a(:href='engine.website' target='_blank' rel='noopener' :aria-label='`${engine.title} website — opens in a new tab`') {{engine.website}}
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
            template(v-else)
              template(v-for='cfg in engine.config', :key='cfg.key')
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
                  :disabled='saving'
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
                  :disabled='saving'
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
                  :disabled='saving'
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
                  :disabled='saving'
                  )
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'

import { fetchSearchEngines, rebuildSearchIndex, saveSearchEngines, type SearchEngine } from '../../helpers/search-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const createAbortableFetch = (signal: AbortSignal) => (
  url: string,
  options: Record<string, unknown>
) => window.fetch(url, { ...options, signal } as RequestInit)

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
      enginesLoading: false,
      enginesLoaded: false,
      enginesLoadError: false,
      rebuilding: false,
      saving: false,
      loadController: null as AbortController | null,
      saveController: null as AbortController | null,
      rebuildController: null as AbortController | null,
      isUnmounted: false
    }
  },
  computed: {
    engine(): SearchEngine {
      return this.engines.find(engine => engine.key === this.selectedEngine) || createEmptySearchEngine()
    },
    canSave(): boolean {
      return this.enginesLoaded &&
        !this.enginesLoading &&
        !this.rebuilding &&
        !this.saving &&
        this.engines.some(engine => engine.key === this.selectedEngine && engine.isAvailable)
    }
  },
  created() {
    this.loadEngines().catch(() => {})
  },
  methods: {
    async loadEngines({ notifyError = true }: { notifyError?: boolean } = {}) {
      if (this.enginesLoading) return false
      const controller = new AbortController()
      this.loadController = controller
      this.enginesLoading = true
      this.enginesLoadError = false
      loadingStart(wikiStore, 'admin-search-refresh')
      try {
        const engines = await fetchSearchEngines(
          createAbortableFetch(controller.signal),
          'Search engines response is invalid'
        )
        if (controller.signal.aborted) {
          return false
        }
        this.engines = engines
        const selected = engines.find(engine => engine.isEnabled && engine.isAvailable) ||
          engines.find(engine => engine.key === 'postgres' && engine.isAvailable) ||
          engines.find(engine => engine.isAvailable)
        this.selectedEngine = selected?.key || ''
        this.enginesLoaded = true
        return true
      } catch (err) {
        if (controller.signal.aborted) {
          return false
        }
        this.engines = []
        this.selectedEngine = ''
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
        if (this.loadController === controller) {
          this.loadController = null
          if (!this.isUnmounted) {
            this.enginesLoading = false
          }
        }
        loadingStop(wikiStore, 'admin-search-refresh')
      }
    },
    async retryLoad() {
      await this.loadEngines().catch(() => {})
    },
    async refresh() {
      if (this.saving || this.rebuilding || this.enginesLoading) return
      try {
        const loaded = await this.loadEngines()
        if (!loaded) return
        showNotification(wikiStore, {
          message: this.$t('admin:search.listRefreshSuccess'),
          style: 'success',
          icon: 'cached'
        })
      } catch {
        // loadEngines reports the request error.
      }
    },
    async save() {
      if (!this.canSave) return
      const controller = new AbortController()
      this.saveController = controller
      this.saving = true
      loadingStart(wikiStore, 'admin-search-saveengines')
      try {
        await saveSearchEngines(createAbortableFetch(controller.signal), this.engines.map(tgt => ({
          isEnabled: tgt.key === this.selectedEngine,
          key: tgt.key,
          config: tgt.config.map(cfg => ({...cfg, value: JSON.stringify({ v: cfg.value.value })}))
        })), this.$t('common:error.unexpected'))
        if (controller.signal.aborted) {
          return
        }
        const loaded = await this.loadEngines({ notifyError: false })
        if (!loaded || controller.signal.aborted) {
          return
        }
        showNotification(wikiStore, {
          message: this.$t('admin:search.configSaveSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          pushGraphError(wikiStore, err)
        }
      } finally {
        if (this.saveController === controller) {
          this.saveController = null
          if (!this.isUnmounted) {
            this.saving = false
          }
        }
        loadingStop(wikiStore, 'admin-search-saveengines')
      }
    },
    async rebuild () {
      if (this.saving || this.rebuilding || this.enginesLoading) return
      const controller = new AbortController()
      this.rebuildController = controller
      this.rebuilding = true
      loadingStart(wikiStore, 'admin-search-rebuildindex')
      try {
        await rebuildSearchIndex(createAbortableFetch(controller.signal), this.$t('common:error.unexpected'))
        if (controller.signal.aborted) {
          return
        }
        showNotification(wikiStore, {
          message: this.$t('admin:search.indexRebuildSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          pushGraphError(wikiStore, err)
        }
      } finally {
        if (this.rebuildController === controller) {
          this.rebuildController = null
          if (!this.isUnmounted) {
            this.rebuilding = false
          }
        }
        loadingStop(wikiStore, 'admin-search-rebuildindex')
      }
    }
  },
  beforeUnmount () {
    this.isUnmounted = true
    this.loadController?.abort()
    this.saveController?.abort()
    this.rebuildController?.abort()
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

<template>
  <v-container class="admin-search" fluid>
    <AdminHero :title="$t('admin:search.search')" :description="$t('admin:search.tuneDiscoveryReadersAgents')" :eyebrow="$t('admin:search.intelligenceConnections')" icon="mdi-text-search-variant">
      <template #status><v-chip size="small" variant="tonal" :color="dirty ? 'warning' : undefined">{{ enginesLoading ? $t('admin:search.loadingConfiguration') : enginesLoadError ? $t('admin:search.configurationUnavailable') : dirty ? $t('admin:search.unsavedChanges') : $t('admin:search.configurationUpDate') }}</v-chip></template>
      <template #actions><v-btn :aria-disabled="dirty || undefined" variant="text" prepend-icon="mdi-refresh" :loading="enginesLoading" :disabled="saving || rebuilding" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ dirty ? $t('admin:search.saveResetSearchChanges') : $t('admin:search.reloadSavedSearchConfiguration') }}</v-tooltip></v-btn></template>
    </AdminHero>
    <v-tabs v-model="tab" class="search-tabs" color="primary" show-arrows :aria-label="$t('admin:search.searchAdministrationSections')">
      <v-tab id="search-tab-configure" aria-controls="search-panel-configure" value="configure" prepend-icon="mdi-tune-variant">{{ $t('admin:search.configuration') }}</v-tab>
      <v-tab id="search-tab-evaluate" aria-controls="search-panel-evaluate" value="evaluate" prepend-icon="mdi-text-box-search-outline">{{ $t('admin:search.evaluateQueries') }}</v-tab>
      <v-tab id="search-tab-index" aria-controls="search-panel-index" value="index" prepend-icon="mdi-database-sync-outline">{{ $t('admin:search.indexMaintenance') }}</v-tab>
    </v-tabs>
    <v-alert v-if="enginesLoadError" type="error" variant="tonal" class="mb-5">{{ $t('admin:search.searchConfigurationCouldNot') }}<template #append><v-btn variant="text" @click="retryLoad">{{ $t('admin:search.retry') }}</v-btn></template></v-alert>
    <v-alert v-if="operationError" type="error" variant="tonal" class="mb-5" closable @click:close="operationError = ''">{{ operationError }}</v-alert>
    <v-window v-model="tab">
      <v-window-item id="search-panel-configure" role="tabpanel" aria-labelledby="search-tab-configure" value="configure">
        <v-skeleton-loader v-if="enginesLoading" type="article, article" />
        <div v-else-if="enginesLoaded" class="search-configuration">
          <section class="search-panel" aria-labelledby="search-engine-title">
            <header><div class="search-kicker">{{ $t('admin:search.retrievalFoundation') }}</div><h2 id="search-engine-title">{{ $t('admin:search.searchEngine2') }}</h2><p>{{ $t('admin:search.savedEngineServesReader') }}</p></header>
            <v-radio-group v-model="selectedEngine" :label="$t('admin:search.chooseEngine')" :disabled="saving || rebuilding">
              <v-radio v-for="eng in engines" :key="eng.key" :value="eng.key" :disabled="saving || rebuilding || !eng.isAvailable" class="engine-choice">
                <template #label><span><strong>{{ eng.title }}</strong><small>{{ eng.description }}{{ !eng.isAvailable ? ` ${$t('admin:search.unavailableDeployment')}` : '' }}</small><v-chip v-if="eng.isEnabled" size="x-small" variant="tonal" class="mt-1">{{ $t('admin:search.savedEngine') }}</v-chip></span></template>
              </v-radio>
            </v-radio-group>
            <p v-if="!engines.length">{{ $t('admin:search.noSearchEnginesInstalled') }}</p>
            <div v-if="engine.key" class="engine-settings">
              <h3>{{ $t('admin:search.retrievalSettings') }}</h3>
              <p v-if="engine.key === 'postgres'">{{ $t('admin:search.dictionaryControlsStemmingStop') }}</p>
              <p v-if="!engine.config.length">{{ $t('admin:search.engineNeedsNoAdditional') }}</p>
              <div v-for="cfg in engine.config" :key="cfg.key" class="engine-setting">
                <v-select v-if="cfg.value.type === 'string' && cfg.value.enum" :model-value="String(cfg.value.value ?? '')" @update:model-value="cfg.value.value = $event" :items="cfg.value.enum" :label="cfg.value.title" :hint="cfg.value.hint || ''" persistent-hint :disabled="saving || rebuilding" />
                <v-switch v-else-if="cfg.value.type === 'boolean'" v-model="cfg.value.value" :label="cfg.value.title" :hint="cfg.value.hint || ''" persistent-hint color="primary" inset :disabled="saving || rebuilding" />
                <v-textarea v-else-if="cfg.value.multiline" :model-value="String(cfg.value.value ?? '')" @update:model-value="cfg.value.value = $event" :label="cfg.value.title" :hint="cfg.value.hint || ''" persistent-hint :disabled="saving || rebuilding" />
                <v-text-field v-else v-model="cfg.value.value" :label="cfg.value.title" :hint="cfg.value.hint || ''" persistent-hint :disabled="saving || rebuilding" />
              </div>
            </div>
          </section>
          <aside class="search-principles">
            <div class="search-kicker">{{ $t('admin:search.questionSource') }}</div><h2>{{ $t('admin:search.howDiscoveryWorks') }}</h2>
            <ol><li><strong>{{ $t('admin:search.matchLanguage') }}</strong><p>{{ $t('admin:search.textSpellingMatchesHelp') }}</p></li><li><strong>{{ $t('admin:search.followConnections') }}</strong><p>{{ $t('admin:search.postgresqlEngineAlsoUses') }}</p></li><li><strong>{{ $t('admin:search.respectAccess') }}</strong><p>{{ $t('admin:search.searchResultsFilteredCurrent') }}</p></li></ol>
            <v-btn variant="tonal" append-icon="mdi-arrow-right" @click="tab = 'evaluate'">{{ $t('admin:search.evaluateQuery') }}</v-btn>
          </aside>
        </div>
      </v-window-item>
      <v-window-item id="search-panel-evaluate" role="tabpanel" aria-labelledby="search-tab-evaluate" value="evaluate"><v-alert v-if="dirty" type="info" variant="tonal" class="mb-5">{{ $t('admin:search.theseResultsUseSaved') }}</v-alert><AdminSearchEvaluate /></v-window-item>
      <v-window-item id="search-panel-index" role="tabpanel" aria-labelledby="search-tab-index" value="index">
        <section class="search-panel search-index" aria-labelledby="search-index-title">
          <header class="index-heading"><div><div class="search-kicker">{{ $t('admin:search.maintenanceEvidence') }}</div><h2 id="search-index-title">{{ $t('admin:search.indexCoverage') }}</h2><p>{{ $t('admin:search.inspectSavedEnginesDerived') }}</p></div><v-btn variant="tonal" prepend-icon="mdi-database-search-outline" :loading="inspecting" :disabled="saving || rebuilding || inspecting" @click="inspect">{{ $t('admin:search.inspectIndex') }}</v-btn></header>
          <v-alert v-if="inspectionError" type="error" variant="tonal">{{ inspectionError }}</v-alert>
          <v-skeleton-loader v-if="inspecting && !inspection" type="list-item-three-line" />
          <template v-if="inspection">
            <div class="index-verdict"><v-icon :color="indexAligned ? 'success' : 'warning'">{{ indexAligned ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline' }}</v-icon><div><strong>{{ indexAligned ? $t('admin:search.sourceRevisionsDictionaryAlign') : $t('admin:search.indexMaintenanceNeeded') }}</strong><p>{{ $t('admin:search.observed', { checkedAt: formatDate(inspection.checkedAt), inspectedEngine, interpolation: { escapeValue: false } }) }}</p></div></div>
            <dl class="index-metrics"><div><dt>{{ $t('admin:search.publishedPublicPages') }}</dt><dd>{{ inspection.publicPages.toLocaleString() }}</dd></div><div><dt>{{ $t('admin:search.indexedEntries') }}</dt><dd>{{ inspection.indexedPages.toLocaleString() }}</dd></div><div><dt>{{ $t('admin:search.missingPages') }}</dt><dd>{{ inspection.missingPages.toLocaleString() }}</dd></div><div><dt>{{ $t('admin:search.staleRevisions') }}</dt><dd>{{ inspection.stalePages.toLocaleString() }}</dd></div><div><dt>{{ $t('admin:search.entriesRemove') }}</dt><dd>{{ inspection.excludedEntries.toLocaleString() }}</dd></div></dl>
            <p class="index-note">{{ $t('admin:search.configuredDictionary') }} <strong>{{ inspection.configuredDictionary }}</strong> {{ $t('admin:search.indexedDictionary') }} <strong>{{ inspection.indexedDictionary || $t('admin:search.notRecorded') }}</strong>{{ $t('admin:search.snapshotChecksCoverageMetadata') }}</p>
          </template>
          <p v-else-if="!inspecting && !inspectionError" class="index-empty">{{ inspectionUnsupported ? $t('admin:search.activeEngineDoesNot') : $t('admin:search.runInspectionSeeCurrent') }}</p>
          <div class="index-rebuild"><div><h3>{{ $t('admin:search.rebuildDerivedSearchData') }}</h3><p>{{ $t('admin:search.useAfterConfigurationChange') }}</p><p class="index-note">{{ $t('admin:search.privatePagesOutsidePublic') }}</p></div><v-btn variant="outlined" color="primary" prepend-icon="mdi-cached" :loading="rebuilding" :disabled="saving || enginesLoading || dirty || !enginesLoaded" @click="rebuildConfirm = true">{{ $t('admin:search.rebuildIndex2') }}</v-btn></div>
          <v-alert v-if="rebuildMessage" type="info" variant="tonal" class="mt-4" role="status">{{ rebuildMessage }}</v-alert>
          <p v-if="dirty" class="index-note">{{ $t('admin:search.saveResetConfigurationChanges') }}</p>
        </section>
      </v-window-item>
    </v-window>
        <div v-if="enginesLoaded && tab === 'configure'" class="search-savebar" role="status">
          <span>{{ saving ? $t('admin:search.savingActivatingEngine') : dirty ? $t('admin:search.changesNotActiveYet') : $t('admin:search.configurationMatchesLastLoad') }}</span>
          <div><v-btn variant="text" prepend-icon="mdi-restore" :disabled="!dirty || saving || rebuilding" @click="resetDraft">{{ $t('admin:search.resetChanges') }}</v-btn><v-btn color="primary" prepend-icon="mdi-check" :disabled="!canSave" :loading="saving" @click="save">{{ $t('admin:search.saveConfiguration') }}</v-btn></div>
        </div>

    <v-dialog v-model="rebuildConfirm" max-width="32rem" :persistent="rebuilding" aria-labelledby="rebuild-confirm-title"><v-card><v-card-title id="rebuild-confirm-title">{{ $t('admin:search.rebuildSearchIndex') }}</v-card-title><v-card-text>{{ $t('admin:search.rebuildsSavedEnginesDerived') }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="rebuilding" @click="rebuildConfirm = false">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" :loading="rebuilding" :disabled="saving || enginesLoading" @click="rebuild">{{ $t('admin:search.rebuildIndex2') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(leaveResolve)" persistent max-width="30rem" aria-labelledby="search-discard-title"><v-card><v-card-title id="search-discard-title">{{ $t('admin:search.discardSearchChanges') }}</v-card-title><v-card-text>{{ $t('admin:search.configurationEditsHaveNot') }}</v-card-text><v-card-actions><v-spacer /><v-btn @click="finishLeave(false)">{{ $t('admin:search.keepEditing') }}</v-btn><v-btn color="warning" @click="finishLeave(true)">{{ $t('admin:search.discardChanges') }}</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import AdminSearchEvaluate from './admin-search-evaluate.vue'
import { inspectSearchIndex } from '../../helpers/search-api'
import type { SearchIndexInspection } from '../../../shared/search-admin.ts'

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
  components: { AdminSearchEvaluate },
  data() {
    return {
      engines: [] as SearchEngine[],
      savedEngines: [] as SearchEngine[],
      baseline: '',
      tab: 'configure',
      operationError: '',
      inspecting: false,
      inspection: null as SearchIndexInspection | null,
      inspectedEngine: '',
      inspectionUnsupported: false,
      inspectionError: '',
      inspectController: null as AbortController | null,
      rebuildConfirm: false,
      rebuildMessage: '',
      leaveResolve: null as ((leave: boolean) => void) | null,
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
    dirty(): boolean { return this.enginesLoaded && this.fingerprint() !== this.baseline },
    indexAligned(): boolean {
      const item = this.inspection
      return Boolean(item && !item.missingPages && !item.stalePages && !item.excludedEntries && item.configuredDictionary === item.indexedDictionary && item.schemaVersion === item.expectedSchemaVersion)
    },
    engine(): SearchEngine {
      return this.engines.find(engine => engine.key === this.selectedEngine) || createEmptySearchEngine()
    },
    canSave(): boolean {
      return this.enginesLoaded &&
        !this.enginesLoading &&
        !this.rebuilding &&
        !this.saving &&
        this.engines.some(engine => engine.key === this.selectedEngine && engine.isAvailable) && this.dirty
    }
  },
  created() {
    const section = window.location.hash.slice(1)
    if (['configure', 'evaluate', 'index'].includes(section)) this.tab = section
    this.loadEngines().catch(() => {})
  },
  watch: { tab(value: string) { const url = new URL(window.location.href); url.hash = value === 'configure' ? '' : value; window.history.replaceState(window.history.state, '', url) } },
  mounted() { window.addEventListener('beforeunload', this.warnBeforeUnload) },
  beforeRouteLeave(): boolean | Promise<boolean> {
    if (!this.dirty) return true
    return new Promise(resolve => { this.leaveResolve = resolve })
  },
  methods: {
    finishLeave(leave: boolean) { const resolve = this.leaveResolve; this.leaveResolve = null; resolve?.(leave) },
    warnBeforeUnload(event: BeforeUnloadEvent) { if (this.dirty) { event.preventDefault(); event.returnValue = '' } },
    formatDate(value: string): string { return new Date(value).toLocaleString() },
    fingerprint(selection?: string): string { return JSON.stringify(this.engines.map(engine => ({ key: engine.key, isEnabled: engine.key === (selection ?? this.selectedEngine), config: engine.config.map(cfg => ({ key: cfg.key, value: cfg.value.value })) }))) },
    resetDraft() {
      if (this.saving || this.rebuilding) return
      this.engines = JSON.parse(JSON.stringify(this.savedEngines)) as SearchEngine[]
      this.selectedEngine = this.engines.find(engine => engine.isEnabled)?.key || ''
      this.operationError = ''
    },
    async inspect() {
      if (this.inspecting || this.saving || this.rebuilding) return
      const controller = new AbortController()
      this.inspectController = controller
      this.inspecting = true
      this.inspectionError = ''
      try {
        const status = await inspectSearchIndex(createAbortableFetch(controller.signal))
        if (controller.signal.aborted) return
        this.inspection = status.inspection
        this.inspectedEngine = status.engine
        this.inspectionUnsupported = !status.inspection
      } catch (error) {
        if (!controller.signal.aborted) this.inspectionError = getErrorMessage(error)
      } finally { if (this.inspectController === controller) this.inspecting = false }
    },
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
          this.$t('admin:search.searchEnginesResponseInvalid')
        )
        if (controller.signal.aborted) {
          return false
        }
        this.engines = engines
        const selected = engines.find(engine => engine.isEnabled && engine.isAvailable) ||
          engines.find(engine => engine.key === 'postgres' && engine.isAvailable) ||
          engines.find(engine => engine.isAvailable)
        this.selectedEngine = selected?.key || ''
        this.savedEngines = JSON.parse(JSON.stringify(engines)) as SearchEngine[]
        this.baseline = this.fingerprint(engines.find(engine => engine.isEnabled)?.key || '')
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
      if (this.dirty) return
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
      let saveAccepted = false
      const controller = new AbortController()
      this.saveController = controller
      this.saving = true
      this.operationError = ''
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
        saveAccepted = true
        this.inspection = null
        this.inspectionUnsupported = false
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
          this.operationError = saveAccepted ? this.$t('admin:search.configurationWasSavedBut', { err: getErrorMessage(err), interpolation: { escapeValue: false } }) : getErrorMessage(err)
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
      if (this.dirty || !this.enginesLoaded) return
      if (this.saving || this.rebuilding || this.enginesLoading) return
      const controller = new AbortController()
      this.rebuildController = controller
      this.rebuilding = true
      this.rebuildConfirm = false
      this.rebuildMessage = this.$t('admin:search.rebuildingSavedEngineWaiting')
      this.operationError = ''
      loadingStart(wikiStore, 'admin-search-rebuildindex')
      try {
        await rebuildSearchIndex(createAbortableFetch(controller.signal), this.$t('common:error.unexpected'))
        if (controller.signal.aborted) {
          return
        }
        this.rebuildMessage = this.$t('admin:search.serverConfirmedIndexRebuild')
        this.inspection = null
        this.inspectionUnsupported = false
        showNotification(wikiStore, {
          message: this.$t('admin:search.indexRebuildSuccess'),
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          this.rebuildMessage = this.$t('admin:search.requestEndedWithoutCompletion')
          this.operationError = getErrorMessage(err)
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
    window.removeEventListener('beforeunload', this.warnBeforeUnload)
    this.finishLeave(false)
    this.inspectController?.abort()
    this.loadController?.abort()
    this.saveController?.abort()
    this.rebuildController?.abort()
  }
}
</script>

<style scoped>
.admin-search { padding-bottom: calc(var(--wiki-footer-height) + 2rem); }
.search-tabs { margin-bottom: 1.75rem; border-bottom: 1px solid var(--wiki-surface-border); }
.search-configuration { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 2rem; align-items: start; }
.search-panel { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: clamp(1rem, 2vw, 2rem); background: var(--wiki-surface-raised); }
.search-kicker { font-size: .75rem; letter-spacing: .09em; text-transform: uppercase; color: var(--wiki-accent-ink); }
h2 { font: 500 1.65rem var(--wiki-font-display); margin-block: .5rem .75rem; }
h3 { font-size: 1rem; margin-bottom: .5rem; }
p { font-size: .85rem; line-height: 1.7; margin-bottom: 1rem; }
.engine-choice { margin-top: .75rem; padding-block: .5rem; }
.engine-choice strong, .engine-choice small { display: block; }
.engine-choice strong { font-size: .95rem; }
.engine-choice small { font-size: .8rem; line-height: 1.6; }
.engine-settings { margin-top: 1rem; padding-top: 1.5rem; border-top: 1px solid var(--wiki-surface-border); }
.engine-setting { margin-top: 1rem; }
.search-principles { padding-block: 1rem; }
.search-principles ol { padding-inline-start: 1.2rem; margin-block: 1.5rem; }
.search-principles li { padding-inline-start: .5rem; margin-bottom: 1rem; }
.search-principles strong { font-size: .9rem; }
.search-principles p { margin-block: .4rem; }
.search-savebar { position: sticky; bottom: var(--wiki-footer-height); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; margin-top: 1.5rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-raised); z-index: 2; }
.search-savebar > span { font-size: .85rem; }
.search-savebar > div { display: flex; gap: .5rem; flex-wrap: wrap; }
.index-heading, .index-rebuild { display: flex; gap: 1.5rem; align-items: start; justify-content: space-between; }
.index-heading > div, .index-rebuild > div { max-width: 65ch; }
.index-verdict { display: flex; align-items: start; gap: .8rem; margin-top: 1.5rem; }
.index-verdict p { font-size: .8rem; margin-block: .4rem; }
.index-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1rem; margin-block: 1.5rem; }
.index-metrics dt { font-size: .8rem; }
.index-metrics dd { font: 500 2rem var(--wiki-font-display); margin: .5rem 0 0; }
.index-note, .index-empty { font-size: .8rem; line-height: 1.7; }
.index-empty { padding-block: 1.5rem; }
.index-rebuild { border-top: 1px solid var(--wiki-surface-border); padding-top: 1.5rem; margin-top: 1.5rem; }
@media (max-width: 1100px) { .index-heading, .index-rebuild { flex-direction: column; } .index-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .search-configuration { grid-template-columns: 1fr; gap: 1rem; } .index-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .search-savebar { position: static; } }
</style>

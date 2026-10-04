<template>
  <v-container fluid class="rendering-workspace">
    <admin-hero :title="$t('admin:rendering.title')" :description="$t('admin:rendering.configureTransformationsBehindPages')" icon="mdi-text-box-edit-outline">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy || reviewOpen" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:rendering.reloadSavedRenderingConfiguration') }}</v-tooltip></v-btn>
        <v-btn color="primary" variant="flat" :disabled="!dirty || busy || loading || errors.length > 0" @click="openReview">{{ $t('admin:rendering.reviewChanges') }}</v-btn>
      </template>
    </admin-hero>
    <dl class="rendering-summary"><div><dt>{{ $t('admin:rendering.enabledDraft') }}</dt><dd>{{ saved ? enabledCount : '—' }}<small v-if="saved"> / {{ draft.length }}</small></dd></div><div><dt>{{ $t('admin:rendering.sourceFormats') }}</dt><dd>{{ saved ? formats.length : '—' }}</dd></div><div><dt>{{ $t('admin:rendering.existingPages') }}</dt><dd>{{ saved ? totalPages : '—' }}</dd></div></dl>
    <v-alert v-if="success" type="success" variant="tonal" closable class="mb-4" @click:close="success = ''">{{ success }}</v-alert>
    <async-state v-if="loading" state="loading" :title="$t('admin:rendering.readingRenderingWorkspace')" :message="$t('admin:rendering.loadingInstalledModulesSaved')" />
    <async-state v-else-if="loadError" state="error" :title="$t('admin:rendering.renderingConfigurationUnavailable')" :message="loadError" :retry-label="$t('admin:rendering.tryAgain')" @retry="reload" />
    <template v-else-if="saved">
      <v-alert v-if="errors.length" type="error" variant="tonal" class="mb-4"><strong>{{ $t('admin:rendering.correctBeforeSaving', { tValue: $t('admin:rendering.configurationValuesCount', { count: errors.length }), interpolation: { escapeValue: false } }) }}</strong><div v-for="issue in errors" :key="issue.key + issue.message"><button class="rendering-error-link" @click="configure(issue.key)">{{ issue.message }}</button></div></v-alert>
      <div class="rendering-tabs-row">
        <div role="tablist" :aria-label="$t('admin:rendering.renderingWorkspaceSections')" class="rendering-tabs">
          <button v-for="tab in tabs" :id="`rendering-tab-${tab.key}`" :key="tab.key" role="tab" :aria-controls="`rendering-panel-${tab.key}`" :aria-selected="section === tab.key" :tabindex="section === tab.key ? 0 : -1" @click="setSection(tab.key)" @keydown="tabKey($event, tab.key)">{{ tab.title }}</button>
        </div>
        <span class="rendering-draft-state" aria-live="polite">{{ dirty ? $t('admin:rendering.modulesChanged', { changesCount: changes.length, interpolation: { escapeValue: false } }) : $t('admin:rendering.matchesSavedConfiguration') }}</span>
        <v-btn variant="text" :disabled="!dirty || busy || reviewOpen" @click="reset">{{ $t('admin:rendering.resetAllDrafts') }}</v-btn>
      </div>
      <section v-show="section === 'modules'" id="rendering-panel-modules" role="tabpanel" aria-labelledby="rendering-tab-modules" class="rendering-modules">
        <aside class="rendering-directory">
          <div class="rendering-directory-heading"><h3>{{ $t('admin:rendering.moduleLibrary') }}</h3><span>{{ filteredModules.length }} / {{ draft.length }}</span></div>
          <v-text-field v-model="query" :label="$t('admin:rendering.findModule')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable />
          <div class="rendering-directory-filters">
            <v-select v-model="family" :items="familyOptions" :label="$t('admin:rendering.moduleFamily')" variant="outlined" density="compact" hide-details />
            <v-select v-model="filter" :items="stateOptions" :label="$t('admin:rendering.moduleState')" variant="outlined" density="compact" hide-details />
          </div>
          <div class="rendering-records" :aria-label="$t('admin:rendering.renderingModules')">
            <button v-for="module in filteredModules" :key="module.key" class="rendering-record" :class="{ 'is-selected': selectedKey === module.key }" :aria-pressed="selectedKey === module.key" @click="select(module.key)">
              <v-icon :icon="module.icon" size="20" /><span><strong>{{ title(module) }}</strong><small>{{ module.dependsOn ? familyTitle(module) : $t('admin:rendering.coreParser') }}</small></span><span class="rendering-record-state" :class="{ 'is-enabled': effective(module) }">{{ state(module) }}</span><span v-if="moduleChanged(module.key)" class="rendering-change-dot" :aria-label="$t('admin:rendering.unsavedChanges')" />
            </button>
          </div>
          <p v-if="!filteredModules.length" class="rendering-empty">{{ $t('admin:rendering.noModulesMatchTry') }}</p>
          <div class="rendering-directory-footer"><span>{{ $t('admin:rendering.enabledModulesCanPaused') }}</span></div>
        </aside>
        <article v-if="current" class="rendering-module-detail">
          <header class="rendering-module-heading">
            <div><span class="rendering-eyebrow">{{ current.dependsOn ? $t('admin:rendering.extension', { current: familyTitle(current), interpolation: { escapeValue: false } }) : $t('admin:rendering.sourceParser') }}</span><h3><v-icon :icon="current.icon" size="28" />{{ title(current) }}</h3><p>{{ current.description }}</p></div>
            <v-switch v-model="current.isEnabled" :label="$t('admin:rendering.enabled2', { current: title(current), interpolation: { escapeValue: false } })" color="primary" hide-details density="compact" :disabled="busy || reviewOpen" />
          </header>
          <div class="rendering-module-context">
            <div><span>{{ $t('admin:rendering.effectiveDraft') }}</span><strong>{{ state(current) }}</strong></div>
            <div><span>{{ current.dependsOn ? $t('admin:rendering.requires') : $t('admin:rendering.transformation') }}</span><button v-if="current.dependsOn" @click="select(current.dependsOn)">{{ parentTitle(current) }} <v-icon icon="mdi-arrow-top-right" size="14" /></button><strong v-else>{{ format(current.input || '') }} → {{ format(current.output || '') }}</strong></div>
            <div><span>{{ (current.dependsOn || current.key) === 'htmlCore' ? $t('admin:rendering.pagesAcrossSourceFormats') : $t('admin:rendering.storedPagesFormat') }}</span><strong>{{ usageCount(current) }}</strong></div>
          </div>
          <v-alert v-if="current.isEnabled && !effective(current)" type="warning" variant="tonal" class="mb-5">{{ $t('admin:rendering.extensionConfiguredEnabledBut') }}</v-alert>
          <div class="rendering-section-heading"><div><h4>{{ $t('admin:rendering.configuration') }}</h4></div><v-btn size="small" variant="text" :disabled="!moduleChanged(current.key) || busy || reviewOpen" @click="resetModule">{{ $t('admin:rendering.resetModule') }}</v-btn></div>
          <p v-if="!properties.length" class="rendering-empty">{{ $t('admin:rendering.moduleHasNoConfigurable') }}</p>
          <div v-else class="rendering-properties">
            <div v-for="[key, prop] in properties" :key="key" class="rendering-property">
              <v-switch v-if="prop.type === 'boolean'" v-model="current.config[key]" :label="prop.title || key" :hint="prop.hint" persistent-hint color="primary" :disabled="busy || reviewOpen" />
              <v-select v-else-if="prop.enum" :model-value="String(current.config[key] ?? '')" @update:model-value="current.config[key] = $event" :items="prop.enum" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" />
              <v-text-field v-else-if="prop.type === 'number'" :model-value="String(current.config[key] ?? '')" type="number" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" @update:model-value="current.config[key] = $event === '' || $event == null ? null : Number($event)" />
              <v-text-field v-else v-model="current.config[key]" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" />
            </div>
          </div>
          <div v-if="moduleIssues.length" class="rendering-module-issues"><p v-for="issue in moduleIssues" :key="issue.message" :class="{ 'is-error': issue.severity === 'error' }"><v-icon :icon="issue.severity === 'error' ? 'mdi-alert-circle-outline' : 'mdi-information-outline'" size="18" />{{ issue.message }}</p></div>
          <section v-if="externalBehavior" class="rendering-behavior"><span class="rendering-eyebrow">{{ $t('admin:rendering.contentConnections') }}</span><p>{{ externalBehavior }}</p></section>
          <footer class="rendering-module-footer"><code>{{ current.key }}</code><v-btn variant="text" size="small" append-icon="mdi-arrow-right" @click="inspectFamily">{{ $t('admin:rendering.followPipeline') }}</v-btn></footer>
        </article>
        <async-state v-else state="empty" :title="$t('admin:rendering.chooseRenderingModule')" :message="$t('admin:rendering.selectInstalledParserExtension')" />
      </section>
      <section v-show="section === 'pipeline'" id="rendering-panel-pipeline" role="tabpanel" aria-labelledby="rendering-tab-pipeline" class="rendering-pipeline-panel">
        <div class="rendering-section-heading"><div><h3>{{ $t('admin:rendering.pipeline') }}</h3><p>{{ $t('admin:rendering.effectiveConfiguredPathNot') }}</p></div><div class="rendering-segment" role="group" :aria-label="$t('admin:rendering.pipelineConfiguration')"><button :aria-pressed="planMode === 'draft'" @click="planMode = 'draft'">{{ $t('admin:rendering.draft') }}</button><button :aria-pressed="planMode === 'saved'" @click="planMode = 'saved'">{{ $t('admin:rendering.saved') }}</button></div></div>
        <div class="rendering-format-choices" role="group" :aria-label="$t('admin:rendering.sourceFormat')"><button v-for="value in formats" :key="value" :aria-pressed="planFormat === value" @click="setPlanFormat(value)"><span>{{ format(value) }}</span><small>{{ $t('admin:rendering.pages', { value: formatUsage(value), interpolation: { escapeValue: false } }) }}</small><v-icon icon="mdi-arrow-right" size="18" /></button></div>
        <div class="rendering-trace-layout">
          <div class="rendering-trace">
            <div class="rendering-trace-bookend"><v-icon icon="mdi-file-document-outline" size="21" /><span>{{ $t('admin:rendering.source', { planFormat: format(planFormat), interpolation: { escapeValue: false } }) }}</span></div>
            <article v-for="(stage, index) in plan" :key="stage.core.key" class="rendering-stage">
              <div class="rendering-stage-heading"><span class="rendering-stage-number">{{ String(index + 1).padStart(2, '0') }}</span><div><span class="rendering-eyebrow">{{ format(stage.core.input || '') }} → {{ format(stage.core.output || '') }}</span><h4>{{ title(stage.core) }}</h4></div><v-btn variant="text" size="small" @click="configure(stage.core.key)">{{ $t('admin:rendering.configure') }}</v-btn></div>
              <div v-if="stage.before.length" class="rendering-stage-group"><h5>{{ stage.core.key === 'htmlCore' ? $t('admin:rendering.beforeHtmlFinalization') : $t('admin:rendering.parserExtensions') }}</h5><div><button v-for="module in stage.before" :key="module.key" @click="configure(module.key)">{{ title(module) }}</button></div></div>
              <div v-if="stage.core.key === 'htmlCore'" class="rendering-stage-core"><v-icon icon="mdi-link-variant" size="18" /><span>{{ $t('admin:rendering.resolveLinksMarkPage') }}</span></div>
              <div v-if="stage.after.length" class="rendering-stage-group"><h5>{{ $t('admin:rendering.postProcessorsExecutionOrder') }}</h5><ol><li v-for="module in stage.after" :key="module.key"><button @click="configure(module.key)">{{ title(module) }}</button><small>{{ module.order === Number.MAX_SAFE_INTEGER ? $t('admin:rendering.defaultOrder') : $t('admin:rendering.order', { order: module.order, interpolation: { escapeValue: false } }) }}</small></li></ol></div>
            </article>
            <div v-if="!plan.length" class="rendering-no-pipeline"><h4>{{ $t('admin:rendering.noEnabledParser', { planFormat: format(planFormat), interpolation: { escapeValue: false } }) }}</h4><p>{{ $t('admin:rendering.renderWorkerCannotUpdate') }}</p></div>
            <div class="rendering-trace-bookend"><v-icon icon="mdi-text-box-check-outline" size="21" /><span>{{ plan.length ? $t('admin:rendering.output', { format: format(plan.at(-1)!.core.output || ''), interpolation: { escapeValue: false } }) : $t('admin:rendering.noOutputUpdate') }}</span><small>{{ plan.length ? $t('admin:rendering.storedReaders') : $t('admin:rendering.existingOutputStaysPlace') }}</small></div>
          </div>
          <aside class="rendering-pipeline-notes">
            <section><span class="rendering-eyebrow">{{ $t('admin:rendering.configurationChecks') }}</span><h4>{{ planIssues.length ? $t('admin:rendering.pointsReview', { planIssuesCount: planIssues.length, interpolation: { escapeValue: false } }) : $t('admin:rendering.noConfigurationIssuesDetected') }}</h4><p v-if="!planIssues.length">{{ $t('admin:rendering.selectedPathHasEnabled') }}</p><ul v-else><li v-for="issue in planIssues" :key="issue.key + issue.message"><button @click="configure(issue.key)">{{ issue.message }}</button></li></ul></section>
            <section><span class="rendering-eyebrow">{{ $t('admin:rendering.whenChangesTakeEffect') }}</span><h4>{{ $t('admin:rendering.nextRenderUsesSaved') }}</h4><p>{{ $t('admin:rendering.savingConfigurationDoesNot') }}</p><v-btn size="small" variant="text" append-icon="mdi-arrow-right" @click="setSection('output')">{{ $t('admin:rendering.inspectPage') }}</v-btn></section>
          </aside>
        </div>
      </section>
      <section v-show="section === 'output'" id="rendering-panel-output" role="tabpanel" aria-labelledby="rendering-tab-output" class="rendering-output-panel">
        <div class="rendering-section-heading"><div><h3>{{ $t('admin:rendering.storedOutput') }}</h3><p>{{ $t('admin:rendering.choosePageInspectRendered') }}</p></div></div>
        <div class="rendering-output-picker"><v-autocomplete v-model="pageId" :items="pageOptions" :label="$t('admin:rendering.pageInspect')" :loading="pagesLoading" variant="outlined" density="comfortable" hide-details clearable :disabled="rendering || renderPending" @update:model-value="inspectOutput" /><v-btn variant="tonal" prepend-icon="mdi-refresh" :disabled="!pageId || outputLoading || rendering || renderPending" @click="inspectOutput">{{ $t('admin:rendering.reloadOutput') }}</v-btn></div>
        <v-alert v-if="pagesError" type="error" variant="tonal" class="mb-4">{{ pagesError }}<v-btn variant="text" size="small" @click="loadPages">{{ $t('admin:rendering.retryPageDirectory') }}</v-btn></v-alert>
        <v-alert v-if="renderNotice && pageId === renderNoticeFor" :type="renderFailed || renderPending ? 'warning' : 'success'" variant="tonal" class="my-4">
          {{ renderNotice }}
          <div v-if="renderReceipt" class="rendering-render-receipt">{{ $t('admin:rendering.receipt', { effectId: renderReceipt.effectId, status: renderStatus ? $t('admin:rendering.status', { status: renderStatus.status, interpolation: { escapeValue: false } }) : $t('admin:rendering.statusUnknown'), interpolation: { escapeValue: false } }) }}</div>
          <v-btn v-if="renderReceipt && !rendering && renderPending" variant="text" size="small" prepend-icon="mdi-refresh" @click="refreshRenderStatus">{{ $t('admin:rendering.refreshRenderStatus') }}</v-btn>
        </v-alert>
        <async-state v-if="outputLoading" state="loading" :title="$t('admin:rendering.readingStoredOutput')" :message="$t('admin:rendering.checkingPageAccessLoading')" />
        <async-state v-else-if="outputError" state="error" :title="$t('admin:rendering.storedOutputCouldNot')" :message="outputError" :retry-label="$t('admin:rendering.tryAgain')" @retry="inspectOutput" />
        <div v-else-if="output" class="rendering-output-workspace">
          <header class="rendering-output-heading"><div><span class="rendering-eyebrow">{{ output.page.visibility === 'private' ? $t('admin:rendering.privatePage') : $t('admin:rendering.workspacePage') }} · {{ format(output.page.contentType) }}</span><h4>{{ output.page.title }}</h4><p>{{ $t('admin:rendering.currentSourceRevision', { locale: output.page.locale, path: output.page.path, sourceRevision: output.page.sourceRevision, interpolation: { escapeValue: false } }) }}</p></div><v-btn variant="outlined" :disabled="rendering || renderPending || dirty" :loading="rendering" @click="renderReview = true">{{ $t('admin:rendering.reRenderPage') }}</v-btn></header>
          <p class="rendering-footnote">{{ $t('admin:rendering.storedOutputNotPreview', { value: dirty ? $t('admin:rendering.saveResetConfigurationDraft') : $t('admin:rendering.reRenderingRunsSaved'), interpolation: { escapeValue: false } }) }}</p>
          <dl class="rendering-output-stats"><div><dt>{{ $t('admin:rendering.htmlSize') }}</dt><dd>{{ (output.bytes / 1024).toFixed(1) }} <small>{{ $t('admin:rendering.kib') }}</small></dd></div><div><dt>{{ $t('admin:rendering.headings') }}</dt><dd>{{ output.headings.length }}</dd></div><div><dt>{{ $t('admin:rendering.internalLinks') }}</dt><dd>{{ output.links.internal }}</dd></div><div><dt>{{ $t('admin:rendering.unresolvedMarkers') }}</dt><dd>{{ output.links.unresolved }}</dd></div><div><dt>{{ $t('admin:rendering.imagesFrames') }}</dt><dd>{{ output.images }} / {{ output.frames }}</dd></div></dl>
          <div class="rendering-output-toolbar"><div class="rendering-segment" role="group" :aria-label="$t('admin:rendering.storedOutputView')"><button v-for="mode in outputModes" :key="mode.key" :aria-pressed="outputMode === mode.key" @click="outputMode = mode.key">{{ mode.title }}</button></div><v-btn size="small" variant="text" prepend-icon="mdi-download" @click="exportOutput">{{ $t('admin:rendering.exportHtmlText') }}</v-btn></div>
          <div v-if="outputMode === 'preview'" class="rendering-isolated-preview"><p>{{ $t('admin:rendering.structurePreviewScriptsLinks') }}</p><iframe :title="$t('admin:rendering.isolatedStoredPageOutput')" sandbox="" referrerpolicy="no-referrer" :srcdoc="previewDocument" /></div>
          <pre v-else-if="outputMode === 'html'" class="rendering-html" tabindex="0" :aria-label="$t('admin:rendering.storedHtmlSource')"><code>{{ output.html || $t('admin:rendering.noRenderedHtmlStored') }}</code></pre>
          <div v-else class="rendering-outline"><p class="rendering-footnote">{{ $t('admin:rendering.unresolvedLinkMarkersReflect') }}</p><ol v-if="output.headings.length"><li v-for="(heading, index) in output.headings" :key="index" :style="{ paddingLeft: `${Math.min(heading.level - 1, 3) * .8}rem` }"><span>H{{ heading.level }}</span><strong>{{ heading.text || $t('admin:rendering.emptyHeading') }}</strong><code>{{ heading.id ? '#' + heading.id : $t('admin:rendering.noAnchor') }}</code></li></ol><p v-else class="rendering-empty">{{ $t('admin:rendering.noHeadingsWereFound') }}</p></div>
        </div>
        <div v-else class="rendering-output-welcome"><v-icon icon="mdi-text-box-search-outline" size="42" /><h4>{{ $t('admin:rendering.pagesOutputMadeInspectable') }}</h4><p>{{ $t('admin:rendering.inspectorReadsStoredHtml') }}</p></div>
      </section>
    </template>
    <v-dialog v-model="reviewOpen" max-width="760" :persistent="saving" aria-labelledby="rendering-review-title">
      <v-card class="rendering-review"><div class="rendering-review-heading"><span class="rendering-eyebrow">{{ $t('admin:rendering.reviewConfiguration') }}</span><h3 id="rendering-review-title">{{ $t('admin:rendering.modulesWillChange', { changesCount: changes.length, interpolation: { escapeValue: false } }) }}</h3><p>{{ $t('admin:rendering.savedConfigurationAppliesFuture') }}</p></div><v-card-text>
        <div class="rendering-change-list"><article v-for="change in changes" :key="change.key"><h4>{{ change.title }}</h4><ul><li v-for="line in change.lines" :key="line">{{ line }}</li></ul></article></div>
        <div v-if="issues.length" class="rendering-review-checks"><h4>{{ $t('admin:rendering.reviewResultingConfiguration') }}</h4><p v-for="issue in issues" :key="issue.key + issue.message">{{ issue.message }}</p><v-checkbox v-model="acknowledged" :label="$t('admin:rendering.iHaveReviewedThese')" hide-details :disabled="saving" /></div>
        <v-alert v-if="saveError" type="error" variant="tonal" class="mt-4">{{ saveError }}<div><v-btn variant="text" size="small" :disabled="saving" @click="reloadReview">{{ $t('admin:rendering.reloadSavedConfiguration') }}</v-btn></div></v-alert>
      </v-card-text><v-card-actions><v-btn variant="text" :disabled="saving" @click="reviewOpen = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="saving" :disabled="saving || errors.length > 0 || (issues.length > 0 && !acknowledged)" @click="save">{{ $t('admin:rendering.saveConfiguration') }}</v-btn></v-card-actions></v-card>
    </v-dialog>
    <v-dialog v-model="renderReview" max-width="600" :persistent="rendering" aria-labelledby="rendering-run-title"><v-card class="rendering-review"><div class="rendering-review-heading"><span class="rendering-eyebrow">{{ $t('admin:rendering.runSavedPipeline') }}</span><h3 id="rendering-run-title">{{ $t('admin:rendering.reRenderPage2') }}</h3><p>{{ $t('admin:rendering.willReceiveFreshStored', { title: output?.page.title, interpolation: { escapeValue: false } }) }}</p></div><v-card-actions><v-btn variant="text" :disabled="rendering" @click="renderReview = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="rendering" :disabled="rendering || renderPending || dirty" @click="rerender">{{ $t('admin:rendering.reRenderPage3') }}</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import { buildRenderingPlan, formatTitle, rendererTitle, renderingIssues, renderingSettings, type RenderingModule, type RenderingOutput, type RenderingWorkspace } from '../../../shared/rendering-policy.ts'
import { fetchRenderingOutput, fetchRenderingWorkspace, saveRenderingWorkspace } from '../../helpers/rendering-workspace-api.ts'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api.ts'
import { fetchRenderPageStatus, renderPage, type RenderPageReceipt, type RenderPageStatus } from '../../helpers/system-api.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
import { buildStoredOutputPreview } from '../../helpers/rendering-output-preview.ts'
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
export default {
  components: { AsyncState },
  data() {
    return {
      saved: null as RenderingWorkspace | null, draft: [] as RenderingModule[], loading: false, loadError: '', saving: false, saveError: '', success: '', disposed: false,
      section: 'modules', selectedKey: 'markdownCore', query: '', family: 'all', filter: 'all', reviewOpen: false, acknowledged: false,
      tabs: [{ key: 'modules', title: this.$t('admin:rendering.modules') }, { key: 'pipeline', title: this.$t('admin:rendering.pipeline') }, { key: 'output', title: this.$t('admin:rendering.storedOutput') }],
      stateOptions: [{ title: this.$t('admin:rendering.allStates'), value: 'all' }, { title: this.$t('admin:rendering.active'), value: 'active' }, { title: this.$t('admin:rendering.disabled'), value: 'disabled' }, { title: this.$t('admin:rendering.pausedCore'), value: 'paused' }, { title: this.$t('admin:rendering.changed'), value: 'changed' }],
      planMode: 'draft', planFormat: 'markdown', pageId: null as number | null, pages: [] as PageListRow[], pagesLoading: false, pagesLoaded: false, pagesError: '', outputLoading: false, outputError: '', outputSequence: 0, output: null as RenderingOutput | null,
      outputMode: 'preview', outputModes: [{ key: 'preview', title: this.$t('admin:rendering.structurePreview') }, { key: 'html', title: this.$t('admin:rendering.htmlSource') }, { key: 'outline', title: this.$t('admin:rendering.outlineLinks') }], rendering: false, renderReview: false, renderNotice: '', renderNoticeFor: null as number | null, renderFailed: false,
      renderReceipt: null as RenderPageReceipt | null, renderStatus: null as RenderPageStatus | null, renderPollCount: 0, renderPollLimit: 12, renderPollTimer: null as ReturnType<typeof setTimeout> | null
    }
  },
  computed: {
    busy(): boolean { return this.saving || this.rendering },
    renderPending(): boolean {
      const status = this.renderStatus?.status
      return Boolean(this.renderReceipt && (!status || status === 'pending' || status === 'leased'))
    },
    dirty(): boolean { return Boolean(this.saved && !same(renderingSettings(this.saved.modules), renderingSettings(this.draft))) },
    current(): RenderingModule | undefined { return this.draft.find(module => module.key === this.selectedKey) },
    enabledCount(): number { return this.draft.filter(module => module.isEnabled).length },
    formats(): string[] { return [...new Set([...this.draft.filter(module => !module.dependsOn).map(module => module.input || ''), ...this.saved?.usage.map(row => row.contentType) ?? []])].filter(Boolean).sort() },
    totalPages(): number { return this.saved?.usage.reduce((sum, row) => sum + row.pages, 0) ?? 0 },
    familyOptions() { return [{ title: this.$t('admin:rendering.allFamilies'), value: 'all' }, ...this.draft.filter(module => !module.dependsOn).map(module => ({ title: formatTitle(module.input || ''), value: module.key }))] },
    filteredModules(): RenderingModule[] {
      const query = (this.query || '').trim().toLowerCase()
      return this.draft.filter(module => (this.family === 'all' || module.key === this.family || module.dependsOn === this.family) && (!query || [module.key, module.title, module.description].join(' ').toLowerCase().includes(query)) && (this.filter === 'all' || this.filter === 'active' && this.effective(module) || this.filter === 'disabled' && !module.isEnabled || this.filter === 'paused' && module.isEnabled && !this.effective(module) || this.filter === 'changed' && this.moduleChanged(module.key))).sort((a, b) => Number(Boolean(a.dependsOn)) - Number(Boolean(b.dependsOn)) || this.title(a).localeCompare(this.title(b)))
    },
    properties() { return Object.entries(this.current?.props ?? {}).sort((a, b) => (a[1].order ?? 999) - (b[1].order ?? 999)) },
    issues() { return renderingIssues(this.draft, this.formats) },
    errors() { return this.issues.filter(issue => issue.severity === 'error') },
    moduleIssues() { return this.issues.filter(issue => issue.key === this.current?.key) },
    planModules(): RenderingModule[] { return this.planMode === 'saved' ? this.saved?.modules ?? [] : this.draft },
    plan() { try { return buildRenderingPlan(this.planModules, this.planFormat) } catch { return [] } },
    planIssues() { return renderingIssues(this.planModules, [this.planFormat]).filter(issue => issue.key === this.planFormat || this.plan.some(stage => stage.core.key === issue.key || this.planModules.find(module => module.key === issue.key)?.dependsOn === stage.core.key)) },
    changes() {
      return this.draft.filter(module => this.moduleChanged(module.key)).map(module => {
        const prior = this.saved!.modules.find(row => row.key === module.key)!, lines: string[] = []
        if (prior.isEnabled !== module.isEnabled) lines.push(`${prior.isEnabled ? this.$t('admin:rendering.enabled') : this.$t('admin:rendering.disabled')} → ${module.isEnabled ? this.$t('admin:rendering.enabled') : this.$t('admin:rendering.disabled')}`)
        for (const [key, prop] of Object.entries(module.props)) if (!same(prior.config[key], module.config[key])) lines.push(`${prop.title || key}: ${String(prior.config[key])} → ${String(module.config[key])}`)
        return { key: module.key, title: this.title(module), lines }
      })
    },
    externalBehavior(): string {
      return ({ markdownPlantuml: this.$t('admin:rendering.diagramSourceEncodedInto'), markdownKroki: this.$t('admin:rendering.diagramSourceEncodedInto2'), htmlImagePrefetch: this.$t('admin:rendering.downloadsImagesMarkedTrusted'), htmlMediaplayers: this.$t('admin:rendering.recognizedMediaLinksCan'), htmlAsciinema: this.$t('admin:rendering.compatibleLinksBecomeEmbedded'), asciidocCore: this.$t('admin:rendering.asciidocSafetyModeControls') } as Record<string, string>)[this.selectedKey] ?? ''
    },
    pageOptions() { return this.pages.map(page => ({ title: `${page.title} · ${page.locale}/${page.path}${page.visibility === 'private' ? ` ${this.$t('admin:rendering.private')}` : ''}`, value: page.id })) },
    previewDocument(): string { return buildStoredOutputPreview(this.output?.html ?? '', this.$vuetify.theme.current.dark) }
  },
  methods: {
    title: rendererTitle, format: formatTitle,
    effective(module: RenderingModule): boolean { return module.isEnabled && (!module.dependsOn || this.draft.some(parent => parent.key === module.dependsOn && parent.isEnabled)) },
    state(module: RenderingModule): string { return !module.isEnabled ? this.$t('admin:rendering.disabled') : this.effective(module) ? this.$t('admin:rendering.active') : this.$t('admin:rendering.paused') },
    familyTitle(module: RenderingModule): string { return formatTitle(this.draft.find(parent => parent.key === (module.dependsOn || module.key))?.input ?? '') },
    parentTitle(module: RenderingModule): string { const parent = this.draft.find(parent => parent.key === module.dependsOn); return parent ? this.title(parent) : module.dependsOn || '' },
    moduleChanged(key: string): boolean { const prior = this.saved?.modules.find(module => module.key === key), current = this.draft.find(module => module.key === key); return Boolean(prior && current && (!same(prior.config, current.config) || prior.isEnabled !== current.isEnabled)) },
    formatUsage(value: string): number { return this.saved?.usage.find(row => row.contentType === value)?.pages ?? 0 },
    usageCount(module: RenderingModule): number { const core = this.draft.find(parent => parent.key === (module.dependsOn || module.key)); return core?.input === 'html' ? this.totalPages : this.formatUsage(core?.input || '') },
    select(key: string) { if (!this.draft.some(module => module.key === key)) return; this.selectedKey = key; this.$router.replace({ query: { ...this.$route.query, module: key }, hash: `#${this.section}` }) },
    setSection(value: string) { this.section = value; this.$router.replace({ query: { ...this.$route.query, format: this.planFormat }, hash: `#${value}` }); if (value === 'output') this.loadPages() },
    setPlanFormat(value: string) { this.planFormat = value; this.$router.replace({ query: { ...this.$route.query, format: value }, hash: `#${this.section}` }) },
    configure(key: string) { this.setSection('modules'); this.select(key) },
    inspectFamily() { this.setPlanFormat(this.draft.find(module => module.key === (this.current?.dependsOn || this.current?.key))?.input || 'markdown'); this.setSection('pipeline') },
    tabKey(event: KeyboardEvent, key: string) { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = this.tabs.findIndex(tab => tab.key === key), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3; this.setSection(this.tabs[next]!.key); this.$nextTick(() => document.getElementById(`rendering-tab-${this.section}`)?.focus()) },
    reset() { if (this.saved) this.draft = copy(this.saved.modules); this.saveError = '' },
    resetModule() { const prior = this.saved?.modules.find(module => module.key === this.selectedKey), index = this.draft.findIndex(module => module.key === this.selectedKey); if (prior && index >= 0) this.draft.splice(index, 1, copy(prior)); this.saveError = '' },
    async reload() {
      if (this.busy || this.loading || this.disposed) return
      if (this.dirty && !(await confirmDiscard(this.$t('admin:rendering.discardAllRenderingDrafts')))) return
      if (this.busy || this.loading || this.disposed) return
      this.loading = true; this.loadError = ''
      try { const result = await fetchRenderingWorkspace(); if (this.disposed) return; this.saved = result; this.reset(); if (!this.current) this.selectedKey = this.draft[0]?.key || '' } catch (error) { if (!this.disposed) this.loadError = getErrorMessage(error) } finally { if (!this.disposed) this.loading = false }
    },
    openReview() { this.acknowledged = false; this.saveError = ''; this.reviewOpen = true },
    async reloadReview() { if (this.busy || !(await confirmDiscard(this.$t('admin:rendering.discardAllRenderingDrafts'))) || this.busy) return; this.reviewOpen = false; this.reset(); await this.reload() },
    async save() {
      if (!this.saved || !this.dirty || this.busy || this.errors.length || (this.issues.length && !this.acknowledged)) return
      this.saving = true; this.saveError = ''
      try { const result = await saveRenderingWorkspace(renderingSettings(this.draft), this.saved.fingerprint); if (this.disposed) return; this.saved = { ...this.saved, ...result }; this.reset(); this.reviewOpen = false; this.success = this.$t('admin:rendering.renderingConfigurationSavedFuture') } catch (error) { if (!this.disposed) this.saveError = getErrorMessage(error) } finally { if (!this.disposed) this.saving = false }
    },
    async loadPages() {
      if (this.pagesLoaded || this.pagesLoading || this.disposed) return
      this.pagesLoading = true; this.pagesError = ''
      try { const pages = await fetchPageList(window.fetch.bind(window)); if (this.disposed) return; this.pages = pages; this.pagesLoaded = true } catch (error) { if (!this.disposed) this.pagesError = getErrorMessage(error) } finally { if (!this.disposed) this.pagesLoading = false }
    },
    async inspectOutput() {
      if (this.disposed || this.rendering) return
      const sequence = ++this.outputSequence, id = this.pageId
      this.output = null; this.outputError = ''; this.outputLoading = Boolean(id)
      this.$router.replace({ query: { ...this.$route.query, page: id ? String(id) : undefined }, hash: this.$route.hash })
      if (!id) return
      try { const result = await fetchRenderingOutput(id); if (this.disposed || sequence !== this.outputSequence) return; this.output = result } catch (error) { if (!this.disposed && sequence === this.outputSequence) this.outputError = getErrorMessage(error) } finally { if (!this.disposed && sequence === this.outputSequence) this.outputLoading = false }
    },
    clearRenderPoll() {
      if (this.renderPollTimer !== null) {
        clearTimeout(this.renderPollTimer)
        this.renderPollTimer = null
      }
    },
    async pollRenderStatus() {
      const receipt = this.renderReceipt
      if (this.disposed || !receipt) return
      try {
        const status = await fetchRenderPageStatus(window.fetch.bind(window), receipt.statusUrl)
        if (this.disposed || this.renderReceipt?.effectId !== receipt.effectId) return
        if (status.effectId !== receipt.effectId || status.pageId !== receipt.pageId || status.sourceRevision !== receipt.sourceRevision)
          throw new Error(this.$t('admin:rendering.serverReturnedDifferentRender'))
        this.renderStatus = status
        if (status.status === 'succeeded') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = false
          this.renderNotice = this.$t('admin:rendering.renderCompletedStoredOutput')
          await this.inspectOutput()
          return
        }
        if (status.status === 'failed') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = true
          this.renderNotice = this.$t('admin:rendering.renderFailedExistingStored')
          return
        }
        if (status.status === 'superseded') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = true
          this.renderNotice = this.$t('admin:rendering.renderWasSupersededNewer')
          return
        }
        if (this.renderPollCount >= this.renderPollLimit) {
          this.clearRenderPoll()
          this.rendering = false
          this.renderFailed = true
          this.renderNotice = this.$t('admin:rendering.renderStillAcceptedBut')
          return
        }
        this.renderPollCount += 1
        this.clearRenderPoll()
        this.renderPollTimer = setTimeout(() => {
          this.renderPollTimer = null
          void this.pollRenderStatus()
        }, 2_000)
      } catch (error) {
        this.clearRenderPoll()
        if (this.disposed || this.renderReceipt?.effectId !== receipt.effectId) return
        this.rendering = false
        this.renderReview = false
        this.renderFailed = true
        this.renderNotice = this.$t('admin:rendering.renderWasAcceptedBut', { error: getErrorMessage(error), interpolation: { escapeValue: false } })
      }
    },
    async refreshRenderStatus() {
      if (!this.renderReceipt || this.rendering || this.disposed) return
      this.renderPollCount = 0
      this.renderFailed = false
      this.renderNotice = this.$t('admin:rendering.checkingRenderReceipt')
      this.rendering = true
      await this.pollRenderStatus()
    },
    async rerender() {
      if (!this.output || this.busy || this.dirty || this.renderPending) return
      const id = this.output.page.id
      this.clearRenderPoll()
      this.rendering = true
      this.renderReview = true
      this.renderNotice = ''
      this.renderNoticeFor = id
      this.renderFailed = false
      this.renderReceipt = null
      this.renderStatus = null
      this.renderPollCount = 0
      try {
        const receipt = await renderPage(window.fetch.bind(window), id)
        if (this.disposed) return
        this.renderReceipt = receipt
        this.renderNotice = this.$t('admin:rendering.renderWasAcceptedQueued')
        this.renderReview = false
        await this.pollRenderStatus()
      } catch (error) {
        if (this.disposed) return
        this.rendering = false
        this.renderReview = false
        this.renderFailed = true
        this.renderNotice = this.$t('admin:rendering.renderRequestOutcomeUnknown', { error: getErrorMessage(error), interpolation: { escapeValue: false } })
      }
    },
    exportOutput() {
      if (!this.output) return
      const url = URL.createObjectURL(new Blob([this.output.html], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `page-${this.output.page.id}-rendered-html.txt`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
    },
    beforeUnload(event: BeforeUnloadEvent) {
      if (this.dirty || this.busy || this.renderPending) {
        event.preventDefault()
        event.returnValue = ''
      }
    },
  },
  watch: {
    '$route.hash'(value: string) { const key = value.slice(1); if (this.tabs.some(tab => tab.key === key)) { this.section = key; if (key === 'output') this.loadPages() } },
    '$route.query.format'(value: unknown) { if (typeof value === 'string' && this.formats.includes(value)) this.planFormat = value },
    '$route.query.page'(value: unknown) { const id = Number(value); const next = Number.isSafeInteger(id) && id > 0 ? id : null; if (next !== this.pageId && !this.rendering && !this.renderPending) { this.pageId = next; this.inspectOutput() } }
  },
  async beforeRouteLeave() { return !this.busy && !this.renderPending && (!this.dirty || await confirmDiscard(this.$t('admin:rendering.discardUnsavedRenderingConfiguration'))) },
  mounted() { const key = this.$route.hash.slice(1); if (this.tabs.some(tab => tab.key === key)) this.section = key; const selected = this.$route.query.module; if (typeof selected === 'string') this.selectedKey = selected; const format = this.$route.query.format; if (typeof format === 'string') this.planFormat = format; this.reload(); if (this.section === 'output') { this.loadPages(); const id = Number(this.$route.query.page); if (Number.isSafeInteger(id) && id > 0) { this.pageId = id; this.inspectOutput() } } window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { this.disposed = true; this.clearRenderPoll(); this.outputSequence++; window.removeEventListener('beforeunload', this.beforeUnload) }
}
</script>
<style lang="scss" scoped>
.rendering-workspace, .rendering-review { min-width: 0; color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
.rendering-eyebrow { display: block; font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); }
.rendering-summary { display: flex; flex-wrap: wrap; gap: .75rem 2rem; padding: .75rem 0; margin-bottom: 1rem; border-bottom: 1px solid var(--wiki-surface-border); }
.rendering-summary > div { display: flex; align-items: baseline; gap: .5rem; }
.rendering-summary dt, .rendering-summary small { font-size: .75rem; color: var(--wiki-text-muted); }
.rendering-summary dd { margin: 0; font-size: .875rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.rendering-tabs-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; border-bottom: 1px solid var(--wiki-surface-border); margin-bottom: 1rem; }
.rendering-tabs { display: flex; flex-wrap: wrap; gap: .25rem; }
.rendering-tabs button { min-height: 44px; color: var(--wiki-text-muted); border: 0; border-bottom: 2px solid transparent; background: transparent; padding: .65rem .75rem; font-size: .8125rem; }
.rendering-tabs button[aria-selected=true] { color: inherit; border-bottom-color: var(--wiki-primary-ink); font-weight: 650; }
.rendering-draft-state { margin-inline-start: auto; color: var(--wiki-text-muted); font-size: .75rem; }
.rendering-error-link { border: 0; background: transparent; color: inherit; text-align: start; font-size: .8125rem; line-height: 1.6; min-height: 44px; text-decoration: underline; max-width: 100%; overflow-wrap: anywhere; }
.rendering-workspace button:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.rendering-modules { display: grid; grid-template-columns: minmax(250px,330px) minmax(0,1fr); gap: 1rem; align-items: start; }
.rendering-directory { min-width: 0; padding: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.rendering-directory-heading { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .75rem; }
.rendering-directory-heading h3 { font-size: 1rem; font-weight: 650; }
.rendering-directory-heading span { font-size: .75rem; color: var(--wiki-text-muted); }
.rendering-directory-filters { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: .5rem; margin: .75rem 0; }
.rendering-records { display: grid; max-height: 600px; overflow-y: auto; padding: 2px; }
.rendering-record { display: flex; align-items: center; text-align: start; gap: .5rem; padding: .75rem .5rem; min-height: 44px; border: 1px solid transparent; border-bottom-color: var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: transparent; color: inherit; width: 100%; min-width: 0; }
.rendering-record:hover, .rendering-record.is-selected { background: var(--wiki-surface-sunken); }
.rendering-record.is-selected { border-color: var(--wiki-primary-ink); }
.rendering-record > span:first-of-type { min-width: 0; flex: 1; }
.rendering-record strong { display: block; font-size: .8125rem; font-weight: 600; }
.rendering-record small { display: block; font-size: .75rem; color: var(--wiki-text-muted); margin-top: .2rem; }
.rendering-record-state { font-size: .75rem; color: var(--wiki-text-muted); max-width: 5rem; }
.rendering-record-state.is-enabled { color: inherit; }
.rendering-change-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--wiki-primary-ink); flex-shrink: 0; }
.rendering-directory-footer { display: grid; justify-items: start; border-top: 1px solid var(--wiki-surface-border); margin-top: .75rem; padding-top: .75rem; gap: .5rem; }
.rendering-directory-footer span { font-size: .75rem; color: var(--wiki-text-muted); line-height: 1.6; }
.rendering-module-detail { min-width: 0; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: 1rem; }
.rendering-module-heading { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: .75rem; }
.rendering-module-heading > div { flex: 1 1 220px; min-width: 0; }
.rendering-module-heading h3 { display: flex; align-items: center; gap: .5rem; font-size: 1.125rem; font-weight: 650; line-height: 1.4; margin: .35rem 0; }
.rendering-module-heading h3 .v-icon { flex-shrink: 0; }
.rendering-module-heading p { font-size: .8125rem; color: var(--wiki-text-muted); line-height: 1.6; margin: 0; }
.rendering-module-heading :deep(.v-switch) { max-width: 100%; }
.rendering-module-context { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .75rem; padding: .75rem 0; border-block: 1px solid var(--wiki-surface-border); margin: 1rem 0; }
.rendering-module-context span { display: block; font-size: .75rem; color: var(--wiki-text-muted); margin-bottom: .25rem; }
.rendering-module-context strong, .rendering-module-context button { font-size: .8125rem; font-weight: 600; }
.rendering-module-context button { color: var(--wiki-primary-ink); border: 0; background: transparent; text-align: start; min-height: 44px; }
.rendering-section-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: .75rem; margin-bottom: .75rem; }
.rendering-section-heading h3, .rendering-section-heading h4 { font-size: 1rem; font-weight: 650; margin: .35rem 0; }
.rendering-section-heading p { margin: 0; font-size: .8125rem; color: var(--wiki-text-muted); line-height: 1.6; }
.rendering-properties { display: grid; gap: 1rem; padding: .5rem 0; max-width: 740px; }
.rendering-property { min-width: 0; }
.rendering-property :deep(.v-input__details) { padding-inline: 0; padding-top: .5rem; }
.rendering-property :deep(.v-messages) { line-height: 1.6; font-size: .75rem; }
.rendering-render-receipt { margin-top: .5rem; font-size: .75rem; color: var(--wiki-text-muted); }
.rendering-empty, .rendering-footnote { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; margin: .75rem 0; }
.rendering-module-issues { border-top: 1px solid var(--wiki-surface-border); margin-top: 1rem; padding-top: .5rem; }
.rendering-module-issues p { display: flex; align-items: flex-start; gap: .5rem; font-size: .8125rem; line-height: 1.6; margin: .5rem 0; }
.rendering-module-issues .v-icon { flex-shrink: 0; }
.rendering-module-issues .is-error { color: var(--wiki-error-ink, rgb(var(--v-theme-on-surface))); }
.rendering-behavior { background: var(--wiki-surface-sunken); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); padding: .75rem; margin: 1rem 0; }
.rendering-behavior p { font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); margin: .35rem 0 0; }
.rendering-module-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; border-top: 1px solid var(--wiki-surface-border); padding-top: .75rem; margin-top: 1rem; }
.rendering-module-footer code { font-size: .75rem; color: var(--wiki-text-muted); }
.rendering-segment { display: flex; flex-wrap: wrap; border: 1px solid var(--wiki-surface-border); padding: 3px; border-radius: var(--wiki-control-radius); }
.rendering-segment button { min-height: 44px; border: 0; border-radius: var(--wiki-control-radius); padding: .5rem .75rem; color: var(--wiki-text-muted); background: transparent; font-size: .8125rem; }
.rendering-segment button[aria-pressed=true] { background: var(--wiki-surface-sunken); color: inherit; }
.rendering-format-choices { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
.rendering-format-choices button { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; min-height: 44px; padding: .65rem .75rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); background: var(--wiki-surface-raised); color: inherit; text-align: start; }
.rendering-format-choices button[aria-pressed=true] { border-color: var(--wiki-primary-ink); background: var(--wiki-surface-sunken); }
.rendering-format-choices span { font-size: .875rem; font-weight: 600; }
.rendering-format-choices small { font-size: .75rem; color: var(--wiki-text-muted); }
.rendering-trace-layout { display: grid; grid-template-columns: minmax(0,2fr) minmax(240px,1fr); gap: 1rem; align-items: start; }
.rendering-trace { display: grid; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); overflow: hidden; background: var(--wiki-surface-raised); }
.rendering-trace-bookend { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem; background: var(--wiki-surface-sunken); color: var(--wiki-text-muted); font-size: .8125rem; }
.rendering-trace-bookend small { margin-inline-start: auto; font-size: .75rem; }
.rendering-stage { border-block: 1px solid var(--wiki-surface-border); padding: 1rem; }
.rendering-stage-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; }
.rendering-stage-heading > div { flex: 1 1 150px; min-width: 0; }
.rendering-stage-heading h4 { font-size: 1rem; font-weight: 650; margin: .25rem 0 0; }
.rendering-stage-number { color: var(--wiki-text-muted); font: .75rem var(--wiki-font-mono); }
.rendering-stage-group { margin-top: .75rem; }
.rendering-stage-group h5 { font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); margin: 0 0 .5rem; }
.rendering-stage-group > div { display: flex; flex-wrap: wrap; gap: .5rem; }
.rendering-stage-group button { min-height: 44px; border: 1px solid var(--wiki-surface-border); background: transparent; color: inherit; border-radius: var(--wiki-control-radius); padding: .5rem .65rem; font-size: .8125rem; text-align: start; }
.rendering-stage-group ol { padding-inline-start: 1.25rem; font-size: .8125rem; }
.rendering-stage-group li { padding: .25rem 0; }
.rendering-stage-group small { margin-inline-start: .5rem; color: var(--wiki-text-muted); font-size: .75rem; }
.rendering-stage-core { display: flex; align-items: flex-start; gap: .5rem; font-size: .8125rem; color: var(--wiki-text-muted); line-height: 1.6; padding-top: .75rem; }
.rendering-pipeline-notes { display: grid; gap: .75rem; }
.rendering-pipeline-notes section { border-top: 1px solid var(--wiki-surface-border); padding: .75rem 0; }
.rendering-pipeline-notes h4 { font-size: .875rem; font-weight: 650; margin: .35rem 0; }
.rendering-pipeline-notes p, .rendering-pipeline-notes li { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; }
.rendering-pipeline-notes ul { padding-inline-start: 1rem; }
.rendering-pipeline-notes li { margin-bottom: .5rem; }
.rendering-pipeline-notes button:not(.v-btn) { min-height: 44px; color: inherit; border: 0; background: transparent; text-align: start; text-decoration: underline; }
.rendering-no-pipeline { padding: 1rem; }
.rendering-no-pipeline h4 { font-size: 1rem; }
.rendering-no-pipeline p { font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); }
.rendering-output-picker { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.rendering-output-picker :deep(.v-input) { min-width: 0; flex: 1 1 250px; }
.rendering-output-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .75rem; }
.rendering-output-heading > div { min-width: 0; flex: 1 1 250px; }
.rendering-output-heading h4 { font-size: 1.125rem; font-weight: 650; margin: .35rem 0; }
.rendering-output-heading p { font-size: .75rem; color: var(--wiki-text-muted); margin: 0; }
.rendering-output-stats { display: flex; flex-wrap: wrap; gap: .75rem 2rem; padding: .75rem 0; margin: 1rem 0; border-block: 1px solid var(--wiki-surface-border); }
.rendering-output-stats dt { color: var(--wiki-text-muted); font-size: .75rem; }
.rendering-output-stats dd { margin: .25rem 0 0; font-size: .875rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.rendering-output-stats small { font-size: .75rem; }
.rendering-output-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.rendering-isolated-preview { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); overflow: hidden; }
.rendering-isolated-preview p { font-size: .75rem; color: var(--wiki-text-muted); line-height: 1.6; margin: 0; padding: .75rem 1rem; background: var(--wiki-surface-sunken); border-bottom: 1px solid var(--wiki-surface-border); }
.rendering-isolated-preview iframe { display: block; width: 100%; height: 600px; border: 0; background: #fff; }
.rendering-html { margin: 0; padding: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-sunken); max-height: 650px; overflow: auto; white-space: pre-wrap; font: .8125rem/1.7 var(--wiki-font-mono); }
.rendering-outline ol { list-style: none; padding: 0; margin: 1rem 0; }
.rendering-outline li { display: flex; gap: .75rem; flex-wrap: wrap; align-items: baseline; padding-block: .75rem; border-bottom: 1px solid var(--wiki-surface-border); }
.rendering-outline span, .rendering-outline code { color: var(--wiki-text-muted); font-size: .75rem; }
.rendering-outline strong { font-size: .8125rem; font-weight: 600; }
.rendering-output-welcome { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: 1.5rem; background: var(--wiki-surface-sunken); }
.rendering-output-welcome h4 { font-size: 1rem; font-weight: 650; margin: .75rem 0 .35rem; }
.rendering-output-welcome p { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; margin: 0; }
.rendering-review-heading { padding: 1rem 1rem .5rem; }
.rendering-review-heading h3 { font-size: 1.125rem; font-weight: 650; margin: .35rem 0; line-height: 1.4; }
.rendering-review-heading p { font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); margin: 0; }
.rendering-change-list { display: grid; gap: .75rem; max-height: 330px; overflow: auto; }
.rendering-change-list h4 { font-size: .875rem; font-weight: 650; margin: 0 0 .35rem; }
.rendering-change-list ul { padding-inline-start: 1rem; margin: 0; font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); }
.rendering-review-checks { padding-top: .75rem; margin-top: .75rem; border-top: 1px solid var(--wiki-surface-border); }
.rendering-review-checks h4 { font-size: .875rem; }
.rendering-review-checks p { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; margin: .5rem 0; }
.rendering-review :deep(.v-card-actions) { flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem; border-top: 1px solid var(--wiki-surface-border); }
.rendering-workspace :deep(.v-btn), .rendering-review :deep(.v-btn) { max-width: 100%; height: auto; }
.rendering-workspace :deep(.v-btn__content), .rendering-review :deep(.v-btn__content) { white-space: normal; padding-block: .4rem; }
@media(max-width:599px) { .rendering-workspace :deep(.v-btn), .rendering-review :deep(.v-btn) { min-height: 44px; } }
@media(max-width:1100px) { .rendering-draft-state { flex-basis: 100%; margin: .5rem 0; } .rendering-trace-layout { grid-template-columns: 1fr; } }
@media(max-width:840px) { .rendering-modules { grid-template-columns: 1fr; } .rendering-records { max-height: 260px; } }
@media(max-width:599px) { .rendering-module-context, .rendering-directory-filters { grid-template-columns: 1fr; } .rendering-tabs button { padding-inline: .5rem; } .rendering-stage-group small { display: block; margin: .25rem 0; } }
</style>

<template>
  <v-container fluid class="rendering-workspace">
    <admin-hero title="Rendering" description="From authored source to the reading experience." icon="mdi-text-box-edit-outline">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy || reviewOpen" @click="reload">Reload saved configuration</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!dirty || busy || loading || errors.length > 0" @click="openReview">Review changes</v-btn>
      </template>
    </admin-hero>
    <section class="rendering-intro">
      <div><span class="rendering-eyebrow">The publishing layer</span><h2>Give every format a clear path.</h2><p>Configure the transformations behind your pages, follow their dependencies, and inspect what readers receive.</p></div>
      <dl><div><dt>Enabled in draft</dt><dd>{{ saved ? enabledCount : '—' }}<small v-if="saved"> / {{ draft.length }}</small></dd></div><div><dt>Source formats</dt><dd>{{ saved ? formats.length : '—' }}</dd></div><div><dt>Existing pages</dt><dd>{{ saved ? totalPages : '—' }}</dd></div></dl>
    </section>
    <v-alert v-if="success" type="success" variant="tonal" closable class="mb-4" @click:close="success = ''">{{ success }}</v-alert>
    <async-state v-if="loading" state="loading" title="Reading the rendering workspace" message="Loading installed modules, saved settings and format usage." />
    <async-state v-else-if="loadError" state="error" title="Rendering configuration is unavailable" :message="loadError" retry-label="Try again" @retry="reload" />
    <template v-else-if="saved">
      <v-alert v-if="errors.length" type="error" variant="tonal" class="mb-4"><strong>Correct {{ errors.length }} configuration {{ errors.length === 1 ? 'value' : 'values' }} before saving.</strong><div v-for="issue in errors" :key="issue.key + issue.message"><button class="rendering-error-link" @click="configure(issue.key)">{{ issue.message }}</button></div></v-alert>
      <div class="rendering-tabs-row">
        <div role="tablist" aria-label="Rendering workspace sections" class="rendering-tabs">
          <button v-for="tab in tabs" :id="`rendering-tab-${tab.key}`" :key="tab.key" role="tab" :aria-controls="`rendering-panel-${tab.key}`" :aria-selected="section === tab.key" :tabindex="section === tab.key ? 0 : -1" @click="setSection(tab.key)" @keydown="tabKey($event, tab.key)">{{ tab.title }}</button>
        </div>
        <span class="rendering-draft-state" aria-live="polite">{{ dirty ? `${changes.length} modules changed` : 'Matches saved configuration' }}</span>
      </div>
      <section v-show="section === 'modules'" id="rendering-panel-modules" role="tabpanel" aria-labelledby="rendering-tab-modules" class="rendering-modules">
        <aside class="rendering-directory">
          <div class="rendering-directory-heading"><h3>Module library</h3><span>{{ filteredModules.length }}</span></div>
          <v-text-field v-model="query" label="Find a module" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable />
          <div class="rendering-directory-filters">
            <v-select v-model="family" :items="familyOptions" label="Module family" variant="outlined" density="compact" hide-details />
            <v-select v-model="filter" :items="stateOptions" label="Module state" variant="outlined" density="compact" hide-details />
          </div>
          <div class="rendering-records" aria-label="Rendering modules">
            <button v-for="module in filteredModules" :key="module.key" class="rendering-record" :class="{ 'is-selected': selectedKey === module.key }" :aria-pressed="selectedKey === module.key" @click="select(module.key)">
              <v-icon :icon="module.icon" size="20" /><span><strong>{{ title(module) }}</strong><small>{{ module.dependsOn ? familyTitle(module) : 'Core parser' }}</small></span><span class="rendering-record-state" :class="{ 'is-enabled': effective(module) }">{{ state(module) }}</span><span v-if="moduleChanged(module.key)" class="rendering-change-dot" aria-label="Unsaved changes" />
            </button>
          </div>
          <p v-if="!filteredModules.length" class="rendering-empty">No modules match. Try another name, family or state.</p>
          <div class="rendering-directory-footer"><span>Enabled modules can be paused by a disabled core.</span><v-btn variant="text" size="small" :disabled="!dirty || busy || reviewOpen" @click="reset">Reset all drafts</v-btn></div>
        </aside>
        <article v-if="current" class="rendering-module-detail">
          <header class="rendering-module-heading">
            <div><span class="rendering-eyebrow">{{ current.dependsOn ? familyTitle(current) + ' extension' : 'Source parser' }}</span><h3><v-icon :icon="current.icon" size="28" />{{ title(current) }}</h3><p>{{ current.description }}</p></div>
            <v-switch v-model="current.isEnabled" :label="`${title(current)} enabled`" color="primary" hide-details density="compact" :disabled="busy || reviewOpen" />
          </header>
          <div class="rendering-module-context">
            <div><span>Effective in draft</span><strong>{{ state(current) }}</strong></div>
            <div><span>{{ current.dependsOn ? 'Requires' : 'Transformation' }}</span><button v-if="current.dependsOn" @click="select(current.dependsOn)">{{ parentTitle(current) }} <v-icon icon="mdi-arrow-top-right" size="14" /></button><strong v-else>{{ format(current.input || '') }} → {{ format(current.output || '') }}</strong></div>
            <div><span>{{ (current.dependsOn || current.key) === 'htmlCore' ? 'Pages across source formats' : 'Stored pages in this format' }}</span><strong>{{ usageCount(current) }}</strong></div>
          </div>
          <v-alert v-if="current.isEnabled && !effective(current)" type="warning" variant="tonal" class="mb-5">This extension is configured as enabled, but its core is disabled. It resumes when the core is enabled.</v-alert>
          <div class="rendering-section-heading"><div><span class="rendering-eyebrow">Configuration</span><h4>{{ properties.length ? 'Tune the transformation' : 'One switch. No extra settings.' }}</h4></div><v-btn size="small" variant="text" :disabled="!moduleChanged(current.key) || busy || reviewOpen" @click="resetModule">Reset this module</v-btn></div>
          <p v-if="!properties.length" class="rendering-empty">This module has no configurable options. Its enabled state determines whether it participates in the pipeline.</p>
          <div v-else class="rendering-properties">
            <div v-for="[key, prop] in properties" :key="key" class="rendering-property">
              <v-switch v-if="prop.type === 'boolean'" v-model="current.config[key]" :label="prop.title || key" :hint="prop.hint" persistent-hint color="primary" :disabled="busy || reviewOpen" />
              <v-select v-else-if="prop.enum" :model-value="String(current.config[key] ?? '')" @update:model-value="current.config[key] = $event" :items="prop.enum" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" />
              <v-text-field v-else-if="prop.type === 'number'" :model-value="String(current.config[key] ?? '')" type="number" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" @update:model-value="current.config[key] = $event === '' || $event == null ? null : Number($event)" />
              <v-text-field v-else v-model="current.config[key]" :label="prop.title || key" :hint="prop.hint" persistent-hint variant="outlined" density="comfortable" :disabled="busy || reviewOpen" />
            </div>
          </div>
          <div v-if="moduleIssues.length" class="rendering-module-issues"><p v-for="issue in moduleIssues" :key="issue.message" :class="{ 'is-error': issue.severity === 'error' }"><v-icon :icon="issue.severity === 'error' ? 'mdi-alert-circle-outline' : 'mdi-information-outline'" size="18" />{{ issue.message }}</p></div>
          <section v-if="externalBehavior" class="rendering-behavior"><span class="rendering-eyebrow">Content and connections</span><p>{{ externalBehavior }}</p></section>
          <footer class="rendering-module-footer"><code>{{ current.key }}</code><v-btn variant="text" size="small" append-icon="mdi-arrow-right" @click="inspectFamily">Follow this pipeline</v-btn></footer>
        </article>
        <async-state v-else state="empty" title="Choose a rendering module" message="Select an installed parser or extension to inspect its behavior." />
      </section>
      <section v-show="section === 'pipeline'" id="rendering-panel-pipeline" role="tabpanel" aria-labelledby="rendering-tab-pipeline" class="rendering-pipeline-panel">
        <div class="rendering-section-heading"><div><span class="rendering-eyebrow">Follow the transformation</span><h3>Source in. Reader output out.</h3><p>This is the effective configured path, not a live render test.</p></div><div class="rendering-segment" role="group" aria-label="Pipeline configuration"><button :aria-pressed="planMode === 'draft'" @click="planMode = 'draft'">Draft</button><button :aria-pressed="planMode === 'saved'" @click="planMode = 'saved'">Saved</button></div></div>
        <div class="rendering-format-choices" role="group" aria-label="Source format"><button v-for="value in formats" :key="value" :aria-pressed="planFormat === value" @click="setPlanFormat(value)"><span>{{ format(value) }}</span><small>{{ formatUsage(value) }} pages</small><v-icon icon="mdi-arrow-right" size="18" /></button></div>
        <div class="rendering-trace-layout">
          <div class="rendering-trace">
            <div class="rendering-trace-bookend"><v-icon icon="mdi-file-document-outline" size="21" /><span>{{ format(planFormat) }} source</span></div>
            <article v-for="(stage, index) in plan" :key="stage.core.key" class="rendering-stage">
              <div class="rendering-stage-heading"><span class="rendering-stage-number">{{ String(index + 1).padStart(2, '0') }}</span><div><span class="rendering-eyebrow">{{ format(stage.core.input || '') }} → {{ format(stage.core.output || '') }}</span><h4>{{ title(stage.core) }}</h4></div><v-btn variant="text" size="small" @click="configure(stage.core.key)">Configure</v-btn></div>
              <div v-if="stage.before.length" class="rendering-stage-group"><h5>{{ stage.core.key === 'htmlCore' ? 'Before HTML finalization' : 'Parser extensions' }}</h5><div><button v-for="module in stage.before" :key="module.key" @click="configure(module.key)">{{ title(module) }}</button></div></div>
              <div v-if="stage.core.key === 'htmlCore'" class="rendering-stage-core"><v-icon icon="mdi-link-variant" size="18" /><span>Resolve links, mark page references, add heading anchors and wrap tables.</span></div>
              <div v-if="stage.after.length" class="rendering-stage-group"><h5>Post-processors · execution order</h5><ol><li v-for="module in stage.after" :key="module.key"><button @click="configure(module.key)">{{ title(module) }}</button><small>{{ module.order === Number.MAX_SAFE_INTEGER ? 'Default order' : 'Order ' + module.order }}</small></li></ol></div>
            </article>
            <div v-if="!plan.length" class="rendering-no-pipeline"><h4>No enabled parser for {{ format(planFormat) }}.</h4><p>The render worker cannot update this page’s output until a parser is enabled.</p></div>
            <div class="rendering-trace-bookend"><v-icon icon="mdi-text-box-check-outline" size="21" /><span>{{ plan.length ? format(plan.at(-1)!.core.output || '') + ' output' : 'No output update' }}</span><small>{{ plan.length ? 'Stored for readers' : 'Existing output stays in place' }}</small></div>
          </div>
          <aside class="rendering-pipeline-notes">
            <section><span class="rendering-eyebrow">Configuration checks</span><h4>{{ planIssues.length ? `${planIssues.length} points to review` : 'No configuration issues detected' }}</h4><p v-if="!planIssues.length">The selected path has an enabled parser and HTML post-processing. This does not measure rendering success or service availability.</p><ul v-else><li v-for="issue in planIssues" :key="issue.key + issue.message"><button @click="configure(issue.key)">{{ issue.message }}</button></li></ul></section>
            <section><span class="rendering-eyebrow">When changes take effect</span><h4>The next render uses saved settings.</h4><p>Saving configuration does not rewrite existing page output. New edits trigger rendering through the page workflow. The authoring preview can differ from the published result. Inspect stored output or explicitly re-render a page to verify saved settings.</p><v-btn size="small" variant="text" append-icon="mdi-arrow-right" @click="setSection('output')">Inspect a page</v-btn></section>
          </aside>
        </div>
      </section>
      <section v-show="section === 'output'" id="rendering-panel-output" role="tabpanel" aria-labelledby="rendering-tab-output" class="rendering-output-panel">
        <div class="rendering-section-heading"><div><span class="rendering-eyebrow">Inspect the result</span><h3>See what is already stored.</h3><p>Choose a page to inspect its rendered HTML, heading structure and link markers.</p></div></div>
        <div class="rendering-output-picker"><v-autocomplete v-model="pageId" :items="pageOptions" label="Page to inspect" :loading="pagesLoading" variant="outlined" density="comfortable" hide-details clearable :disabled="rendering || renderPending" @update:model-value="inspectOutput" /><v-btn variant="tonal" prepend-icon="mdi-refresh" :disabled="!pageId || outputLoading || rendering || renderPending" @click="inspectOutput">Reload output</v-btn></div>
        <v-alert v-if="pagesError" type="error" variant="tonal" class="mb-4">{{ pagesError }}<v-btn variant="text" size="small" @click="loadPages">Retry page directory</v-btn></v-alert>
        <v-alert v-if="renderNotice && pageId === renderNoticeFor" :type="renderFailed || renderPending ? 'warning' : 'success'" variant="tonal" class="my-4">
          {{ renderNotice }}
          <div v-if="renderReceipt" class="rendering-render-receipt">Receipt {{ renderReceipt.effectId }} · {{ renderStatus ? `Status: ${renderStatus.status}` : 'Status: unknown' }}</div>
          <v-btn v-if="renderReceipt && !rendering && renderPending" variant="text" size="small" prepend-icon="mdi-refresh" @click="refreshRenderStatus">Refresh render status</v-btn>
        </v-alert>
        <async-state v-if="outputLoading" state="loading" title="Reading stored output" message="Checking page access and loading the saved render." />
        <async-state v-else-if="outputError" state="error" title="Stored output could not be read" :message="outputError" retry-label="Try again" @retry="inspectOutput" />
        <div v-else-if="output" class="rendering-output-workspace">
          <header class="rendering-output-heading"><div><span class="rendering-eyebrow">{{ output.page.visibility === 'private' ? 'Private page' : 'Workspace page' }} · {{ format(output.page.contentType) }}</span><h4>{{ output.page.title }}</h4><p>{{ output.page.locale }}/{{ output.page.path }} · Current source revision {{ output.page.sourceRevision }}</p></div><v-btn variant="outlined" :disabled="rendering || renderPending || dirty" :loading="rendering" @click="renderReview = true">Re-render this page</v-btn></header>
          <p class="rendering-footnote">This is stored output, not a preview of your draft settings. Its rendering configuration and source revision were not recorded with the HTML. {{ dirty ? 'Save or reset your configuration draft before re-rendering.' : 'Re-rendering runs the saved pipeline and replaces stored output without editing page source.' }}</p>
          <dl class="rendering-output-stats"><div><dt>HTML size</dt><dd>{{ (output.bytes / 1024).toFixed(1) }} <small>KiB</small></dd></div><div><dt>Headings</dt><dd>{{ output.headings.length }}</dd></div><div><dt>Internal links</dt><dd>{{ output.links.internal }}</dd></div><div><dt>Unresolved markers</dt><dd>{{ output.links.unresolved }}</dd></div><div><dt>Images / frames</dt><dd>{{ output.images }} / {{ output.frames }}</dd></div></dl>
          <div class="rendering-output-toolbar"><div class="rendering-segment" role="group" aria-label="Stored output view"><button v-for="mode in outputModes" :key="mode.key" :aria-pressed="outputMode === mode.key" @click="outputMode = mode.key">{{ mode.title }}</button></div><v-btn size="small" variant="text" prepend-icon="mdi-download" @click="exportOutput">Export HTML as text</v-btn></div>
          <div v-if="outputMode === 'preview'" class="rendering-isolated-preview"><p>Structure preview: scripts, links, forms and external resources are disabled. Page theme styles and interactive extensions are not reproduced.</p><iframe title="Isolated stored page output" sandbox="" referrerpolicy="no-referrer" :srcdoc="previewDocument" /></div>
          <pre v-else-if="outputMode === 'html'" class="rendering-html" tabindex="0" aria-label="Stored HTML source"><code>{{ output.html || 'No rendered HTML is stored for this page.' }}</code></pre>
          <div v-else class="rendering-outline"><p class="rendering-footnote">Unresolved link markers reflect the last render and may include pages unavailable in that page’s visibility scope.</p><ol v-if="output.headings.length"><li v-for="(heading, index) in output.headings" :key="index" :style="{ paddingLeft: `${Math.min(heading.level - 1, 3) * .8}rem` }"><span>H{{ heading.level }}</span><strong>{{ heading.text || '(Empty heading)' }}</strong><code>{{ heading.id ? '#' + heading.id : 'No anchor' }}</code></li></ol><p v-else class="rendering-empty">No headings were found in this stored output.</p></div>
        </div>
        <div v-else class="rendering-output-welcome"><v-icon icon="mdi-text-box-search-outline" size="42" /><h4>A page’s output, made inspectable.</h4><p>The inspector reads stored HTML without creating a page or contacting rendering providers.</p></div>
      </section>
    </template>
    <v-dialog v-model="reviewOpen" max-width="760" :persistent="saving" aria-labelledby="rendering-review-title">
      <v-card class="rendering-review"><div class="rendering-review-heading"><span class="rendering-eyebrow">Review configuration</span><h3 id="rendering-review-title">{{ changes.length }} modules will change.</h3><p>The saved configuration applies to future renders. Existing page output stays in place until rendered again.</p></div><v-card-text>
        <div class="rendering-change-list"><article v-for="change in changes" :key="change.key"><h4>{{ change.title }}</h4><ul><li v-for="line in change.lines" :key="line">{{ line }}</li></ul></article></div>
        <div v-if="issues.length" class="rendering-review-checks"><h4>Review the resulting configuration</h4><p v-for="issue in issues" :key="issue.key + issue.message">{{ issue.message }}</p><v-checkbox v-model="acknowledged" label="I have reviewed these configuration effects." hide-details :disabled="saving" /></div>
        <v-alert v-if="saveError" type="error" variant="tonal" class="mt-4">{{ saveError }}<div><v-btn variant="text" size="small" :disabled="saving" @click="reloadReview">Reload saved configuration</v-btn></div></v-alert>
      </v-card-text><v-card-actions><v-btn variant="text" :disabled="saving" @click="reviewOpen = false">Cancel</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="saving" :disabled="saving || errors.length > 0 || (issues.length > 0 && !acknowledged)" @click="save">Save configuration</v-btn></v-card-actions></v-card>
    </v-dialog>
    <v-dialog v-model="renderReview" max-width="600" :persistent="rendering" aria-labelledby="rendering-run-title"><v-card class="rendering-review"><div class="rendering-review-heading"><span class="rendering-eyebrow">Run the saved pipeline</span><h3 id="rendering-run-title">Re-render this page?</h3><p>{{ output?.page.title }} will receive fresh stored output. Source, ownership and publication settings stay intact. Enabled provider modules may contact external services. Leaving this page does not cancel the server job.</p></div><v-card-actions><v-btn variant="text" :disabled="rendering" @click="renderReview = false">Cancel</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="rendering" :disabled="rendering || renderPending || dirty" @click="rerender">Re-render page</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>
<script lang="ts">
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
      tabs: [{ key: 'modules', title: 'Modules' }, { key: 'pipeline', title: 'Pipeline' }, { key: 'output', title: 'Stored output' }],
      stateOptions: [{ title: 'All states', value: 'all' }, { title: 'Active', value: 'active' }, { title: 'Disabled', value: 'disabled' }, { title: 'Paused by core', value: 'paused' }, { title: 'Changed', value: 'changed' }],
      planMode: 'draft', planFormat: 'markdown', pageId: null as number | null, pages: [] as PageListRow[], pagesLoading: false, pagesLoaded: false, pagesError: '', outputLoading: false, outputError: '', outputSequence: 0, output: null as RenderingOutput | null,
      outputMode: 'preview', outputModes: [{ key: 'preview', title: 'Structure preview' }, { key: 'html', title: 'HTML source' }, { key: 'outline', title: 'Outline & links' }], rendering: false, renderReview: false, renderNotice: '', renderNoticeFor: null as number | null, renderFailed: false,
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
    familyOptions() { return [{ title: 'All families', value: 'all' }, ...this.draft.filter(module => !module.dependsOn).map(module => ({ title: formatTitle(module.input || ''), value: module.key }))] },
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
        if (prior.isEnabled !== module.isEnabled) lines.push(`${prior.isEnabled ? 'Enabled' : 'Disabled'} → ${module.isEnabled ? 'Enabled' : 'Disabled'}`)
        for (const [key, prop] of Object.entries(module.props)) if (!same(prior.config[key], module.config[key])) lines.push(`${prop.title || key}: ${String(prior.config[key])} → ${String(module.config[key])}`)
        return { key: module.key, title: this.title(module), lines }
      })
    },
    externalBehavior(): string {
      return ({ markdownPlantuml: 'Diagram source is encoded into URLs for the configured PlantUML server. Readers can request those URLs; enabled image prefetch can request them during server rendering.', markdownKroki: 'Diagram source is encoded into URLs for the configured Kroki server. Readers can request those URLs; enabled image prefetch can request them during server rendering.', htmlImagePrefetch: 'Downloads images marked by trusted diagram renderers and embeds them in the output. This can send diagram source to the configured provider during rendering. Unmarked remote images are not prefetched.', htmlMediaplayers: 'Recognized media links can become embedded third-party players. Loading the published page can contact their providers.', htmlAsciinema: 'Compatible links become embedded terminal recordings. The reader can load content from the recording provider.', asciidocCore: 'The AsciiDoc safety mode controls processing privileges, including file and include behavior. Choose the least permissive mode that supports your content.' } as Record<string, string>)[this.selectedKey] ?? ''
    },
    pageOptions() { return this.pages.map(page => ({ title: `${page.title} · ${page.locale}/${page.path}${page.visibility === 'private' ? ' · Private' : ''}`, value: page.id })) },
    previewDocument(): string { return buildStoredOutputPreview(this.output?.html ?? '', this.$vuetify.theme.current.dark) }
  },
  methods: {
    title: rendererTitle, format: formatTitle,
    effective(module: RenderingModule): boolean { return module.isEnabled && (!module.dependsOn || this.draft.some(parent => parent.key === module.dependsOn && parent.isEnabled)) },
    state(module: RenderingModule): string { return !module.isEnabled ? 'Disabled' : this.effective(module) ? 'Active' : 'Paused' },
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
      if (this.busy || this.loading || this.disposed || (this.dirty && !window.confirm('Discard all rendering drafts and reload saved configuration?'))) return
      this.loading = true; this.loadError = ''
      try { const result = await fetchRenderingWorkspace(); if (this.disposed) return; this.saved = result; this.reset(); if (!this.current) this.selectedKey = this.draft[0]?.key || '' } catch (error) { if (!this.disposed) this.loadError = getErrorMessage(error) } finally { if (!this.disposed) this.loading = false }
    },
    openReview() { this.acknowledged = false; this.saveError = ''; this.reviewOpen = true },
    async reloadReview() { if (this.busy || !window.confirm('Discard all rendering drafts and reload saved configuration?')) return; this.reviewOpen = false; this.reset(); await this.reload() },
    async save() {
      if (!this.saved || !this.dirty || this.busy || this.errors.length || (this.issues.length && !this.acknowledged)) return
      this.saving = true; this.saveError = ''
      try { const result = await saveRenderingWorkspace(renderingSettings(this.draft), this.saved.fingerprint); if (this.disposed) return; this.saved = { ...this.saved, ...result }; this.reset(); this.reviewOpen = false; this.success = 'Rendering configuration saved. Future renders will use these settings.' } catch (error) { if (!this.disposed) this.saveError = getErrorMessage(error) } finally { if (!this.disposed) this.saving = false }
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
          throw new Error('The server returned a different render receipt.')
        this.renderStatus = status
        if (status.status === 'succeeded') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = false
          this.renderNotice = 'The render completed. Stored output has been refreshed.'
          await this.inspectOutput()
          return
        }
        if (status.status === 'failed') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = true
          this.renderNotice = 'The render failed. Existing stored output was preserved; no replacement was written.'
          return
        }
        if (status.status === 'superseded') {
          this.clearRenderPoll()
          this.rendering = false
          this.renderReview = false
          this.renderFailed = true
          this.renderNotice = 'The render was superseded by a newer source revision. Existing stored output was preserved.'
          return
        }
        if (this.renderPollCount >= this.renderPollLimit) {
          this.clearRenderPoll()
          this.rendering = false
          this.renderFailed = true
          this.renderNotice = 'The render is still accepted but its completion is not confirmed. Refresh status manually; no automatic retry will be submitted.'
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
        this.renderNotice = `The render was accepted, but its completion status is unknown: ${getErrorMessage(error)}. Refresh status manually; no automatic retry will be submitted.`
      }
    },
    async refreshRenderStatus() {
      if (!this.renderReceipt || this.rendering || this.disposed) return
      this.renderPollCount = 0
      this.renderFailed = false
      this.renderNotice = 'Checking the render receipt…'
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
        this.renderNotice = 'The render was accepted and queued. It has not completed yet.'
        this.renderReview = false
        await this.pollRenderStatus()
      } catch (error) {
        if (this.disposed) return
        this.rendering = false
        this.renderReview = false
        this.renderFailed = true
        this.renderNotice = `The render request outcome is unknown: ${getErrorMessage(error)}. No automatic retry was submitted.`
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
  beforeRouteLeave() { return !this.busy && !this.renderPending && (!this.dirty || window.confirm('Discard the unsaved rendering configuration?')) },
  mounted() { const key = this.$route.hash.slice(1); if (this.tabs.some(tab => tab.key === key)) this.section = key; const selected = this.$route.query.module; if (typeof selected === 'string') this.selectedKey = selected; const format = this.$route.query.format; if (typeof format === 'string') this.planFormat = format; this.reload(); if (this.section === 'output') { this.loadPages(); const id = Number(this.$route.query.page); if (Number.isSafeInteger(id) && id > 0) { this.pageId = id; this.inspectOutput() } } window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { this.disposed = true; this.clearRenderPoll(); this.outputSequence++; window.removeEventListener('beforeunload', this.beforeUnload) }
}
</script>
<style lang="scss" scoped>
.rendering-workspace,.rendering-review { --render-border:rgba(var(--v-theme-on-surface),.13); --render-muted:rgba(var(--v-theme-on-surface),.72); }
.rendering-eyebrow { display:block; font-size:.65rem; font-weight:650; letter-spacing:.13em; text-transform:uppercase; color:var(--render-muted); }
.rendering-intro { display:flex; align-items:center; justify-content:space-between; gap:2rem; padding:1.8rem 0 2rem; h2 { font-size:clamp(1.4rem,2.3vw,1.9rem); line-height:1.2; font-weight:600; letter-spacing:-.04em; margin:.6rem 0; } p { max-width:580px; font-size:.84rem; line-height:1.75; color:var(--render-muted); margin:0; } dl { display:flex; flex-shrink:0; gap:2rem; } dt { font-size:.67rem; color:var(--render-muted); } dd { margin:.5rem 0 0; font-size:1.9rem; font-weight:550; line-height:1; } small { font-size:.8rem; color:var(--render-muted); } }
.rendering-tabs-row { display:flex; align-items:center; border-block:1px solid var(--render-border); margin-bottom:1.6rem; }
.rendering-tabs { display:flex; gap:1rem; button { color:var(--render-muted); border:0; border-bottom:2px solid transparent; background:transparent; padding:.9rem .5rem; font-size:.8rem; &[aria-selected=true] { color:rgb(var(--v-theme-on-surface)); border-bottom-color:rgb(var(--v-theme-primary)); font-weight:650; } } }
.rendering-error-link { border:0; background:transparent; color:inherit; text-align:left; font-size:.78rem; line-height:1.8; padding:.4rem 0; text-decoration:underline; max-width:100%; overflow-wrap:anywhere; }
.rendering-workspace button:focus-visible { outline:2px solid rgb(var(--v-theme-on-surface)); outline-offset:2px; }
.rendering-draft-state { margin-left:auto; color:var(--render-muted); font-size:.68rem; }
.rendering-modules { display:grid; grid-template-columns:minmax(250px,330px) minmax(0,1fr); gap:1.7rem; align-items:start; }
.rendering-directory { min-width:0; }
.rendering-directory-heading { display:flex; justify-content:space-between; align-items:center; margin:.2rem 0 1rem; h3 { font-size:1rem; font-weight:600; } span { font-size:.7rem; color:var(--render-muted); } }
.rendering-directory-filters { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; margin:.75rem 0; }
.rendering-records { display:grid; max-height:660px; overflow-y:auto; padding:2px; gap:3px; }
.rendering-record { display:flex; align-items:center; text-align:left; gap:.7rem; padding:.85rem .6rem; border:1px solid transparent; border-radius:7px; background:transparent; color:rgb(var(--v-theme-on-surface)); width:100%; min-width:0; &:hover { background:rgba(var(--v-theme-on-surface),.035); } &.is-selected { background:rgba(var(--v-theme-primary),.08); border-color:rgba(var(--v-theme-primary),.4); } >span:first-of-type { min-width:0; flex:1; } strong { display:block; font-size:.76rem; font-weight:550; overflow-wrap:anywhere; } small { display:block; font-size:.65rem; color:var(--render-muted); margin-top:.3rem; } .rendering-record-state { font-size:.59rem; color:var(--render-muted); &.is-enabled { color:rgb(var(--v-theme-on-surface)); } } }
.rendering-change-dot { width:5px; height:5px; border-radius:50%; background:rgb(var(--v-theme-primary)); flex-shrink:0; }
.rendering-directory-footer { display:grid; justify-items:start; border-top:1px solid var(--render-border); margin-top:.8rem; padding:.9rem .2rem; gap:.5rem; span { font-size:.68rem; color:var(--render-muted); line-height:1.7; } }
.rendering-module-detail { min-width:0; background:rgb(var(--v-theme-surface)); border:1px solid var(--render-border); border-radius:11px; padding:1.6rem; }
.rendering-module-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:1.5rem; h3 { display:flex; align-items:center; gap:.7rem; font-size:1.4rem; font-weight:600; letter-spacing:-.03em; margin:.7rem 0; } p { font-size:.8rem; color:var(--render-muted); line-height:1.75; margin:0; } :deep(.v-switch) { flex:0 0 auto; max-width:230px; } :deep(.v-label) { font-size:.75rem; } }
.rendering-module-context { display:grid; grid-template-columns:1fr 1fr 1fr; gap:1rem; padding:1.2rem 0; border-block:1px solid var(--render-border); margin:1.5rem 0; span { display:block; font-size:.65rem; color:var(--render-muted); margin-bottom:.5rem; } strong,button { font-size:.77rem; font-weight:550; } button { color:rgb(var(--v-theme-on-surface)); border:0; background:transparent; text-align:left; } }
.rendering-section-heading { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1.2rem; h3,h4 { font-size:1.15rem; font-weight:600; letter-spacing:-.025em; margin:.45rem 0; } p { margin:0; font-size:.78rem; color:var(--render-muted); line-height:1.7; } }
.rendering-properties { display:grid; gap:1.3rem; padding:.6rem 0 1rem; max-width:740px; }
.rendering-property { min-width:0; :deep(.v-input__details) { padding-inline:0; padding-top:.5rem; } :deep(.v-messages) { line-height:1.6; font-size:.72rem; } :deep(.v-switch .v-input__control) { min-height:38px; } }
.rendering-property-note { display:block; font-size:.63rem; color:var(--render-muted); margin-top:.45rem; }
.rendering-render-receipt { margin-top:.45rem; font-size:.68rem; color:var(--render-muted); overflow-wrap:anywhere; }
.rendering-empty,.rendering-footnote { color:var(--render-muted); font-size:.74rem; line-height:1.8; margin:.8rem 0; }
.rendering-module-issues { border-top:1px solid var(--render-border); margin-top:1rem; padding-top:.5rem; p { display:flex; align-items:flex-start; gap:.6rem; font-size:.74rem; line-height:1.7; color:var(--render-muted); margin:.7rem 0; } .is-error { color:rgb(var(--v-theme-error)); } }
.rendering-behavior { background:rgba(var(--v-theme-on-surface),.035); border-radius:8px; padding:1rem; margin:1rem 0; p { font-size:.74rem; line-height:1.8; color:var(--render-muted); margin:.6rem 0 0; } }
.rendering-module-footer { display:flex; align-items:center; justify-content:space-between; gap:1rem; border-top:1px solid var(--render-border); padding-top:1rem; margin-top:1rem; code { font-size:.65rem; color:var(--render-muted); overflow-wrap:anywhere; } }
.rendering-segment { display:flex; border:1px solid var(--render-border); padding:3px; border-radius:6px; button { border:0; border-radius:4px; padding:.45rem .7rem; color:var(--render-muted); background:transparent; font-size:.73rem; white-space:nowrap; &[aria-pressed=true] { background:rgba(var(--v-theme-on-surface),.08); color:rgb(var(--v-theme-on-surface)); } } }
.rendering-format-choices { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.8rem; margin:1.5rem 0; button { display:grid; grid-template-columns:1fr auto; gap:.6rem; padding:1rem; border:1px solid var(--render-border); border-radius:9px; background:rgb(var(--v-theme-surface)); color:rgb(var(--v-theme-on-surface)); text-align:left; &[aria-pressed=true] { border-color:rgba(var(--v-theme-primary),.6); background:rgba(var(--v-theme-primary),.05); } span { font-size:.85rem; font-weight:550; } small { grid-row:2; font-size:.67rem; color:var(--render-muted); } .v-icon { grid-column:2; grid-row:1/3; align-self:center; } } }
.rendering-trace-layout { display:grid; grid-template-columns:minmax(0,2fr) minmax(240px,1fr); gap:1.7rem; align-items:start; }
.rendering-trace { display:grid; gap:1.3rem; }
.rendering-trace-bookend { display:flex; align-items:center; gap:.7rem; padding:.7rem 1rem; color:var(--render-muted); font-size:.8rem; small { margin-left:auto; font-size:.65rem; } }
.rendering-stage { position:relative; background:rgb(var(--v-theme-surface)); border:1px solid var(--render-border); border-radius:10px; padding:1.3rem; &::before { content:''; position:absolute; height:1.3rem; width:1px; background:var(--render-border); top:-1.3rem; left:2rem; } }
.rendering-stage-heading { display:flex; align-items:center; gap:.85rem; >div { flex:1; } h4 { font-size:1.05rem; font-weight:600; margin:.35rem 0 0; } }
.rendering-stage-number { border:1px solid var(--render-border); border-radius:50%; display:grid; place-items:center; width:30px; height:30px; flex-shrink:0; font-size:.65rem; }
.rendering-stage-group { margin-top:1.25rem; h5 { font-size:.69rem; font-weight:550; color:var(--render-muted); margin:0 0 .8rem; } >div { display:flex; flex-wrap:wrap; gap:.5rem; } button { border:1px solid var(--render-border); background:transparent; color:rgb(var(--v-theme-on-surface)); border-radius:5px; padding:.4rem .6rem; font-size:.69rem; text-align:left; } ol { padding-left:1.3rem; font-size:.7rem; li { padding:.3rem 0; } small { margin-left:.7rem; color:var(--render-muted); font-size:.6rem; } } }
.rendering-stage-core { display:flex; align-items:flex-start; gap:.6rem; font-size:.72rem; color:var(--render-muted); line-height:1.7; padding:1rem 0 0; }
.rendering-pipeline-notes { display:grid; gap:1.2rem; section { border-top:1px solid var(--render-border); padding:1rem 0; } h4 { font-size:.95rem; font-weight:600; margin:.6rem 0; } p,li { color:var(--render-muted); font-size:.74rem; line-height:1.8; } ul { padding-left:1rem; margin:.5rem 0; } li { margin-bottom:.8rem; } button:not(.v-btn) { color:inherit; border:0; background:transparent; text-align:left; text-decoration:underline; text-decoration-color:var(--render-border); text-underline-offset:3px; } }
.rendering-no-pipeline { border:1px dashed var(--render-border); border-radius:8px; padding:1.4rem; h4 { font-size:.95rem; } p { font-size:.77rem; line-height:1.8; color:var(--render-muted); } }
.rendering-output-picker { display:flex; align-items:center; gap:1rem; margin:1.2rem 0 1.8rem; :deep(.v-input) { min-width:0; } }
.rendering-output-heading { display:flex; justify-content:space-between; align-items:center; gap:1.5rem; h4 { font-size:1.3rem; font-weight:600; letter-spacing:-.025em; margin:.6rem 0; overflow-wrap:anywhere; } p { font-size:.71rem; color:var(--render-muted); margin:0; overflow-wrap:anywhere; } }
.rendering-output-stats { display:flex; flex-wrap:wrap; gap:1.5rem 2.5rem; padding:1.4rem 0; margin:1rem 0; border-block:1px solid var(--render-border); dt { color:var(--render-muted); font-size:.65rem; } dd { margin:.5rem 0 0; font-size:1.4rem; font-weight:550; } small { font-size:.7rem; } }
.rendering-output-toolbar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin:1.4rem 0 1rem; }
.rendering-isolated-preview { border:1px solid var(--render-border); border-radius:9px; overflow:hidden; p { font-size:.7rem; color:var(--render-muted); line-height:1.7; margin:0; padding:.9rem 1rem; background:rgb(var(--v-theme-surface)); border-bottom:1px solid var(--render-border); } iframe { display:block; width:100%; height:600px; border:0; background:#fff; } }
.rendering-html { margin:0; padding:1.2rem; border:1px solid var(--render-border); border-radius:9px; background:rgb(var(--v-theme-surface)); max-height:650px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:.75rem; line-height:1.8; }
.rendering-outline ol { list-style:none; padding:0; margin:1rem 0; li { display:flex; gap:.8rem; flex-wrap:wrap; align-items:baseline; padding-block:.75rem; border-bottom:1px solid var(--render-border); } span { color:var(--render-muted); font-size:.65rem; } strong { font-size:.8rem; font-weight:550; } code { font-size:.67rem; color:var(--render-muted); overflow-wrap:anywhere; } }
.rendering-output-welcome { border:1px dashed var(--render-border); border-radius:12px; padding:3rem 2rem; text-align:center; h4 { font-size:1.15rem; font-weight:600; margin:1rem 0 .6rem; } p { color:var(--render-muted); font-size:.78rem; line-height:1.8; max-width:420px; margin:auto; } }
.rendering-review-heading { padding:1.6rem 1.5rem 1rem; h3 { font-size:1.5rem; font-weight:600; letter-spacing:-.04em; margin:.6rem 0; } p { font-size:.8rem; line-height:1.8; color:var(--render-muted); margin:0; } }
.rendering-change-list { display:grid; gap:1rem; max-height:330px; overflow:auto; h4 { font-size:.83rem; font-weight:600; margin:0 0 .5rem; } ul { padding-left:1rem; margin:0; font-size:.74rem; line-height:1.8; color:var(--render-muted); overflow-wrap:anywhere; } }
.rendering-review-checks { padding-top:1rem; margin-top:1rem; border-top:1px solid var(--render-border); h4 { font-size:.83rem; } p { color:var(--render-muted); font-size:.73rem; line-height:1.8; margin:.6rem 0; } }
.rendering-review :deep(.v-card-actions) { padding:1rem 1.5rem; border-top:1px solid var(--render-border); }
@media(max-width:1150px) { .rendering-intro { flex-direction:column; align-items:flex-start; gap:1.3rem; } .rendering-modules { grid-template-columns:260px minmax(0,1fr); gap:1rem; } .rendering-module-heading { flex-wrap:wrap; gap:.7rem; } .rendering-module-context { grid-template-columns:1fr 1fr; } .rendering-trace-layout { grid-template-columns:minmax(0,1.6fr) minmax(220px,1fr); gap:1.2rem; } }
@media(max-width:760px) { .rendering-modules,.rendering-trace-layout { grid-template-columns:1fr; } .rendering-records { max-height:230px; } .rendering-module-detail { padding:1.2rem; } .rendering-tabs-row { flex-wrap:wrap; } .rendering-tabs { gap:.6rem; } .rendering-draft-state { flex-basis:100%; margin:0 0 .7rem .5rem; } .rendering-intro dl { gap:1.7rem; } .rendering-intro dt { font-size:.63rem; } .rendering-intro dd { font-size:1.6rem; } .rendering-section-heading { flex-wrap:wrap; align-items:flex-start; } .rendering-format-choices { grid-template-columns:1fr 1fr; } .rendering-stage { padding:1rem; } .rendering-stage-heading { flex-wrap:wrap; } .rendering-stage-heading h4 { font-size:.95rem; } .rendering-output-picker { flex-wrap:wrap; } .rendering-output-picker :deep(.v-input) { flex-basis:100%; } .rendering-output-heading { flex-wrap:wrap; gap:1rem; } .rendering-output-toolbar { align-items:flex-start; flex-wrap:wrap; } .rendering-output-toolbar .rendering-segment { width:100%; justify-content:space-between; } .rendering-output-toolbar .rendering-segment button { padding:.5rem; font-size:.66rem; } .rendering-pipeline-notes { gap:.4rem; } }
</style>

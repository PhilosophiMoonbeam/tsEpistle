<template>
  <v-container fluid class="admin-authoring">
    <admin-hero :title="$t('admin:editor.editors')" :description="$t('admin:editor.chooseEditorsBelongAuthoring')" icon="mdi-pencil-ruler">
      <template #actions><v-btn variant="text" prepend-icon="mdi-refresh" :disabled="saving || reviewOpen" :loading="loading" @click="reload">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:editor.reloadSavedEditorPolicy') }}</v-tooltip></v-btn><v-btn variant="flat" color="primary" :disabled="!dirty || loading || saving || !valid" @click="reviewOpen = true">{{ $t('admin:editor.reviewChanges') }}</v-btn></template>
    </admin-hero>
    <dl class="authoring-summary"><div><dt>{{ $t('admin:editor.availableDraft') }}</dt><dd>{{ loaded ? draft.available.length : '—' }}<small> / {{ editors.length }}</small></dd></div><div><dt>{{ $t('admin:editor.existingPages') }}</dt><dd>{{ loaded ? totalPages : '—' }}</dd></div><div><dt>{{ $t('admin:editor.chooserFormatsUse') }}</dt><dd>{{ loaded ? usedFormats : '—' }}</dd></div></dl>
    <v-alert v-if="success" type="success" variant="tonal" closable class="mb-4" @click:close="success = ''">{{ success }}</v-alert>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-4">{{ warning }}</v-alert>
    <async-state v-if="loading" state="loading" :title="$t('admin:editor.loadingAuthoringWorkspace')" :message="$t('admin:editor.readingSavedPolicyEditor')" />
    <async-state v-else-if="loadError" state="error" :title="$t('admin:editor.editorSettingsCouldNot')" :message="loadError" :retry-label="$t('admin:editor.tryAgain')" @retry="reload" />
    <template v-else-if="loaded">
      <div class="authoring-tabs-row"><div class="authoring-tabs" role="tablist" :aria-label="$t('admin:editor.editorWorkspaceSections')"><button v-for="tab in tabs" :id="`authoring-tab-${tab.value}`" :key="tab.value" role="tab" :aria-selected="section === tab.value" :aria-controls="`authoring-panel-${tab.value}`" :tabindex="section === tab.value ? 0 : -1" @click="setSection(tab.value)" @keydown="tabKey($event, tab.value)">{{ tab.title }}</button></div><span class="authoring-draft-state" aria-live="polite">{{ dirty ? $t('admin:editor.unsavedPolicy') : $t('admin:editor.matchesSavedPolicy') }}</span></div>
      <div v-show="section === 'policy'" id="authoring-panel-policy" role="tabpanel" aria-labelledby="authoring-tab-policy" class="authoring-policy">
        <section class="authoring-catalogue"><div class="authoring-section-heading"><div><h3>{{ $t('admin:editor.availableNewPages') }}</h3><p>{{ $t('admin:editor.chooseEditorsBelongAuthoring') }}</p></div><v-btn size="small" variant="text" :disabled="saving || reviewOpen || allAvailable" @click="selectAll">{{ $t('admin:editor.enableAllRegistered') }}</v-btn></div>
          <div class="authoring-catalogue-filter"><v-text-field v-model="editorQuery" :label="$t('admin:editor.searchEditors', { defaultValue: 'Search editors' })" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable /><span>{{ filteredEditors.length }} / {{ editors.length }}</span></div>
          <div class="authoring-options"><article v-for="editor in filteredEditors" :key="editor.key" class="authoring-option" :class="{ 'is-enabled': enabled(editor.key) }">
            <div class="authoring-option-identity"><v-icon :icon="editor.icon" size="22" /><div><h4>{{ editor.title }}</h4><span class="authoring-format">{{ editor.format }}</span><p>{{ editor.description }}</p><p v-if="!registered(editor.key)" class="authoring-registration">{{ $t('admin:editor.missingServerRegistryRepair') }}</p></div></div>
            <div class="authoring-option-usage"><span>{{ $t('admin:editor.existingPagesCount', { count: usage(editor.key).pages }) }}</span><small v-if="usage(editor.key).privatePages">{{ $t('admin:editor.private', { key: usage(editor.key).privatePages, interpolation: { escapeValue: false } }) }}</small></div>
            <div class="authoring-option-control"><label><input type="checkbox" :checked="enabled(editor.key)" :disabled="saving || reviewOpen || (enabled(editor.key) && draft.available.length === 1) || (!enabled(editor.key) && !registered(editor.key))" :aria-label="$t('admin:editor.availability', { title: editor.title, interpolation: { escapeValue: false } })" @change="toggle(editor.key)" /><span>{{ enabled(editor.key) ? $t('admin:editor.availableCreation') : $t('admin:editor.hiddenCreation') }}</span></label><span v-if="draft.recommended === editor.key" class="authoring-recommended"><v-icon icon="mdi-star-outline" size="18" />{{ $t('admin:editor.recommended') }}</span></div>
          </article></div>
          <p v-if="!filteredEditors.length" class="authoring-footnote" role="status">{{ $t('admin:editor.noMatchingEditors', { defaultValue: 'No editors match this search.' }) }}</p>
          <p class="authoring-footnote">{{ $t('admin:editor.leastOneEditorStays') }}</p>
        </section>
        <aside class="authoring-guidance"><section class="authoring-recommendation"><span class="authoring-kicker">{{ $t('admin:editor.guideFirstChoice') }}</span><h3>{{ $t('admin:editor.workspaceRecommendation') }}</h3><p>{{ $t('admin:editor.putPreferredEditorFirst') }}</p><v-select v-model="draft.recommended" :items="recommendations" :label="$t('admin:editor.recommendedEditor')" variant="outlined" density="comfortable" hide-details :disabled="saving || reviewOpen" /><p v-if="recommendationNotice" class="authoring-notice" role="status">{{ recommendationNotice }}</p></section><section class="authoring-flow"><span class="authoring-kicker">{{ $t('admin:editor.newPageJourney') }}</span><ol><li><span>01</span><div><strong>{{ $t('admin:editor.startPage') }}</strong><small>{{ $t('admin:editor.authorChoosesLocationLanguage') }}</small></div></li><li><span>02</span><div><strong>{{ draft.available.length === 1 ? $t('admin:editor.open', { title: title(draft.available[0]!), interpolation: { escapeValue: false } }) : $t('admin:editor.chooseEditors', { availableCount: draft.available.length, interpolation: { escapeValue: false } }) }}</strong><small>{{ draft.available.length === 1 ? $t('admin:editor.oneOptionChooserSkipped') : draft.recommended ? $t('admin:editor.appearsFirstRecommendation', { recommended: title(draft.recommended), interpolation: { escapeValue: false } }) : $t('admin:editor.everyEnabledEditorOffered') }}</small></div></li><li><span>03</span><div><strong>{{ $t('admin:editor.writeChosenFormat') }}</strong><small>{{ $t('admin:editor.existingPagesContinueUsing') }}</small></div></li></ol><v-btn variant="text" size="small" append-icon="mdi-arrow-right" @click="setSection('preview')">{{ $t('admin:editor.previewStartingPoint') }}</v-btn></section><div class="authoring-reset"><span>{{ dirty ? $t('admin:editor.changesLocalUntilSaved') : $t('admin:editor.workspaceUsingPolicy') }}</span><v-btn variant="text" size="small" :disabled="!dirty || saving || reviewOpen" @click="reset">{{ $t('admin:editor.resetDraft') }}</v-btn></div></aside>
      </div>
      <section v-show="section === 'formats'" id="authoring-panel-formats" role="tabpanel" aria-labelledby="authoring-tab-formats" class="authoring-format-panel"><div class="authoring-section-heading"><div><span class="authoring-kicker">{{ $t('admin:editor.understandTradeoffs') }}</span><h3>{{ $t('admin:editor.toolsDifferSourceMatters') }}</h3><p>{{ $t('admin:editor.chooseFormatsFitAuthors') }}</p></div></div><div class="authoring-comparison" tabindex="0" role="region" :aria-label="$t('admin:editor.editorCapabilitiesUsage')"><table><thead><tr><th>{{ $t('admin:editor.title') }}</th><th>{{ $t('admin:editor.authoring') }}</th><th>{{ $t('admin:editor.storedSource') }}</th><th>{{ $t('common:actions.preview') }}</th><th>{{ $t('admin:editor.collaboration') }}</th><th>{{ $t('admin:editor.existingPages') }}</th></tr></thead><tbody><tr v-for="editor in editors" :key="editor.key"><th><v-icon :icon="editor.icon" size="19" />{{ editor.title }}<small>{{ enabled(editor.key) ? $t('admin:editor.availableDraft') : $t('admin:editor.hiddenDraft') }}</small></th><td>{{ editor.key === 'ckeditor' || editor.key === 'visual-markdown' ? $t('admin:editor.visualRichText') : $t('admin:editor.sourceEditing') }}</td><td>{{ editor.format }}</td><td>{{ editor.key === 'code' ? $t('admin:editor.sourceOnly') : editor.key === 'markdown' || editor.key === 'asciidoc' ? $t('admin:editor.livePreviewPane') : $t('admin:editor.inlineVisualEditing') }}</td><td>{{ editor.key === 'markdown' ? $t('admin:editor.liveCoediting') : $t('admin:editor.revisionChecks') }}</td><td><strong>{{ usage(editor.key).pages }}</strong><small>{{ $t('admin:editor.private', { key: usage(editor.key).privatePages, interpolation: { escapeValue: false } }) }}</small></td></tr></tbody></table></div><div class="authoring-format-notes"><article><h4>{{ $t('admin:editor.markdownPortableKnowledge') }}</h4><p>{{ $t('admin:editor.markdownVisualMarkdownShare') }}</p></article><article><h4>{{ $t('admin:editor.htmlAsciidocSpecificNeeds') }}</h4><p>{{ $t('admin:editor.visualHtmlCodeStore') }}</p></article><article><h4>{{ $t('admin:editor.usageCurrentSnapshot') }}</h4><p>{{ $t('admin:editor.countsIncludeAllCurrent') }}</p></article></div><v-alert v-if="otherUsage.length" type="info" variant="tonal" class="mt-5">{{ $t('admin:editor.pagesUseOtherEditor', { otherUsage: otherUsage.reduce((sum, row) => sum + row.pages, 0), otherUsage2: otherUsage.map(row => `${row.key} (${row.pages})`).join(', '), interpolation: { escapeValue: false } }) }}</v-alert></section>
      <section v-show="section === 'preview'" id="authoring-panel-preview" role="tabpanel" aria-labelledby="authoring-tab-preview" class="authoring-preview-panel"><div class="authoring-section-heading"><div><span class="authoring-kicker">{{ $t('admin:editor.beforeAuthorsSee') }}</span><h3>{{ $t('admin:editor.previewStartingPoint') }}</h3><p>{{ $t('admin:editor.compareDraftSavedPolicy') }}</p></div><div class="authoring-preview-toggle" role="group" :aria-label="$t('admin:editor.previewPolicy')"><button :aria-pressed="previewMode === 'draft'" @click="previewMode = 'draft'">{{ $t('admin:editor.draft') }}</button><button :aria-pressed="previewMode === 'saved'" @click="previewMode = 'saved'">{{ $t('admin:editor.saved') }}</button></div></div><div class="authoring-preview-window"><div class="authoring-preview-chrome"><v-icon icon="mdi-file-plus-outline" size="18" /><span>{{ $t('admin:editor.newPage') }}</span><small>{{ previewMode === 'draft' ? $t('admin:editor.draftPolicyPreview') : $t('admin:editor.savedPolicyPreview') }}</small></div><div v-if="previewPolicy.available.length === 1" class="authoring-direct-preview"><v-icon :icon="definition(previewPolicy.available[0]!).icon" size="42" /><h4>{{ $t('admin:editor.opensDirectly', { title: title(previewPolicy.available[0]!), interpolation: { escapeValue: false } }) }}</h4><p>{{ $t('admin:editor.oneEditorAvailableSo') }}</p><span class="authoring-preview-format">{{ $t('admin:editor.source', { available: definition(previewPolicy.available[0]!).format, interpolation: { escapeValue: false } }) }}</span></div><template v-else><div class="authoring-preview-title"><h4>{{ $t('admin:editor.howWouldYouLike') }}</h4><p>{{ $t('admin:editor.chooseEditorPage') }}</p></div><div class="authoring-preview-choices"><article v-for="editor in previewEditors" :key="editor.key" :class="{ 'is-recommended': previewPolicy.recommended === editor.key }"><div><v-icon :icon="editor.icon" size="24" /><span v-if="previewPolicy.recommended === editor.key">{{ $t('admin:editor.recommended') }}</span></div><h5>{{ editor.title }}</h5><p>{{ editor.chooserDescription }}</p><small>{{ $t('admin:editor.source2', { format: editor.format, interpolation: { escapeValue: false } }) }}</small></article><article class="authoring-template-preview"><v-icon icon="mdi-content-copy" size="24" /><h5>{{ $t('admin:editor.template') }}</h5><p>{{ $t('admin:editor.reuseExistingPageStarting') }}</p><small>{{ $t('admin:editor.sourceAccessCreationPolicy') }}</small></article></div></template></div></section>
    </template>
    <v-dialog v-model="reviewOpen" max-width="720" :persistent="saving" aria-labelledby="authoring-review-title"><v-card class="authoring-review"><div class="authoring-review-heading"><span class="authoring-kicker">{{ $t('admin:editor.reviewNewPagePolicy') }}</span><h3 id="authoring-review-title">{{ $t('admin:editor.clearerStartingPoint') }}</h3><p>{{ $t('admin:editor.changesEditorsOfferedNew') }}</p></div><v-card-text><div class="authoring-review-diff"><section><h4>{{ $t('admin:editor.enableCreation') }}</h4><ul v-if="added.length"><li v-for="key in added" :key="key">{{ title(key) }}</li></ul><p v-else>{{ $t('admin:editor.noEditorsAdded') }}</p></section><section><h4>{{ $t('admin:editor.hideCreation') }}</h4><ul v-if="removed.length"><li v-for="key in removed" :key="key">{{ title(key) }}<small>{{ $t('admin:editor.existingPagesRemainEditable', { value: usage(key).pages, interpolation: { escapeValue: false } }) }}</small></li></ul><p v-else>{{ $t('admin:editor.noEditorsHidden') }}</p></section></div><div class="authoring-review-recommendation"><span>{{ $t('admin:editor.workspaceRecommendation2') }}</span><strong>{{ saved?.recommended ? title(saved.recommended) : $t('admin:editor.none') }} → {{ draft.recommended ? title(draft.recommended) : $t('admin:editor.none') }}</strong></div><p class="authoring-footnote">{{ $t('admin:editor.newlyOpenedCreationFlows', { value: draft.available.length === 1 ? $t('admin:editor.willOpenDirectlyNew', { title: title(draft.available[0]!), interpolation: { escapeValue: false } }) : $t('admin:editor.chooserWillOfferEditors', { availableCount: draft.available.length, recommended: draft.recommended ? `, with ${title(draft.recommended)} first` : '', interpolation: { escapeValue: false } }), interpolation: { escapeValue: false } }) }}</p><v-alert v-if="saveError" type="error" variant="tonal" class="mt-4">{{ saveError }}<div><v-btn variant="text" size="small" class="mt-2" :disabled="saving" @click="reloadFromReview">{{ $t('admin:editor.reloadSavedPolicy') }}</v-btn></div></v-alert></v-card-text><v-card-actions><v-btn variant="text" :disabled="saving" @click="reviewOpen = false">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="saving" :disabled="saving || !valid || !dirty" @click="save">{{ $t('admin:editor.saveEditorPolicy') }}</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import { PAGE_EDITOR_DEFINITIONS, type PageEditorDefinition } from '../../helpers/page-editors.ts'
import { fetchEditorWorkspace, saveEditorWorkspace } from '../../helpers/editor-policy-api.ts'
import { validateEditorPolicy, type EditorPolicy, type EditorPolicySnapshot, type EditorUsage } from '../../../shared/editor-policy.ts'
import type { PageEditorKey } from '../../../shared/page-editors.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'
export default {
  components: { AsyncState },
  data() { return { editors: PAGE_EDITOR_DEFINITIONS, editorQuery: '' as string | null, draft: { available: [], recommended: null } as EditorPolicy, saved: null as EditorPolicySnapshot | null, registeredKeys: [] as string[], counts: [] as EditorUsage[], loading: true, loadError: '', saving: false, saveError: '', reviewOpen: false, success: '', warnings: [] as string[], recommendationNotice: '', section: 'policy', previewMode: 'draft',
    tabs: [{ title: this.$t('admin:editor.creationPolicy'), value: 'policy' }, { title: this.$t('admin:editor.formatsUsage'), value: 'formats' }, { title: this.$t('admin:editor.authorPreview'), value: 'preview' }] } },
  // Filtering affects only the visible inventory, never availability or recommendation.
  computed: {
    loaded(): boolean { return Boolean(this.saved) && !this.loadError },
    filteredEditors(): PageEditorDefinition[] { const query = (this.editorQuery || '').trim().toLocaleLowerCase(); return this.editors.filter(editor => !query || [editor.title, editor.key, editor.format, editor.description].join(' ').toLocaleLowerCase().includes(query)) },
    dirty(): boolean { return Boolean(this.saved && (this.saved.recommended !== this.draft.recommended || this.saved.available.join(',') !== this.draft.available.join(','))) },
    valid(): boolean { return validateEditorPolicy(this.draft).ok && this.draft.available.every(this.registered) },
    allAvailable(): boolean { return this.editors.filter(editor => this.registered(editor.key)).every(editor => this.enabled(editor.key)) },
    recommendations() { return [{ title: this.$t('admin:editor.noRecommendation'), value: null }, ...this.editors.filter(editor => this.enabled(editor.key)).map(editor => ({ title: editor.title, value: editor.key }))] },
    totalPages(): number { return this.counts.reduce((sum, row) => sum + row.pages, 0) },
    usedFormats(): number { return new Set(this.editors.filter(editor => this.usage(editor.key).pages > 0).map(editor => editor.format)).size },
    otherUsage(): EditorUsage[] { return this.counts.filter(row => !this.editors.some(editor => editor.key === row.key)) },
    added(): PageEditorKey[] { return this.draft.available.filter(key => !this.saved?.available.includes(key)) },
    removed(): PageEditorKey[] { return this.saved?.available.filter(key => !this.draft.available.includes(key)) ?? [] },
    previewPolicy(): EditorPolicy { return this.previewMode === 'saved' && this.saved ? this.saved : this.draft },
    previewEditors(): PageEditorDefinition[] { return this.editors.filter(editor => this.previewPolicy.available.includes(editor.key)).sort((a, b) => Number(b.key === this.previewPolicy.recommended) - Number(a.key === this.previewPolicy.recommended)) }
  },
  methods: {
    enabled(key: PageEditorKey): boolean { return this.draft.available.includes(key) },
    registered(key: PageEditorKey): boolean { return this.registeredKeys.includes(key) },
    definition(key: PageEditorKey): PageEditorDefinition { return this.editors.find(editor => editor.key === key)! },
    title(key: PageEditorKey): string { return this.definition(key).title },
    usage(key: string): EditorUsage { return this.counts.find(row => row.key === key) ?? { key, pages: 0, privatePages: 0 } },
    toggle(key: PageEditorKey) { if (this.saving || this.reviewOpen || (this.enabled(key) && this.draft.available.length === 1) || (!this.enabled(key) && !this.registered(key))) return; const selected = new Set(this.draft.available); if (selected.has(key)) selected.delete(key); else selected.add(key); this.draft.available = this.editors.filter(editor => selected.has(editor.key)).map(editor => editor.key); if (this.draft.recommended && !selected.has(this.draft.recommended)) { this.recommendationNotice = this.$t('admin:editor.wasHiddenSoRecommendation', { recommended: this.title(this.draft.recommended), interpolation: { escapeValue: false } }); this.draft.recommended = null } this.saveError = '' },
    selectAll() { const available = this.editors.filter(editor => this.registered(editor.key)).map(editor => editor.key); if (!available.length) return; this.draft.available = available; if (this.draft.recommended && !available.includes(this.draft.recommended)) this.draft.recommended = null },
    reset() { if (this.saved) this.draft = { available: [...this.saved.available], recommended: this.saved.recommended }; this.recommendationNotice = ''; this.saveError = '' },
    setSection(value: string) { this.section = value; this.$router.replace({ hash: `#${value}` }) },
    tabKey(event: KeyboardEvent, value: string) { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = this.tabs.findIndex(tab => tab.value === value), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3; this.setSection(this.tabs[next]!.value); this.$nextTick(() => document.getElementById(`authoring-tab-${this.section}`)?.focus()) },
    async reload() { if (this.saving || (this.dirty && !(await confirmDiscard(this.$t('admin:editor.discardUnsavedEditorPolicy')))) || this.saving) return; this.loading = true; this.loadError = ''; try { const result = await fetchEditorWorkspace(); this.saved = result.policy; this.registeredKeys = result.registered; this.counts = result.usage; this.reset() } catch (error) { this.loadError = getErrorMessage(error) } finally { this.loading = false } },
    async reloadFromReview() { if (this.saving) return; if (this.dirty && !(await confirmDiscard(this.$t('admin:editor.discardUnsavedEditorPolicy2')))) return; this.reviewOpen = false; this.reset(); await this.reload() },
    async save() { if (!this.saved || this.saving || !this.valid || !this.dirty) return; this.saving = true; this.saveError = ''; const draft = { available: [...this.draft.available], recommended: this.draft.recommended }; try { const result = await saveEditorWorkspace(draft, this.saved.fingerprint); this.saved = result.policy; this.reset(); siteConfig.availableEditors = [...result.policy.available]; siteConfig.recommendedEditor = result.policy.recommended; this.warnings = result.warnings; this.success = this.$t('admin:editor.editorPolicySavedNew'); this.reviewOpen = false } catch (error) { this.saveError = getErrorMessage(error) } finally { this.saving = false } },
    beforeUnload(event: BeforeUnloadEvent) { if (this.dirty || this.saving) { event.preventDefault(); event.returnValue = '' } }
  },
  watch: { '$route.hash'(hash: string) { const value = hash.slice(1); if (this.tabs.some(tab => tab.value === value)) this.section = value } },
  async beforeRouteLeave() { return !this.saving && (!this.dirty || await confirmDiscard(this.$t('admin:editor.discardUnsavedEditorPolicy3'))) },
  mounted() { const hash = this.$route.hash.slice(1); if (this.tabs.some(tab => tab.value === hash)) this.section = hash; this.reload(); window.addEventListener('beforeunload', this.beforeUnload) },
  beforeUnmount() { window.removeEventListener('beforeunload', this.beforeUnload) }
}
</script>
<style lang="scss" scoped>
.admin-authoring, .authoring-review { min-width: 0; color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
.authoring-kicker { display: block; font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); }
.authoring-summary { display: flex; flex-wrap: wrap; gap: .75rem 2rem; padding: .75rem 0; margin-bottom: 1rem; border-bottom: 1px solid var(--wiki-surface-border); }
.authoring-summary > div { display: flex; align-items: baseline; gap: .5rem; }
.authoring-summary dt, .authoring-summary small { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-summary dd { margin: 0; font-size: .875rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.authoring-tabs-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; border-bottom: 1px solid var(--wiki-surface-border); margin-bottom: 1rem; }
.authoring-tabs { display: flex; flex-wrap: wrap; gap: .25rem; }
.authoring-tabs button { min-height: 44px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--wiki-text-muted); padding: .65rem .75rem; font-size: .8125rem; }
.authoring-tabs button[aria-selected=true] { color: inherit; border-bottom-color: var(--wiki-primary-ink); font-weight: 650; }
.authoring-draft-state { margin-inline-start: auto; font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-policy { display: grid; grid-template-columns: minmax(0,2fr) minmax(260px,1fr); gap: 1rem; align-items: start; }
.authoring-catalogue { min-width: 0; }
.authoring-section-heading { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: .75rem; margin-bottom: .75rem; }
.authoring-section-heading h3 { font-size: 1rem; font-weight: 650; margin: .25rem 0 .35rem; }
.authoring-section-heading p { margin: 0; color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; }
.authoring-catalogue-filter { display: flex; align-items: center; gap: .75rem; margin-bottom: .75rem; }
.authoring-catalogue-filter .v-text-field { min-width: 0; }
.authoring-catalogue-filter > span { flex-shrink: 0; font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-options { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); overflow: hidden; }
.authoring-option { display: grid; grid-template-columns: minmax(0,1fr) minmax(110px,.35fr); gap: .5rem 1rem; min-width: 0; border-bottom: 1px solid var(--wiki-surface-border); padding: 1rem; }
.authoring-option:last-child { border-bottom: 0; }
.authoring-option-identity { display: flex; align-items: flex-start; gap: .75rem; min-width: 0; }
.authoring-option-identity > .v-icon { flex-shrink: 0; margin-top: .15rem; }
.authoring-option-identity > div { min-width: 0; }
.authoring-option h4 { font-size: .9375rem; font-weight: 650; margin: 0 0 .25rem; line-height: 1.4; }
.authoring-option p { font-size: .8125rem; color: var(--wiki-text-muted); line-height: 1.6; margin: .35rem 0 0; }
.authoring-format { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-option-usage { display: flex; flex-direction: column; gap: .25rem; font-size: .8125rem; padding-block: .15rem; }
.authoring-option-usage small { color: var(--wiki-text-muted); font-size: .75rem; }
.authoring-option-control { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; grid-column: 1 / -1; }
.authoring-option-control label { display: flex; align-items: center; gap: .65rem; min-height: 44px; font-size: .8125rem; cursor: pointer; }
.authoring-option-control input { width: 18px; height: 18px; flex-shrink: 0; accent-color: rgb(var(--v-theme-primary)); }
.authoring-option-control input:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 3px; }
.authoring-recommended { display: flex; align-items: center; gap: .35rem; color: var(--wiki-text-muted); font-size: .75rem; }
.authoring-registration { font-size: .75rem; }
.authoring-footnote { font-size: .75rem; line-height: 1.6; color: var(--wiki-text-muted); margin: .75rem 0 0; }
.authoring-guidance { display: grid; gap: 1rem; min-width: 0; }
.authoring-recommendation, .authoring-flow { background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: 1rem; }
.authoring-recommendation h3, .authoring-flow h3 { font-size: 1rem; font-weight: 650; margin: .35rem 0; }
.authoring-recommendation p, .authoring-flow p { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.6; margin: 0 0 .75rem; }
.authoring-flow ol { list-style: none; padding: 0; margin: .75rem 0; }
.authoring-flow li { display: flex; gap: .75rem; padding: .5rem 0; }
.authoring-flow li > span { color: var(--wiki-text-muted); font: .75rem var(--wiki-font-mono); flex-shrink: 0; padding-top: .15rem; }
.authoring-flow strong { display: block; font-size: .8125rem; font-weight: 600; margin-bottom: .25rem; }
.authoring-flow small { display: block; font-size: .75rem; line-height: 1.6; color: var(--wiki-text-muted); }
.authoring-reset { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.authoring-reset span { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-notice { margin: .75rem 0 0; font-size: .75rem; }
.authoring-format-panel, .authoring-preview-panel { min-width: 0; }
.authoring-comparison { overflow: auto; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.authoring-comparison table { border-collapse: collapse; width: 100%; text-align: start; font-size: .8125rem; }
.authoring-comparison th, .authoring-comparison td { padding: .75rem; border-bottom: 1px solid var(--wiki-surface-border); min-width: 115px; vertical-align: middle; }
.authoring-comparison thead th { font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); background: var(--wiki-surface-sunken); }
.authoring-comparison tbody th { font-weight: 650; min-width: 200px; }
.authoring-comparison tbody th .v-icon { margin-inline-end: .5rem; }
.authoring-comparison small { display: block; font-size: .75rem; color: var(--wiki-text-muted); margin-top: .25rem; font-weight: 400; }
.authoring-format-notes { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1rem; margin-top: 1rem; }
.authoring-format-notes h4 { font-size: .875rem; font-weight: 650; margin-bottom: .35rem; }
.authoring-format-notes p { font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); margin: 0; }
.authoring-preview-toggle { display: flex; flex-wrap: wrap; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); padding: 3px; }
.authoring-preview-toggle button { min-height: 44px; color: var(--wiki-text-muted); border: 0; background: transparent; padding: .5rem .75rem; border-radius: var(--wiki-control-radius); font-size: .8125rem; }
.authoring-preview-toggle button[aria-pressed=true] { background: var(--wiki-surface-sunken); color: inherit; }
.authoring-preview-window { margin-top: 1rem; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); overflow: hidden; }
.authoring-preview-chrome { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem; border-bottom: 1px solid var(--wiki-surface-border); font-size: .8125rem; background: var(--wiki-surface-sunken); }
.authoring-preview-chrome small { margin-inline-start: auto; color: var(--wiki-text-muted); font-size: .75rem; }
.authoring-preview-title { padding: 1rem 1rem 0; }
.authoring-preview-title h4 { font-size: 1.125rem; font-weight: 650; }
.authoring-preview-title p { font-size: .8125rem; color: var(--wiki-text-muted); margin: .35rem 0 0; }
.authoring-preview-choices { padding: 1rem; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .75rem; }
.authoring-preview-choices article { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); padding: 1rem; }
.authoring-preview-choices article > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; align-items: center; }
.authoring-preview-choices article.is-recommended { border-color: var(--wiki-primary-ink); background: var(--wiki-surface-sunken); }
.authoring-preview-choices h5 { font-size: .9375rem; font-weight: 650; margin: .5rem 0 .35rem; }
.authoring-preview-choices p { font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); margin: 0 0 .5rem; }
.authoring-preview-choices small, .authoring-preview-choices span { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-direct-preview { padding: 1.5rem 1rem; }
.authoring-direct-preview h4 { font-size: 1.125rem; font-weight: 650; margin: .75rem 0 .35rem; }
.authoring-direct-preview p { margin: 0 0 .75rem; font-size: .8125rem; line-height: 1.6; color: var(--wiki-text-muted); }
.authoring-preview-format { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-review :deep(.v-card-actions) { flex-wrap: wrap; gap: .5rem; padding: .75rem 1rem; border-top: 1px solid var(--wiki-surface-border); }
.authoring-review-heading { padding: 1rem 1rem .5rem; }
.authoring-review-heading h3 { font-size: 1.125rem; font-weight: 650; line-height: 1.4; margin: .35rem 0; }
.authoring-review-heading p { font-size: .8125rem; color: var(--wiki-text-muted); line-height: 1.6; margin: 0; }
.authoring-review-diff { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 1rem; }
.authoring-review-diff h4 { font-size: .875rem; font-weight: 650; }
.authoring-review-diff ul { padding-inline-start: 1rem; font-size: .8125rem; margin: .5rem 0 0; }
.authoring-review-diff li { padding: .25rem 0; }
.authoring-review-diff small { display: block; font-size: .75rem; color: var(--wiki-text-muted); margin-top: .25rem; }
.authoring-review-diff p { font-size: .8125rem; color: var(--wiki-text-muted); margin: .5rem 0 0; }
.authoring-review-recommendation { display: grid; gap: .35rem; border-block: 1px solid var(--wiki-surface-border); padding: .75rem 0; margin-top: 1rem; }
.authoring-review-recommendation span { font-size: .75rem; color: var(--wiki-text-muted); }
.authoring-review-recommendation strong { font-size: .875rem; font-weight: 650; }
.admin-authoring button:focus-visible, .authoring-comparison:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.admin-authoring :deep(.v-btn), .authoring-review :deep(.v-btn) { max-width: 100%; height: auto; }
.admin-authoring :deep(.v-btn__content), .authoring-review :deep(.v-btn__content) { white-space: normal; padding-block: .4rem; }
@media(max-width:599px) { .admin-authoring :deep(.v-btn), .authoring-review :deep(.v-btn) { min-height: 44px; } }
@media(max-width:1100px) { .authoring-draft-state { flex-basis: 100%; margin: .5rem 0; } .authoring-option { grid-template-columns: 1fr; } .authoring-option-control { grid-column: auto; } }
@media(max-width:840px) { .authoring-policy { grid-template-columns: 1fr; } .authoring-format-notes { grid-template-columns: 1fr; } }
@media(max-width:599px) { .authoring-preview-choices, .authoring-review-diff { grid-template-columns: 1fr; } .authoring-tabs button { padding-inline: .5rem; } }
</style>

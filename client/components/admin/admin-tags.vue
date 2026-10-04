<template>
  <v-container fluid class="admin-taxonomy">
    <admin-hero :title="$t('admin:tags.title')" :description="$t('admin:tags.defineMeaningfulLabelsUnderstand')" icon="mdi-tag-multiple-outline">
      <template #actions>
        <v-btn :aria-disabled="hasUnsavedChanges || undefined" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ hasUnsavedChanges ? $t('admin:tags.saveResetTagChanges') : $t('admin:tags.reloadSavedTags') }}</v-tooltip></v-btn>
        <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" :disabled="busy" @click="openCreate">{{ $t('admin:tags.createTag') }}</v-btn>
      </template>
    </admin-hero>

    <section v-if="inventoryLoaded" class="taxonomy-register-summary" :aria-label="$t('admin:tags.tagDirectory')">
      <span class="taxonomy-register-scope">{{ loadedNamesLabel }}</span>
      <dl>
        <div><dt>{{ $t('admin:tags.activeTags') }}</dt><dd>{{ inventoryCounts.active }}</dd></div>
        <div><dt>{{ $t('admin:tags.aliases') }}</dt><dd>{{ inventoryCounts.alias }}</dd></div>
        <div><dt>{{ $t('admin:tags.unusedActive') }}</dt><dd>{{ inventoryCounts.unused }}</dd></div>
      </dl>
    </section>

    <v-alert v-if="success" type="success" variant="tonal" class="mb-4" role="status" closable @click:close="success = ''">{{ success }}</v-alert>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-4">{{ warning }}</v-alert>
    <v-alert v-if="loadError && inventoryLoaded" type="error" variant="tonal" class="mb-4">
      <span>{{ loadError }}</span>
      <v-btn variant="text" size="small" class="ms-2" :disabled="busy || hasUnsavedChanges" @click="refresh">{{ $t('admin:tags.retryReload') }}</v-btn>
    </v-alert>

    <async-state v-if="loading && !inventoryLoaded" state="loading" :title="$t('admin:tags.loadingVocabulary')" :message="$t('admin:tags.readingTagDefinitionsPage')" />
    <async-state v-else-if="!inventoryLoaded && loadError" state="error" :title="$t('admin:tags.vocabularyCouldNotLoaded')" :message="loadError" :retry-label="$t('admin:tags.tryAgain')" @retry="refresh" />
    <div v-else class="taxonomy-workspace">
      <aside class="taxonomy-directory" :aria-label="$t('admin:tags.tagDirectory')" :aria-busy="loading">
        <div class="taxonomy-directory-heading"><h3>{{ $t('admin:tags.vocabulary') }}</h3><span>{{ $t('admin:tags.namesCount', { count: tags.length }) }}</span></div>
        <p class="taxonomy-directory-scope">{{ $t('admin:tags.filterLoadedNames', { defaultValue: 'Search and views filter the loaded tag register.' }) }}</p>
        <v-progress-linear v-if="loading" indeterminate :aria-label="$t('admin:tags.loadingVocabulary')" />
        <v-text-field v-model="search" :label="$t('admin:tags.findTagLabel')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable :disabled="busy" @update:model-value="pagination = 1" />
        <v-select v-model="view" :items="views" :label="$t('admin:tags.vocabularyView')" variant="outlined" density="compact" hide-details :disabled="busy" @update:model-value="pagination = 1" />
        <p class="taxonomy-directory-count" role="status">{{ registerRangeLabel }}</p>
        <div v-if="!filtered.length" class="taxonomy-empty">
          <v-icon icon="mdi-tag-search-outline" size="30" aria-hidden="true" />
          <h4>{{ tags.length ? $t('admin:tags.noMatchingNames') : $t('admin:tags.startSharedVocabulary') }}</h4>
          <p>{{ tags.length ? $t('admin:tags.tryAnotherTermVocabulary') : $t('admin:tags.createTagBeforeAssigning') }}</p>
          <v-btn v-if="tags.length" size="small" variant="text" :disabled="busy" @click="search = ''; view = 'all'">{{ $t('admin:tags.clearFilters') }}</v-btn>
        </div>
        <div v-else class="taxonomy-records">
          <button v-for="entry in visible" :key="entry.id" type="button" class="taxonomy-record" :class="{ 'is-selected': selectedId === entry.id }" :aria-pressed="selectedId === entry.id" :aria-label="`${entry.title || entry.tag}, ${stateLabel(entry)}${selectedId === entry.id ? $t('admin:tags.selected') : ''}`" :disabled="mutationBusy" @click="select(entry.id)">
            <v-icon :icon="selectedId === entry.id ? 'mdi-check' : state(entry) === 'alias' ? 'mdi-arrow-u-right-top' : state(entry) === 'archived' ? 'mdi-archive-outline' : 'mdi-pound'" size="18" aria-hidden="true" />
            <span><strong><bdi>{{ entry.tag }}</bdi></strong><small><bdi>{{ entry.title || (state(entry) === 'alias' ? $t('admin:tags.alias') : $t('admin:tags.noDisplayLabel')) }}</bdi></small></span>
            <span class="taxonomy-record-meta"><b>{{ entry.pageCount }}</b><small>{{ state(entry) === 'active' ? $t('admin:tags.pagesLabel', { defaultValue: 'pages' }) : stateLabel(entry) }}</small></span>
          </button>
        </div>
        <v-pagination v-if="pageCount > 1" v-model="pagination" :length="pageCount" :total-visible="3" density="compact" :aria-label="$t('admin:tags.tagDirectoryPages')" :disabled="busy" />
        <v-select v-if="tags.length" v-model="directoryPageSize" :items="[12, 24, 48]" :label="$t('admin:tags.namesPerPage', { defaultValue: 'Names per page' })" variant="outlined" density="compact" hide-details :disabled="busy" />
        <v-btn v-if="inspection" variant="text" prepend-icon="mdi-crosshairs-gps" :disabled="busy" @click="locateSelected">{{ $t('admin:tags.locateSelected', { defaultValue: 'Show selected in register' }) }}</v-btn>
        <v-btn v-if="inspection" class="taxonomy-view-selected" variant="outlined" prepend-icon="mdi-eye-outline" :disabled="busy" @click="viewSelected">{{ $t('admin:tags.viewSelectedTag') }}</v-btn>
        <p class="taxonomy-directory-note">{{ $t('admin:tags.aliasesKeepOldNames') }}</p>
      </aside>

      <section class="taxonomy-detail" aria-labelledby="taxonomy-selected-title" :aria-busy="detailLoading">
        <h2 v-if="!inspection" id="taxonomy-selected-title" class="taxonomy-visually-hidden">{{ $t('admin:tags.selectedTagDetails') }}</h2>
        <async-state v-if="detailLoading" state="loading" :title="$t('admin:tags.readingTag')" :message="$t('admin:tags.gatheringPageAssignmentsAccess')" />
        <async-state v-else-if="detailError" state="error" :title="$t('admin:tags.tagCouldNotOpened')" :message="detailError" :retry-label="$t('admin:tags.tryAgain')" @retry="loadDetail(selectedId)" />
        <div v-else-if="!inspection" class="taxonomy-welcome">
          <v-icon icon="mdi-tag-search-outline" size="24" aria-hidden="true" />
          <h3>{{ $t('admin:tags.selectedTagDetails') }}</h3>
          <p>{{ $t('admin:tags.chooseNameUnderstandReach') }}</p>
        </div>
        <template v-else>
          <p class="taxonomy-loaded-status" role="status">{{ $t('admin:tags.loaded') }} <bdi>{{ current.title || current.tag }}</bdi></p>
          <header class="taxonomy-identity">
            <v-icon icon="mdi-tag-outline" size="24" class="taxonomy-identity-icon" aria-hidden="true" />
            <div class="taxonomy-identity-main">
              <div class="taxonomy-identity-meta"><span class="taxonomy-kicker">{{ state(current) === 'alias' ? $t('admin:tags.historicalName') : state(current) === 'archived' ? $t('admin:tags.archivedVocabulary') : $t('admin:tags.canonicalTag') }}</span><v-chip size="small" variant="outlined">{{ stateLabel(current) }}</v-chip></div>
              <h2 id="taxonomy-selected-title" tabindex="-1"><bdi>{{ current.title || current.tag }}</bdi></h2>
              <p v-if="current.title && current.title !== current.tag" class="taxonomy-name"><bdi>{{ current.tag }}</bdi></p>
              <p v-if="state(current) === 'active'" class="taxonomy-definition-status" :class="{ 'is-draft': dirty }" role="status"><v-icon :icon="dirty ? 'mdi-pencil-outline' : 'mdi-check-circle-outline'" size="16" />{{ dirty ? $t('admin:tags.unsavedDefinition') : $t('admin:tags.matchesSavedDefinition') }}</p>
            </div>
          </header>
          <div v-if="current.redirectToId" class="taxonomy-destination"><v-icon icon="mdi-arrow-u-right-top" size="18" aria-hidden="true" /><span>{{ current.isArchived ? $t('admin:tags.retiredAlias') : $t('admin:tags.resolves') }} <button type="button" :disabled="mutationBusy" @click="select(current.redirectToId!)"><bdi>{{ destination?.tag || $t('admin:tags.tag2', { redirectToId: current.redirectToId, interpolation: { escapeValue: false } }) }}</bdi></button></span></div>
          <dl class="taxonomy-facts"><div><dt>{{ current.redirectToId ? $t('admin:tags.destinationPages') : $t('admin:tags.assignedPages') }}</dt><dd>{{ current.pageCount }}</dd></div><div><dt>{{ $t('admin:tags.tagBasedRules') }}</dt><dd>{{ current.ruleCount }}</dd></div><div><dt>{{ $t('admin:tags.historyReferences') }}</dt><dd>{{ current.historyCount }}</dd></div></dl>

          <div class="taxonomy-tabs" role="tablist" :aria-label="$t('admin:tags.tagSections')">
            <button v-for="item in sections" :id="`taxonomy-tab-${item.value}`" :key="item.value" type="button" role="tab" :aria-selected="section === item.value" :aria-controls="`taxonomy-panel-${item.value}`" :tabindex="section === item.value ? 0 : -1" :disabled="busy" @click="setSection(item.value)" @keydown="tabKey($event, item.value)">{{ item.title }}</button>
          </div>

          <div v-show="section === 'definition'" id="taxonomy-panel-definition" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-definition" :aria-hidden="section !== 'definition'" :inert="section !== 'definition'">
            <div class="taxonomy-section-heading"><h3>{{ $t('admin:tags.definition') }}</h3><p>{{ $t('admin:tags.stableNameLinksPage') }}</p></div>
            <form v-if="state(current) === 'active'" @submit.prevent="reviewEdit">
              <v-text-field v-model="draft.tag" :label="$t('admin:tags.tagName')" variant="outlined" maxlength="255" counter="255" :disabled="busy" :hint="$t('admin:tags.namesTrimmedSavedLowercase')" persistent-hint />
              <v-text-field v-model="draft.title" :label="$t('admin:tags.displayLabel')" variant="outlined" maxlength="255" counter="255" :disabled="busy" :hint="$t('admin:tags.optionalExampleAgentMemory')" persistent-hint class="mt-4" />
              <v-alert v-if="actionError" type="error" variant="tonal" class="mt-4">{{ actionError }}</v-alert>
              <div class="taxonomy-save"><span role="status">{{ dirty ? $t('admin:tags.unsavedDefinition') : $t('admin:tags.matchesSavedDefinition') }}</span><div><v-btn type="button" variant="text" :disabled="!dirty || busy" @click="resetDraft">{{ $t('admin:tags.reset') }}</v-btn><v-btn type="submit" variant="flat" color="primary" :disabled="!dirty || !validDefinition || busy" :loading="reviewing">{{ $t('admin:tags.reviewChanges') }}</v-btn></div></div>
            </form>
            <v-alert v-else type="info" variant="tonal">{{ current.isArchived ? $t('admin:tags.nameRetiredRestoreLifecycle') : $t('admin:tags.preservedNameEditCanonical') }}</v-alert>
            <div class="taxonomy-dates"><div><span>{{ $t('admin:tags.created') }}</span><time :datetime="current.createdAt">{{ date(current.createdAt) }}</time></div><div><span>{{ $t('admin:tags.lastChanged') }}</span><time :datetime="current.updatedAt">{{ date(current.updatedAt) }}</time></div></div>
          </div>

          <div v-show="section === 'usage'" id="taxonomy-panel-usage" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-usage" :aria-hidden="section !== 'usage'" :inert="section !== 'usage'">
            <div class="taxonomy-section-heading"><h3>{{ $t('admin:tags.whereNameReaches') }}</h3><p>{{ $t('admin:tags.pageAssignmentsHistoricalNames') }}</p></div>
            <div class="taxonomy-subheading"><h4>{{ $t('admin:tags.assignedPages') }} <span>{{ inspection.pages.length }}</span></h4><v-btn v-if="inspection.pages.length" size="small" variant="text" :href="`/t/${encodeURIComponent(current.tag)}`" target="_blank" rel="noopener" append-icon="mdi-open-in-new">{{ $t('admin:tags.openWiki') }}</v-btn></div>
            <p v-if="!inspection.pages.length" class="taxonomy-muted">{{ $t('admin:tags.noCurrentPageAssignments', { isArchived: current.isArchived ? $t('admin:tags.restoringNameDoesNot') : $t('admin:tags.useTagWhenCreating'), interpolation: { escapeValue: false } }) }}</p>
            <div v-else class="taxonomy-page-list"><router-link v-for="page in inspection.pages.slice(0, pageLimit)" :key="page.id" :to="`/pages/${page.id}`"><span><strong><bdi>{{ page.title || page.path }}</bdi></strong><small><bdi>{{ page.locale }} / {{ page.path }}</bdi></small></span><span>{{ page.visibility === 'private' ? $t('admin:tags.private') : $t('admin:tags.workspace') }}<v-icon icon="mdi-chevron-right" size="16" aria-hidden="true" /></span></router-link><v-btn v-if="inspection.pages.length > pageLimit" variant="text" @click="pageLimit += 25">{{ $t('admin:tags.showMorePages') }}</v-btn></div>
            <h4 class="mt-7">{{ $t('admin:tags.preservedAliases') }} <span>{{ inspection.aliases.length }}</span></h4><div v-if="inspection.aliases.length" class="taxonomy-aliases"><button v-for="alias in inspection.aliases" :key="alias.id" type="button" :disabled="mutationBusy" @click="select(alias.id)"><v-icon icon="mdi-arrow-u-right-top" size="16" aria-hidden="true" /><bdi>{{ alias.tag }}</bdi><small v-if="alias.isArchived">{{ $t('admin:tags.archived') }}</small></button></div><p v-else class="taxonomy-muted">{{ $t('admin:tags.noOtherNamesHave') }}</p>
            <h4 class="mt-7">{{ $t('admin:tags.accessRuleReferences') }} <span>{{ inspection.rules.length }}</span></h4><p class="taxonomy-muted">{{ $t('admin:tags.countsShowPublicPages') }}</p>
            <div v-if="inspection.rules.length" class="taxonomy-rule-list"><article v-for="(rule, i) in inspection.rules" :key="i"><div><router-link :to="`/groups/${rule.groupId}`">{{ rule.groupName }}</router-link><span class="taxonomy-rule-kind">{{ rule.deny ? $t('admin:tags.deny') : $t('admin:tags.allow') }} · #{{ rule.path }}</span></div><p>{{ rule.roles.join(', ') }} · {{ rule.locales.length ? rule.locales.join(', ') : $t('admin:tags.allLanguages') }}</p><strong>{{ $t('admin:tags.publicPagesMatchCount', { count: rule.before }) }}</strong></article></div><p v-else class="taxonomy-muted">{{ $t('admin:tags.noGroupUsesName') }}</p>
          </div>

          <div v-show="section === 'lifecycle'" id="taxonomy-panel-lifecycle" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-lifecycle" :aria-hidden="section !== 'lifecycle'" :inert="section !== 'lifecycle'">
            <div class="taxonomy-section-heading"><h3>{{ $t('admin:tags.letVocabularyEvolve') }}</h3><p>{{ $t('admin:tags.everyLifecycleChangeIncludes') }}</p></div>
            <v-alert v-if="dirty" type="info" variant="tonal" class="mb-5">{{ $t('admin:tags.reviewResetDefinitionChanges') }}</v-alert>
            <section v-if="state(current) === 'active'" class="taxonomy-lifecycle-card"><v-icon icon="mdi-source-merge" size="26" aria-hidden="true" /><div><h4>{{ $t('admin:tags.mergeIntoAnotherTag') }}</h4><p>{{ $t('admin:tags.consolidatePageAssignmentsUnder') }}</p><v-autocomplete v-model="mergeTarget" :items="mergeTargets" item-title="tag" item-value="id" :label="$t('admin:tags.canonicalDestination')" variant="outlined" density="compact" hide-details :disabled="busy || dirty" /><v-btn variant="outlined" class="mt-4" :disabled="!mergeTarget || busy || dirty" :loading="reviewing" @click="review({ action: 'merge', tagId: current.id, targetId: mergeTarget! })">{{ $t('admin:tags.reviewMerge') }}</v-btn></div></section>
            <section class="taxonomy-lifecycle-card"><v-icon :icon="current.isArchived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-outline'" size="26" aria-hidden="true" /><div><h4>{{ current.isArchived ? $t('admin:tags.restoreName') : $t('admin:tags.retireName') }}</h4><p>{{ current.isArchived ? $t('admin:tags.makeNameAvailableAgain') : current.redirectToId ? $t('admin:tags.stopAliasResolvingHistorical') : $t('admin:tags.removeCurrentPageAssignments') }}</p><v-btn variant="outlined" :disabled="busy || dirty" :loading="reviewing" @click="review({ action: current.isArchived ? 'restore' : 'archive', tagId: current.id })">{{ current.isArchived ? $t('admin:tags.reviewRestoration') : $t('admin:tags.reviewRetirement') }}</v-btn></div></section>
            <v-alert v-if="actionError" type="error" variant="tonal" class="mt-4">{{ actionError }}</v-alert>
          </div>
        </template>
      </section>
    </div>

    <v-dialog :model-value="createOpen" max-width="560" :persistent="creating" aria-labelledby="create-taxonomy-title" @update:model-value="setCreateDialog" @after-leave="restoreCreateFocus">
      <v-card class="taxonomy-dialog">
        <div class="taxonomy-dialog-heading"><span class="taxonomy-kicker">{{ $t('admin:tags.buildVocabulary') }}</span><h3 id="create-taxonomy-title">{{ $t('admin:tags.createTag2') }}</h3><p>{{ $t('admin:tags.reserveClearNameNow') }}</p></div>
        <form @submit.prevent="create">
          <v-card-text class="taxonomy-dialog-body">
            <v-text-field v-model="newTag.tag" :label="$t('admin:tags.newTagName')" variant="outlined" autofocus maxlength="255" :disabled="creating" :hint="$t('admin:tags.savedLowercaseExistingRetired')" persistent-hint />
            <v-text-field v-model="newTag.title" :label="$t('admin:tags.newDisplayLabel')" variant="outlined" class="mt-4" maxlength="255" :disabled="creating" hide-details />
            <v-alert v-if="createError" type="error" variant="tonal" class="mt-4">{{ createError }}</v-alert>
          </v-card-text>
          <v-card-actions><v-spacer /><v-btn variant="text" :disabled="creating" @click="closeCreate">{{ $t('common:actions.cancel') }}</v-btn><v-btn type="submit" variant="flat" color="primary" :disabled="!definitionValid(newTag) || creating" :loading="creating">{{ $t('admin:tags.createTag') }}</v-btn></v-card-actions>
        </form>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="reviewOpen" max-width="900" :persistent="applying || reviewing" aria-labelledby="taxonomy-review-title" @update:model-value="setReviewDialog">
      <v-card v-if="preview" class="taxonomy-dialog taxonomy-review">
        <div class="taxonomy-dialog-heading"><span class="taxonomy-kicker">{{ $t('admin:tags.reviewBeforeApplying') }}</span><h3 id="taxonomy-review-title">{{ reviewTitle }}</h3><p><bdi>{{ preview.source.tag }}</bdi><template v-if="preview.destination"> → <bdi>{{ preview.destination.tag }}</bdi></template></p></div>
        <v-card-text class="taxonomy-dialog-body">
          <div class="taxonomy-review-summary"><div><strong>{{ preview.pageCount }}</strong><span>{{ $t('admin:tags.pageAssignmentsChange') }}</span></div><div><strong>{{ preview.aliases.length }}</strong><span>{{ $t('admin:tags.existingAliasesConsidered') }}</span></div><div><strong>{{ preview.rules.filter(r => r.added || r.removed).length }}</strong><span>{{ $t('admin:tags.accessRulesChangeMatches') }}</span></div></div>
          <p class="taxonomy-review-explanation">{{ reviewExplanation }}</p>
          <dl v-if="preview.change.action === 'edit'" class="taxonomy-definition-review"><div><dt>{{ $t('admin:tags.savedDisplayLabel') }}</dt><dd><bdi>{{ preview.source.title || $t('admin:tags.none') }}</bdi></dd></div><div><dt>{{ $t('admin:tags.proposedDisplayLabel') }}</dt><dd><bdi>{{ preview.change.title || $t('admin:tags.none') }}</bdi></dd></div></dl>
          <h4 v-if="preview.rules.length" class="mt-6">{{ $t('admin:tags.tagBasedAccessRule') }}</h4><p v-if="preview.rules.length" class="taxonomy-muted">{{ $t('admin:tags.publicPageMatchCounts') }}</p>
          <div v-if="preview.rules.length" class="taxonomy-impact-table" tabindex="0" role="region" :aria-label="$t('admin:tags.accessRuleImpact')"><table><thead><tr><th scope="col">{{ $t('admin:tags.groupRule') }}</th><th scope="col">{{ $t('admin:tags.before') }}</th><th scope="col">{{ $t('admin:tags.after') }}</th><th scope="col">{{ $t('admin:tags.change') }}</th></tr></thead><tbody><tr v-for="(rule, i) in preview.rules" :key="i"><td><strong><bdi>{{ rule.groupName }}</bdi></strong><small>{{ rule.deny ? $t('admin:tags.deny') : $t('admin:tags.allow') }} · #{{ rule.path }}</small><small>{{ rule.roles.join(', ') }} · {{ rule.locales.length ? rule.locales.join(', ') : $t('admin:tags.allLanguages') }}</small></td><td>{{ rule.before }}</td><td>{{ rule.after }}</td><td>{{ rule.added || rule.removed ? `+${rule.added} / −${rule.removed}` : $t('admin:tags.unchanged') }}</td></tr></tbody></table></div>
          <v-checkbox v-if="preview.accessChanges" v-model="acknowledgeAccess" :label="$t('admin:tags.iUnderstandTheseTag')" hide-details class="mt-4" :disabled="applying || reviewing || reviewStale" />
          <details v-if="preview.pages.length" class="taxonomy-review-pages"><summary>{{ $t('admin:tags.affectedPagesCount', { count: preview.pages.length }) }}</summary><ul><li v-for="page in preview.pages" :key="page.id"><strong><bdi>{{ page.title || page.path }}</bdi></strong><span><bdi>{{ page.locale }} / {{ page.path }}</bdi> {{ $t('admin:tags.revision', { visibility: page.visibility, sourceRevision: page.sourceRevision, interpolation: { escapeValue: false } }) }}</span></li></ul></details>
          <v-alert v-if="reviewError || reviewStale" :type="reviewStale ? 'warning' : 'error'" variant="tonal" class="mt-5"><span v-if="reviewStale">{{ $t('admin:tags.impactReviewStaleRefresh') }}</span><span v-if="reviewError"> {{ reviewError }}</span><div><v-btn size="small" variant="text" class="mt-2" :disabled="applying || reviewing" :loading="reviewing" @click="review(preview.change)">{{ $t('admin:tags.refreshImpactReview') }}</v-btn></div></v-alert>
          <p class="taxonomy-muted mt-5">{{ $t('admin:tags.pageHistorySearchRender') }}</p>
        </v-card-text>
        <v-card-actions><v-btn variant="text" :disabled="applying || reviewing" @click="cancelReview">{{ $t('common:actions.cancel') }}</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="applying" :disabled="applying || reviewing || reviewStale || (preview.accessChanges && !acknowledgeAccess)" @click="apply">{{ $t('admin:tags.apply', { action: preview.change.action === 'edit' ? 'changes' : preview.change.action === 'archive' ? 'retirement' : preview.change.action === 'restore' ? 'restoration' : 'merge', interpolation: { escapeValue: false } }) }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import { taxonomyState, type TaxonomyChange, type TaxonomyInspection, type TaxonomyPreview, type TaxonomyTag } from '../../../shared/taxonomy.ts'
import { applyTaxonomy, createTaxonomyTag, fetchTaxonomy, inspectTaxonomy, previewTaxonomy } from '../../helpers/taxonomy-api.ts'
import { getErrorMessage } from '../../helpers/root-ui-store'

const emptyDefinition = () => ({ tag: '', title: '' })
const queryValue = (value: unknown): string => Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : ''
const errorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const value = Reflect.get(error, 'status')
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) {
    const status = Number(value)
    return Number.isFinite(status) ? status : undefined
  }
  return undefined
}
const isStaleReviewError = (error: unknown): boolean => {
  const message = getErrorMessage(error)
  return errorStatus(error) === 409 || /\b(stale|fingerprint|review (?:has )?changed|review (?:has )?expired)\b/i.test(message)
}

export default {
  components: { AsyncState },
  data() {
    return {
      tags: [] as TaxonomyTag[],
      inventoryLoaded: false,
      inspection: null as TaxonomyInspection | null,
      loading: false,
      loadError: '',
      detailLoading: false,
      detailError: '',
      loadSequence: 0,
      inventorySequence: 0,
      disposed: false,
      internalNavigation: false,
      search: '',
      view: 'active',
      pagination: 1,
      pageLimit: 25,
      directoryPageSize: 12,
      section: 'definition',
      draft: emptyDefinition(),
      mergeTarget: null as number | null,
      actionError: '',
      success: '',
      warnings: [] as string[],
      createOpen: false,
      createReturnFocus: null as HTMLElement | null,
      creating: false,
      createError: '',
      newTag: emptyDefinition(),
      reviewing: false,
      reviewOpen: false,
      preview: null as TaxonomyPreview | null,
      reviewError: '',
      reviewStale: false,
      acknowledgeAccess: false,
      applying: false,
      views: [
        { title: this.$t('admin:tags.activeTags'), value: 'active' },
        { title: this.$t('admin:tags.unusedActiveTags'), value: 'unused' },
        { title: this.$t('admin:tags.aliases'), value: 'alias' },
        { title: this.$t('admin:tags.archivedNames'), value: 'archived' },
        { title: this.$t('admin:tags.allNames'), value: 'all' }
      ],
      sections: [
        { title: this.$t('admin:tags.definition'), value: 'definition' },
        { title: this.$t('admin:tags.usageAccess'), value: 'usage' },
        { title: this.$t('admin:tags.lifecycle'), value: 'lifecycle' }
      ]
    }
  },
  computed: {
    current(): TaxonomyTag { return this.inspection!.tag },
    selectedId(): number { return Number(this.$route.query.tag) || 0 },
    destination(): TaxonomyTag | undefined { return this.tags.find(t => t.id === this.inspection?.tag.redirectToId) },
    mutationBusy(): boolean { return this.applying || this.creating || this.reviewing },
    busy(): boolean { return this.mutationBusy || this.reviewOpen },
    dirty(): boolean { return Boolean(this.inspection && (this.draft.tag !== this.current.tag || this.draft.title !== this.current.title)) },
    createDirty(): boolean { return Boolean(this.newTag.tag || this.newTag.title) },
    hasUnsavedChanges(): boolean { return this.dirty || this.createDirty },
    validDefinition(): boolean { return this.definitionValid(this.draft) },
    loadedNamesLabel(): string {
      return this.$t('admin:tags.loadedNames', { defaultValue: '{{count}} names loaded', count: this.tags.length })
    },
    registerRangeLabel(): string {
      return this.$t('admin:tags.registerRange', {
        defaultValue: '{{start}}–{{end}} of {{count}} matching names',
        start: this.filtered.length ? (this.pagination - 1) * this.directoryPageSize + 1 : 0,
        end: Math.min(this.pagination * this.directoryPageSize, this.filtered.length),
        count: this.filtered.length
      })
    },
    inventoryCounts(): { active: number; alias: number; unused: number } {
      const counts = { active: 0, alias: 0, unused: 0 }
      for (const tag of this.tags) {
        const state = this.state(tag)
        if (state === 'active') {
          counts.active++
          if (!tag.pageCount) counts.unused++
        } else if (state === 'alias') counts.alias++
      }
      return counts
    },
    filtered(): TaxonomyTag[] {
      const query = (this.search || '').trim().toLocaleLowerCase()
      return this.tags
        .filter(t => (this.view === 'all' || this.view === 'unused' ? this.view === 'all' || (this.state(t) === 'active' && !t.pageCount) : this.state(t) === this.view) && (!query || `${t.tag} ${t.title}`.toLocaleLowerCase().includes(query)))
        .sort((a, b) => a.tag.localeCompare(b.tag))
    },
    pageCount(): number { return Math.ceil(this.filtered.length / this.directoryPageSize) },
    visible(): TaxonomyTag[] { return this.filtered.slice((this.pagination - 1) * this.directoryPageSize, this.pagination * this.directoryPageSize) },
    mergeTargets(): TaxonomyTag[] { return this.tags.filter(t => this.state(t) === 'active' && t.id !== this.selectedId).sort((a, b) => a.tag.localeCompare(b.tag)) },
    reviewTitle(): string { return this.preview?.change.action === 'merge' ? this.$t('admin:tags.bringTwoConceptsTogether') : this.preview?.change.action === 'archive' ? this.$t('admin:tags.retireName') : this.preview?.change.action === 'restore' ? this.$t('admin:tags.restoreName') : this.preview?.destination ? this.$t('admin:tags.renameConcept') : this.$t('admin:tags.updateDisplayLabel') },
    reviewExplanation(): string {
      const change = this.preview?.change
      return change?.action === 'merge'
        ? this.$t('admin:tags.pageAssignmentsWillMove')
        : change?.action === 'archive'
          ? this.$t('admin:tags.nameWillArchivedRemain')
          : change?.action === 'restore'
            ? this.$t('admin:tags.nameWillBecomeAvailable')
            : this.preview?.destination
              ? this.$t('admin:tags.newNameBecomesCanonical')
              : this.$t('admin:tags.onlyDisplayLabelChanges')
    }
  },
  watch: {
    directoryPageSize() { this.pagination = 1 },
    pageCount(count: number) { this.pagination = Math.min(this.pagination, Math.max(1, count)) },
    selectedId(id: number) {
      this.section = 'definition'
      this.loadDetail(id)
    }
  },
  methods: {
    state: taxonomyState,
    stateLabel(tag: TaxonomyTag): string {
      return this.state(tag) === 'active' ? this.$t('admin:tags.activeState', { defaultValue: 'Active' }) : this.state(tag) === 'alias' ? this.$t('admin:tags.alias') : this.$t('admin:tags.archived')
    },
    locateSelected() {
      if (this.busy || !this.inspection) return
      this.search = ''
      this.view = 'all'
      const index = this.filtered.findIndex(tag => tag.id === this.current.id)
      if (index >= 0) this.pagination = Math.floor(index / this.directoryPageSize) + 1
    },
    definitionValid(value: { tag: string; title: string }): boolean {
      return Boolean(value.tag.trim()) && value.tag.trim().length <= 255 && value.title.trim().length <= 255 && !/[\u0000-\u001f\u007f]/.test(value.tag + value.title)
    },
    date(value: string): string {
      return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    },
    async confirmUnsaved(message: string): Promise<boolean> {
      return !this.hasUnsavedChanges || (await confirmDiscard(message))
    },
    select(id: number) {
      if (this.mutationBusy || id === this.selectedId) return
      void this.$router.replace({ query: { ...this.$route.query, tag: String(id) } })
    },
    async selectAfterWrite(id: number): Promise<void> {
      if (!id || this.disposed) return
      if (id === this.selectedId) {
        await this.loadDetail(id)
        return
      }
      this.internalNavigation = true
      try {
        await this.$router.replace({ query: { ...this.$route.query, tag: String(id) } })
      } catch (error) {
        if (!this.disposed) this.detailError = this.$t('admin:tags.changeWasSavedBut', { error: getErrorMessage(error), interpolation: { escapeValue: false } })
      } finally {
        this.internalNavigation = false
      }
    },
    resetDraft() {
      if (this.inspection) this.draft = { tag: this.current.tag, title: this.current.title }
      this.actionError = ''
    },
    viewSelected() {
      this.$nextTick(() => {
        const heading = document.getElementById('taxonomy-selected-title')
        if (heading instanceof HTMLElement) heading.focus()
      })
    },
    setSection(value: string) {
      if (this.busy || !this.sections.some(item => item.value === value)) return
      this.section = value
    },
    tabKey(event: KeyboardEvent, value: string) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = this.sections.findIndex(item => item.value === value)
      const tablist = (event.currentTarget as HTMLElement | null)?.closest('[role="tablist"]') as HTMLElement | null
      const direction = tablist?.getAttribute('dir') || (tablist && typeof window !== 'undefined' ? window.getComputedStyle(tablist).direction : '') || (typeof document !== 'undefined' ? document.documentElement.dir : '') || 'ltr'
      const forward = direction === 'rtl' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight'
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.sections.length - 1 : (index + (forward ? 1 : -1) + this.sections.length) % this.sections.length
      this.section = this.sections[next]!.value
      this.$nextTick(() => document.getElementById(`taxonomy-tab-${this.section}`)?.focus())
    },
    async loadInventory(): Promise<boolean> {
      const sequence = ++this.inventorySequence
      this.loading = true
      this.loadError = ''
      try {
        const tags = await fetchTaxonomy()
        if (this.disposed || sequence !== this.inventorySequence) return false
        this.tags = tags
        this.inventoryLoaded = true
        this.pagination = Math.min(this.pagination, Math.max(1, this.pageCount))
        return true
      } catch (error) {
        if (!this.disposed && sequence === this.inventorySequence) this.loadError = getErrorMessage(error)
        return false
      } finally {
        if (!this.disposed && sequence === this.inventorySequence) this.loading = false
      }
    },
    async refresh(): Promise<boolean> {
      if (this.busy || this.loading || this.hasUnsavedChanges || this.disposed) return false
      const loaded = await this.loadInventory()
      if (loaded && this.selectedId) await this.loadDetail(this.selectedId)
      return loaded
    },
    async loadDetail(id: number): Promise<boolean> {
      const sequence = ++this.loadSequence
      this.inspection = null
      this.draft = emptyDefinition()
      this.detailError = ''
      this.actionError = ''
      this.pageLimit = 25
      this.mergeTarget = null
      this.detailLoading = Boolean(id)
      if (!id) return true
      try {
        const inspection = await inspectTaxonomy(id)
        if (this.disposed || sequence !== this.loadSequence) return false
        if (inspection.tag.id !== id) {
          this.detailError = this.$t('admin:tags.selectedTagChangedWhile')
          return false
        }
        this.inspection = inspection
        this.resetDraft()
        return true
      } catch (error) {
        if (!this.disposed && sequence === this.loadSequence) this.detailError = getErrorMessage(error)
        return false
      } finally {
        if (!this.disposed && sequence === this.loadSequence) this.detailLoading = false
      }
    },
    async openCreate(event?: MouseEvent) {
      const returnFocusTo = event?.currentTarget ?? document.activeElement
      if (this.busy || !(await this.confirmUnsaved(this.$t('admin:tags.discardUnsavedTagChanges'))) || this.busy) return
      this.resetDraft()
      this.newTag = emptyDefinition()
      this.createError = ''
      this.createReturnFocus = returnFocusTo instanceof HTMLElement ? returnFocusTo : null
      this.createOpen = true
    },
    setCreateDialog(value: boolean) {
      if (value) {
        this.createOpen = true
        return
      }
      this.closeCreate()
    },
    async closeCreate(): Promise<boolean> {
      if (this.creating) return false
      if (!(await this.confirmUnsaved(this.$t('admin:tags.discardNewTagDraft'))) || this.creating) {
        this.createOpen = true
        return false
      }
      this.createOpen = false
      this.newTag = emptyDefinition()
      this.createError = ''
      return true
    },
    restoreCreateFocus(): void {
      const target = this.createReturnFocus
      this.createReturnFocus = null
      if (this.disposed || this.createOpen || !target?.isConnected || target.matches(':disabled') ||
          target.closest('[inert], [aria-hidden="true"]')) return
      target.focus({ preventScroll: true })
    },
    async create(): Promise<void> {
      if (this.creating || this.applying || this.reviewing || !this.definitionValid(this.newTag)) return
      const definition = { tag: this.newTag.tag, title: this.newTag.title }
      this.creating = true
      this.createError = ''
      try {
        let result: { id: number }
        try {
          result = await createTaxonomyTag(definition)
        } catch (error) {
          if (!this.disposed) this.createError = getErrorMessage(error)
          return
        }
        if (this.disposed) return
        this.newTag = emptyDefinition()
        this.createReturnFocus = null
        this.createOpen = false
        this.success = this.$t('admin:tags.tagCreatedReadyAssign')
        this.view = 'active'
        this.search = ''
        this.pagination = 1
        await this.loadInventory()
        await this.selectAfterWrite(result.id)
      } finally {
        this.creating = false
      }
    },
    reviewEdit() {
      if (this.dirty && this.validDefinition) void this.review({ action: 'edit', tagId: this.current.id, tag: this.draft.tag, title: this.draft.title })
    },
    async review(change: TaxonomyChange): Promise<void> {
      if (this.applying || this.creating || this.reviewing || this.disposed) return
      const wasOpen = Boolean(this.reviewOpen && this.preview)
      this.reviewing = true
      this.reviewError = ''
      if (!wasOpen) this.actionError = ''
      this.acknowledgeAccess = false
      try {
        const preview = await previewTaxonomy(change)
        if (this.disposed) return
        if (preview.change.action !== change.action || preview.change.tagId !== change.tagId || preview.source.id !== this.selectedId) {
          const message = this.$t('admin:tags.selectedTagChangedWhile2')
          if (wasOpen) {
            this.reviewStale = true
            this.reviewError = message
          } else {
            this.actionError = message
          }
          return
        }
        this.preview = preview
        this.reviewOpen = true
        this.reviewStale = false
      } catch (error) {
        if (this.disposed) return
        if (wasOpen) {
          this.reviewStale = true
          this.reviewError = getErrorMessage(error)
        } else {
          this.actionError = getErrorMessage(error)
        }
      } finally {
        if (!this.disposed) this.reviewing = false
      }
    },
    cancelReview() {
      if (this.applying || this.reviewing) return
      this.reviewOpen = false
      this.preview = null
      this.reviewError = ''
      this.reviewStale = false
      this.acknowledgeAccess = false
    },
    async setReviewDialog(value: boolean) {
      if (value) {
        this.reviewOpen = true
        return
      }
      if (this.applying || this.reviewing) {
        this.reviewOpen = true
        return
      }
      // Keep the review visible behind the question; it closes only when discarded.
      this.reviewOpen = true
      if (await confirmDiscard(this.$t('admin:tags.discardImpactReview'))) this.cancelReview()
    },
    async apply(): Promise<void> {
      if (!this.preview || this.applying || this.creating || this.reviewing || this.reviewStale || (this.preview.accessChanges && !this.acknowledgeAccess)) return
      const reviewed = this.preview
      this.applying = true
      this.reviewError = ''
      try {
        let result: Awaited<ReturnType<typeof applyTaxonomy>>
        try {
          result = await applyTaxonomy(reviewed, this.acknowledgeAccess)
        } catch (error) {
          if (!this.disposed) {
            this.reviewError = getErrorMessage(error)
            this.reviewStale = true
            this.acknowledgeAccess = false
            this.reviewOpen = true
            if (!isStaleReviewError(error)) this.reviewError = this.$t('admin:tags.refreshImpactReviewBefore', { reviewError: this.reviewError, interpolation: { escapeValue: false } })
          }
          return
        }
        if (this.disposed) return
        this.reviewOpen = false
        this.preview = null
        this.reviewStale = false
        this.acknowledgeAccess = false
        this.resetDraft()
        this.success = this.$t('admin:tags.taxonomyUpdatedChangeHas')
        this.warnings = result.refreshWarnings
        await this.loadInventory()
        await this.selectAfterWrite(result.tagId)
      } finally {
        this.applying = false
      }
    },
    beforeUnload(event: BeforeUnloadEvent) {
      if (this.hasUnsavedChanges || this.applying || this.creating || this.reviewing || this.reviewOpen) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
  },
  async beforeRouteLeave() {
    if (this.applying || this.creating || this.reviewing) return false
    const discardReview = this.reviewOpen && (await confirmDiscard(this.$t('admin:tags.discardUnappliedTaxonomyReview')))
    if (this.reviewOpen && !discardReview) return false
    if (!(await this.confirmUnsaved(this.$t('admin:tags.discardUnsavedTagChanges2')))) return false
    if (discardReview) this.cancelReview()
    return true
  },
  async beforeRouteUpdate(to, from) {
    if (this.internalNavigation || queryValue(to.query.tag) === queryValue(from.query.tag)) return true
    if (this.applying || this.creating || this.reviewing) return false
    const discardReview = this.reviewOpen && (await confirmDiscard(this.$t('admin:tags.discardUnappliedTaxonomyReview')))
    if (this.reviewOpen && !discardReview) return false
    if (!(await this.confirmUnsaved(this.$t('admin:tags.discardUnsavedTagChanges2')))) return false
    if (discardReview) this.cancelReview()
    return true
  },
  mounted() {
    void this.refresh()
    window.addEventListener('beforeunload', this.beforeUnload)
  },
  beforeUnmount() {
    this.disposed = true
    this.loadSequence++
    this.inventorySequence++
    window.removeEventListener('beforeunload', this.beforeUnload)
  }
}
</script>
<style lang="scss" scoped>
.admin-taxonomy {
  --taxonomy-border: var(--wiki-surface-border);
  --taxonomy-muted: var(--wiki-text-muted);
  min-width: 0;
  color: rgb(var(--v-theme-on-surface));
}

.admin-taxonomy :deep(.v-input),
.taxonomy-dialog :deep(.v-input) { min-width: 0; }

.admin-taxonomy :deep(.v-btn),
.taxonomy-dialog :deep(.v-btn) {
  max-width: 100%;
  min-height: 40px;
  height: auto;
  .v-btn__content { white-space: normal; padding-block: 6px; }
}

.taxonomy-definition-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: var(--wiki-success-ink);
  font-size: .8125rem;
  line-height: 1.5;
  &.is-draft { color: var(--wiki-warning-ink); }
}

.taxonomy-kicker {
  display: block;
  color: var(--taxonomy-muted);
  font-size: .75rem;
  font-weight: 750;
  line-height: 1.4;
}

.taxonomy-register-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 12px 16px;
  margin-block: 16px;
  border: 1px solid var(--taxonomy-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  font-size: .8125rem;
  color: var(--taxonomy-muted);
  dl { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 0; }
  dl > div { display: flex; gap: 8px; align-items: baseline; }
  dd { margin: 0; font-weight: 650; color: rgb(var(--v-theme-on-surface)); font-variant-numeric: tabular-nums; }
}

.taxonomy-directory-scope {
  margin: 0;
  color: var(--taxonomy-muted);
  font-size: .8125rem;
  line-height: 1.5;
}

.taxonomy-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}

.taxonomy-directory,
.taxonomy-detail {
  min-width: 0;
  border: 1px solid var(--taxonomy-border);
  border-radius: var(--wiki-panel-radius, 12px);
  background: var(--wiki-surface-raised, rgb(var(--v-theme-surface)));
}

.taxonomy-directory {
  grid-template-columns: minmax(0, 1fr);
  display: grid;
  gap: 12px;
  padding: 16px;
}

.taxonomy-directory-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;

  h3 {
    margin: 0;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1rem;
    font-weight: 650;
  }

  span {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    white-space: nowrap;
  }
}

.taxonomy-directory-count {
  margin: 0;
  color: var(--taxonomy-muted);
  font-size: .8125rem;
  line-height: 1.5;
}

.taxonomy-records {
  display: grid;
  gap: 4px;
  min-width: 0;
  max-height: min(64dvh, 680px);
  overflow-y: auto;
  padding: 3px;
}

.taxonomy-record {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 52px;
  width: 100%;
  gap: 10px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius);
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: start;
  transition: background-color var(--wiki-motion-fast, 120ms) var(--wiki-motion-ease, ease), border-color var(--wiki-motion-fast, 120ms) var(--wiki-motion-ease, ease);

  > span:nth-child(2) {
    min-width: 0;
    flex: 1;
  }

  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }

  strong {
    font-size: .875rem;
    font-weight: 650;
    line-height: 1.35;
  }

  small {
    margin-top: 3px;
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.35;
  }

  &:hover {
    background: var(--wiki-surface-sunken);
  }

  &.is-selected {
    border-color: var(--wiki-accent-ink);
    background: var(--wiki-surface-sunken);
    color: var(--wiki-accent-ink);
  }
}

.taxonomy-record-meta {
  flex-shrink: 0;
  text-align: end;

  b {
    display: block;
    font-size: .875rem;
    font-weight: 600;
  }
}

.taxonomy-directory-note {
  margin: 4px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--taxonomy-border);
  color: var(--taxonomy-muted);
  font-size: .8125rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.taxonomy-view-selected {
  display: none;
}

.taxonomy-empty {
  padding: 24px 4px;
  text-align: center;

  h4 {
    margin: 12px 0 6px;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1rem;
  }

  p {
    margin: 0 0 12px;
    color: var(--taxonomy-muted);
    font-size: .875rem;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
}

.taxonomy-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.taxonomy-loaded-status {
  margin: 0;
  padding: 16px 24px 0;
  color: var(--taxonomy-muted);
  font-size: .8125rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.taxonomy-welcome {
  padding: 24px 20px;
  text-align: start;

  h3 {
    margin: 8px 0;
    font-family: var(--wiki-font-heading);
    font-size: 1.125rem;
    font-weight: 650;
    line-height: 1.4;
  }

  > p {
    max-width: 480px;
    margin: 0;
    color: var(--taxonomy-muted);
    font-size: .9375rem;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
}


.taxonomy-identity {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 16px;
  padding: 24px 24px 16px;
}

.taxonomy-identity-icon {
  flex-shrink: 0;
  color: var(--wiki-accent-ink);
}

.taxonomy-identity-main {
  min-width: 0;
  flex: 1;

  h2 {
    margin: 8px 0 4px;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1.25rem;
    font-weight: 650;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
}

.taxonomy-identity-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 12px;
  flex-wrap: wrap;
}

.taxonomy-name {
  margin: 0;
  color: var(--taxonomy-muted);
  font: .875rem var(--wiki-font-mono, ui-monospace, monospace);
  overflow-wrap: anywhere;
}

.taxonomy-destination {
  display: flex;
  align-items: flex-start;
  min-width: 0;
  gap: 10px;
  margin: 0 24px 16px;
  padding: 12px;
  border-radius: var(--wiki-radius-xs, 6px);
  background: var(--wiki-surface-sunken, rgba(var(--v-theme-on-surface), .04));
  font-size: .875rem;
  line-height: 1.5;

  span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  button {
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    overflow-wrap: anywhere;
  }
}

.taxonomy-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 0 24px 24px;
  padding-top: 16px;
  border-top: 1px solid var(--taxonomy-border);

  dt {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.4;
  }

  dd {
    margin: 6px 0 0;
    font-size: 1.125rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
}

.taxonomy-tabs {
  display: flex;
  min-width: 0;
  gap: 8px;
  padding: 0 16px;
  border-block: 1px solid var(--taxonomy-border);
  flex-wrap: wrap;

  button {
    min-height: 52px;
    padding: 8px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--taxonomy-muted);
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: .875rem;
    overflow-wrap: anywhere;

    &[aria-selected='true'] {
      border-bottom-color: var(--wiki-accent-ink);
      background: var(--wiki-surface-sunken);
      color: rgb(var(--v-theme-on-surface));
      font-weight: 650;
    }
  }
}

.taxonomy-panel {
  min-width: 0;
  padding: 24px;

  h4 {
    margin: 0;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1rem;
    font-weight: 650;

    span {
      margin-inline-start: 6px;
      color: var(--taxonomy-muted);
      font-weight: 400;
    }
  }
}

.taxonomy-section-heading {
  margin-bottom: 24px;

  h3 {
    margin: 0 0 8px;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1.0625rem;
    font-weight: 650;
    letter-spacing: -.02em;
  }

  p {
    max-width: 720px;
    margin: 0;
    color: var(--taxonomy-muted);
    font-size: .875rem;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
}

.taxonomy-save {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 16px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--taxonomy-border);

  > span {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
  }

  > div {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
}

.taxonomy-dates {
  display: flex;
  gap: 32px;
  margin-top: 32px;
  font-size: .8125rem;

  div {
    display: grid;
    gap: 4px;
  }

  span {
    color: var(--taxonomy-muted);
  }
}

.taxonomy-muted {
  margin: 8px 0 16px;
  color: var(--taxonomy-muted, var(--wiki-text-muted));
  font-size: .875rem;
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.taxonomy-subheading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.taxonomy-page-list {
  display: grid;
  min-width: 0;

  > a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    gap: 16px;
    padding: 14px 0;
    border-bottom: 1px solid var(--taxonomy-border);
    color: inherit;
    text-decoration: none;

    > span:first-child {
      min-width: 0;
    }

    strong,
    small {
      display: block;
      overflow-wrap: anywhere;
    }

    strong {
      font-size: .875rem;
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 3px;
    }

    small {
      margin-top: 4px;
      color: var(--taxonomy-muted);
      font-size: .8125rem;
    }

    > span:last-child {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      gap: 4px;
      color: var(--taxonomy-muted);
      font-size: .8125rem;
    }
  }
}

.taxonomy-aliases {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;

  button {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    max-width: 100%;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--taxonomy-border);
    border-radius: var(--wiki-radius-xs, 6px);
    background: transparent;
    color: inherit;
    font-size: .8125rem;
    overflow-wrap: anywhere;
  }

  small {
    color: var(--taxonomy-muted);
  }
}

.taxonomy-rule-list {
  display: grid;
  gap: 10px;

  article {
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--taxonomy-border);
    border-radius: var(--wiki-radius-xs, 6px);

    > div {
      display: flex;
      justify-content: space-between;
      min-width: 0;
      gap: 8px;
      flex-wrap: wrap;
    }

    a {
      color: inherit;
      font-size: .875rem;
      font-weight: 650;
      text-underline-offset: 3px;
      overflow-wrap: anywhere;
    }

    p {
      margin: 8px 0;
      color: var(--taxonomy-muted);
      font-size: .8125rem;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }

    strong {
      font-size: .8125rem;
      font-weight: 550;
    }
  }
}

.taxonomy-rule-kind {
  color: var(--taxonomy-muted);
  font-size: .8125rem;
  overflow-wrap: anywhere;
}

.taxonomy-lifecycle-card {
  display: flex;
  align-items: flex-start;
  min-width: 0;
  gap: 16px;
  margin-top: 16px;
  padding: 20px;
  border: 1px solid var(--taxonomy-border);
  border-radius: var(--wiki-radius-xs, 6px);

  > div {
    min-width: 0;
    flex: 1;
  }

  h4 {
    margin: 0;
  }

  p {
    margin: 8px 0 16px;
    color: var(--taxonomy-muted);
    font-size: .875rem;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
}

.taxonomy-dialog {
  --taxonomy-border: var(--wiki-surface-border);
  --taxonomy-muted: var(--wiki-text-muted);
  max-width: 100%;
  max-height: calc(100dvh - 32px);
  border: 1px solid var(--taxonomy-border);

  .v-card-actions {
    display: flex;
    min-width: 0;
    gap: 8px;
    padding: 16px 24px calc(16px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--taxonomy-border);
    flex-wrap: wrap;
  }
}

.taxonomy-dialog-heading {
  min-width: 0;
  padding: 24px 24px 16px;

  h3 {
    margin: 8px 0;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1.5rem;
    font-weight: 650;
    letter-spacing: -.03em;
    line-height: 1.25;
  }

  p {
    margin: 0;
    color: var(--taxonomy-muted);
    font-size: .875rem;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
}

.taxonomy-dialog-body {
  min-width: 0;
  max-height: min(70dvh, 680px);
  overflow-y: auto;
}

.taxonomy-review-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  padding: 16px 0;
  border-block: 1px solid var(--taxonomy-border);

  strong {
    display: block;
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  span {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.45;
  }
}

.taxonomy-review-explanation {
  margin: 20px 0;
  font-size: .9375rem;
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.taxonomy-definition-review {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 16px;
  border-radius: var(--wiki-radius-xs, 6px);
  background: var(--wiki-surface-sunken, rgba(var(--v-theme-on-surface), .04));

  div {
    min-width: 0;
  }

  dt {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.45;
  }

  dd {
    margin: 4px 0 0;
    font-size: .9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
}

.taxonomy-impact-table {
  max-width: 100%;
  border: 1px solid var(--taxonomy-border);
  border-radius: var(--wiki-radius-xs, 6px);
  overflow-x: auto;

  table {
    width: 100%;
    min-width: 640px;
    border-collapse: collapse;
    text-align: start;
    font-size: .8125rem;
  }

  th,
  td {
    padding: 12px;
    border-bottom: 1px solid var(--taxonomy-border);
    vertical-align: top;
  }

  th {
    font-size: .8125rem;
    font-weight: 650;
    white-space: nowrap;
  }

  td:first-child {
    min-width: 240px;
  }

  td:not(:first-child) {
    white-space: nowrap;
  }

  small {
    display: block;
    margin-top: 4px;
    color: var(--taxonomy-muted);
    font-size: .75rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: normal;
  }
}

.taxonomy-review-pages {
  margin-top: 20px;
  padding: 16px 0;
  border-block: 1px solid var(--taxonomy-border);

  summary {
    min-height: 44px;
    cursor: pointer;
    font-size: .875rem;
    font-weight: 650;
    line-height: 44px;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    min-width: 0;
    gap: 4px;
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--taxonomy-border);
    font-size: .8125rem;
    overflow-wrap: anywhere;
  }

  span {
    color: var(--taxonomy-muted);
    font-size: .75rem;
    line-height: 1.5;
  }
}

button:focus-visible,
a:focus-visible,
summary:focus-visible,
.taxonomy-impact-table:focus-visible,
.taxonomy-view-selected:focus-visible {
  outline: 2px solid var(--wiki-focus-color, rgb(var(--v-theme-primary)));
  outline-offset: var(--wiki-focus-offset, 2px);
}

@media (forced-colors: active) {
  button:focus-visible,
  a:focus-visible,
  summary:focus-visible,
  .taxonomy-impact-table:focus-visible,
  .taxonomy-view-selected:focus-visible {
    outline-color: Highlight;
  }
}

@media (max-width: 959.98px) {
  .taxonomy-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .taxonomy-view-selected {
    display: inline-flex;
    justify-self: start;
  }
}

@media (max-width: 599.98px) {
  .admin-taxonomy :deep(.v-btn),
  .taxonomy-dialog :deep(.v-btn) { min-height: 44px; }
  .admin-taxonomy :deep(.v-selection-control__input),
  .taxonomy-dialog :deep(.v-selection-control__input) { min-width: 44px; min-height: 44px; }
  .taxonomy-directory :deep(.v-pagination__list) { flex-wrap: wrap; }
  .taxonomy-register-summary { padding: 12px; gap: 12px; dl { gap: 8px 16px; } }

  .taxonomy-directory {
    padding: 16px;
  }

  .taxonomy-directory-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .taxonomy-identity {
    align-items: flex-start;
    padding: 16px;
  }


  .taxonomy-identity-main h2 {
    font-size: 1.4rem;
  }

  .taxonomy-loaded-status {
    padding-inline: 16px;
  }

  .taxonomy-destination {
    margin-inline: 16px;
  }

  .taxonomy-facts {
    grid-template-columns: 1fr;
    margin-inline: 16px;
  }

  .taxonomy-tabs {
    padding-inline: 8px;
    gap: 0;

    button {
      flex: 1 1 100%;
      min-height: 44px;
      text-align: start;
    }
  }

  .taxonomy-panel {
    padding: 16px;
  }

  .taxonomy-save {
    align-items: flex-start;
    flex-direction: column;

    > div {
      width: 100%;
    }
  }

  .taxonomy-dates {
    display: grid;
    gap: 12px;
  }

  .taxonomy-page-list > a {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;

    > span:last-child {
      align-self: flex-start;
    }
  }

  .taxonomy-lifecycle-card {
    flex-direction: column;
    padding: 16px;

    > div {
      width: 100%;
      min-width: 0;
    }
  }


  .taxonomy-review-summary,
  .taxonomy-definition-review {
    grid-template-columns: 1fr;
  }

  .taxonomy-dialog {
    .v-card-actions {
      padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
    }

    .v-spacer {
      flex: 1 0 100%;
      width: 100%;
      height: 0;
    }
  }

  .taxonomy-dialog-heading {
    padding: 16px 16px 12px;
  }

  .taxonomy-dialog-body {
    max-height: min(65dvh, 560px);
    padding-inline: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .taxonomy-record {
    transition: none;
  }
}
</style>

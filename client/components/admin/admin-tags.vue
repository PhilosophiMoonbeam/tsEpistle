<template>
  <v-container fluid class="admin-taxonomy">
    <admin-hero title="Tags" description="A shared vocabulary for people and agents." icon="mdi-tag-multiple-outline">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy || hasUnsavedChanges" @click="refresh">Refresh</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-plus" :disabled="busy" @click="openCreate">Create tag</v-btn>
      </template>
    </admin-hero>

    <section class="taxonomy-intro" aria-labelledby="taxonomy-intro-title">
      <div>
        <span class="taxonomy-kicker">Shared vocabulary</span>
        <h2 id="taxonomy-intro-title">Give knowledge a common language.</h2>
        <p>Define meaningful labels, understand their reach, and evolve the vocabulary without losing aliases, access context, or history.</p>
      </div>
      <dl>
        <div><dt>Active tags</dt><dd>{{ tags.filter(t => state(t) === 'active').length }}</dd></div>
        <div><dt>Aliases</dt><dd>{{ tags.filter(t => state(t) === 'alias').length }}</dd></div>
        <div><dt>Unused active</dt><dd>{{ tags.filter(t => state(t) === 'active' && !t.pageCount).length }}</dd></div>
      </dl>
    </section>

    <v-alert v-if="success" type="success" variant="tonal" class="mb-4" role="status" closable @click:close="success = ''">{{ success }}</v-alert>
    <v-alert v-for="warning in warnings" :key="warning" type="warning" variant="tonal" class="mb-4">{{ warning }}</v-alert>
    <v-alert v-if="loadError && tags.length" type="error" variant="tonal" class="mb-4">
      <span>{{ loadError }}</span>
      <v-btn variant="text" size="small" class="ms-2" :disabled="busy || hasUnsavedChanges" @click="refresh">Retry reload</v-btn>
    </v-alert>

    <async-state v-if="loading && !tags.length" state="loading" title="Loading the vocabulary" message="Reading tag definitions, page usage and access rules." />
    <async-state v-else-if="!tags.length && loadError" state="error" title="The vocabulary could not be loaded" :message="loadError" retry-label="Try again" @retry="refresh" />
    <div v-else class="taxonomy-workspace">
      <aside class="taxonomy-directory" aria-label="Tag directory" :aria-busy="loading">
        <div class="taxonomy-directory-heading"><h3>Vocabulary</h3><span>{{ tags.length }} {{ tags.length === 1 ? 'name' : 'names' }}</span></div>
        <v-text-field v-model="search" label="Find a tag or label" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable :disabled="busy" @update:model-value="pagination = 1" />
        <v-select v-model="view" :items="views" label="Vocabulary view" variant="outlined" density="compact" hide-details :disabled="busy" @update:model-value="pagination = 1" />
        <p class="taxonomy-directory-count" role="status">{{ filtered.length }} {{ filtered.length === 1 ? 'name' : 'names' }} in this view</p>
        <div v-if="!filtered.length" class="taxonomy-empty">
          <v-icon icon="mdi-tag-search-outline" size="30" aria-hidden="true" />
          <h4>{{ tags.length ? 'No matching names' : 'Start a shared vocabulary' }}</h4>
          <p>{{ tags.length ? 'Try another term or vocabulary view.' : 'Create a tag before assigning it to pages, or add one while editing a page.' }}</p>
          <v-btn v-if="tags.length" size="small" variant="text" :disabled="busy" @click="search = ''; view = 'all'">Clear filters</v-btn>
        </div>
        <div v-else class="taxonomy-records">
          <button v-for="entry in visible" :key="entry.id" type="button" class="taxonomy-record" :class="{ 'is-selected': selectedId === entry.id }" :aria-pressed="selectedId === entry.id" :aria-label="`${entry.title || entry.tag}, ${state(entry)}${selectedId === entry.id ? ', selected' : ''}`" :disabled="mutationBusy" @click="select(entry.id)">
            <v-icon :icon="selectedId === entry.id ? 'mdi-check' : state(entry) === 'alias' ? 'mdi-arrow-u-right-top' : state(entry) === 'archived' ? 'mdi-archive-outline' : 'mdi-pound'" size="18" aria-hidden="true" />
            <span><strong><bdi>{{ entry.tag }}</bdi></strong><small><bdi>{{ entry.title || (state(entry) === 'alias' ? 'Alias' : 'No display label') }}</bdi></small></span>
            <span class="taxonomy-record-meta"><b>{{ entry.pageCount }}</b><small>{{ state(entry) === 'active' ? 'pages' : state(entry) }}</small></span>
          </button>
        </div>
        <v-pagination v-if="pageCount > 1" v-model="pagination" :length="pageCount" :total-visible="3" density="compact" aria-label="Tag directory pages" :disabled="busy" />
        <v-btn v-if="inspection" class="taxonomy-view-selected" variant="outlined" prepend-icon="mdi-eye-outline" :disabled="busy" @click="viewSelected">View selected tag</v-btn>
        <p class="taxonomy-directory-note">Aliases keep old names useful. Archived names remain reserved for history.</p>
      </aside>

      <section class="taxonomy-detail" aria-labelledby="taxonomy-selected-title" :aria-busy="detailLoading">
        <h2 v-if="!inspection" id="taxonomy-selected-title" class="taxonomy-visually-hidden">Selected tag details</h2>
        <async-state v-if="detailLoading" state="loading" title="Reading this tag" message="Gathering page assignments and access rule references." />
        <async-state v-else-if="detailError" state="error" title="This tag could not be opened" :message="detailError" retry-label="Try again" @retry="loadDetail(selectedId)" />
        <div v-else-if="!inspection" class="taxonomy-welcome">
          <div class="taxonomy-welcome-mark" aria-hidden="true">#</div>
          <span class="taxonomy-kicker">A vocabulary that can grow</span>
          <h3>Choose a name. Understand its reach.</h3>
          <p>Every tag has a definition, a set of page assignments and a place in your access rules. Select one to see the whole picture.</p>
          <div class="taxonomy-principles">
            <div><v-icon icon="mdi-tag-outline" aria-hidden="true" /><strong>Define</strong><p>Give each concept a clear, consistent name.</p></div>
            <div><v-icon icon="mdi-source-merge" aria-hidden="true" /><strong>Consolidate</strong><p>Bring overlapping concepts together with an impact review.</p></div>
            <div><v-icon icon="mdi-history" aria-hidden="true" /><strong>Preserve</strong><p>Keep historical labels as your vocabulary evolves.</p></div>
          </div>
        </div>
        <template v-else>
          <p class="taxonomy-loaded-status" role="status">Loaded <bdi>{{ current.title || current.tag }}</bdi></p>
          <header class="taxonomy-identity">
            <div class="taxonomy-identity-mark" aria-hidden="true">#</div>
            <div class="taxonomy-identity-main">
              <div class="taxonomy-identity-meta"><span class="taxonomy-kicker">{{ state(current) === 'alias' ? 'Historical name' : state(current) === 'archived' ? 'Archived vocabulary' : 'Canonical tag' }}</span><v-chip size="small" variant="outlined">{{ state(current) }}</v-chip></div>
              <h2 id="taxonomy-selected-title" tabindex="-1"><bdi>{{ current.title || current.tag }}</bdi></h2>
              <p v-if="current.title && current.title !== current.tag" class="taxonomy-name"><bdi>{{ current.tag }}</bdi></p>
            </div>
          </header>
          <div v-if="current.redirectToId" class="taxonomy-destination"><v-icon icon="mdi-arrow-u-right-top" size="18" aria-hidden="true" /><span>{{ current.isArchived ? 'Retired alias of' : 'Resolves to' }} <button type="button" :disabled="mutationBusy" @click="select(current.redirectToId!)"><bdi>{{ destination?.tag || `Tag #${current.redirectToId}` }}</bdi></button></span></div>
          <dl class="taxonomy-facts"><div><dt>{{ current.redirectToId ? 'Destination pages' : 'Assigned pages' }}</dt><dd>{{ current.pageCount }}</dd></div><div><dt>Tag-based rules</dt><dd>{{ current.ruleCount }}</dd></div><div><dt>History references</dt><dd>{{ current.historyCount }}</dd></div></dl>

          <div class="taxonomy-tabs" role="tablist" aria-label="Tag sections">
            <button v-for="item in sections" :id="`taxonomy-tab-${item.value}`" :key="item.value" type="button" role="tab" :aria-selected="section === item.value" :aria-controls="`taxonomy-panel-${item.value}`" :tabindex="section === item.value ? 0 : -1" :disabled="busy" @click="setSection(item.value)" @keydown="tabKey($event, item.value)">{{ item.title }}</button>
          </div>

          <div v-show="section === 'definition'" id="taxonomy-panel-definition" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-definition" :aria-hidden="section !== 'definition'" :inert="section !== 'definition'">
            <div class="taxonomy-section-heading"><h3>Definition</h3><p>A stable name for links, page assignments and agent tools. The display label adds a human-friendly title.</p></div>
            <form v-if="state(current) === 'active'" @submit.prevent="reviewEdit">
              <v-text-field v-model="draft.tag" label="Tag name" variant="outlined" maxlength="255" counter="255" :disabled="busy" hint="Names are trimmed and saved in lowercase. Renaming preserves this name as an alias." persistent-hint />
              <v-text-field v-model="draft.title" label="Display label" variant="outlined" maxlength="255" counter="255" :disabled="busy" hint="Optional. For example, agent-memory → Agent memory." persistent-hint class="mt-4" />
              <v-alert v-if="actionError" type="error" variant="tonal" class="mt-4">{{ actionError }}</v-alert>
              <div class="taxonomy-save"><span role="status">{{ dirty ? 'Unsaved definition' : 'Matches the saved definition' }}</span><div><v-btn type="button" variant="text" :disabled="!dirty || busy" @click="resetDraft">Reset</v-btn><v-btn type="submit" variant="flat" color="primary" :disabled="!dirty || !validDefinition || busy" :loading="reviewing">Review changes</v-btn></div></div>
            </form>
            <v-alert v-else type="info" variant="tonal">{{ current.isArchived ? 'This name is retired. Restore it from Lifecycle before changing its definition or assigning it to pages.' : 'This is a preserved name. Edit the canonical destination to change the concept; retire the alias if this name should stop resolving.' }}</v-alert>
            <div class="taxonomy-dates"><div><span>Created</span><time :datetime="current.createdAt">{{ date(current.createdAt) }}</time></div><div><span>Last changed</span><time :datetime="current.updatedAt">{{ date(current.updatedAt) }}</time></div></div>
          </div>

          <div v-show="section === 'usage'" id="taxonomy-panel-usage" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-usage" :aria-hidden="section !== 'usage'" :inert="section !== 'usage'">
            <div class="taxonomy-section-heading"><h3>Where this name reaches</h3><p>Page assignments, historical names and the groups whose tag-based rules reference this concept.</p></div>
            <div class="taxonomy-subheading"><h4>Assigned pages <span>{{ inspection.pages.length }}</span></h4><v-btn v-if="inspection.pages.length" size="small" variant="text" :href="`/t/${encodeURIComponent(current.tag)}`" target="_blank" rel="noopener" append-icon="mdi-open-in-new">Open in wiki</v-btn></div>
            <p v-if="!inspection.pages.length" class="taxonomy-muted">No current page assignments. {{ current.isArchived ? 'Restoring a name does not restore its former assignments.' : 'Use this tag when creating or editing a page.' }}</p>
            <div v-else class="taxonomy-page-list"><router-link v-for="page in inspection.pages.slice(0, pageLimit)" :key="page.id" :to="`/pages/${page.id}`"><span><strong><bdi>{{ page.title || page.path }}</bdi></strong><small><bdi>{{ page.locale }} / {{ page.path }}</bdi></small></span><span>{{ page.visibility === 'private' ? 'Private' : 'Workspace' }}<v-icon icon="mdi-chevron-right" size="16" aria-hidden="true" /></span></router-link><v-btn v-if="inspection.pages.length > pageLimit" variant="text" @click="pageLimit += 25">Show more pages</v-btn></div>
            <h4 class="mt-7">Preserved aliases <span>{{ inspection.aliases.length }}</span></h4><div v-if="inspection.aliases.length" class="taxonomy-aliases"><button v-for="alias in inspection.aliases" :key="alias.id" type="button" :disabled="mutationBusy" @click="select(alias.id)"><v-icon icon="mdi-arrow-u-right-top" size="16" aria-hidden="true" /><bdi>{{ alias.tag }}</bdi><small v-if="alias.isArchived">archived</small></button></div><p v-else class="taxonomy-muted">No other names have been preserved for this tag.</p>
            <h4 class="mt-7">Access rule references <span>{{ inspection.rules.length }}</span></h4><p class="taxonomy-muted">Counts show public pages matched by each tag rule, including its language filter. Effective access also depends on group permissions, other rules and private-page ownership.</p>
            <div v-if="inspection.rules.length" class="taxonomy-rule-list"><article v-for="(rule, i) in inspection.rules" :key="i"><div><router-link :to="`/groups/${rule.groupId}`">{{ rule.groupName }}</router-link><span class="taxonomy-rule-kind">{{ rule.deny ? 'Deny' : 'Allow' }} · #{{ rule.path }}</span></div><p>{{ rule.roles.join(', ') }} · {{ rule.locales.length ? rule.locales.join(', ') : 'All languages' }}</p><strong>{{ rule.before }} public {{ rule.before === 1 ? 'page matches' : 'pages match' }}</strong></article></div><p v-else class="taxonomy-muted">No group uses this name or its active aliases in a tag-based page rule.</p>
          </div>

          <div v-show="section === 'lifecycle'" id="taxonomy-panel-lifecycle" class="taxonomy-panel" role="tabpanel" aria-labelledby="taxonomy-tab-lifecycle" :aria-hidden="section !== 'lifecycle'" :inert="section !== 'lifecycle'">
            <div class="taxonomy-section-heading"><h3>Let the vocabulary evolve</h3><p>Every lifecycle change includes a current impact review. Historical labels stay attached to their original page versions.</p></div>
            <v-alert v-if="dirty" type="info" variant="tonal" class="mb-5">Review or reset your definition changes before changing this tag’s lifecycle.</v-alert>
            <section v-if="state(current) === 'active'" class="taxonomy-lifecycle-card"><v-icon icon="mdi-source-merge" size="26" aria-hidden="true" /><div><h4>Merge into another tag</h4><p>Consolidate page assignments under one canonical name. This name and its aliases will resolve to the destination. Tag-based rules can match more pages after a merge.</p><v-autocomplete v-model="mergeTarget" :items="mergeTargets" item-title="tag" item-value="id" label="Canonical destination" variant="outlined" density="compact" hide-details :disabled="busy || dirty" /><v-btn variant="outlined" class="mt-4" :disabled="!mergeTarget || busy || dirty" :loading="reviewing" @click="review({ action: 'merge', tagId: current.id, targetId: mergeTarget! })">Review merge</v-btn></div></section>
            <section class="taxonomy-lifecycle-card"><v-icon :icon="current.isArchived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-outline'" size="26" aria-hidden="true" /><div><h4>{{ current.isArchived ? 'Restore this name' : 'Retire this name' }}</h4><p>{{ current.isArchived ? 'Make the name available again. Removed page assignments stay removed. An alias can be restored after its canonical destination is active.' : current.redirectToId ? 'Stop this alias from resolving. Its historical references remain. Rules using this name will stop matching its destination pages.' : 'Remove current page assignments and archive this tag and its aliases. Historical names remain reserved; access rule matches may change.' }}</p><v-btn variant="outlined" :disabled="busy || dirty" :loading="reviewing" @click="review({ action: current.isArchived ? 'restore' : 'archive', tagId: current.id })">{{ current.isArchived ? 'Review restoration' : 'Review retirement' }}</v-btn></div></section>
            <v-alert v-if="actionError" type="error" variant="tonal" class="mt-4">{{ actionError }}</v-alert>
          </div>
        </template>
      </section>
    </div>

    <v-dialog :model-value="createOpen" max-width="560" :persistent="creating" aria-labelledby="create-taxonomy-title" @update:model-value="setCreateDialog">
      <v-card class="taxonomy-dialog">
        <div class="taxonomy-dialog-heading"><span class="taxonomy-kicker">Build the vocabulary</span><h3 id="create-taxonomy-title">Create a tag</h3><p>Reserve a clear name now. Assign it to pages when the concept is ready to use.</p></div>
        <form @submit.prevent="create">
          <v-card-text class="taxonomy-dialog-body">
            <v-text-field v-model="newTag.tag" label="New tag name" variant="outlined" autofocus maxlength="255" :disabled="creating" hint="Saved in lowercase. Existing and retired names are reserved." persistent-hint />
            <v-text-field v-model="newTag.title" label="New display label" variant="outlined" class="mt-4" maxlength="255" :disabled="creating" hide-details />
            <v-alert v-if="createError" type="error" variant="tonal" class="mt-4">{{ createError }}</v-alert>
          </v-card-text>
          <v-card-actions><v-spacer /><v-btn variant="text" :disabled="creating" @click="closeCreate">Cancel</v-btn><v-btn type="submit" variant="flat" color="primary" :disabled="!definitionValid(newTag) || creating" :loading="creating">Create tag</v-btn></v-card-actions>
        </form>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="reviewOpen" max-width="900" :persistent="applying || reviewing" aria-labelledby="taxonomy-review-title" @update:model-value="setReviewDialog">
      <v-card v-if="preview" class="taxonomy-dialog taxonomy-review">
        <div class="taxonomy-dialog-heading"><span class="taxonomy-kicker">Review before applying</span><h3 id="taxonomy-review-title">{{ reviewTitle }}</h3><p><bdi>{{ preview.source.tag }}</bdi><template v-if="preview.destination"> → <bdi>{{ preview.destination.tag }}</bdi></template></p></div>
        <v-card-text class="taxonomy-dialog-body">
          <div class="taxonomy-review-summary"><div><strong>{{ preview.pageCount }}</strong><span>page assignments change</span></div><div><strong>{{ preview.aliases.length }}</strong><span>existing aliases considered</span></div><div><strong>{{ preview.rules.filter(r => r.added || r.removed).length }}</strong><span>access rules change matches</span></div></div>
          <p class="taxonomy-review-explanation">{{ reviewExplanation }}</p>
          <dl v-if="preview.change.action === 'edit'" class="taxonomy-definition-review"><div><dt>Saved display label</dt><dd><bdi>{{ preview.source.title || 'None' }}</bdi></dd></div><div><dt>Proposed display label</dt><dd><bdi>{{ preview.change.title || 'None' }}</bdi></dd></div></dl>
          <h4 v-if="preview.rules.length" class="mt-6">Tag-based access rule impact</h4><p v-if="preview.rules.length" class="taxonomy-muted">Public-page match counts include each rule’s language filter. These are rule matches, not a simulation of a person’s effective access.</p>
          <div v-if="preview.rules.length" class="taxonomy-impact-table" tabindex="0" role="region" aria-label="Access rule impact"><table><thead><tr><th scope="col">Group &amp; rule</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr></thead><tbody><tr v-for="(rule, i) in preview.rules" :key="i"><td><strong><bdi>{{ rule.groupName }}</bdi></strong><small>{{ rule.deny ? 'Deny' : 'Allow' }} · #{{ rule.path }}</small><small>{{ rule.roles.join(', ') }} · {{ rule.locales.length ? rule.locales.join(', ') : 'All languages' }}</small></td><td>{{ rule.before }}</td><td>{{ rule.after }}</td><td>{{ rule.added || rule.removed ? `+${rule.added} / −${rule.removed}` : 'Unchanged' }}</td></tr></tbody></table></div>
          <v-checkbox v-if="preview.accessChanges" v-model="acknowledgeAccess" label="I understand that these tag-based access rules will match different pages." hide-details class="mt-4" :disabled="applying || reviewing || reviewStale" />
          <details v-if="preview.pages.length" class="taxonomy-review-pages"><summary>{{ preview.pages.length }} affected {{ preview.pages.length === 1 ? 'page' : 'pages' }}</summary><ul><li v-for="page in preview.pages" :key="page.id"><strong><bdi>{{ page.title || page.path }}</bdi></strong><span><bdi>{{ page.locale }} / {{ page.path }}</bdi> · {{ page.visibility }} · revision {{ page.sourceRevision }}</span></li></ul></details>
          <v-alert v-if="reviewError || reviewStale" :type="reviewStale ? 'warning' : 'error'" variant="tonal" class="mt-5"><span v-if="reviewStale">This impact review is stale. Refresh it and acknowledge any access change again.</span><span v-if="reviewError"> {{ reviewError }}</span><div><v-btn size="small" variant="text" class="mt-2" :disabled="applying || reviewing" :loading="reviewing" @click="review(preview.change)">Refresh impact review</v-btn></div></v-alert>
          <p class="taxonomy-muted mt-5">Page history and search/render updates are saved with assignment changes. If the reviewed data changes, you will be asked to review again.</p>
        </v-card-text>
        <v-card-actions><v-btn variant="text" :disabled="applying || reviewing" @click="cancelReview">Cancel</v-btn><v-spacer /><v-btn variant="flat" color="primary" :loading="applying" :disabled="applying || reviewing || reviewStale || (preview.accessChanges && !acknowledgeAccess)" @click="apply">Apply {{ preview.change.action === 'edit' ? 'changes' : preview.change.action === 'archive' ? 'retirement' : preview.change.action === 'restore' ? 'restoration' : 'merge' }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script lang="ts">
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
      section: 'definition',
      draft: emptyDefinition(),
      mergeTarget: null as number | null,
      actionError: '',
      success: '',
      warnings: [] as string[],
      createOpen: false,
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
        { title: 'Active tags', value: 'active' },
        { title: 'Unused active tags', value: 'unused' },
        { title: 'Aliases', value: 'alias' },
        { title: 'Archived names', value: 'archived' },
        { title: 'All names', value: 'all' }
      ],
      sections: [
        { title: 'Definition', value: 'definition' },
        { title: 'Usage & access', value: 'usage' },
        { title: 'Lifecycle', value: 'lifecycle' }
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
    filtered(): TaxonomyTag[] {
      const query = (this.search || '').trim().toLocaleLowerCase()
      return this.tags
        .filter(t => (this.view === 'all' || this.view === 'unused' ? this.view === 'all' || (this.state(t) === 'active' && !t.pageCount) : this.state(t) === this.view) && (!query || `${t.tag} ${t.title}`.toLocaleLowerCase().includes(query)))
        .sort((a, b) => a.tag.localeCompare(b.tag))
    },
    pageCount(): number { return Math.ceil(this.filtered.length / 12) },
    visible(): TaxonomyTag[] { return this.filtered.slice((this.pagination - 1) * 12, this.pagination * 12) },
    mergeTargets(): TaxonomyTag[] { return this.tags.filter(t => this.state(t) === 'active' && t.id !== this.selectedId).sort((a, b) => a.tag.localeCompare(b.tag)) },
    reviewTitle(): string { return this.preview?.change.action === 'merge' ? 'Bring two concepts together' : this.preview?.change.action === 'archive' ? 'Retire this name' : this.preview?.change.action === 'restore' ? 'Restore this name' : this.preview?.destination ? 'Rename this concept' : 'Update the display label' },
    reviewExplanation(): string {
      const change = this.preview?.change
      return change?.action === 'merge'
        ? 'Page assignments will move to the destination and duplicates will be consolidated. The source and its aliases will resolve to the destination; original labels remain in page history.'
        : change?.action === 'archive'
          ? 'The name will be archived and remain reserved. A canonical tag’s page assignments are removed and its aliases are archived. Historical page versions retain their original labels.'
          : change?.action === 'restore'
            ? 'The name will become available again. Restoring an alias reconnects the old name to its active destination. Former page assignments are not restored.'
            : this.preview?.destination
              ? 'The new name becomes canonical. The old name remains an alias for links, page editing and tag-based rules. Historical labels are preserved.'
              : 'Only the display label changes. Page assignments and tag names stay as they are.'
    }
  },
  watch: {
    selectedId(id: number) {
      this.section = 'definition'
      this.loadDetail(id)
    }
  },
  methods: {
    state: taxonomyState,
    definitionValid(value: { tag: string; title: string }): boolean {
      return Boolean(value.tag.trim()) && value.tag.trim().length <= 255 && value.title.trim().length <= 255 && !/[\u0000-\u001f\u007f]/.test(value.tag + value.title)
    },
    date(value: string): string {
      return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    },
    confirmDiscard(message: string): boolean {
      return !this.hasUnsavedChanges || window.confirm(message)
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
        if (!this.disposed) this.detailError = `The change was saved, but the selected tag could not be opened: ${getErrorMessage(error)}`
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
          this.detailError = 'The selected tag changed while it was loading. Try again.'
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
    openCreate() {
      if (this.busy || !this.confirmDiscard('Discard the unsaved tag changes and create a tag?')) return
      this.resetDraft()
      this.newTag = emptyDefinition()
      this.createError = ''
      this.createOpen = true
    },
    setCreateDialog(value: boolean) {
      if (value) {
        this.createOpen = true
        return
      }
      this.closeCreate()
    },
    closeCreate(): boolean {
      if (this.creating) return false
      if (!this.confirmDiscard('Discard the new tag draft?')) {
        this.createOpen = true
        return false
      }
      this.createOpen = false
      this.newTag = emptyDefinition()
      this.createError = ''
      return true
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
        this.createOpen = false
        this.success = 'Tag created. It is ready to assign to pages.'
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
          const message = 'The selected tag changed while the impact review was loading. Refresh the tag and review again.'
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
    setReviewDialog(value: boolean) {
      if (value) {
        this.reviewOpen = true
        return
      }
      if (this.applying || this.reviewing) {
        this.reviewOpen = true
        return
      }
      if (window.confirm('Discard this impact review?')) this.cancelReview()
      else this.reviewOpen = true
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
            if (!isStaleReviewError(error)) this.reviewError = `${this.reviewError} Refresh the impact review before trying another write.`
          }
          return
        }
        if (this.disposed) return
        this.reviewOpen = false
        this.preview = null
        this.reviewStale = false
        this.acknowledgeAccess = false
        this.resetDraft()
        this.success = 'Taxonomy updated. The change has been saved.'
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
  beforeRouteLeave() {
    if (this.applying || this.creating || this.reviewing) return false
    const discardReview = this.reviewOpen && window.confirm('Discard the unapplied taxonomy review?')
    if (this.reviewOpen && !discardReview) return false
    if (!this.confirmDiscard('Discard the unsaved tag changes?')) return false
    if (discardReview) this.cancelReview()
    return true
  },
  beforeRouteUpdate(to, from) {
    if (this.internalNavigation || queryValue(to.query.tag) === queryValue(from.query.tag)) return true
    if (this.applying || this.creating || this.reviewing) return false
    const discardReview = this.reviewOpen && window.confirm('Discard the unapplied taxonomy review?')
    if (this.reviewOpen && !discardReview) return false
    if (!this.confirmDiscard('Discard the unsaved tag changes?')) return false
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
  --taxonomy-border: var(--wiki-surface-border, rgba(var(--v-theme-on-surface), .14));
  --taxonomy-border-strong: var(--wiki-surface-border-strong, rgba(var(--v-theme-on-surface), .28));
  --taxonomy-muted: rgba(var(--v-theme-on-surface), .76);
  min-width: 0;
  color: rgb(var(--v-theme-on-surface));
}

.taxonomy-kicker {
  display: block;
  color: var(--taxonomy-muted);
  font-size: .75rem;
  font-weight: 750;
  letter-spacing: .13em;
  line-height: 1.3;
  text-transform: uppercase;
}

.taxonomy-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 32px;
  padding: 24px 0 32px;
  min-width: 0;

  h2 {
    margin: 8px 0;
    font-family: var(--wiki-font-display, var(--wiki-font-heading, sans-serif));
    font-size: clamp(1.5rem, 2.6vw, 2.1rem);
    font-weight: 600;
    letter-spacing: -.035em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  p {
    max-width: 680px;
    margin: 0;
    color: var(--taxonomy-muted);
    font-size: .9375rem;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(3, minmax(72px, 1fr));
    gap: 24px;
    margin: 0;
  }

  dt {
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.35;
  }

  dd {
    margin: 6px 0 0;
    font-size: 1.75rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    line-height: 1;
  }
}

.taxonomy-workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  align-items: start;
  gap: 24px;
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
  padding: 24px;
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
  border-radius: var(--wiki-radius-xs, 6px);
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
    background: rgba(var(--v-theme-on-surface), .04);
  }

  &.is-selected {
    border-color: rgba(var(--v-theme-primary), .35);
    background: rgba(var(--v-theme-primary), .1);
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
  padding: 56px 32px;
  text-align: center;

  h3 {
    margin: 8px 0;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -.025em;
    line-height: 1.25;
  }

  > p {
    max-width: 480px;
    margin: 0 auto;
    color: var(--taxonomy-muted);
    font-size: .9375rem;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
}

.taxonomy-welcome-mark {
  padding-bottom: 16px;
  color: rgb(var(--v-theme-primary));
  font-size: 3.5rem;
  font-weight: 250;
  line-height: 1;
}

.taxonomy-principles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px solid var(--taxonomy-border);
  text-align: start;

  strong {
    display: block;
    margin: 8px 0 4px;
    font-size: .875rem;
  }

  p {
    margin: 0;
    color: var(--taxonomy-muted);
    font-size: .8125rem;
    line-height: 1.65;
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

.taxonomy-identity-mark {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border: 1px solid var(--taxonomy-border);
  border-radius: var(--wiki-panel-radius, 12px);
  color: rgb(var(--v-theme-primary));
  font-size: 2.5rem;
  font-weight: 250;
}

.taxonomy-identity-main {
  min-width: 0;
  flex: 1;

  h2 {
    margin: 8px 0 4px;
    font-family: var(--wiki-font-heading, sans-serif);
    font-size: 1.75rem;
    font-weight: 650;
    letter-spacing: -.035em;
    line-height: 1.25;
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
    font-size: 1.5rem;
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
    white-space: nowrap;

    &[aria-selected='true'] {
      border-bottom-color: rgb(var(--v-theme-primary));
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
    font-size: 1.2rem;
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
  color: var(--taxonomy-muted, rgba(var(--v-theme-on-surface), .76));
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
  --taxonomy-border: var(--wiki-surface-border, rgba(var(--v-theme-on-surface), .14));
  --taxonomy-muted: rgba(var(--v-theme-on-surface), .76);
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
.taxonomy-view-selected:focus-visible {
  outline: 2px solid var(--wiki-focus-color, rgb(var(--v-theme-primary)));
  outline-offset: var(--wiki-focus-offset, 2px);
}

@media (forced-colors: active) {
  button:focus-visible,
  a:focus-visible,
  summary:focus-visible,
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
  .taxonomy-intro {
    grid-template-columns: 1fr;
    gap: 24px;
    padding-block: 16px 24px;

    dl {
      gap: 12px;
    }

    dd {
      font-size: 1.5rem;
    }
  }

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

  .taxonomy-identity-mark {
    width: 48px;
    height: 48px;
    border-radius: var(--wiki-radius-xs, 6px);
    font-size: 2rem;
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

  .taxonomy-principles {
    grid-template-columns: 1fr;
    gap: 16px;
    margin-top: 32px;
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

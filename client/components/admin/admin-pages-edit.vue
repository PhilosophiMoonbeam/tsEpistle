<template>
  <v-container fluid class="admin-page-detail">
    <template v-if="page">
      <admin-hero :title="page.title || 'Untitled page'" :description="`${page.locale} / ${page.path}`" icon="mdi-file-document-outline"><template #actions><v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">Pages</v-btn><v-btn variant="text" prepend-icon="mdi-refresh" :disabled="loading || publicationBusy || pageFeatureBusy" @click="refreshDetails">Refresh</v-btn><v-btn variant="outlined" :href="pageUrl">View page</v-btn><v-btn variant="flat" color="primary" prepend-icon="mdi-pencil-outline" :href="pageHref(page, '/e')">Edit content</v-btn></template></admin-hero>
      <div class="page-context-strip"><span>Page #{{ page.id }}</span><span>{{ publicationStatus }}</span><span>{{ page.visibility === 'private' ? `Private · owner #${page.ownerId}` : 'Workspace · page rules apply' }}</span><span><span v-if="page.editor">{{ page.editor }} / </span>{{ page.contentType }}</span></div>
      <v-tabs :model-value="section" color="primary" show-arrows aria-label="Page administration sections"><v-tab id="page-tab-overview" value="overview" aria-controls="page-panel-overview" @click="setSection('overview')">Overview</v-tab><v-tab v-if="publicationAvailable" id="page-tab-publication" value="publication" aria-controls="page-panel-publication" @click="setSection('publication')">Publication <span v-if="publicationDirty" class="ms-2" aria-label="unsaved changes">•</span></v-tab><v-tab id="page-tab-knowledge" value="knowledge" aria-controls="page-panel-knowledge" @click="setSection('knowledge')">Knowledge &amp; provenance</v-tab></v-tabs>
      <div class="page-detail-workspace">
        <section v-show="section === 'overview'" id="page-panel-overview" role="tabpanel" aria-labelledby="page-tab-overview" class="page-overview-grid">
          <div><span class="pages-kicker">Page identity</span><h2>Context at a glance.</h2><p class="page-description">{{ page.description || 'This page has no description. Add one in the editor to help readers and agents understand its purpose.' }}</p><dl class="page-detail-values"><div><dt>Language &amp; path</dt><dd>{{ page.locale }} / {{ page.path }}</dd></div><div><dt>Reader availability</dt><dd>{{ publicationStatus }}<small v-if="page.publishStartDate || page.publishEndDate">{{ formatDate(page.publishStartDate) }} → {{ formatDate(page.publishEndDate) }}</small></dd></div><div><dt>Visibility</dt><dd>{{ page.visibility === 'private' ? 'Private namespace' : 'Workspace namespace' }}<small>{{ page.visibility === 'private' ? `Owned by user #${page.ownerId}. Private ownership continues to apply even when published.` : 'Access depends on sign-in, group permissions and page rules.' }}</small></dd></div></dl><div class="page-secondary-links"><v-btn variant="outlined" :href="pageHref(page, '/h')" prepend-icon="mdi-history">Revision history</v-btn><v-btn variant="text" :href="pageHref(page, '/s')" prepend-icon="mdi-code-tags">View source</v-btn></div></div>
          <aside v-if="canViewStewardContacts" class="page-stewardship"><span class="pages-kicker">People &amp; stewardship</span><h3>Who shaped this page.</h3><div class="page-person"><span>Last edited by</span><router-link :to="`/users/${page.authorId}`">{{ page.authorName || `User #${page.authorId}` }}</router-link><small>{{ page.authorEmail }}</small><time>{{ formatDate(page.updatedAt) }}</time></div><div class="page-person"><span>Created by</span><router-link :to="`/users/${page.creatorId}`">{{ page.creatorName || `User #${page.creatorId}` }}</router-link><small>{{ page.creatorEmail }}</small><time>{{ formatDate(page.createdAt) }}</time></div><div class="page-access-actions"><v-btn variant="outlined" :disabled="loading || publicationBusy || publicationDirty || pageFeatureBusy || pageFeatureDirty" @click="manageAccess('visibility')">Change visibility</v-btn><v-btn v-if="managesSystem && page.visibility === 'private'" variant="text" :disabled="loading || publicationBusy || publicationDirty || pageFeatureBusy || pageFeatureDirty" @click="manageAccess('owner')">Transfer ownership</v-btn></div><p>Authorship records who edited the page. Private ownership determines whose personal namespace it belongs to.</p></aside>
          <section v-if="pageFeaturesDraft" class="page-feature-settings" aria-labelledby="page-feature-settings-title" :aria-busy="pageFeatureBusy">
            <div class="page-section-intro">
              <span class="pages-kicker">Reader features</span>
              <h3 id="page-feature-settings-title">Choose what readers can see.</h3>
              <p>These controls update reader-facing page features only; page content, visibility, and publication remain unchanged.</p>
            </div>
            <v-alert v-if="pageFeatureConflict" type="warning" variant="tonal" class="mb-4">Page features changed on the server while this draft was open. Reset to review the saved values before editing again.</v-alert>
            <v-alert v-else-if="pageFeatureError" type="error" variant="tonal" class="mb-4">{{ pageFeatureError }}</v-alert>
            <v-switch v-model="pageFeaturesDraft.linksVisible" color="primary" label="Show links" hint="Show the page’s link section to readers." persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <v-switch v-model="pageFeaturesDraft.ratingsAllowed" color="primary" label="Allow ratings" hint="OFF hides the ratings panel and blocks rating requests on this page. ON still requires site-wide availability." persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <v-switch v-model="pageFeaturesDraft.lastEditorVisible" color="primary" label="Show last editor" hint="Show who last edited this page to readers." persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <div class="page-feature-settings-actions">
              <span role="status">{{ pageFeatureConflict ? 'Saved settings changed; reset to review them.' : pageFeatureDirty ? 'Unsaved changes' : 'Matches the saved page' }}</span>
              <v-spacer />
              <v-btn type="button" variant="text" :disabled="loading || pageFeatureBusy || !pageFeatureDirty" @click="resetPageFeatures">Reset</v-btn>
              <v-btn type="button" variant="flat" color="primary" :loading="pageFeatureBusy" :disabled="pageFeatureSaveDisabled" @click="savePageFeatures">Save features</v-btn>
            </div>
          </section>
          <details class="page-technical"><summary>Technical identity &amp; page removal</summary><dl class="page-detail-values"><div><dt>Source revision</dt><dd>{{ page.sourceRevision }}</dd></div><div><dt>Content hash</dt><dd><code>{{ page.hash }}</code></dd></div><div><dt>Editor &amp; content type</dt><dd><span v-if="page.editor">{{ page.editor }} / </span>{{ page.contentType }}</dd></div></dl><div class="page-danger"><div><strong>Delete this page</strong><p>Removes this page and its associated history. Consider returning it to draft if it should remain available to editors.</p></div><v-btn variant="outlined" color="error" :disabled="loading || publicationDirty || publicationBusy || pageFeatureDirty || pageFeatureBusy" @click="deletePageDialog = true">Delete page</v-btn></div></details>
        </section>
        <section v-if="section === 'publication' && publicationAvailable" id="page-panel-publication" role="tabpanel" aria-labelledby="page-tab-publication"><admin-page-publication-settings :page="page" :now="now" @dirty="publicationDirty = $event" @busy="publicationBusy = $event" @saved="publicationSaved" /></section><section v-else-if="section === 'publication'" id="page-panel-publication-unavailable" role="tabpanel" aria-label="Publication controls unavailable"><div class="page-section-intro"><span class="pages-kicker">Publication &amp; scheduling</span><h2>Publication details are restricted.</h2><p>This page can be reviewed, but its publication controls are unavailable for your effective page access.</p></div></section>
        <section v-show="section === 'knowledge'" id="page-panel-knowledge" role="tabpanel" aria-labelledby="page-tab-knowledge" class="page-knowledge"><div class="page-section-intro"><span class="pages-kicker">Human knowledge / agent memory</span><h2>Understand the page’s evidence.</h2><p>Authoritative knowledge metadata travels with the page. The derived projection gives agents a structured view and may lag behind the latest revision.</p></div><div class="page-knowledge-grid"><section><h3>Authoritative metadata</h3><dl class="page-detail-values"><div><dt>Metadata state</dt><dd>{{ page.okf.authority.state }}</dd></div><div v-if="page.okf.authority.trust"><dt>Trust &amp; review</dt><dd>{{ page.okf.authority.trust.trustTier }} · {{ page.okf.authority.trust.verification }}<small>{{ page.okf.authority.trust.status }}{{ page.okf.authority.trust.stale ? ' · stale' : '' }}</small></dd></div><div v-if="page.okf.authority.metadata"><dt>Knowledge type</dt><dd>{{ page.okf.authority.metadata.type }}</dd></div></dl><p v-if="page.okf.authority.state !== 'valid'">{{ page.okf.authority.state === 'missing' ? 'No authoritative knowledge metadata is attached to this page.' : 'The stored metadata needs attention in the editor before it can be trusted.' }}</p><div v-if="page.okf.authority.metadata?.sources?.length" class="page-knowledge-sources"><h4>Recorded sources</h4><article v-for="(source, index) in page.okf.authority.metadata.sources" :key="index"><strong>{{ source.title || source.id || `Source ${index + 1}` }}</strong><code>{{ source.resource }}</code></article></div><v-btn variant="outlined" :href="pageHref(page, '/e')">Open editor</v-btn></section><section><h3>Agent projection</h3><dl class="page-detail-values"><div><dt>Projection state</dt><dd>{{ page.okf.projection.state }}</dd></div><div v-if="projection"><dt>Completeness</dt><dd>{{ projection.state }}<small v-if="projection.missingFields.length">Missing: {{ projection.missingFields.join(', ') }}</small></dd></div><div v-if="projection"><dt>Generated</dt><dd>{{ formatDate(projection.lifecycle.generatedAt) }}</dd></div></dl><p>{{ projection?.summary || 'No current derived summary is available.' }}</p><template v-if="projection"><h4 v-if="projection.openQuestions.length">Open questions</h4><ul v-if="projection.openQuestions.length"><li v-for="question in projection.openQuestions" :key="question">{{ question }}</li></ul><details class="page-projection-detail"><summary>Projection provenance &amp; structure</summary><pre tabindex="0" role="region" aria-label="Projection provenance data">{{ JSON.stringify(projection, null, 2) }}</pre></details></template></section></div></section>
      </div>
      <admin-page-access v-model="accessOpen" :page="page" :mode="accessMode" @busy="accessBusy = $event" @changed="accessChanged" />
      <v-dialog v-model="deletePageDialog" max-width="600" persistent aria-labelledby="delete-page-title"><v-card><v-card-title id="delete-page-title">Delete this page?</v-card-title><v-card-text><strong>{{ page.title || page.path }}</strong><p class="mt-3">This removes the page and its history. Deletion checks the revision you reviewed; a newer edit will stop this request.</p><v-alert v-if="mutationError" type="error" variant="tonal" class="mt-4">{{ mutationError }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="loading || pageFeatureBusy" @click="deletePageDialog = false">Keep page</v-btn><v-btn color="error" variant="flat" :loading="loading" :disabled="pageFeatureDirty || pageFeatureBusy" @click="deletePage">Delete page</v-btn></v-card-actions></v-card></v-dialog>
    </template>
    <async-state v-else-if="loading" state="loading" title="Loading page details" message="Fetching the current page and its knowledge metadata." />
    <async-state v-else-if="errorMessage" state="error" title="Page details could not be loaded" :message="errorMessage" retry-label="Try again" @retry="loadPage" />
  </v-container>
</template>
<script lang='ts'>
import { confirmDiscard, requestConfirmation } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import _ from 'lodash'
import AdminPagePublicationSettings from './admin-page-publication-settings.vue'
import AdminPageAccess from './admin-page-access.vue'
import { pageHref, publicationState } from '../../helpers/admin-pages'
import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'
import { updatePageFeatures } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'
import type { PageFeatures } from '../../../shared/page-features.ts'
const copyPageFeatures = (features: PageFeatures): PageFeatures => ({ ...features })
const samePageFeatures = (left: PageFeatures | null, right: PageFeatures | null): boolean =>
  left !== null && right !== null &&
  left.schemaVersion === right.schemaVersion &&
  left.linksVisible === right.linksVisible &&
  left.ratingsAllowed === right.ratingsAllowed &&
  left.lastEditorVisible === right.lastEditorVisible

export default {


  components: {
    AsyncState,
    AdminPagePublicationSettings, AdminPageAccess
  },
  data() {
    return {
      accessOpen: false,
      accessMode: 'visibility',
      accessBusy: false,
      section: 'overview',
      now: Date.now(),
      clock: null as ReturnType<typeof setInterval> | null,
      publicationDirty: false,
      publicationBusy: false,
      pageFeaturesDraft: null as PageFeatures | null,
      pageFeaturesBase: null as PageFeatures | null,
      pageFeatureDraftPageId: null as number | null,
      pageFeatureBusy: false,
      pageFeatureError: '',
      mutationError: '',
      deletePageDialog: false,
      page: null as PageDetails | null,
      resolvedPageRouteId: null as number | null,
      loadGeneration: 0,
      loading: false,
      errorMessage: ''
    }
  },
  computed: {
    managesSystem(): boolean { return wikiStore.user.permissions.includes('manage:system') },
    pageUrl(): string { return this.page ? pageHref(this.page) : '#' },
    publicationAvailable(): boolean {
      const page = this.page
      return page !== null && page.capabilities?.viewStewardContacts === true && page.isPublished !== undefined && page.publishStartDate !== undefined && page.publishEndDate !== undefined
    },
    canViewStewardContacts(): boolean {
      const page = this.page
      return (
        page !== null &&
        page.capabilities?.viewStewardContacts === true &&
        page.authorId !== undefined &&
        page.authorName !== undefined &&
        page.authorEmail !== undefined &&
        page.creatorId !== undefined &&
        page.creatorName !== undefined &&
        page.creatorEmail !== undefined
      )
    },
    publicationStatus(): string { return this.page ? publicationState(this.page, this.now) : '' },
    projection() { return this.page?.okf.projection.value ?? null },
    pageFeatureDirty(): boolean {
      const page = this.page
      return page !== null && this.pageFeatureDraftPageId === page.id && this.pageFeaturesDraft !== null && !samePageFeatures(this.pageFeaturesDraft, page.pageFeatures)
    },
    pageFeatureConflict(): boolean {
      const page = this.page
      return this.pageFeatureDirty && page !== null && this.pageFeatureDraftPageId === page.id && this.pageFeaturesBase !== null && !samePageFeatures(page.pageFeatures, this.pageFeaturesBase)
    },
    pageFeatureControlsDisabled(): boolean { return this.loading || this.pageFeatureBusy || this.pageFeatureConflict },
    pageFeatureSaveDisabled(): boolean {
      return this.pageFeatureControlsDisabled || !this.pageFeatureDirty || this.publicationBusy || this.publicationDirty
    },
  },
  methods: {
    pageHref,
    formatDate(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : 'No boundary' },
    resetPageFeatures() {
      const page = this.page
      if (!page) {
        this.pageFeaturesDraft = null
        this.pageFeaturesBase = null
        this.pageFeatureDraftPageId = null
        this.pageFeatureError = ''
        return
      }
      this.pageFeaturesDraft = copyPageFeatures(page.pageFeatures)
      this.pageFeaturesBase = copyPageFeatures(page.pageFeatures)
      this.pageFeatureDraftPageId = page.id
      this.pageFeatureError = ''
    },
    async savePageFeatures() {
      const page = this.page
      const pageFeatures = this.pageFeaturesDraft
      if (this.pageFeatureSaveDisabled || !page || !pageFeatures) return
      this.pageFeatureBusy = true
      this.pageFeatureError = ''
      try {
        await updatePageFeatures(
          window.fetch.bind(window),
          page.id,
          copyPageFeatures(pageFeatures),
          page.sourceRevision,
          this.$t('common:error.unexpected')
        )
        // The reviewed draft is now committed; the following GET establishes its new baseline.
        this.pageFeaturesBase = copyPageFeatures(pageFeatures)
        wikiStore.showNotification({ message: 'Page features saved.', style: 'success', icon: 'check' })
        await this.loadPage()
      } catch (error) {
        this.pageFeatureError = getErrorMessage(error) || 'Page features could not be saved.'
        wikiStore.showError(error)
      } finally {
        this.pageFeatureBusy = false
      }
    },
    setSection(section: string) { if (section === 'publication' && !this.publicationAvailable) return; this.section = section; this.$router.replace({ hash: '#' + section }) },
    protectUnload(event: BeforeUnloadEvent) { if (this.publicationDirty || this.publicationBusy || this.pageFeatureDirty || this.pageFeatureBusy || this.accessOpen || this.accessBusy) { event.preventDefault(); event.returnValue = '' } },
    manageAccess(mode: string) { this.accessMode = mode; this.accessOpen = true },
    async accessChanged() { wikiStore.showNotification({ message: 'Page access updated.', style: 'success', icon: 'check' }); await this.loadPage() },
    async canLeave(): Promise<boolean> {
      if (this.pageFeatureBusy || this.publicationBusy || this.accessBusy) return false
      if (this.accessOpen && !(await requestConfirmation({ title: 'Leave this access review?', confirmLabel: 'Leave review', cancelLabel: 'Stay' }))) return false
      if (this.publicationDirty && !(await confirmDiscard('Discard unsaved publication changes?'))) return false
      if (this.pageFeatureDirty && !(await confirmDiscard('Discard unsaved page feature changes?'))) return false
      return !this.pageFeatureBusy && !this.publicationBusy && !this.accessBusy
    },
    async refreshDetails() {
      if ((this.publicationDirty || this.pageFeatureDirty) && !(await confirmDiscard('Discard unsaved publication and page feature changes and reload this page?'))) return
      if (this.pageFeatureDirty) this.resetPageFeatures()
      await this.loadPage()
    },
    async publicationSaved() { this.publicationDirty = false; wikiStore.showNotification({ message: 'Publication settings saved.', style: 'success', icon: 'check' }); await this.loadPage() },
    async loadPage () {
      const requestGeneration = ++this.loadGeneration
      const routePageId = _.toSafeInteger(this.$route.params.id)
      this.deletePageDialog = false
      this.page = null
      this.resolvedPageRouteId = null
      this.loading = true
      this.errorMessage = ''; this.mutationError = ''; this.publicationDirty = false
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const page = await fetchPage(
          window.fetch.bind(window),
          routePageId,
          this.$t('common:error.unexpected')
        )
        if (requestGeneration !== this.loadGeneration) {
          return
        }
        this.resolvedPageRouteId = routePageId
        this.page = page
        const preserveFeatureDraft =
          this.pageFeatureDraftPageId === page.id &&
          this.pageFeaturesDraft !== null &&
          this.pageFeaturesBase !== null &&
          !samePageFeatures(this.pageFeaturesDraft, this.pageFeaturesBase)
        if (!preserveFeatureDraft) {
          this.pageFeaturesDraft = copyPageFeatures(page.pageFeatures)
          this.pageFeaturesBase = copyPageFeatures(page.pageFeatures)
          this.pageFeatureDraftPageId = page.id
          this.pageFeatureError = ''
        }
      } catch (err) {
        if (requestGeneration !== this.loadGeneration) {
          return
        }
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-pages-refresh')
        if (requestGeneration === this.loadGeneration) {
          this.loading = false
        }
      }
    },
    async deletePage() {
      if (this.loading || this.pageFeatureDirty || this.pageFeatureBusy) return
      const routePageId = _.toSafeInteger(this.$route.params.id)
      const requestGeneration = this.loadGeneration
      const page = this.page
      if (!page || this.resolvedPageRouteId !== routePageId) {
        return
      }

      this.loading = true; this.mutationError = ''
      wikiStore.startLoading('page-delete')
      try {
        await deletePageById(
          window.fetch.bind(window),
          page.id,
          page.sourceRevision,
          this.$t('common:error.unexpected')
        )
        if (
          requestGeneration !== this.loadGeneration ||
          routePageId !== _.toSafeInteger(this.$route.params.id)
        ) {
          return
        }
        this.deletePageDialog = false
        wikiStore.showNotification({
          style: 'green',
          message: `Page deleted successfully.`,
          icon: 'check'
        })
        this.$router.replace('/pages')
      } catch (err) {
        if (
          requestGeneration !== this.loadGeneration ||
          routePageId !== _.toSafeInteger(this.$route.params.id)
        ) {
          return
        }
        this.mutationError = getErrorMessage(err)
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('page-delete')
        if (
          requestGeneration === this.loadGeneration &&
          routePageId === _.toSafeInteger(this.$route.params.id)
        ) {
          this.loading = false
        }
      }
    }
  },
  watch: {
    '$route.hash'(hash: string) { const section = hash.slice(1); if (['overview', 'publication', 'knowledge'].includes(section)) this.section = section },
    '$route.params.id': {
      handler () {
        return this.loadPage()
      },
      immediate: true
    }
  },
  mounted() { const hash = this.$route.hash.slice(1); if (['overview', 'publication', 'knowledge'].includes(hash)) this.section = hash; window.addEventListener('beforeunload', this.protectUnload); this.clock = setInterval(() => { this.now = Date.now() }, 60000) },
  beforeRouteLeave() { return this.canLeave() },
  beforeRouteUpdate(to, from) { if (to.params.id === from.params.id) return true; return this.canLeave() },
  beforeUnmount () {
    window.removeEventListener('beforeunload', this.protectUnload)
    if (this.clock) clearInterval(this.clock)
    this.loadGeneration++
  }
}

</script>
<style scoped lang="scss">
.admin-page-detail { max-width:1600px; padding-bottom:4rem !important; }.page-context-strip { display:flex; flex-wrap:wrap; gap:.7rem 1.4rem; margin:1rem 0 2rem; padding:0 .5rem; font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-detail-workspace { background:rgb(var(--v-theme-surface)); border:1px solid rgba(var(--v-border-color),.18); border-radius:0 12px 12px; margin-top:.7rem; overflow:hidden; }.pages-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.13em; color:rgb(var(--v-theme-on-surface-variant)); }h2 { font:500 clamp(1.7rem,2.5vw,2.3rem)/1.15 var(--font-family-serif,Georgia,serif); margin:.7rem 0 1rem; }h3 { font:500 1.5rem/1.25 var(--font-family-serif,Georgia,serif); margin:.7rem 0 1.4rem; }p { line-height:1.7; color:rgb(var(--v-theme-on-surface-variant)); }.page-overview-grid { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:3rem; padding:2rem; }.page-detail-values { margin:1.3rem 0; }.page-detail-values>div { display:grid; grid-template-columns:minmax(7rem,28%) minmax(0,1fr); gap:1rem; padding:1rem 0; border-bottom:1px solid rgba(var(--v-border-color),.14); }.page-detail-values dt { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-detail-values dd { margin:0; font-size:.9rem; overflow-wrap:anywhere; }.page-detail-values small { display:block; line-height:1.7; margin-top:.4rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-secondary-links { display:flex; gap:.7rem; flex-wrap:wrap; }.page-stewardship { border-left:1px solid rgba(var(--v-border-color),.18); padding-left:2rem; }.page-access-actions { display:flex; flex-wrap:wrap; gap:.5rem; margin:1rem 0; }.page-person { display:flex; flex-direction:column; gap:.4rem; padding:1rem 0; border-top:1px solid rgba(var(--v-border-color),.14); overflow-wrap:anywhere; }.page-person>span,.page-person time,.page-person small { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-person a { font-weight:600; color:rgb(var(--v-theme-on-surface)); text-decoration:underline; }.page-stewardship>p { font-size:.8rem; margin-top:1rem; }.page-technical { grid-column:1/-1; border-top:1px solid rgba(var(--v-border-color),.18); padding-top:1.5rem; }.page-technical summary,.page-projection-detail summary { cursor:pointer; font-size:.9rem; }.page-danger { display:flex; justify-content:space-between; align-items:center; gap:2rem; padding:1rem 0; }.page-danger p { margin-top:.4rem; max-width:45rem; font-size:.85rem; }.page-knowledge { padding:2rem; }.page-section-intro { max-width:46rem; margin-bottom:2rem; }.page-knowledge-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:3rem; }.page-knowledge-grid p { margin-bottom:1rem; }.page-knowledge-sources article { padding:1rem 0; border-top:1px solid rgba(var(--v-border-color),.15); }.page-knowledge-sources code { display:block; overflow-wrap:anywhere; font-size:.8rem; margin-top:.5rem; }.page-knowledge ul { padding-left:1.5rem; margin:1rem 0; line-height:1.7; }.page-projection-detail { margin-top:1.5rem; }.page-projection-detail pre { overflow:auto; max-height:28rem; font-size:.75rem; margin-top:1rem; }summary:focus-visible,a:focus-visible { outline:2px solid rgb(var(--v-theme-primary)); outline-offset:4px; }@media(max-width:800px) { .page-overview-grid,.page-knowledge-grid { grid-template-columns:minmax(0,1fr); gap:2rem; }.page-stewardship { border-left:0; border-top:1px solid rgba(var(--v-border-color),.18); padding:1.5rem 0 0; }.page-knowledge,.page-overview-grid { padding:1.3rem; }.page-detail-values>div { grid-template-columns:1fr; gap:.4rem; }.page-danger { align-items:start; flex-direction:column; gap:1rem; } }
.page-feature-settings { grid-column:1/-1; border-top:1px solid rgba(var(--v-border-color),.18); padding-top:1.5rem; }.page-feature-settings-actions { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; margin-top:1rem; }
</style>

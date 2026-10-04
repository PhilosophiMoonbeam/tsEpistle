<template>
  <v-container fluid class="admin-page-detail">
    <template v-if="page">
      <admin-hero :title="page.title || $t('admin:pagesEdit.untitledPage')" :description="`${page.locale} / ${page.path}`" icon="mdi-file-document-outline"><template #actions><v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">{{ $t('admin:pagesEdit.pages') }}</v-btn><v-btn variant="text" prepend-icon="mdi-refresh" :disabled="loading || publicationBusy || pageFeatureBusy" @click="refreshDetails">{{ $t('common:actions.refresh') }}</v-btn><v-btn variant="outlined" :href="pageUrl">{{ $t('admin:pagesEdit.viewPage') }}</v-btn><v-btn variant="flat" color="primary" prepend-icon="mdi-pencil-outline" :href="pageHref(page, '/e')">{{ $t('admin:pagesEdit.editContent') }}</v-btn></template></admin-hero>
      <div class="page-context-strip"><span>{{ $t('admin:pagesEdit.page', { id: page.id, interpolation: { escapeValue: false } }) }}</span><span>{{ publicationStatus }}</span><span>{{ page.visibility === 'private' ? $t('admin:pagesEdit.privateOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pagesEdit.workspacePageRulesApply') }}</span><span><span v-if="page.editor">{{ page.editor }} / </span>{{ page.contentType }}</span></div>
      <v-tabs :model-value="section" color="primary" show-arrows :aria-label="$t('admin:pagesEdit.pageAdministrationSections')"><v-tab id="page-tab-overview" value="overview" aria-controls="page-panel-overview" @click="setSection('overview')">{{ $t('admin:pagesEdit.overview') }}</v-tab><v-tab v-if="publicationAvailable" id="page-tab-publication" value="publication" aria-controls="page-panel-publication" @click="setSection('publication')">{{ $t('admin:pagesEdit.publication') }} <span v-if="publicationDirty" class="ms-2" :aria-label="$t('admin:pagesEdit.unsavedChanges2')">•</span></v-tab><v-tab id="page-tab-knowledge" value="knowledge" aria-controls="page-panel-knowledge" @click="setSection('knowledge')">{{ $t('admin:pagesEdit.knowledgeProvenance') }}</v-tab></v-tabs>
      <div class="page-detail-workspace">
        <section v-show="section === 'overview'" id="page-panel-overview" role="tabpanel" aria-labelledby="page-tab-overview" class="page-overview-grid">
          <div><span class="pages-kicker">{{ $t('admin:pagesEdit.pageIdentity') }}</span><h2>{{ $t('admin:pagesEdit.contextGlance') }}</h2><p class="page-description">{{ page.description || $t('admin:pagesEdit.pageHasNoDescription') }}</p><dl class="page-detail-values"><div><dt>{{ $t('admin:pagesEdit.languagePath') }}</dt><dd>{{ page.locale }} / {{ page.path }}</dd></div><div><dt>{{ $t('admin:pagesEdit.readerAvailability') }}</dt><dd>{{ publicationStatus }}<small v-if="page.publishStartDate || page.publishEndDate">{{ formatDate(page.publishStartDate) }} → {{ formatDate(page.publishEndDate) }}</small></dd></div><div><dt>{{ $t('admin:pagesEdit.visibility') }}</dt><dd>{{ page.visibility === 'private' ? $t('admin:pagesEdit.privateNamespace') : $t('admin:pagesEdit.workspaceNamespace') }}<small>{{ page.visibility === 'private' ? $t('admin:pagesEdit.ownedUserPrivateOwnership', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pagesEdit.accessDependsSignGroup') }}</small></dd></div></dl><div class="page-secondary-links"><v-btn variant="outlined" :href="pageHref(page, '/h')" prepend-icon="mdi-history">{{ $t('admin:pagesEdit.revisionHistory') }}</v-btn><v-btn variant="text" :href="pageHref(page, '/s')" prepend-icon="mdi-code-tags">{{ $t('admin:pagesEdit.viewSource') }}</v-btn></div></div>
          <aside v-if="canViewStewardContacts" class="page-stewardship"><span class="pages-kicker">{{ $t('admin:pagesEdit.peopleStewardship') }}</span><h3>{{ $t('admin:pagesEdit.whoShapedPage') }}</h3><div class="page-person"><span>{{ $t('admin:pagesEdit.lastEdited') }}</span><router-link :to="`/users/${page.authorId}`">{{ page.authorName || $t('admin:pagesEdit.user', { authorId: page.authorId, interpolation: { escapeValue: false } }) }}</router-link><small>{{ page.authorEmail }}</small><time>{{ formatDate(page.updatedAt) }}</time></div><div class="page-person"><span>{{ $t('admin:pagesEdit.created') }}</span><router-link :to="`/users/${page.creatorId}`">{{ page.creatorName || $t('admin:pagesEdit.user2', { creatorId: page.creatorId, interpolation: { escapeValue: false } }) }}</router-link><small>{{ page.creatorEmail }}</small><time>{{ formatDate(page.createdAt) }}</time></div><div class="page-access-actions"><v-btn variant="outlined" :disabled="loading || publicationBusy || publicationDirty || pageFeatureBusy || pageFeatureDirty" @click="manageAccess('visibility')">{{ $t('admin:pagesEdit.changeVisibility') }}</v-btn><v-btn v-if="managesSystem && page.visibility === 'private'" variant="text" :disabled="loading || publicationBusy || publicationDirty || pageFeatureBusy || pageFeatureDirty" @click="manageAccess('owner')">{{ $t('admin:pagesEdit.transferOwnership') }}</v-btn></div><p>{{ $t('admin:pagesEdit.authorshipRecordsWhoEdited') }}</p></aside>
          <section v-if="pageFeaturesDraft" class="page-feature-settings" aria-labelledby="page-feature-settings-title" :aria-busy="pageFeatureBusy">
            <div class="page-section-intro">
              <span class="pages-kicker">{{ $t('admin:pagesEdit.readerFeatures') }}</span>
              <h3 id="page-feature-settings-title">{{ $t('admin:pagesEdit.chooseWhatReadersCan') }}</h3>
              <p>{{ $t('admin:pagesEdit.theseControlsUpdateReader') }}</p>
            </div>
            <v-alert v-if="pageFeatureConflict" type="warning" variant="tonal" class="mb-4">{{ $t('admin:pagesEdit.pageFeaturesChangedServer') }}</v-alert>
            <v-alert v-else-if="pageFeatureError" type="error" variant="tonal" class="mb-4">{{ pageFeatureError }}</v-alert>
            <v-switch v-model="pageFeaturesDraft.linksVisible" color="primary" :label="$t('admin:pagesEdit.showLinks')" :hint="$t('admin:pagesEdit.showPagesLinkSection')" persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <v-switch v-model="pageFeaturesDraft.ratingsAllowed" color="primary" :label="$t('admin:pagesEdit.allowRatings')" :hint="$t('admin:pagesEdit.offHidesRatingsPanel')" persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <v-switch v-model="pageFeaturesDraft.lastEditorVisible" color="primary" :label="$t('admin:pagesEdit.showLastEditor')" :hint="$t('admin:pagesEdit.showWhoLastEdited')" persistent-hint inset :disabled="pageFeatureControlsDisabled" />
            <div class="page-feature-settings-actions">
              <span role="status">{{ pageFeatureConflict ? $t('admin:pagesEdit.savedSettingsChangedReset') : pageFeatureDirty ? $t('admin:pagesEdit.unsavedChanges') : $t('admin:pagesEdit.matchesSavedPage') }}</span>
              <v-spacer />
              <v-btn type="button" variant="text" :disabled="loading || pageFeatureBusy || !pageFeatureDirty" @click="resetPageFeatures">{{ $t('admin:pagesEdit.reset') }}</v-btn>
              <v-btn type="button" variant="flat" color="primary" :loading="pageFeatureBusy" :disabled="pageFeatureSaveDisabled" @click="savePageFeatures">{{ $t('admin:pagesEdit.saveFeatures') }}</v-btn>
            </div>
          </section>
          <details class="page-technical"><summary>{{ $t('admin:pagesEdit.technicalIdentityPageRemoval') }}</summary><dl class="page-detail-values"><div><dt>{{ $t('admin:pagesEdit.sourceRevision') }}</dt><dd>{{ page.sourceRevision }}</dd></div><div><dt>{{ $t('admin:pagesEdit.contentHash') }}</dt><dd><code>{{ page.hash }}</code></dd></div><div><dt>{{ $t('admin:pagesEdit.editorContentType') }}</dt><dd><span v-if="page.editor">{{ page.editor }} / </span>{{ page.contentType }}</dd></div></dl><div class="page-danger"><div><strong>{{ $t('admin:pagesEdit.deletePage') }}</strong><p>{{ $t('admin:pagesEdit.removesPageAssociatedHistory') }}</p></div><v-btn variant="outlined" color="error" :disabled="loading || publicationDirty || publicationBusy || pageFeatureDirty || pageFeatureBusy" @click="deletePageDialog = true">{{ $t('admin:pagesEdit.deletePage2') }}</v-btn></div></details>
        </section>
        <section v-if="publicationAvailable" v-show="section === 'publication'" id="page-panel-publication" role="tabpanel" aria-labelledby="page-tab-publication"><admin-page-publication-settings :page="page" :now="now" @dirty="publicationDirty = $event" @busy="publicationBusy = $event" @saved="publicationSaved" /></section><section v-else v-show="section === 'publication'" id="page-panel-publication-unavailable" role="tabpanel" :aria-label="$t('admin:pagesEdit.publicationControlsUnavailable')"><div class="page-section-intro"><span class="pages-kicker">{{ $t('admin:pagesEdit.publicationScheduling') }}</span><h2>{{ $t('admin:pagesEdit.publicationDetailsRestricted') }}</h2><p>{{ $t('admin:pagesEdit.pageCanReviewedBut') }}</p></div></section>
        <section v-show="section === 'knowledge'" id="page-panel-knowledge" role="tabpanel" aria-labelledby="page-tab-knowledge" class="page-knowledge"><div class="page-section-intro"><span class="pages-kicker">{{ $t('admin:pagesEdit.humanKnowledgeAgentMemory') }}</span><h2>{{ $t('admin:pagesEdit.understandPagesEvidence') }}</h2><p>{{ $t('admin:pagesEdit.authoritativeKnowledgeMetadataTravels') }}</p></div><div class="page-knowledge-grid"><section><h3>{{ $t('admin:pagesEdit.authoritativeMetadata') }}</h3><dl class="page-detail-values"><div><dt>{{ $t('admin:pagesEdit.metadataState') }}</dt><dd>{{ page.okf.authority.state }}</dd></div><div v-if="page.okf.authority.trust"><dt>{{ $t('admin:pagesEdit.trustReview') }}</dt><dd>{{ page.okf.authority.trust.trustTier }} · {{ page.okf.authority.trust.verification }}<small>{{ page.okf.authority.trust.status }}{{ page.okf.authority.trust.stale ? ` ${$t('admin:pagesEdit.stale')}` : '' }}</small></dd></div><div v-if="page.okf.authority.metadata"><dt>{{ $t('admin:pagesEdit.knowledgeType') }}</dt><dd>{{ page.okf.authority.metadata.type }}</dd></div></dl><p v-if="page.okf.authority.state !== 'valid'">{{ page.okf.authority.state === 'missing' ? $t('admin:pagesEdit.noAuthoritativeKnowledgeMetadata') : $t('admin:pagesEdit.storedMetadataNeedsAttention') }}</p><div v-if="page.okf.authority.metadata?.sources?.length" class="page-knowledge-sources"><h4>{{ $t('admin:pagesEdit.recordedSources') }}</h4><article v-for="(source, index) in page.okf.authority.metadata.sources" :key="index"><strong>{{ source.title || source.id || $t('admin:pagesEdit.source', { value: index + 1, interpolation: { escapeValue: false } }) }}</strong><code>{{ source.resource }}</code></article></div><v-btn variant="outlined" :href="pageHref(page, '/e')">{{ $t('admin:pagesEdit.openEditor') }}</v-btn></section><section><h3>{{ $t('admin:pagesEdit.agentProjection') }}</h3><dl class="page-detail-values"><div><dt>{{ $t('admin:pagesEdit.projectionState') }}</dt><dd>{{ page.okf.projection.state }}</dd></div><div v-if="projection"><dt>{{ $t('admin:pagesEdit.completeness') }}</dt><dd>{{ projection.state }}<small v-if="projection.missingFields.length">{{ $t('admin:pagesEdit.missing', { missingFields: projection.missingFields.join(', '), interpolation: { escapeValue: false } }) }}</small></dd></div><div v-if="projection"><dt>{{ $t('admin:pagesEdit.generated') }}</dt><dd>{{ formatDate(projection.lifecycle.generatedAt) }}</dd></div></dl><p>{{ projection?.summary || $t('admin:pagesEdit.noCurrentDerivedSummary') }}</p><template v-if="projection"><h4 v-if="projection.openQuestions.length">{{ $t('admin:pagesEdit.openQuestions') }}</h4><ul v-if="projection.openQuestions.length"><li v-for="question in projection.openQuestions" :key="question">{{ question }}</li></ul><details class="page-projection-detail"><summary>{{ $t('admin:pagesEdit.projectionProvenanceStructure') }}</summary><pre tabindex="0" role="region" :aria-label="$t('admin:pagesEdit.projectionProvenanceData')">{{ JSON.stringify(projection, null, 2) }}</pre></details></template></section></div></section>
      </div>
      <admin-page-access v-model="accessOpen" :page="page" :mode="accessMode" @busy="accessBusy = $event" @changed="accessChanged" />
      <v-dialog v-model="deletePageDialog" max-width="600" persistent aria-labelledby="delete-page-title"><v-card><v-card-title id="delete-page-title">{{ $t('admin:pagesEdit.deletePage3') }}</v-card-title><v-card-text><strong>{{ page.title || page.path }}</strong><p class="mt-3">{{ $t('admin:pagesEdit.removesPageHistoryDeletion') }}</p><v-alert v-if="mutationError" type="error" variant="tonal" class="mt-4">{{ mutationError }}</v-alert></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="loading || pageFeatureBusy" @click="deletePageDialog = false">{{ $t('admin:pagesEdit.keepPage') }}</v-btn><v-btn color="error" variant="flat" :loading="loading" :disabled="pageFeatureDirty || pageFeatureBusy" @click="deletePage">{{ $t('admin:pagesEdit.deletePage2') }}</v-btn></v-card-actions></v-card></v-dialog>
    </template>
    <async-state v-else-if="loading" state="loading" :title="$t('admin:pagesEdit.loadingPageDetails')" :message="$t('admin:pagesEdit.fetchingCurrentPageKnowledge')" />
    <async-state v-else-if="errorMessage" state="error" :title="$t('admin:pagesEdit.pageDetailsCouldNot')" :message="errorMessage" :retry-label="$t('admin:pagesEdit.tryAgain')" @retry="loadPage" />
  </v-container>
</template>
<script lang='ts'>
import { confirmDiscard, requestConfirmation } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import * as _ from 'lodash-es'
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
    formatDate(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : this.$t('admin:pagesEdit.noBoundary') },
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
        wikiStore.showNotification({ message: this.$t('admin:pagesEdit.pageFeaturesSaved'), style: 'success', icon: 'check' })
        await this.loadPage()
      } catch (error) {
        this.pageFeatureError = getErrorMessage(error) || this.$t('admin:pagesEdit.pageFeaturesCouldNot')
        wikiStore.showError(error)
      } finally {
        this.pageFeatureBusy = false
      }
    },
    setSection(section: string) { if (section === 'publication' && !this.publicationAvailable) return; this.section = section; this.$router.replace({ hash: '#' + section }) },
    protectUnload(event: BeforeUnloadEvent) { if (this.publicationDirty || this.publicationBusy || this.pageFeatureDirty || this.pageFeatureBusy || this.accessOpen || this.accessBusy) { event.preventDefault(); event.returnValue = '' } },
    manageAccess(mode: string) { this.accessMode = mode; this.accessOpen = true },
    async accessChanged() { wikiStore.showNotification({ message: this.$t('admin:pagesEdit.pageAccessUpdated'), style: 'success', icon: 'check' }); await this.loadPage() },
    async canLeave(): Promise<boolean> {
      if (this.pageFeatureBusy || this.publicationBusy || this.accessBusy) return false
      if (this.accessOpen && !(await requestConfirmation({ title: this.$t('admin:pagesEdit.leaveAccessReview'), confirmLabel: this.$t('admin:pagesEdit.leaveReview'), cancelLabel: this.$t('admin:pagesEdit.stay') }))) return false
      if (this.publicationDirty && !(await confirmDiscard(this.$t('admin:pagesEdit.discardUnsavedPublicationChanges')))) return false
      if (this.pageFeatureDirty && !(await confirmDiscard(this.$t('admin:pagesEdit.discardUnsavedPageFeature')))) return false
      return !this.pageFeatureBusy && !this.publicationBusy && !this.accessBusy
    },
    async refreshDetails() {
      if ((this.publicationDirty || this.pageFeatureDirty) && !(await confirmDiscard(this.$t('admin:pagesEdit.discardUnsavedPublicationPage')))) return
      if (this.pageFeatureDirty) this.resetPageFeatures()
      await this.loadPage()
    },
    async publicationSaved() { this.publicationDirty = false; wikiStore.showNotification({ message: this.$t('admin:pagesEdit.publicationSettingsSaved'), style: 'success', icon: 'check' }); await this.loadPage() },
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
          message: this.$t('admin:pagesEdit.pageDeletedSuccessfully'),
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
.admin-page-detail { max-width: 1600px; min-width: 0; padding-bottom: 2rem !important; }
.page-context-strip { display: flex; flex-wrap: wrap; gap: .375rem 1rem; margin: .75rem 0 1rem; font-size: .8125rem; color: var(--wiki-text-muted); overflow-wrap: anywhere; }
.page-detail-workspace { margin-top: .5rem; overflow: hidden; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.pages-kicker { color: var(--wiki-text-muted); font-size: .75rem; font-weight: 600; }
h2, h3 { font-family: var(--wiki-font-heading); font-weight: 650; line-height: 1.35; margin: .375rem 0 .75rem; }
h2 { font-size: 1.125rem; } h3 { font-size: 1rem; }
p { color: var(--wiki-text-muted); line-height: 1.55; font-size: .875rem; }
.page-overview-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 1.5rem; padding: 1.25rem; }
.page-overview-grid > *, .page-knowledge-grid > * { min-width: 0; }
.page-detail-values { margin: .75rem 0; }
.page-detail-values > div { display: grid; grid-template-columns: minmax(7rem, 28%) minmax(0, 1fr); gap: .75rem; padding: .625rem 0; border-bottom: 1px solid var(--wiki-surface-border); }
.page-detail-values dt { color: var(--wiki-text-muted); font-size: .8125rem; }
.page-detail-values dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
.page-detail-values small { display: block; line-height: 1.5; margin-top: .25rem; color: var(--wiki-text-muted); }
.page-secondary-links, .page-access-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.page-stewardship { border-inline-start: 1px solid var(--wiki-surface-border); padding-inline-start: 1.25rem; }
.page-person { display: flex; flex-direction: column; gap: .25rem; padding: .75rem 0; border-top: 1px solid var(--wiki-surface-border); overflow-wrap: anywhere; }
.page-person > span, .page-person time, .page-person small, .page-stewardship > p { font-size: .8125rem; color: var(--wiki-text-muted); }
.page-person a { color: var(--wiki-accent-ink); font-weight: 600; text-decoration: underline; }
.page-stewardship > p { margin-top: .75rem; }
.page-technical, .page-feature-settings { grid-column: 1 / -1; padding-top: 1rem; border-top: 1px solid var(--wiki-surface-border); }
.page-technical summary, .page-projection-detail summary { display: list-item; min-height: 44px; padding-block: .625rem; cursor: pointer; font-size: .875rem; }
.page-danger { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .75rem 0; }
.page-danger p { margin-top: .25rem; max-width: 45rem; font-size: .8125rem; }
.page-knowledge { padding: 1.25rem; }
.page-section-intro { max-width: 50rem; margin-bottom: 1rem; }
.page-knowledge-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
.page-knowledge-grid p { margin-bottom: .75rem; }
.page-knowledge-sources article { padding: .75rem 0; border-top: 1px solid var(--wiki-surface-border); }
.page-knowledge-sources code { display: block; overflow-wrap: anywhere; font-family: var(--wiki-font-mono); font-size: .8125rem; margin-top: .25rem; }
.page-knowledge ul { padding-inline-start: 1.25rem; margin: .75rem 0; line-height: 1.6; }
.page-projection-detail { margin-top: 1rem; }
.page-projection-detail pre { overflow: auto; max-height: 28rem; margin-top: .75rem; font: .75rem/1.55 var(--wiki-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.page-feature-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; font-size: .8125rem; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 3px; }
@media (max-width: 800px) {
  .page-overview-grid, .page-knowledge-grid { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
  .page-stewardship { border-inline-start: 0; border-top: 1px solid var(--wiki-surface-border); padding: 1rem 0 0; }
  .page-knowledge, .page-overview-grid { padding: 1rem; }
  .page-detail-values > div { grid-template-columns: 1fr; gap: .25rem; }
  .page-danger { align-items: start; flex-direction: column; gap: .75rem; }
}
</style>

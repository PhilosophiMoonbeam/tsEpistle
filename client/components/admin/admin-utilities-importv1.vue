<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesImportv1.contentImport`) }}
  v-card-subtitle {{ $t(`admin:utilitiesImportv1.bringDocumentsAssetsInto`) }}
  v-card-text
    v-alert(color='warning' variant='tonal' icon='mdi-alert-outline')
      .text-body-medium {{ $t(`admin:utilitiesImportv1.importCanCreatePages`) }}
    h2.text-title-medium {{ $t(`admin:utilitiesImportv1.contentSource`) }}
    v-list.mb-4(density='compact' :aria-label='$t(`admin:utilitiesImportv1.importTargetAvailability`)')
      v-list-item(:prepend-icon='importTargets.git.available ? `mdi-check-circle-outline` : `mdi-close-circle-outline`' :title='importTargets.git.available ? $t(`admin:utilitiesImportv1.gitImportAvailable`) : $t(`admin:utilitiesImportv1.gitImportUnavailable`)' :subtitle='targetAvailability(importTargets.git)')
      v-list-item(:prepend-icon='importTargets.disk.available ? `mdi-check-circle-outline` : `mdi-close-circle-outline`' :title='importTargets.disk.available ? $t(`admin:utilitiesImportv1.localFolderImportAvailable`) : $t(`admin:utilitiesImportv1.localFolderImportUnavailable`)' :subtitle='targetAvailability(importTargets.disk)')
    p.text-body-medium.mt-2 {{ $t(`admin:utilitiesImportv1.contentImportSavesReviewed`) }}
    v-radio-group(:model-value='contentMode' @update:model-value='$event !== null && (contentMode = $event)' inline :label='$t(`admin:utilitiesImportv1.source`)' :disabled='busy')
      v-radio(value='git' :label='$t(`admin:utilitiesImportv1.gitRepository`)' :disabled='!importTargets.git.available')
      v-radio(value='disk' :label='$t(`admin:utilitiesImportv1.localFolder`)' :disabled='!importTargets.disk.available')
    v-alert.mb-4(v-if='!selectedTarget.available' color='warning' variant='tonal' density='compact') {{ selectedTargetMessage }}
    template(v-if='contentMode === `disk`')
      v-text-field(v-model='diskPath' :label='$t(`admin:utilitiesImportv1.contentFolderPath`)' variant='outlined' :disabled='busy || !importTargets.disk.available' :error-messages='diskError' @blur='touched.disk = true')
    template(v-else)
      v-row
        v-col(cols='12' md='8')
          v-text-field(v-model='git.repoUrl' :label='$t(`admin:utilitiesImportv1.repositoryUrl`)' variant='outlined' :disabled='busy || !importTargets.git.available' :error-messages='gitError' @blur='touched.repo = true')
        v-col(cols='12' md='4')
          v-text-field(v-model='git.branch' :label='$t(`admin:utilitiesImportv1.branch`)' variant='outlined' :disabled='busy || !importTargets.git.available' :error-messages='branchError' @blur='touched.branch = true')
        v-col(cols='12' md='4')
          v-select(v-model='git.authType' :items='authTypes' item-title='title' item-value='value' :label='$t(`admin:utilitiesImportv1.authentication`)' variant='outlined' :disabled='busy || !importTargets.git.available')
        v-col(cols='12' md='8')
          v-switch(:model-value='git.verifySSL' @update:model-value='$event !== null && (git.verifySSL = $event)' :label='$t(`admin:utilitiesImportv1.verifyHttpsCertificate`)' color='primary' hide-details :disabled='busy || !importTargets.git.available')
        v-col(v-if='git.authType === `ssh`' cols='12')
          v-textarea(v-model='git.privateKey' :label='$t(`admin:utilitiesImportv1.sshPrivateKeyContents`)' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available' :error-messages='privateKeyError' @blur='touched.key = true')
        template(v-else)
          v-col(cols='12' md='6')
            v-text-field(v-model='git.username' :label='$t(`admin:utilitiesImportv1.username`)' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available' :error-messages='passwordError' @blur='touched.password = true')
          v-col(cols='12' md='6')
            v-text-field(v-model='git.password' type='password' :label='$t(`admin:utilitiesImportv1.passwordAccessToken`)' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available' :error-messages='passwordError' @blur='touched.password = true')
        v-col(cols='12' md='6')
          v-text-field(v-model='git.defaultName' :label='$t(`admin:utilitiesImportv1.fallbackAuthorName`)' variant='outlined' :disabled='busy || !importTargets.git.available')
        v-col(cols='12' md='6')
          v-text-field(v-model='git.defaultEmail' :label='$t(`admin:utilitiesImportv1.fallbackAuthorEmail`)' variant='outlined' :disabled='busy || !importTargets.git.available')
        v-col(cols='12')
          v-text-field(v-model='git.localRepoPath' :label='$t(`admin:utilitiesImportv1.localWorkingCopyPath`)' variant='outlined' :disabled='busy || !importTargets.git.available' :error-messages='workingCopyError' @blur='touched.workingCopy = true')
      v-checkbox(:model-value='clearDotContentReview' label='Discard saved exact Git choices before this review (canonical records are never deleted by clearing choices)' :disabled='busy || previewLoading' hide-details @update:model-value='clearDotContentReview = $event === true')
    v-alert.mt-3(v-if='previewError' color='error' variant='tonal' role='alert') {{ previewError }}
    v-btn.mt-3(color='primary' variant='flat' :loading='previewLoading' :disabled='busy || previewLoading || !canImportContent' @click='inspectContent') Preview local source
    v-card.mt-4(v-if='preview' variant='outlined')
      v-card-title Review source identities
      v-card-text
        p.text-body-medium Preview only: no settings, pages or assets have been changed. Git preview reads the existing local working copy; it does not clone or fetch. A changed source or destination invalidates confirmation.
        p.text-body-small.mt-2 Target: {{ preview.scope.targetKey }} · Configuration binding: #[code {{ preview.scope.configurationRevision }}]
        p.text-body-small Snapshot: #[code {{ preview.snapshot }}]
        h3.text-title-small.mt-4 Complete bounded inventory ({{ preview.entries.length }} entries)
        v-table(density='compact')
          thead
            tr
              th(scope='col') Source
              th(scope='col') Kind
              th(scope='col') SHA-256
          tbody
            tr(v-for='entry in visibleEntries' :key='entry.sourcePath')
              td.text-break {{ entry.sourcePath }}
              td {{ entry.kind }}
              td.text-break {{ entry.sourceSha256 ?? '—' }}
        v-pagination(v-if='preview.entries.length > 25' v-model='inventoryPage' :length='Math.ceil(preview.entries.length / 25)' aria-label='Source inventory pages')
        template(v-if='preview.gitContent?.length')
          h3.text-title-small.mt-4 Git source ownership and dot-content review ({{ preview.gitContent.length }})
          p.text-body-small New dot-prefixed content is excluded, not deleted. Legacy native assets remain independent even when bytes match: retain never grants Git ownership. Only an explicitly reviewed native import/replacement of actual source bytes may establish ownership; a foreign source must first be reconciled through native asset administration. Choices are at most 2 MiB per batch. Unsafe/internal paths never become eligible.
          v-card.mt-3(v-for='entry in visibleGitContent' :key='entry.sourcePath' variant='tonal')
            v-card-text
              .text-body-medium.text-break {{ entry.sourcePath }} · {{ entry.kind }} · {{ entry.hidden ? 'excluded by default' : entry.previous ? 'previous Git source' : 'visible Git asset' }}
              .text-body-small.text-break SHA-256: {{ entry.sourceSha256 }} · Git revision: {{ entry.sourceRevision ?? 'current worktree' }} · {{ entry.sourceAvailable ? 'actual source bytes available' : 'actual old bytes unavailable; retain only' }}
              .text-body-small(v-if='entry.owner') Native {{ entry.owner.kind }} {{ entry.owner.id }} · {{ entry.owner.locale ? `${entry.owner.locale}/` : '' }}{{ entry.owner.path }} · revision {{ entry.owner.revision }} · native SHA-256 {{ entry.owner.sha256 }} · associated raw SHA-256 {{ entry.owner.sourceSha256 ?? entry.owner.sha256 }} · {{ entry.owner.sourceOwned ? 'native source association verified' : 'association/current raw revision requires review' }}
              .text-body-small(v-else) No native source owner. Exclusion cannot authorize deletion.
              v-alert.mt-2(v-for='diagnostic in entry.diagnostics' :key='diagnostic' color='warning' variant='tonal' density='compact') {{ diagnostic }}
              v-select.mt-3(v-model='dotActions[entry.sourcePath]' :items='dotChoiceOptions(entry)' item-title='title' item-value='value' label='Explicit decision for this exact Git source' variant='outlined' :disabled='busy || previewLoading' @update:model-value='mappingChanged')
              v-text-field(v-if='dotActions[entry.sourcePath] === `remap`' v-model='dotDestinations[entry.sourcePath]' :label='entry.kind === `page` ? `Visible native page path (same locale)` : `Visible native asset path including filename`' variant='outlined' :disabled='busy || previewLoading' @update:model-value='mappingChanged')
          v-pagination(v-if='preview.gitContent.length > 10' v-model='dotPage' :length='Math.ceil(preview.gitContent.length / 10)' aria-label='Git content conflict pages')
        h3.text-title-small.mt-4 Page destinations ({{ preview.pages.length }} pages)
        p.text-body-small Enter a valid native locale/path for unsupported source names. Previously unreviewed existing pages require an explicit association at the displayed revision. A retained source association is shown separately. No automatic rename or overwrite is performed.
        v-card.mt-3(v-for='page in visiblePages' :key='page.sourcePath' variant='tonal')
          v-card-text
            .text-body-medium.text-break {{ page.sourcePath }}
            .text-body-small.text-break SHA-256: {{ page.sourceSha256 }} · {{ page.format }}
            .text-body-small(v-if='page.existingPageId !== null') Current destination: {{ page.locale }}/{{ page.path }} · page {{ page.existingPageId }} · revision {{ page.expectedSourceRevision }} · {{ page.owned ? 'reviewed source ownership' : 'association required' }}
            v-alert.mt-2(v-for='diagnostic in page.diagnostics' :key='diagnostic' color='warning' variant='tonal' density='compact') {{ diagnostic }}
            v-row.mt-2
              v-col(cols='12' md='4')
                v-select(v-model='mappingFor(page.sourcePath).locale' :items='preview.locales' label='Native locale' variant='outlined' :disabled='busy || previewLoading || page.format === `okf_valid`' @update:model-value='mappingChanged')
              v-col(cols='12' md='8')
                v-text-field(v-model='mappingFor(page.sourcePath).path' label='Native destination path' variant='outlined' :disabled='busy || previewLoading || page.format === `okf_valid`' @update:model-value='mappingChanged')
              v-col(cols='12')
                v-select(:model-value='mappingFor(page.sourcePath).existingPageId' :items='destinationChoices' item-title='title' item-value='value' label='Explicitly IMPORT / REPLACE current native page state at this reviewed ID and revision' variant='outlined' :disabled='busy || previewLoading' @update:model-value='associateDestination(page.sourcePath, $event)')
            .text-body-small(v-if='mappingFor(page.sourcePath).existingPageId !== null') Confirmed page {{ mappingFor(page.sourcePath).existingPageId }} · revision {{ mappingFor(page.sourcePath).expectedSourceRevision }}
        v-pagination(v-if='preview.pages.length > 10' v-model='mappingPage' :length='Math.ceil(preview.pages.length / 10)' aria-label='Page mapping pages')
        v-btn.mt-4(color='warning' :disabled='busy || previewLoading' @click='openContentReview') {{ $t(`admin:utilitiesImportv1.reviewContentImport`) }}
        v-btn.mt-4.ml-2(variant='text' :disabled='busy || previewLoading' @click='cancelPreview') Cancel preview
  utility-review(
    v-model:open='review.open'
    :title='review.title'
    :effect='review.effect'
    :confirm-text='review.confirmation'
    :parameters='review.parameters'
    :submission-error='reviewError'
    :busy='busy'
    :uncertain-receipt='uncertainReceipt'
    @dirty-state='setReviewDirty'
    @confirm='submit'
  )
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  utilityOperationConfirmation,
  type UtilitiesWorkspace,
  type UtilityOperation,
  type UtilityOperationKind
} from '../../../shared/utilities-workspace.ts'
import UtilityReview from './admin-utilities-review.vue'
import type { Translate } from '../../helpers/use-translate.ts'
import { StorageImportPreviewSchema, StorageImportReviewSchema, type StorageImportPreview, type StorageImportMapping, type StorageImportReview, type StorageGitContentEntry, type StorageGitContentChoice } from '../../../shared/utility-content-import.ts'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'

type ImportKind = Extract<UtilityOperationKind, 'import-v1-content'>
type GitDraft = {
  repoUrl: string
  branch: string
  authType: 'ssh' | 'basic'
  privateKey: string
  username: string
  password: string
  defaultName: string
  defaultEmail: string
  localRepoPath: string
  verifySSL: boolean
}
type ImportPayload = Record<string, unknown>
type ReviewSnapshot = {
  kind: ImportKind
  title: string
  effect: string
  confirmation: string
  parameters: Array<{ label: string; value: string }>
  payload: ImportPayload
}

const repositoryIdentity = (t: Translate, value: string): string => {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
  } catch {
    return t('admin:utilitiesImportv1.repositoryAddressSuppliedCredentials')
  }
}

export default defineComponent({
  components: { UtilityReview },
  props: {
    workspace: { type: Object as PropType<UtilitiesWorkspace>, required: true },
    busy: { type: Boolean, default: false },
    uncertainReceipt: { type: Object as PropType<UtilityOperation | null>, default: null }
  },
  emits: ['request', 'draft-state'],
  data: (vm) => ({
    touched: { disk: false, repo: false, branch: false, workingCopy: false, key: false, password: false },
    contentMode: (vm.workspace.importTargets.git.available || !vm.workspace.importTargets.disk.available ? 'git' : 'disk') as 'git' | 'disk',
    initialContentMode: (vm.workspace.importTargets.git.available || !vm.workspace.importTargets.disk.available ? 'git' : 'disk') as 'git' | 'disk',
    clearDotContentReview: false,
    diskPath: '',
    git: {
      repoUrl: '',
      branch: 'master',
      authType: 'ssh' as 'ssh' | 'basic',
      privateKey: '',
      username: '',
      password: '',
      defaultName: '',
      defaultEmail: '',
      localRepoPath: './data/repo',
      verifySSL: true
    } as GitDraft,
    authTypes: [
      { title: vm.$t('admin:utilitiesImportv1.sshPrivateKey'), value: 'ssh' },
      { title: vm.$t('admin:utilitiesImportv1.httpBasicAccessToken'), value: 'basic' }
    ],
    review: {
      open: false,
      kind: 'import-v1-content' as ImportKind,
      title: '',
      effect: '',
      confirmation: '',
      parameters: [] as Array<{ label: string; value: string }>,
      payload: {} as ImportPayload
    },
    reviewError: '',
    preview: null as StorageImportPreview | null,
    previewPayload: null as ImportPayload | null,
    mappings: [] as StorageImportMapping[],
    dotActions: {} as Record<string, StorageGitContentChoice['action'] | ''>,
    dotDestinations: {} as Record<string, string>,
    dotPage: 1,
    inventoryPage: 1,
    mappingPage: 1,
    previewLoading: false,
    previewSequence: 0,
    previewError: '',
    reviewDirty: false
  }),
  computed: {
    mappingBySource(): Map<string, StorageImportMapping> {
      return new Map(this.mappings.map(mapping => [mapping.sourcePath, mapping]))
    },
    visibleEntries() {
      return this.preview?.entries.slice((this.inventoryPage - 1) * 25, this.inventoryPage * 25) ?? []
    },
    visiblePages() {
      return this.preview?.pages.slice((this.mappingPage - 1) * 10, this.mappingPage * 10) ?? []
    },
    visibleGitContent(): StorageGitContentEntry[] {
      return this.preview?.gitContent?.slice((this.dotPage - 1) * 10, this.dotPage * 10) ?? []
    },
    destinationChoices(): Array<{ title: string; value: number | null }> {
      return [{ title: 'Create a new destination (no existing-page association)', value: null },
        ...(this.preview?.destinations.map(page => ({ title: `${page.locale}/${page.path} · page ${page.id} · revision ${page.sourceRevision}`, value: page.id })) ?? [])]
    },
    importTargets() {
      return this.workspace.importTargets
    },
    selectedTarget() {
      return this.importTargets[this.contentMode]
    },
    selectedTargetMessage(): string {
      return (
        this.selectedTarget.reason ??
        this.$t('admin:utilitiesImportv1.importTargetUnavailableCurrent')
      )
    },
    diskError(): string {
      if (!this.touched.disk) return ''
      return this.contentMode !== 'disk' || this.diskPath.trim().length > 0 ? '' : this.$t('admin:utilitiesImportv1.enterContentFolderPath')
    },
    gitError(): string {
      if (!this.touched.repo) return ''
      return this.contentMode !== 'git' || this.git.repoUrl.trim().length > 0 ? '' : this.$t('admin:utilitiesImportv1.enterRepositoryUrl')
    },
    branchError(): string {
      if (!this.touched.branch) return ''
      return this.contentMode !== 'git' || this.git.branch.trim().length > 0 ? '' : this.$t('admin:utilitiesImportv1.enterBranch')
    },
    workingCopyError(): string {
      if (!this.touched.workingCopy) return ''
      return this.contentMode !== 'git' || this.git.localRepoPath.trim().length > 0 ? '' : this.$t('admin:utilitiesImportv1.enterLocalWorkingCopyPath')
    },
    privateKeyError(): string {
      if (!this.touched.key) return ''
      return this.contentMode !== 'git' || this.git.authType !== 'ssh' || this.git.privateKey.trim().length > 0 ? '' : this.$t('admin:utilitiesImportv1.enterSshPrivateKey')
    },
    passwordError(): string {
      if (!this.touched.password) return ''
      return this.contentMode !== 'git' || this.git.authType !== 'basic' || (this.git.username.trim().length > 0 && this.git.password.length > 0)
        ? ''
        : this.$t('admin:utilitiesImportv1.enterUsernamePasswordAccess')
    },
    canImportContent(): boolean {
      if (this.contentMode === 'disk') return this.importTargets.disk.available && this.diskPath.trim().length > 0
      return (
        this.importTargets.git.available &&
        Boolean(
          this.git.repoUrl.trim() &&
          this.git.branch.trim() &&
          this.git.localRepoPath.trim() &&
          (this.git.authType === 'ssh' ? this.git.privateKey.trim() : this.git.username.trim() && this.git.password)
        )
      )
    },
    formDirty(): boolean {
      const git = this.git
      return Boolean(
        this.clearDotContentReview ||
        this.contentMode !== this.initialContentMode ||
        this.diskPath ||
        git.repoUrl ||
        git.branch !== 'master' ||
        git.authType !== 'ssh' ||
        git.privateKey ||
        git.username ||
        git.password ||
        git.defaultName ||
        git.defaultEmail ||
        git.localRepoPath !== './data/repo' ||
        !git.verifySSL
      )
    }
  },
  watch: {
    clearDotContentReview() {
      this.cancelPreview()
      this.publishDraftState()
    },
    contentMode() {
      this.cancelPreview()
      this.publishDraftState()
    },
    diskPath() {
      this.cancelPreview()
      this.publishDraftState()
    },
    git: {
      deep: true,
      handler() {
        this.cancelPreview()
        this.publishDraftState()
      }
    }
  },
  beforeUnmount() {
    this.previewSequence += 1
  },
  methods: {
    async fetchPreview(payload: ImportPayload): Promise<StorageImportPreview> {
      const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/utilities/content-import/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const value: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 413 && payload.mode === 'git') throw new Error('The transport rejected this review size. Review fewer exact Git choices per batch. No settings or content have changed.')
        throw new Error(value && typeof value === 'object' && typeof Reflect.get(value, 'error') === 'string'
          ? String(Reflect.get(value, 'error')) : 'The local import source could not be previewed. No settings or content have been changed.')
      }
      return StorageImportPreviewSchema.parse(value)
    },
    async inspectContent() {
      if (!this.canImportContent || this.busy || this.previewLoading) return
      const sequence = ++this.previewSequence
      const payload = Object.freeze(this.contentPayload()) as ImportPayload
      this.previewLoading = true
      this.previewError = ''
      this.preview = null
      this.review.open = false
      try {
        const preview = await this.fetchPreview(payload)
        if (sequence !== this.previewSequence) return
        this.preview = preview
        this.previewPayload = payload
        this.mappings = preview.pages.map(page => ({
          sourcePath: page.sourcePath, sourceSha256: page.sourceSha256,
          locale: page.locale, path: page.path,
          existingPageId: page.owned ? page.existingPageId : null,
          expectedSourceRevision: page.owned ? page.expectedSourceRevision : null
        }))
        this.dotActions = Object.fromEntries((preview.gitContent ?? []).map(entry => [entry.sourcePath, '']))
        this.dotDestinations = {}
        this.dotPage = 1
        this.inventoryPage = 1
        this.mappingPage = 1
      } catch (error) {
        if (sequence === this.previewSequence) this.previewError = error instanceof Error ? error.message : 'The import preview is unavailable.'
      } finally {
        if (sequence === this.previewSequence) this.previewLoading = false
      }
    },
    mappingFor(sourcePath: string): StorageImportMapping {
      const mapping = this.mappingBySource.get(sourcePath)
      if (!mapping) throw new Error('This source is no longer in the reviewed inventory. Preview again.')
      return mapping
    },
    dotChoiceOptions(entry: StorageGitContentEntry) {
      return [
        { title: entry.automatic && (entry.owner === null && !entry.previous || entry.owner?.sourceOwned && entry.owner.path === entry.sourcePath)
          ? 'Use ordinary Git admission with exact native source ownership'
          : entry.owner ? 'Leave unresolved — preserve canonical record and report conflict' : 'Exclude this new source — no content change', value: '' },
        ...(entry.owner || entry.previous ? [{ title: entry.owner
          ? entry.owner.sourceOwned ? 'Retain the verified source association and current canonical bytes' : 'Retain current canonical bytes without creating or refreshing Git ownership'
          : 'Acknowledge absent owner; retain the pinned source receipt without deleting anything', value: 'retain' }] : []),
        ...(!entry.previous && entry.sourceAvailable && (entry.hidden || entry.kind === 'asset' && entry.owner !== null) &&
          (entry.owner === null || entry.kind === 'page' || entry.owner.path === entry.sourcePath)
          ? [{ title: entry.hidden ? 'INCLUDE this exact supported dot source through a native import/replacement'
            : 'IMPORT / REPLACE this exact native asset with the reviewed Git bytes (foreign ownership must first be reconciled)', value: 'include' }] : []),
        ...(entry.owner?.sourceOwned && (entry.owner.sourceSha256 ?? entry.owner.sha256) === entry.sourceSha256 ? [
          { title: 'Remap this exact source-owned canonical record to a visible destination', value: 'remap' },
          { title: 'Deliberately remove this exact source-owned canonical record', value: 'remove' }
        ] : [])
      ]
    },
    mappingChanged() {
      this.review.open = false
      this.publishDraftState()
    },
    associateDestination(sourcePath: string, id: number | null) {
      const mapping = this.mappingFor(sourcePath)
      const destination = this.preview?.destinations.find(page => page.id === id)
      mapping.existingPageId = destination?.id ?? null
      mapping.expectedSourceRevision = destination?.sourceRevision ?? null
      if (destination) {
        mapping.locale = destination.locale
        mapping.path = destination.path
      }
      this.mappingChanged()
    },
    cancelPreview() {
      this.previewSequence += 1
      this.previewLoading = false
      this.preview = null
      this.previewPayload = null
      this.mappings = []
      this.dotActions = {}
      this.dotDestinations = {}
      this.previewError = ''
      this.review.open = false
    },
    targetAvailability(target: { available: boolean; reason: string | null }): string {
      return target.available ? this.$t('admin:utilitiesImportv1.readyReviewedImport') : (target.reason ?? this.$t('admin:utilitiesImportv1.unavailableCurrentDeployment'))
    },
    contentPayload(): ImportPayload {
      return this.contentMode === 'disk'
        ? { mode: 'disk', path: this.diskPath.trim() }
        : {
            mode: 'git',
            repoUrl: this.git.repoUrl.trim(),
            branch: this.git.branch.trim(),
            authType: this.git.authType,
            ...(this.git.authType === 'ssh'
              ? { privateKey: this.git.privateKey }
              : { username: this.git.username.trim(), password: this.git.password }),
            ...(this.git.defaultName.trim() ? { defaultName: this.git.defaultName.trim() } : {}),
            ...(this.git.defaultEmail.trim() ? { defaultEmail: this.git.defaultEmail.trim() } : {}),
            localRepoPath: this.git.localRepoPath.trim(),
            verifySSL: this.git.verifySSL,
            ...(this.clearDotContentReview ? { clearDotContentReview: true } : {})
          }
    },
    async openContentReview() {
      if (!this.canImportContent || this.busy || this.previewLoading || !this.preview || !this.previewPayload) return
      const gitBySource = new Map(this.preview.gitContent?.map(entry => [entry.sourcePath, entry]))
      const pageBySource = new Map(this.preview.pages.map(page => [page.sourcePath, page]))
      const identityReview: StorageImportReview = {
        scope: { ...this.preview.scope }, snapshot: this.preview.snapshot,
        mappings: this.mappings.filter(mapping => {
          const entry = gitBySource.get(mapping.sourcePath)
          if (entry?.hidden && this.dotActions[entry.sourcePath] !== 'include') return false
          if (this.contentMode === 'disk') return true
          const page = pageBySource.get(mapping.sourcePath)
          return page !== undefined && (mapping.locale !== page.locale || mapping.path !== page.path ||
            mapping.existingPageId !== (page.owned ? page.existingPageId : null) ||
            mapping.expectedSourceRevision !== (page.owned ? page.expectedSourceRevision : null))
        }).map(mapping => ({ ...mapping })),
        ...(this.contentMode === 'git' ? { gitContent: (this.preview.gitContent ?? []).flatMap(entry => {
          const action = this.dotActions[entry.sourcePath]
          return action ? [{
            sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, sourceRevision: entry.sourceRevision ?? null, sourceAvailable: entry.sourceAvailable,
            owner: entry.owner === null ? null : { ...entry.owner }, action,
            ...(action === 'remap' ? { destinationPath: this.dotDestinations[entry.sourcePath] ?? '' } : {})
          }] : []
        }) } : {})
      }
      const parsedReview = StorageImportReviewSchema.safeParse(identityReview)
      if (!parsedReview.success) {
        this.previewError = parsedReview.error.issues[0]?.message ?? 'Review fewer exact source choices in this batch.'
        return
      }
      const payload = Object.freeze({ ...this.previewPayload, review: identityReview }) as ImportPayload
      const sequence = ++this.previewSequence
      this.previewLoading = true
      this.previewError = ''
      try {
        await this.fetchPreview(payload)
        if (sequence !== this.previewSequence) return
      } catch (error) {
        if (sequence === this.previewSequence) this.previewError = error instanceof Error ? error.message : 'The identity review is stale or invalid. Preview again.'
        return
      } finally {
        if (sequence === this.previewSequence) this.previewLoading = false
      }
      const parameters =
        this.contentMode === 'disk'
          ? [
              { label: this.$t('admin:utilitiesImportv1.contentSource'), value: this.$t('admin:utilitiesImportv1.localFolder') },
              { label: this.$t('admin:utilitiesImportv1.contentFolder'), value: this.diskPath.trim() }
            ]
          : [
              { label: this.$t('admin:utilitiesImportv1.contentSource'), value: this.$t('admin:utilitiesImportv1.gitRepository') },
              { label: this.$t('admin:utilitiesImportv1.repository'), value: repositoryIdentity(this.$t, this.git.repoUrl.trim()) },
              { label: this.$t('admin:utilitiesImportv1.branch'), value: this.git.branch.trim() },
              {
                label: this.$t('admin:utilitiesImportv1.authentication'),
                value: this.git.authType === 'ssh' ? this.$t('admin:utilitiesImportv1.sshPrivateKeySupplied') : this.$t('admin:utilitiesImportv1.httpBasicAccessToken2')
              },
              { label: this.$t('admin:utilitiesImportv1.httpsCertificateVerification'), value: this.git.verifySSL ? this.$t('admin:utilitiesImportv1.enabled') : this.$t('admin:utilitiesImportv1.disabled') },
              {
                label: this.$t('admin:utilitiesImportv1.fallbackAuthor'),
                value:
                  this.git.defaultName || this.git.defaultEmail
                    ? `${this.git.defaultName || this.$t('admin:utilitiesImportv1.defaultName')} · ${this.git.defaultEmail || this.$t('admin:utilitiesImportv1.defaultEmail')}`
                    : this.$t('admin:utilitiesImportv1.useTargetsConfiguredDefault')
              },
              { label: this.$t('admin:utilitiesImportv1.localWorkingCopy'), value: this.git.localRepoPath.trim() }
            ]
      this.review = {
        open: true,
        kind: 'import-v1-content',
        title: this.$t('admin:utilitiesImportv1.reviewContentImport'),
        effect:
          this.$t('admin:utilitiesImportv1.savesSelectedStorageTarget'),
        confirmation: utilityOperationConfirmation('import-v1-content'),
        parameters: [...parameters,
          { label: 'Reviewed snapshot', value: identityReview.snapshot },
          ...(this.contentMode === 'git' ? [{ label: 'Saved Git choices', value: `${identityReview.gitContent?.length ?? 0} exact selections${this.clearDotContentReview ? '; discard previous saved choices' : ''}. Native source associations and unselected canonical records are retained.` }] : []),
          ...(identityReview.gitContent ?? []).map(choice => ({
            label: `Git decision: ${choice.sourcePath}`,
            value: `${choice.action}${choice.destinationPath ? ` → ${choice.destinationPath}` : ''} · ${choice.owner ? `native ${choice.owner.kind} ${choice.owner.id} at revision ${choice.owner.revision}` : 'no existing native owner'} · SHA-256 ${choice.sourceSha256}`
          })),
          ...identityReview.mappings.map(mapping => ({
            label: mapping.sourcePath,
            value: `${mapping.locale}/${mapping.path} · ${mapping.existingPageId === null ? 'new destination' : `associate page ${mapping.existingPageId} at revision ${mapping.expectedSourceRevision}`} · SHA-256 ${mapping.sourceSha256}`
          }))
        ],
        payload
      }
      this.reviewError = ''
    },
    setReviewDirty(dirty: boolean) {
      this.reviewDirty = dirty
      this.publishDraftState()
    },
    publishDraftState() {
      this.$emit('draft-state', this.formDirty || this.reviewDirty)
    },
    submit({ reason, acknowledgedUncertainId }: { reason: string; acknowledgedUncertainId?: string }) {
      const snapshot = this.review
      if (!snapshot.open || this.busy) return
      const mode = snapshot.payload.mode
      if ((mode !== 'git' && mode !== 'disk') || !this.importTargets[mode].available) {
        this.reviewError = (mode === 'git' || mode === 'disk' ? this.importTargets[mode].reason : null) ?? this.$t('admin:utilitiesImportv1.importTargetUnavailableCurrent')
        return
      }
      this.$emit('request', {
        kind: snapshot.kind,
        reason,
        acknowledgedUncertainId,
        payload: snapshot.payload,
        onRecorded: () => {
          this.git.privateKey = ''
          this.git.password = ''
          this.review.open = false
          this.reviewError = ''
          this.setReviewDirty(false)
        },
        onRejected: (message: string) => {
          this.reviewError = message
        }
      })
    }
  }
})
</script>

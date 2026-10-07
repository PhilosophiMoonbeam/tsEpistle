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
    v-radio-group(v-model='contentMode' inline :label='$t(`admin:utilitiesImportv1.source`)' :disabled='busy')
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
          v-switch(v-model='git.verifySSL' :label='$t(`admin:utilitiesImportv1.verifyHttpsCertificate`)' color='primary' hide-details :disabled='busy || !importTargets.git.available')
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
    v-btn.mt-3(color='warning' variant='flat' :disabled='busy || !canImportContent' @click='openContentReview') {{ $t(`admin:utilitiesImportv1.reviewContentImport`) }}
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
    reviewDirty: false
  }),
  computed: {
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
    contentMode() {
      this.publishDraftState()
    },
    diskPath() {
      this.publishDraftState()
    },
    git: {
      deep: true,
      handler() {
        this.publishDraftState()
      }
    }
  },
  methods: {
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
            privateKey: this.git.privateKey,
            username: this.git.username,
            password: this.git.password,
            defaultName: this.git.defaultName,
            defaultEmail: this.git.defaultEmail,
            localRepoPath: this.git.localRepoPath.trim(),
            verifySSL: this.git.verifySSL
          }
    },
    openContentReview() {
      if (!this.canImportContent || this.busy) return
      const payload = Object.freeze(this.contentPayload()) as ImportPayload
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
        parameters,
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

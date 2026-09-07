<template lang="pug">
v-card
  v-card-title Import from Wiki.js 1.x
  v-card-subtitle Import users and content as separate reviewed operations. A partial or interrupted import is never replayed automatically.
  v-card-text
    v-alert(color='warning' variant='tonal' icon='mdi-alert-outline')
      .text-body-medium Import can create users, groups, pages and assets. Take a verified backup and complete each source once before starting another operation.
    v-tabs(v-model='section' color='primary' :disabled='busy')
      v-tab(value='users') Users
      v-tab(value='content') Content and uploads
    v-window(v-model='section').mt-5
      v-window-item(value='users')
        h2.text-title-medium User source
        p.text-body-medium.mt-2 The connection string is sent only for the requested import. It is not written to the Utilities receipt or review summary.
        p.text-body-medium.mt-2 This importer uses the current MongoDB driver, not the original Wiki.js 1.x driver. Restore older source databases into a compatible MongoDB server before importing. This operation does not upgrade or modify the source database.
        v-text-field(v-model='mongoDbConnString' type='password' label='Wiki.js 1.x MongoDB connection string' variant='outlined' autocomplete='off' :disabled='busy' :error-messages='mongoError')
        v-radio-group.utility-import-group-strategy(v-model='groupMode' label='Imported user group strategy' :disabled='busy')
          v-radio(value='MULTI' label='Create groups for each unique legacy permission set')
          v-radio(value='SINGLE' label='Create one shared imported-user group')
          v-radio(value='NONE' label='Create no groups')
        v-btn.mt-3(color='warning' variant='flat' :disabled='busy || !canImportUsers' @click='openUsersReview') Review user import
      v-window-item(value='content')
        h2.text-title-medium Content source
        v-list.mb-4(density='compact' aria-label='Import target availability')
          v-list-item(:prepend-icon='importTargets.git.available ? `mdi-check-circle-outline` : `mdi-close-circle-outline`' :title='importTargets.git.available ? `Git import available` : `Git import unavailable`' :subtitle='targetAvailability(importTargets.git)')
          v-list-item(:prepend-icon='importTargets.disk.available ? `mdi-check-circle-outline` : `mdi-close-circle-outline`' :title='importTargets.disk.available ? `Local-folder import available` : `Local-folder import unavailable`' :subtitle='targetAvailability(importTargets.disk)')
        p.text-body-medium.mt-2 Content import saves the reviewed disk or Git storage configuration, activates it, then imports its documents and assets. Git credentials are secret fields and never enter receipts or review details.
        v-radio-group(v-model='contentMode' inline label='Source' :disabled='busy')
          v-radio(value='git' label='Git repository' :disabled='!importTargets.git.available')
          v-radio(value='disk' label='Local folder' :disabled='!importTargets.disk.available')
        v-alert.mb-4(v-if='!selectedTarget.available' color='warning' variant='tonal' density='compact') {{ selectedTargetMessage }}
        template(v-if='contentMode === `disk`')
          v-text-field(v-model='diskPath' label='Content folder path' variant='outlined' :disabled='busy || !importTargets.disk.available' :error-messages='diskError')
        template(v-else)
          v-row
            v-col(cols='12' md='8')
              v-text-field(v-model='git.repoUrl' label='Repository URL' variant='outlined' :disabled='busy || !importTargets.git.available' :error-messages='gitError')
            v-col(cols='12' md='4')
              v-text-field(v-model='git.branch' label='Branch' variant='outlined' :disabled='busy || !importTargets.git.available')
            v-col(cols='12' md='4')
              v-select(v-model='git.authType' :items='authTypes' item-title='title' item-value='value' label='Authentication' variant='outlined' :disabled='busy || !importTargets.git.available')
            v-col(cols='12' md='8')
              v-switch(v-model='git.verifySSL' label='Verify HTTPS certificate' color='primary' hide-details :disabled='busy || !importTargets.git.available')
            v-col(v-if='git.authType === `ssh`' cols='12')
              v-textarea(v-model='git.privateKey' label='SSH private key contents' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available' :error-messages='privateKeyError')
            template(v-else)
              v-col(cols='12' md='6')
                v-text-field(v-model='git.username' label='Username' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available')
              v-col(cols='12' md='6')
                v-text-field(v-model='git.password' type='password' label='Password or access token' variant='outlined' autocomplete='off' :disabled='busy || !importTargets.git.available' :error-messages='passwordError')
            v-col(cols='12' md='6')
              v-text-field(v-model='git.defaultName' label='Fallback author name' variant='outlined' :disabled='busy || !importTargets.git.available')
            v-col(cols='12' md='6')
              v-text-field(v-model='git.defaultEmail' label='Fallback author email' variant='outlined' :disabled='busy || !importTargets.git.available')
            v-col(cols='12')
              v-text-field(v-model='git.localRepoPath' label='Local working-copy path' variant='outlined' :disabled='busy || !importTargets.git.available')
        v-btn.mt-3(color='warning' variant='flat' :disabled='busy || !canImportContent' @click='openContentReview') Review content import
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

type ImportKind = Extract<UtilityOperationKind, 'import-v1-users' | 'import-v1-content'>
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

const mongoUri = (value: string): URL | null => {
  if (value.length > 4096 || /\s/.test(value)) return null
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:') && Boolean(parsed.host) && !parsed.hash ? parsed : null
  } catch {
    return null
  }
}
const mongoSourceIdentity = (value: string): string => {
  const parsed = mongoUri(value)
  return parsed ? `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}` : 'MongoDB source (credentials hidden)'
}
const repositoryIdentity = (value: string): string => {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
  } catch {
    return 'Repository address supplied (credentials hidden)'
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
  data: () => ({
    section: 'users',
    mongoDbConnString: '',
    groupMode: 'MULTI',
    contentMode: 'git' as 'git' | 'disk',
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
      { title: 'SSH private key', value: 'ssh' },
      { title: 'HTTP basic or access token', value: 'basic' }
    ],
    review: {
      open: false,
      kind: 'import-v1-users' as ImportKind,
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
        'This import target is unavailable in the current deployment. Choose an available source before reviewing the import.'
      )
    },
    mongoError(): string {
      return !this.mongoDbConnString ? '' : mongoUri(this.mongoDbConnString) ? '' : 'Enter a valid mongodb:// or mongodb+srv:// connection string.'
    },
    diskError(): string {
      return this.contentMode !== 'disk' || this.diskPath.trim().length > 0 ? '' : 'Enter a content folder path.'
    },
    gitError(): string {
      return this.contentMode !== 'git' || this.git.repoUrl.trim().length > 0 ? '' : 'Enter a repository URL.'
    },
    privateKeyError(): string {
      return this.contentMode !== 'git' || this.git.authType !== 'ssh' || this.git.privateKey.trim().length > 0 ? '' : 'Enter the SSH private key.'
    },
    passwordError(): string {
      return this.contentMode !== 'git' || this.git.authType !== 'basic' || (this.git.username.trim().length > 0 && this.git.password.length > 0)
        ? ''
        : 'Enter a username and password or access token.'
    },
    canImportUsers(): boolean {
      return Boolean(mongoUri(this.mongoDbConnString)) && ['MULTI', 'SINGLE', 'NONE'].includes(this.groupMode)
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
        this.mongoDbConnString ||
        this.groupMode !== 'MULTI' ||
        this.contentMode !== 'git' ||
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
    mongoDbConnString() {
      this.publishDraftState()
    },
    groupMode() {
      this.publishDraftState()
    },
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
      return target.available ? 'Ready for a reviewed import.' : (target.reason ?? 'Unavailable in the current deployment.')
    },
    openUsersReview() {
      if (!this.canImportUsers || this.busy) return
      const payload = Object.freeze({ mongoDbConnString: this.mongoDbConnString, groupMode: this.groupMode }) as ImportPayload
      this.review = {
        open: true,
        kind: 'import-v1-users',
        title: 'Review Wiki.js 1.x user import',
        effect:
          'This reads the reviewed MongoDB user records, creates missing users and may create groups. Existing local users are skipped. No welcome email is sent.',
        confirmation: utilityOperationConfirmation('import-v1-users'),
        parameters: [
          { label: 'MongoDB source', value: mongoSourceIdentity(this.mongoDbConnString) },
          {
            label: 'Imported user groups',
            value:
              this.groupMode === 'MULTI'
                ? 'Create groups for each legacy permission set'
                : this.groupMode === 'SINGLE'
                  ? 'Create one shared imported-user group'
                  : 'Do not create imported-user groups'
          },
          { label: 'Connection credentials', value: 'Supplied; value hidden' }
        ],
        payload
      }
      this.reviewError = ''
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
              { label: 'Content source', value: 'Local folder' },
              { label: 'Content folder', value: this.diskPath.trim() }
            ]
          : [
              { label: 'Content source', value: 'Git repository' },
              { label: 'Repository', value: repositoryIdentity(this.git.repoUrl.trim()) },
              { label: 'Branch', value: this.git.branch.trim() },
              {
                label: 'Authentication',
                value: this.git.authType === 'ssh' ? 'SSH private key supplied; value hidden' : 'HTTP basic or access token supplied; values hidden'
              },
              { label: 'HTTPS certificate verification', value: this.git.verifySSL ? 'Enabled' : 'Disabled' },
              {
                label: 'Fallback author',
                value:
                  this.git.defaultName || this.git.defaultEmail
                    ? `${this.git.defaultName || 'Default name'} · ${this.git.defaultEmail || 'Default email'}`
                    : 'Use the target’s configured default'
              },
              { label: 'Local working copy', value: this.git.localRepoPath.trim() }
            ]
      this.review = {
        open: true,
        kind: 'import-v1-content',
        title: 'Review Wiki.js 1.x content import',
        effect:
          'This saves the selected storage target before activating it, then reads documents and assets from the reviewed source. Existing conflict and document-validation rules apply.',
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
      this.$emit('request', {
        kind: snapshot.kind,
        reason,
        acknowledgedUncertainId,
        payload: snapshot.payload,
        onRecorded: () => {
          if (snapshot.kind === 'import-v1-users') this.mongoDbConnString = ''
          else {
            this.git.privateKey = ''
            this.git.password = ''
          }
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

<style lang="scss" scoped>
.utility-import-group-strategy {
  :deep(.v-input__control > .v-label) {
    color: rgb(var(--v-theme-on-surface));
    opacity: 1;
  }
}
</style>

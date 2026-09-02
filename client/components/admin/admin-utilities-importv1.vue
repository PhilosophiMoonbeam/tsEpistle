<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.importv1Title') }}
    v-form#import-v1-form(@submit.prevent='startImport')
      .text-center
        img.animated.fadeInUp.wait-p1s(src='/_assets/svg/icon-software.svg', alt='')
        .text-body-medium Import from Wiki.js 1.x
      v-divider.my-4
      .text-body-medium Data from a Wiki.js 1.x installation can easily be imported using this tool. What do you want to import?
      v-checkbox(
        label='Content + Uploads'
        value='content'
        color='warning'
        v-model='importFilters'
        hide-details
        )
        template(v-slot:label)
          strong.text-deep-orange-darken-2 Content + Uploads
      .admin-import-option-indent(v-if='wantContent')
        v-radio-group(v-model='contentMode', hide-details, aria-label='Content import source')
          v-radio(
            value='git'
            color='primary'
            )
            template(v-slot:label)
              div
                span Import from Git Connection
                .text-body-small: em #[strong.text-primary Recommended] | The Git storage module will also be configured for you.
          .admin-import-option-indent.mt-5(v-if='needGit')
            v-row
              v-col(cols='12', md='8')
                v-select(
                  label='Authentication Mode'
                  :items='gitAuthModes'
                  item-title='text'
                  item-value='value'
                  v-model='gitAuthMode'
                  variant="outlined"
                  hide-details
                )
              v-col(cols='12', md='4')
                v-switch(
                  label='Verify SSL Certificate'
                  v-model='gitVerifySSL'
                  hide-details
                  color='primary'
                )
              v-col(cols='12', md='8')
                v-text-field(
                  variant="outlined"
                  label='Repository URL'
                  :placeholder='(gitAuthMode === `ssh`) ? `e.g. git@github.com:orgname/repo.git` : `e.g. https://github.com/orgname/repo.git`'
                  :rules='[requiredRule, repositoryRule]'
                  v-model='gitRepoUrl'
                )
              v-col(cols='12', md='4')
                v-text-field(
                  label='Branch'
                  placeholder='e.g. master'
                  :rules='[requiredRule]'
                  v-model='gitRepoBranch'
                  variant="outlined"
                )
              v-col(v-if='gitAuthMode === `ssh`', cols='12')
                v-textarea(
                  variant="outlined"
                  label='Private Key Contents'
                  placeholder='[REDACTED PRIVATE KEY]'
                  :rules='[requiredRule]'
                  v-model='gitPrivKey'
                )
              template(v-else-if='gitAuthMode === `basic`')
                v-col(cols='12', sm='6')
                  v-text-field(
                    label='Username'
                    :rules='[requiredRule]'
                    v-model='gitUsername'
                    variant="outlined"
                  )
                v-col(cols='12', sm='6')
                  v-text-field(
                    type='password'
                    label='Password / PAT'
                    :rules='[requiredRule]'
                    v-model='gitPassword'
                    variant="outlined"
                  )
              v-col(cols='12', sm='6')
                v-text-field(
                  label='Default Author Email'
                  placeholder='e.g. name@company.com'
                  v-model='gitUserEmail'
                  variant="outlined"
                  hide-details
                )
              v-col(cols='12', sm='6')
                v-text-field(
                  label='Default Author Name'
                  placeholder='e.g. John Smith'
                  v-model='gitUserName'
                  variant="outlined"
                  hide-details
                )
              v-col(cols='12')
                v-text-field(
                  label='Local Repository Path'
                  placeholder='e.g. ./data/repo'
                  v-model='gitRepoPath'
                  variant="outlined"
                  hide-details
                )
                .text-body-small.mt-2 This folder should be empty or not exist yet. #[strong.text-deep-orange-darken-2 DO NOT] point to your existing Wiki.js 1.x repository folder. In most cases, it should be left to the default value.
            v-alert(color='warning', variant="outlined", icon='mdi-alert', prominent)
              .text-body-medium - Note that if you already configured the git storage module, its configuration will be replaced with the above.
              .text-body-medium - Although both v1 and v2 installations can use the same remote git repository, you shouldn't make edits to the same pages simultaneously.
          v-divider
          v-radio.mt-3(
            value='disk'
            color='primary'
            )
            template(v-slot:label)
              div
                span Import from local folder
                .text-body-small: em Choose this option only if you didn't have git configured in your Wiki.js 1.x installation.
          .admin-import-option-indent.mt-5(v-if='needDisk')
            v-text-field(
              variant="outlined"
              label='Content Repo Path'
              hint='The absolute path to where the Wiki.js 1.x content is stored on disk.'
              persistent-hint
              :rules='[requiredRule]'
              v-model='contentPath'
            )

      v-checkbox(
        label='Users'
        value='users'
        color='warning'
        v-model='importFilters'
        hide-details
        )
        template(v-slot:label)
          strong.text-deep-orange-darken-2 Users
      .admin-import-option-indent.mt-5(v-if='wantUsers')
        v-text-field(
          variant="outlined"
          label='MongoDB Connection String'
          hint='The connection string to connect to the Wiki.js 1.x MongoDB database.'
          persistent-hint
          :rules='[mongoRule]'
          v-model='dbConnStr'
        )
        v-radio-group(v-model='groupMode', hide-details, mandatory, aria-label='Imported user group strategy')
          v-radio(
            value='MULTI'
            color='primary'
            )
            template(v-slot:label)
              div
                span Create groups for each unique user permissions configuration
                .text-body-small: em #[strong.text-primary Recommended] | Users having identical permission sets will be assigned to the same group. Note that this can potentially result in a large amount of groups being created.
          v-divider
          v-radio.mt-3(
            value='SINGLE'
            color='primary'
            )
            template(v-slot:label)
              div
                span Create a single group with all imported users
                .text-body-small: em The new group will have read permissions enabled by default.
          v-divider
          v-radio.mt-3(
            value='NONE'
            color='primary'
            )
            template(v-slot:label)
              div
                span Don't create any group
                .text-body-small: em Users will not be able to access your wiki until they are assigned to a group.

        v-alert.mt-5(color='warning', variant="outlined", icon='mdi-alert', prominent)
          .text-body-medium Note that any user that already exists in this installation will not be imported. A list of skipped users will be displayed upon completion.
          .text-body-small.text-grey You must first delete from this installation any user you want to migrate over from the old installation.

    div.v-card-chin
      v-btn.px-3(type='submit', form='import-v1-form', variant="flat", color='warning', :disabled='!canStartImport || isLoading').ml-0
        v-icon(start, color='on-warning') mdi-database-import
        span.text-on-warning Start Import
    v-dialog(v-model='confirmImport', max-width='620', persistent, :fullscreen='$vuetify.display.smAndDown', aria-labelledby='import-confirmation-title')
      v-card
        v-card-title#import-confirmation-title Review Wiki.js 1.x import
        v-card-text
          .text-body-medium You are about to import:
          ul.mt-2
            li(v-if='wantUsers') Users from the configured MongoDB database ({{groupModeDescription}})
            li(v-if='wantContent') Content and uploads from {{contentMode === 'git' ? 'the configured Git repository' : 'the configured local folder'}}
          v-alert.mt-4(v-if='wantContent && contentMode === "git"', color='warning', variant='outlined', icon='mdi-alert')
            .text-body-medium Git imports replace the existing Git storage-module configuration before importing content.
            .text-body-small.mt-2(v-if='wantUsers') Existing users are skipped when their email already exists.
          .text-body-small.mt-2(v-if='wantUsers && (!wantContent || contentMode !== "git")') Existing users are skipped when their email already exists.
        v-card-actions
          v-btn(variant="text", @click='confirmImport = false') Cancel
          v-spacer
          v-btn(color='warning', @click='confirmImport = false; executeImport()') {{wantContent && contentMode === 'git' ? 'Replace configuration and start import' : 'Start import'}}
    v-dialog(v-model='isLoading', persistent, max-width='420', aria-labelledby='import-progress-title')
      v-card(color='warning')
        v-card-text.pa-8.text-center(role='status', aria-live='polite', aria-busy='true')
          semipolar-spinner.animated.fadeIn(
            :animation-duration='1500'
            :size='65'
            color='rgb(var(--v-theme-on-warning))'
            style='margin: 0 auto;'
          )
          .mt-5.text-body-large#import-progress-title Importing from Wiki.js 1.x...
          .text-body-small Please wait while the selected stages finish.
          v-progress-linear.mt-5(
            color='on-warning'
            :model-value='progress'
            rounded
            :buffer-value='0'
          )
          .text-body-small.mt-2 {{progress}}% complete
    v-dialog(v-model='isSuccess', persistent, max-width='520', aria-labelledby='import-result-title')
      v-card(:color='hasImportFailures ? "warning" : "success"')
        v-card-text.pa-8.text-center(role='status', aria-live='polite')
          v-icon(size='60') {{hasImportFailures ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'}}
          .my-5.text-body-large#import-result-title {{hasImportFailures ? 'Import partially completed' : 'Import completed'}}
          .text-body-medium(v-if='userStage === "succeeded"') #[strong {{successUsers}}] users imported; #[strong {{successGroups}}] groups created.
          .text-body-medium(v-if='contentStage === "succeeded"') Content and uploads imported.
          .text-body-medium(v-if='userStage === "failed"') Users failed: {{userStageError}}
          .text-body-medium(v-if='contentStage === "failed"') Content failed: {{contentStageError}}
          v-btn.text-none.mt-3(
            v-if='failedUsers.length > 0'
            variant="text"
            :color='hasImportFailures ? "on-warning" : "on-success"'
            @click='showFailedUsers = true'
          )
            v-icon(start) mdi-alert
            span {{failedUsers.length}} user records failed
        v-card-actions
          v-spacer
          v-btn.px-5(variant="outlined", @click='isSuccess = false') Close
          v-spacer
    v-dialog(v-model='showFailedUsers', persistent, max-width='800', :fullscreen='$vuetify.display.smAndDown', aria-labelledby='failed-users-title')
      v-card(color='error')
        v-toolbar(color='error', density="compact")
          v-icon mdi-alert
          .text-body-medium.pl-3#failed-users-title Failed User Imports
          v-spacer
          v-btn.px-5(variant="text", @click='showFailedUsers = false') Close
        v-table.failed-users-table(density="compact", fixed-header, height='300px')
          template(v-slot:default)
            thead
              tr
                th Provider
                th Email
                th Error
            tbody
              tr(v-for='(fusr, idx) in failedUsers', :key='`fusr-` + idx')
                td {{fusr.provider}}
                td {{fusr.email}}
                td {{fusr.error}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'

import { SemipolarSpinner } from 'epic-spinners'

import { executeStorageAction, fetchStorageStatus, fetchStorageTargets, saveStorageTargets } from '../../helpers/storage-api'
import { importV1Users } from '../../helpers/system-api'
import { wikiStore } from '@/store/index.ts'

type ImportFilter = 'content' | 'users'
type ContentMode = 'git' | 'disk'
type GitAuthMode = 'ssh' | 'basic'
type GroupMode = 'MULTI' | 'SINGLE' | 'NONE'
type ImportStage = 'pending' | 'running' | 'succeeded' | 'failed'

type FailedUser = {
  provider: string
  email: string
  error: string
}

type StorageConfigValue = {
  value: unknown
  order?: number
  [key: string]: unknown
}

type StorageConfig = {
  key: string
  value: StorageConfigValue
  [key: string]: unknown
}

type StorageTarget = {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: StorageConfig[]
  [key: string]: unknown
}

type StorageStatus = {
  key: string
  status: string
  message: string
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFailedUsers (users: unknown[]): FailedUser[] {
  return users.map(user => {
    if (!isRecord(user) || typeof user.provider !== 'string' || typeof user.email !== 'string' || typeof user.error !== 'string') {
      throw new Error('Wiki.js 1.x user import response is invalid.')
    }
    return {
      provider: user.provider,
      email: user.email,
      error: user.error
    }
  })
}

function normalizeStorageTarget (target: unknown): StorageTarget {
  if (!isRecord(target) || typeof target.key !== 'string' || typeof target.isEnabled !== 'boolean' || typeof target.mode !== 'string' || typeof target.syncInterval !== 'string' || !Array.isArray(target.config)) {
    throw new Error('Storage target response is invalid.')
  }

  const config: StorageConfig[] = target.config.map(entry => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      throw new Error('Storage target configuration is invalid.')
    }
    const value: unknown = JSON.parse(entry.value)
    if (!isRecord(value) || !('value' in value)) {
      throw new Error('Storage target configuration is invalid.')
    }
    return {
      ...entry,
      key: entry.key,
      value: {
        ...value,
        value: value.value
      }
    }
  })

  return {
    ...target,
    key: target.key,
    isEnabled: target.isEnabled,
    mode: target.mode,
    syncInterval: target.syncInterval,
    config: _.sortBy(config, entry => entry.value.order)
  }
}

function normalizeStorageStatus (status: unknown): StorageStatus {
  if (!isRecord(status) || typeof status.key !== 'string' || typeof status.status !== 'string' || typeof status.message !== 'string') {
    throw new Error('Storage status response is invalid.')
  }
  return {
    key: status.key,
    status: status.status,
    message: status.message
  }
}

function isValidRepository (value: string): boolean {
  return /^(https?:\/\/.+|git@.+|ssh:\/\/.+)/.test(value.trim())
}

function isValidMongo (value: string): boolean {
  return /^(mongodb(\+srv)?:\/\/).+/.test(value.trim())
}
export default defineComponent({
  components: {
    SemipolarSpinner
  },
  data() {
    return {
      importFilters: ['content', 'users'] as ImportFilter[],
      groupMode: 'MULTI' as GroupMode,
      contentMode: 'git' as ContentMode,
      dbConnStr: 'mongodb://',
      contentPath: '/wiki-v1/repo',
      confirmImport: false,
      isLoading: false,
      isSuccess: false,
      gitAuthMode: 'ssh' as GitAuthMode,
      gitAuthModes: [
        { text: 'SSH', value: 'ssh' },
        { text: 'Basic', value: 'basic' }
      ],
      gitVerifySSL: true,
      gitRepoUrl: '',
      gitRepoBranch: 'master',
      gitPrivKey: '',
      gitUsername: '',
      gitPassword: '',
      gitUserEmail: '',
      gitUserName: '',
      gitRepoPath: './data/repo',
      progress: 0,
      successGroups: 0,
      successUsers: 0,
      userStage: 'pending' as ImportStage,
      contentStage: 'pending' as ImportStage,
      userStageError: '',
      contentStageError: '',
      showFailedUsers: false,
      failedUsers: [] as FailedUser[]
    }
  },
  computed: {
    wantContent () {
      return this.importFilters.indexOf('content') >= 0
    },
    wantUsers () {
      return this.importFilters.indexOf('users') >= 0
    },
    needDisk () {
      return this.contentMode === 'disk'
    },
    needGit () {
      return this.contentMode === 'git'
    },
    canStartImport (): boolean {
      if (!this.wantUsers && !this.wantContent) return false
      if (this.wantUsers && !isValidMongo(this.dbConnStr)) return false
      if (!this.wantContent) return true
      if (this.contentMode === 'disk') return this.contentPath.trim().length > 0
      if (!this.gitRepoUrl.trim() || !this.gitRepoBranch.trim() || !isValidRepository(this.gitRepoUrl)) return false
      return this.gitAuthMode === 'ssh'
        ? this.gitPrivKey.trim().length > 0
        : this.gitUsername.trim().length > 0 && this.gitPassword.trim().length > 0
    },
    hasImportFailures (): boolean {
      return this.userStage === 'failed' || this.contentStage === 'failed' || this.failedUsers.length > 0
    },
    groupModeDescription (): string {
      return this.groupMode === 'MULTI'
        ? 'groups per permission set'
        : this.groupMode === 'SINGLE' ? 'one group' : 'no new group'
    }
  },
  methods: {
    requiredRule (value: unknown): true | string {
      return typeof value === 'string' && value.trim().length > 0 ? true : 'This field is required.'
    },
    repositoryRule (value: unknown): true | string {
      if (typeof value !== 'string' || value.trim().length === 0) return true
      return isValidRepository(value) ? true : 'Enter an HTTPS or SSH repository URL.'
    },
    mongoRule (value: unknown): true | string {
      return typeof value === 'string' && isValidMongo(value)
        ? true
        : 'Enter a valid MongoDB connection string.'
    },
    stageWeight (): number {
      return 100 / (Number(this.wantUsers) + Number(this.wantContent))
    },
    advanceContent (step: number) {
      this.progress = Math.min(100, this.progress + this.stageWeight() * step / 50)
    },
    startImport () {
      if (this.isLoading || !this.canStartImport) return
      this.confirmImport = true
    },
    async executeImport () {
      if (this.isLoading || !this.canStartImport) return
      this.isLoading = true
      this.isSuccess = false
      this.progress = 0
      this.failedUsers = []
      this.successUsers = 0
      this.successGroups = 0
      this.userStage = this.wantUsers ? 'pending' : 'succeeded'
      this.contentStage = this.wantContent ? 'pending' : 'succeeded'
      this.userStageError = ''
      this.contentStageError = ''

      if (this.wantUsers) {
        this.userStage = 'running'
        try {
          const result = await importV1Users(window.fetch.bind(window), this.dbConnStr, this.groupMode)
          this.successUsers = result.usersCount
          this.successGroups = result.groupsCount
          this.failedUsers = normalizeFailedUsers(result.failed)
          this.userStage = 'succeeded'
          this.progress += this.stageWeight()
        } catch (err) {
          this.userStage = 'failed'
          this.userStageError = err instanceof Error ? err.message : String(err)
          wikiStore.showError(err)
        }
      }

      if (this.wantContent) {
        this.contentStage = 'running'
        try {
          const storageTargets = (await fetchStorageTargets(window.fetch.bind(window))).map(normalizeStorageTarget)
          if (storageTargets.length === 0) throw new Error('Failed to fetch storage targets.')
          this.advanceContent(10)
          const targets = storageTargets.map(str => {
            const nStr: StorageTarget = {
              ...str,
              config: str.config.map(cfg => ({ ...cfg, value: { ...cfg.value } }))
            }
            if (this.contentMode === 'git' && nStr.key === 'git') {
              nStr.isEnabled = true
              nStr.mode = 'sync'
              nStr.syncInterval = 'PT5M'
              nStr.config = [
                { key: 'authType', value: { value: this.gitAuthMode } },
                { key: 'repoUrl', value: { value: this.gitRepoUrl } },
                { key: 'branch', value: { value: this.gitRepoBranch } },
                { key: 'sshPrivateKeyMode', value: { value: 'contents' } },
                { key: 'sshPrivateKeyPath', value: { value: '' } },
                { key: 'sshPrivateKeyContent', value: { value: this.gitPrivKey } },
                { key: 'verifySSL', value: { value: this.gitVerifySSL } },
                { key: 'basicUsername', value: { value: this.gitUsername } },
                { key: 'basicPassword', value: { value: this.gitPassword } },
                { key: 'defaultEmail', value: { value: this.gitUserEmail } },
                { key: 'defaultName', value: { value: this.gitUserName } },
                { key: 'localRepoPath', value: { value: this.gitRepoPath } },
                { key: 'gitBinaryPath', value: { value: '' } }
              ]
            }
            if (this.contentMode === 'disk' && nStr.key === 'disk') {
              nStr.isEnabled = true
              nStr.mode = 'push'
              nStr.syncInterval = 'P0D'
              nStr.config = [
                { key: 'path', value: { value: this.contentPath } },
                { key: 'createDailyBackups', value: { value: false } }
              ]
            }
            return nStr
          })
          await saveStorageTargets(window.fetch.bind(window), targets.map(target => ({
            isEnabled: target.isEnabled,
            key: target.key,
            config: target.config.map(config => ({ ...config, value: JSON.stringify({ v: config.value.value }) })),
            mode: target.mode,
            syncInterval: target.syncInterval
          })))
          this.advanceContent(10)

          let statusAttempts = 0
          while (statusAttempts < 10) {
            statusAttempts++
            const storageStatus = (await fetchStorageStatus(window.fetch.bind(window))).map(normalizeStorageStatus)
            const st = storageStatus.find(status => status.key === this.contentMode)
            if (!st) throw new Error('Storage target could not be configured.')
            if (st.status === 'operational') break
            if (st.status === 'error') throw new Error(st.message)
            if (statusAttempts >= 10) throw new Error('Storage target is stuck in pending state. Try again.')
            await new Promise<void>(resolve => window.setTimeout(resolve, 1000))
          }
          this.advanceContent(15)
          const result = await executeStorageAction(window.fetch.bind(window), this.contentMode, 'importAll')
          if (result.outcome !== 'succeeded') {
            throw new Error(result.message || 'Content import did not complete successfully.')
          }
          this.advanceContent(15)
          this.contentStage = 'succeeded'
        } catch (err) {
          this.contentStage = 'failed'
          this.contentStageError = err instanceof Error ? err.message : String(err)
          wikiStore.showError(err)
        }
      }

      const allSucceeded = (!this.wantUsers || this.userStage === 'succeeded') && (!this.wantContent || this.contentStage === 'succeeded')
      if (allSucceeded) this.progress = 100
      this.isLoading = false
      this.isSuccess = true
    }
  }
})
</script>

<style lang='scss'>
.admin-import-option-indent {
  padding-left: 2rem;
}

.failed-users-table td {
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (max-width: 599.98px) {
  .admin-import-option-indent {
    padding-left: 1rem;
  }
}
</style>

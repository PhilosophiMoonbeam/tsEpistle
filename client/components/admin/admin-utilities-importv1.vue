<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.importv1Title') }}
    v-card-text
      .text-center
        img.animated.fadeInUp.wait-p1s(src='/_assets/svg/icon-software.svg')
        .text-body-medium Import from Wiki.js 1.x
      v-divider.my-4
      .text-body-medium Data from a Wiki.js 1.x installation can easily be imported using this tool. What do you want to import?
      v-checkbox(
        label='Content + Uploads'
        value='content'
        color="deep-orange-darken-2"
        v-model='importFilters'
        hide-details
        )
        template(v-slot:label)
          strong.text-deep-orange-darken-2 Content + Uploads
      .pl-8(v-if='wantContent')
        v-radio-group(v-model='contentMode', hide-details)
          v-radio(
            value='git'
            color='primary'
            )
            template(v-slot:label)
              div
                span Import from Git Connection
                .text-body-small: em #[strong.text-primary Recommended] | The Git storage module will also be configured for you.
        .pl-8.mt-5(v-if='needGit')
          v-row
            v-col(cols='8')
              v-select(
                label='Authentication Mode'
                :items='gitAuthModes'
                v-model='gitAuthMode'
                variant="outlined"
                hide-details
              )
            v-col(cols='4')
              v-switch(
                label='Verify SSL Certificate'
                v-model='gitVerifySSL'
                hide-details
                color='primary'
              )
            v-col(cols='8')
              v-text-field(
                variant="outlined"
                label='Repository URL'
                :placeholder='(gitAuthMode === `ssh`) ? `e.g. git@github.com:orgname/repo.git` : `e.g. https://github.com/orgname/repo.git`'
                hide-details
                v-model='gitRepoUrl'
              )
            v-col(cols='4')
              v-text-field(
                label='Branch'
                placeholder='e.g. master'
                v-model='gitRepoBranch'
                variant="outlined"
                hide-details
              )
            v-col(v-if='gitAuthMode === `ssh`', cols='12')
              v-textarea(
                variant="outlined"
                label='Private Key Contents'
                placeholder='[REDACTED PRIVATE KEY]'
                hide-details
                v-model='gitPrivKey'
              )
            template(v-else-if='gitAuthMode === `basic`')
              v-col(cols='6')
                v-text-field(
                  label='Username'
                  v-model='gitUsername'
                  variant="outlined"
                  hide-details
                )
              v-col(cols='6')
                v-text-field(
                  type='password'
                  label='Password / PAT'
                  v-model='gitPassword'
                  variant="outlined"
                  hide-details
                )
            v-col(cols='6')
              v-text-field(
                label='Default Author Email'
                placeholder='e.g. name@company.com'
                v-model='gitUserEmail'
                variant="outlined"
                hide-details
              )
            v-col(cols='6')
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
          v-alert(color='deep-orange', variant="outlined", icon='mdi-alert', prominent)
            .text-body-medium - Note that if you already configured the git storage module, its configuration will be replaced with the above.
            .text-body-medium - Although both v1 and v2 installations can use the same remote git repository, you shouldn't make edits to the same pages simultaneously.
        v-radio-group(v-model='contentMode', hide-details)
          v-divider
          v-radio.mt-3(
            value='disk'
            color='primary'
            )
            template(v-slot:label)
              div
                span Import from local folder
                .text-body-small: em Choose this option only if you didn't have git configured in your Wiki.js 1.x installation.
        .pl-8.mt-5(v-if='needDisk')
          v-text-field(
            variant="outlined"
            label='Content Repo Path'
            hint='The absolute path to where the Wiki.js 1.x content is stored on disk.'
            persistent-hint
            v-model='contentPath'
          )

      v-checkbox(
        label='Users'
        value='users'
        color="deep-orange-darken-2"
        v-model='importFilters'
        hide-details
        )
        template(v-slot:label)
          strong.text-deep-orange-darken-2 Users
      .pl-8.mt-5(v-if='wantUsers')
        v-text-field(
          variant="outlined"
          label='MongoDB Connection String'
          hint='The connection string to connect to the Wiki.js 1.x MongoDB database.'
          persistent-hint
          v-model='dbConnStr'
        )
        v-radio-group(v-model='groupMode', hide-details, mandatory)
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

        v-alert.mt-5(color='deep-orange', variant="outlined", icon='mdi-alert', prominent)
          .text-body-medium Note that any user that already exists in this installation will not be imported. A list of skipped users will be displayed upon completion.
          .text-body-small.text-grey You must first delete from this installation any user you want to migrate over from the old installation.

    div.v-card-chin
      v-btn.px-3(variant="flat", color="deep-orange-darken-2", :disabled='!wantUsers && !wantContent', @click='startImport').ml-0
        v-icon(start, color='white') mdi-database-import
        span.text-white Start Import
    v-dialog(
      v-model='isLoading'
      persistent
      max-width='350'
      )
      v-card(color="deep-orange-darken-2")
        v-card-text.pa-10.text-center
          semipolar-spinner.animated.fadeIn(
            :animation-duration='1500'
            :size='65'
            color='#FFF'
            style='margin: 0 auto;'
          )
          .mt-5.text-body-large.text-white Importing from Wiki.js 1.x...
          .text-body-small Please wait
          v-progress-linear.mt-5(
            color='white'
            :model-value='progress'
            stream
            rounded
            :buffer-value='0'
          )
    v-dialog(
      v-model='isSuccess'
      persistent
      max-width='350'
      )
      v-card(color="green-darken-2")
        v-card-text.pa-10.text-center
          v-icon(size='60') mdi-check-circle-outline
          .my-5.text-body-large.text-white Import completed
          template(v-if='wantUsers')
            .text-body-medium
              span #[strong {{successUsers}}] users imported
              v-btn.text-none.ml-3(
                v-if='failedUsers.length > 0'
                variant="text"
                color='white'
                @click='showFailedUsers = true'
                )
                v-icon(start) mdi-alert
                span {{failedUsers.length}} failed
            .text-body-medium #[strong {{successGroups}}] groups created
        v-card-actions.bg-green-darken-1
          v-spacer
          v-btn.px-5(
            color='white'
            variant="outlined"
            @click='isSuccess = false'
          ) Close
          v-spacer
    v-dialog(
      v-model='showFailedUsers'
      persistent
      max-width='800'
      )
      v-card(color="red-darken-2")
        v-toolbar(color="red-darken-2", density="compact")
          v-icon mdi-alert
          .text-body-medium.pl-3 Failed User Imports
          v-spacer
          v-btn.px-5(
            color='white'
            variant="text"
            @click='showFailedUsers = false'
            ) Close
        v-table(density="compact", fixed-header, height='300px')
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
                td {{fusr.error}}</template>

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
      successPages: 0,
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
      return this.contentMode === `disk`
    },
    needGit () {
      return this.contentMode === `git`
    }
  },
  methods: {
    async startImport () {
      this.isLoading = true
      this.progress = 0
      this.failedUsers = []

      _.delay(async () => {
        // -> Import Users

        if (this.wantUsers) {
          try {
            const result = await importV1Users(
              window.fetch.bind(window),
              this.dbConnStr,
              this.groupMode
            )
            this.successUsers = result.usersCount
            this.successGroups = result.groupsCount
            this.failedUsers = normalizeFailedUsers(result.failed)
            this.progress += 50
          } catch (err) {
            wikiStore.showError(err)
            this.isLoading = false
            return
          }
        }

        // -> Import Content

        if (this.wantContent) {
          try {
            const storageTargets = (await fetchStorageTargets(window.fetch.bind(window))).map(normalizeStorageTarget)
            if (storageTargets.length > 0) {
              this.progress += 10
              const targets = storageTargets.map(str => {
                const nStr: StorageTarget = {
                  ...str,
                  config: str.config.map(cfg => ({
                    ...cfg,
                    value: { ...cfg.value }
                  }))
                }

                // -> Setup Git Module

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

                // -> Setup Disk Module
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

              // -> Save storage modules configuration

              await saveStorageTargets(window.fetch.bind(window), targets.map(target => ({
                isEnabled: target.isEnabled,
                key: target.key,
                config: target.config.map(config => ({
                  ...config,
                  value: JSON.stringify({ v: config.value.value })
                })),
                mode: target.mode,
                syncInterval: target.syncInterval
              })))

              this.progress += 10

              // -> Wait for success sync

              let statusAttempts = 0
              while (statusAttempts < 10) {
                statusAttempts++
                const storageStatus = (await fetchStorageStatus(window.fetch.bind(window))).map(normalizeStorageStatus)
                if (storageStatus.length > 0) {
                  const st = storageStatus.find(status => status.key === this.contentMode)
                  if (!st) {
                    throw new Error('Storage target could not be configured.')
                  }
                  switch (st.status) {
                    case 'pending':
                      if (statusAttempts >= 10) {
                        throw new Error('Storage target is stuck in pending state. Try again.')
                      } else {
                        continue
                      }
                    case 'operational':
                      statusAttempts = 10
                      break
                    case 'error':
                      throw new Error(st.message)
                  }
                } else {
                  throw new Error('Failed to fetch storage sync status.')
                }
              }

              this.progress += 15

              // -> Perform import all

              await executeStorageAction(window.fetch.bind(window), this.contentMode, 'importAll')

              this.progress += 15
            } else {
              throw new Error('Failed to fetch storage targets.')
            }
          } catch (err) {
            wikiStore.showError(err)
            this.isLoading = false
            return
          }
        }

        this.isLoading = false
        this.isSuccess = true
      }, 1500)
    }
  }
})
</script>

<style lang='scss'>

</style>

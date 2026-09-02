<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.exportTitle') }}
    v-form(@submit.prevent='requestExport')
      v-card-text
        .text-center
          img.animated.fadeInUp.wait-p1s(src='/_assets/svg/icon-big-parcel.svg', alt='')
          .text-body-medium Export to tarball / file system
        v-divider.my-4
        .text-body-medium What do you want to export?
        v-checkbox(
          v-for='choice of entityChoices'
          :key='choice.key'
          :label='choice.label'
          :value='choice.key'
          color="primary"
          hide-details
          v-model='entities'
          :aria-describedby='entities.length < 1 ? `export-entities-error` : undefined'
        )
          template(v-slot:label)
            div
              strong.text-primary {{choice.label}}
              .text-body-small {{choice.hint}}
        v-text-field.mt-7(
          variant="outlined"
          label='Target Folder Path'
          hint='Use an absolute path or a path relative to the tsFranki installation folder. The target folder MUST be empty.'
          persistent-hint
          v-model='filePath'
          :error-messages='filePathError'
        )
        .text-body-small.text-error.mt-1#export-entities-error(v-if='entities.length < 1') Select at least one entity to export.
        v-alert.mt-3(color='warning', variant="outlined", icon='mdi-alert', prominent)
          .text-body-medium Depending on your selection, the archive could contain sensitive data such as site configuration keys and hashed user passwords. Ensure the exported archive is treated accordingly.
          .text-body-medium For example, you may want to encrypt the archive if stored for backup purposes.
      v-card-chin
        v-btn.px-3(type='submit', variant="flat", color="primary", :disabled='!isExportValid || isLoading', :loading='isLoading').ml-0
          v-icon(start, aria-hidden='true') mdi-database-export
          span Start Export
    v-dialog(
      v-model='isConfirming'
      persistent
      max-width='520'
      aria-labelledby='export-confirm-title'
      )
      v-card
        v-card-title#export-confirm-title Confirm export
        v-card-text
          .text-body-medium Export {{ entities.join(', ') }} to:
          code.export-path {{ filePath.trim() }}
          .text-body-medium.mt-3 Confirm that the target folder is empty and that you will protect any sensitive data in the export.
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='isConfirming = false', :disabled='isLoading') Cancel
          v-btn(color='primary', variant='flat', @click='confirmExport') Confirm Export
    v-dialog(
      v-model='isLoading'
      persistent
      max-width='350'
      aria-labelledby='export-progress-title'
      )
      v-card(color="primary")
        v-card-text.pa-10.text-center
          self-building-square-spinner.animated.fadeIn(
            :animation-duration='4500'
            :size='40'
            color='#FFF'
            style='margin: 0 auto;'
            aria-hidden='true'
          )
          .mt-5.text-body-large.text-white#export-progress-title Exporting...
          .text-body-small.text-white(role='status' aria-live='polite') Please wait, this may take a while ({{ progress }}%)
          v-progress-linear.mt-5(
            color='white'
            :model-value='progress'
            stream
            rounded
            :buffer-value='0'
            aria-label='Export progress'
            :aria-valuetext='`${progress}% complete`'
          )
    v-dialog(
      v-model='isSuccess'
      persistent
      max-width='350'
      aria-labelledby='export-success-title'
      )
      v-card(color="success")
        v-card-text.pa-10.text-center
          v-icon(size='60', aria-hidden='true') mdi-check-circle-outline
          .my-5.text-body-large.text-white#export-success-title Export completed
          code.export-path.text-white {{ filePath.trim() }}
        v-card-actions
          v-spacer
          v-btn.px-5(color='white', variant="outlined", @click='isSuccess = false') Close
          v-spacer
    v-dialog(
      v-model='isFailed'
      persistent
      max-width='800'
      aria-labelledby='export-failed-title'
      )
      v-card(color="error")
        v-toolbar(color="error", density="compact")
          v-icon(aria-hidden='true') mdi-alert
          .text-body-medium.pl-3#export-failed-title Export failed
          v-spacer
          v-btn.px-5(color='white', variant="text", @click='isFailed = false') Close
        v-card-text.pa-5.bg-red-darken-4.text-white(role='alert')
          span {{errorMessage}}</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { SelfBuildingSquareSpinner } from 'epic-spinners'

import { fetchSystemExportStatus, startSystemExport } from '../../helpers/system-api'
type ExportEntity = 'assets' | 'comments' | 'navigation' | 'pages' | 'history' | 'settings' | 'groups' | 'users'

type ExportEntityChoice = {
  key: ExportEntity
  label: string
  hint: string
}

type ExportState = {
  entities: ExportEntity[]
  filePath: string
  isConfirming: boolean
  isLoading: boolean
  isSuccess: boolean
  isFailed: boolean
  errorMessage: string
  progress: number
  isDisposed: boolean
  requestGeneration: number
  pollAnimationFrameHandle: number | null
  pollTimeoutHandle: number | null
  startTimeoutHandle: number | null
}

type ExportVm = ExportState & {
  clearScheduledWork: () => void
  checkProgress: (generation?: number) => Promise<void>
  startExport: () => Promise<void>
}

function getErrorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default defineComponent({
  components: {
    SelfBuildingSquareSpinner
  },
  data(): ExportState {
    return {
      entities: [] as ExportEntity[],
      filePath: './data/export',
      isConfirming: false,
      isLoading: false,
      isSuccess: false,
      isFailed: false,
      errorMessage: '',
      progress: 0,
      isDisposed: false,
      requestGeneration: 0,
      startTimeoutHandle: null as number | null,
      pollAnimationFrameHandle: null as number | null,
      pollTimeoutHandle: null as number | null
    }
  },
  computed: {
    isExportValid (): boolean {
      return this.entities.length > 0 && this.filePath.trim().length > 0
    },
    filePathError (): string {
      return this.filePath.trim().length > 0 ? '' : 'Enter a target folder path.'
    },
    entityChoices (): ExportEntityChoice[] {
      return [
        {
          key: 'assets',
          label: 'Assets',
          hint: 'Media files such as images, documents, etc.'
        },
        {
          key: 'comments',
          label: 'Comments',
          hint: 'Comments made using the default comment module only.'
        },
        {
          key: 'navigation',
          label: 'Navigation',
          hint: 'Sidebar links when using Static or Custom Navigation.'
        },
        {
          key: 'pages',
          label: 'Pages',
          hint: 'Page content, tags and related metadata.'
        },
        {
          key: 'history',
          label: 'Pages History',
          hint: 'All previous versions of pages and their related metadata.'
        },
        {
          key: 'settings',
          label: 'Settings',
          hint: 'Site configuration and modules settings.'
        },
        {
          key: 'groups',
          label: 'User Groups',
          hint: 'Group permissions and page rules.'
        },
        {
          key: 'users',
          label: 'Users',
          hint: 'Users metadata and their group memberships.'
        }
      ]
    }
  },
  beforeUnmount() {
    this.isDisposed = true
    this.requestGeneration += 1
    this.clearScheduledWork()
  },
  methods: {
    requestExport () {
      if (this.isExportValid && !this.isLoading) {
        this.isConfirming = true
      }
    },
    async confirmExport () {
      if (!this.isExportValid || this.isLoading) {
        return
      }
      this.isConfirming = false
      await this.startExport()
    },
    clearScheduledWork () {
      if (this.startTimeoutHandle !== null) {
        window.clearTimeout(this.startTimeoutHandle)
        this.startTimeoutHandle = null
      }
      if (this.pollAnimationFrameHandle !== null) {
        window.cancelAnimationFrame(this.pollAnimationFrameHandle)
        this.pollAnimationFrameHandle = null
      }
      if (this.pollTimeoutHandle !== null) {
        window.clearTimeout(this.pollTimeoutHandle)
        this.pollTimeoutHandle = null
      }
    },
    async checkProgress (this: ExportVm, generation = this.requestGeneration) {
      if (this.isDisposed || generation !== this.requestGeneration) {
        return
      }

      try {
        const respStatusObj = await fetchSystemExportStatus(window.fetch.bind(window), 'Export status response is invalid')
        if (this.isDisposed || generation !== this.requestGeneration) {
          return
        }

        switch (respStatusObj.status) {
          case 'error': {
            throw new Error(respStatusObj.message || 'An unexpected error occurred.')
          }
          case 'running': {
            this.progress = respStatusObj.progress || 0
            this.pollAnimationFrameHandle = window.requestAnimationFrame(() => {
              if (this.isDisposed || generation !== this.requestGeneration) {
                return
              }
              this.pollAnimationFrameHandle = null

              this.pollTimeoutHandle = window.setTimeout(() => {
                if (this.isDisposed || generation !== this.requestGeneration) {
                  return
                }
                this.pollTimeoutHandle = null
                void this.checkProgress(generation)
              }, 5000)
            })
            break
          }
          case 'success': {
            this.isLoading = false
            this.isSuccess = true
            break
          }
          default: {
            throw new Error('Invalid export status.')
          }
        }
      } catch (err) {
        if (this.isDisposed || generation !== this.requestGeneration) {
          return
        }
        this.errorMessage = getErrorMessage(err)
        this.isLoading = false
        this.isFailed = true
      }
    },
    async startExport () {
      if (this.isDisposed || !this.isExportValid) {
        return
      }

      this.clearScheduledWork()
      this.requestGeneration += 1
      const generation = this.requestGeneration
      this.isFailed = false
      this.isSuccess = false
      this.errorMessage = ''
      this.filePath = this.filePath.trim()
      this.isLoading = true
      this.progress = 0

      this.startTimeoutHandle = window.setTimeout(async () => {
        if (this.isDisposed || generation !== this.requestGeneration) {
          return
        }
        this.startTimeoutHandle = null

        try {
          // -> Initiate export
          await startSystemExport(window.fetch.bind(window), this.entities, this.filePath, 'Export failed')
          if (this.isDisposed || generation !== this.requestGeneration) {
            return
          }

          // -> Check for progress
          void this.checkProgress(generation)
        } catch (err) {
          if (this.isDisposed || generation !== this.requestGeneration) {
            return
          }
          this.errorMessage = getErrorMessage(err)
          this.isFailed = true
          this.isLoading = false
        }
      }, 1500)
    }
  }
})
</script>
<style lang='scss'>
.export-path {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>

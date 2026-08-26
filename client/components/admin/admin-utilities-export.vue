<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.exportTitle') }}
    v-card-text
      .text-center
        img.animated.fadeInUp.wait-p1s(src='/_assets/svg/icon-big-parcel.svg')
        .text-body-medium Export to tarball / file system
      v-divider.my-4
      .text-body-medium What do you want to export?
      v-checkbox(
        v-for='choice of entityChoices'
        :key='choice.key'
        :label='choice.label'
        :value='choice.key'
        color="deep-orange-darken-2"
        hide-details
        v-model='entities'
        )
        template(v-slot:label)
          div
            strong.text-deep-orange-darken-2 {{choice.label}}
            .text-body-small {{choice.hint}}
      v-text-field.mt-7(
        variant="outlined"
        label='Target Folder Path'
        hint='Use an absolute path or a path relative to the tsFranki installation folder. The target folder MUST be empty.'
        persistent-hint
        v-model='filePath'
      )

      v-alert.mt-3(color='deep-orange', variant="outlined", icon='mdi-alert', prominent)
        .text-body-medium Depending on your selection, the archive could contain sensitive data such as site configuration keys and hashed user passwords. Ensure the exported archive is treated accordingly.
        .text-body-medium For example, you may want to encrypt the archive if stored for backup purposes.

    div.v-card-chin
      v-btn.px-3(variant="flat", color="deep-orange-darken-2", :disabled='entities.length < 1', @click='startExport').ml-0
        v-icon(start, color='white') mdi-database-export
        span.text-white Start Export
    v-dialog(
      v-model='isLoading'
      persistent
      max-width='350'
      )
      v-card(color="deep-orange-darken-2")
        v-card-text.pa-10.text-center
          self-building-square-spinner.animated.fadeIn(
            :animation-duration='4500'
            :size='40'
            color='#FFF'
            style='margin: 0 auto;'
          )
          .mt-5.text-body-large.text-white Exporting...
          .text-body-small Please wait, this may take a while
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
          .my-5.text-body-large.text-white Export completed
        v-card-actions.bg-green-darken-1
          v-spacer
          v-btn.px-5(
            color='white'
            variant="outlined"
            @click='isSuccess = false'
          ) Close
          v-spacer
    v-dialog(
      v-model='isFailed'
      persistent
      max-width='800'
      )
      v-card(color="red-darken-2")
        v-toolbar(color="red-darken-2", density="compact")
          v-icon mdi-alert
          .text-body-medium.pl-3 Export failed
          v-spacer
          v-btn.px-5(
            color='white'
            variant="text"
            @click='isFailed = false'
            ) Close
        v-card-text.pa-5.bg-red-darken-4.text-white
          span {{errorMessage}}</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { SelfBuildingSquareSpinner } from 'epic-spinners'

import { fetchSystemExportStatus, startSystemExport } from '../../helpers/system-api'
import { wikiStore } from '@/store/index.ts'

type ExportEntity = 'assets' | 'comments' | 'navigation' | 'pages' | 'history' | 'settings' | 'groups' | 'users'

type ExportEntityChoice = {
  key: ExportEntity
  label: string
  hint: string
}

function getErrorMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default defineComponent({
  components: {
    SelfBuildingSquareSpinner
  },
  data() {
    return {
      entities: [] as ExportEntity[],
      filePath: './data/export',
      isLoading: false,
      isSuccess: false,
      isFailed: false,
      errorMessage: '',
      progress: 0
    }
  },
  computed: {
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
  methods: {
    async checkProgress () {
      try {
        const respStatusObj = await fetchSystemExportStatus(window.fetch.bind(window), 'Export status response is invalid')
        switch (respStatusObj.status) {
          case 'error': {
            throw new Error(respStatusObj.message || 'An unexpected error occured.')
          }
          case 'running': {
            this.progress = respStatusObj.progress || 0
            window.requestAnimationFrame(() => {
              setTimeout(() => {
                this.checkProgress()
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
        this.errorMessage = getErrorMessage(err)
        this.isLoading = false
        this.isFailed = true
      }
    },
    async startExport () {
      this.isFailed = false
      this.isSuccess = false
      this.isLoading = true
      this.progress = 0

      setTimeout(async () => {
        try {
          // -> Initiate export
          await startSystemExport(window.fetch.bind(window), this.entities, this.filePath, 'Export failed')

          // -> Check for progress
          this.checkProgress()
        } catch (err) {
          this.errorMessage = getErrorMessage(err)
          this.isFailed = true
          wikiStore.showError(err)
          this.isLoading = false
        }
      }, 1500)
    }
  }
})
</script>

<style lang='scss'>

</style>

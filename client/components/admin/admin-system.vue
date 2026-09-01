<template lang='pug'>
  v-container.admin-system(fluid)
    v-row
      v-col(cols='12')
        AdminHero(
          :title='$t(`admin:system.title`)'
          :description='$t(`admin:system.subtitle`)'
          icon='/_assets/svg/icon-tune.svg'
          heading-id='admin-system-heading'
        )
          template(v-slot:actions)
            v-btn(
              variant="outlined"
              color='primary'
              size="small"
              @click='refresh'
              :loading='loading'
            )
              v-icon(start) mdi-refresh
              span Refresh
        async-state(
          v-if='loading'
          state='loading'
          title='Loading system information'
          message='Fetching product, host, and runtime diagnostics.'
        )
        async-state(
          v-else-if='errorMessage'
          state='error'
          title='System information could not be loaded'
          :message='errorMessage'
          retry-label='Try again'
          @retry='loadInfo'
        )
        v-row.mt-3(v-else-if='infoLoaded')
          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp
              v-card-title.text-title-medium {{ info.product.name }}
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-source-fork
                  v-list-item-title Product Version
                  v-list-item-subtitle.system-value {{ info.product.version }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-source-branch
                  v-list-item-title Build Revision
                  v-list-item-subtitle.system-value.system-mono
                    a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') {{ info.product.revision }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-call-merge
                  v-list-item-title Upstream Base
                  v-list-item-subtitle.system-value.system-mono {{ info.product.upstreamBase }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-update
                  v-list-item-title Preview Update Checks
                  v-list-item-subtitle
                    v-chip(size='small', variant='tonal', color='info') Unavailable
                    .text-body-small.text-medium-emphasis.mt-1 No fork-owned update provider is configured
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-code-tags
                  v-list-item-title Source Code
                  v-list-item-subtitle.system-value
                    a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') Exact deployed revision

          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp.wait-p2s
              v-card-title.text-title-medium {{ $t('admin:system.hostInfo') }}
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') {{platformLogo}}
                  v-list-item-title {{ $t('admin:system.os') }}
                  v-list-item-subtitle.system-value {{ (info.platform === 'docker') ? 'Docker Container (Linux)' : info.operatingSystem }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-desktop-classic
                  v-list-item-title {{ $t('admin:system.hostname') }}
                  v-list-item-subtitle.system-value.system-mono {{ info.hostname }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-cpu-64-bit
                  v-list-item-title {{ $t('admin:system.cpuCores') }}
                  v-list-item-subtitle.system-value {{ info.cpuCores }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-memory
                  v-list-item-title {{ $t('admin:system.totalRAM') }}
                  v-list-item-subtitle.system-value {{ info.ramTotal }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-iframe-outline
                  v-list-item-title {{ $t('admin:system.workingDirectory') }}
                  v-list-item-subtitle.system-value.system-mono {{ info.workingDirectory }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-card-bulleted-settings-outline
                  v-list-item-title {{ $t('admin:system.configFile') }}
                  v-list-item-subtitle.system-value.system-mono {{ info.configFile }}

          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp
              v-card-title.text-title-medium Runtime
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-lightning-bolt
                  v-list-item-title Version
                  v-list-item-subtitle.system-value.system-mono {{ info.bunVersion }}

          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp.wait-p2s
              v-card-title.text-title-medium {{ info.dbType }}
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-database
                  v-list-item-title Version
                  v-list-item-subtitle.system-value.system-mono {{ info.dbVersion }}
                v-list-item
                  template(v-slot:prepend): v-icon.text-medium-emphasis(size='20') mdi-server-outline
                  v-list-item-title Host
                  v-list-item-subtitle.system-value.system-mono {{ info.dbHost }}
</template>

<script lang='ts'>

import AsyncState from '@/components/common/async-state.vue'
import { wikiStore } from '@/store/index.ts'

import { fetchSystemInfo } from '../../helpers/system-api'
import type { SystemInfo } from '../../helpers/system-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const makeDefaultSystemInfo = (): SystemInfo => ({
  product: siteConfig.product,
  currentVersion: siteConfig.product.version,
  latestVersion: null,
  latestVersionReleaseDate: null,
  updateStatus: 'unavailable',
  groupsTotal: 0,
  pagesTotal: 0,
  usersTotal: 0,
  tagsTotal: 0,
  configFile: '',
  cpuCores: 0,
  dbHost: '',
  dbType: '',
  dbVersion: '',
  hostname: '',
  bunVersion: '',
  operatingSystem: '',
  platform: '',
  ramTotal: '',
  upgradeCapable: false,
  workingDirectory: ''
})
export default {
  components: {
    AsyncState
  },
  data () {
    return {
      info: makeDefaultSystemInfo(),
      loading: false,
      infoLoaded: false,
      errorMessage: ''
    }
  },
  computed: {
    platformLogo () {
      switch (this.info.platform) {
        case 'docker':
          return 'mdi-docker'
        case 'darwin':
          return 'mdi-apple'
        case 'linux':
          if (this.info.operatingSystem.indexOf('Ubuntu') >= 0) {
            return 'mdi-ubuntu'
          } else {
            return 'mdi-linux'
          }
        case 'win32':
          return 'mdi-microsoft-windows'
        default:
          return ''
      }
    }
  },
  methods: {
    async loadInfo () {
      this.loading = true
      this.errorMessage = ''
      this.infoLoaded = false
      loadingStart(wikiStore, 'admin-system-refresh')
      try {
        this.info = await fetchSystemInfo(window.fetch.bind(window), 'System info response is invalid')
        this.infoLoaded = true
        return true
      } catch (err) {
        this.errorMessage = getErrorMessage(err)
        pushGraphError(wikiStore, err)
        return false
      } finally {
        this.loading = false
        loadingStop(wikiStore, 'admin-system-refresh')
      }
    },
    async refresh () {
      const loaded = await this.loadInfo()
      if (!loaded) {
        return false
      }
      showNotification(wikiStore, {
        message: this.$t('admin:system.refreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
      return true
    }
  },
  created () {
    this.loadInfo()
  }
}
</script>

<style lang='scss'>
.admin-system {
  .v-list-item-title,
  .v-list-item-subtitle {
    min-width: 0;
    user-select: text;
  }

  .system-value {
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .system-mono {
    font-family: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
}
</style>

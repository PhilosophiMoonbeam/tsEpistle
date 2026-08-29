<template lang='pug'>
  v-container.admin-system(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-tune.svg', alt='System Info', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:system.title') }}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p2s {{ $t('admin:system.subtitle') }}
        v-row.mt-3
          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp
              v-btn.animated.fadeInLeft.wait-p2s.btn-animate-rotate(icon, absolute, location='top end', size="small", @click='refresh'): v-icon(color='grey') mdi-refresh
              v-list-subheader {{ info.product.name }}
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-indigo.text-white mdi-source-fork
                  v-list-item-title Product Version
                  v-list-item-subtitle {{ info.product.version }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-source-branch
                  v-list-item-title Build Revision
                  v-list-item-subtitle
                    a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') {{ info.product.revision }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-call-merge
                  v-list-item-title Upstream Base
                  v-list-item-subtitle {{ info.product.upstreamBase }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-update
                  v-list-item-title Preview Update Checks
                  v-list-item-subtitle Unavailable — no fork-owned update provider is configured
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-code-tags
                  v-list-item-title Source Code
                  v-list-item-subtitle
                    a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') Exact deployed revision

            v-card.mt-4.animated.fadeInUp.wait-p2s
              v-list-subheader {{ $t('admin:system.hostInfo') }}
              v-list(lines="two", density="compact")
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-avatar.bg-blue-grey(size='40')
                        v-icon(color='white') {{platformLogo}}
                  v-list-item-title {{ $t('admin:system.os') }}
                  v-list-item-subtitle {{ (info.platform === 'docker') ? 'Docker Container (Linux)' : info.operatingSystem }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-desktop-classic
                  v-list-item-title {{ $t('admin:system.hostname') }}
                  v-list-item-subtitle {{ info.hostname }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-cpu-64-bit
                  v-list-item-title {{ $t('admin:system.cpuCores') }}
                  v-list-item-subtitle {{ info.cpuCores }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-memory
                  v-list-item-title {{ $t('admin:system.totalRAM') }}
                  v-list-item-subtitle {{ info.ramTotal }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-iframe-outline
                  v-list-item-title {{ $t('admin:system.workingDirectory') }}
                  v-list-item-subtitle {{ info.workingDirectory }}
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-icon.bg-blue-grey.text-white mdi-card-bulleted-settings-outline
                  v-list-item-title {{ $t('admin:system.configFile') }}
                  v-list-item-subtitle {{ info.configFile }}

          v-col(lg='6' cols='12')
            v-card.pb-3.animated.fadeInUp.wait-p4s
              v-list-subheader Bun
              v-list(density="compact")
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-avatar.bg-light-green(size='40')
                        v-icon(color='white') mdi-lightning-bolt
                  v-list-item-title {{ info.bunVersion }}

              v-divider.mt-3
              v-list-subheader {{ info.dbType }}
              v-list(density="compact")
                v-list-item
                  template(v-slot:prepend)
                    v-avatar
                      v-avatar.bg-indigo-darken-1(size='40')
                        v-icon(color='white') mdi-database
                  v-list-item-title(style='white-space: pre-line') {{ info.dbVersion }}
                  v-list-item-subtitle {{ info.dbHost }}

</template>

<script lang='ts'>

import { wikiStore } from '@/store/index.ts'

import { fetchSystemInfo } from '../../helpers/system-api'
import type { SystemInfo } from '../../helpers/system-api'
import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

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
  data () {
    return {
      info: makeDefaultSystemInfo()
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
          if (this.info.operatingSystem.indexOf('Ubuntu')) {
            return 'mdi-ubuntu'
          } else {
            return 'mdi-linux'
          }
        case 'win32':
          return 'mdi-microsoft-windows'
        default:
          return ''
      }
    },
  },
  methods: {
    async loadInfo () {
      loadingStart(wikiStore, 'admin-system-refresh')
      try {
        this.info = await fetchSystemInfo(window.fetch.bind(window), 'System info response is invalid')
        return true
      } catch (err) {
        pushGraphError(wikiStore, err)
        return false
      } finally {
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
  .v-list-item-title, .v-list-item-subtitle {
    user-select: text;
  }
}
</style>

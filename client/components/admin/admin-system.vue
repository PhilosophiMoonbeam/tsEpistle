<template lang='pug'>
  v-container.admin-system(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-tune.svg', alt='System Info', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{ $t('admin:system.title') }}
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s {{ $t('admin:system.subtitle') }}
        v-row.mt-3
          v-col(lg='6' cols='12')
            v-card.animated.fadeInUp
              v-btn.animated.fadeInLeft.wait-p2s.btn-animate-rotate(fab, absolute, :right='!$vuetify.locale.isRtl', :left='$vuetify.locale.isRtl', top, small, light, @click='refresh'): v-icon(color='grey') mdi-refresh
              v-list-subheader {{ info.product.name }}
              v-list(two-line, dense)
                v-list-item
                  v-avatar
                    v-icon.indigo.white--text mdi-source-fork
                  div.v-list-item-content
                    v-list-item-title Product Version
                    v-list-item-subtitle {{ info.product.version }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-source-branch
                  div.v-list-item-content
                    v-list-item-title Build Revision
                    v-list-item-subtitle
                      a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') {{ info.product.revision }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-call-merge
                  div.v-list-item-content
                    v-list-item-title Upstream Base
                    v-list-item-subtitle {{ info.product.upstreamBase }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-update
                  div.v-list-item-content
                    v-list-item-title Preview Update Checks
                    v-list-item-subtitle Unavailable — no fork-owned update provider is configured
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-code-tags
                  div.v-list-item-content
                    v-list-item-title Source Code
                    v-list-item-subtitle
                      a(:href='info.product.sourceUrl', target='_blank', rel='noopener noreferrer') Exact deployed revision

            v-card.mt-4.animated.fadeInUp.wait-p2s
              v-list-subheader {{ $t('admin:system.hostInfo') }}
              v-list(two-line, dense)
                v-list-item
                  v-avatar
                    v-avatar.blue-grey(size='40')
                      v-icon(color='white') {{platformLogo}}
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.os') }}
                    v-list-item-subtitle {{ (info.platform === 'docker') ? 'Docker Container (Linux)' : info.operatingSystem }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-desktop-classic
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.hostname') }}
                    v-list-item-subtitle {{ info.hostname }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-cpu-64-bit
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.cpuCores') }}
                    v-list-item-subtitle {{ info.cpuCores }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-memory
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.totalRAM') }}
                    v-list-item-subtitle {{ info.ramTotal }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-iframe-outline
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.workingDirectory') }}
                    v-list-item-subtitle {{ info.workingDirectory }}
                v-list-item
                  v-avatar
                    v-icon.blue-grey.white--text mdi-card-bulleted-settings-outline
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.configFile') }}
                    v-list-item-subtitle {{ info.configFile }}

          v-col(lg='6' cols='12')
            v-card.pb-3.animated.fadeInUp.wait-p4s
              v-list-subheader Node.js
              v-list(dense)
                v-list-item
                  v-avatar
                    v-avatar.light-green(size='40')
                      v-icon(color='white') mdi-nodejs
                  div.v-list-item-content
                    v-list-item-title {{ info.nodeVersion }}

              v-divider.mt-3
              v-list-subheader {{ info.dbType }}
              v-list(dense)
                v-list-item
                  v-avatar
                    v-avatar.indigo.darken-1(size='40')
                      v-icon(color='white') mdi-database
                  div.v-list-item-content
                    v-list-item-title(v-html='dbVersion')
                    v-list-item-subtitle {{ info.dbHost }}


</template>

<script lang='ts'>
import _ from 'lodash'

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
  nodeVersion: '',
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
    dbVersion () {
      return _.get(this.info, 'dbVersion', '').replace(/(?:\r\n|\r|\n)/g, '<br />')
    },
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
  .v-list-item-title, .v-list-item__subtitle {
    user-select: text;
  }
}
</style>

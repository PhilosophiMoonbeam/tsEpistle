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
              v-list-subheader Wiki.js
              v-list(two-line, dense)
                v-list-item
                  v-avatar
                    v-icon.blue.white--text mdi-application-export
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.currentVersion') }}
                    v-list-item-subtitle {{ info.currentVersion }}
                v-list-item
                  v-avatar
                    v-icon.blue.white--text mdi-inbox-arrow-up
                  div.v-list-item-content
                    v-list-item-title {{ $t('admin:system.latestVersion') }}
                    v-list-item-subtitle {{ info.latestVersion }}
                  div.v-list-item-action
                    span.v-list-item-action-text {{ $t('admin:system.published') }} {{ $helpers.formatMoment(info.latestVersionReleaseDate, 'from') }}
              v-card-actions(v-if='info.upgradeCapable && !isLatestVersion && info.platform === `docker`', :class='$vuetify.theme.current.dark ? `grey darken-3-d5` : `indigo lighten-5`')
                .caption.indigo--text.pl-3(:class='$vuetify.theme.current.dark ? `text--lighten-4` : ``') Wiki.js can perform the upgrade to the latest version for you.
                v-spacer
                v-btn.px-3(
                  color='indigo'
                  dark
                  @click='performUpgrade'
                  )
                  v-icon(left) mdi-upload
                  span Perform Upgrade

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

                v-alert.mt-3.mx-4(:value='isDbLimited', color='deep-orange darken-2', icon='mdi-alert', dark) {{ $t('admin:system.dbPartialSupport') }}

    v-dialog(
      v-model='isUpgrading'
      persistent
      width='450'
      )
      v-card.blue.darken-5(dark)
        v-card-text.text-center.pa-10
          self-building-square-spinner(
            :animation-duration='4000'
            :size='40'
            color='#FFF'
            style='margin: 0 auto;'
            )
          .body-2.mt-5.blue--text.text--lighten-4 Your Wiki.js container is being upgraded...
          .caption.blue--text.text--lighten-2 Please wait
          v-progress-linear.mt-5(
            color='blue lighten-2'
            :value='upgradeProgress'
            :buffer-value='upgradeProgress'
            rounded
            :stream='isUpgradingStarted'
            query
            :indeterminate='!isUpgradingStarted'
          )
</template>

<script lang='ts'>
import _ from 'lodash'

import { SelfBuildingSquareSpinner } from 'epic-spinners'
import { wikiStore } from '@/store/index.ts'

import { fetchSystemInfo, performSystemUpgrade } from '../../helpers/system-api'
import type { SystemInfo } from '../../helpers/system-api'
import { loadingStart, loadingStop, showNotification, pushGraphError } from '../../helpers/root-ui-store'

const makeDefaultSystemInfo = (): SystemInfo => ({
  configFile: '',
  cpuCores: 0,
  currentVersion: '',
  dbHost: '',
  dbType: '',
  dbVersion: '',
  hostname: '',
  latestVersion: '',
  latestVersionReleaseDate: null,
  nodeVersion: '',
  operatingSystem: '',
  platform: '',
  ramTotal: '',
  upgradeCapable: false,
  workingDirectory: ''
})

export default {
  components: {
    SelfBuildingSquareSpinner
  },
  data () {
    return {
      isUpgrading: false,
      isUpgradingStarted: false,
      upgradeProgress: 0,
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
    isDbLimited () {
      return this.info.dbType === 'MySQL' && this.dbVersion.indexOf('5.') === 0
    },
    isLatestVersion () {
      return this.info.currentVersion === this.info.latestVersion
    }
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
    },
    async performUpgrade () {
      this.isUpgrading = true
      this.isUpgradingStarted = false
      this.upgradeProgress = 0
      loadingStart(wikiStore, 'admin-system-upgrade')
      try {
        await performSystemUpgrade(window.fetch.bind(window), 'Upgrade failed')
        this.isUpgradingStarted = true
        const progressInterval: ReturnType<typeof setInterval> = setInterval(() => {
          this.upgradeProgress += 0.83
        }, 500)
        _.delay(() => {
          clearInterval(progressInterval)
          window.location.reload()
        }, 60000)
      } catch (err) {
        pushGraphError(wikiStore, err)
        loadingStop(wikiStore, 'admin-system-upgrade')
        this.isUpgrading = false
      }
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

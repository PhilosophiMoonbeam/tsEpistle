<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row()
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-rest-api.svg', alt='API', style='width: 80px;')
          .admin-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('admin:api.title')}}
            .subtitle-1.grey--text.animated.fadeInLeft {{$t('admin:api.subtitle')}}
          v-spacer
          template(v-if='enabled')
            status-indicator.mr-3(positive, pulse)
            .caption.green--text.animated.fadeInLeft {{$t('admin:api.enabled')}}
          template(v-else)
            status-indicator.mr-3(negative, pulse)
            .caption.red--text.animated.fadeInLeft {{$t('admin:api.disabled')}}
          v-spacer
          v-btn.mr-3.animated.fadeInDown.wait-p2s(outlined, color='grey', icon, @click='refresh')
            v-icon mdi-refresh
          v-btn.mr-3.animated.fadeInDown.wait-p1s(:color='enabled ? `red` : `green`', depressed, @click='globalSwitch', dark, :loading='isToggleLoading')
            v-icon(left) mdi-power
            span(v-if='!enabled') {{$t('admin:api.enableButton')}}
            span(v-else) {{$t('admin:api.disableButton')}}
          v-btn.animated.fadeInDown(color='primary', depressed, large, @click='newKey', dark)
            v-icon(left) mdi-plus
            span {{$t('admin:api.newKeyButton')}}
        v-card.mt-3.animated.fadeInUp
          v-table(v-if='keys && keys.length > 0')
            template(v-slot:default)
              thead
                tr.grey(:class='$vuetify.theme.current.dark ? `darken-4-d5` : `lighten-5`')
                  th {{$t('admin:api.headerName')}}
                  th {{$t('admin:api.headerKeyEnding')}}
                  th {{$t('admin:api.headerExpiration')}}
                  th {{$t('admin:api.headerCreated')}}
                  th {{$t('admin:api.headerLastUpdated')}}
                  th(width='100') {{$t('admin:api.headerRevoke')}}
              tbody
                tr(v-for='key of keys', :key='`key-` + key.id')
                  td
                    strong(:class='key.isRevoked ? `red--text` : ``') {{ key.name }}
                    em.caption.ml-1.red--text(v-if='key.isRevoked') (revoked)
                  td.caption {{ key.keyShort }}
                  td(:style='key.isRevoked ? `text-decoration: line-through;` : ``') {{ $helpers.formatMoment(key.expiration, 'LL') }}
                  td {{ $helpers.formatMoment(key.createdAt, 'calendar') }}
                  td {{ $helpers.formatMoment(key.updatedAt, 'calendar') }}
                  td: v-btn(icon, @click='revoke(key)', :disabled='key.isRevoked'): v-icon(color='error') mdi-cancel
          v-card-text(v-else)
            v-alert.mb-0(icon='mdi-information', :value='true', outlined, color='info') {{$t('admin:api.noKeyInfo')}}

    create-api-key(v-model='isCreateDialogShown', :refresh-api-keys='refresh')

    v-dialog(v-model='isRevokeConfirmDialogShown', max-width='500', persistent)
      v-card
        .dialog-header.is-red {{$t('admin:api.revokeConfirm')}}
        v-card-text.pa-4
          i18next(tag='span', path='admin:api.revokeConfirmText')
            strong(place='name') {{ current.name }}
        v-card-actions
          v-spacer
          v-btn(text, @click='isRevokeConfirmDialogShown = false', :disabled='revokeLoading') {{$t('common:actions.cancel')}}
          v-btn(color='red', dark, @click='revokeConfirm', :loading='revokeLoading') {{$t('admin:api.revoke')}}
</template>

<script lang='ts'>
import StatusIndicator from '@/components/common/status-indicator.vue'
import { wikiStore } from '@/store/index.ts'

import CreateApiKey from './admin-api-create.vue'
import { fetchAdminApiBootstrap, revokeAdminApiKey, setAdminApiState, type AdminApiKey } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'

export default {
  components: {
    StatusIndicator,
    CreateApiKey
  },
  data() {
    return {
      enabled: false,
      isToggleLoading: false,
      keys: [] as AdminApiKey[],
      isCreateDialogShown: false,
      isRevokeConfirmDialogShown: false,
      revokeLoading: false,
      current: null as AdminApiKey | null
    }
  },
  methods: {
    async loadApiBootstrap () {
      wikiStore.startLoading('admin-api-state-refresh')
      wikiStore.startLoading('admin-api-keys-refresh')
      try {
        const bootstrap = await fetchAdminApiBootstrap(window.fetch.bind(window), 'Admin API bootstrap response is invalid')
        this.enabled = bootstrap.enabled
        this.keys = bootstrap.keys
        return true
      } catch (err) {
        this.enabled = false
        this.keys = []
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
        return false
      } finally {
        wikiStore.stopLoading('admin-api-state-refresh')
        wikiStore.stopLoading('admin-api-keys-refresh')
      }
    },
    async refresh (notify = true) {
      const loaded = await this.loadApiBootstrap()
      if (notify && loaded) {
        wikiStore.showNotification({
          message: this.$t('admin:api.refreshSuccess'),
          style: 'success',
          icon: 'cached'
        })
      }
      return loaded
    },
    async globalSwitch () {
      const wasEnabled = this.enabled
      this.isToggleLoading = true
      wikiStore.startLoading('admin-api-toggle')
      try {
        await setAdminApiState(window.fetch.bind(window), !this.enabled)
        const loaded = await this.refresh(false)
        if (loaded) {
          wikiStore.showNotification({
            style: 'success',
            message: wasEnabled ? this.$t('admin:api.toggleStateDisabledSuccess') : this.$t('admin:api.toggleStateEnabledSuccess'),
            icon: 'check'
          })
        }
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-toggle')
        this.isToggleLoading = false
      }
    },
    async newKey () {
      this.isCreateDialogShown = true
    },
    revoke (key: AdminApiKey) {
      this.current = key
      this.isRevokeConfirmDialogShown = true
    },
    async revokeConfirm () {
      this.revokeLoading = true
      wikiStore.startLoading('admin-api-revoke')
      try {
        if (!this.current) throw new Error('No API key selected for revocation.')
        await revokeAdminApiKey(window.fetch.bind(window), this.current.id)
        const loaded = await this.refresh(false)
        if (loaded) {
          wikiStore.showNotification({
            style: 'success',
            message: this.$t('admin:api.revokeSuccess'),
            icon: 'check'
          })
        }
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-api-revoke')
        this.isRevokeConfirmDialogShown = false
        this.revokeLoading = false
      }
    }
  },
  created () {
    this.loadApiBootstrap()
  }
}
</script>

<style lang='scss'>

</style>

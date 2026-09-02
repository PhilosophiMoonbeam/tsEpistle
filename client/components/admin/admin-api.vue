<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t(`admin:api.title`)'
          :description='$t(`admin:api.subtitle`)'
          icon='/_assets/svg/icon-rest-api.svg'
        )
          template(v-slot:status)
            .admin-api-status.d-flex.align-center
              v-chip(v-if='loadState === `success`', label, size="small", :color='enabled ? `success` : `warning`')
                v-icon(start, size="small") {{ enabled ? 'mdi-check-circle' : 'mdi-api-off' }}
                span {{ enabled ? $t('admin:api.enabled') : $t('admin:api.disabled') }}
              v-chip(v-else-if='loadState === `error`', label, size="small", color='error')
                v-icon(start, size="small") mdi-alert
                span Unable to load status
          template(v-slot:actions)
            .admin-api-actions.d-flex.align-center.flex-wrap.ga-2
              v-btn(variant="outlined", color='grey', icon, @click='refresh', :loading='loadState === `loading`', :disabled='adminApiBusy', aria-label='Refresh API status')
                v-icon mdi-refresh
              v-btn(v-if='loadState === `success` && enabled', variant="outlined", color='error', @click='disableDialog = true', :loading='isToggleLoading', :disabled='adminApiBusy')
                v-icon(start) mdi-power
                span {{$t('admin:api.disableButton')}}
              v-btn(v-else-if='loadState === `success`', variant="outlined", color='success', @click='globalSwitch', :loading='isToggleLoading', :disabled='adminApiBusy')
                v-icon(start) mdi-power
                span {{$t('admin:api.enableButton')}}
              v-btn(color='primary', variant="flat", size="large", @click='newKey', :disabled='loadState !== `success` || adminApiBusy')
                v-icon(start) mdi-plus
                span {{$t('admin:api.newKeyButton')}}
        v-alert.mt-3(
          v-if='loadState === `success` && !enabled'
          type='warning'
          variant='tonal'
          icon='mdi-api-off'
        )
          | API-key requests are currently disabled. Existing keys remain stored and can be managed below.
        v-card.mt-3.animated.fadeInUp
          v-card-title.d-flex.align-center.flex-wrap.ga-2
            v-icon.mr-2(color='primary') mdi-key-chain
            span API keys
            v-spacer
            v-chip(v-if='loadState === `success`', label, size="small", :color='keys.length ? `success` : `info`') {{ keys.length ? `${keys.length} active` : 'No keys' }}
          v-divider
          v-skeleton-loader(v-if='loadState === `loading`', type='table-tbody')
          v-alert.ma-4(v-else-if='loadState === `error`', type='error', variant="tonal", icon='mdi-alert')
            span Unable to load API keys.
            v-btn.ml-2(variant="text", size="small", @click='refresh') Retry
          template(v-else)
            v-table.api-key-desktop(v-if='keys.length > 0')
              template(v-slot:default)
                thead
                  tr(:class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-5`')
                    th {{$t('admin:api.headerName')}}
                    th {{$t('admin:api.headerKeyEnding')}}
                    th {{$t('admin:api.headerExpiration')}}
                    th {{$t('admin:api.headerCreated')}}
                    th {{$t('admin:api.headerLastUpdated')}}
                    th(width='100') {{$t('admin:api.headerRevoke')}}
                tbody
                  tr(v-for='key of keys', :key='`key-` + key.id')
                    td
                      strong(:class='key.isRevoked ? `text-red` : ``') {{ key.name }}
                      em.text-body-small.ml-1.text-red(v-if='key.isRevoked') (revoked)
                    td.text-body-small {{ key.keyShort }}
                    td(:style='key.isRevoked ? `text-decoration: line-through;` : ``') {{ $helpers.formatMoment(key.expiration, 'LL') }}
                    td {{ $helpers.formatMoment(key.createdAt, 'calendar') }}
                    td {{ $helpers.formatMoment(key.updatedAt, 'calendar') }}
                    td
                      v-btn(icon, @click='revoke(key)', :disabled='key.isRevoked || adminApiBusy', :aria-label='`Revoke ${key.name}`')
                        v-icon(color='error') mdi-cancel
            div.api-key-mobile(v-if='keys.length > 0')
              .admin-mobile-record(v-for='key of keys', :key='`mobile-key-` + key.id')
                .d-flex.align-center
                  .admin-mobile-record-title(:class='key.isRevoked ? `text-red` : ``') {{ key.name }}
                  v-spacer
                  v-chip(label, size="x-small", :color='key.isRevoked ? `error` : `success`') {{ key.isRevoked ? 'Revoked' : 'Active' }}
                .admin-mobile-record-meta {{ key.keyShort }}
                .text-body-small.text-grey.mt-2 Expires {{ $helpers.formatMoment(key.expiration, 'LL') }}
                .text-body-small.text-grey Updated {{ $helpers.formatMoment(key.updatedAt, 'calendar') }}
                v-btn.mt-2(v-if='!key.isRevoked', variant="outlined", size="small", color='error', @click='revoke(key)', :disabled='adminApiBusy', :aria-label='`Revoke ${key.name}`')
                  v-icon(start) mdi-cancel
                  span {{$t('admin:api.revoke')}}
            v-card-text(v-if='!keys.length')
              v-alert.mb-0(icon='mdi-information', :model-value='true', variant="outlined", color='info') {{$t('admin:api.noKeyInfo')}}
        v-card.mt-3.animated.fadeInUp
          v-card-title.d-flex.align-center.flex-wrap.ga-2
            v-icon.mr-2(color='primary') mdi-book-open-variant
            span Integration reference
            v-spacer
            v-chip(label, size="small", color='success') Stable compatibility surface
          v-divider
          v-row.ma-0
            v-col(cols='12', lg='7')
              v-card-text
                p tsFranki supports API-key integrations through GraphQL and the versioned REST v1 API.
                .text-label-small GraphQL endpoint
                code.api-contract-code {{ graphqlEndpoint }}
                .text-label-small.mt-4 Authentication
                p Send the generated key as an HTTP bearer token:
                code.api-contract-code Authorization: {{ apiAccessContract.bearerScheme }} &lt;API_KEY&gt;
                .text-label-small.mt-4 Full-access key example
                pre.api-contract-example {{ curlExample }}
                .text-label-small.mt-4 REST v1 endpoint
                code.api-contract-code {{ externalRestEndpoint }}
                .text-label-small.mt-4 OpenAPI 3.1 contract
                code.api-contract-code {{ openApiEndpoint }}
            v-col(cols='12', lg='5')
              v-card-text
                .text-label-small Internal REST transport
                code.api-contract-code {{ internalRestEndpoint }}
                p.mt-4 The REST routes under this prefix are application-internal and are not a public integration contract. API keys are rejected; signed-in user sessions are required.
                v-divider.my-4
                .text-label-small Permission scopes
                p.mb-2 #[strong Full access] uses the system-administrator permissions.
                p.mb-0 #[strong Group scoped] uses the selected group's permissions. GraphQL directives and REST handlers enforce every operation's required permissions and page rules.

    create-api-key(v-model='isCreateDialogShown', :refresh-api-keys='refresh')

    v-dialog(v-model='isRevokeConfirmDialogShown', max-width='500', persistent, aria-labelledby='revoke-api-key-dialog-title')
      v-card
        .dialog-header.is-red
          span#revoke-api-key-dialog-title {{$t('admin:api.revokeConfirm')}}
        v-card-text.pa-4
          i18next(tag='span', path='admin:api.revokeConfirmText')
            strong(place='name') {{ current ? current.name : '' }}
        v-card-actions
          v-spacer
          v-btn(variant="text", @click='isRevokeConfirmDialogShown = false', :disabled='revokeLoading') {{$t('common:actions.cancel')}}
          v-btn(color='red', @click='revokeConfirm', :loading='revokeLoading', :disabled='revokeLoading') {{$t('admin:api.revoke')}}
    v-dialog(v-model='disableDialog', max-width='500', persistent, aria-labelledby='disable-api-access-dialog-title')
      v-card
        .dialog-header.is-red
          span#disable-api-access-dialog-title Disable API-key access?
        v-card-text.pa-4 Existing API keys remain stored, but all API-key requests will stop until access is enabled again. Continue?
        v-card-actions
          v-spacer
          v-btn(variant="text", @click='disableDialog = false', :disabled='isToggleLoading') {{$t('common:actions.cancel')}}
          v-btn(color='error', @click='disableApi', :loading='isToggleLoading', :disabled='isToggleLoading') Disable API access
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'

import CreateApiKey from './admin-api-create.vue'
import { fetchAdminApiBootstrap, revokeAdminApiKey, setAdminApiState, type AdminApiKey } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { apiAccessContract } from '../../../shared/api-access.ts'

export default {
  components: {
    CreateApiKey
  },
  data() {
    return {
      enabled: false,
      isToggleLoading: false,
      keys: [] as AdminApiKey[],
      loadState: 'loading' as 'loading' | 'success' | 'error',
      isCreateDialogShown: false,
      isRevokeConfirmDialogShown: false,
      disableDialog: false,
      revokeLoading: false,
      current: null as AdminApiKey | null
    }
  },
  computed: {
    adminApiBusy(): boolean {
      return this.loadState === 'loading' || this.isToggleLoading || this.revokeLoading
    },
    apiAccessContract() {
      return apiAccessContract
    },
    graphqlEndpoint() {
      return `${window.location.origin}${apiAccessContract.graphqlPath}`
    },
    externalRestEndpoint() {
      return `${window.location.origin}${apiAccessContract.externalRestPrefix}`
    },
    openApiEndpoint() {
      return `${window.location.origin}${apiAccessContract.openApiPath}`
    },
    internalRestEndpoint() {
      return `${window.location.origin}${apiAccessContract.internalRestPrefix}/*`
    },
    curlExample() {
      return [
        `curl --request POST '${this.graphqlEndpoint}' \\`,
        `  --header 'Authorization: ${apiAccessContract.bearerScheme} <API_KEY>' \\`,
        "  --header 'Content-Type: application/json' \\",
        "  --data '{\"query\":\"query { system { info { currentVersion product { name version } } } }\"}'"
      ].join('\n')
    }
  },
  methods: {
    async loadApiBootstrap () {
      this.loadState = 'loading'
      wikiStore.startLoading('admin-api-state-refresh')
      wikiStore.startLoading('admin-api-keys-refresh')
      try {
        const bootstrap = await fetchAdminApiBootstrap(window.fetch.bind(window), 'Admin API bootstrap response is invalid')
        this.enabled = bootstrap.enabled
        this.keys = bootstrap.keys
        this.loadState = 'success'
        return true
      } catch (err) {
        this.loadState = 'error'
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
      if (this.loadState === 'loading') return false
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
      if (this.isToggleLoading || this.revokeLoading || this.loadState !== 'success') return
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
    async disableApi () {
      this.disableDialog = false
      await this.globalSwitch()
    },
    newKey () {
      if (this.adminApiBusy) return
      this.isCreateDialogShown = true
    },
    revoke (key: AdminApiKey) {
      if (this.adminApiBusy || key.isRevoked) return
      this.current = key
      this.isRevokeConfirmDialogShown = true
    },
    async revokeConfirm () {
      if (this.revokeLoading || !this.current) return
      this.revokeLoading = true
      wikiStore.startLoading('admin-api-revoke')
      try {
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
.api-contract-code {
  display: block;
  overflow-wrap: anywhere;
}

.api-contract-example {
  margin: 0;
  overflow-x: auto;
  padding: 1rem;
  white-space: pre;
}
.api-key-mobile {
  display: none;
}

@media (max-width: 959px) {
  .api-key-desktop {
    display: none;
  }

  .api-key-mobile {
    display: block;
  }

  .admin-api-status,
  .admin-api-actions {
    flex-basis: 100%;
  }

  .admin-api-actions .v-btn:last-child {
    flex: 1;
  }
}
</style>

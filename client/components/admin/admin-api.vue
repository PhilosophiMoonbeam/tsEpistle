<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-rest-api.svg', alt='API', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{$t('admin:api.title')}}
            .text-body-large.text-grey.animated.fadeInLeft {{$t('admin:api.subtitle')}}
          v-spacer
          template(v-if='enabled')
            status-indicator.mr-3(positive, pulse)
            .text-body-small.text-green.animated.fadeInLeft {{$t('admin:api.enabled')}}
          template(v-else)
            status-indicator.mr-3(negative, pulse)
            .text-body-small.text-red.animated.fadeInLeft {{$t('admin:api.disabled')}}
          v-spacer
          v-btn.mr-3.animated.fadeInDown.wait-p2s(variant="outlined", color='grey', icon, @click='refresh')
            v-icon mdi-refresh
          v-btn.mr-3.animated.fadeInDown.wait-p1s(:color='enabled ? `red` : `green`', variant="flat", @click='globalSwitch', :loading='isToggleLoading')
            v-icon(start) mdi-power
            span(v-if='!enabled') {{$t('admin:api.enableButton')}}
            span(v-else) {{$t('admin:api.disableButton')}}
          v-btn.animated.fadeInDown(color='primary', variant="flat", size="large", @click='newKey')
            v-icon(start) mdi-plus
            span {{$t('admin:api.newKeyButton')}}
        v-alert.mt-3(
          v-if='!enabled'
          type='warning'
          variant='tonal'
          icon='mdi-api-off'
        )
          strong API-key access is disabled.
          span.ml-1 Enable it before using a generated key. Signed-in browser sessions and internal application requests are unaffected.
        v-row.mt-1
          v-col(cols='12', lg='7')
            v-card.fill-height(border)
              v-card-title
                v-icon.mr-2(color='primary') mdi-graphql
                span Supported external APIs
                v-spacer
                v-chip(label, size="small", color='success').text-white Stable compatibility surface
              v-divider
              v-card-text
                p Wiki.ts Preview supports API-key integrations through GraphQL and the versioned REST v1 API.
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
            v-card.fill-height(border)
              v-card-title
                v-icon.mr-2(color='warning') mdi-shield-lock-outline
                span Internal REST transport
                v-spacer
                v-chip(label, size="small", color='warning') Session only
              v-divider
              v-card-text
                code.api-contract-code {{ internalRestEndpoint }}
                p.mt-4 The REST routes under this prefix are application-internal and are not a public integration contract. API keys are rejected; signed-in user sessions are required.
                v-divider.my-4
                .text-label-small Permission scopes
                p.mb-2 #[strong Full access] uses the system-administrator permissions.
                p.mb-0 #[strong Group scoped] uses the selected group's permissions. GraphQL directives and REST handlers enforce every operation's required permissions and page rules.

        v-card.mt-3.animated.fadeInUp
          v-table(v-if='keys && keys.length > 0')
            template(v-slot:default)
              thead
                tr(:class='$vuetify.theme.current.dark ? `bg-grey-darken-4-d5` : `bg-grey-lighten-5`')
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
                  td: v-btn(icon, @click='revoke(key)', :disabled='key.isRevoked'): v-icon(color='error') mdi-cancel
          v-card-text(v-else)
            v-alert.mb-0(icon='mdi-information', :value='true', variant="outlined", color='info') {{$t('admin:api.noKeyInfo')}}

    create-api-key(v-model='isCreateDialogShown', :refresh-api-keys='refresh')

    v-dialog(v-model='isRevokeConfirmDialogShown', max-width='500', persistent)
      v-card
        .dialog-header.is-red {{$t('admin:api.revokeConfirm')}}
        v-card-text.pa-4
          i18next(tag='span', path='admin:api.revokeConfirmText')
            strong(place='name') {{ current.name }}
        v-card-actions
          v-spacer
          v-btn(variant="text", @click='isRevokeConfirmDialogShown = false', :disabled='revokeLoading') {{$t('common:actions.cancel')}}
          v-btn(color='red', @click='revokeConfirm', :loading='revokeLoading') {{$t('admin:api.revoke')}}</template>

<script lang='ts'>
import StatusIndicator from '@/components/common/status-indicator.vue'
import { wikiStore } from '@/store/index.ts'

import CreateApiKey from './admin-api-create.vue'
import { fetchAdminApiBootstrap, revokeAdminApiKey, setAdminApiState, type AdminApiKey } from '../../helpers/auth-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { apiAccessContract } from '../../../shared/api-access.ts'

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
  computed: {
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
</style>

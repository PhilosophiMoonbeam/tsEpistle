<template>
  <v-container fluid class="webhook-admin">
    <admin-hero :title="$t('admin:webhooks.title')" :description="$t('admin:webhooks.connectLifeWikiSystems')" icon="mdi-webhook">
      <template #actions><v-btn color="primary" prepend-icon="mdi-plus" :disabled="webhookBusy || Boolean(revealedSecret) || (!draft.id && editorVisible)" @click="newHook">{{ $t('admin:webhooks.newEndpoint') }}</v-btn></template>
    </admin-hero>
    <v-alert v-if="operationError" type="error" variant="tonal" class="mb-4" closable @click:close="operationError = ''">{{ operationError }}</v-alert>
    <div class="webhook-workspace">
      <aside class="endpoint-directory" :aria-label="$t('admin:webhooks.webhookEndpoints')">
        <div class="directory-heading"><h2>{{ $t('admin:webhooks.endpoints') }} <span v-if="loadState === 'success'">· {{ hooks.length }}</span></h2><v-btn class="directory-toggle" variant="text" size="small" :aria-expanded="directoryExpanded || !editorVisible" aria-controls="endpoint-list-region" @click="directoryExpanded = !directoryExpanded">{{ directoryExpanded || !editorVisible ? $t('admin:webhooks.hideEndpoints') : $t('admin:webhooks.chooseEndpoint') }}</v-btn></div>
        <div id="endpoint-list-region" class="directory-content" :class="{ expanded: directoryExpanded || !editorVisible }">
        <v-text-field v-model="endpointQuery" :label="$t('admin:webhooks.findEndpoint')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable />
        <v-select v-model="endpointFilter" :items="[{ title: $t('admin:webhooks.allEndpoints'), value: 'All endpoints' }, { title: $t('admin:webhooks.enabled'), value: 'Enabled' }, { title: $t('admin:webhooks.disabled'), value: 'Disabled' }]" :label="$t('admin:webhooks.endpointStatus')" variant="outlined" density="compact" hide-details class="mt-3" />
        <v-skeleton-loader v-if="loadState === 'loading'" type="list-item-two-line@3" />
        <v-alert v-else-if="loadState === 'error'" type="error" variant="tonal" class="mt-4">{{ $t('admin:webhooks.unableLoadEndpoints') }} <v-btn variant="text" size="small" @click="loadHooks">{{ $t('admin:webhooks.retry') }}</v-btn></v-alert>
        <div v-else-if="filteredHooks.length" class="endpoint-list">
          <button v-for="hook in pagedHooks" :key="hook.id" type="button" class="endpoint-choice" :class="{ selected: draft.id === hook.id }" :aria-current="draft.id === hook.id ? 'true' : undefined" :disabled="webhookBusy || Boolean(revealedSecret)" @click="selectHook(hook)">
            <span class="endpoint-choice-top"><strong>{{ hook.name }}</strong><v-icon size="17" :color="hook.isEnabled ? 'success' : undefined">{{ hook.isEnabled ? 'mdi-circle-small' : 'mdi-pause-circle-outline' }}</v-icon></span>
            <span class="endpoint-address">{{ endpointHost(hook.url) }}</span>
            <span class="endpoint-meta">{{ hook.isEnabled ? $t('admin:webhooks.enabled') : $t('admin:webhooks.disabled') }} · {{ hook.events.includes('*') ? $t('admin:webhooks.everyEvent') : `${$t('admin:webhooks.subscriptionsCount', { count: hook.events.length })}` }}</span>
          </button>
        </div>
        <p v-else class="directory-empty">{{ hooks.length ? $t('admin:webhooks.noEndpointsMatchThese') : $t('admin:webhooks.connectionsStartHereAdd') }}</p>
        <template v-if="loadState === 'success'">
          <p class="register-count" role="status" v-text="$t('admin:webhooks.loadedEndpointMatches', { defaultValue: '{{matches}} matching · {{loaded}} loaded endpoints', matches: filteredHooks.length, loaded: hooks.length })" />
          <v-pagination v-if="filteredHooks.length > 12" v-model="endpointPage" :length="Math.ceil(filteredHooks.length / 12)" :total-visible="3" density="comfortable" :aria-label="$t('admin:webhooks.endpointPages', { defaultValue: 'Endpoint pages' })" />
        </template>
        </div>
        <p class="directory-note">{{ $t('admin:webhooks.httpsReceiversSignedPayloads') }}</p>
      </aside>
      <div v-if="editorVisible" class="endpoint-main" :aria-label="$t('admin:webhooks.selectedWebhook')">
        <div class="endpoint-heading">
          <div><span class="webhook-kicker">{{ draft.id ? $t('admin:webhooks.endpointWorkspace') : $t('admin:webhooks.newConnection') }}</span><h2>{{ savedHook?.name || $t('admin:webhooks.connectReceiver') }}</h2><p>{{ draft.id ? savedHook?.url || draft.url : $t('admin:webhooks.chooseWhereEventsGo') }}</p></div>
          <v-chip v-if="savedHook" size="small" :color="savedHook.isEnabled ? 'success' : undefined">{{ savedHook.isEnabled ? $t('admin:webhooks.enabled') : $t('admin:webhooks.disabled') }}</v-chip>
        </div>
        <v-alert v-if="revealedSecret" type="warning" variant="tonal" class="mb-5">
          <strong>{{ $t('admin:webhooks.saveSigningSecret') }}</strong><p>{{ $t('admin:webhooks.onlyDisplayStoreReceiver') }}</p>
          <code class="webhook-secret" tabindex="0" :aria-label="$t('admin:webhooks.webhookSigningSecret')" @focus="selectSecretText">{{ revealedSecret }}</code>
          <div class="webhook-actions mt-3"><v-btn ref="copySecretButton" variant="outlined" @click="copySecret">{{ secretCopied ? $t('admin:webhooks.copied') : $t('admin:webhooks.copySecret') }}</v-btn><v-btn variant="flat" color="warning" :disabled="webhookBusy" @click="finishSecret">{{ $t('admin:webhooks.iveSavedSecret') }}</v-btn></div>
        </v-alert>
        <v-tabs v-model="section" class="webhook-tabs" color="primary" show-arrows :aria-label="$t('admin:webhooks.endpointSections')">
          <v-tab id="webhook-tab-setup" value="setup" aria-controls="webhook-panel-setup">{{ $t('admin:webhooks.setup') }}</v-tab>
          <v-tab id="webhook-tab-deliveries" value="deliveries" aria-controls="webhook-panel-deliveries" :disabled="!draft.id">{{ $t('admin:webhooks.deliveries') }}</v-tab>
          <v-tab id="webhook-tab-integration" value="integration" aria-controls="webhook-panel-integration">{{ $t('admin:webhooks.receiverGuide') }}</v-tab>
        </v-tabs>
        <section v-show="section === 'setup'" id="webhook-panel-setup" role="tabpanel" aria-labelledby="webhook-tab-setup">
          <v-form ref="webhookForm" @submit.prevent="save">
            <div class="webhook-panel">
              <span class="webhook-kicker">{{ $t('admin:webhooks.n01Destination') }}</span><h3>{{ $t('admin:webhooks.recognizableConnection') }}</h3>
              <p>{{ $t('admin:webhooks.nameSystemReceivingThese') }}</p>
              <v-text-field ref="webhookNameInput" v-model="draft.name" :label="$t('admin:webhooks.endpointName')" maxlength="128" variant="outlined" :rules="[requiredRule]" :disabled="webhookBusy || Boolean(revealedSecret)" />
              <v-text-field ref="webhookUrlInput" v-model="draft.url" :label="$t('admin:webhooks.httpsEndpointUrl')" maxlength="2048" :placeholder="$t('admin:webhooks.httpsHooksExampleCom')" type="url" variant="outlined" :rules="[httpsRule]" :disabled="webhookBusy || Boolean(revealedSecret)" />
              <v-switch v-model="draft.isEnabled" color="primary" :label="$t('admin:webhooks.enableEventDelivery')" hide-details :disabled="webhookBusy || Boolean(revealedSecret)" />
              <p v-if="!draft.id" class="field-note">{{ $t('admin:webhooks.newEndpointsStartDisabled') }}</p>
              <p class="field-note">{{ $t('admin:webhooks.disablingStopsNewDeliveries') }}</p>
            </div>
            <div class="webhook-panel mt-4">
              <span class="webhook-kicker">{{ $t('admin:webhooks.n02Subscriptions') }}</span><h3>{{ $t('admin:webhooks.listenRightChanges') }}</h3>
              <p>{{ $t('admin:webhooks.eventsIncludePageMetadata') }}</p>
              <v-checkbox :model-value="subscribedEvents.includes('*')" :label="$t('admin:webhooks.everyEventIncludingFuture')" color="primary" hide-details :disabled="webhookBusy || Boolean(revealedSecret)" @update:model-value="setAllEvents(Boolean($event))" />
              <div v-if="!subscribedEvents.includes('*')" class="event-groups">
                <fieldset v-for="group in ['Pages', 'Reviews']" :key="group"><legend>{{ group }}</legend>
                  <label v-for="event in eventCatalog.filter(item => item.group === group)" :key="event.name" class="event-option">
                    <input type="checkbox" :checked="subscribedEvents.includes(event.name)" :disabled="webhookBusy || Boolean(revealedSecret)" @change="toggleEvent(event.name)" />
                    <span><strong>{{ event.title }}</strong><small>{{ event.description }}</small><code>{{ event.name }}</code></span>
                  </label>
                </fieldset>
              </div>
              <details class="custom-events"><summary>{{ $t('admin:webhooks.customEventSubscriptions') }}</summary><p>{{ $t('admin:webhooks.useExactEventNames') }}</p><v-textarea ref="webhookEventsInput" v-model="eventsText" :label="$t('admin:webhooks.eventNames')" rows="4" variant="outlined" :rules="[eventsRule]" :disabled="webhookBusy || Boolean(revealedSecret)" /></details>
              <p v-if="!subscribedEvents.length" class="text-error" role="status">{{ $t('admin:webhooks.chooseLeastOneEvent') }}</p>
            </div>
            <div class="webhook-savebar"><span>{{ dirty ? $t('admin:webhooks.unsavedEndpointChanges') : $t('admin:webhooks.endpointSettingsUpDate') }}</span><div class="webhook-actions"><v-btn variant="text" :disabled="!dirty || webhookBusy || Boolean(revealedSecret)" @click="resetDraft">{{ $t('admin:webhooks.resetChanges') }}</v-btn><v-btn ref="webhookSaveButton" color="primary" type="submit" :loading="saving" :disabled="webhookBusy || Boolean(revealedSecret) || !dirty || !isWebhookValid">{{ draft.id ? $t('admin:webhooks.saveEndpoint') : $t('admin:webhooks.createEndpoint') }}</v-btn></div></div>
          </v-form>
          <div v-if="draft.id" class="endpoint-maintenance"><div><h3>{{ $t('admin:webhooks.connectionMaintenance') }}</h3><p>{{ $t('admin:webhooks.rotateCredentialsWhenUpdating') }}</p></div><div class="webhook-actions"><v-btn variant="outlined" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="rotateDialog = true">{{ $t('admin:webhooks.rotateSecret') }}</v-btn><v-btn variant="text" color="error" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="deleteDialog = true">{{ $t('admin:webhooks.deleteEndpoint') }}</v-btn></div></div>
        </section>
        <section v-show="section === 'deliveries'" id="webhook-panel-deliveries" role="tabpanel" aria-labelledby="webhook-tab-deliveries">
          <div class="deliveries-heading"><div><h3>{{ $t('admin:webhooks.followEveryDelivery') }}</h3><p>{{ $t('admin:webhooks.latest100DeliveriesSaved') }}</p></div><div class="webhook-actions"><v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="deliveryLoading" :disabled="webhookBusy || deliveryLoading" @click="loadDeliveries">{{ $t('common:actions.refresh') }}</v-btn><v-btn color="primary" prepend-icon="mdi-send-check-outline" :disabled="webhookBusy || dirty || Boolean(revealedSecret) || !savedHook?.isEnabled" @click="testDialog = true">{{ $t('admin:webhooks.sendTest') }}</v-btn></div></div>
          <v-alert v-if="dirty" type="info" variant="tonal" class="mb-4">{{ $t('admin:webhooks.saveResetChangesBefore') }}</v-alert>
          <v-alert v-if="testMessage" type="info" variant="tonal" class="mb-4">{{ testMessage }}</v-alert>
          <p v-if="deliveriesCheckedAt" class="field-note">{{ $t('admin:webhooks.lastRefreshedRefreshSee', { deliveriesCheckedAt: formatDate(deliveriesCheckedAt), interpolation: { escapeValue: false } }) }}</p>
          <div class="delivery-toolbar"><v-text-field v-model="deliveryQuery" :label="$t('admin:webhooks.findEventDeliveryId')" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable /><v-select v-model="deliveryFilter" :items="[{ title: $t('admin:webhooks.allStates'), value: 'All states' }, { title: $t('admin:webhooks.needsAttention'), value: 'Needs attention' }, { title: $t('admin:webhooks.progress'), value: 'In progress' }, { title: $t('admin:webhooks.succeeded'), value: 'Succeeded' }, { title: $t('admin:webhooks.cancelled'), value: 'Cancelled' }]" :label="$t('admin:webhooks.deliveryState')" variant="outlined" density="compact" hide-details /></div>
          <v-skeleton-loader v-if="deliveryLoading && !deliveries.length" type="list-item-three-line@3" />
          <v-alert v-if="deliveryError" type="error" variant="tonal" class="mt-4">{{ $t('admin:webhooks.unableRefreshDeliveryHistory') }} <v-btn variant="text" @click="loadDeliveries">{{ $t('admin:webhooks.retry') }}</v-btn></v-alert>
          <div class="delivery-list">
            <details v-for="delivery in pagedDeliveries" :key="delivery.id" class="delivery-record">
              <summary><span><strong>{{ delivery.eventType }}</strong><small>{{ formatDate(delivery.createdAt) }}</small></span><span>{{ $t('admin:webhooks.attempts', { attempts: delivery.attempts, maxAttempts: delivery.maxAttempts, interpolation: { escapeValue: false } }) }}</span><span class="delivery-http">{{ delivery.statusCode ? $t('admin:webhooks.http', { statusCode: delivery.statusCode, interpolation: { escapeValue: false } }) : $t('admin:webhooks.noHttpResponse') }}</span><v-chip size="small" :color="stateColor(delivery.state)">{{ deliveryLabel(delivery) }}</v-chip><v-icon size="18">mdi-chevron-down</v-icon></summary>
              <div class="delivery-detail"><dl><div><dt>{{ $t('admin:webhooks.deliveryId') }}</dt><dd>{{ delivery.id }}</dd></div><div><dt>{{ $t('admin:webhooks.eventIdVersion', { eventVersion: delivery.eventVersion, interpolation: { escapeValue: false } }) }}</dt><dd>{{ delivery.eventId }}</dd></div><div><dt>{{ delivery.deliveredAt ? $t('admin:webhooks.completed') : $t('admin:webhooks.nextScheduledAttempt') }}</dt><dd>{{ formatDate(delivery.deliveredAt || (delivery.state === 'pending' ? delivery.nextRunAt : null)) }}</dd></div></dl>
              <v-alert v-if="delivery.lastError" type="error" variant="tonal" class="mb-3">{{ delivery.lastError }}</v-alert>
              <h4>{{ $t('admin:webhooks.latestResponse') }}</h4><pre>{{ delivery.responseSnippet || $t('admin:webhooks.noResponseBodyRecorded') }}</pre><p class="field-note">{{ $t('admin:webhooks.responseExcerptsLimited4') }}</p>
              <div class="webhook-actions"><v-btn v-if="delivery.state === 'failed'" variant="outlined" :loading="deliveryBusy === delivery.id" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="changeDelivery(delivery.id, 'retry')">{{ $t('admin:webhooks.retryDelivery') }}</v-btn><v-btn v-if="delivery.state === 'pending' || delivery.state === 'running'" variant="outlined" color="error" :disabled="webhookBusy || Boolean(revealedSecret)" @click="requestDeliveryCancel(delivery.id)">{{ $t('admin:webhooks.cancelDelivery') }}</v-btn></div></div>
            </details>
          </div>
          <div v-if="deliveries.length" class="register-pagination">
            <p class="register-count" role="status" v-text="$t('admin:webhooks.loadedDeliveryMatches', { defaultValue: '{{matches}} matching · {{loaded}} loaded deliveries (latest 100 only)', matches: filteredDeliveries.length, loaded: deliveries.length })" />
            <v-pagination v-if="filteredDeliveries.length > 20" v-model="deliveryPage" :length="Math.ceil(filteredDeliveries.length / 20)" :total-visible="3" density="comfortable" :aria-label="$t('admin:webhooks.deliveryPages', { defaultValue: 'Delivery pages' })" />
          </div>
          <div v-if="!filteredDeliveries.length && !deliveryLoading && !deliveryError" class="webhook-empty"><v-icon size="36" color="primary">mdi-transit-connection-variant</v-icon><h3>{{ deliveries.length ? $t('admin:webhooks.noMatchingDeliveries') : $t('admin:webhooks.readyFirstEvent') }}</h3><p>{{ deliveries.length ? $t('admin:webhooks.adjustEventSearchState') : $t('admin:webhooks.sendTestCheckReceiver') }}</p></div>
        </section>
        <section v-show="section === 'integration'" id="webhook-panel-integration" role="tabpanel" aria-labelledby="webhook-tab-integration"><admin-webhook-guide /></section>
      </div>
      <div v-else class="webhook-empty endpoint-welcome"><span class="webhook-kicker">{{ $t('admin:webhooks.eventsDestination') }}</span><h2>{{ $t('admin:webhooks.keepSystemsConversation') }}</h2><p>{{ $t('admin:webhooks.notifyWorkflowSynchronizeCatalog') }}</p><v-btn color="primary" prepend-icon="mdi-plus" :disabled="loadState !== 'success'" @click="newHook">{{ $t('admin:webhooks.addFirstEndpoint') }}</v-btn></div>
    </div>
    <v-dialog v-model="deleteDialog" max-width="480" persistent aria-labelledby="delete-webhook-dialog-title"><v-card><v-card-title id="delete-webhook-dialog-title">{{ $t('admin:webhooks.deleteEndpoint2') }}</v-card-title><v-card-text>{{ $t('admin:webhooks.removeDeliveryHistoryRequests', { name: savedHook?.name || draft.name, interpolation: { escapeValue: false } }) }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="deleting" @click="deleteDialog = false">{{ $t('admin:webhooks.keepEndpoint') }}</v-btn><v-btn color="error" :loading="deleting" @click="removeHook">{{ $t('admin:webhooks.deleteEndpoint') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="rotateDialog" max-width="500" persistent aria-labelledby="rotate-webhook-dialog-title"><v-card><v-card-title id="rotate-webhook-dialog-title">{{ $t('admin:webhooks.rotateSigningSecret') }}</v-card-title><v-card-text>{{ $t('admin:webhooks.oldSecretStopsWorking', { name: savedHook?.name, interpolation: { escapeValue: false } }) }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="rotating" @click="rotateDialog = false">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" :loading="rotating" @click="rotateSecret">{{ $t('admin:webhooks.rotateSecret') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="cancelDeliveryDialog" max-width="500" persistent aria-labelledby="cancel-webhook-delivery-dialog-title"><v-card><v-card-title id="cancel-webhook-delivery-dialog-title">{{ $t('admin:webhooks.cancelDelivery2') }}</v-card-title><v-card-text>{{ $t('admin:webhooks.stopFurtherAttemptsRequest', { eventType: cancelDelivery?.eventType, interpolation: { escapeValue: false } }) }}</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="Boolean(deliveryBusy)" @click="cancelDeliveryDialog = false">{{ $t('admin:webhooks.keepDelivery') }}</v-btn><v-btn color="error" :loading="Boolean(deliveryBusy)" @click="confirmDeliveryCancel">{{ $t('admin:webhooks.cancelDelivery') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="testDialog" max-width="520" persistent aria-labelledby="test-webhook-title"><v-card><v-card-title id="test-webhook-title">{{ $t('admin:webhooks.sendTestDelivery') }}</v-card-title><v-card-text><p>{{ $t('admin:webhooks.signed') }} <code>webhook.test</code> {{ $t('admin:webhooks.eventWillSent') }} <strong>{{ savedHook?.url }}</strong>.</p><p>{{ $t('admin:webhooks.containsTestMarkerMessage') }}</p></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="testing" @click="testDialog = false">{{ $t('common:actions.cancel') }}</v-btn><v-btn color="primary" :loading="testing" @click="sendTest">{{ $t('admin:webhooks.sendTestDelivery2') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(pendingChange)" max-width="500" persistent aria-labelledby="webhook-discard-title"><v-card><v-card-title id="webhook-discard-title">{{ revealedSecret ? $t('admin:webhooks.leaveWithoutSavingSecret') : $t('admin:webhooks.discardEndpointChanges') }}</v-card-title><v-card-text>{{ revealedSecret ? $t('admin:webhooks.secretCannotDisplayedAgain') : $t('admin:webhooks.unsavedChangesWillLost') }}</v-card-text><v-card-actions><v-spacer /><v-btn @click="finishChange(false)">{{ $t('admin:webhooks.keepEditing') }}</v-btn><v-btn color="error" @click="finishChange(true)">{{ revealedSecret ? $t('admin:webhooks.leaveEndpoint') : $t('admin:webhooks.discardChanges') }}</v-btn></v-card-actions></v-card></v-dialog>
  </v-container>
</template>

<script lang='ts'>
import AdminWebhookGuide from './admin-webhook-guide.vue'
import { WEBHOOK_EVENTS, isWebhookEventName } from '../../../shared/webhook-events.ts'
import { wikiStore } from '@/store/index.ts'
import {
  sendWebhookTest,
  changeWebhookDelivery,
  createWebhook,
  deleteWebhook,
  fetchWebhookDeliveries,
  fetchWebhooks,
  rotateWebhookSecret,
  updateWebhook,
  type AdminWebhook,
  type WebhookDelivery
} from '../../helpers/webhooks-api'

type WebhookDraft = {
  id: string | null
  name: string
  url: string
  isEnabled: boolean
}

const emptyDraft = (): WebhookDraft => ({ id: null, name: '', url: '', isEnabled: false })
const isHttpsEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export default {
  components: { AdminWebhookGuide },
  data() {
    return {
      section: ['deliveries', 'integration'].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'setup',
      eventCatalog: WEBHOOK_EVENTS,
      endpointQuery: '',
      directoryExpanded: false,
      endpointFilter: 'All endpoints',
      endpointPage: 1,
      deliveryPage: 1,
      deliveryQuery: '',
      deliveryFilter: 'All states',
      baseline: '',
      pendingChange: null as ((allow: boolean) => void) | null,
      operationError: '',
      testDialog: false,
      testing: false,
      testMessage: '',
      deliveriesCheckedAt: '',
      hooks: [] as AdminWebhook[],
      deliveries: [] as WebhookDelivery[],
      draft: emptyDraft(),
      specificEvents: 'page.created\npage.updated\npage.deleted',
      eventsText: 'page.created\npage.updated\npage.deleted',
      revealedSecret: '',
      editorVisible: false,
      secretCopied: false,
      hooksLoadToken: 0,
      loadState: 'loading' as 'loading' | 'success' | 'error',
      deliveryLoading: false,
      deliveryError: false,
      deliveryBusy: '' as string,
      deliveryLoadToken: 0,
      saving: false,
      rotating: false,
      deleting: false,
      deleteDialog: false,
      rotateDialog: false,
      cancelDeliveryDialog: false,
      cancelDeliveryId: ''
    }
  },
  watch: {
    section () {
      this.updateLocation()
    },
    filteredHooks () { this.endpointPage = 1 },
    filteredDeliveries () { this.deliveryPage = 1 }
  },
  beforeRouteLeave (): boolean | Promise<boolean> {
    if (this.webhookBusy) return false
    if (!this.dirty && !this.revealedSecret) return true
    return new Promise(resolve => { this.pendingChange = resolve })
  },
  computed: {
    fingerprint (): string { return JSON.stringify([this.draft, [...new Set(this.subscribedEvents)].sort()]) },
    dirty (): boolean { return this.editorVisible && this.baseline !== this.fingerprint },
    savedHook (): AdminWebhook | undefined { return this.hooks.find(hook => hook.id === this.draft.id) },
    filteredHooks (): AdminWebhook[] {
      const query = (this.endpointQuery || '').trim().toLowerCase()
      return this.hooks.filter(hook => `${hook.name} ${hook.url}`.toLowerCase().includes(query) &&
        (this.endpointFilter === 'All endpoints' || hook.isEnabled === (this.endpointFilter === 'Enabled')))
    },
    filteredDeliveries (): WebhookDelivery[] {
      const query = (this.deliveryQuery || '').trim().toLowerCase()
      return this.deliveries.filter(delivery => `${delivery.eventType} ${delivery.id} ${delivery.eventId}`.toLowerCase().includes(query) &&
        (this.deliveryFilter === 'All states' || (this.deliveryFilter === 'Needs attention' && delivery.state === 'failed') ||
        (this.deliveryFilter === 'In progress' && ['pending', 'running'].includes(delivery.state)) ||
        delivery.state === this.deliveryFilter.toLowerCase()))
    },
    pagedHooks (): AdminWebhook[] { return this.filteredHooks.slice((this.endpointPage - 1) * 12, this.endpointPage * 12) },
    pagedDeliveries (): WebhookDelivery[] { return this.filteredDeliveries.slice((this.deliveryPage - 1) * 20, this.deliveryPage * 20) },
    webhookBusy (): boolean {
      return this.testing || this.saving || this.rotating || this.deleting || Boolean(this.deliveryBusy)
    },
    subscribedEvents (): string[] {
      return [...new Set(this.eventsText.split(/\r?\n/).map(event => event.trim()).filter(Boolean))]
    },
    isWebhookValid (): boolean {
      return this.draft.name.trim().length > 0 && this.draft.name.trim().length <= 128 && this.draft.url.trim().length <= 2048 && isHttpsEndpoint(this.draft.url) && this.subscribedEvents.length > 0 && this.subscribedEvents.length <= 50 && this.subscribedEvents.every(isWebhookEventName)
    },
    requiredRule (): (value: string) => true | string {
      return (value: string) => value.trim().length > 0 || this.$t('admin:webhooks.nameRequired')
    },
    httpsRule (): (value: string) => true | string {
      return (value: string) => isHttpsEndpoint(value) || this.$t('admin:webhooks.useHttpsEndpointUrl')
    },
    eventsRule (): (value: string) => true | string {
      return () => (this.subscribedEvents.length > 0 && this.subscribedEvents.length <= 50 && this.subscribedEvents.every(isWebhookEventName)) || this.$t('admin:webhooks.use150Event')
    },
    cancelDelivery (): WebhookDelivery | null {
      return this.deliveries.find(delivery => delivery.id === this.cancelDeliveryId) || null
    }
  },
  methods: {
    updateLocation () {
      const url = new URL(window.location.href)
      if (this.draft.id) url.searchParams.set('endpoint', this.draft.id); else url.searchParams.delete('endpoint')
      url.hash = this.section === 'setup' ? '' : this.section
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    },
    markClean () { this.baseline = this.fingerprint },
    requestChange (action: () => void) {
      if (this.webhookBusy) return
      if (this.dirty || this.revealedSecret) this.pendingChange = allow => { if (allow) action() }
      else action()
    },
    finishChange (allow: boolean) { const pending = this.pendingChange; this.pendingChange = null; pending?.(allow) },
    warnBeforeUnload (event: BeforeUnloadEvent) {
      if (this.dirty || this.revealedSecret || this.webhookBusy) { event.preventDefault(); event.returnValue = '' }
    },
    resetDraft () { if (this.savedHook) this.selectHookNow(this.savedHook); else this.newHookNow() },
    setAllEvents (all: boolean) {
      if (all) { this.specificEvents = this.subscribedEvents.filter(event => event !== '*').join('\n'); this.eventsText = '*' }
      else this.eventsText = this.specificEvents || 'page.created\npage.updated\npage.deleted'
    },
    toggleEvent (name: string) { this.eventsText = (this.subscribedEvents.includes(name) ? this.subscribedEvents.filter(event => event !== name) : [...this.subscribedEvents, name]).join('\n') },
    endpointHost (url: string): string { try { return new URL(url).host } catch { return url } },
    formatDate (value: string | null): string { return value ? new Date(value).toLocaleString() : '—' },
    deliveryLabel (delivery: WebhookDelivery): string { return delivery.responseSnippet === 'Webhook disabled before delivery' ? this.$t('admin:webhooks.skippedDisabled') : delivery.state },
    async sendTest () {
      if (this.webhookBusy || this.dirty || !this.savedHook?.isEnabled || !this.draft.id || this.revealedSecret) return
      this.testing = true
      this.operationError = ''
      try {
        const id = await sendWebhookTest(window.fetch.bind(window), this.draft.id)
        this.testDialog = false
        this.deliveryFilter = 'All states'
        this.deliveryQuery = ''
        this.testMessage = this.$t('admin:webhooks.testQueuedDeliveryRefresh', { id, interpolation: { escapeValue: false } })
        await this.loadDeliveries()
      } catch (error) { this.reportError(error) } finally { this.testing = false }
    },
    reportError (error: unknown) { this.operationError = error instanceof Error ? error.message : String(error); wikiStore.showError(error) },
    async copySecret () {
      try {
        await navigator.clipboard.writeText(this.revealedSecret)
        this.secretCopied = true
      } catch {
        wikiStore.showNotification({ style: 'red', message: this.$t('admin:webhooks.copyFailedSelectSecret'), icon: 'alert' })
      }
    },
    selectSecretText (event: FocusEvent) {
      if (!(event.currentTarget instanceof HTMLElement)) return
      const selection = window.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(event.currentTarget)
      selection.removeAllRanges()
      selection.addRange(range)
    },
    finishSecret () {
      this.revealedSecret = ''
      this.secretCopied = false
      this.$nextTick(() => {
        document.getElementById(`webhook-tab-${this.section}`)?.focus()
      })
    },
    focusSecretAction () {
      this.$nextTick(() => {
        ;(this.$refs.copySecretButton as { focus?: () => void })?.focus?.()
      })
    },
    async loadHooks (): Promise<boolean> {
      const token = ++this.hooksLoadToken
      this.loadState = 'loading'
      try {
        const hooks = await fetchWebhooks(window.fetch.bind(window))
        if (token !== this.hooksLoadToken) return false
        this.hooks = hooks
        this.loadState = 'success'
        if (!this.editorVisible && this.hooks.length) {
          const requested = new URLSearchParams(window.location.search).get('endpoint')
          this.selectHookNow(this.hooks.find(hook => hook.id === requested) || this.hooks[0])
        }
        return true
      } catch (error) {
        if (token !== this.hooksLoadToken) return false
        this.loadState = 'error'
        this.reportError(error)
        return false
      }
    },
    newHook () { this.requestChange(() => this.newHookNow()) },
    newHookNow () {
      this.section = 'setup'
      this.operationError = ''
      this.testMessage = ''
      this.deliveriesCheckedAt = ''
      this.editorVisible = true
      this.deliveryLoadToken++
      this.draft = emptyDraft()
      this.eventsText = 'page.created\npage.updated\npage.deleted'
      this.deliveries = []
      this.deliveryLoading = false
      this.deliveryError = false
      this.revealedSecret = ''
      this.secretCopied = false
      this.markClean()
      this.updateLocation()
      this.$nextTick(() => {
        ;(this.$refs.webhookNameInput as { focus?: () => void })?.focus?.()
      })
    },
    selectHook (hook: AdminWebhook) { if (hook.id !== this.draft.id) this.requestChange(() => this.selectHookNow(hook)) },
    selectHookNow (hook: AdminWebhook) {
      this.directoryExpanded = false
      this.operationError = ''
      this.testMessage = ''
      this.deliveriesCheckedAt = ''
      const selectionChanged = this.draft.id !== hook.id
      this.editorVisible = true
      this.draft = { id: hook.id, name: hook.name, url: hook.url, isEnabled: hook.isEnabled }
      this.eventsText = hook.events.join('\n')
      this.specificEvents = hook.events.filter(event => event !== '*').join('\n')
      if (selectionChanged) this.deliveries = []
      this.deliveryError = false
      this.revealedSecret = ''
      this.secretCopied = false
      this.markClean()
      this.updateLocation()
      this.loadDeliveries()
    },
    async save () {
      if (this.webhookBusy || this.revealedSecret || !this.dirty) return
      if (!this.isWebhookValid) {
        const form = this.$refs.webhookForm as { validate?: () => Promise<unknown> }
        await form.validate?.()
        await this.$nextTick()
        const target = !this.draft.name.trim()
          ? this.$refs.webhookNameInput
          : (!isHttpsEndpoint(this.draft.url) ? this.$refs.webhookUrlInput : this.$refs.webhookEventsInput)
        ;(target as { focus?: () => void })?.focus?.()
        return
      }
      this.operationError = ''
      this.saving = true
      try {
        const input = {
          name: this.draft.name.trim(),
          url: this.draft.url.trim(),
          events: this.subscribedEvents,
          isEnabled: this.draft.isEnabled
        }
        if (this.draft.id) {
          await updateWebhook(window.fetch.bind(window), this.draft.id, input)
        } else {
          const created = await createWebhook(window.fetch.bind(window), input)
          this.draft.id = created.id
          this.revealedSecret = created.secret
          this.secretCopied = false
          this.focusSecretAction()
        }
        this.draft.name = input.name
        this.draft.url = input.url
        this.eventsText = input.events.join('\n')
        const now = new Date().toISOString()
        const saved = { ...input, id: this.draft.id!, createdAt: this.savedHook?.createdAt || now, updatedAt: now }
        this.hooks = [...this.hooks.filter(hook => hook.id !== saved.id), saved]
        this.markClean()
        this.updateLocation()
        await this.loadHooks()
        wikiStore.showNotification({ style: 'success', message: this.$t('admin:webhooks.webhookSaved'), icon: 'check' })
      } catch (error) {
        this.reportError(error)
      } finally {
        this.saving = false
      }
    },
    async rotateSecret () {
      if (!this.draft.id || this.webhookBusy || this.dirty || this.revealedSecret) return
      this.rotateDialog = false
      this.rotating = true
      try {
        this.revealedSecret = await rotateWebhookSecret(window.fetch.bind(window), this.draft.id)
        this.secretCopied = false
        this.focusSecretAction()
      } catch (error) {
        this.reportError(error)
      } finally {
        this.rotating = false
      }
    },
    async removeHook () {
      if (!this.draft.id || this.webhookBusy || this.dirty || this.revealedSecret) return
      this.deleting = true
      try {
        await deleteWebhook(window.fetch.bind(window), this.draft.id)
        this.deleteDialog = false
        this.newHookNow()
        if (await this.loadHooks()) {
          if (this.hooks.length) this.selectHookNow(this.hooks[0])
          else this.editorVisible = false
        }
      } catch (error) {
        this.reportError(error)
      } finally {
        this.deleting = false
      }
    },
    async loadDeliveries () {
      if (!this.draft.id) return
      const selectedId = this.draft.id
      const token = ++this.deliveryLoadToken
      this.operationError = ''
      this.deliveryLoading = true
      this.deliveryError = false
      try {
        const rows = await fetchWebhookDeliveries(window.fetch.bind(window), selectedId)
        if (this.draft.id === selectedId && token === this.deliveryLoadToken) { this.deliveries = rows; this.deliveriesCheckedAt = new Date().toISOString() }
      } catch (error) {
        if (this.draft.id === selectedId && token === this.deliveryLoadToken) {
          this.deliveryError = true
          this.reportError(error)
        }
      } finally {
        if (token === this.deliveryLoadToken) this.deliveryLoading = false
      }
    },
    requestDeliveryCancel (id: string) {
      this.cancelDeliveryId = id
      this.cancelDeliveryDialog = true
    },
    async confirmDeliveryCancel () {
      if (this.deliveryBusy) return
      const id = this.cancelDeliveryId
      if (!id) return
      this.cancelDeliveryDialog = false
      await this.changeDelivery(id, 'cancel')
      this.cancelDeliveryId = ''
    },
    async changeDelivery (id: string, action: 'retry' | 'cancel') {
      if (this.webhookBusy || this.revealedSecret || (action === 'retry' && this.dirty)) return
      this.operationError = ''
      this.deliveryBusy = id
      try {
        await changeWebhookDelivery(window.fetch.bind(window), id, action)
        await this.loadDeliveries()
        wikiStore.showNotification({ style: 'success', message: action === 'retry' ? this.$t('admin:webhooks.deliveryQueuedRetry') : this.$t('admin:webhooks.deliveryCancelled'), icon: 'check' })
      } catch (error) {
        this.reportError(error)
      } finally {
        this.deliveryBusy = ''
      }
    },
    stateColor (state: string): string | undefined {
      if (state === 'succeeded') return 'success'
      if (state === 'failed') return 'error'
      if (state === 'running') return 'primary'
      // A cancelled delivery uses the neutral chip (theme on-surface).
      if (state === 'cancelled') return undefined
      return 'warning'
    }
  },
  created () {
    window.addEventListener('beforeunload', this.warnBeforeUnload)
    this.loadHooks()
  },
  beforeUnmount () {
    window.removeEventListener('beforeunload', this.warnBeforeUnload)
    this.finishChange(false)
    this.hooksLoadToken++
    this.deliveryLoadToken++
  }
}
</script>

<style scoped>
.webhook-admin { padding-bottom: calc(var(--wiki-footer-height) + 2rem) !important; min-width: 0; }
.webhook-admin :deep(button) { scroll-margin-block: 6rem; }
.webhook-workspace { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 1.25rem; align-items: start; }
.endpoint-directory { border-inline-end: 1px solid var(--wiki-surface-border); padding-inline-end: 1rem; min-width: 0; }
.directory-heading { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: space-between; margin-bottom: .75rem; }
.directory-heading h2 { font: 600 1rem/1.4 var(--wiki-font-display); }.directory-heading h2 span { font: 400 .8rem var(--wiki-font-body); }.directory-toggle { display: none; }
.endpoint-list { display: grid; gap: .25rem; margin-top: .75rem; }
.endpoint-choice { background: transparent; color: inherit; display: block; text-align: start; width: 100%; padding: .75rem; border: 1px solid transparent; border-radius: var(--wiki-control-radius); }
.endpoint-choice:hover { background: var(--wiki-surface-sunken); }.endpoint-choice.selected { border-color: var(--wiki-surface-border); border-inline-start: 3px solid var(--wiki-accent-ink); background: var(--wiki-surface-sunken); }
.endpoint-choice:focus-visible, summary:focus-visible, .event-option input:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; }
.endpoint-choice-top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }.endpoint-choice strong { font-size: .875rem; overflow-wrap: anywhere; }.endpoint-address, .endpoint-meta { display: block; font-size: .8rem; margin-top: .25rem; overflow-wrap: anywhere; color: var(--wiki-text-muted); }
.directory-note, .directory-empty, .register-count { font-size: .8rem; line-height: 1.6; margin-top: .75rem; color: var(--wiki-text-muted); }.directory-note { border-top: 1px solid var(--wiki-surface-border); padding-top: .75rem; }.register-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
.endpoint-main { min-width: 0; }.endpoint-heading, .deliveries-heading, .endpoint-maintenance { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: .75rem 1rem; }.endpoint-heading > div, .deliveries-heading > div:first-child, .endpoint-maintenance > div:first-child { flex: 1 1 20rem; min-width: 0; }
.endpoint-heading h2, .endpoint-welcome h2 { font: 600 1.25rem/1.4 var(--wiki-font-display); margin-block: .35rem; overflow-wrap: anywhere; }.endpoint-heading p { overflow-wrap: anywhere; }
.webhook-kicker { font-size: .75rem; font-weight: 600; color: var(--wiki-text-muted); }
p { font-size: .875rem; line-height: 1.6; margin-bottom: .75rem; }h3 { font: 600 1rem/1.4 var(--wiki-font-display); margin-block: .35rem .5rem; }h4 { font-size: .875rem; margin-bottom: .5rem; }
.webhook-tabs { border-bottom: 1px solid var(--wiki-surface-border); margin: .75rem 0 1rem; }
.webhook-panel { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: 1.25rem; background: var(--wiki-surface-raised); min-width: 0; }
.field-note { font-size: .8rem; margin-top: .35rem; color: var(--wiki-text-muted); }
.event-groups { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; margin-block: 1rem; }.event-groups fieldset { border: 0; min-width: 0; }.event-groups legend { font-size: .875rem; font-weight: 600; margin-bottom: .5rem; }
.event-option { display: flex; align-items: start; gap: .75rem; min-height: 44px; padding-block: .75rem; border-top: 1px solid var(--wiki-surface-border); cursor: pointer; }.event-option input { margin-top: .25rem; accent-color: rgb(var(--v-theme-primary)); width: 1.1rem; height: 1.1rem; flex-shrink: 0; }.event-option span { min-width: 0; }.event-option strong, .event-option small, .event-option code { display: block; }.event-option strong { font-size: .875rem; font-weight: 500; }.event-option small { font-size: .8rem; line-height: 1.6; margin-block: .2rem; color: var(--wiki-text-muted); }.event-option code { font: .75rem var(--wiki-font-mono); overflow-wrap: anywhere; }
.custom-events { padding-top: .75rem; border-top: 1px solid var(--wiki-surface-border); }.custom-events summary { font-size: .875rem; cursor: pointer; padding-block: .5rem; }
.webhook-savebar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; padding: 1rem; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); margin-top: 1rem; position: sticky; bottom: var(--wiki-footer-height); z-index: 2; }.webhook-savebar > span { font-size: .8rem; }
.webhook-actions { display: flex; gap: .5rem; flex-wrap: wrap; min-width: 0; }.endpoint-maintenance { margin-top: 1.5rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; }.endpoint-maintenance p { font-size: .8rem; }
.deliveries-heading { margin-bottom: 1rem; }.delivery-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 13rem); gap: .75rem; margin-bottom: 1rem; }
.delivery-record { border-bottom: 1px solid var(--wiki-surface-border); }.delivery-record summary { display: grid; grid-template-columns: minmax(0, 1fr) 100px 120px auto 18px; gap: .75rem; align-items: center; cursor: pointer; padding: .85rem .5rem; font-size: .8rem; list-style: none; }.delivery-record summary::-webkit-details-marker { display: none; }.delivery-record summary strong { font-weight: 600; font-size: .875rem; overflow-wrap: anywhere; }.delivery-record summary small { display: block; font-size: .75rem; margin-top: .25rem; }.delivery-record[open] summary > .v-icon { transform: rotate(180deg); }
.delivery-detail { padding: 1rem; background: var(--wiki-surface-sunken); }.delivery-detail dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; margin-bottom: 1rem; }.delivery-detail dt { font-size: .75rem; margin-bottom: .25rem; color: var(--wiki-text-muted); }.delivery-detail dd { margin: 0; font-size: .8rem; overflow-wrap: anywhere; }.delivery-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; font: .8rem/1.65 var(--wiki-font-mono); max-height: 240px; overflow: auto; }
.webhook-empty { text-align: center; padding: 2rem 1rem; }.webhook-empty p { max-width: 55ch; margin-inline: auto; }.endpoint-welcome p { margin-block: 1rem; }.webhook-secret { display: block; margin-top: .75rem; overflow-wrap: anywhere; user-select: all; }
@media(max-width: 1200px) { .webhook-workspace { grid-template-columns: 240px minmax(0, 1fr); }.delivery-record summary { grid-template-columns: minmax(0, 1fr) auto 18px; }.delivery-record summary > span:nth-child(2), .delivery-http { grid-column: 1; font-size: .75rem; }.delivery-record summary > .v-chip { grid-column: 2; grid-row: 1; }.delivery-record summary > .v-icon { grid-column: 3; grid-row: 1; } }
@media(max-width: 900px) { .directory-toggle { display: inline-flex; min-height: 44px; }.directory-content:not(.expanded) { display: none; }.directory-heading { margin-bottom: 0; }.directory-content.expanded { margin-top: .75rem; }.webhook-workspace { grid-template-columns: minmax(0,1fr); }.endpoint-directory { border-inline-end: 0; border-bottom: 1px solid var(--wiki-surface-border); padding: 0 0 1rem; }.endpoint-list { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 280px; overflow-y: auto; }.directory-note { display: none; } }
@media(max-width: 600px) { .event-groups, .delivery-toolbar, .delivery-detail dl { grid-template-columns: minmax(0,1fr); }.webhook-savebar { position: static; align-items: stretch; }.endpoint-list { grid-template-columns: minmax(0,1fr); max-height: 240px; }.delivery-record summary { gap: .35rem .5rem; }.webhook-panel { padding: 1rem; }.webhook-admin .v-btn { min-height: 44px; height: auto; white-space: normal; max-width: 100%; }.register-pagination { justify-content: start; } }
</style>

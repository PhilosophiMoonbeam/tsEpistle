<template>
  <v-container fluid class="webhook-admin">
    <admin-hero title="Webhooks" description="Connect the life of your wiki to the systems around it." icon="mdi-webhook">
      <template #actions><v-btn color="primary" prepend-icon="mdi-plus" :disabled="webhookBusy || Boolean(revealedSecret) || (!draft.id && editorVisible)" @click="newHook">New endpoint</v-btn></template>
    </admin-hero>
    <v-alert v-if="operationError" type="error" variant="tonal" class="mb-4" closable @click:close="operationError = ''">{{ operationError }}</v-alert>
    <div class="webhook-workspace">
      <aside class="endpoint-directory" aria-label="Webhook endpoints">
        <div class="directory-heading"><h2>Endpoints <span v-if="loadState === 'success'">· {{ hooks.length }}</span></h2><v-btn class="directory-toggle" variant="text" size="small" :aria-expanded="directoryExpanded || !editorVisible" aria-controls="endpoint-list-region" @click="directoryExpanded = !directoryExpanded">{{ directoryExpanded || !editorVisible ? 'Hide endpoints' : 'Choose endpoint' }}</v-btn></div>
        <div id="endpoint-list-region" class="directory-content" :class="{ expanded: directoryExpanded || !editorVisible }">
        <v-text-field v-model="endpointQuery" label="Find an endpoint" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable />
        <v-select v-model="endpointFilter" :items="['All endpoints', 'Enabled', 'Disabled']" label="Endpoint status" variant="outlined" density="compact" hide-details class="mt-3" />
        <v-skeleton-loader v-if="loadState === 'loading'" type="list-item-two-line@3" />
        <v-alert v-else-if="loadState === 'error'" type="error" variant="tonal" class="mt-4">Unable to load endpoints. <v-btn variant="text" size="small" @click="loadHooks">Retry</v-btn></v-alert>
        <div v-else-if="filteredHooks.length" class="endpoint-list">
          <button v-for="hook in filteredHooks" :key="hook.id" type="button" class="endpoint-choice" :class="{ selected: draft.id === hook.id }" :aria-current="draft.id === hook.id ? 'true' : undefined" :disabled="webhookBusy || Boolean(revealedSecret)" @click="selectHook(hook)">
            <span class="endpoint-choice-top"><strong>{{ hook.name }}</strong><v-icon size="17" :color="hook.isEnabled ? 'success' : undefined">{{ hook.isEnabled ? 'mdi-circle-small' : 'mdi-pause-circle-outline' }}</v-icon></span>
            <span class="endpoint-address">{{ endpointHost(hook.url) }}</span>
            <span class="endpoint-meta">{{ hook.isEnabled ? 'Enabled' : 'Disabled' }} · {{ hook.events.includes('*') ? 'Every event' : `${hook.events.length} ${hook.events.length === 1 ? 'subscription' : 'subscriptions'}` }}</span>
          </button>
        </div>
        <p v-else class="directory-empty">{{ hooks.length ? 'No endpoints match these filters.' : 'Your connections start here. Add an endpoint to subscribe a receiver to wiki events.' }}</p>
        </div>
        <p class="directory-note">HTTPS receivers · Signed payloads · Durable delivery</p>
      </aside>
      <div v-if="editorVisible" class="endpoint-main" aria-label="Selected webhook">
        <div class="endpoint-heading">
          <div><span class="webhook-kicker">{{ draft.id ? 'Endpoint workspace' : 'New connection' }}</span><h2>{{ savedHook?.name || 'Connect a receiver' }}</h2><p>{{ draft.id ? savedHook?.url || draft.url : 'Choose where events go, then decide what your receiver needs to know.' }}</p></div>
          <v-chip v-if="savedHook" size="small" :color="savedHook.isEnabled ? 'success' : undefined">{{ savedHook.isEnabled ? 'Enabled' : 'Disabled' }}</v-chip>
        </div>
        <v-alert v-if="revealedSecret" type="warning" variant="tonal" class="mb-5">
          <strong>Save your signing secret</strong><p>This is its only display. Store it in your receiver before leaving this endpoint.</p>
          <code class="webhook-secret" tabindex="0" aria-label="Webhook signing secret" @focus="selectSecretText">{{ revealedSecret }}</code>
          <div class="webhook-actions mt-3"><v-btn ref="copySecretButton" variant="outlined" @click="copySecret">{{ secretCopied ? 'Copied' : 'Copy secret' }}</v-btn><v-btn variant="flat" color="warning" :disabled="webhookBusy" @click="finishSecret">I’ve saved this secret</v-btn></div>
        </v-alert>
        <v-tabs v-model="section" class="webhook-tabs" color="primary" show-arrows aria-label="Endpoint sections">
          <v-tab id="webhook-tab-setup" value="setup" aria-controls="webhook-panel-setup">Setup</v-tab>
          <v-tab id="webhook-tab-deliveries" value="deliveries" aria-controls="webhook-panel-deliveries" :disabled="!draft.id">Deliveries</v-tab>
          <v-tab id="webhook-tab-integration" value="integration" aria-controls="webhook-panel-integration">Receiver guide</v-tab>
        </v-tabs>
        <section v-show="section === 'setup'" id="webhook-panel-setup" role="tabpanel" aria-labelledby="webhook-tab-setup">
          <v-form ref="webhookForm" @submit.prevent="save">
            <div class="webhook-panel">
              <span class="webhook-kicker">01 / Destination</span><h3>A recognizable connection</h3>
              <p>Name the system receiving these events. Use a public HTTPS URL that accepts signed JSON requests.</p>
              <v-text-field ref="webhookNameInput" v-model="draft.name" label="Endpoint name" maxlength="128" variant="outlined" :rules="[requiredRule]" :disabled="webhookBusy || Boolean(revealedSecret)" />
              <v-text-field ref="webhookUrlInput" v-model="draft.url" label="HTTPS endpoint URL" maxlength="2048" placeholder="https://hooks.example.com/wiki" type="url" variant="outlined" :rules="[httpsRule]" :disabled="webhookBusy || Boolean(revealedSecret)" />
              <v-switch v-model="draft.isEnabled" color="primary" label="Enable event delivery" hide-details :disabled="webhookBusy || Boolean(revealedSecret)" />
              <p v-if="!draft.id" class="field-note">New endpoints start disabled. Create the endpoint, configure its signing secret in your receiver, then enable delivery.</p>
              <p class="field-note">Disabling stops new deliveries and skips queued deliveries that have not started. A request already in flight may finish.</p>
            </div>
            <div class="webhook-panel mt-4">
              <span class="webhook-kicker">02 / Subscriptions</span><h3>Listen for the right changes</h3>
              <p>Events include page metadata and review details, including private page metadata. Subscribe only receivers that should have this workspace access.</p>
              <v-checkbox :model-value="subscribedEvents.includes('*')" label="Every event, including future event types" color="primary" hide-details :disabled="webhookBusy || Boolean(revealedSecret)" @update:model-value="setAllEvents(Boolean($event))" />
              <div v-if="!subscribedEvents.includes('*')" class="event-groups">
                <fieldset v-for="group in ['Pages', 'Reviews']" :key="group"><legend>{{ group }}</legend>
                  <label v-for="event in eventCatalog.filter(item => item.group === group)" :key="event.name" class="event-option">
                    <input type="checkbox" :checked="subscribedEvents.includes(event.name)" :disabled="webhookBusy || Boolean(revealedSecret)" @change="toggleEvent(event.name)" />
                    <span><strong>{{ event.title }}</strong><small>{{ event.description }}</small><code>{{ event.name }}</code></span>
                  </label>
                </fieldset>
              </div>
              <details class="custom-events"><summary>Custom event subscriptions</summary><p>Use exact event names, one per line. A subscription does not create an event producer.</p><v-textarea ref="webhookEventsInput" v-model="eventsText" label="Event names" rows="4" variant="outlined" :rules="[eventsRule]" :disabled="webhookBusy || Boolean(revealedSecret)" /></details>
              <p v-if="!subscribedEvents.length" class="text-error" role="status">Choose at least one event before saving.</p>
            </div>
            <div class="webhook-savebar"><span>{{ dirty ? 'Unsaved endpoint changes' : 'Endpoint settings are up to date' }}</span><div class="webhook-actions"><v-btn variant="text" :disabled="!dirty || webhookBusy || Boolean(revealedSecret)" @click="resetDraft">Reset changes</v-btn><v-btn ref="webhookSaveButton" color="primary" type="submit" :loading="saving" :disabled="webhookBusy || Boolean(revealedSecret) || !dirty || !isWebhookValid">{{ draft.id ? 'Save endpoint' : 'Create endpoint' }}</v-btn></div></div>
          </v-form>
          <div v-if="draft.id" class="endpoint-maintenance"><div><h3>Connection maintenance</h3><p>Rotate credentials when updating your receiver, or remove a retired connection.</p></div><div class="webhook-actions"><v-btn variant="outlined" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="rotateDialog = true">Rotate secret</v-btn><v-btn variant="text" color="error" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="deleteDialog = true">Delete endpoint</v-btn></div></div>
        </section>
        <section v-show="section === 'deliveries'" id="webhook-panel-deliveries" role="tabpanel" aria-labelledby="webhook-tab-deliveries">
          <div class="deliveries-heading"><div><h3>Follow every delivery</h3><p>The latest 100 deliveries for the saved endpoint. Open a delivery to inspect the response and recovery options.</p></div><div class="webhook-actions"><v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="deliveryLoading" :disabled="webhookBusy || deliveryLoading" @click="loadDeliveries">Refresh</v-btn><v-btn color="primary" prepend-icon="mdi-send-check-outline" :disabled="webhookBusy || dirty || Boolean(revealedSecret) || !savedHook?.isEnabled" @click="testDialog = true">Send test</v-btn></div></div>
          <v-alert v-if="dirty" type="info" variant="tonal" class="mb-4">Save or reset changes before sending a test. Delivery history belongs to the saved endpoint.</v-alert>
          <v-alert v-if="testMessage" type="info" variant="tonal" class="mb-4">{{ testMessage }}</v-alert>
          <p v-if="deliveriesCheckedAt" class="field-note">Last refreshed {{ formatDate(deliveriesCheckedAt) }}. Refresh to see queue progress.</p>
          <div class="delivery-toolbar"><v-text-field v-model="deliveryQuery" label="Find event or delivery ID" prepend-inner-icon="mdi-magnify" variant="outlined" density="compact" hide-details clearable /><v-select v-model="deliveryFilter" :items="['All states', 'Needs attention', 'In progress', 'Succeeded', 'Cancelled']" label="Delivery state" variant="outlined" density="compact" hide-details /></div>
          <v-skeleton-loader v-if="deliveryLoading && !deliveries.length" type="list-item-three-line@3" />
          <v-alert v-if="deliveryError" type="error" variant="tonal" class="mt-4">Unable to refresh delivery history. Previously loaded rows may be out of date. <v-btn variant="text" @click="loadDeliveries">Retry</v-btn></v-alert>
          <div class="delivery-list">
            <details v-for="delivery in filteredDeliveries" :key="delivery.id" class="delivery-record">
              <summary><span><strong>{{ delivery.eventType }}</strong><small>{{ formatDate(delivery.createdAt) }}</small></span><span>{{ delivery.attempts }} / {{ delivery.maxAttempts }} attempts</span><span class="delivery-http">{{ delivery.statusCode ? `HTTP ${delivery.statusCode}` : 'No HTTP response' }}</span><v-chip size="small" :color="stateColor(delivery.state)">{{ deliveryLabel(delivery) }}</v-chip><v-icon size="18">mdi-chevron-down</v-icon></summary>
              <div class="delivery-detail"><dl><div><dt>Delivery ID</dt><dd>{{ delivery.id }}</dd></div><div><dt>Event ID · version {{ delivery.eventVersion }}</dt><dd>{{ delivery.eventId }}</dd></div><div><dt>{{ delivery.deliveredAt ? 'Completed' : 'Next scheduled attempt' }}</dt><dd>{{ formatDate(delivery.deliveredAt || (delivery.state === 'pending' ? delivery.nextRunAt : null)) }}</dd></div></dl>
              <v-alert v-if="delivery.lastError" type="error" variant="tonal" class="mb-3">{{ delivery.lastError }}</v-alert>
              <h4>Latest response</h4><pre>{{ delivery.responseSnippet || 'No response body recorded.' }}</pre><p class="field-note">Response excerpts are limited to 4 KiB. History shows the latest outcome for each delivery, not every attempt.</p>
              <div class="webhook-actions"><v-btn v-if="delivery.state === 'failed'" variant="outlined" :loading="deliveryBusy === delivery.id" :disabled="webhookBusy || dirty || Boolean(revealedSecret)" @click="changeDelivery(delivery.id, 'retry')">Retry delivery</v-btn><v-btn v-if="delivery.state === 'pending' || delivery.state === 'running'" variant="outlined" color="error" :disabled="webhookBusy || Boolean(revealedSecret)" @click="requestDeliveryCancel(delivery.id)">Cancel delivery</v-btn></div></div>
            </details>
          </div>
          <div v-if="!filteredDeliveries.length && !deliveryLoading && !deliveryError" class="webhook-empty"><v-icon size="36" color="primary">mdi-transit-connection-variant</v-icon><h3>{{ deliveries.length ? 'No matching deliveries' : 'Ready for the first event' }}</h3><p>{{ deliveries.length ? 'Adjust the event search or state filter.' : 'Send a test to check your receiver, or wait for a subscribed event. Enable and save the endpoint first.' }}</p></div>
        </section>
        <section v-show="section === 'integration'" id="webhook-panel-integration" role="tabpanel" aria-labelledby="webhook-tab-integration"><admin-webhook-guide /></section>
      </div>
      <div v-else class="webhook-empty endpoint-welcome"><span class="webhook-kicker">Events, with a destination</span><h2>Keep your systems in conversation.</h2><p>Notify a workflow, synchronize a catalog, or let an agent respond to wiki activity. Each endpoint has its own subscriptions, signing secret and delivery history.</p><v-btn color="primary" prepend-icon="mdi-plus" :disabled="loadState !== 'success'" @click="newHook">Add your first endpoint</v-btn></div>
    </div>
    <v-dialog v-model="deleteDialog" max-width="480" persistent aria-labelledby="delete-webhook-dialog-title"><v-card><v-card-title id="delete-webhook-dialog-title">Delete endpoint?</v-card-title><v-card-text>Remove {{ savedHook?.name || draft.name }} and its delivery history? Requests already in flight may still reach the receiver.</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="deleting" @click="deleteDialog = false">Keep endpoint</v-btn><v-btn color="error" :loading="deleting" @click="removeHook">Delete endpoint</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="rotateDialog" max-width="500" persistent aria-labelledby="rotate-webhook-dialog-title"><v-card><v-card-title id="rotate-webhook-dialog-title">Rotate signing secret?</v-card-title><v-card-text>The old secret for {{ savedHook?.name }} stops working immediately. Update your receiver with the new secret. Requests already in flight may carry the old signature.</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="rotating" @click="rotateDialog = false">Cancel</v-btn><v-btn color="primary" :loading="rotating" @click="rotateSecret">Rotate secret</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="cancelDeliveryDialog" max-width="500" persistent aria-labelledby="cancel-webhook-delivery-dialog-title"><v-card><v-card-title id="cancel-webhook-delivery-dialog-title">Cancel delivery?</v-card-title><v-card-text>Stop further attempts for {{ cancelDelivery?.eventType }}. A request already in flight may still reach the receiver. Cancelled deliveries cannot be retried.</v-card-text><v-card-actions><v-spacer /><v-btn :disabled="Boolean(deliveryBusy)" @click="cancelDeliveryDialog = false">Keep delivery</v-btn><v-btn color="error" :loading="Boolean(deliveryBusy)" @click="confirmDeliveryCancel">Cancel delivery</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog v-model="testDialog" max-width="520" persistent aria-labelledby="test-webhook-title"><v-card><v-card-title id="test-webhook-title">Send a test delivery?</v-card-title><v-card-text><p>A signed <code>webhook.test</code> event will be sent to <strong>{{ savedHook?.url }}</strong>.</p><p>It contains a test marker and message, with no page data. It targets only this endpoint, regardless of subscriptions, and attempts delivery once. You can retry a failed test from its delivery details.</p></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="testing" @click="testDialog = false">Cancel</v-btn><v-btn color="primary" :loading="testing" @click="sendTest">Send test delivery</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(pendingChange)" max-width="500" persistent aria-labelledby="webhook-discard-title"><v-card><v-card-title id="webhook-discard-title">{{ revealedSecret ? 'Leave without saving the secret?' : 'Discard endpoint changes?' }}</v-card-title><v-card-text>{{ revealedSecret ? 'This secret cannot be displayed again. Save it in your receiver before leaving, or rotate it later.' : 'Your unsaved changes will be lost. Stay here to finish editing or discard them to continue.' }}</v-card-text><v-card-actions><v-spacer /><v-btn @click="finishChange(false)">Keep editing</v-btn><v-btn color="error" @click="finishChange(true)">{{ revealedSecret ? 'Leave endpoint' : 'Discard changes' }}</v-btn></v-card-actions></v-card></v-dialog>
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
    }
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
      return (value: string) => value.trim().length > 0 || 'Name is required.'
    },
    httpsRule (): (value: string) => true | string {
      return (value: string) => isHttpsEndpoint(value) || 'Use an HTTPS endpoint URL.'
    },
    eventsRule (): (value: string) => true | string {
      return () => (this.subscribedEvents.length > 0 && this.subscribedEvents.length <= 50 && this.subscribedEvents.every(isWebhookEventName)) || 'Use 1–50 event names with lowercase words separated by dots or hyphens, or *.'
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
    deliveryLabel (delivery: WebhookDelivery): string { return delivery.responseSnippet === 'Webhook disabled before delivery' ? 'Skipped · disabled' : delivery.state },
    async sendTest () {
      if (this.webhookBusy || this.dirty || !this.savedHook?.isEnabled || !this.draft.id || this.revealedSecret) return
      this.testing = true
      this.operationError = ''
      try {
        const id = await sendWebhookTest(window.fetch.bind(window), this.draft.id)
        this.testDialog = false
        this.deliveryFilter = 'All states'
        this.deliveryQuery = ''
        this.testMessage = `Test queued. Delivery ${id}. Refresh to see the result.`
        await this.loadDeliveries()
      } catch (error) { this.reportError(error) } finally { this.testing = false }
    },
    reportError (error: unknown) { this.operationError = error instanceof Error ? error.message : String(error); wikiStore.showError(error) },
    async copySecret () {
      try {
        await navigator.clipboard.writeText(this.revealedSecret)
        this.secretCopied = true
      } catch {
        wikiStore.showNotification({ style: 'red', message: 'Copy failed. Select the secret and copy it manually.', icon: 'alert' })
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
        wikiStore.showNotification({ style: 'success', message: 'Webhook saved.', icon: 'check' })
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
        wikiStore.showNotification({ style: 'success', message: action === 'retry' ? 'Delivery queued for retry.' : 'Delivery cancelled.', icon: 'check' })
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
.webhook-admin { padding-bottom: calc(var(--wiki-footer-height) + 3rem) !important; }
.webhook-admin :deep(button) { scroll-margin-block: 6rem; }
.webhook-workspace { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: clamp(1.5rem, 3vw, 3rem); align-items: start; }
.endpoint-directory { border-right: 1px solid var(--wiki-surface-border); padding-right: 1.5rem; min-width: 0; }
.directory-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.directory-heading h2 { font: 500 1.2rem var(--wiki-font-display); }
.directory-heading h2 span { font: 400 .8rem var(--wiki-font-body); }.directory-toggle { display: none; }
.endpoint-list { display: grid; gap: .5rem; margin-top: 1rem; }
.endpoint-choice { background: transparent; color: inherit; display: block; text-align: left; width: 100%; padding: 1rem; border: 1px solid transparent; border-radius: var(--wiki-control-radius); transition: background .15s; }
.endpoint-choice:hover { background: var(--wiki-surface-raised); }
.endpoint-choice.selected { border-color: var(--wiki-surface-border); background: var(--wiki-surface-raised); box-shadow: inset 3px 0 var(--wiki-accent-ink); }
.endpoint-choice:focus-visible, summary:focus-visible, .event-option input:focus-visible { outline: 2px solid var(--wiki-accent-ink); outline-offset: 3px; }
.endpoint-choice-top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.endpoint-choice strong { font-size: .85rem; overflow-wrap: anywhere; }
.endpoint-address, .endpoint-meta { display: block; font-size: .75rem; margin-top: .4rem; overflow-wrap: anywhere; }
.directory-note, .directory-empty { font-size: .75rem; line-height: 1.7; margin-top: 1.5rem; }
.directory-note { border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; }
.endpoint-main { min-width: 0; }
.endpoint-heading, .deliveries-heading, .endpoint-maintenance { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
.endpoint-heading h2, .endpoint-welcome h2 { font: 500 clamp(1.6rem, 2.5vw, 2.3rem) var(--wiki-font-display); margin-block: .5rem; overflow-wrap: anywhere; }
.endpoint-heading p { overflow-wrap: anywhere; }
.webhook-kicker { font-size: .7rem; text-transform: uppercase; letter-spacing: .09em; color: var(--wiki-accent-ink); }
p { font-size: .85rem; line-height: 1.7; margin-bottom: 1rem; }
h3 { font: 500 1.35rem var(--wiki-font-display); margin-block: .5rem .75rem; }
h4 { font-size: .85rem; margin-bottom: .75rem; }
.webhook-tabs { border-bottom: 1px solid var(--wiki-surface-border); margin: .75rem 0 1.5rem; }
.webhook-panel { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); padding: clamp(1rem, 2vw, 1.75rem); background: var(--wiki-surface-raised); }
.field-note { font-size: .75rem; margin-top: .4rem; }
.event-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-block: 1.5rem; }
.event-groups fieldset { border: 0; min-width: 0; }
.event-groups legend { font-size: .8rem; font-weight: 600; margin-bottom: .75rem; }
.event-option { display: flex; align-items: start; gap: .75rem; padding-block: .75rem; border-top: 1px solid var(--wiki-surface-border); cursor: pointer; }
.event-option input { margin-top: .25rem; accent-color: rgb(var(--v-theme-primary)); width: 1rem; height: 1rem; flex-shrink: 0; }
.event-option strong, .event-option small, .event-option code { display: block; }
.event-option strong { font-size: .8rem; font-weight: 500; }.event-option small { font-size: .75rem; line-height: 1.6; margin-block: .2rem; }.event-option code { font-size: .68rem; overflow-wrap: anywhere; }
.custom-events { padding-top: 1rem; border-top: 1px solid var(--wiki-surface-border); }.custom-events summary { font-size: .85rem; cursor: pointer; padding-bottom: 1rem; }
.webhook-savebar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-control-radius); margin-top: 1rem; position: sticky; bottom: var(--wiki-footer-height); z-index: 2; }.webhook-savebar > span { font-size: .8rem; }
.webhook-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.endpoint-maintenance { margin-top: 2rem; border-top: 1px solid var(--wiki-surface-border); padding-top: 1rem; }.endpoint-maintenance h3 { font-size: 1.05rem; }.endpoint-maintenance p { font-size: .8rem; }
.deliveries-heading { margin-bottom: 1rem; }.deliveries-heading > div:first-child { max-width: 55ch; }.deliveries-heading .webhook-actions { flex-shrink: 0; }
.delivery-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 1rem; margin-bottom: 1rem; }
.delivery-record { border-bottom: 1px solid var(--wiki-surface-border); }.delivery-record summary { display: grid; grid-template-columns: minmax(0, 1fr) 100px 120px auto 18px; gap: 1rem; align-items: center; cursor: pointer; padding: 1.1rem .5rem; font-size: .75rem; list-style: none; }.delivery-record summary::-webkit-details-marker { display: none; }.delivery-record summary strong { font-weight: 500; font-size: .8rem; overflow-wrap: anywhere; }.delivery-record summary small { display: block; font-size: .7rem; margin-top: .4rem; }.delivery-record[open] summary > .v-icon { transform: rotate(180deg); }
.delivery-detail { padding: 1rem; background: var(--wiki-surface-raised); }.delivery-detail dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }.delivery-detail dt { font-size: .7rem; margin-bottom: .4rem; }.delivery-detail dd { margin: 0; font-size: .8rem; overflow-wrap: anywhere; }.delivery-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; max-height: 240px; overflow: auto; }
.webhook-empty { text-align: center; padding: 3rem 1.5rem; }.webhook-empty p { max-width: 55ch; margin-inline: auto; }.endpoint-welcome { padding-block: 4rem; }.endpoint-welcome p { margin-block: 1.5rem; }
.webhook-secret { display: block; margin-top: .75rem; overflow-wrap: anywhere; user-select: all; }
@media(max-width: 1250px) { .webhook-workspace { grid-template-columns: 230px minmax(0, 1fr); }.endpoint-directory { padding-right: 1rem; }.deliveries-heading, .endpoint-maintenance { flex-direction: column; }.delivery-record summary { grid-template-columns: minmax(0, 1fr) auto 18px; }.delivery-record summary > span:nth-child(2), .delivery-http { display: none; } }
@media(max-width: 900px) { .directory-toggle { display: inline-flex; }.directory-content:not(.expanded) { display: none; }.directory-heading { margin-bottom: 0; }.directory-content.expanded { margin-top: 1rem; } .webhook-workspace { grid-template-columns: 1fr; }.endpoint-directory { border-right: 0; border-bottom: 1px solid var(--wiki-surface-border); padding: 0 0 1.5rem; }.endpoint-list { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 280px; overflow-y: auto; }.directory-note { display: none; } }
@media(max-width: 600px) { .event-groups, .delivery-toolbar, .delivery-detail dl { grid-template-columns: 1fr; }.webhook-savebar { position: static; flex-direction: column; align-items: stretch; }.endpoint-heading { flex-wrap: wrap; }.endpoint-list { grid-template-columns: 1fr; max-height: 220px; }.delivery-record summary { gap: .5rem; } }
</style>

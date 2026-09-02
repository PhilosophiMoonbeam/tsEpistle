<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          :title='$t(`admin:webhooks.title`)'
          :description='$t(`admin:webhooks.subtitle`)'
          icon='/_assets/svg/icon-winter.svg'
        )
          template(v-slot:actions)
            .admin-webhook-actions.d-flex.align-center.flex-wrap.ga-2
              v-btn(color='primary', variant="flat", @click='newHook', :disabled='webhookBusy || Boolean(revealedSecret) || (!draft.id && editorVisible)')
                v-icon(start) mdi-plus
                span New webhook

      v-col(cols='12', lg='4')
        v-card(border)
          v-card-title.d-flex.align-center.flex-wrap.ga-2
            v-icon.mr-2(color='primary') mdi-webhook
            span Endpoints
            v-spacer
            v-chip(v-if='loadState === `success`', label, size="small", :color='hooks.length ? `success` : `info`') {{ hooks.length ? `${hooks.length} configured` : 'Not configured' }}
          v-divider
          v-skeleton-loader(v-if='loadState === `loading`', type='list-item-two-line@3')
          v-alert.ma-3(v-else-if='loadState === `error`', type='error', variant="tonal", icon='mdi-alert')
            span Unable to load webhooks.
            v-btn.ml-2(variant="text", size="small", @click='loadHooks') Retry
          v-list(v-else-if='hooks.length', lines='two')
            v-list-item(
              v-for='item in hooks'
              :key='item.id'
              :active='draft.id === item.id'
              :aria-current='draft.id === item.id ? "true" : undefined'
              :disabled='webhookBusy || Boolean(revealedSecret)'
              :aria-disabled='webhookBusy || Boolean(revealedSecret) ? `true` : undefined'
              @click='selectHook(item)'
            )
              template(v-slot:prepend)
                v-icon(:color='item.isEnabled ? `success` : `grey`') {{ item.isEnabled ? 'mdi-check-circle' : 'mdi-pause-circle' }}
              v-list-item-title {{ item.name }}
              v-list-item-subtitle {{ item.url }}
              template(v-slot:append)
                v-chip(label, size="x-small", :color='item.isEnabled ? `success` : `warning`') {{ item.isEnabled ? 'Enabled' : 'Disabled' }}
          v-card-text(v-else)
            v-alert(type='info', variant='tonal') No webhook endpoints configured. Use New webhook to add one.

      v-col(cols='12', lg='8')
        v-card(v-if='editorVisible', border)
          v-card-title.d-flex.align-center.flex-wrap.ga-2
            span {{ draft.id ? 'Edit webhook' : 'New webhook' }}
            v-spacer
            v-progress-circular(v-if='saving', indeterminate, size='22', color='primary', aria-label='Saving webhook')
          v-divider
          v-card-text
            v-alert(v-if='revealedSecret', type='warning', variant='tonal')
              strong One-time signing secret
              span.ml-1 Copy it now; it will not be shown again.
              code.webhook-secret {{ revealedSecret }}
              .d-flex.align-center.flex-wrap.ga-2.mt-3
                v-btn(variant="outlined", color='warning', @click='copySecret')
                  v-icon(start) mdi-content-copy
                  span {{ secretCopied ? 'Copied' : 'Copy secret' }}
                v-btn(color='warning', variant="flat", @click='finishSecret') I’ve saved this secret
            v-form(ref='webhookForm', @submit.prevent='save')
              v-text-field(ref='webhookNameInput', v-model='draft.name', label='Name', maxlength='128', variant="outlined", :rules='[requiredRule]', :disabled='webhookBusy')
              v-text-field(ref='webhookUrlInput', v-model='draft.url', label='HTTPS endpoint URL', placeholder='https://hooks.example.com/wiki', type='url', variant="outlined", :rules='[httpsRule]', :disabled='webhookBusy')
              v-textarea(
                ref='webhookEventsInput'
                v-model='eventsText'
                label='Subscribed events'
                hint='One event per line. Use * for every event.'
                persistent-hint
                rows='4'
                variant="outlined"
                :rules='[eventsRule]'
                :disabled='webhookBusy'
              )
              v-switch(v-model='draft.isEnabled', color='success', label='Enabled', :disabled='webhookBusy')
              .d-flex.flex-wrap.ga-2.mt-3
                v-btn(color='primary', variant="flat", type='submit', :loading='saving', :disabled='webhookBusy || !isWebhookValid')
                  v-icon(start) mdi-content-save
                  span Save
                v-btn(v-if='draft.id', variant='outlined', @click='rotateDialog = true', :loading='rotating', :disabled='webhookBusy || Boolean(revealedSecret)')
                  v-icon(start) mdi-key-change
                  span Rotate secret
                v-btn(v-if='draft.id', color='error', variant='outlined', @click='deleteDialog = true', :disabled='webhookBusy || Boolean(revealedSecret)')
                  v-icon(start) mdi-delete
                  span Delete

        v-card.mt-4(v-if='draft.id', border)
          v-card-title.d-flex.align-center.flex-wrap.ga-2
            span Recent deliveries
            v-spacer
            v-btn(icon='mdi-refresh', variant='text', aria-label='Refresh deliveries', @click='loadDeliveries', :loading='deliveryLoading', :disabled='deliveryLoading || Boolean(deliveryBusy)')
          v-divider
          v-skeleton-loader(v-if='deliveryLoading && !deliveries.length', type='table-tbody')
          v-alert.ma-3(v-if='deliveryError', type='error', variant="tonal", icon='mdi-alert')
            span Unable to load deliveries.
            v-btn.ml-2(variant="text", size="small", @click='loadDeliveries', :disabled='deliveryLoading || Boolean(deliveryBusy)') Retry
          template(v-if='deliveries.length || (!deliveryLoading && !deliveryError)')
            v-table(v-if='deliveries.length && $vuetify.display.mdAndUp')
              thead
                tr
                  th(scope='col') Event
                  th(scope='col') State
                  th(scope='col') Attempts
                  th(scope='col') HTTP
                  th(scope='col') Created
                  th(scope='col') Actions
              tbody
                tr(v-for='delivery in deliveries', :key='delivery.id')
                  td {{ delivery.eventType }} v{{ delivery.eventVersion }}
                  td
                    v-chip(size='small', :color='stateColor(delivery.state)') {{ delivery.state }}
                  td {{ delivery.attempts }} / {{ delivery.maxAttempts }}
                  td {{ delivery.statusCode || '—' }}
                  td {{ $helpers.formatMoment(delivery.createdAt, 'calendar') }}
                  td
                    v-btn(v-if='delivery.state === `failed`', variant='outlined', size='small', @click='changeDelivery(delivery.id, `retry`)', :loading='deliveryBusy === delivery.id', :disabled='Boolean(deliveryBusy)') Retry
                    v-btn.ml-2(v-if='delivery.state === `pending` || delivery.state === `running`', variant='outlined', color='error', size='small', @click='requestDeliveryCancel(delivery.id)', :disabled='Boolean(deliveryBusy)') Cancel
            div(v-else-if='deliveries.length')
              .admin-mobile-record(v-for='delivery in deliveries', :key='`mobile-delivery-` + delivery.id')
                .d-flex.align-center
                  .admin-mobile-record-title {{ delivery.eventType }} v{{ delivery.eventVersion }}
                  v-spacer
                  v-chip(size='small', :color='stateColor(delivery.state)') {{ delivery.state }}
                .admin-mobile-record-meta {{ delivery.attempts }} / {{ delivery.maxAttempts }} attempts · HTTP {{ delivery.statusCode || '—' }}
                .text-body-small.text-grey.mt-2 {{ $helpers.formatMoment(delivery.createdAt, 'calendar') }}
                .d-flex.flex-wrap.ga-2.mt-2
                  v-btn(v-if='delivery.state === `failed`', variant='outlined', size='small', @click='changeDelivery(delivery.id, `retry`)', :loading='deliveryBusy === delivery.id', :disabled='Boolean(deliveryBusy)') Retry
                  v-btn(v-if='delivery.state === `pending` || delivery.state === `running`', variant='outlined', color='error', size='small', @click='requestDeliveryCancel(delivery.id)', :disabled='Boolean(deliveryBusy)') Cancel
            v-card-text(v-if='!deliveries.length')
              .text-center.text-medium-emphasis No deliveries yet.

    v-dialog(v-model='deleteDialog', max-width='480', persistent, aria-labelledby='delete-webhook-dialog-title')
      v-card
        .dialog-header.is-red
          span#delete-webhook-dialog-title Delete webhook?
        v-card-text Existing delivery history for {{ draft.name || 'this endpoint' }} ({{ draft.url || 'the selected URL' }}) will also be removed.
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='deleteDialog = false', :disabled='deleting') Cancel
          v-btn(color='error', @click='removeHook', :loading='deleting', :disabled='deleting') Delete
    v-dialog(v-model='rotateDialog', max-width='500', persistent, aria-labelledby='rotate-webhook-dialog-title')
      v-card
        .dialog-header.is-red
          span#rotate-webhook-dialog-title Rotate webhook secret?
        v-card-text The old signing secret for {{ draft.name || 'this webhook' }} will stop working immediately. Continue?
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='rotateDialog = false', :disabled='rotating') Cancel
          v-btn(color='error', @click='rotateSecret', :loading='rotating', :disabled='rotating') Rotate secret
    v-dialog(v-model='cancelDeliveryDialog', max-width='500', persistent, aria-labelledby='cancel-webhook-delivery-dialog-title')
      v-card
        .dialog-header.is-red
          span#cancel-webhook-delivery-dialog-title Cancel webhook delivery?
        v-card-text
          | The delivery of 
          strong {{ cancelDelivery ? `${cancelDelivery.eventType} v${cancelDelivery.eventVersion}` : 'this event' }}
          |  will be stopped and cannot resume. Continue?
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='cancelDeliveryDialog = false', :disabled='Boolean(deliveryBusy)') Keep delivery
          v-btn(color='error', @click='confirmDeliveryCancel', :loading='Boolean(deliveryBusy)', :disabled='Boolean(deliveryBusy)') Cancel delivery
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import {
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

const emptyDraft = (): WebhookDraft => ({ id: null, name: '', url: '', isEnabled: true })
const isHttpsEndpoint = (value: string): boolean => {
  try {
    return new URL(value.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

export default {
  data() {
    return {
      hooks: [] as AdminWebhook[],
      deliveries: [] as WebhookDelivery[],
      draft: emptyDraft(),
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
  computed: {
    webhookBusy (): boolean {
      return this.saving || this.rotating || this.deleting || Boolean(this.deliveryBusy)
    },
    subscribedEvents (): string[] {
      return this.eventsText.split(/\r?\n/).map(event => event.trim()).filter(Boolean)
    },
    isWebhookValid (): boolean {
      return this.draft.name.trim().length > 0 && isHttpsEndpoint(this.draft.url) && this.subscribedEvents.length > 0
    },
    requiredRule (): (value: string) => true | string {
      return (value: string) => value.trim().length > 0 || 'Name is required.'
    },
    httpsRule (): (value: string) => true | string {
      return (value: string) => isHttpsEndpoint(value) || 'Use an HTTPS endpoint URL.'
    },
    eventsRule (): (value: string) => true | string {
      return () => this.subscribedEvents.length > 0 || 'Subscribe to at least one event.'
    },
    cancelDelivery (): WebhookDelivery | null {
      return this.deliveries.find(delivery => delivery.id === this.cancelDeliveryId) || null
    }
  },
  methods: {
    async copySecret () {
      try {
        await navigator.clipboard.writeText(this.revealedSecret)
        this.secretCopied = true
      } catch {
        wikiStore.showNotification({ style: 'red', message: 'Copy failed. Select the secret and copy it manually.', icon: 'alert' })
      }
    },
    finishSecret () {
      this.revealedSecret = ''
      this.secretCopied = false
    },
    async loadHooks (): Promise<boolean> {
      const token = ++this.hooksLoadToken
      this.loadState = 'loading'
      try {
        const hooks = await fetchWebhooks(window.fetch.bind(window))
        if (token !== this.hooksLoadToken) return false
        this.hooks = hooks
        this.loadState = 'success'
        if (!this.editorVisible && this.hooks.length) this.selectHook(this.hooks[0])
        return true
      } catch (error) {
        if (token !== this.hooksLoadToken) return false
        this.loadState = 'error'
        wikiStore.showError(error)
        return false
      }
    },
    newHook () {
      this.editorVisible = true
      this.deliveryLoadToken++
      this.draft = emptyDraft()
      this.eventsText = 'page.created\npage.updated\npage.deleted'
      this.deliveries = []
      this.deliveryLoading = false
      this.deliveryError = false
      this.revealedSecret = ''
      this.secretCopied = false
      this.$nextTick(() => {
        ;(this.$refs.webhookNameInput as { focus?: () => void })?.focus?.()
      })
    },
    selectHook (hook: AdminWebhook) {
      const selectionChanged = this.draft.id !== hook.id
      this.editorVisible = true
      this.draft = { id: hook.id, name: hook.name, url: hook.url, isEnabled: hook.isEnabled }
      this.eventsText = hook.events.join('\n')
      if (selectionChanged) this.deliveries = []
      this.deliveryError = false
      this.revealedSecret = ''
      this.secretCopied = false
      this.loadDeliveries()
    },
    async save () {
      if (this.saving) return
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
        }
        this.draft.name = input.name
        this.draft.url = input.url
        await this.loadHooks()
        wikiStore.showNotification({ style: 'success', message: 'Webhook saved.', icon: 'check' })
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.saving = false
      }
    },
    async rotateSecret () {
      if (!this.draft.id || this.rotating) return
      this.rotateDialog = false
      this.rotating = true
      try {
        this.revealedSecret = await rotateWebhookSecret(window.fetch.bind(window), this.draft.id)
        this.secretCopied = false
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.rotating = false
      }
    },
    async removeHook () {
      if (!this.draft.id || this.deleting) return
      this.deleting = true
      try {
        await deleteWebhook(window.fetch.bind(window), this.draft.id)
        this.deleteDialog = false
        this.newHook()
        if (await this.loadHooks()) {
          if (this.hooks.length) this.selectHook(this.hooks[0])
          else this.editorVisible = false
        }
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.deleting = false
      }
    },
    async loadDeliveries () {
      if (!this.draft.id) return
      const selectedId = this.draft.id
      const token = ++this.deliveryLoadToken
      this.deliveryLoading = true
      this.deliveryError = false
      try {
        const rows = await fetchWebhookDeliveries(window.fetch.bind(window), selectedId)
        if (this.draft.id === selectedId && token === this.deliveryLoadToken) this.deliveries = rows
      } catch (error) {
        if (this.draft.id === selectedId && token === this.deliveryLoadToken) {
          this.deliveryError = true
          wikiStore.showError(error)
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
      if (this.deliveryBusy) return
      this.deliveryBusy = id
      try {
        await changeWebhookDelivery(window.fetch.bind(window), id, action)
        await this.loadDeliveries()
        wikiStore.showNotification({ style: 'success', message: action === 'retry' ? 'Delivery queued for retry.' : 'Delivery cancelled.', icon: 'check' })
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.deliveryBusy = ''
      }
    },
    stateColor (state: string): string {
      if (state === 'succeeded') return 'success'
      if (state === 'failed') return 'error'
      if (state === 'running') return 'primary'
      if (state === 'cancelled') return 'grey'
      return 'warning'
    }
  },
  created () {
    this.loadHooks()
  },
  beforeUnmount () {
    this.hooksLoadToken++
    this.deliveryLoadToken++
  }
}
</script>

<style lang='scss'>
.webhook-secret {
  display: block;
  margin-top: 8px;
  overflow-wrap: anywhere;
  user-select: all;
}

@media (max-width: 959px) {
  .admin-webhook-actions {
    flex-basis: 100%;
  }

  .admin-webhook-actions .v-btn {
    flex: 1;
  }
}
</style>

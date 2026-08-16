<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-winter.svg', alt='Webhooks', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:webhooks.title') }}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{ $t('admin:webhooks.subtitle') }}
          v-spacer
          v-btn(color='primary', variant="flat", @click='newHook')
            v-icon(start) mdi-plus
            span New webhook

      v-col(cols='12', lg='4')
        v-card(border)
          v-card-title
            v-icon.mr-2(color='primary') mdi-webhook
            span Endpoints
          v-divider
          v-list(v-if='hooks.length', lines='two')
            v-list-item(
              v-for='item in hooks'
              :key='item.id'
              :active='draft.id === item.id'
              @click='selectHook(item)'
            )
              template(v-slot:prepend)
                v-icon(:color='item.isEnabled ? `success` : `grey`') {{ item.isEnabled ? 'mdi-check-circle' : 'mdi-pause-circle' }}
              v-list-item-title {{ item.name }}
              v-list-item-subtitle {{ item.url }}
          v-card-text(v-else)
            v-alert(type='info', variant='tonal') No webhook endpoints configured.

      v-col(cols='12', lg='8')
        v-card(border)
          v-card-title
            span {{ draft.id ? 'Edit webhook' : 'New webhook' }}
            v-spacer
            v-progress-circular(v-if='loading', indeterminate, size='22', color='primary', aria-label='Saving webhook')
          v-divider
          v-card-text
            v-alert(v-if='revealedSecret', type='warning', variant='tonal', closable, @click:close='revealedSecret = ``')
              strong Copy this signing secret now. It will not be shown again.
              code.webhook-secret {{ revealedSecret }}
            v-form(@submit.prevent='save')
              v-text-field(v-model='draft.name', label='Name', maxlength='128', required)
              v-text-field(v-model='draft.url', label='HTTPS endpoint URL', placeholder='https://hooks.example.com/wiki', required)
              v-textarea(
                v-model='eventsText'
                label='Subscribed events'
                hint='One event per line. Use * for every event.'
                persistent-hint
                rows='4'
              )
              v-switch(v-model='draft.isEnabled', color='success', label='Enabled')
              .d-flex.flex-wrap.ga-2.mt-3
                v-btn(color='primary', variant="flat", type='submit', :loading='saving')
                  v-icon(start) mdi-content-save
                  span Save
                v-btn(v-if='draft.id', variant='outlined', @click='rotateSecret', :loading='rotating')
                  v-icon(start) mdi-key-change
                  span Rotate secret
                v-btn(v-if='draft.id', color='error', variant='outlined', @click='deleteDialog = true')
                  v-icon(start) mdi-delete
                  span Delete

        v-card.mt-4(v-if='draft.id', border)
          v-card-title
            span Recent deliveries
            v-spacer
            v-btn(icon='mdi-refresh', variant='text', aria-label='Refresh deliveries', @click='loadDeliveries')
          v-divider
          v-table
            thead
              tr
                th Event
                th State
                th Attempts
                th HTTP
                th Created
                th Actions
            tbody
              tr(v-for='delivery in deliveries', :key='delivery.id')
                td {{ delivery.eventType }} v{{ delivery.eventVersion }}
                td
                  v-chip(size='small', :color='stateColor(delivery.state)') {{ delivery.state }}
                td {{ delivery.attempts }} / {{ delivery.maxAttempts }}
                td {{ delivery.statusCode || '—' }}
                td {{ $helpers.formatMoment(delivery.createdAt, 'calendar') }}
                td
                  v-btn(
                    v-if='delivery.state === `failed`'
                    icon='mdi-refresh'
                    size='small'
                    variant='text'
                    aria-label='Retry delivery'
                    @click='changeDelivery(delivery.id, `retry`)'
                  )
                  v-btn(
                    v-if='delivery.state === `pending` || delivery.state === `running`'
                    icon='mdi-cancel'
                    size='small'
                    variant='text'
                    color='error'
                    aria-label='Cancel delivery'
                    @click='changeDelivery(delivery.id, `cancel`)'
                  )
              tr(v-if='!deliveries.length')
                td.text-center.text-medium-emphasis(colspan='6') No deliveries yet.

    v-dialog(v-model='deleteDialog', max-width='480')
      v-card
        v-card-title Delete webhook?
        v-card-text Existing delivery history for this endpoint will also be removed.
        v-card-actions
          v-spacer
          v-btn(variant='text', @click='deleteDialog = false') Cancel
          v-btn(color='error', @click='removeHook', :loading='deleting') Delete</template>

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

export default {
  data() {
    return {
      hooks: [] as AdminWebhook[],
      deliveries: [] as WebhookDelivery[],
      draft: emptyDraft(),
      eventsText: 'page.created\npage.updated\npage.deleted',
      revealedSecret: '',
      loading: false,
      saving: false,
      rotating: false,
      deleting: false,
      deleteDialog: false
    }
  },
  methods: {
    async loadHooks () {
      this.loading = true
      try {
        this.hooks = await fetchWebhooks(window.fetch.bind(window))
        if (!this.draft.id && this.hooks.length) this.selectHook(this.hooks[0])
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.loading = false
      }
    },
    newHook () {
      this.draft = emptyDraft()
      this.eventsText = 'page.created\npage.updated\npage.deleted'
      this.deliveries = []
      this.revealedSecret = ''
    },
    selectHook (hook: AdminWebhook) {
      this.draft = { id: hook.id, name: hook.name, url: hook.url, isEnabled: hook.isEnabled }
      this.eventsText = hook.events.join('\n')
      this.revealedSecret = ''
      this.loadDeliveries()
    },
    events (): string[] {
      return [...new Set(this.eventsText.split(/[\n,]/).map(value => value.trim()).filter(Boolean))]
    },
    async save () {
      this.saving = true
      try {
        const input = {
          name: this.draft.name,
          url: this.draft.url,
          events: this.events(),
          isEnabled: this.draft.isEnabled
        }
        if (this.draft.id) {
          await updateWebhook(window.fetch.bind(window), this.draft.id, input)
        } else {
          const created = await createWebhook(window.fetch.bind(window), input)
          this.draft.id = created.id
          this.revealedSecret = created.secret
        }
        await this.loadHooks()
        wikiStore.showNotification({ style: 'success', message: 'Webhook saved.', icon: 'check' })
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.saving = false
      }
    },
    async rotateSecret () {
      if (!this.draft.id) return
      this.rotating = true
      try {
        this.revealedSecret = await rotateWebhookSecret(window.fetch.bind(window), this.draft.id)
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.rotating = false
      }
    },
    async removeHook () {
      if (!this.draft.id) return
      this.deleting = true
      try {
        await deleteWebhook(window.fetch.bind(window), this.draft.id)
        this.deleteDialog = false
        this.newHook()
        await this.loadHooks()
      } catch (error) {
        wikiStore.showError(error)
      } finally {
        this.deleting = false
      }
    },
    async loadDeliveries () {
      if (!this.draft.id) return
      try {
        this.deliveries = await fetchWebhookDeliveries(window.fetch.bind(window), this.draft.id)
      } catch (error) {
        wikiStore.showError(error)
      }
    },
    async changeDelivery (id: string, action: 'retry' | 'cancel') {
      try {
        await changeWebhookDelivery(window.fetch.bind(window), id, action)
        await this.loadDeliveries()
      } catch (error) {
        wikiStore.showError(error)
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
</style>

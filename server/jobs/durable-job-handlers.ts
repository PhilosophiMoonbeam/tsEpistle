import type { ContentExtensionRerenderContext } from '../content-extensions/rerender.ts'
import { type DurableJobHandler } from '../core/durable-jobs.ts'
import { decryptWebhookSecret, resolveWebhookUrl, sendSignedWebhook, WebhookDeliveryError } from '../core/webhooks.ts'
import { createContentExtensionRerenderHandler } from './content-extension-rerender.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from './page-watch-notification.ts'
import { cleanupSiteLogoRevisions, createSiteLogoProcessHandler } from './site-logo-process.ts'

const cleanupRetentionMs = 30 * 24 * 60 * 60 * 1_000

export const cleanupDurableJobs: DurableJobHandler = async (_job, { knex, signal }) => {
  const before = new Date(Date.now() - cleanupRetentionMs)
  signal.throwIfAborted()
  await knex('durableJobs').whereIn('state', ['succeeded', 'failed', 'cancelled']).where('completedAt', '<', before).delete()
}

export const createWebhookDeliveryHandler =
  (sessionSecret: string): DurableJobHandler =>
  async (job, { knex, signal }) => {
    signal.throwIfAborted()
    const deliveryId = job.payload.deliveryId
    const eventId = job.payload.eventId
    const webhookId = job.payload.webhookId
    if (typeof deliveryId !== 'string' || typeof eventId !== 'string' || typeof webhookId !== 'string') {
      throw new TypeError('Webhook delivery job payload is invalid')
    }

    const delivery = await knex('webhookDeliveries').where({ id: deliveryId, eventId, webhookId }).first()
    if (!delivery || delivery.deliveredAt) return
    const webhook = await knex('webhooks').where('id', webhookId).first()
    if (!webhook) return
    if (!webhook.isEnabled) {
      signal.throwIfAborted()
      const now = new Date()
      await knex('webhookDeliveries').where('id', deliveryId).update({
        statusCode: 204,
        responseSnippet: 'Webhook disabled before delivery',
        deliveredAt: now
      })
      return
    }
    const event = await knex('outboxEvents').where('id', eventId).first()
    if (!event) return
    const payload: unknown = JSON.parse(String(event.payload))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError(`Outbox event ${eventId} payload must be an object`)
    }

    try {
      const target = await resolveWebhookUrl(String(webhook.url))
      signal.throwIfAborted()
      const result = await sendSignedWebhook({
        deliveryId,
        eventId,
        eventType: String(event.type),
        eventVersion: Number(event.version),
        eventCreatedAt: new Date(event.createdAt),
        payload: payload as Record<string, unknown>,
        secret: decryptWebhookSecret(String(webhook.secretCiphertext), sessionSecret),
        target,
        signal
      })
      signal.throwIfAborted()
      await knex('webhookDeliveries').where('id', deliveryId).update({
        statusCode: result.statusCode,
        responseSnippet: result.responseSnippet,
        deliveredAt: new Date()
      })
    } catch (error) {
      signal.throwIfAborted()
      await knex('webhookDeliveries')
        .where('id', deliveryId)
        .update({
          statusCode: error instanceof WebhookDeliveryError ? error.statusCode : null,
          responseSnippet: error instanceof WebhookDeliveryError ? error.responseSnippet : String(error)
        })
      throw error
    }
  }

export const createDurableJobHandlers = (
  sessionSecret: string,
  wiki: PageWatchWikiContext & ContentExtensionRerenderContext
): Readonly<Record<string, DurableJobHandler>> =>
  Object.freeze({
    'cleanup-durable-jobs@1': cleanupDurableJobs,
    'cleanup-site-logo@1': cleanupSiteLogoRevisions,
    'process-site-logo@1': createSiteLogoProcessHandler(1),
    'process-site-logo@2': createSiteLogoProcessHandler(2),
    'process-site-logo@3': createSiteLogoProcessHandler(3),
    'rerender-content-extension@1': createContentExtensionRerenderHandler(wiki),
    'deliver-webhook@1': createWebhookDeliveryHandler(sessionSecret),
    'notify-page-watcher@1': createPageWatchNotificationHandler(wiki)
  })

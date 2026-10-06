import { createLocalePackageHandler } from './locale-package.ts'
import { createStorageActionHandler } from './storage-action.ts'
import type { DurableJobIdentity } from '../../shared/durable-job-catalog.ts'
import type { Knex } from 'knex'
import type { ContentExtensionRerenderContext } from '../content-extensions/rerender.ts'
import { DurableJobStore } from '../core/durable-jobs.ts'
import type { DurableJobHandler } from '../core/durable-jobs.ts'
import {
  decryptWebhookSecret,
  isCommentWebhookPageEligible,
  projectCommentWebhookPayload,
  resolveWebhookUrl,
  sendSignedWebhook,
  WebhookDeliveryError
} from '../core/webhooks.ts'
import { isCommentWebhookEventName, type CommentWebhookEventName } from '../../shared/webhook-events.ts'
import { pageAuthorizationContext, type PagePrincipal } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import type { WikiAuth } from '../controllers/_types.ts'
import { createContentExtensionRerenderHandler } from './content-extension-rerender.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from './page-watch-notification.ts'
import { cleanupSiteLogoRevisions, createSiteLogoProcessHandler } from './site-logo-process.ts'
import { createAssetRelocationHandler } from './asset-relocation.ts'

const cleanupRetentionMs = 30 * 24 * 60 * 60 * 1_000
const cleanupBatchSize = 500

export const cleanupDurableJobs: DurableJobHandler = async (job, { knex, signal }) => {
  const before = new Date(Date.now() - cleanupRetentionMs)
  signal.throwIfAborted()
  await knex.transaction(async transaction => {
    const query = transaction('durableJobs').whereIn('state', ['succeeded', 'failed', 'cancelled']).where('completedAt', '<', before)
    if (await transaction.schema.hasTable('assetRelocationEffects')) {
      query.andWhere(relocationJobs => {
        relocationJobs.whereNot('durableJobs.type', 'asset-relocation').orWhereExists(successfulEffect => {
          successfulEffect
            .select(transaction.raw('1'))
            .from('assetRelocationEffects as effect')
            .whereRaw('?? = ??', ['effect.jobId', 'durableJobs.id'])
            .where('effect.status', 'succeeded')
        })
      })
    }
    const candidates = await query
      .clone()
      .select<{ id: string }[]>('id')
      .orderBy('completedAt')
      .orderBy('id')
      .limit(cleanupBatchSize + 1)
    signal.throwIfAborted()
    if (candidates.length === 0) return
    const hasMore = candidates.length > cleanupBatchSize
    if (hasMore) candidates.pop()
    await query
      .clone()
      .whereIn(
        'id',
        candidates.map(candidate => candidate.id)
      )
      .delete()
    if (hasMore) {
      // Keep deletion and its retry-deduplicated continuation atomic so failures cannot strand the backlog.
      await new DurableJobStore(transaction).enqueue({
        type: job.type,
        version: job.version,
        payload: {},
        maxAttempts: job.maxAttempts,
        deduplicationKey: `${job.type}:continuation:${job.id}`
      })
    }
    signal.throwIfAborted()
  })
}

const hasLiteralCommentSubscription = (value: unknown, eventType: string): boolean => {
  if (typeof value !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  return Array.isArray(parsed) && parsed.every(subscription => typeof subscription === 'string') && parsed.includes(eventType)
}

const suppressedWebhookDelivery = async (knex: Knex, deliveryId: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  await knex('webhookDeliveries').where('id', deliveryId).update({
    statusCode: 204,
    responseSnippet: 'Comment is no longer anonymously visible',
    deliveredAt: new Date()
  })
}

interface CommentWebhookWikiContext {
  auth: Pick<WikiAuth, 'checkPageAccess' | 'loadPageRuleAuthority'>
  config: { features: { featurePageComments: boolean } }
  data: { commentProvider?: { key?: unknown } }
  models: { users: { getGuestUser(): Promise<PagePrincipal> } }
}

const isCommentWebhookEligible = async (
  knex: Knex,
  wiki: CommentWebhookWikiContext | undefined,
  webhookId: string,
  eventType: CommentWebhookEventName,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<boolean> => {
  signal.throwIfAborted()
  if (!wiki || !wiki.config.features.featurePageComments || wiki.data.commentProvider?.key !== 'default') return false
  const pageId = Reflect.get(payload, 'pageId')
  const commentId = Reflect.get(payload, 'commentId')
  const action = Reflect.get(payload, 'action')
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    pageId < 1 ||
    typeof commentId !== 'number' ||
    !Number.isSafeInteger(commentId) ||
    commentId < 1 ||
    (action !== 'created' && action !== 'updated' && action !== 'deleted')
  )
    return false

  const currentWebhook = await knex('webhooks').where('id', webhookId).first('events', 'isEnabled')
  if (
    !currentWebhook ||
    !(currentWebhook.isEnabled === true || currentWebhook.isEnabled === 1) ||
    !hasLiteralCommentSubscription(currentWebhook.events, eventType)
  )
    return false

  const activeProviders = await knex<{ key: string }>('commentProviders').where('isEnabled', true).select('key')
  if (activeProviders.length !== 1 || activeProviders[0]?.key !== 'default') return false

  const page = await knex('pages')
    .select('id', 'visibility', 'isPublished', 'isSearchable', 'publishStartDate', 'publishEndDate', 'path', 'localeCode', 'ownerId')
    .where('id', pageId)
    .first()
  if (!page) return false
  const protection = await knex('pageAccessPasswords').where('pageId', pageId).first('pageId')
  if (!isCommentWebhookPageEligible(page, Boolean(protection))) return false
  const tagRows = await knex<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  const pageContext = pageAuthorizationContext({ ...page, tags: tagRows })
  if (!pageContext) return false

  const guest = await wiki.models.users.getGuestUser()
  if (!guest || Reflect.get(guest, 'id') !== 2 || !(Reflect.get(guest, 'isActive') === true || Reflect.get(guest, 'isActive') === 1)) return false
  Reflect.set(guest, 'ownershipUserId', null)
  const authority: PageRuleAuthority = await wiki.auth.loadPageRuleAuthority(guest)
  if (!wiki.auth.checkPageAccess(guest, ['read:pages'], pageContext, authority) || !wiki.auth.checkPageAccess(guest, ['read:comments'], pageContext, authority))
    return false
  if (eventType !== 'comment.deleted') {
    const visibleComment = await knex('comments').where({ id: commentId, pageId }).where('isHidden', false).first('id')
    if (!visibleComment) return false
  }
  signal.throwIfAborted()
  return true
}

export const createWebhookDeliveryHandler =
  (sessionSecret: string, wiki?: CommentWebhookWikiContext): DurableJobHandler =>
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
    const eventType = String(event.type)
    const commentEventType = isCommentWebhookEventName(eventType) ? eventType : undefined
    if (commentEventType !== undefined && !hasLiteralCommentSubscription(webhook.events, commentEventType)) {
      await suppressedWebhookDelivery(knex, deliveryId, signal)
      return
    }
    const payload: unknown = JSON.parse(String(event.payload))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError(`Outbox event ${eventId} payload must be an object`)
    }
    const eventPayload = payload as Record<string, unknown>
    const deliveryPayload: Record<string, unknown> =
      commentEventType !== undefined ? projectCommentWebhookPayload(commentEventType, eventPayload) : eventPayload

    try {
      const target = await resolveWebhookUrl(String(webhook.url))
      signal.throwIfAborted()
      const result = await sendSignedWebhook({
        deliveryId,
        eventId,
        eventType,
        eventVersion: Number(event.version),
        eventCreatedAt: new Date(event.createdAt),
        payload: deliveryPayload,
        ...(commentEventType !== undefined
          ? {
              commentEligibility: () => isCommentWebhookEligible(knex, wiki, webhookId, commentEventType, deliveryPayload, signal)
            }
          : {}),
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
): Readonly<Record<DurableJobIdentity, DurableJobHandler>> =>
  Object.freeze({
    'locale-package@1': createLocalePackageHandler(),
    'storage-action@1': createStorageActionHandler(),
    'cleanup-durable-jobs@1': cleanupDurableJobs,
    'cleanup-site-logo@1': cleanupSiteLogoRevisions,
    'process-site-logo@1': createSiteLogoProcessHandler(1),
    'process-site-logo@2': createSiteLogoProcessHandler(2),
    'process-site-logo@3': createSiteLogoProcessHandler(3),
    'process-site-logo@4': createSiteLogoProcessHandler(4),
    'process-site-logo@5': createSiteLogoProcessHandler(5),
    'rerender-content-extension@1': createContentExtensionRerenderHandler(wiki),
    'deliver-webhook@1': createWebhookDeliveryHandler(sessionSecret, wiki as unknown as CommentWebhookWikiContext),
    'notify-page-watcher@1': createPageWatchNotificationHandler(wiki),
    'asset-relocation@1': createAssetRelocationHandler()
  } satisfies Record<DurableJobIdentity, DurableJobHandler>)

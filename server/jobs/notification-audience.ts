import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { NotificationCategory, PageNotificationCategory } from '../../shared/site-notifications.ts'
import { DurableJobStore } from '../core/durable-jobs.ts'
import { loadNotificationComments } from './notification-access.ts'
import { commentMentionHandles } from '../helpers/comment-markdown.ts'

export interface NotificationOutboxEvent {
  id: string
  type: string
  payload: string
  createdAt: Date | string | number
}

export interface NotificationRecipient {
  userId: number
  pageId: number
  actorId: number
  actorName: string
  category: PageNotificationCategory
  commentId: number | null
  inAppEnabled: boolean
  emailEnabled: boolean
}

interface PreferenceRow {
  userId: number
  category: NotificationCategory
  inAppEnabled: boolean | number
  emailEnabled: boolean | number
}
interface WatcherRow {
  userId: number
  inAppEnabled: boolean | number
  emailEnabled: boolean | number
}
interface ParticipantRow {
  pageId: number
  authorId: number
  isHidden: boolean | number
}
interface AudienceRow {
  userId: number
}
const AUDIENCE_BATCH_SIZE = 100
const DISCUSSION_CATEGORIES: NotificationCategory[] = ['mention', 'commentReply', 'watchedPageComment']
const dbBoolean = (value: unknown): boolean => value === true || value === 1
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const eventPayload = (event: NotificationOutboxEvent): Record<string, unknown> => {
  const payload: unknown = JSON.parse(event.payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !positiveId(Reflect.get(payload, 'pageId')))
    throw new TypeError('Notification event payload is invalid')
  return payload as Record<string, unknown>
}

const pageCategory = (type: string): NotificationCategory | null => (type === 'page.created' ? 'pageCreated' : type === 'page.deleted' ? 'pageDeleted' : null)

const selectRecipients = async (
  database: Knex | Knex.Transaction,
  event: NotificationOutboxEvent,
  userIds: readonly number[]
): Promise<NotificationRecipient[]> => {
  if (userIds.length === 0) return []
  const payload = eventPayload(event)
  const pageId = Number(payload.pageId)
  const watchers = await database<WatcherRow>('pageWatchers')
    .where('pageId', pageId)
    .whereIn('userId', userIds)
    .select('userId', 'inAppEnabled', 'emailEnabled')
  const watchersByUser = new Map(watchers.map(row => [Number(row.userId), row]))
  const isDiscussion = event.type === 'discussion.comment-created'
  const category = pageCategory(event.type)
  const preferences =
    category || isDiscussion
      ? await database<PreferenceRow>('userNotificationPreferences')
          .whereIn('userId', userIds)
          .whereIn('category', isDiscussion ? DISCUSSION_CATEGORIES : [category!])
          .select('userId', 'category', 'inAppEnabled', 'emailEnabled')
      : []
  const preferencesByUser = new Map<number, Partial<Record<NotificationCategory, PreferenceRow>>>()
  for (const row of preferences) {
    const preference = preferencesByUser.get(Number(row.userId)) ?? {}
    preference[row.category] = row
    preferencesByUser.set(Number(row.userId), preference)
  }
  const channels = (userId: number, selectedCategory: NotificationCategory, watcher?: WatcherRow) => {
    const preference = preferencesByUser.get(userId)?.[selectedCategory]
    return {
      inAppEnabled: dbBoolean(preference?.inAppEnabled) && (!watcher || dbBoolean(watcher.inAppEnabled)),
      emailEnabled: dbBoolean(preference?.emailEnabled) && (!watcher || dbBoolean(watcher.emailEnabled))
    }
  }
  if (!isDiscussion) {
    if (!positiveId(payload.actorId)) throw new TypeError('Page notification actor is invalid')
    if ([payload.actorName, payload.title, payload.path, payload.localeCode, payload.visibility].some(value => typeof value !== 'string'))
      throw new TypeError('Page notification metadata is invalid')
    return userIds.flatMap(userId => {
      if (userId === payload.actorId || userId === 2) return []
      const watcher = watchersByUser.get(userId)
      // Legacy watches keep their channels, but explicit deletion preferences need the deleted-scope category.
      const watchEnabled = watcher && (dbBoolean(watcher.inAppEnabled) || dbBoolean(watcher.emailEnabled))
      const deletionPreference = category === 'pageDeleted' ? preferencesByUser.get(userId)?.pageDeleted : undefined
      const deletionEnabled = deletionPreference && (dbBoolean(deletionPreference.inAppEnabled) || dbBoolean(deletionPreference.emailEnabled))
      const selectedCategory = deletionEnabled ? 'pageDeleted' : watchEnabled ? 'pageWatch' : category
      const enabled = deletionEnabled
        ? channels(userId, 'pageDeleted')
        : watchEnabled
          ? { inAppEnabled: dbBoolean(watcher.inAppEnabled), emailEnabled: dbBoolean(watcher.emailEnabled) }
          : category
            ? channels(userId, category)
            : { inAppEnabled: false, emailEnabled: false }
      return selectedCategory && (enabled.inAppEnabled || enabled.emailEnabled)
        ? [
            {
              userId,
              pageId,
              actorId: payload.actorId as number,
              actorName: String(payload.actorName),
              category: selectedCategory,
              commentId: null,
              ...enabled
            }
          ]
        : []
    })
  }
  if (!positiveId(payload.commentId) || !positiveId(payload.actorId)) throw new TypeError('Discussion notification identity is invalid')
  const comment = (await loadNotificationComments(database, [payload.commentId])).get(payload.commentId)
  if (!comment || comment.pageId !== pageId || dbBoolean(comment.isHidden) || comment.authorId !== payload.actorId) return []
  const parent = comment.replyTo > 0 ? (await loadNotificationComments(database, [comment.replyTo])).get(comment.replyTo) : undefined
  const replyAuthorId = parent && parent.pageId === pageId && !dbBoolean(parent.isHidden) ? parent.authorId : null
  const participants = await database<ParticipantRow>('comments').where({ pageId, isHidden: false }).whereIn('authorId', userIds).distinct('authorId')
  const participantIds = participants.map(row => Number(row.authorId)).filter(id => id > 2)
  const handles = new Set(commentMentionHandles(comment.content))
  const claims =
    participantIds.length > 0 && handles.size > 0
      ? await database<{ userId: number; handle: string }>('userHandleClaims').whereIn('userId', participantIds).select('userId', 'handle')
      : []
  const mentionedIds = new Set(claims.filter(row => handles.has(row.handle)).map(row => Number(row.userId)))
  return userIds.flatMap(userId => {
    if (userId === comment.authorId || userId === 2) return []
    const watcher = watchersByUser.get(userId)
    const candidates: Array<{ category: NotificationCategory; eligible: boolean; watcher?: WatcherRow }> = [
      { category: 'mention', eligible: mentionedIds.has(userId) },
      { category: 'commentReply', eligible: replyAuthorId === userId && participantIds.includes(userId) },
      { category: 'watchedPageComment', eligible: Boolean(watcher), ...(watcher ? { watcher } : {}) }
    ]
    for (const candidate of candidates) {
      if (!candidate.eligible) continue
      const enabled = channels(userId, candidate.category, candidate.watcher)
      if (enabled.inAppEnabled || enabled.emailEnabled)
        return [{ userId, pageId, actorId: comment.authorId, actorName: comment.name, category: candidate.category, commentId: comment.id, ...enabled }]
    }
    return []
  })
}

/** Recompute current preferences and participant/mention/reply identity immediately before delivery. */
export const resolveNotificationRecipient = async (
  database: Knex | Knex.Transaction,
  event: NotificationOutboxEvent,
  userId: number
): Promise<NotificationRecipient | undefined> => (await selectRecipients(database, event, [userId]))[0]

const enqueueRecipient = async (
  transaction: Knex.Transaction,
  event: NotificationOutboxEvent,
  recipient: NotificationRecipient,
  audienceAt: Date
): Promise<void> => {
  const durableJobs = new DurableJobStore(transaction)
  const aggregated = event.type === 'page.updated' && recipient.category === 'pageWatch'
  const aggregationMs = 2 * 60 * 1_000
  const bucketStart = new Date(Math.floor(audienceAt.valueOf() / aggregationMs) * aggregationMs)
  const deliveryPayload = {
    deliveryId: randomUUID(),
    eventId: event.id,
    userId: recipient.userId,
    emailEnabled: recipient.emailEnabled,
    inAppEnabled: recipient.inAppEnabled,
    category: recipient.category,
    commentId: recipient.commentId
  }
  const job = await durableJobs.enqueue({
    type: 'notify-page-watcher',
    version: 1,
    payload: deliveryPayload,
    maxAttempts: 5,
    ...(aggregated ? { nextRunAt: new Date(bucketStart.valueOf() + aggregationMs + 5_000) } : {}),
    deduplicationKey: aggregated
      ? `page-watch-update:${recipient.userId}:${recipient.pageId}:${bucketStart.toISOString()}`
      : `page-watch:${recipient.userId}:${event.id}`
  })
  let selectedEventId = event.id
  let deliveryId = String(job.payload.deliveryId)
  if (aggregated) {
    const lockedJob = await transaction<{ payload: string; state: string }>('durableJobs').where('id', job.id).forUpdate().first()
    if (!lockedJob) throw new Error('Notification job disappeared during aggregation')
    const current: unknown = JSON.parse(lockedJob.payload)
    if (
      !current ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      typeof Reflect.get(current, 'eventId') !== 'string' ||
      typeof Reflect.get(current, 'deliveryId') !== 'string'
    )
      throw new TypeError('Aggregated notification job is invalid')
    selectedEventId = String(Reflect.get(current, 'eventId'))
    deliveryId = String(Reflect.get(current, 'deliveryId'))
    if (selectedEventId !== event.id && lockedJob.state === 'pending') {
      const previous = await transaction<NotificationOutboxEvent>('outboxEvents').where('id', selectedEventId).first('id', 'createdAt')
      if (!previous) throw new Error('Aggregated notification event is unavailable')
      const previousTime = previous.createdAt instanceof Date ? previous.createdAt.valueOf() : new Date(previous.createdAt).valueOf()
      const eventTime = event.createdAt instanceof Date ? event.createdAt.valueOf() : new Date(event.createdAt).valueOf()
      if (eventTime > previousTime || (eventTime === previousTime && event.id > previous.id)) {
        await transaction('durableJobs')
          .where({ id: job.id, state: 'pending' })
          .update({ payload: JSON.stringify({ ...deliveryPayload, deliveryId }), updatedAt: new Date() })
        selectedEventId = event.id
      }
    }
  }
  await transaction('pageWatchDeliveries')
    .insert({ id: deliveryId, eventId: selectedEventId, userId: recipient.userId, jobId: job.id, createdAt: audienceAt, deliveredAt: null, lastError: null })
    .onConflict('id')
    .merge({ eventId: selectedEventId })
}

/** One bounded keyset page. Continuations and deliveries use the existing durable notification job identity. */
export const enqueueNotificationAudience = async (
  transaction: Knex.Transaction,
  event: NotificationOutboxEvent,
  afterUserId: number,
  audienceAt: Date,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  const payload = eventPayload(event)
  const pageId = Number(payload.pageId)
  const isDiscussion = event.type === 'discussion.comment-created'
  const category = pageCategory(event.type)
  let candidates: Knex.QueryBuilder<AudienceRow, AudienceRow[]>
  if (isDiscussion) {
    candidates = transaction<AudienceRow>('userNotificationPreferences as preference')
      .whereIn('preference.category', DISCUSSION_CATEGORIES)
      .where(function () {
        this.where('preference.inAppEnabled', true).orWhere('preference.emailEnabled', true)
      })
      .where(function () {
        this.whereExists(
          transaction('pageWatchers').select('userId').where('pageId', pageId).whereRaw('?? = ??', ['pageWatchers.userId', 'preference.userId'])
        ).orWhereExists(
          transaction('comments').select('authorId').where({ pageId, isHidden: false }).whereRaw('?? = ??', ['comments.authorId', 'preference.userId'])
        )
      })
      .distinct<AudienceRow[]>('preference.userId as userId')
  } else {
    const watchers = transaction<AudienceRow>('pageWatchers')
      .where('pageId', pageId)
      .where(function () {
        this.where('inAppEnabled', true).orWhere('emailEnabled', true)
      })
      .select('userId')
    const audience = category
      ? watchers.union(
          transaction<AudienceRow>('userNotificationPreferences')
            .where('category', category)
            .where(function () {
              this.where('inAppEnabled', true).orWhere('emailEnabled', true)
            })
            .select('userId')
        )
      : watchers
    candidates = transaction.select<AudienceRow[]>('userId').from(audience.as('audience'))
  }
  const rows = await candidates
    .where(isDiscussion ? 'preference.userId' : 'userId', '>', afterUserId)
    .orderBy(isDiscussion ? 'preference.userId' : 'userId', 'asc')
    .limit(AUDIENCE_BATCH_SIZE + 1)
  const userIds = rows.slice(0, AUDIENCE_BATCH_SIZE).map(row => Number(row.userId))
  const recipients = await selectRecipients(transaction, event, userIds)
  for (const recipient of recipients) {
    signal?.throwIfAborted()
    await enqueueRecipient(transaction, event, recipient, audienceAt)
  }
  signal?.throwIfAborted()
  if (rows.length > AUDIENCE_BATCH_SIZE) {
    const nextUserId = userIds[userIds.length - 1]!
    await new DurableJobStore(transaction).enqueue({
      type: 'notify-page-watcher',
      version: 1,
      payload: { mode: 'audience', eventId: event.id, afterUserId: nextUserId, audienceAt: audienceAt.toISOString() },
      maxAttempts: 5,
      deduplicationKey: `notification-audience:${event.id}:${nextUserId}`
    })
  } else if (event.type === 'page.deleted') {
    await transaction('pageWatchers').where('pageId', pageId).delete()
  }
}

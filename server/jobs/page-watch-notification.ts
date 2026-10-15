import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { DurableJobHandler } from '../core/durable-jobs.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { canReadPage, pageRoute } from '../helpers/page-access.ts'
import type { MailPageWatchAction } from '../../shared/mail-workspace.ts'
import { NOTIFICATION_CATEGORIES } from '../../shared/site-notifications.ts'
import type { PageNotificationCategory } from '../../shared/site-notifications.ts'
import { enqueueNotificationAudience, resolveNotificationRecipient } from './notification-audience.ts'
import type { NotificationOutboxEvent } from './notification-audience.ts'
import {
  canReadDiscussionNotification,
  canReadNotificationPage,
  loadDeletedNotificationScopes,
  loadDiscussionNotificationAccess
} from './notification-access.ts'
import type { NotificationPage } from './notification-access.ts'

interface PageWatchPayload {
  deliveryId: string
  eventId: string
  userId: number
  emailEnabled: boolean
  inAppEnabled: boolean
  category: PageNotificationCategory
  commentId: number | null
}

interface PageEventPayload {
  pageId: number
  actorId: number
  actorName: string
  title: string
  path: string
  localeCode: string
  ownerId: number | null
  tags?: unknown
  visibility: 'public' | 'private'
}

export interface PageWatchWikiContext {
  config: { host: string }
  mail: {
    send(options: {
      template: 'page-watch'
      to: string
      messageId: string
      data: { action: MailPageWatchAction; actorName: string; pageTitle: string; url: string }
    }): Promise<unknown>
  }
  auth: {
    loadPageRuleAuthority(requester: Express.User | undefined): Promise<PageRuleAuthority>
  }
  models: {
    pages: { getPageFromDb(id: number): Promise<Record<string, unknown> | undefined> }
    users: {
      query(): {
        findById(id: number): {
          withGraphJoined(relation: string): {
            modifyGraph(relation: string, callback: (builder: { select(...columns: string[]): unknown }) => void): Promise<Record<string, unknown> | undefined>
          }
        }
      }
      getRootUser(): Promise<Record<string, unknown>>
    }
  }
}

const positiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

const nonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

const parseJobPayload = (value: unknown): PageWatchPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Page watch job payload must be an object')
  const category = Reflect.get(value, 'category')
  if (category !== undefined && category !== 'pageWatch' && !NOTIFICATION_CATEGORIES.some(known => known === category))
    throw new TypeError('Notification category is invalid')
  const commentId = Reflect.get(value, 'commentId')
  return {
    emailEnabled: Reflect.get(value, 'emailEnabled') === true,
    inAppEnabled: Reflect.get(value, 'inAppEnabled') === true,
    deliveryId: nonEmptyString(Reflect.get(value, 'deliveryId'), 'deliveryId'),
    eventId: nonEmptyString(Reflect.get(value, 'eventId'), 'eventId'),
    userId: positiveInteger(Reflect.get(value, 'userId'), 'userId'),
    category: category === undefined ? 'pageWatch' : (category as PageNotificationCategory),
    commentId: commentId === undefined || commentId === null ? null : positiveInteger(commentId, 'commentId')
  }
}

const parseAudiencePayload = (value: Record<string, unknown>): { eventId: string; afterUserId: number; audienceAt: Date } => {
  const afterUserId = value.afterUserId
  if (typeof afterUserId !== 'number' || !Number.isSafeInteger(afterUserId) || afterUserId < 0) throw new TypeError('Notification audience cursor is invalid')
  const audienceAt = new Date(nonEmptyString(value.audienceAt, 'audienceAt'))
  if (!Number.isFinite(audienceAt.valueOf())) throw new TypeError('Notification audience timestamp is invalid')
  return { eventId: nonEmptyString(value.eventId, 'eventId'), afterUserId, audienceAt }
}

const parseEventPayload = (value: unknown): PageEventPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Page event payload must be an object')
  const visibility = Reflect.get(value, 'visibility')
  const ownerId = Reflect.get(value, 'ownerId')
  if (ownerId !== null && (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1)) {
    throw new TypeError('ownerId must be null or a positive integer')
  }
  if (visibility !== 'public' && visibility !== 'private') throw new TypeError('visibility must be public or private')
  return {
    pageId: positiveInteger(Reflect.get(value, 'pageId'), 'pageId'),
    actorId: positiveInteger(Reflect.get(value, 'actorId'), 'actorId'),
    actorName: nonEmptyString(Reflect.get(value, 'actorName'), 'actorName'),
    title: nonEmptyString(Reflect.get(value, 'title'), 'title'),
    path: nonEmptyString(Reflect.get(value, 'path'), 'path'),
    localeCode: nonEmptyString(Reflect.get(value, 'localeCode'), 'localeCode'),
    ownerId,
    tags: Reflect.get(value, 'tags'),
    visibility
  }
}

const PAGE_WATCH_ACTIONS: Record<string, MailPageWatchAction> = {
  'page.created': 'created',
  'page.updated': 'updated',
  'page.restored': 'restored',
  'page.moved': 'moved',
  'page.deleted': 'deleted',
  'page.visibility-changed': 'changed-visibility',
  'page.ownership-transferred': 'transferred-ownership'
}
const eventAction = (type: string): MailPageWatchAction => PAGE_WATCH_ACTIONS[type] ?? 'changed'

const loadUser = async (wiki: PageWatchWikiContext, userId: number): Promise<Record<string, unknown> | undefined> => {
  if (userId === 1) return wiki.models.users.getRootUser()
  const user = await wiki.models.users
    .query()
    .findById(userId)
    .withGraphJoined('groups')
    .modifyGraph('groups', builder => {
      builder.select('groups.id', 'permissions')
    })
  const getGlobalPermissions = user && Reflect.get(user, 'getGlobalPermissions')
  if (user && typeof getGlobalPermissions === 'function') {
    Reflect.set(user, 'permissions', Reflect.apply(getGlobalPermissions, user, []))
  }
  return user
}

type CurrentPage = NotificationPage

const loadCurrentPage = async (wiki: PageWatchWikiContext, knex: Knex, pageId: number): Promise<CurrentPage | undefined> => {
  const page = await wiki.models.pages.getPageFromDb(pageId)
  if (!page) return undefined
  const tags = Reflect.get(page, 'tags')
  if (Array.isArray(tags)) return { ...page, id: pageId } as CurrentPage
  const tagRows = await knex<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  return { ...page, id: pageId, tags: tagRows.map(row => ({ tag: row.tag })) } as CurrentPage
}

const purgeRecipientPage = async (knex: Knex, pageId: number, userId: number): Promise<void> => {
  await knex('pageWatchNotifications').where({ pageId, userId }).delete()
  await knex('pageWatchers').where({ pageId, userId }).delete()
}

export const createPageWatchNotificationHandler =
  (wiki: PageWatchWikiContext): DurableJobHandler =>
  async (job, { knex, signal }) => {
    signal.throwIfAborted()
    if (job.payload.mode === 'audience') {
      const audience = parseAudiencePayload(job.payload)
      await knex.transaction(async transaction => {
        const event = await transaction<NotificationOutboxEvent>('outboxEvents').where('id', audience.eventId).first()
        if (event) await enqueueNotificationAudience(transaction, event, audience.afterUserId, audience.audienceAt, signal)
      })
      return
    }
    const payload = parseJobPayload(job.payload)
    const delivery = await knex('pageWatchDeliveries').where({ id: payload.deliveryId, eventId: payload.eventId, userId: payload.userId }).first()
    if (!delivery || delivery.deliveredAt) return
    const event = await knex<NotificationOutboxEvent>('outboxEvents').where('id', payload.eventId).first()
    if (!event) throw new Error('Page watch event no longer exists')
    const rawEvent: unknown = JSON.parse(event.payload)
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) throw new TypeError('Notification event is invalid')
    const pageId = positiveInteger(Reflect.get(rawEvent, 'pageId'), 'pageId')
    const isDiscussion = event.type === 'discussion.comment-created'
    const pageEvent = isDiscussion ? undefined : parseEventPayload(rawEvent)
    let category = payload.category
    let commentId = payload.commentId
    let actorId = pageEvent?.actorId ?? positiveInteger(Reflect.get(rawEvent, 'actorId'), 'actorId')
    let actorName = pageEvent?.actorName ?? ''
    let emailEnabled = payload.emailEnabled
    let inAppEnabled = payload.inAppEnabled
    const complete = async (lastError: string | null): Promise<void> => {
      signal.throwIfAborted()
      await knex('pageWatchDeliveries')
        .where({ id: payload.deliveryId, eventId: payload.eventId, userId: payload.userId })
        .update({ deliveredAt: new Date(), lastError })
    }
    if (isDiscussion) {
      const recipient = await resolveNotificationRecipient(knex, event, payload.userId)
      if (!recipient) {
        await complete('Discussion recipient is no longer eligible')
        return
      }
      category = recipient.category
      commentId = recipient.commentId
      actorId = recipient.actorId
      actorName = recipient.actorName
      emailEnabled = recipient.emailEnabled
      inAppEnabled = recipient.inAppEnabled
    } else if (category !== 'pageWatch') {
      const preference = await knex('userNotificationPreferences').where({ userId: payload.userId, category }).first()
      emailEnabled = emailEnabled && (preference?.emailEnabled === true || preference?.emailEnabled === 1)
      inAppEnabled = inAppEnabled && (preference?.inAppEnabled === true || preference?.inAppEnabled === 1)
    }
    if (actorId === payload.userId || (!emailEnabled && !inAppEnabled)) {
      await complete('Recipient has no enabled notification channels')
      return
    }
    const user = await loadUser(wiki, payload.userId)
    const active = user && Reflect.get(user, 'isActive')
    const isActive = user && (category === 'pageWatch' ? active !== false && active !== 0 : active === true || active === 1)
    const email = user && Reflect.get(user, 'email')
    if (
      !isActive ||
      (isDiscussion && user && (Reflect.get(user, 'isSystem') === true || Reflect.get(user, 'isSystem') === 1)) ||
      (category === 'pageWatch' && (typeof email !== 'string' || !email))
    ) {
      signal.throwIfAborted()
      await purgeRecipientPage(knex, pageId, payload.userId)
      await complete('Recipient is unavailable')
      return
    }
    if (typeof email !== 'string' || !email) emailEnabled = false
    const currentPage = await loadCurrentPage(wiki, knex, pageId)
    const deletedScopes = !currentPage && category === 'pageDeleted' ? await loadDeletedNotificationScopes(knex, [event]) : null
    const page = currentPage ?? deletedScopes?.get(event.id)
    const authority = await wiki.auth.loadPageRuleAuthority(user as Express.User)
    const hasMetadata =
      page &&
      typeof page.title === 'string' &&
      page.title.length > 0 &&
      typeof page.path === 'string' &&
      page.path.length > 0 &&
      typeof page.localeCode === 'string' &&
      page.localeCode.length > 0 &&
      (page.visibility === 'public' || page.visibility === 'private')
    const readable =
      page &&
      (category === 'pageWatch' || (category === 'pageDeleted' && !currentPage && page.isDeletedNotificationReplacement !== true)
        ? canReadPage(user as Express.User, page, authority)
        : canReadNotificationPage(user as Express.User, page, authority))
    if (!page || !hasMetadata || !readable) {
      signal.throwIfAborted()
      await purgeRecipientPage(knex, pageId, payload.userId)
      await complete('Page access was revoked')
      return
    }
    if (
      (category === 'pageCreated' || category === 'pageDeleted') &&
      currentPage &&
      (await knex('pageAccessPasswords').where('pageId', pageId).first('pageId'))
    ) {
      await complete('Page title is protected')
      return
    }
    if (isDiscussion) {
      const access = await loadDiscussionNotificationAccess(knex, [pageId], commentId === null ? [] : [commentId], user as Express.User, null)
      if (commentId === null || !canReadDiscussionNotification(user as Express.User, page, commentId, authority, access)) {
        await complete('Discussion access is unavailable')
        return
      }
    }
    const action: MailPageWatchAction =
      category === 'mention'
        ? 'mention'
        : category === 'commentReply'
          ? 'comment-reply'
          : category === 'watchedPageComment'
            ? 'watched-comment'
            : eventAction(event.type)
    const route = pageRoute(page)
    const url = `${wiki.config.host.replace(/\/$/, '')}${route}${commentId === null ? '' : `#comment-post-id-${commentId}`}`
    try {
      signal.throwIfAborted()
      if (inAppEnabled) {
        // Only routing and current page metadata are retained. Discussion text/render never enter this inbox.
        await knex('pageWatchNotifications')
          .insert({
            id: randomUUID(),
            eventId: payload.eventId,
            userId: payload.userId,
            pageId,
            eventType: event.type,
            category: category === 'pageWatch' ? null : category,
            commentId,
            actorName,
            title: page.title,
            path: page.path,
            localeCode: page.localeCode,
            visibility: page.visibility,
            createdAt: new Date(),
            readAt: null
          })
          .onConflict(['eventId', 'userId'])
          .ignore()
      }
      if (emailEnabled && typeof email === 'string') {
        signal.throwIfAborted()
        await wiki.mail.send({
          template: 'page-watch',
          to: email,
          messageId: `<page-watch-${payload.deliveryId}@wiki.local>`,
          data: { action, actorName, pageTitle: page.title, url }
        })
      }
      await complete(null)
    } catch (error) {
      signal.throwIfAborted()
      await knex('pageWatchDeliveries')
        .where({ id: payload.deliveryId, eventId: payload.eventId, userId: payload.userId })
        .update({ lastError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { DurableJobHandler } from '../core/durable-jobs.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { canReadPage, pageRoute } from '../helpers/page-access.ts'
import type { PageVisibilityRecord } from '../helpers/page-access.ts'

interface PageWatchPayload {
  deliveryId: string
  eventId: string
  userId: number
  emailEnabled: boolean
  inAppEnabled: boolean
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
  mail: { send(options: { template: string; to: string; subject: string; text: string; messageId: string; data: Record<string, unknown> }): Promise<unknown> }
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
  return {
    emailEnabled: Reflect.get(value, 'emailEnabled') === true,
    inAppEnabled: Reflect.get(value, 'inAppEnabled') === true,
    deliveryId: nonEmptyString(Reflect.get(value, 'deliveryId'), 'deliveryId'),
    eventId: nonEmptyString(Reflect.get(value, 'eventId'), 'eventId'),
    userId: positiveInteger(Reflect.get(value, 'userId'), 'userId')
  }
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

const eventAction = (type: string): string => ({
  'page.created': 'created',
  'page.updated': 'updated',
  'page.restored': 'restored',
  'page.moved': 'moved',
  'page.deleted': 'deleted',
  'page.visibility-changed': 'changed visibility for',
  'page.ownership-transferred': 'transferred ownership of'
})[type] ?? 'changed'

const loadUser = async (wiki: PageWatchWikiContext, userId: number): Promise<Record<string, unknown> | undefined> => {
  if (userId === 1) return wiki.models.users.getRootUser()
  const user = await wiki.models.users.query().findById(userId).withGraphJoined('groups').modifyGraph('groups', builder => {
    builder.select('groups.id', 'permissions')
  })
  const getGlobalPermissions = user && Reflect.get(user, 'getGlobalPermissions')
  if (user && typeof getGlobalPermissions === 'function') {
    Reflect.set(user, 'permissions', Reflect.apply(getGlobalPermissions, user, []))
  }
  return user
}

interface CurrentPage extends PageVisibilityRecord, Record<string, unknown> {
  title: string
  path: string
  localeCode: string
}

const loadCurrentPage = async (wiki: PageWatchWikiContext, knex: Knex, pageId: number): Promise<CurrentPage | undefined> => {
  const page = await wiki.models.pages.getPageFromDb(pageId)
  if (!page) return undefined
  const tags = Reflect.get(page, 'tags')
  if (Array.isArray(tags)) return page as CurrentPage
  const tagRows = await knex<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  return { ...page, tags: tagRows.map(row => ({ tag: row.tag })) } as CurrentPage
}

const purgeRecipientPage = async (knex: Knex, pageId: number, userId: number): Promise<void> => {
  await knex('pageWatchNotifications').where({ pageId, userId }).delete()
  await knex('pageWatchers').where({ pageId, userId }).delete()
}

export const createPageWatchNotificationHandler = (wiki: PageWatchWikiContext): DurableJobHandler => async (job, { knex, signal }) => {
  signal.throwIfAborted()
  const payload = parseJobPayload(job.payload)
  const delivery = await knex('pageWatchDeliveries').where({ id: payload.deliveryId, eventId: payload.eventId, userId: payload.userId }).first()
  if (!delivery || delivery.deliveredAt) return
  const event = await knex('outboxEvents').where({ id: payload.eventId }).first()
  if (!event) throw new Error('Page watch event no longer exists')
  const eventPayload = parseEventPayload(JSON.parse(String(event.payload)))
  const user = await loadUser(wiki, payload.userId)
  const isActive = user && Reflect.get(user, 'isActive') !== false
  const email = user && Reflect.get(user, 'email')
  if (!isActive || typeof email !== 'string' || email.length === 0) {
    signal.throwIfAborted()
    await purgeRecipientPage(knex, eventPayload.pageId, payload.userId)
    signal.throwIfAborted()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: 'Recipient is unavailable' })
    return
  }
  const page = await loadCurrentPage(wiki, knex, eventPayload.pageId)
  const authority = await wiki.auth.loadPageRuleAuthority(user as Express.User)
  const hasCurrentMetadata = Boolean(
    page &&
    typeof page.title === 'string' &&
    page.title.length > 0 &&
    typeof page.path === 'string' &&
    page.path.length > 0 &&
    typeof page.localeCode === 'string' &&
    page.localeCode.length > 0 &&
    (page.visibility === 'public' || page.visibility === 'private')
  )
  if (!page || !hasCurrentMetadata || !canReadPage(user as Express.User, page, authority)) {
    signal.throwIfAborted()
    await purgeRecipientPage(knex, eventPayload.pageId, payload.userId)
    signal.throwIfAborted()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: 'Page access was revoked' })
    return
  }

  const notificationTitle = page.title
  const notificationPath = page.path
  const notificationLocaleCode = page.localeCode
  const notificationVisibility = page.visibility
  const action = eventAction(String(event.type))
  const route = pageRoute({ visibility: notificationVisibility, localeCode: notificationLocaleCode, path: notificationPath })
  const url = `${wiki.config.host.replace(/\/$/, '')}${route}`
  const text = `${eventPayload.actorName} ${action} “${notificationTitle}”.\n\n${url}`
  try {
    signal.throwIfAborted()
    if (payload.inAppEnabled) {
      try {
        await knex('pageWatchNotifications').insert({
          id: randomUUID(),
          eventId: payload.eventId,
          userId: payload.userId,
          pageId: eventPayload.pageId,
          eventType: event.type,
          actorName: eventPayload.actorName,
          title: notificationTitle,
          path: notificationPath,
          localeCode: notificationLocaleCode,
          visibility: notificationVisibility,
          createdAt: new Date(),
          readAt: null
        })
      } catch (error) {
        signal.throwIfAborted()
        const existing = await knex('pageWatchNotifications').where({ eventId: payload.eventId, userId: payload.userId }).first()
        signal.throwIfAborted()
        if (!existing) throw error
      }
    }
    if (payload.emailEnabled) {
      signal.throwIfAborted()
      await wiki.mail.send({
        template: 'page-watch',
        to: email,
        subject: `Page ${action}: ${notificationTitle}`,
        text,
        messageId: `<page-watch-${payload.deliveryId}@wiki.local>`,
        data: { action, actorName: eventPayload.actorName, pageTitle: notificationTitle, url }
      })
    }
    signal.throwIfAborted()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: null })
  } catch (error) {
    signal.throwIfAborted()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ lastError: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

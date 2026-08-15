import { randomUUID } from 'node:crypto'
import type { DurableJobHandler } from '../core/durable-jobs.ts'
import { canReadPage, pageRoute } from '../helpers/page-access.ts'

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

export const createPageWatchNotificationHandler = (wiki: PageWatchWikiContext): DurableJobHandler => async (job, { knex }) => {
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
    await knex('pageWatchers').where({ pageId: eventPayload.pageId, userId: payload.userId }).delete()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: 'Recipient is unavailable' })
    return
  }
  const page = await wiki.models.pages.getPageFromDb(eventPayload.pageId)
  const accessTarget = page ?? eventPayload
  if (!canReadPage(user, accessTarget as never)) {
    await knex('pageWatchers').where({ pageId: eventPayload.pageId, userId: payload.userId }).delete()
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: 'Page access was revoked' })
    return
  }

  const currentTitle = page && Reflect.get(page, 'title')
  const currentPath = page && Reflect.get(page, 'path')
  const currentLocaleCode = page && Reflect.get(page, 'localeCode')
  const currentVisibility = page && Reflect.get(page, 'visibility')
  const notificationTitle = typeof currentTitle === 'string' ? currentTitle : eventPayload.title
  const notificationPath = typeof currentPath === 'string' ? currentPath : eventPayload.path
  const notificationLocaleCode = typeof currentLocaleCode === 'string' ? currentLocaleCode : eventPayload.localeCode
  const notificationVisibility = currentVisibility === 'public' || currentVisibility === 'private'
    ? currentVisibility
    : eventPayload.visibility
  const action = eventAction(String(event.type))
  const route = pageRoute({ visibility: notificationVisibility, localeCode: notificationLocaleCode, path: notificationPath })
  const url = `${wiki.config.host.replace(/\/$/, '')}${route}`
  const text = `${eventPayload.actorName} ${action} “${notificationTitle}”.\n\n${url}`
  try {
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
        const existing = await knex('pageWatchNotifications').where({ eventId: payload.eventId, userId: payload.userId }).first()
        if (!existing) throw error
      }
    }
    if (payload.emailEnabled) {
      await wiki.mail.send({
        template: 'page-watch',
        to: email,
        subject: `Page ${action}: ${notificationTitle}`,
        text,
        messageId: `<page-watch-${payload.deliveryId}@wiki.local>`,
        data: { action, actorName: eventPayload.actorName, pageTitle: notificationTitle, url }
      })
    }
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ deliveredAt: new Date(), lastError: null })
  } catch (error) {
    await knex('pageWatchDeliveries').where({ id: payload.deliveryId }).update({ lastError: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

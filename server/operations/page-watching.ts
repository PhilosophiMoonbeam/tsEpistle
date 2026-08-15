import type { Knex } from 'knex'
import { canReadPage, principalId } from '../helpers/page-access.ts'
import type { PagePrincipal, PageVisibilityRecord } from '../helpers/page-access.ts'
import errors from './errors.ts'

const { ApplicationError } = errors

interface WatchInput {
  requester?: PagePrincipal
  id: number
  emailEnabled?: boolean
  inAppEnabled?: boolean
}

interface WikiContext {
  models: {
    knex: Knex
    pages: { getPageFromDb(id: number): Promise<PageVisibilityRecord | undefined> }
  }
}

const wiki = (global as typeof globalThis & { WIKI: unknown }).WIKI as unknown as WikiContext

const authenticatedUserId = (requester: PagePrincipal | undefined): number => {
  const userId = principalId(requester)
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  if (userId === null || userId === 2 || email === 'api@localhost') throw new ApplicationError('Authentication is required to watch pages', { status: 401, code: 'AUTH_REQUIRED' })
  return userId
}

const readablePage = async (requester: PagePrincipal | undefined, id: number): Promise<PageVisibilityRecord> => {
  const page = await wiki.models.pages.getPageFromDb(id)
  if (!page || !canReadPage(requester, page)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  return page
}

export const getPageWatchState = async ({ requester, id }: WatchInput): Promise<{ watched: boolean; emailEnabled: boolean; inAppEnabled: boolean }> => {
  const userId = authenticatedUserId(requester)
  await readablePage(requester, id)
  const watcher = await wiki.models.knex('pageWatchers').where({ pageId: id, userId }).first()
  return {
    watched: Boolean(watcher),
    emailEnabled: Boolean(watcher?.emailEnabled),
    inAppEnabled: Boolean(watcher?.inAppEnabled)
  }
}

export const watchPage = async ({ requester, id, emailEnabled = true, inAppEnabled = true }: WatchInput): Promise<{ watched: true; emailEnabled: boolean; inAppEnabled: boolean }> => {
  const userId = authenticatedUserId(requester)
  await readablePage(requester, id)
  const watcher = { pageId: id, userId, createdAt: new Date(), emailEnabled, inAppEnabled }
  await wiki.models.knex('pageWatchers').insert(watcher).onConflict(['pageId', 'userId']).merge({ emailEnabled, inAppEnabled })
  return { watched: true, emailEnabled, inAppEnabled }
}

export const unwatchPage = async ({ requester, id }: WatchInput): Promise<{ watched: false }> => {
  const userId = authenticatedUserId(requester)
  await wiki.models.knex('pageWatchers').where({ pageId: id, userId }).delete()
  return { watched: false }
}


export const listPageWatchNotifications = async (requester: PagePrincipal | undefined): Promise<{ items: Array<Record<string, unknown>>; unreadCount: number }> => {
  const userId = authenticatedUserId(requester)
  const rows = await wiki.models.knex('pageWatchNotifications')
    .where({ userId })
    .orderBy('createdAt', 'desc')
    .limit(50)
  return {
    items: rows.map(row => ({
      id: row.id,
      pageId: row.pageId,
      eventType: row.eventType,
      actorName: row.actorName,
      title: row.title,
      path: row.path,
      localeCode: row.localeCode,
      visibility: row.visibility,
      createdAt: row.createdAt,
      readAt: row.readAt
    })),
    unreadCount: rows.filter(row => !row.readAt).length
  }
}

export const markPageWatchNotificationRead = async (requester: PagePrincipal | undefined, id: string): Promise<void> => {
  const userId = authenticatedUserId(requester)
  if (!id) throw new ApplicationError('Notification id is required', { status: 400, code: 'INVALID_INPUT' })
  await wiki.models.knex('pageWatchNotifications').where({ id, userId }).update({ readAt: new Date() })
}
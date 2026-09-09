import type { Knex } from 'knex'
import { canReadPage, principalId } from '../helpers/page-access.ts'
import type { PagePrincipal, PageVisibilityRecord } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import errors from './errors.ts'

const { ApplicationError } = errors

interface WatchInput {
  requester?: PagePrincipal
  id: number
  emailEnabled?: boolean
  inAppEnabled?: boolean
}

interface WikiContext {
  auth: {
    loadPageRuleAuthority(requester: PagePrincipal | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  models: {
    knex: Knex
    pages: { getPageFromDb(id: number): Promise<PageVisibilityRecord | undefined> }
  }
}
const wiki = WIKI as unknown as WikiContext

const MAX_VISIBLE_NOTIFICATIONS = 50
const NOTIFICATION_CANDIDATE_BATCH_SIZE = 50

type NotificationTimestamp = Date | string

interface NotificationCursor {
  createdAt: NotificationTimestamp
  id: string
}

interface CurrentNotificationPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
}

interface NotificationRow extends Record<string, unknown> {
  id: string
  pageId: number
  eventType: string
  actorName: string
  title: string
  path: string
  localeCode: string
  visibility: string
  createdAt: NotificationTimestamp
  readAt: unknown
}

const authenticatedUserId = (requester: PagePrincipal | undefined): number => {
  const userId = principalId(requester)
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  if (userId === null || userId === 2 || email === 'api@localhost') throw new ApplicationError('Authentication is required to watch pages', { status: 401, code: 'AUTH_REQUIRED' })
  return userId
}

const readablePage = async (requester: PagePrincipal | undefined, id: number): Promise<PageVisibilityRecord> => {
  const page = await wiki.models.pages.getPageFromDb(id)
  const authority = await wiki.auth.loadPageRuleAuthority(requester)
  if (!page || !canReadPage(requester, page, authority)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  return page
}

const loadPageTags = async (transaction: Knex.Transaction, pageId: number): Promise<Array<{ tag: string }>> => {
  const rows = await transaction<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  return rows.map(row => ({ tag: row.tag }))
}

const loadCurrentNotificationPages = async (pageIds: readonly number[]): Promise<Map<number, CurrentNotificationPage>> => {
  if (pageIds.length === 0) return new Map()
  const database = wiki.models.knex
  const pageRows = await database<Record<string, unknown>>('pages')
    .whereIn('id', pageIds)
    .select('*')
  const tagRows = await database<{ pageId: number | string; tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', pageIds)
    .orderBy('tags.tag', 'asc')
    .select('pageTags.pageId as pageId', 'tags.tag as tag')
  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  for (const row of tagRows) {
    const pageId = Number(row.pageId)
    if (!Number.isSafeInteger(pageId) || pageId < 1 || typeof row.tag !== 'string') continue
    const tags = tagsByPage.get(pageId) ?? []
    tags.push({ tag: row.tag })
    tagsByPage.set(pageId, tags)
  }
  const pages = new Map<number, CurrentNotificationPage>()
  for (const row of pageRows) {
    const pageId = Number(row.id)
    if (!Number.isSafeInteger(pageId) || pageId < 1 || typeof row.title !== 'string') continue
    pages.set(pageId, {
      ...row,
      id: pageId,
      title: row.title,
      tags: tagsByPage.get(pageId) ?? []
    } as CurrentNotificationPage)
  }
  return pages
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
  await wiki.models.knex.transaction(async transaction => {
    const page = await transaction<PageVisibilityRecord>('pages').where('id', id).forUpdate().first()
    if (!page) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    page.tags = await loadPageTags(transaction, id)
    const authority = await wiki.auth.loadPageRuleAuthority(requester, transaction)
    if (!canReadPage(requester, page, authority)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    const watcher = { pageId: id, userId, createdAt: new Date(), emailEnabled, inAppEnabled }
    await transaction('pageWatchers').insert(watcher).onConflict(['pageId', 'userId']).merge({ emailEnabled, inAppEnabled })
  })
  return { watched: true, emailEnabled, inAppEnabled }
}

export const unwatchPage = async ({ requester, id }: WatchInput): Promise<{ watched: false }> => {
  const userId = authenticatedUserId(requester)
  await wiki.models.knex('pageWatchers').where({ pageId: id, userId }).delete()
  return { watched: false }
}


const purgeNotificationRows = async (userId: number, pageIds: readonly number[], notificationIds: readonly string[]): Promise<void> => {
  const database = wiki.models.knex
  if (pageIds.length > 0) await database('pageWatchNotifications').where({ userId }).whereIn('pageId', pageIds).delete()
  if (notificationIds.length > 0) await database('pageWatchNotifications').where({ userId }).whereIn('id', notificationIds).delete()
  if (pageIds.length > 0) await database('pageWatchers').where({ userId }).whereIn('pageId', pageIds).delete()
}

const isCurrentNotificationPage = (page: CurrentNotificationPage | undefined): page is CurrentNotificationPage =>
  page !== undefined &&
  typeof page.title === 'string' &&
  page.title.length > 0 &&
  typeof page.path === 'string' &&
  page.path.length > 0 &&
  typeof page.localeCode === 'string' &&
  page.localeCode.length > 0 &&
  (page.visibility === 'public' || page.visibility === 'private')

export const listPageWatchNotifications = async (requester: PagePrincipal | undefined): Promise<{ items: Array<Record<string, unknown>>; unreadCount: number }> => {
  const userId = authenticatedUserId(requester)
  const authority = await wiki.auth.loadPageRuleAuthority(requester)
  const items: Array<Record<string, unknown>> = []
  let cursor: NotificationCursor | undefined

  while (items.length < MAX_VISIBLE_NOTIFICATIONS) {
    let query = wiki.models.knex<NotificationRow>('pageWatchNotifications')
      .where({ userId })
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(NOTIFICATION_CANDIDATE_BATCH_SIZE)
    const currentCursor = cursor
    if (currentCursor) {
      query = query.where(function () {
        this.where('createdAt', '<', currentCursor.createdAt)
          .orWhere(function () {
            this.where('createdAt', currentCursor.createdAt).andWhere('id', '<', currentCursor.id)
          })
      })
    }
    const rows = await query
    if (rows.length === 0) break
    const lastRow = rows[rows.length - 1]
    if (!lastRow) break
    cursor = { createdAt: lastRow.createdAt, id: String(lastRow.id) }

    const pageIds = Array.from(new Set(
      rows
        .map(row => Number(row.pageId))
        .filter(pageId => Number.isSafeInteger(pageId) && pageId > 0)
    ))
    const currentPages = await loadCurrentNotificationPages(pageIds)
    const purgePageIds = new Set<number>()
    const purgeNotificationIds: string[] = []
    for (const row of rows) {
      const pageId = Number(row.pageId)
      const page = Number.isSafeInteger(pageId) && pageId > 0 ? currentPages.get(pageId) : undefined
      if (!isCurrentNotificationPage(page) || !canReadPage(requester, page, authority)) {
        if (Number.isSafeInteger(pageId) && pageId > 0) purgePageIds.add(pageId)
        purgeNotificationIds.push(String(row.id))
        continue
      }
      if (items.length >= MAX_VISIBLE_NOTIFICATIONS) continue
      items.push({
        id: row.id,
        pageId,
        eventType: row.eventType,
        actorName: row.actorName,
        title: page.title,
        path: page.path,
        localeCode: page.localeCode,
        visibility: page.visibility,
        createdAt: row.createdAt,
        readAt: row.readAt
      })
    }
    await purgeNotificationRows(userId, [...purgePageIds], purgeNotificationIds)
    if (rows.length < NOTIFICATION_CANDIDATE_BATCH_SIZE) break
  }
  return {
    items,
    unreadCount: items.filter(item => !item.readAt).length
  }
}

export const markPageWatchNotificationRead = async (requester: PagePrincipal | undefined, id: string): Promise<void> => {
  const userId = authenticatedUserId(requester)
  if (!id) throw new ApplicationError('Notification id is required', { status: 400, code: 'INVALID_INPUT' })
  await wiki.models.knex('pageWatchNotifications').where({ id, userId }).update({ readAt: new Date() })
}
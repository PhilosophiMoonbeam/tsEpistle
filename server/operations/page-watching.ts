import type { PageWatchNotification, PageWatchNotificationList } from '../../shared/site-notifications.ts'
import { randomUUID } from 'node:crypto'
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
const MAX_PROCESSED_NOTIFICATION_CANDIDATES = 500
const NOTIFICATION_CURSOR_TTL_MS = 5 * 60 * 1_000
const MAX_NOTIFICATION_CURSORS = 128
const NOTIFICATION_CURSOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type NotificationPhase = 'unread' | 'read'
type NotificationTimestamp = Date | string | number

interface NotificationCursor {
  phase: NotificationPhase
  createdAt: NotificationTimestamp
  id: string
}

interface StoredNotificationCursor extends NotificationCursor {
  ownerId: number
  expiresAt: number
}

const notificationCursors = new Map<string, StoredNotificationCursor>()

interface CurrentNotificationPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
}

interface CurrentNotificationPageWithLocale extends CurrentNotificationPage {
  localeCode: string
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
  readAt: NotificationTimestamp | null
}
const wireTimestamp = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined
  if (date === undefined || !Number.isFinite(date.getTime())) throw new TypeError('Page watch notification timestamp is invalid')
  return date.toISOString()
}
const MAX_LIVE_NOTIFICATION_CURSORS_PER_OWNER = 4

const pruneNotificationCursors = (now = Date.now()): void => {
  for (const [token, cursor] of notificationCursors) {
    if (cursor.expiresAt <= now) notificationCursors.delete(token)
  }
}

const invalidNotificationCursor = (): never => {
  throw new ApplicationError('Page watch notification cursor expired', { status: 409, code: 'WATCH_CURSOR_EXPIRED' })
}

const readNotificationCursor = (ownerId: number, value: string | null | undefined): StoredNotificationCursor | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !NOTIFICATION_CURSOR_PATTERN.test(value)) return invalidNotificationCursor()
  pruneNotificationCursors()
  const cursor = notificationCursors.get(value)
  if (!cursor || cursor.expiresAt <= Date.now() || cursor.ownerId !== ownerId) return invalidNotificationCursor()
  return cursor
}

const equivalentNotificationTimestamp = (left: NotificationTimestamp, right: NotificationTimestamp): boolean => {
  if (left instanceof Date || right instanceof Date) {
    if (!(left instanceof Date) || !(right instanceof Date)) return false
    const leftTime = left.getTime()
    const rightTime = right.getTime()
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
  }
  return typeof left === typeof right && Object.is(left, right)
}

const equivalentNotificationCursor = (left: StoredNotificationCursor, ownerId: number, right: NotificationCursor): boolean =>
  left.ownerId === ownerId && left.phase === right.phase && left.id === right.id && equivalentNotificationTimestamp(left.createdAt, right.createdAt)

const issueNotificationCursor = (ownerId: number, cursor: NotificationCursor): string => {
  const now = Date.now()
  pruneNotificationCursors(now)

  for (const [token, stored] of notificationCursors) {
    if (equivalentNotificationCursor(stored, ownerId, cursor)) return token
  }

  let ownerCursorCount = 0
  let oldestOwnerToken: string | undefined
  for (const [token, stored] of notificationCursors) {
    if (stored.ownerId !== ownerId) continue
    ownerCursorCount += 1
    if (oldestOwnerToken === undefined) oldestOwnerToken = token
  }
  if (ownerCursorCount >= MAX_LIVE_NOTIFICATION_CURSORS_PER_OWNER && oldestOwnerToken !== undefined) notificationCursors.delete(oldestOwnerToken)
  if (notificationCursors.size >= MAX_NOTIFICATION_CURSORS) {
    throw new ApplicationError('Page watch notification cursor capacity exhausted', { status: 503, code: 'NOTIFICATION_CURSOR_CAPACITY' })
  }

  const token = randomUUID()
  notificationCursors.set(token, {
    ownerId,
    phase: cursor.phase,
    createdAt: cursor.createdAt,
    id: cursor.id,
    expiresAt: now + NOTIFICATION_CURSOR_TTL_MS
  })
  return token
}

const authenticatedUserId = (requester: PagePrincipal | undefined): number => {
  const userId = principalId(requester)
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  if (userId === null || userId === 2 || email === 'api@localhost')
    throw new ApplicationError('Authentication is required to watch pages', { status: 401, code: 'AUTH_REQUIRED' })
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
  const pageRows = await database<Record<string, unknown>>('pages').whereIn('id', pageIds).select('*')
  const tagRows = await database<{ pageId: number | string; tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', pageIds)
    .orderBy('tags.tag', 'asc')
    .select('pageTags.pageId as pageId', 'tags.tag as tag')
  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  const malformedTagPages = new Set<number>()
  for (const row of tagRows) {
    const pageId = Number(row.pageId)
    if (!Number.isSafeInteger(pageId) || pageId < 1) continue
    if (typeof row.tag !== 'string') {
      malformedTagPages.add(pageId)
      continue
    }
    const tags = tagsByPage.get(pageId) ?? []
    tags.push({ tag: row.tag })
    tagsByPage.set(pageId, tags)
  }
  const pages = new Map<number, CurrentNotificationPage>()
  for (const row of pageRows) {
    const pageId = Number(row.id)
    if (!Number.isSafeInteger(pageId) || pageId < 1 || typeof row.title !== 'string' || malformedTagPages.has(pageId)) continue
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

export const watchPage = async ({
  requester,
  id,
  emailEnabled = true,
  inAppEnabled = true
}: WatchInput): Promise<{ watched: true; emailEnabled: boolean; inAppEnabled: boolean }> => {
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

const purgeNotificationRows = async (userId: number, notificationIds: readonly string[], revokedWatcherPageIds: readonly number[]): Promise<void> => {
  const database = wiki.models.knex
  if (notificationIds.length > 0) await database('pageWatchNotifications').where({ userId }).whereIn('id', notificationIds).delete()
  if (revokedWatcherPageIds.length > 0) await database('pageWatchers').where({ userId }).whereIn('pageId', revokedWatcherPageIds).delete()
}

const isCurrentNotificationPage = (page: CurrentNotificationPage | undefined): page is CurrentNotificationPageWithLocale =>
  page !== undefined &&
  typeof page.title === 'string' &&
  page.title.length > 0 &&
  typeof page.path === 'string' &&
  page.path.length > 0 &&
  typeof page.localeCode === 'string' &&
  page.localeCode.length > 0 &&
  (page.visibility === 'public' || page.visibility === 'private')
export const listPageWatchNotifications = async (requester: PagePrincipal | undefined, cursor?: string | null): Promise<PageWatchNotificationList> => {
  const userId = authenticatedUserId(requester)
  const storedCursor = readNotificationCursor(userId, cursor)
  const authority = await wiki.auth.loadPageRuleAuthority(requester)
  const items: PageWatchNotification[] = []
  let phase: NotificationPhase = storedCursor?.phase ?? 'unread'
  let queryCursor: NotificationCursor | null = storedCursor ? { phase: storedCursor.phase, createdAt: storedCursor.createdAt, id: storedCursor.id } : null
  let processed = 0
  let lastProcessedCursor: NotificationCursor | null = null
  let nextCursor: string | null = null
  let unreadComplete = phase === 'read'

  while (items.length < MAX_VISIBLE_NOTIFICATIONS && processed < MAX_PROCESSED_NOTIFICATION_CANDIDATES) {
    const batchLimit = Math.min(NOTIFICATION_CANDIDATE_BATCH_SIZE, MAX_PROCESSED_NOTIFICATION_CANDIDATES - processed)
    let query = wiki.models
      .knex<NotificationRow>('pageWatchNotifications')
      .where({ userId })
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(batchLimit)
    if (phase === 'unread') query = query.whereNull('readAt')
    else query = query.whereNotNull('readAt')

    const currentCursor = queryCursor
    if (currentCursor) {
      query = query.where(function () {
        this.where('createdAt', '<', currentCursor.createdAt).orWhere(function () {
          this.where('createdAt', currentCursor.createdAt).andWhere('id', '<', currentCursor.id)
        })
      })
    }

    const rows = await query
    if (rows.length === 0) {
      if (phase === 'unread') {
        unreadComplete = true
        phase = 'read'
        queryCursor = null
        continue
      }
      break
    }

    const pageIds = Array.from(new Set(rows.map(row => Number(row.pageId)).filter(pageId => Number.isSafeInteger(pageId) && pageId > 0)))
    const currentPages = await loadCurrentNotificationPages(pageIds)
    const revokedWatcherPageIds = new Set<number>()
    const purgeNotificationIds: string[] = []
    let processedRowsInBatch = 0

    for (const row of rows) {
      if (items.length >= MAX_VISIBLE_NOTIFICATIONS || processed >= MAX_PROCESSED_NOTIFICATION_CANDIDATES) break

      processed += 1
      processedRowsInBatch += 1
      lastProcessedCursor = { phase, createdAt: row.createdAt, id: String(row.id) }
      queryCursor = lastProcessedCursor

      const pageId = Number(row.pageId)
      const page = Number.isSafeInteger(pageId) && pageId > 0 ? currentPages.get(pageId) : undefined
      if (!isCurrentNotificationPage(page) || !canReadPage(requester, page, authority)) {
        if (Number.isSafeInteger(pageId) && pageId > 0) revokedWatcherPageIds.add(pageId)
        purgeNotificationIds.push(String(row.id))
        continue
      }

      items.push({
        id: String(row.id),
        pageId,
        eventType: row.eventType,
        actorName: row.actorName,
        title: page.title,
        path: page.path,
        localeCode: page.localeCode,
        visibility: page.visibility,
        createdAt: wireTimestamp(row.createdAt),
        readAt: row.readAt === null ? null : wireTimestamp(row.readAt)
      })
    }

    const hasUnprocessedFetchedRows = processedRowsInBatch < rows.length
    await purgeNotificationRows(userId, purgeNotificationIds, [...revokedWatcherPageIds])

    if (items.length >= MAX_VISIBLE_NOTIFICATIONS) {
      if (phase === 'unread' && !hasUnprocessedFetchedRows && rows.length < batchLimit) unreadComplete = true
      if (lastProcessedCursor && (hasUnprocessedFetchedRows || rows.length >= batchLimit)) nextCursor = issueNotificationCursor(userId, lastProcessedCursor)
      break
    }
    if (processed >= MAX_PROCESSED_NOTIFICATION_CANDIDATES) {
      if (lastProcessedCursor && (hasUnprocessedFetchedRows || rows.length >= batchLimit)) nextCursor = issueNotificationCursor(userId, lastProcessedCursor)
      break
    }
    if (rows.length < batchLimit) {
      if (phase === 'unread') {
        unreadComplete = true
        phase = 'read'
        queryCursor = null
        continue
      }
      break
    }
  }

  return {
    ownerId: userId,
    items,
    unreadCount: items.reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0),
    nextCursor,
    unreadComplete
  }
}

export const markPageWatchNotificationRead = async (requester: PagePrincipal | undefined, id: string): Promise<void> => {
  const userId = authenticatedUserId(requester)
  if (!id) throw new ApplicationError('Notification id is required', { status: 400, code: 'INVALID_INPUT' })
  await wiki.models.knex('pageWatchNotifications').where({ id, userId }).update({ readAt: new Date() })
}

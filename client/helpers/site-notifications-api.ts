import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import type {
  NotificationPreferencesPatch,
  NotificationPreferencesResponse,
  PageApprovalInbox,
  PageApprovalInboxItem,
  PageWatchNotification,
  PageWatchNotificationList
} from '../../shared/site-notifications.ts'
import { NOTIFICATION_CATEGORIES } from '../../shared/site-notifications.ts'
import type { MyDiscussionsPage } from '../../shared/discussion-annotations.ts'
import { pageHref } from './admin-pages.ts'

type NotificationApiError = Error & { status?: number; code?: string }

const apiError = (payload: unknown, fallback: string): NotificationApiError => {
  const message = isRecord(payload) && typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback
  const error = new Error(message) as NotificationApiError
  if (isRecord(payload) && typeof payload.code === 'string' && payload.code.length > 0) error.code = payload.code
  return error
}

const ownerMismatch = (expectedOwnerId: number, actualOwnerId: unknown): NotificationApiError =>
  Object.assign(new Error('Account changed. Refresh your account.'), {
    status: 409,
    code: 'NOTIFICATION_OWNER_CHANGED',
    expectedOwnerId,
    actualOwnerId
  })

const validOwnerId = (ownerId: number): boolean => Number.isSafeInteger(ownerId) && ownerId > 0

const notificationHeaders = (ownerId: number): Record<string, string> => {
  if (!validOwnerId(ownerId)) throw new Error('Notification owner is invalid.')
  return { Accept: 'application/json', 'X-Notification-Owner': String(ownerId) }
}

const requestJson = async <T>(
  path: string,
  ownerId: number,
  valid: (value: unknown) => value is T,
  fallback: string,
  signal?: AbortSignal,
  body?: NotificationPreferencesPatch
): Promise<T> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...notificationHeaders(ownerId), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'PATCH', body: JSON.stringify({ preferences: body }) } : {}),
    ...(signal ? { signal } : {})
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) throw Object.assign(apiError(payload, fallback), { status: response.status })
  if (isRecord(payload) && 'ownerId' in payload && payload.ownerId !== ownerId) throw ownerMismatch(ownerId, payload.ownerId)
  if (!valid(payload)) throw new Error(fallback)
  if (!isRecord(payload) || payload.ownerId !== ownerId) throw new Error(fallback)
  return payload
}

const isTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isVisibility = (value: unknown): value is 'public' | 'private' => value === 'public' || value === 'private'
const isOwnerId = (value: unknown): value is number => typeof value === 'number' && validOwnerId(value)

const isPageWatchNotification = (value: unknown): value is PageWatchNotification =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  Number.isSafeInteger(value.pageId) &&
  typeof value.eventType === 'string' &&
  (value.category === 'pageWatch' || NOTIFICATION_CATEGORIES.some(category => category === value.category)) &&
  (value.commentId === null || (Number.isSafeInteger(value.commentId) && Number(value.commentId) > 0)) &&
  typeof value.actorName === 'string' &&
  typeof value.title === 'string' &&
  typeof value.path === 'string' &&
  typeof value.localeCode === 'string' &&
  isVisibility(value.visibility) &&
  isTimestamp(value.createdAt) &&
  (value.readAt === null || isTimestamp(value.readAt))

const isPageWatchNotificationList = (value: unknown): value is PageWatchNotificationList =>
  isRecord(value) &&
  isOwnerId(value.ownerId) &&
  Array.isArray(value.items) &&
  value.items.every(isPageWatchNotification) &&
  typeof value.unreadCount === 'number' &&
  Number.isSafeInteger(value.unreadCount) &&
  value.unreadCount >= 0 &&
  (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0)) &&
  typeof value.unreadComplete === 'boolean'

const approvalStatuses: Record<string, true> = {
  submitted: true,
  approved: true,
  'changes-requested': true,
  rejected: true,
  cancelled: true,
  published: true
}
const isPageApprovalInboxItem = (value: unknown): value is PageApprovalInboxItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  Number.isSafeInteger(value.pageId) &&
  Number.isSafeInteger(value.submitterId) &&
  (value.assigneeId === null || Number.isSafeInteger(value.assigneeId)) &&
  typeof value.status === 'string' &&
  approvalStatuses[value.status] === true &&
  Number.isSafeInteger(value.revisionId) &&
  isTimestamp(value.revisionUpdatedAt) &&
  isTimestamp(value.createdAt) &&
  isTimestamp(value.updatedAt) &&
  (value.closedAt === null || isTimestamp(value.closedAt)) &&
  typeof value.stale === 'boolean' &&
  typeof value.canReview === 'boolean' &&
  typeof value.title === 'string' &&
  typeof value.path === 'string' &&
  typeof value.localeCode === 'string' &&
  isVisibility(value.visibility)

const isPageApprovalInbox = (value: unknown): value is PageApprovalInbox =>
  isRecord(value) &&
  isOwnerId(value.ownerId) &&
  Array.isArray(value.items) &&
  value.items.every(isPageApprovalInboxItem) &&
  (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))

export const fetchPageWatchNotifications = (ownerId: number, cursor?: string | null, signal?: AbortSignal): Promise<PageWatchNotificationList> => {
  const path =
    cursor === undefined || cursor === null ? '/_api/pages/watches/notifications' : `/_api/pages/watches/notifications?cursor=${encodeURIComponent(cursor)}`
  return requestJson(path, ownerId, isPageWatchNotificationList, 'Watch notifications could not be loaded.', signal)
}

export const fetchPageApprovalInbox = (ownerId: number, cursor?: string, signal?: AbortSignal): Promise<PageApprovalInbox> => {
  const path = cursor === undefined ? '/_api/pages/approvals/inbox' : `/_api/pages/approvals/inbox?cursor=${encodeURIComponent(cursor)}`
  return requestJson(path, ownerId, isPageApprovalInbox, 'Approval inbox could not be loaded.', signal)
}

export const markPageWatchNotificationRead = async (ownerId: number, id: string, signal?: AbortSignal): Promise<void> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/pages/watches/notifications/${encodeURIComponent(id)}/read`, {
    method: 'PATCH',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: notificationHeaders(ownerId),
    ...(signal ? { signal } : {})
  })
  if (!response.ok) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    throw Object.assign(apiError(payload, 'Watch notification could not be marked read.'), { status: response.status })
  }
}

export const notificationIdentityInvalidated = (error: unknown): boolean =>
  isRecord(error) && (error.code === 'NOTIFICATION_OWNER_CHANGED' || error.name === 'NOTIFICATION_OWNER_CHANGED' || error.status === 401)

const isPreferencesResponse = (value: unknown): value is NotificationPreferencesResponse => {
  if (!isRecord(value) || !isOwnerId(value.ownerId) || !isRecord(value.preferences)) return false
  const preferences = value.preferences
  return NOTIFICATION_CATEGORIES.every(category => {
    const channels = preferences[category]
    return isRecord(channels) && typeof channels.inApp === 'boolean' && typeof channels.email === 'boolean'
  })
}

export const fetchNotificationPreferences = (ownerId: number, signal?: AbortSignal): Promise<NotificationPreferencesResponse> =>
  requestJson('/_api/pages/notifications/preferences', ownerId, isPreferencesResponse, 'Notification preferences could not be loaded.', signal)

export const updateNotificationPreferences = (
  ownerId: number,
  preferences: NotificationPreferencesPatch,
  signal?: AbortSignal
): Promise<NotificationPreferencesResponse> =>
  requestJson('/_api/pages/notifications/preferences', ownerId, isPreferencesResponse, 'Notification preferences could not be saved.', signal, preferences)

const isMyDiscussionsPage = (value: unknown): value is MyDiscussionsPage & { ownerId: number } => {
  if (!isRecord(value) || !isOwnerId(value.ownerId) || !Array.isArray(value.items)) return false
  if (!(value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))) return false
  return value.items.every(item => {
    if (
      !isRecord(item) ||
      !isOwnerId(item.id) ||
      !Number.isSafeInteger(item.replyTo) ||
      Number(item.replyTo) < 0 ||
      typeof item.content !== 'string' ||
      !isTimestamp(item.createdAt) ||
      !isTimestamp(item.updatedAt) ||
      !isRecord(item.page)
    )
      return false
    return (
      isOwnerId(item.page.id) &&
      typeof item.page.title === 'string' &&
      typeof item.page.path === 'string' &&
      typeof item.page.locale === 'string' &&
      isVisibility(item.page.visibility)
    )
  })
}

export const fetchMyDiscussions = (ownerId: number, cursor?: string | null, signal?: AbortSignal): Promise<MyDiscussionsPage> => {
  const query = new URLSearchParams({ limit: '30' })
  if (cursor) query.set('cursor', cursor)
  return requestJson(`/_api/comments/mine?${query}`, ownerId, isMyDiscussionsPage, 'Your discussions could not be loaded.', signal)
}

export const notificationPageHref = (item: Pick<PageWatchNotification, 'visibility' | 'localeCode' | 'path'> & { commentId?: number | null }): string => {
  const path = pageHref({ visibility: item.visibility, locale: item.localeCode, path: item.path })
  return item.commentId ? `${path}#comment-post-id-${item.commentId}` : path
}

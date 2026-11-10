export const NOTIFICATION_CATEGORIES = ['pageCreated', 'pageDeleted', 'watchedPageComment', 'commentReply', 'mention', 'feedbackStatus', 'reviewReminder', 'pageLifecycle'] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]
export type PageNotificationCategory = NotificationCategory | 'pageWatch'

export const NOTIFICATION_CEILING_CATEGORIES = [...NOTIFICATION_CATEGORIES, 'pageWatch'] as const
export const NOTIFICATION_CEILING_MODES = ['off', 'in-app-only', 'existing-consented-channels'] as const
export type NotificationCeiling = (typeof NOTIFICATION_CEILING_MODES)[number]
export type NotificationCeilings = Record<PageNotificationCategory, NotificationCeiling>
export interface NotificationSettingsResponse {
  ceilings: NotificationCeilings
  fingerprint: string
}
export const defaultNotificationCeilings = (): NotificationCeilings => ({
  pageCreated: 'existing-consented-channels',
  pageDeleted: 'existing-consented-channels',
  watchedPageComment: 'existing-consented-channels',
  commentReply: 'existing-consented-channels',
  mention: 'existing-consented-channels',
  pageWatch: 'existing-consented-channels',
  feedbackStatus: 'existing-consented-channels',
  reviewReminder: 'existing-consented-channels',
  pageLifecycle: 'existing-consented-channels'
})

export interface NotificationChannels {
  inApp: boolean
  email: boolean
}

export type NotificationPreferences = Record<NotificationCategory, NotificationChannels>
export type NotificationPreferencesPatch = Partial<Record<NotificationCategory, Partial<NotificationChannels>>>

export interface NotificationPreferencesResponse {
  ownerId: number
  preferences: NotificationPreferences
  ceilings: NotificationCeilings
}

export type ApprovalStatus = 'submitted' | 'approved' | 'changes-requested' | 'rejected' | 'cancelled' | 'published'

export interface LifecycleNotificationOutcome {
  kind: 'add-tags' | 'set-notice' | 'propose-move'
  state: 'applied' | 'skipped' | 'proposed' | 'fulfilled' | 'blocked' | 'failed' | 'suspended' | 'cancelled'
}

export interface PageWatchNotification {
  id: string
  pageId: number
  eventType: string
  category: PageNotificationCategory
  commentId: number | null
  actorName: string
  title: string
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  createdAt: string
  readAt: string | null
  outcomes?: LifecycleNotificationOutcome[]
}

export interface PageWatchNotificationList {
  ownerId: number
  items: PageWatchNotification[]
  /** Number of unread page/discussion notifications in this returned window only. */
  unreadCount: number
  nextCursor: string | null
  unreadComplete: boolean
}

export interface PageApprovalInboxItem {
  id: string
  pageId: number
  submitterId: number
  assigneeId: number | null
  status: ApprovalStatus
  revisionId: number
  revisionUpdatedAt: string
  reviewedSourceRevision: string | null
  publishedSourceRevision: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  stale: boolean
  canReview: boolean
  title: string
  path: string
  localeCode: string
  visibility: 'public' | 'private'
}

export interface PageApprovalInbox {
  ownerId: number
  items: PageApprovalInboxItem[]
  nextCursor: string | null
}

export type SiteNotificationItemKey = `watch:${string}` | `approval:${string}`

export type SiteNotificationItem =
  | (PageWatchNotification & { kind: 'watch'; itemKey: `watch:${string}` })
  | (PageApprovalInboxItem & { kind: 'approval'; itemKey: `approval:${string}` })

export interface GovernedNotificationReceiptList {
  ownerId: number
  items: Array<{
    id: string
    pageId: number
    category: 'feedbackStatus' | 'pageLifecycle'
    channel: 'email' | 'in-app'
    status: 'pending' | 'sending' | 'delivered' | 'sent' | 'suppressed' | 'unknown' | 'failed'
    attempt: number
    updatedAt: string
    canResend: boolean
    title: string
    path: string
    localeCode: string
    visibility: 'public' | 'private'
  }>
}

export type ApprovalStatus = 'submitted' | 'approved' | 'changes-requested' | 'rejected' | 'cancelled' | 'published'

export interface PageWatchNotification {
  id: string
  pageId: number
  eventType: string
  actorName: string
  title: string
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  createdAt: string
  readAt: string | null
}

export interface PageWatchNotificationList {
  ownerId: number
  items: PageWatchNotification[]
  /** Number of unread watch notifications in this returned window only. */
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

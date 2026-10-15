import type { Knex } from 'knex'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { canReadPage, canWritePage, managesSystem, pageAuthorizationContext, principalId } from '../helpers/page-access.ts'
import type { PagePrincipal, PageVisibilityRecord } from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'

export interface NotificationPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
  localeCode: string
  isPublished?: unknown
  publishStartDate?: unknown
  publishEndDate?: unknown
}

export interface NotificationComment {
  id: number
  pageId: number
  authorId: number
  replyTo: number
  name: string
  content: string
  isHidden: boolean | number
}

interface DiscussionNotificationAccess {
  enabled: boolean
  comments: Map<number, NotificationComment>
  protectedPageIds: Set<number>
  unlockedPageIds: Set<number>
}

const dbBoolean = (value: unknown): boolean => value === true || value === 1

const notificationRuntime = () =>
  WIKI as unknown as {
    config: { features?: { featurePageComments?: boolean } }
    auth: { checkPageAccess(requester: PagePrincipal, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean }
  }

export const canReadNotificationPage = (requester: PagePrincipal, page: NotificationPage, authority: PageRuleAuthority): boolean =>
  canReadPage(requester, page, authority) &&
  (page.visibility !== 'public' || (dbBoolean(page.isPublished) && publicationWindowOpen(page)) || canWritePage(requester, page, authority))

export const loadNotificationComments = async (database: Knex | Knex.Transaction, commentIds: readonly number[]): Promise<Map<number, NotificationComment>> => {
  if (commentIds.length === 0) return new Map()
  const rows = await database<NotificationComment>('comments')
    .whereIn('id', commentIds)
    .select('id', 'pageId', 'authorId', 'replyTo', 'name', 'content', 'isHidden')
  return new Map(
    rows.map(row => [
      Number(row.id),
      { ...row, id: Number(row.id), pageId: Number(row.pageId), authorId: Number(row.authorId), replyTo: Number(row.replyTo) || 0 }
    ])
  )
}

export const loadDiscussionNotificationAccess = async (
  database: Knex | Knex.Transaction,
  pageIds: readonly number[],
  commentIds: readonly number[],
  requester: PagePrincipal,
  // A background delivery has no session; it may use a current recipient-owned unlock grant.
  // Interactive reads pass the actual request session, never another session's grant.
  sessionId: string | null
): Promise<DiscussionNotificationAccess> => {
  const comments = await loadNotificationComments(database, commentIds)
  const providers = await database('commentProviders').where('isEnabled', true).select('key')
  const featureRow = await database('settings').where('key', 'features').first('value')
  const value: unknown = typeof featureRow?.value === 'string' ? JSON.parse(featureRow.value) : featureRow?.value
  const features = value && typeof value === 'object' && !Array.isArray(value) ? value : notificationRuntime().config.features
  const enabled = dbBoolean(features && Reflect.get(features, 'featurePageComments')) && providers.length === 1 && providers[0]?.key === 'default'
  const protections =
    pageIds.length > 0 ? await database<{ pageId: number; version: number }>('pageAccessPasswords').whereIn('pageId', pageIds).select('pageId', 'version') : []
  const protectedPageIds = new Set(protections.map(row => Number(row.pageId)))
  const unlockedPageIds = new Set<number>()
  const userId = principalId(requester)
  if (userId !== null && protectedPageIds.size > 0 && (sessionId === null || sessionId.length > 0)) {
    const query = database<{ pageId: number; passwordVersion: number }>('pageUnlockGrants')
      .where('userId', userId)
      .whereIn('pageId', [...protectedPageIds])
      .where('expiresAt', '>', new Date())
      .select('pageId', 'passwordVersion')
    if (sessionId !== null) query.where('sessionId', sessionId)
    const versions = new Map(protections.map(row => [Number(row.pageId), Number(row.version)]))
    for (const grant of await query) if (versions.get(Number(grant.pageId)) === Number(grant.passwordVersion)) unlockedPageIds.add(Number(grant.pageId))
  }
  return { enabled, comments, protectedPageIds, unlockedPageIds }
}

export const canReadDiscussionNotification = (
  requester: PagePrincipal,
  page: NotificationPage,
  commentId: number,
  authority: PageRuleAuthority,
  access: DiscussionNotificationAccess
): boolean => {
  const comment = access.comments.get(commentId)
  const context = pageAuthorizationContext(page)
  return Boolean(
    access.enabled &&
      comment &&
      comment.pageId === page.id &&
      !dbBoolean(comment.isHidden) &&
      canReadNotificationPage(requester, page, authority) &&
      context &&
      notificationRuntime().auth.checkPageAccess(requester, ['read:comments'], context, authority) &&
      (!access.protectedPageIds.has(page.id) || access.unlockedPageIds.has(page.id) || managesSystem(requester))
  )
}

/** Deleted pages have no live row. Their immutable event location is checked against CURRENT recipient authority. */
export const deletedNotificationPage = (eventType: string, payload: unknown): NotificationPage | undefined => {
  if (eventType !== 'page.deleted' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const id = Reflect.get(payload, 'pageId')
  const title = Reflect.get(payload, 'title')
  const path = Reflect.get(payload, 'path')
  const localeCode = Reflect.get(payload, 'localeCode')
  const visibility = Reflect.get(payload, 'visibility')
  const ownerId = Reflect.get(payload, 'ownerId')
  const tags = Reflect.get(payload, 'tags')
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof title !== 'string' ||
    !title ||
    typeof path !== 'string' ||
    !path ||
    typeof localeCode !== 'string' ||
    !localeCode ||
    (visibility !== 'public' && visibility !== 'private') ||
    (ownerId !== null && (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1)) ||
    !Array.isArray(tags)
  )
    return undefined
  const page: NotificationPage = { id, title, path, localeCode, visibility, ownerId, tags }
  return pageAuthorizationContext(page) ? page : undefined
}

/**
 * A missing live page is not proof that its old event title is safe. Use the current native
 * recovery scope, and, when its route has been replaced, only current replacement metadata.
 * Password-protected or unverifiable deleted/replacement scopes have no background-safe title.
 */
export const loadDeletedNotificationScopes = async (
  database: Knex | Knex.Transaction,
  events: readonly { id: string; type: string; payload: string }[]
): Promise<Map<string, NotificationPage>> => {
  const eventPages = new Map<string, NotificationPage>()
  for (const event of events) {
    const page = deletedNotificationPage(event.type, JSON.parse(event.payload))
    if (page) eventPages.set(event.id, page)
  }
  if (eventPages.size === 0) return new Map()
  const recoveryRows = await database<{ pageId: number; deletionVersionId: number; securityContext: unknown }>('deletedPageRecovery')
    .whereIn(
      'pageId',
      [...eventPages.values()].map(page => page.id)
    )
    .select('pageId', 'deletionVersionId', 'securityContext')
  const historyRows =
    recoveryRows.length > 0
      ? await database<{ id: number; title: string }>('pageHistory')
          .whereIn(
            'id',
            recoveryRows.map(row => row.deletionVersionId)
          )
          .select('id', 'title')
      : []
  const historyTitles = new Map(historyRows.map(row => [Number(row.id), row.title]))
  const safeRecovery = new Map<number, { former: Record<string, unknown>; title: string }>()
  for (const row of recoveryRows) {
    let security: unknown = row.securityContext
    if (typeof security === 'string') {
      try {
        security = JSON.parse(security)
      } catch {
        continue
      }
    }
    if (
      !security ||
      typeof security !== 'object' ||
      Array.isArray(security) ||
      Reflect.get(security, 'version') !== 1 ||
      !Object.hasOwn(security, 'protection') ||
      Reflect.get(security, 'protection') !== null
    )
      continue
    const former: unknown = Reflect.get(security, 'former')
    const title = historyTitles.get(Number(row.deletionVersionId))
    if (!former || typeof former !== 'object' || Array.isArray(former) || typeof title !== 'string' || !title) continue
    safeRecovery.set(Number(row.pageId), { former: former as Record<string, unknown>, title })
  }
  const scopes = new Map<string, NotificationPage>()
  for (const [eventId, eventPage] of eventPages) {
    const recovery = safeRecovery.get(eventPage.id)
    if (!recovery) continue
    const former = recovery.former
    if (
      former.path !== eventPage.path ||
      former.localeCode !== eventPage.localeCode ||
      former.visibility !== eventPage.visibility ||
      former.ownerId !== eventPage.ownerId
    )
      continue
    const page = deletedNotificationPage('page.deleted', { ...former, pageId: eventPage.id, title: recovery.title })
    if (page) scopes.set(eventId, page)
  }
  if (scopes.size === 0) return scopes
  const replacements = await database<NotificationPage>('pages')
    .where(function () {
      for (const page of scopes.values()) this.orWhere({ path: page.path, localeCode: page.localeCode, visibility: page.visibility, ownerId: page.ownerId })
    })
    .select('id', 'title', 'path', 'localeCode', 'visibility', 'ownerId', 'isPublished', 'publishStartDate', 'publishEndDate')
  if (replacements.length === 0) return scopes
  const replacementIds = replacements.map(page => Number(page.id))
  const protections = await database<{ pageId: number }>('pageAccessPasswords').whereIn('pageId', replacementIds).select('pageId')
  const protectedIds = new Set(protections.map(row => Number(row.pageId)))
  const tags = await database<{ pageId: number; tag: string }>('pageTags')
    .join('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', replacementIds)
    .select('pageTags.pageId as pageId', 'tags.tag as tag')
  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  for (const row of tags) {
    const values = tagsByPage.get(Number(row.pageId)) ?? []
    values.push({ tag: row.tag })
    tagsByPage.set(Number(row.pageId), values)
  }
  const scopeKey = (page: NotificationPage): string => JSON.stringify([page.path, page.localeCode, page.visibility, page.ownerId])
  const replacementsByScope = new Map(replacements.map(page => [scopeKey(page), page]))
  for (const [eventId, scope] of scopes) {
    const replacement = replacementsByScope.get(scopeKey(scope))
    if (!replacement) continue
    if (protectedIds.has(Number(replacement.id))) {
      scopes.delete(eventId)
      continue
    }
    scopes.set(eventId, { ...replacement, id: scope.id, tags: tagsByPage.get(Number(replacement.id)) ?? [], isDeletedNotificationReplacement: true })
  }
  return scopes
}

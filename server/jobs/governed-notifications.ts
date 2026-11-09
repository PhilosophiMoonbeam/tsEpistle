import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { NotificationCategory, GovernedNotificationReceiptList, LifecycleNotificationOutcome } from '../../shared/site-notifications.ts'
import type { MailPageWatchAction } from '../../shared/mail-workspace.ts'
import { DurableJobStore, type DurableJob, type DurableJobHandler } from '../core/durable-jobs.ts'
import { writeOutboxEvent, type OutboxEventInput } from '../core/outbox.ts'
import { authorizePageCreationAccount } from '../operations/live-notes.ts'
import { feedbackNotificationContext } from '../operations/page-feedback.ts'
import { resolvePageReviewRecipients, readReviewClock, reviewDatabaseNow, type ReviewRoutingRow } from '../operations/page-review-routing.ts'
import { pageRoute, type PagePrincipal } from '../helpers/page-access.ts'
import { canReadDiscussionNotification, canReadNotificationPage, loadDiscussionNotificationAccess, loadNotificationComments, type NotificationPage } from './notification-access.ts'
import type { NotificationOutboxEvent } from './notification-audience.ts'
import { ceilingChannels, lockNotificationSettings, readNotificationCeilings } from './notification-ceilings.ts'
import type { PageReviewNotificationAdapter, ReviewNotificationEffect } from './page-review-reminders.ts'
import type { PageWatchWikiContext } from './page-watch-notification.ts'
import type { MailRuntime } from '../core/mail.ts'
import { commentMentionHandles } from '../helpers/comment-markdown.ts'

type GovernedCategory = 'feedbackStatus' | 'reviewReminder' | 'pageLifecycle'
type JobFence = { id: string; owner: string; token: string; type: string; version: number }
interface Effect {
  origin: 'scheduled' | 'feedback'; category: GovernedCategory; eventId: string; pageId: number; userId: number; admittedAt: string
  sourceRevision?: string; jobFence?: JobFence
}
interface NotificationContent {
  page: NotificationPage & { title: string; path: string; localeCode: string; visibility: 'public' | 'private' }
  email: string; actorName: string; eventType: string; action: MailPageWatchAction
  outcomes?: LifecycleNotificationOutcome[]
}
interface Projection extends NotificationContent {
  inAppEnabled: boolean; emailEnabled: boolean
}
const enabled = (value: unknown): boolean => value === true || value === 1
const runtime = () => WIKI as unknown as Omit<PageWatchWikiContext, 'mail'> & { mail: Pick<MailRuntime, 'send'> }
const object = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Invalid governed notification event')
  return parsed as Record<string, unknown>
}
const fenceCurrent = async (tx: Knex.Transaction, fence: JobFence | undefined): Promise<boolean> => {
  if (!fence) return true
  return Boolean(await tx('durableJobs').where({ id: fence.id, type: fence.type, version: fence.version, state: 'running', leaseOwner: fence.owner, leaseToken: fence.token }).where('leaseExpiresAt', '>', tx.raw('clock_timestamp()')).forUpdate().first('id'))
}
const account = async (tx: Knex.Transaction, userId: number): Promise<Express.User | null> => {
  await tx('groups').orderBy('id').forShare().select('id')
  const row = await tx('users').where('id', userId).forShare().first()
  if (!row || !enabled(row.isActive) || enabled(row.isSystem) || userId === 2 || row.email === 'api@localhost') return null
  return await authorizePageCreationAccount(tx, row as Express.User) as Express.User
}
const channels = async (tx: Knex.Transaction, effect: Effect, category: NotificationCategory = effect.category) => {
  await lockNotificationSettings(tx)
  const pref = await tx('userNotificationPreferences').where({ userId: effect.userId, category }).first()
  const stopped = await tx('userNotificationPreferences').where({ userId: effect.userId, category: 'allEmailStopped' }).first('updatedAt')
  return ceilingChannels(await readNotificationCeilings(tx), category, effect.admittedAt, {
    inAppEnabled: enabled(pref?.inAppEnabled),
    emailEnabled: enabled(pref?.emailEnabled) && (!stopped || Date.parse(effect.admittedAt) > new Date(stopped.updatedAt).valueOf())
  })
}
const page = async (tx: Knex.Transaction, id: number): Promise<Projection['page'] | null> => {
  const row = await tx('pages').where('id', id).forShare().first('id', 'sourceRevision', 'title', 'path', 'localeCode', 'visibility', 'ownerId', 'isPublished', 'publishStartDate', 'publishEndDate')
  if (!row || typeof row.title !== 'string' || !row.title || typeof row.path !== 'string' || !row.path || typeof row.localeCode !== 'string' || !row.localeCode || (row.visibility !== 'public' && row.visibility !== 'private')) return null
  const tags = await tx('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', id).select('tags.tag')
  return { ...row, tags } as Projection['page']
}

interface FeedbackCandidateChannels {
  userId: number; statusInApp: boolean; statusEmail: boolean; discussionInApp: boolean; discussionEmail: boolean
}
const feedbackCandidateChannels = async (tx: Knex.Transaction, payload: Record<string, unknown>, createdAt: Date | string | number, onlyUserId?: number): Promise<FeedbackCandidateChannels[]> => {
  const pageId = Number(payload.pageId), actorId = Number(payload.actorId)
  const idea = await tx('feedbackIdeas').where({ id: String(payload.ideaId), boardId: String(payload.boardId), pageId }).first('submittedBy')
  if (!idea) return []
  const subscriptions = tx('feedbackSubscriptions').where('ideaId', String(payload.ideaId)).select('userId').forShare()
  const watchers = tx('pageWatchers').where('pageId', pageId).select('userId', 'inAppEnabled', 'emailEnabled')
  if (onlyUserId !== undefined) { subscriptions.where('userId', onlyUserId); watchers.where('userId', onlyUserId) }
  const subscriptionIds = new Set((await subscriptions).map(row => Number(row.userId)))
  const watchRows = await watchers, watchersById = new Map(watchRows.map(row => [Number(row.userId), row]))
  const commentId = payload.commentId === null || payload.commentId === undefined ? null : Number(payload.commentId)
  const comment = commentId === null ? undefined : (await loadNotificationComments(tx, [commentId])).get(commentId)
  const mentionedIds = new Set<number>()
  let replyAuthor: number | null = null
  if (comment && comment.pageId === pageId && !enabled(comment.isHidden) && comment.authorId === actorId) {
    const participantQuery = tx('comments').where({ pageId, isHidden: false }).whereNotNull('authorId').distinct('authorId')
    if (onlyUserId !== undefined) participantQuery.where('authorId', onlyUserId)
    const participants = await participantQuery
    const participantIds = participants.map(row => Number(row.authorId))
    const handles = commentMentionHandles(comment.content)
    if (handles.length && participantIds.length) {
      const claims = await tx('userHandleClaims').whereIn('userId', onlyUserId === undefined ? participantIds : participantIds.filter(id => id === onlyUserId)).whereIn('handle', handles).select('userId')
      for (const claim of claims) mentionedIds.add(Number(claim.userId))
    }
    if (comment.replyTo > 0) {
      const parent = (await loadNotificationComments(tx, [comment.replyTo])).get(comment.replyTo)
      if (parent && parent.pageId === pageId && !enabled(parent.isHidden) && parent.authorId !== null && participantIds.includes(parent.authorId)) replyAuthor = parent.authorId
    }
  }
  const ids = [...new Set([Number(idea.submittedBy), ...subscriptionIds, ...watchersById.keys(), ...mentionedIds, ...(replyAuthor === null ? [] : [replyAuthor])])]
    .filter(id => Number.isSafeInteger(id) && id > 0 && id !== 2 && id !== actorId && (onlyUserId === undefined || id === onlyUserId))
  if (!ids.length) return []
  const activeAccounts = await tx('users').whereIn('id', ids).where({ isActive: true, isSystem: false }).whereNot('email', 'api@localhost').select('id')
  const activeIds = activeAccounts.map(row => Number(row.id))
  if (!activeIds.length) return []
  await lockNotificationSettings(tx)
  const ceiling = await readNotificationCeilings(tx)
  const preferences = await tx('userNotificationPreferences').whereIn('userId', activeIds).whereIn('category', ['feedbackStatus', 'mention', 'commentReply', 'watchedPageComment', 'allEmailStopped']).select('*').forShare()
  // Preference writers update preferences before watch channels. Keep the same lock order.
  const currentWatches = await tx('pageWatchers').where('pageId', pageId).whereIn('userId', activeIds).orderBy('userId').select('userId', 'inAppEnabled', 'emailEnabled').forShare()
  watchersById.clear()
  for (const watcher of currentWatches) watchersById.set(Number(watcher.userId), watcher)
  const preferencesByUser = new Map<number, Map<string, typeof preferences[number]>>()
  for (const row of preferences) {
    const userId = Number(row.userId)
    let categories = preferencesByUser.get(userId)
    if (!categories) { categories = new Map(); preferencesByUser.set(userId, categories) }
    categories.set(String(row.category), row)
  }
  return activeIds.map(userId => {
    const prefRows = preferencesByUser.get(userId)
    const stopped = prefRows?.get('allEmailStopped')
    const channel = (category: NotificationCategory) => {
      const pref = prefRows?.get(category)
      return ceilingChannels(ceiling, category, createdAt, { inAppEnabled: enabled(pref?.inAppEnabled), emailEnabled: enabled(pref?.emailEnabled) && (!stopped || new Date(createdAt).valueOf() > new Date(stopped.updatedAt).valueOf()) })
    }
    const status = channel('feedbackStatus'), watcher = watchersById.get(userId)
    const statusEligible = Number(idea.submittedBy) === userId || subscriptionIds.has(userId)
    const result: FeedbackCandidateChannels = { userId, statusInApp: status.inAppEnabled && (statusEligible || enabled(watcher?.inAppEnabled)), statusEmail: status.emailEnabled && (statusEligible || enabled(watcher?.emailEnabled)), discussionInApp: false, discussionEmail: false }
    if (comment && comment.pageId === pageId && !enabled(comment.isHidden) && comment.authorId === actorId) {
      for (const category of ['mention', 'commentReply', 'watchedPageComment'] as const) {
        if (category === 'mention' ? !mentionedIds.has(userId) : category === 'commentReply' ? replyAuthor !== userId : !watcher) continue
        const consent = channel(category)
        result.discussionInApp ||= consent.inAppEnabled && (category !== 'watchedPageComment' || enabled(watcher?.inAppEnabled))
        result.discussionEmail ||= consent.emailEnabled && (category !== 'watchedPageComment' || enabled(watcher?.emailEnabled))
      }
    }
    return result
  })
}
export const snapshotFeedbackNotificationAudience = async (tx: Knex.Transaction, eventInput: OutboxEventInput & { id: string; createdAt: Date }): Promise<Array<{ userId: number; emailEnabled: boolean; inAppEnabled: boolean }>> => {
  if (eventInput.type !== 'feedback.status-changed') throw new TypeError('Feedback admission requires a status transition event')
  return (await feedbackCandidateChannels(tx, eventInput.payload, eventInput.createdAt)).map(row => ({ userId: row.userId, emailEnabled: row.statusEmail || row.discussionEmail, inAppEnabled: row.statusInApp || row.discussionInApp }))
    .filter(row => row.inAppEnabled || row.emailEnabled)
}

const admittedChannels = (payload: Record<string, unknown>, userId: number): { emailEnabled: boolean; inAppEnabled: boolean } | null => {
  if (!Array.isArray(payload.recipientChannels)) return null
  const entries = payload.recipientChannels.filter((row: unknown) => row && typeof row === 'object' && Reflect.get(row, 'userId') === userId)
  if (entries.length !== 1) return null
  const row: unknown = entries[0]
  if (!row || typeof row !== 'object' || typeof Reflect.get(row, 'emailEnabled') !== 'boolean' || typeof Reflect.get(row, 'inAppEnabled') !== 'boolean') return null
  return { emailEnabled: Reflect.get(row, 'emailEnabled'), inAppEnabled: Reflect.get(row, 'inAppEnabled') }
}
const eventFor = (tx: Knex.Transaction, eventId: string) => tx<NotificationOutboxEvent>('outboxEvents').where('id', eventId).first()

/** Shares current scope authorization; only delivery evaluates present channel consent. */
const projectGovernedNotificationContext = async (tx: Knex.Transaction, effect: Effect, purpose: 'delivery' | 'read', requester?: PagePrincipal, sessionId: string | null = null): Promise<Projection | null> => {
  const recipient = requester
    ? await authorizePageCreationAccount(tx, requester as Express.User) as Express.User
    : await account(tx, effect.userId)
  if (!recipient || enabled(Reflect.get(recipient, 'isSystem')) || recipient.email === 'api@localhost' ||
    (requester && Number(Reflect.get(requester, 'id')) !== effect.userId)) return null
  const savedEvent = effect.category === 'reviewReminder' ? undefined : await eventFor(tx, effect.eventId)
  if (effect.category !== 'reviewReminder' && !savedEvent) return null
  if (effect.category === 'feedbackStatus') {
    if (!savedEvent) return null
    const payload = object(savedEvent.payload)
    if (typeof payload.boardId !== 'string' || typeof payload.ideaId !== 'string') return null
    const observedBoard = await tx('feedbackBoards').where('id', payload.boardId).first('boardPageId')
    if (!observedBoard) return null
    // Native feedback writers lock pages in ID order before board/membership. Hold both scopes through handoff.
    await tx('pages').whereIn('id', [...new Set([effect.pageId, Number(observedBoard.boardPageId)])]).orderBy('id').select('id').forShare()
    const board = await tx('feedbackBoards').where('id', payload.boardId).forShare().first('boardPageId')
    const idea = await tx('feedbackIdeas').where({ id: payload.ideaId, boardId: payload.boardId, pageId: effect.pageId }).forShare().first('id')
    if (!board || Number(board.boardPageId) !== Number(observedBoard.boardPageId) || !idea) return null
  }
  const currentPage = await page(tx, effect.pageId)
  if (!currentPage) return null
  const authority = await runtime().auth.loadPageRuleAuthority(recipient, tx)
  if (!canReadNotificationPage(recipient, currentPage, authority)) return null
  let consent = purpose === 'delivery' ? await channels(tx, effect) : { inAppEnabled: false, emailEnabled: false }
  let eventType: string, action: MailPageWatchAction, actorName = ''
  let outcomes: LifecycleNotificationOutcome[] | undefined
  if (effect.category === 'reviewReminder') {
    const sourceRevision = effect.sourceRevision
    if (sourceRevision === undefined || await tx('pageAccessPasswords').where('pageId', effect.pageId).first('pageId')) return null
    if (purpose === 'delivery') {
      if (String(currentPage.sourceRevision) !== sourceRevision) return null
      const cycle = await tx('pageReviewCycles').where({ id: effect.eventId, pageId: effect.pageId }).first()
      const routing = await tx<ReviewRoutingRow>('pageReviewRouting').where('pageId', effect.pageId).first()
      if (!cycle || !routing || !routing.enabled || String(cycle.scheduleGeneration) !== String(routing.scheduleGeneration)) return null
      const clock = await readReviewClock(tx, routing, sourceRevision, await reviewDatabaseNow(tx))
      if (!clock.due || clock.due.epochKey !== cycle.epochKey || clock.due.milestone !== cycle.milestone) return null
      const resolution = await resolvePageReviewRecipients({ transaction: tx, pageId: effect.pageId, sourceRevision })
      const routed = resolution.recipients.find(row => row.userId === effect.userId)
      if (!routed) return null
      consent = { inAppEnabled: consent.inAppEnabled && routed.inAppEnabled, emailEnabled: consent.emailEnabled && routed.emailEnabled }
    }
    eventType = 'page.review-reminder'; action = 'review-reminder'
  } else {
    const event = savedEvent
    if (!event) return null
    const payload = object(event.payload)
    if (Number(payload.pageId) !== effect.pageId) return null
    eventType = event.type
    if (effect.category === 'feedbackStatus') {
      if (event.type !== 'feedback.status-changed' || payload.rootTransitionEventId !== effect.eventId || Number(payload.actorId) === effect.userId || typeof payload.boardId !== 'string' || typeof payload.ideaId !== 'string') return null
      const context = await feedbackNotificationContext(tx, { requester: recipient, sessionId, boardId: payload.boardId, ideaId: payload.ideaId })
      if (!context || context.pageId !== effect.pageId) return null
      const admitted = admittedChannels(payload, effect.userId)
      if (!admitted) return null
      if (purpose === 'delivery') {
        const candidate = (await feedbackCandidateChannels(tx, payload, event.createdAt, effect.userId))[0]
        if (!candidate) return null
        let inApp = candidate.statusInApp, email = candidate.statusEmail
        if (payload.commentId !== null && payload.commentId !== undefined && (candidate.discussionInApp || candidate.discussionEmail)) {
          const commentId = Number(payload.commentId)
          const access = await loadDiscussionNotificationAccess(tx, [effect.pageId], [commentId], recipient, sessionId)
          if (canReadDiscussionNotification(recipient, currentPage, commentId, authority, access)) {
            inApp ||= candidate.discussionInApp; email ||= candidate.discussionEmail
          }
        }
        consent = { inAppEnabled: inApp && admitted.inAppEnabled, emailEnabled: email && admitted.emailEnabled }
      } else if (payload.commentId !== null && payload.commentId !== undefined) {
        const commentId = Number(payload.commentId)
        const access = await loadDiscussionNotificationAccess(tx, [effect.pageId], [commentId], recipient, sessionId)
        if (!canReadDiscussionNotification(recipient, currentPage, commentId, authority, access)) return null
      }
      const actor = await tx('users').where('id', Number(payload.actorId)).first('name')
      actorName = typeof actor?.name === 'string' ? actor.name : ''
      action = 'feedback-status'
    } else {
      if (!['page.lifecycle-result', 'page.lifecycle-move-result'].includes(event.type) || await tx('pageAccessPasswords').where('pageId', effect.pageId).first('pageId')) return null
      if (purpose === 'delivery') {
        if (String(payload.sourceRevision) !== String(currentPage.sourceRevision)) return null
        const cycle = await tx('pageLifecycleCycles').where({ id: String(payload.cycleId), ruleId: String(payload.ruleId), pageId: effect.pageId }).first('ruleRevision')
        const rule = await tx('pageLifecycleRules').where('id', String(payload.ruleId)).forShare().first('revision', 'status')
        if (!cycle || !rule || Number(rule.revision) !== Number(cycle.ruleRevision) || !['enabled', 'retired', 'needs-attention'].includes(rule.status)) return null
      }
      let audiencePayload = payload
      if (event.type === 'page.lifecycle-move-result') {
        const original = await tx<NotificationOutboxEvent>('outboxEvents').where({ type: 'page.lifecycle-result' }).whereRaw("(payload::jsonb ->> 'cycleId') = ?", [String(payload.cycleId)]).first()
        if (!original) return null
        audiencePayload = object(original.payload)
      }
      if (!Array.isArray(audiencePayload.recipientIds) || !audiencePayload.recipientIds.includes(effect.userId)) return null
      const admitted = admittedChannels(audiencePayload, effect.userId)
      if (!admitted) return null
      if (purpose === 'delivery') {
        consent = { inAppEnabled: consent.inAppEnabled && admitted.inAppEnabled, emailEnabled: consent.emailEnabled && admitted.emailEnabled }
        if (audiencePayload.audience === 'review-route') {
          const routed = (await resolvePageReviewRecipients({ transaction: tx, pageId: effect.pageId, sourceRevision: String(currentPage.sourceRevision) })).recipients.find(row => row.userId === effect.userId)
          if (!routed) return null
          consent = { inAppEnabled: consent.inAppEnabled && routed.inAppEnabled, emailEnabled: consent.emailEnabled && routed.emailEnabled }
        } else if (audiencePayload.audience === 'watchers') {
          const watcher = await tx('pageWatchers').where({ pageId: effect.pageId, userId: effect.userId }).first()
          if (!watcher) return null
          consent = { inAppEnabled: consent.inAppEnabled && enabled(watcher.inAppEnabled), emailEnabled: consent.emailEnabled && enabled(watcher.emailEnabled) }
        } else return null
      }
      action = event.type === 'page.lifecycle-move-result' ? 'lifecycle-moved' : payload.outcome === 'needs-review' ? 'lifecycle-proposed' : 'lifecycle-result'
      if (event.type === 'page.lifecycle-result' && payload.outcome === 'needs-review') eventType = 'page.lifecycle-proposed'
      if (event.type === 'page.lifecycle-move-result') outcomes = [{ kind: 'propose-move', state: 'fulfilled' }]
      else {
        if (!Array.isArray(payload.actions)) return null
        outcomes = []
        for (const value of payload.actions) {
          if (!value || typeof value !== 'object') return null
          const kind: unknown = Reflect.get(value, 'kind'), state: unknown = Reflect.get(value, 'state')
          if (!['add-tags', 'set-notice', 'propose-move'].includes(String(kind)) || !['applied', 'skipped', 'proposed', 'fulfilled', 'blocked', 'failed', 'suspended', 'cancelled'].includes(String(state))) return null
          outcomes.push({ kind: kind as LifecycleNotificationOutcome['kind'], state: state as LifecycleNotificationOutcome['state'] })
        }
      }
    }
  }
  if (purpose === 'delivery' && !consent.inAppEnabled && !consent.emailEnabled) return null
  return { page: currentPage, email: typeof recipient.email === 'string' ? recipient.email : '', ...consent, actorName, eventType, action, ...(outcomes === undefined ? {} : { outcomes }) }
}

export const projectGovernedNotification = (tx: Knex.Transaction, effect: Effect, requester?: PagePrincipal, sessionId: string | null = null): Promise<Projection | null> =>
  projectGovernedNotificationContext(tx, effect, 'delivery', requester, sessionId)

const insertInbox = async (tx: Knex.Transaction, effect: Effect, projection: Projection): Promise<boolean> => {
  if (!projection.inAppEnabled || !await fenceCurrent(tx, effect.jobFence)) return false
  if (effect.category === 'reviewReminder' && !await tx('outboxEvents').where('id', effect.eventId).first('id')) {
    const review = effect as ReviewNotificationEffect
    await writeOutboxEvent(tx, { id: effect.eventId, type: 'page.review-reminder', version: 1, aggregateType: 'page', aggregateId: effect.pageId,
      payload: { origin: 'scheduled', category: 'reviewReminder', cycleId: effect.eventId, pageId: effect.pageId, sourceRevision: review.sourceRevision, milestone: review.milestone, dueAt: review.dueAt } })
  }
  const fence = effect.jobFence
  if (!fence) return false
  await tx.raw(`INSERT INTO "pageWatchNotifications"
    (id,"eventId","userId","pageId","eventType",category,"commentId","actorName",title,path,"localeCode",visibility,"createdAt","readAt")
    SELECT ?::uuid,?::uuid,?::integer,?::integer,?::text,?::text,NULL,?::text,?::text,?::text,?::text,?::text,clock_timestamp(),NULL
    WHERE EXISTS (SELECT 1 FROM "durableJobs" WHERE id=?::uuid AND type=? AND version=? AND state='running' AND "leaseOwner"=? AND "leaseToken"=? AND "leaseExpiresAt">clock_timestamp())
    ON CONFLICT ("eventId","userId") DO NOTHING`,
    [randomUUID(), effect.eventId, effect.userId, effect.pageId, projection.eventType, effect.category, projection.actorName, projection.page.title, projection.page.path, projection.page.localeCode, projection.page.visibility, fence.id, fence.type, fence.version, fence.owner, fence.token])
  return Boolean(await tx('pageWatchNotifications').where({ eventId: effect.eventId, userId: effect.userId }).first('id'))
}
export const governedReviewNotificationAdapter: PageReviewNotificationAdapter = {
  async deliverInApp(tx, effect) {
    const projection = await projectGovernedNotification(tx, effect)
    return projection ? insertInbox(tx, effect, projection) : false
  },
  sendEmail: (tx, effect) => sendGovernedEmail(tx, effect, effect.messageId)
}

class HandoffSuppressed extends Error {}
const sendGovernedEmail = async (tx: Knex.Transaction, effect: Effect, messageId: string): Promise<'sent' | 'suppressed' | 'retry-before-handoff'> => {
  let handoffAdmitted = false
  try {
    const projection = await projectGovernedNotification(tx, effect)
    if (!projection?.emailEnabled || !projection.email || !await fenceCurrent(tx, effect.jobFence)) return 'suppressed'
    const sent: unknown = await runtime().mail.send({
      template: 'page-watch', to: projection.email, messageId,
      data: { action: projection.action, actorName: projection.actorName, pageTitle: projection.page.title, url: `${runtime().config.host.replace(/\/$/, '')}${pageRoute(projection.page)}`, ...(projection.outcomes === undefined ? {} : { notificationOutcomes: projection.outcomes }) }
    }, undefined, async () => {
      const current = await projectGovernedNotification(tx, effect)
      if (!current?.emailEnabled || current.email !== projection.email || !await fenceCurrent(tx, effect.jobFence)) throw new HandoffSuppressed('Current handoff authority unavailable')
      handoffAdmitted = true
    })
    const accepted: unknown = sent && typeof sent === 'object' ? Reflect.get(sent, 'accepted') : undefined
    if (!Array.isArray(accepted) || !accepted.some(value => (typeof value === 'string' ? value : value && typeof value === 'object' ? Reflect.get(value, 'address') : undefined) === projection.email))
      throw new Error('SMTP did not acknowledge recipient acceptance')
    return 'sent'
  } catch (error) {
    if (error instanceof HandoffSuppressed) return 'suppressed'
    // The native mail callback runs only after all rendering and immediately before transport.sendMail.
    // Only an error before that point proves that no external handoff occurred.
    if (!handoffAdmitted) return 'retry-before-handoff'
    throw error
  }
}

export const projectGovernedInboxRow = async (tx: Knex.Transaction, row: { eventId: string; pageId: number; category: string | null }, userId: number, requester: PagePrincipal, sessionId: string): Promise<NotificationContent | null> => {
  if (row.category !== 'feedbackStatus' && row.category !== 'reviewReminder' && row.category !== 'pageLifecycle') return null
  let admittedAt: Date | string | number, sourceRevision: string | undefined
  if (row.category === 'reviewReminder') {
    const cycle = await tx('pageReviewCycles').where({ id: row.eventId, pageId: row.pageId }).first()
    if (!cycle) return null
    admittedAt = cycle.createdAt; sourceRevision = String(cycle.sourceRevision)
  } else {
    const event = await eventFor(tx, row.eventId)
    if (!event) return null
    admittedAt = event.createdAt
  }
  return projectGovernedNotificationContext(tx, { origin: row.category === 'feedbackStatus' ? 'feedback' : 'scheduled', category: row.category, eventId: row.eventId, pageId: row.pageId, userId, admittedAt: new Date(admittedAt).toISOString(), ...(sourceRevision === undefined ? {} : { sourceRevision }) }, 'read', requester, sessionId)
}

interface Receipt {
  id: string; eventId: string; userId: number; pageId: number; category: 'feedbackStatus' | 'pageLifecycle'; channel: 'email' | 'in-app'
  status: 'pending' | 'sending' | 'delivered' | 'sent' | 'suppressed' | 'unknown' | 'failed'
  attempt: number; messageId: string | null; admittedAt: Date | string; updatedAt: Date | string
}
const receiptEffect = (receipt: Receipt, jobFence?: JobFence): Effect => ({
  origin: receipt.category === 'feedbackStatus' ? 'feedback' : 'scheduled', category: receipt.category,
  eventId: receipt.eventId, pageId: receipt.pageId, userId: Number(receipt.userId), admittedAt: new Date(receipt.admittedAt).toISOString(),
  ...(jobFence ? { jobFence } : {})
})

/** Bounded keyset expansion; channel receipts are permanent per-root dedupe watermarks. */
export const enqueueGovernedNotificationAudience = async (tx: Knex.Transaction, event: NotificationOutboxEvent, afterUserId = 0): Promise<boolean> => {
  if (!['feedback.status-changed', 'page.lifecycle-result', 'page.lifecycle-move-result'].includes(event.type)) return false
  const payload = object(event.payload), category = event.type === 'feedback.status-changed' ? 'feedbackStatus' : 'pageLifecycle'
  const candidates = tx('userNotificationPreferences').whereIn('category', category === 'feedbackStatus' ? ['feedbackStatus', 'mention', 'commentReply', 'watchedPageComment'] : ['pageLifecycle'])
    .where(builder => builder.where('inAppEnabled', true).orWhere('emailEnabled', true))
    .where('userId', '>', afterUserId).distinct('userId').orderBy('userId').limit(101)
  const rows = await candidates
  for (const row of rows.slice(0, 100)) {
    const effect: Effect = { origin: category === 'feedbackStatus' ? 'feedback' : 'scheduled', category, eventId: event.id, pageId: Number(payload.pageId), userId: Number(row.userId), admittedAt: new Date(event.createdAt).toISOString() }
    const projection = await projectGovernedNotification(tx, effect)
    if (!projection) continue
    for (const channel of ['in-app', 'email'] as const) {
      if (!(channel === 'email' ? projection.emailEnabled : projection.inAppEnabled)) continue
      const now = new Date()
      const inserted = await tx('governedNotificationReceipts').insert({ id: randomUUID(), eventId: event.id, pageId: effect.pageId, userId: effect.userId, category, channel, status: 'pending', attempt: 0, messageId: null, safeFailureReason: null, admittedAt: effect.admittedAt, createdAt: now, updatedAt: now })
        .onConflict(['eventId', 'userId', 'channel']).ignore().returning('id')
      if (inserted.length) await new DurableJobStore(tx).enqueue({ type: 'notify-governed', version: 1, payload: { receiptId: inserted[0].id, attempt: 0 }, maxAttempts: 5, deduplicationKey: `governed:${event.id}:${effect.userId}:${channel}:0` })
    }
  }
  if (rows.length > 100) await new DurableJobStore(tx).enqueue({ type: 'notify-governed', version: 1, payload: { mode: 'audience', eventId: event.id, afterUserId: Number(rows[99]!.userId) }, maxAttempts: 5, deduplicationKey: `governed-audience:${event.id}:${rows[99]!.userId}` })
  return true
}

const jobFenceFor = (job: DurableJob): JobFence | null => job.leaseOwner && job.leaseToken
  ? { id: job.id, owner: job.leaseOwner, token: job.leaseToken, type: job.type, version: job.version } : null

export const createGovernedNotificationHandler = (): DurableJobHandler => async (job, { knex, signal }) => {
  signal.throwIfAborted()
  const fence = jobFenceFor(job)
  if (!fence) return
  if (job.payload.mode === 'audience') {
    await knex.transaction(async tx => {
      if (!await fenceCurrent(tx, fence)) return
      const event = await eventFor(tx, String(job.payload.eventId))
      if (event) await enqueueGovernedNotificationAudience(tx, event, Number(job.payload.afterUserId))
    })
    return
  }
  const receiptId = String(job.payload.receiptId)
  const attempt = job.payload.attempt
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError('Invalid governed notification attempt')
  const prepared = await knex.transaction(async tx => {
    const observed = await tx<Receipt>('governedNotificationReceipts').where('id', receiptId).first()
    if (!observed || observed.attempt !== attempt) return null
    const effect = receiptEffect(observed, fence)
    const projection = await projectGovernedNotification(tx, effect)
    if (!await fenceCurrent(tx, fence)) return null
    const receipt = await tx<Receipt>('governedNotificationReceipts').where('id', receiptId).forUpdate().first()
    if (!receipt || receipt.attempt !== attempt || !['pending', 'sending'].includes(receipt.status)) return null
    if (receipt.status === 'sending') {
      await tx('governedNotificationReceipts').where('id', receiptId).update({ status: 'unknown', safeFailureReason: 'Interrupted handoff; automatic replay refused', updatedAt: tx.fn.now() })
      await tx('governedNotificationEmailAttempts').where({ receiptId, attempt: receipt.attempt, status: 'sending' }).update({ status: 'unknown', updatedAt: tx.fn.now() })
      return null
    }
    signal.throwIfAborted()
    if (!projection || !(receipt.channel === 'email' ? projection.emailEnabled : projection.inAppEnabled)) {
      await tx('governedNotificationReceipts').where('id', receiptId).update({ status: 'suppressed', safeFailureReason: 'Current access or channel consent unavailable', updatedAt: tx.fn.now() })
      return null
    }
    if (receipt.channel === 'in-app') {
      const delivered = await insertInbox(tx, effect, projection)
      await tx('governedNotificationReceipts').where('id', receiptId).update({ status: delivered ? 'delivered' : 'suppressed', updatedAt: tx.fn.now() })
      return null
    }
    const messageId = `<governed-${receipt.id}-${receipt.attempt}@wiki.local>`
    await tx('governedNotificationReceipts').where('id', receiptId).update({ status: 'sending', messageId, safeFailureReason: null, updatedAt: tx.fn.now() })
    await tx('governedNotificationEmailAttempts').insert({ receiptId, attempt: receipt.attempt, status: 'sending', messageId, duplicateAcknowledged: receipt.attempt > 0, createdAt: tx.fn.now(), updatedAt: tx.fn.now() })
      .onConflict(['receiptId', 'attempt']).merge({ status: 'sending', updatedAt: tx.fn.now() })
    return { effect, messageId, attempt: receipt.attempt }
  })
  if (!prepared) return
  // Phase one committed the sending intent. Never roll it back with external I/O.
  let outcome: 'sent' | 'suppressed' | 'retry-before-handoff' | 'unknown' = 'unknown'
  let handoffInvoked = false
  try {
    outcome = await knex.transaction(async tx => {
      const projection = await projectGovernedNotification(tx, prepared.effect)
      if (signal.aborted || !projection?.emailEnabled || !await fenceCurrent(tx, fence)) return 'suppressed'
      const receipt = await tx<Receipt>('governedNotificationReceipts').where('id', receiptId).forUpdate().first()
      if (!receipt || receipt.status !== 'sending' || receipt.messageId !== prepared.messageId) return 'suppressed'
      handoffInvoked = true
      return sendGovernedEmail(tx, prepared.effect, prepared.messageId)
    })
  } catch { outcome = handoffInvoked ? 'unknown' : 'retry-before-handoff' }
  const retry = outcome === 'retry-before-handoff' && job.attempts < job.maxAttempts
  // Separate finalization: a crash here leaves the durable sending marker, never replayable mail.
  await knex.transaction(async tx => {
    const receipt = await tx('governedNotificationReceipts').where({ id: receiptId, status: 'sending', messageId: prepared.messageId }).forUpdate().first('id')
    if (!receipt) return
    await tx('governedNotificationReceipts').where('id', receiptId).update({
      status: outcome === 'retry-before-handoff' ? retry ? 'pending' : 'failed' : outcome,
      safeFailureReason: outcome === 'unknown' ? 'External acceptance unknown; deliberate warned resend required' : outcome === 'retry-before-handoff' ? 'Known pre-handoff failure' : null,
      updatedAt: tx.fn.now()
    })
    await tx('governedNotificationEmailAttempts').where({ receiptId, attempt: prepared.attempt, messageId: prepared.messageId, status: 'sending' }).update({
      status: outcome === 'retry-before-handoff' && !retry ? 'failed' : outcome, updatedAt: tx.fn.now()
    })
  })
  if (retry) throw new Error('Governed mail failed before handoff; bounded retry admitted')
}

export const recoverGovernedNotificationHandoffs = async (knex: Knex): Promise<void> => {
  await knex.transaction(async tx => {
    const interrupted = await tx('governedNotificationReceipts').where('status', 'sending').where('updatedAt', '<', tx.raw("clock_timestamp() - interval '30 seconds'"))
      .whereNotExists(tx('durableJobs').select(tx.raw('1')).where({ type: 'notify-governed', state: 'running' })
        .whereRaw("payload::jsonb ->> 'receiptId' = ??::text", ['governedNotificationReceipts.id'])
        .whereRaw("payload::jsonb ->> 'attempt' = ??::text", ['governedNotificationReceipts.attempt'])
        .where('leaseExpiresAt', '>', tx.raw('clock_timestamp()')))
      .orderBy('updatedAt').limit(100).forUpdate().skipLocked().select('id', 'attempt')
    for (const row of interrupted) {
      await tx('governedNotificationReceipts').where({ id: row.id, status: 'sending' }).update({ status: 'unknown', safeFailureReason: 'Interrupted handoff; automatic replay refused', updatedAt: tx.fn.now() })
      await tx('governedNotificationEmailAttempts').where({ receiptId: row.id, attempt: row.attempt, status: 'sending' }).update({ status: 'unknown', updatedAt: tx.fn.now() })
    }
    const exhausted = await tx('governedNotificationReceipts as receipt').where('receipt.status', 'pending')
      .whereExists(tx('durableJobs as job').select(tx.raw('1')).where({ 'job.type': 'notify-governed', 'job.state': 'failed' })
        .whereRaw("job.payload::jsonb ->> 'receiptId' = receipt.id::text")
        .whereRaw('?? = concat(?::text, ??::text, ?::text, ??::text, ?::text, ??, ?::text, ??::text)', ['job.deduplicationKey', 'governed:', 'receipt.eventId', ':', 'receipt.userId', ':', 'receipt.channel', ':', 'receipt.attempt']))
      .orderBy('receipt.updatedAt').limit(100).forUpdate().skipLocked().select('receipt.id')
    if (exhausted.length) await tx('governedNotificationReceipts').whereIn('id', exhausted.map(row => row.id)).where('status', 'pending')
      .update({ status: 'failed', safeFailureReason: 'Delivery preparation exhausted the bounded durable retry policy', updatedAt: tx.fn.now() })
    const cancelled = await tx('governedNotificationReceipts as receipt').where('receipt.status', 'pending')
      .whereExists(tx('durableJobs as job').select(tx.raw('1')).where({ 'job.type': 'notify-governed', 'job.state': 'cancelled' })
        .whereRaw("job.payload::jsonb ->> 'receiptId' = receipt.id::text")
        .whereRaw('?? = concat(?::text, ??::text, ?::text, ??::text, ?::text, ??, ?::text, ??::text)', ['job.deduplicationKey', 'governed:', 'receipt.eventId', ':', 'receipt.userId', ':', 'receipt.channel', ':', 'receipt.attempt']))
      .orderBy('receipt.updatedAt').limit(100).forUpdate().skipLocked().select('receipt.id')
    if (cancelled.length) await tx('governedNotificationReceipts').whereIn('id', cancelled.map(row => row.id)).where('status', 'pending')
      .update({ status: 'suppressed', safeFailureReason: 'Durable notification cancelled before external handoff', updatedAt: tx.fn.now() })
  })
}

export const cleanupGovernedNotifications = async (knex: Knex): Promise<boolean> => {
  return knex.transaction(async tx => {
    const expired = await tx('governedNotificationReceipts').whereNotIn('status', ['pending', 'sending'])
      .where('updatedAt', '<', tx.raw("clock_timestamp() - CASE WHEN status IN ('unknown','failed') THEN interval '365 days' ELSE interval '90 days' END"))
      .where(builder => builder.whereNotNull('messageId').orWhereNotNull('safeFailureReason')).orderBy('updatedAt').limit(100).select('id')
    // Keep root/user/channel/status and attempt as minimal non-replay watermarks.
    if (expired.length) await tx('governedNotificationReceipts').whereIn('id', expired.map(row => row.id)).update({ messageId: null, safeFailureReason: null })
    const oldAttempts = await tx('governedNotificationEmailAttempts').whereNot('status', 'sending').whereNotNull('messageId')
      .where('updatedAt', '<', tx.raw("clock_timestamp() - CASE WHEN status IN ('unknown','failed') THEN interval '365 days' ELSE interval '90 days' END"))
      .orderBy('updatedAt').limit(100).select('receiptId', 'attempt')
    for (const row of oldAttempts) await tx('governedNotificationEmailAttempts').where({ receiptId: row.receiptId, attempt: row.attempt }).update({ messageId: null })
    return expired.length === 100 || oldAttempts.length === 100
  })
}

interface OwnReceiptInput { knex: Knex; requester: Express.User; sessionId: string }
export const listOwnGovernedNotificationReceipts = async (input: OwnReceiptInput): Promise<GovernedNotificationReceiptList> => input.knex.transaction(async tx => {
  const owner = await authorizePageCreationAccount(tx, input.requester)
  const rows = await tx<Receipt>('governedNotificationReceipts').where('userId', owner.id).orderBy('updatedAt', 'desc').orderBy('id', 'desc').limit(100)
  const items: GovernedNotificationReceiptList['items'] = []
  for (const row of rows) {
    const projection = await projectGovernedNotificationContext(tx, receiptEffect(row), 'read', owner, input.sessionId)
    if (!projection) continue
    const canResend = row.channel === 'email' && ['unknown', 'failed'].includes(row.status) &&
      Boolean((await projectGovernedNotification(tx, receiptEffect(row), owner, input.sessionId))?.emailEnabled)
    items.push({ id: row.id, pageId: row.pageId, category: row.category, channel: row.channel, status: row.status, attempt: row.attempt, updatedAt: new Date(row.updatedAt).toISOString(), canResend,
      title: projection.page.title, path: projection.page.path, localeCode: projection.page.localeCode, visibility: projection.page.visibility })
    if (items.length >= 50) break
  }
  return { ownerId: owner.id, items }
})
export const resendOwnGovernedNotification = async (input: OwnReceiptInput & { id: string; acknowledged: true }): Promise<{ ownerId: number; id: string; status: 'pending' }> => input.knex.transaction(async tx => {
  const owner = await authorizePageCreationAccount(tx, input.requester)
  if (input.acknowledged !== true) throw Object.assign(new Error('Acknowledge possible duplicate email before resending.'), { status: 400, code: 'GOVERNED_RESEND_ACK_REQUIRED' })
  const observed = await tx<Receipt>('governedNotificationReceipts').where({ id: input.id, userId: owner.id }).first()
  if (!observed) throw Object.assign(new Error('Notification unavailable'), { status: 404, code: 'NOTIFICATION_NOT_FOUND' })
  const projection = await projectGovernedNotification(tx, receiptEffect(observed), owner, input.sessionId)
  const receipt = await tx<Receipt>('governedNotificationReceipts').where({ id: input.id, userId: owner.id }).forUpdate().first()
  if (!projection?.emailEnabled || !receipt || receipt.channel !== 'email' || !['unknown', 'failed'].includes(receipt.status)) throw Object.assign(new Error('Notification is not currently eligible for an explicit resend'), { status: 409, code: 'GOVERNED_RESEND_UNAVAILABLE' })
  const attempt = receipt.attempt + 1
  await tx('governedNotificationReceipts').where('id', receipt.id).update({ status: 'pending', attempt, messageId: null, safeFailureReason: 'Explicit recipient resend; possible duplicate acknowledged', updatedAt: tx.fn.now() })
  await new DurableJobStore(tx).enqueue({ type: 'notify-governed', version: 1, payload: { receiptId: receipt.id, attempt }, maxAttempts: 5, deduplicationKey: `governed:${receipt.eventId}:${owner.id}:email:${attempt}` })
  return { ownerId: owner.id, id: receipt.id, status: 'pending' }
})

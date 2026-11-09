import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { PageReviewCommandSchema, PageReviewPreviewSchema, PageReviewViewSchema, accuracyReviewClock, independentReviewClock, type PageReviewView, type ReviewClock } from '../../shared/page-review-routing.ts'
import { canReadPage, canWritePage, type PageVisibilityRecord } from '../helpers/page-access.ts'
import { loadPageRuleAuthority } from '../core/auth.ts'
import { authorizePageCreationAccount } from './live-notes.ts'
import { pageRequiresUnlock } from './page-protection.ts'
import errors from './errors.ts'
import { producePageReviewReminder } from '../jobs/page-review-reminders.ts'
import { ceilingChannels, lockNotificationSettings, readNotificationCeilings } from '../jobs/notification-ceilings.ts'
import type { PageReviewRoute } from '../../shared/page-review-routing.ts'

export interface ReviewRoutingRow {
  pageId: number; revision: string; mode: 'contacts' | 'users' | 'groups'; enabled: boolean
  scheduleMode: 'accuracy-age' | 'independent'; scheduleGeneration: string
  independentAnchorAt: Date | string | null; independentIntervalDays: number | null
  enabledAt: Date | string | null; observedSourceRevision: string; unverifiedAt: Date | string
  createdBy: number | null; updatedBy: number | null; createdAt: Date | string; updatedAt: Date | string
}
interface ReviewPage extends PageVisibilityRecord { id: number; sourceRevision: string; creatorId: number | null; authorId: number | null }
export interface ReviewRecipient { userId: number; emailEnabled: boolean; inAppEnabled: boolean }
export interface ReviewRecipientResolution { status: 'eligible' | 'disabled' | 'protected' | 'undeliverable'; routingRevision: string; recipients: ReviewRecipient[]; reason?: 'no-current-contacts' | 'no-eligible-recipients' | 'opted-out' }
export interface ReviewRecipientLocks { readonly transaction: Knex.Transaction; readonly pageId: number; readonly sourceRevision: string; readonly routingRevision: string; readonly candidateIds: readonly number[] }
interface BrowserInput { knex: Knex; requester: Express.User | undefined; sessionId: string; delegated: boolean; pageId: number }
const fail = (message: string, status: number, code: string): never => { throw new errors.ApplicationError(message, { status, code }) }
export const reviewDatabaseNow = async (transaction: Knex.Transaction): Promise<Date> => {
  const result = await transaction.raw<{ rows: Array<{ now: Date | string }> }>('SELECT clock_timestamp() AS now')
  const now = new Date(result.rows[0]!.now)
  if (!Number.isFinite(now.valueOf())) throw new Error('Database UTC clock unavailable')
  return now
}
const permissions = (value: unknown): string[] => {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}
const routeCandidates = async (transaction: Knex.Transaction, page: ReviewPage, routing: ReviewRoutingRow | undefined): Promise<number[]> => {
  if (!routing || routing.mode === 'contacts') return [...new Set([page.creatorId, page.authorId].filter((value): value is number => typeof value === 'number' && value > 0))]
  if (routing.mode === 'users') {
    const rows = await transaction('pageReviewRoutingUsers').where({ pageId: page.id }).whereNotNull('userId').select('userId')
    return rows.map(row => Number(row.userId))
  }
  const rows = await transaction('pageReviewRoutingGroups').join('userGroups', 'userGroups.groupId', 'pageReviewRoutingGroups.groupId').where('pageReviewRoutingGroups.pageId', page.id).distinct('userGroups.userId')
  return rows.map(row => Number(row.userId))
}
/** Prelocks only group/account authority; compose before native asset/search/page locks. */
export const lockPageReviewRecipientAccounts = async (input: { transaction: Knex.Transaction; pageId: number; sourceRevision: string; additionalUserIds?: readonly number[]; previewRoute?: PageReviewRoute }): Promise<ReviewRecipientLocks> => {
  const { transaction, pageId, sourceRevision } = input
  await transaction('groups').select('id').orderBy('id').forShare()
  const page = await transaction<ReviewPage>('pages').where('id', pageId).first()
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId }).first()
  const candidateIds = !page ? [] : input.previewRoute?.mode === 'users' ? input.previewRoute.userIds : input.previewRoute?.mode === 'groups' ? (await transaction('userGroups').whereIn('groupId', input.previewRoute.groupIds).distinct('userId')).map(row => Number(row.userId)) : await routeCandidates(transaction, page, input.previewRoute?.mode === 'contacts' ? undefined : routing)
  const accountIds = [...new Set([...candidateIds, ...(input.additionalUserIds ?? [])])].sort((a, b) => a - b)
  if (accountIds.length) await transaction('users').whereIn('id', accountIds).orderBy('id').select('id').forShare()
  return { transaction, pageId, sourceRevision, routingRevision: String(routing?.revision ?? '0'), candidateIds }
}
/** Current authority only. Prepared locks are transaction-bound, never saved reader authority. */
export const resolvePageReviewRecipients = async (input: { transaction: Knex.Transaction; pageId: number; sourceRevision: string; includeDisabled?: boolean; previewRoute?: PageReviewRoute; prepared?: ReviewRecipientLocks }): Promise<ReviewRecipientResolution> => {
  const { transaction, pageId, sourceRevision } = input
  const prepared = input.prepared ?? await lockPageReviewRecipientAccounts(input)
  if (prepared.transaction !== transaction || prepared.pageId !== pageId || prepared.sourceRevision !== sourceRevision) throw new Error('Review recipient locks belong to a different transaction or source')
  const groups = await transaction('groups').select('id', 'permissions').orderBy('id')
  const empty: ReviewRecipientResolution = { status: 'undeliverable', routingRevision: prepared.routingRevision, recipients: [] }
  const current = await transaction<ReviewPage>('pages').where('id', pageId).forUpdate().first()
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId }).forShare().first()
  if (!current || String(current.sourceRevision) !== sourceRevision || String(routing?.revision ?? '0') !== prepared.routingRevision) return empty
  const accounts = prepared.candidateIds.length ? await transaction('users').whereIn('id', prepared.candidateIds).orderBy('id') : []
  if ((!routing || !routing.enabled) && !input.includeDisabled) return { ...empty, status: 'disabled' }
  if (await transaction('pageAccessPasswords').where({ pageId }).first('pageId')) return { ...empty, status: 'protected' }
  const tags = await transaction('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', pageId).select('tags.tag')
  const page = { ...current, tags }
  const recipients: ReviewRecipient[] = []
  let hasEligibleAuthority = false
  for (const account of accounts) {
    if (account.isActive !== true || account.isSystem !== false || account.id === 2 || account.email === 'api@localhost') continue
    const memberships = await transaction('userGroups').where('userId', account.id).select('groupId')
    const groupIds = new Set(memberships.map(row => Number(row.groupId)))
    const requester = { ...account, permissions: account.id === 1 ? ['manage:system'] : [...new Set(groups.filter(group => groupIds.has(Number(group.id))).flatMap(group => permissions(group.permissions)))] } as Express.User
    const authority = await loadPageRuleAuthority(requester, transaction)
    if (!canReadPage(requester, page, authority) || !canWritePage(requester, page, authority)) continue
    hasEligibleAuthority = true
    const consent = await transaction('userNotificationPreferences').where({ userId: account.id, category: 'reviewReminder' }).forShare().first()
    const stopped = await transaction('userNotificationPreferences').where({ userId: account.id, category: 'allEmailStopped' }).forShare().first()
    const emailEnabled = consent?.emailEnabled === true && typeof account.email === 'string' && account.email.length > 0 && (!stopped || new Date(consent.updatedAt).valueOf() > new Date(stopped.updatedAt).valueOf())
    const inAppEnabled = consent?.inAppEnabled === true
    if (emailEnabled || inAppEnabled) recipients.push({ userId: Number(account.id), emailEnabled, inAppEnabled })
  }
  return { ...empty, status: recipients.length ? 'eligible' : 'undeliverable', recipients, ...(recipients.length ? {} : { reason: hasEligibleAuthority ? 'opted-out' : !accounts.length && (input.previewRoute?.mode ?? routing?.mode ?? 'contacts') === 'contacts' ? 'no-current-contacts' : 'no-eligible-recipients' }) }
}
export const readReviewClock = async (transaction: Knex.Transaction, routing: ReviewRoutingRow, sourceRevision: string, now: Date): Promise<ReviewClock> => {
  if (routing.scheduleMode === 'independent') return independentReviewClock(new Date(routing.independentAnchorAt!).toISOString(), routing.independentIntervalDays!, now.valueOf())
  const attestation = await transaction('pageAccuracyAttestations').where({ pageId: routing.pageId, sourceRevision }).orderBy('verifiedAt', 'desc').orderBy('id', 'desc').first('id', 'sourceRevision', 'verifiedAt')
  return accuracyReviewClock({ sourceRevision, attestation: attestation ? { ...attestation, sourceRevision: String(attestation.sourceRevision) } : null, unverifiedAt: new Date(routing.unverifiedAt).valueOf(), now: now.valueOf() })
}
const browserContext = async (transaction: Knex.Transaction, input: BrowserInput, previewRoute?: PageReviewRoute) => {
  if (input.delegated || !input.sessionId || !input.requester || 'api' in input.requester || 'grp' in input.requester) fail('A current human browser account is required.', 401, 'AUTH_REQUIRED')
  const actorId = input.requester?.id
  if (typeof actorId !== 'number' || !Number.isSafeInteger(actorId) || actorId < 1) return fail('A current human browser account is required.', 401, 'AUTH_REQUIRED')
  const observed = await transaction<ReviewPage>('pages').where('id', input.pageId).first()
  const prepared = observed ? await lockPageReviewRecipientAccounts({ transaction, pageId: input.pageId, sourceRevision: String(observed.sourceRevision), additionalUserIds: [actorId], ...(previewRoute ? { previewRoute } : {}) }) : undefined
  const requester = await authorizePageCreationAccount(transaction, input.requester)
  if (Reflect.get(requester, 'isSystem') !== false || Reflect.get(requester, 'email') === 'api@localhost') fail('A human browser account is required.', 401, 'AUTH_REQUIRED')
  const preflight = observed ? await resolvePageReviewRecipients({ transaction, pageId: input.pageId, sourceRevision: String(observed.sourceRevision), includeDisabled: true, ...(prepared ? { prepared } : {}), ...(previewRoute ? { previewRoute } : {}) }) : null
  const page = await transaction<ReviewPage>('pages').where('id', input.pageId).forUpdate().first()
  if (!page) return fail('This page does not exist.', 404, 'PAGE_NOT_FOUND')
  const currentRoute = await transaction('pageReviewRouting').where({ pageId: page.id }).first('revision')
  if (observed && (String(observed.sourceRevision) !== String(page.sourceRevision) || preflight?.routingRevision !== String(currentRoute?.revision ?? '0'))) fail('The page or routing changed. Reload before continuing.', 409, 'PAGE_REVIEW_STALE')
  const tags = await transaction('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', page.id).select('tags.tag')
  const authority = await loadPageRuleAuthority(requester, transaction)
  if (!canReadPage(requester, { ...page, tags }, authority)) return fail('This page does not exist.', 404, 'PAGE_NOT_FOUND')
  if (!canWritePage(requester, { ...page, tags }, authority)) fail('Current page writer authority is required.', 403, 'PAGE_REVIEW_FORBIDDEN')
  if (await pageRequiresUnlock({ requester, pageId: page.id, sessionId: input.sessionId, transaction, readOnly: true })) fail('Access denied', 403, 'PAGE_LOCKED')
  return { requester, page, resolution: preflight }
}
const defaultRouting = (page: ReviewPage, now: Date, actorId: number): ReviewRoutingRow => ({ pageId: page.id, revision: '0', mode: 'contacts', enabled: false, scheduleMode: 'accuracy-age', scheduleGeneration: '1', independentAnchorAt: null, independentIntervalDays: null, enabledAt: null, observedSourceRevision: String(page.sourceRevision), unverifiedAt: now, createdBy: actorId, updatedBy: actorId, createdAt: now, updatedAt: now })
const view = async (transaction: Knex.Transaction, page: ReviewPage, routing: ReviewRoutingRow, now: Date, previewRoute?: PageReviewRoute): Promise<PageReviewView> => {
  const resolution = await resolvePageReviewRecipients({ transaction, pageId: page.id, sourceRevision: String(page.sourceRevision), includeDisabled: true, ...(previewRoute ? { previewRoute } : {}) })
  const members: PageReviewView['members'] = []
  if ((previewRoute?.mode ?? routing.mode) === 'contacts') {
    const ids = await routeCandidates(transaction, page, undefined)
    const rows = ids.length ? await transaction('users').whereIn('id', ids).where({ isSystem: false }).whereNot('id', 2).whereNot('email', 'api@localhost').select('id', 'name', 'isActive') : []
    for (const row of rows) members.push({ id: Number(row.id), name: row.name ?? null, unavailable: row.isActive !== true })
  } else if (previewRoute && previewRoute.mode !== 'contacts') {
    const ids = previewRoute.mode === 'users' ? previewRoute.userIds : previewRoute.groupIds
    const rows = await transaction(previewRoute.mode === 'users' ? 'users' : 'groups').whereIn('id', ids).select('id', 'name')
    for (const row of rows) members.push({ id: Number(row.id), name: row.name ?? null, unavailable: false })
  } else if (!previewRoute && routing.mode !== 'contacts') {
    const users = routing.mode === 'users'
    const table = users ? 'pageReviewRoutingUsers' : 'pageReviewRoutingGroups'
    const target = users ? 'users' : 'groups'
    const column = users ? 'userId' : 'groupId'
    const rows = await transaction(table).leftJoin(target, `${target}.id`, `${table}.${column}`).where(`${table}.pageId`, page.id).select(`${table}.referenceId`, `${target}.name`, `${target}.id as currentId`, ...(users ? ['users.isActive', 'users.isSystem', 'users.email'] : []))
    for (const row of rows) members.push({ id: Number(row.referenceId), name: row.name ?? null, unavailable: row.currentId === null || (users && (row.isActive !== true || row.isSystem !== false || row.email === 'api@localhost')) })
  }
  const recipients: PageReviewView['recipients'] = []
  for (const recipient of resolution.recipients) {
    const user = await transaction('users').where('id', recipient.userId).first('name')
    recipients.push({ ...recipient, name: user?.name ?? null })
  }
  const clock = await readReviewClock(transaction, routing, String(page.sourceRevision), now)
  const cycle = clock.due ? await transaction('pageReviewCycles').where({ pageId: page.id, scheduleGeneration: routing.scheduleGeneration, epochKey: clock.due.epochKey, milestone: clock.due.milestone }).first() : undefined
  const receipts = cycle ? await transaction('pageReviewChannelReceipts').where({ cycleId: cycle.id }).select('userId', 'status', 'channel', 'attempt', 'acknowledgedAt') : []
  const currentRecipientIds = new Set(resolution.recipients.map(recipient => recipient.userId))
  const deliveries = receipts.filter(receipt => currentRecipientIds.has(Number(receipt.userId))).map(receipt => ({ userId: Number(receipt.userId), channel: receipt.channel, status: receipt.status, attempt: Number(receipt.attempt), acknowledgedAt: receipt.acknowledgedAt ? new Date(receipt.acknowledgedAt).toISOString() : null }))
  let diagnostic: PageReviewView['diagnostic'] = !routing.enabled ? 'disabled' : resolution.status === 'protected' ? 'protected' : clock.unknownClock ? 'unknown-clock' : resolution.status === 'undeliverable' ? resolution.reason ?? 'no-eligible-recipients' : 'scheduled'
  if (routing.enabled && resolution.status === 'eligible' && cycle) diagnostic = receipts.some(row => row.status === 'unknown' || row.status === 'sending') ? 'unknown-email' : receipts.some(row => row.status === 'failed') ? 'failed' : receipts.some(row => row.status === 'sent' || row.status === 'delivered') ? 'delivered' : ['suppressed', 'superseded', 'coalesced'].includes(cycle.status) || (receipts.length > 0 && receipts.every(row => row.status === 'suppressed')) ? 'suppressed' : 'queued'
  return PageReviewViewSchema.parse({ pageId: page.id, sourceRevision: String(page.sourceRevision), routingRevision: String(routing.revision), mode: routing.mode, enabled: routing.enabled, schedule: routing.scheduleMode === 'accuracy-age' ? { mode: 'accuracy-age' } : { mode: 'independent', anchorAt: new Date(routing.independentAnchorAt!).toISOString(), intervalDays: routing.independentIntervalDays, acknowledgeIndependentAccuracy: true }, scheduleGeneration: String(routing.scheduleGeneration), members, recipients, deliveries, diagnostic, nextDueAt: clock.nextDueAt === null ? null : new Date(clock.nextDueAt).toISOString(), currentDueAt: clock.due ? new Date(clock.due.dueAt).toISOString() : null, currentMilestone: clock.due?.milestone ?? null, currentCycleId: cycle?.id ?? null, asOf: now.toISOString(), accuracyUnaffected: true })
}
const validateRoute = async (transaction: Knex.Transaction, route: { mode: 'contacts' } | { mode: 'users'; userIds: number[] } | { mode: 'groups'; groupIds: number[] }) => {
  if (route.mode === 'contacts') return
  const ids = route.mode === 'users' ? route.userIds : route.groupIds
  let query = transaction(route.mode === 'users' ? 'users' : 'groups').whereIn('id', ids)
  if (route.mode === 'users') query = query.where({ isActive: true, isSystem: false }).whereNot('id', 2).whereNot('email', 'api@localhost')
  if ((await query.select('id')).length !== ids.length) fail('Select current available human users or groups.', 400, 'PAGE_REVIEW_INVALID_RECIPIENTS')
}
export const readPageReviewRouting = (input: BrowserInput): Promise<PageReviewView> => input.knex.transaction(async transaction => {
  const { requester, page } = await browserContext(transaction, input)
  const now = await reviewDatabaseNow(transaction)
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId: page.id }).first() ?? defaultRouting(page, now, requester.id)
  return view(transaction, page, routing, now)
})
export const previewPageReviewRouting = (input: BrowserInput & { preview: unknown }): Promise<PageReviewView> => input.knex.transaction(async transaction => {
  const parsed = PageReviewPreviewSchema.safeParse(input.preview)
  if (!parsed.success) return fail('Invalid review routing preview.', 400, 'INVALID_INPUT')
  const { requester, page } = await browserContext(transaction, input, parsed.data.route)
  const now = await reviewDatabaseNow(transaction)
  const routing = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId: page.id }).first() ?? defaultRouting(page, now, requester.id)
  if (String(page.sourceRevision) !== parsed.data.expectedSourceRevision || String(routing.revision) !== parsed.data.expectedRoutingRevision) fail('The page or routing changed. Reload before continuing.', 409, 'PAGE_REVIEW_STALE')
  if (parsed.data.route) {
    await validateRoute(transaction, parsed.data.route)
    routing.mode = parsed.data.route.mode
  }
  if (parsed.data.schedule) {
    routing.scheduleMode = parsed.data.schedule.mode
    routing.independentAnchorAt = parsed.data.schedule.mode === 'independent' ? parsed.data.schedule.anchorAt : null
    routing.independentIntervalDays = parsed.data.schedule.mode === 'independent' ? parsed.data.schedule.intervalDays : null
  }
  return view(transaction, page, routing, now, parsed.data.route)
})
export const updatePageReviewRouting = (input: BrowserInput & { mutation: unknown }): Promise<PageReviewView> => input.knex.transaction(async transaction => {
  const parsed = PageReviewCommandSchema.safeParse(input.mutation)
  if (!parsed.success) return fail('Invalid review routing command.', 400, 'INVALID_INPUT')
  const command = parsed.data
  const { requester, page, resolution } = await browserContext(transaction, input, command.command === 'route' ? command.route : command.command === 'reset' ? { mode: 'contacts' } : undefined)
  const now = await reviewDatabaseNow(transaction)
  const stored = await transaction<ReviewRoutingRow>('pageReviewRouting').where({ pageId: page.id }).forUpdate().first()
  const routing = stored ?? defaultRouting(page, now, requester.id)
  if (String(page.sourceRevision) !== command.expectedSourceRevision || String(routing.revision) !== command.expectedRoutingRevision) fail('The page or routing changed. Reload before continuing.', 409, 'PAGE_REVIEW_STALE')
  if (command.command === 'route' || command.command === 'reset') {
    const route = command.command === 'reset' ? { mode: 'contacts' as const } : command.route
    await validateRoute(transaction, route)
    if (!stored) await transaction('pageReviewRouting').insert({ ...routing, revision: '1' })
    await transaction('pageReviewRoutingUsers').where({ pageId: page.id }).delete()
    await transaction('pageReviewRoutingGroups').where({ pageId: page.id }).delete()
    routing.mode = route.mode
    if (route.mode === 'users') await transaction('pageReviewRoutingUsers').insert(route.userIds.map(userId => ({ pageId: page.id, referenceId: userId, userId })))
    if (route.mode === 'groups') await transaction('pageReviewRoutingGroups').insert(route.groupIds.map(groupId => ({ pageId: page.id, referenceId: groupId, groupId })))
  } else if (command.command === 'enable') {
    routing.enabled = command.enabled
    if (command.enabled && routing.enabledAt === null) { routing.enabledAt = now; routing.unverifiedAt = now }
  } else if (command.command === 'reschedule') {
    routing.scheduleGeneration = (BigInt(routing.scheduleGeneration) + 1n).toString()
    routing.scheduleMode = command.schedule.mode
    routing.independentAnchorAt = command.schedule.mode === 'independent' ? command.schedule.anchorAt : null
    routing.independentIntervalDays = command.schedule.mode === 'independent' ? command.schedule.intervalDays : null
  } else {
    const cycle = await transaction('pageReviewCycles').where({ id: command.cycleId, pageId: page.id, scheduleGeneration: routing.scheduleGeneration }).forUpdate().first()
    if (!cycle) fail('This reminder is no longer current.', 409, 'PAGE_REVIEW_STALE')
    if (command.command === 'acknowledge') {
      const changed = await transaction('pageReviewChannelReceipts').where({ cycleId: command.cycleId, userId: requester.id }).update({ acknowledgedAt: now })
      if (!changed) fail('This reminder has no receipt for your account.', 404, 'PAGE_REVIEW_RECEIPT_NOT_FOUND')
    }
    else {
      const clock = await readReviewClock(transaction, routing, String(page.sourceRevision), now)
      if (!routing.enabled || cycle.status === 'coalesced' || !clock.due || clock.due.epochKey !== cycle.epochKey || clock.due.milestone !== cycle.milestone || String(cycle.sourceRevision) !== String(page.sourceRevision)) fail('This reminder is no longer current.', 409, 'PAGE_REVIEW_STALE')
      await lockNotificationSettings(transaction)
      const recipient = resolution?.recipients.find(value => value.userId === command.userId)
      const stopped = await transaction('userNotificationPreferences').where({ userId: command.userId, category: 'allEmailStopped' }).forShare().first('updatedAt')
      const channels = ceilingChannels(await readNotificationCeilings(transaction), 'reviewReminder', cycle.createdAt, {
        inAppEnabled: false,
        emailEnabled: recipient?.emailEnabled === true && (!stopped || new Date(cycle.createdAt).valueOf() > new Date(stopped.updatedAt).valueOf())
      })
      if (!channels.emailEnabled) fail('This recipient is not currently eligible for an explicit email resend.', 409, 'PAGE_REVIEW_RESEND_UNAVAILABLE')
      const receipt = await transaction('pageReviewChannelReceipts').where({ cycleId: command.cycleId, userId: command.userId, channel: 'email' }).forUpdate().first()
      if (!receipt || receipt.consentAtAdmission !== true || !['unknown', 'failed'].includes(receipt.status)) fail('Only failed or unknown email can be deliberately resent.', 409, 'PAGE_REVIEW_STALE')
      await transaction('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'pending', attempt: Number(receipt.attempt) + 1, messageId: null, safeFailureReason: 'Explicit resend acknowledged possible duplicate', updatedAt: now })
      // Only an explicitly warned resend can reopen a canceled current cycle.
      // Other canceled channel receipts keep their terminal suppressed status.
      await transaction('pageReviewCycles').where({ id: cycle.id, status: 'superseded' }).update({ status: 'queued' })
    }
  }
  if (command.command === 'route' || command.command === 'reset' || (command.command === 'enable' && !command.enabled)) {
    // Cancel replayable work at cycle scope before replacement production.
    // Sending, delivered and uncertain outcomes, attempts and consumed identity remain facts.
    await transaction('pageReviewCycles').where({ pageId: page.id }).whereIn('status', ['queued', 'suppressed']).update({ status: 'superseded' })
    await transaction('pageReviewChannelReceipts').whereIn('cycleId', transaction('pageReviewCycles').where({ pageId: page.id }).select('id')).where('status', 'pending')
      .update({ status: 'suppressed', safeFailureReason: command.command === 'enable' ? 'Review reminders disabled before delivery' : 'Review routing changed before delivery', updatedAt: now })
  }
  routing.revision = (BigInt(routing.revision) + 1n).toString()
  routing.updatedBy = requester.id; routing.updatedAt = now
  await transaction('pageReviewRouting').insert(routing).onConflict('pageId').merge()
  await transaction('pageReviewRoutingAudit').insert({ id: randomUUID(), pageId: page.id, routingRevision: routing.revision, scheduleGeneration: routing.scheduleGeneration, actorId: requester.id, command: command.command, createdAt: now })
  // Replacement work uses current authority but cannot reopen a terminal cycle.
  await producePageReviewReminder({ transaction, pageId: page.id })
  return view(transaction, page, routing, now)
})

import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { PAGE_LIFECYCLE_LIMITS, PageLifecyclePreviewRequestSchema, PageLifecycleSaveRequestSchema, PageLifecycleRuleDefinitionSchema, pageLifecycleClockDisplay, pageLifecycleDue, pageLifecycleMoveDestination, pageLifecycleOriginalRelativePath, pageLifecycleSelectorMatches } from '../../shared/page-lifecycle.ts'
import type { PageLifecycleClock, PageLifecycleEffect, PageLifecyclePreview, PageLifecyclePreviewPage, PageLifecyclePreviewRequest, PageLifecycleRuleDefinition, PageLifecycleRuleStatus } from '../../shared/page-lifecycle.ts'
import auth, { loadPageRuleAuthority } from '../core/auth.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import { DurableJobStore } from '../core/durable-jobs.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { isApiPrincipal } from '../helpers/api-principal.ts'
import { canReadPage, canWritePage, pageAuthorizationContext, principalId, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { lockAssetMutationFence } from '../helpers/asset-location-lock.ts'
import { lockSearchIndex, lockSearchPage } from '../helpers/search-contract.ts'
import { observePageLifecycleBaseline } from '../helpers/page-lifecycle-clocks.ts'
import Page from '../models/pages.ts'
import errors from './errors.ts'
import { DISCUSSION_SETTINGS_LOCK } from './discussion-settings.ts'

const lifecyclePageColumns = ['id', 'sourceRevision', 'path', 'localeCode', 'visibility', 'ownerId', 'contentType', 'isPublished', 'publishStartDate', 'publishEndDate'] as const

export interface PageLifecycleInput { requester?: PagePrincipal; sessionId?: string; input?: unknown; ruleId?: unknown; proposalId?: unknown; cycleId?: unknown; expectedRevision?: unknown; action?: unknown; cursor?: unknown }
export interface LifecycleAccount extends Express.User { id: number; name: string; email: string; isActive: boolean; isSystem: boolean; authVersion: number }
export interface LifecyclePage { id: number; sourceRevision: string | number; path: string; localeCode: string; visibility: 'public' | 'private'; ownerId: number | null; contentType: string; isPublished: boolean; publishStartDate: string | null; publishEndDate: string | null; tags: Array<{ id: number; tag: string }>; tagIds: number[] }
export interface LifecycleRule { id: string; version: number; revision: number; humanOwnerId: number | null; authVersion: number; unattendedConsent: boolean; definition: PageLifecycleRuleDefinition | string; status: PageLifecycleRuleStatus; reason: string | null; selectorFingerprint: string; selectedPages: unknown; executionId: string | null; currentBatchId: string | null; createdAt: Date; updatedAt: Date; retiredAt: Date | null }
export interface LifecycleRulePage { ruleId: string; pageId: number; originalRelativePath: string; originalLocale: string; consumedBodyEpoch: string | null; consumedCommentEpoch: string | null; intervalHighWater: string | number; attemptedRevision: number; attemptedBodyEpoch: string | null; attemptedCommentEpoch: string | null; attemptedIntervalHighWater: string | number; lastExecutionId: string | null }
export interface LifecycleCycle { id: string; ruleId: string; batchId: string; ruleRevision: number; pageId: number; conditionKey: string; conditionEpoch: string | null; cycleNo: string | number | null; executionKey: string; dueAt: Date; selectedSourceRevision: string | number; nextExpectedSourceRevision: string | number; selectorFingerprint: string; status: string; reason: string | null; jobId: string | null }
export interface LifecycleProposal { id: string; ruleId: string; cycleId: string; effectIndex: number; ruleRevision: number; pageId: number; sourceRevision: string | number; sourcePath: string; sourceLocale: string; destinationPath: string; destinationLocale: string; selectorFingerprint: string; status: string; reason: string | null; expiresAt: Date | string; resultSourceRevision: string | number | null }
export interface LifecycleReceipt { cycleId: string; effectIndex: number; kind: PageLifecycleEffect['kind']; state: string; reason: string | null; beforeSourceRevision: string | number; afterSourceRevision: string | number; proposalId: string | null; outboxId: string | null }
export const lifecycleStoredJson = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
export interface LifecycleActor { account: LifecycleAccount; principal: NonNullable<PagePrincipal>; authority: PageRuleAuthority }
export const lifecycleFingerprint = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const lifecycleDefinition = (rule: LifecycleRule): PageLifecycleRuleDefinition => PageLifecycleRuleDefinitionSchema.parse(lifecycleStoredJson(rule.definition))
export const lifecycleFailure = (message: string, code = 'LIFECYCLE_INVALID', status = 400): never => { throw new errors.ApplicationError(message, { code, status }) }
export const pageLifecycleDatabaseNow = async (transaction: Knex.Transaction): Promise<Date> => {
  const result = await transaction.raw<{ rows: Array<{ now: Date | string }> }>('SELECT clock_timestamp() AS now')
  const now = new Date(result.rows[0]!.now)
  if (!Number.isFinite(now.valueOf())) throw new Error('Database UTC clock unavailable')
  return now
}

export const lockPageLifecycleRule = async (transaction: Knex.Transaction, ruleId: string): Promise<void> => {
  await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x504c5255, ruleId])
}
export const lifecycleNativeCommentsAvailable = async (transaction: Knex.Transaction): Promise<boolean> => {
  await transaction.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
  const enabled = await transaction<{ key: string }>('commentProviders').where('isEnabled', true).orderBy('key').forShare().select('key')
  return enabled.length === 1 && enabled[0]!.key === 'default'
}

/** Shared lock order: discussion settings (comment conditions) -> groups/tags -> sorted accounts -> lifecycle rule fence -> native asset/search/page -> job -> rule -> cycle -> receipts/clocks/proposals. */
export const lockLifecycleActor = async (transaction: Knex.Transaction, ownerId: number, expectedAuthVersion?: number, requester?: PagePrincipal): Promise<LifecycleActor | null> => {
  await transaction('groups').select('id').orderBy('id').forShare()
  const account = await transaction<LifecycleAccount>('users').where('id', ownerId).select('id', 'name', 'email', 'isActive', 'isSystem', 'authVersion').forShare().first()
  if (!account || account.isActive !== true || account.isSystem !== false || account.email === 'api@localhost' || !Number.isSafeInteger(account.authVersion) || (expectedAuthVersion !== undefined && account.authVersion !== expectedAuthVersion)) return null
  if (requester && (!accountSessionIsCurrent(requester, account) || isApiPrincipal(requester))) return null
  const memberships = await transaction<{ groupId: number }>('userGroups').where('userId', ownerId).orderBy('groupId').select('groupId')
  const principal: LifecycleAccount & { groups: number[]; permissions: string[] } = { ...account, groups: memberships.map(row => row.groupId), permissions: [] }
  const authority = await loadPageRuleAuthority(principal, transaction)
  principal.permissions = [...authority.permissions]
  return { account, principal, authority }
}
const interactiveActor = async (transaction: Knex.Transaction, input: PageLifecycleInput): Promise<LifecycleActor> => {
  const id = principalId(input.requester)
  if (id === null || isApiPrincipal(input.requester) || !input.sessionId) return lifecycleFailure('A current human browser session is required.', 'LIFECYCLE_HUMAN_REQUIRED', 403)
  const actor = await lockLifecycleActor(transaction, id, undefined, input.requester)
  if (!actor) return lifecycleFailure('Your account session is no longer current.', 'LIFECYCLE_AUTHOR_UNAVAILABLE', 403)
  if (!actor.authority.permissions.some(permission => ['write:pages', 'manage:pages', 'manage:system'].includes(permission))) return lifecycleFailure('Current page write authority is required.', 'LIFECYCLE_FORBIDDEN', 403)
  return actor
}
export const lockLifecycleNativePage = async (transaction: Knex.Transaction, pageId: number, nativePageIds: readonly number[] = [pageId]): Promise<LifecyclePage | null> => {
  const ids = [...new Set([pageId, ...nativePageIds])].sort((a, b) => a - b)
  z.array(z.number().int().positive().max(2147483647)).max(21).parse(ids)
  await lockAssetMutationFence(transaction, true)
  await lockSearchIndex(transaction, false)
  for (const id of ids) await lockSearchPage(transaction, id)
  const pages = await transaction<Omit<LifecyclePage, 'tags' | 'tagIds'>>('pages').select(...lifecyclePageColumns).whereIn('id', ids).orderBy('id').forUpdate()
  const page = pages.find(current => current.id === pageId)
  if (!page) return null
  const tags = await transaction<{ id: number; tag: string }>('tags').join('pageTags', 'pageTags.tagId', 'tags.id').where('pageTags.pageId', pageId).select('tags.id', 'tags.tag').orderBy('tags.id')
  return { ...page, tags, tagIds: tags.map(tag => tag.id) }
}
export const lifecyclePagePermitted = (principal: PagePrincipal, authority: PageRuleAuthority, page: LifecyclePage): boolean => (page.visibility !== 'private' || page.ownerId === principalId(principal)) && canReadPage(principal, page, authority) && canWritePage(principal, page, authority)
export const lifecycleDestinationPermitted = (principal: PagePrincipal, authority: PageRuleAuthority, page: LifecyclePage, destinationPath: string): boolean => {
  const destination = { ...page, path: destinationPath }, context = pageAuthorizationContext(destination)
  return context !== null && lifecyclePagePermitted(principal, authority, destination) && auth.checkPageAccess(principal, ['write:pages'], context, authority)
}
const canManageLifecycleRule = async (transaction: Knex.Transaction, actor: LifecycleActor, rule: LifecycleRule): Promise<boolean> => {
  // Ownership permits retiring one's own delegation even after page access is lost.
  // Managing someone else's delegation requires the complete CURRENT page scope,
  // including current contexts for its former page associations, never a filtered set.
  if (rule.humanOwnerId === actor.account.id || actor.authority.permissions.includes('manage:system')) return true
  if (!actor.authority.permissions.includes('manage:pages')) return false
  const definition = lifecycleDefinition(rule), explicitIds = new Set(definition.selector.kind === 'ids' ? definition.selector.pageIds : [])
  let hasContext = false
  for await (const pages of lifecyclePageCandidates(transaction, definition, rule.id)) {
    for (const page of pages) {
      const context = pageAuthorizationContext(page)
      if (!context || !lifecyclePagePermitted(actor.principal, actor.authority, page) || !auth.checkPageAccess(actor.principal, ['manage:pages'], context, actor.authority)) return false
      hasContext = true
      explicitIds.delete(page.id)
    }
  }
  return hasContext && explicitIds.size === 0
}
const managedRule = async (transaction: Knex.Transaction, actor: LifecycleActor, id: string, lock = false): Promise<LifecycleRule> => {
  const query = transaction<LifecycleRule>('pageLifecycleRules').where('id', id)
  const rule = await (lock ? query.forUpdate() : query).first()
  if (!rule || !await canManageLifecycleRule(transaction, actor, rule)) return lifecycleFailure('Lifecycle rule is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  return rule
}
async function* lifecyclePageCandidates(transaction: Knex.Transaction, definition: PageLifecycleRuleDefinition, relatedRuleId?: string): AsyncGenerator<LifecyclePage[]> {
  const selector = definition.selector
  let afterId = 0
  for (;;) {
    const query = transaction<Omit<LifecyclePage, 'tags' | 'tagIds'>>('pages').select(...lifecyclePageColumns).where('id', '>', afterId).orderBy('id').limit(100)
    query.where(function () {
      this.where(function () {
        if (selector.kind === 'ids') this.whereIn('id', selector.pageIds)
        else {
          this.where({ localeCode: selector.localeCode, visibility: 'public' }).whereNull('ownerId')
          if (selector.kind === 'subtree') this.where(function () { this.where('path', selector.normalizedRootPath).orWhereRaw('left(??, char_length(?) + 1) = ?', ['path', selector.normalizedRootPath, `${selector.normalizedRootPath}/`]) })
          for (const tagId of selector.allTagIds ?? []) this.whereExists(transaction('pageTags').select(transaction.raw('1')).whereRaw('?? = ??', ['pageTags.pageId', 'pages.id']).where('tagId', tagId))
        }
      })
      if (relatedRuleId) this.orWhereExists(transaction('pageLifecycleRulePages').select(transaction.raw('1')).whereRaw('?? = ??', ['pageLifecycleRulePages.pageId', 'pages.id']).where('ruleId', relatedRuleId))
    })
    if (relatedRuleId) query.forShare()
    const rows = await query
    if (rows.length === 0) return
    const tags = await transaction<{ pageId: number; id: number; tag: string }>('pageTags').join('tags', 'tags.id', 'pageTags.tagId').whereIn('pageId', rows.map(page => page.id)).select('pageTags.pageId', 'tags.id', 'tags.tag').orderBy('tags.id')
    yield rows.map(row => {
      const pageTags = tags.filter(tag => tag.pageId === row.id).map(({ id, tag }) => ({ id, tag }))
      return { ...row, tags: pageTags, tagIds: pageTags.map(tag => tag.id) }
    })
    const last = rows.at(-1)
    if (!last) return
    afterId = last.id
  }
}
export const lifecycleSelectPages = async (transaction: Knex.Transaction, definition: PageLifecycleRuleDefinition, principal: PagePrincipal, authority: PageRuleAuthority): Promise<LifecyclePage[]> => {
  const selected: LifecyclePage[] = []
  for await (const pages of lifecyclePageCandidates(transaction, definition)) {
    for (const page of pages) {
      if (pageLifecycleSelectorMatches(definition.selector, page) && lifecyclePagePermitted(principal, authority, page)) selected.push(page)
      if (selected.length > PAGE_LIFECYCLE_LIMITS.targets) return selected
    }
  }
  return selected
}
export const lifecycleTargetSnapshot = (pages: LifecyclePage[]) => pages.map(page => ({ pageId: page.id, sourceRevision: String(page.sourceRevision), path: page.path, localeCode: page.localeCode, visibility: page.visibility, ownerId: page.ownerId, tagIds: page.tagIds }))
const previewWithinTransaction = async (transaction: Knex.Transaction, request: PageLifecyclePreviewRequest, actor: LifecycleActor, nativeCommentsAvailable: boolean) => {
  if (request.startObserving && request.definition.condition.kind === 'comments-inactive' && !nativeCommentsAvailable) return lifecycleFailure('External discussions do not provide an authoritative native activity clock.', 'LIFECYCLE_UNKNOWN_CLOCK', 409)
  let rule: LifecycleRule | null = null
  if (request.ruleId) {
    rule = await managedRule(transaction, actor, request.ruleId)
    if (rule.revision !== request.expectedRevision || ['retired', 'cancelled'].includes(rule.status)) return lifecycleFailure('Preview the current nonterminal rule revision.', 'LIFECYCLE_STALE', 409)
    if (rule.humanOwnerId !== actor.account.id && !request.reown) return lifecycleFailure('Explicitly inspect and re-own this rule before enabling its effects.', 'LIFECYCLE_REOWN_REQUIRED', 403)
  } else if (request.expectedRevision !== undefined || request.reown || request.runAgain) return lifecycleFailure('Choose an existing rule for this operation.')
  const pages = await lifecycleSelectPages(transaction, request.definition, actor.principal, actor.authority)
  if (pages.length > PAGE_LIFECYCLE_LIMITS.targets) return lifecycleFailure('Narrow selector and preview; more than 1000 currently eligible pages.', 'LIFECYCLE_TOO_BROAD', 409)
  const tagIds = request.definition.effects.flatMap(effect => effect.kind === 'add-tags' ? effect.tagIds : [])
  const validTags = tagIds.length === 0 ? [] : await transaction<{ id: number; tag: string; redirectToId: number | null; isArchived: boolean }>('tags').whereIn('id', tagIds).orderBy('id').forShare()
  if (tagIds.some(id => !validTags.some(tag => tag.id === id && tag.redirectToId === null && tag.isArchived === false))) return lifecycleFailure('An action tag is retired or unavailable.', 'LIFECYCLE_INVALID_ACTION', 409)
  const now = await pageLifecycleDatabaseNow(transaction), views: PageLifecyclePreviewPage[] = [], bindings: unknown[] = []
  for (const page of pages) {
    const clock = await transaction<PageLifecycleClock>('pageLifecycleClocks').where('pageId', page.id).first()
    const protection = await transaction('pageAccessPasswords').where('pageId', page.id).first('pageId')
    const identity = rule ? await transaction<LifecycleRulePage>('pageLifecycleRulePages').where({ ruleId: rule.id, pageId: page.id }).first() : undefined
    const original = identity?.originalRelativePath ?? pageLifecycleOriginalRelativePath(request.definition.selector, page.path)
    const effects: PageLifecyclePreviewPage['effects'] = []
    for (const effect of request.definition.effects) {
      let reason = protection ? 'needs-interactive' : undefined
      if (effect.kind === 'add-tags' && !lifecyclePagePermitted(actor.principal, actor.authority, { ...page, tags: [...page.tags, ...validTags.filter(tag => !page.tagIds.includes(tag.id))] })) reason = 'forbidden-after-tags'
      if (effect.kind === 'propose-move') {
        const destinationPath = pageLifecycleMoveDestination(effect, page.id, original)
        if (page.visibility !== 'public' || page.ownerId !== null) reason = 'needs-manual-native-flow'
        else if (!lifecycleDestinationPermitted(actor.principal, actor.authority, page, destinationPath)) reason = 'destination-unavailable'
        effects.push({ kind: effect.kind, mode: 'human-review', destinationPath, ...(reason ? { reason } : {}) })
      } else effects.push({ kind: effect.kind, mode: 'unattended', ...(reason ? { reason } : {}) })
    }
    views.push({ pageId: page.id, sourceRevision: String(page.sourceRevision), path: page.path, localeCode: page.localeCode, protected: Boolean(protection), ...pageLifecycleClockDisplay(request.definition.condition, nativeCommentsAvailable ? clock ?? null : null, now), effects })
    bindings.push({ pageId: page.id, clock: clock ? { ...clock, bodyAnchorAt: clock.bodyAnchorAt === null ? null : String(clock.bodyAnchorAt instanceof Date ? clock.bodyAnchorAt.toISOString() : clock.bodyAnchorAt), commentAnchorAt: clock.commentAnchorAt === null ? null : String(clock.commentAnchorAt instanceof Date ? clock.commentAnchorAt.toISOString() : clock.commentAnchorAt) } : null, protected: Boolean(protection), originalRelativePath: original, effects })
  }
  const fingerprint = lifecycleFingerprint({ request, actorId: actor.account.id, authVersion: actor.account.authVersion, nativeCommentsAvailable, targets: lifecycleTargetSnapshot(pages), bindings })
  return { rule, pages, views, fingerprint, now }
}
export const previewPageLifecycle = async (input: PageLifecycleInput): Promise<PageLifecyclePreview> => {
  const request = PageLifecyclePreviewRequestSchema.parse(input.input)
  return Page.knex().transaction(async transaction => {
    const nativeCommentsAvailable = request.definition.condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
    const actor = await interactiveActor(transaction, input), preview = await previewWithinTransaction(transaction, request, actor, nativeCommentsAvailable)
    const id = randomUUID(), expiresAt = new Date(preview.now.valueOf() + PAGE_LIFECYCLE_LIMITS.previewMs)
    await transaction('pageLifecyclePreviews').insert({ id, actorId: actor.account.id, ruleId: request.ruleId ?? null, ruleRevision: request.expectedRevision ?? null, authVersion: actor.account.authVersion, fingerprint: preview.fingerprint, request: JSON.stringify(request), pages: JSON.stringify(lifecycleTargetSnapshot(preview.pages)), createdAt: preview.now, expiresAt, consumedAt: null })
    return { previewToken: id, expiresAt: expiresAt.toISOString(), fingerprint: preview.fingerprint, ruleId: request.ruleId ?? null, expectedRevision: request.expectedRevision ?? null, pages: preview.views, startObserving: request.startObserving, runAgain: request.runAgain, warning: request.runAgain ? 'Run again may duplicate already completed tags, notices and notifications. A move always needs new human review.' : preview.pages.length === 0 ? 'No currently eligible pages' : null }
  })
}
export const savePageLifecycle = async (input: PageLifecycleInput): Promise<{ ruleId: string; revision: number; status: PageLifecycleRuleStatus }> => {
  const save = PageLifecycleSaveRequestSchema.parse(input.input), { previewToken, unattendedConsent, enabled, ...request } = save
  return Page.knex().transaction(async transaction => {
    const nativeCommentsAvailable = request.definition.condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
    const actor = await interactiveActor(transaction, input)
    const ruleId = request.ruleId ?? randomUUID()
    await lockPageLifecycleRule(transaction, ruleId)
    // Lock exactly the previewed pages before recomputing admission; page revisions,
    // selectors and unknown-clock consent must remain stable through save commit.
    const supplied = await transaction('pageLifecyclePreviews').where({ id: previewToken, actorId: actor.account.id }).first('pages')
    if (!supplied) return lifecycleFailure('Preview again before saving.', 'LIFECYCLE_PREVIEW_STALE', 409)
    const selected = lifecycleStoredJson<Array<{ pageId: number }>>(supplied.pages)
    for (const page of selected) await lockLifecycleNativePage(transaction, page.pageId)
    const preview = await previewWithinTransaction(transaction, request, actor, nativeCommentsAvailable)
    const token = await transaction('pageLifecyclePreviews').where({ id: previewToken, actorId: actor.account.id }).forUpdate().first()
    if (!token || token.consumedAt || new Date(token.expiresAt).valueOf() <= preview.now.valueOf() || token.authVersion !== actor.account.authVersion || token.fingerprint !== preview.fingerprint || canonicalJson(lifecycleStoredJson(token.request)) !== canonicalJson(request)) return lifecycleFailure('The lifecycle preview changed or expired. Preview again.', 'LIFECYCLE_PREVIEW_STALE', 409)
    // Serialize enabled limits and cancellation with the rule row, after native authority locks.
    await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x504c524c])
    const previous = request.ruleId ? await managedRule(transaction, actor, ruleId, true) : null
    if (previous && previous.revision !== request.expectedRevision) return lifecycleFailure('The rule revision changed. Preview again.', 'LIFECYCLE_STALE', 409)
    if (enabled) {
      const site = await transaction('pageLifecycleRules').where('status', 'enabled').whereNot('id', ruleId).count<{ count: string }[]>({ count: '*' }).first()
      const owner = await transaction('pageLifecycleRules').where({ status: 'enabled', humanOwnerId: actor.account.id }).whereNot('id', ruleId).count<{ count: string }[]>({ count: '*' }).first()
      if (Number(site?.count) >= 100 || Number(owner?.count) >= 20) return lifecycleFailure('The enabled lifecycle rule limit has been reached.', 'LIFECYCLE_LIMIT', 409)
    }
    const revision = (previous?.revision ?? 0) + 1, status = enabled ? 'enabled' : 'disabled'
    const row = { version: 1, revision, humanOwnerId: actor.account.id, authVersion: actor.account.authVersion, unattendedConsent, definition: JSON.stringify(request.definition), status, reason: null, selectorFingerprint: lifecycleFingerprint(lifecycleTargetSnapshot(preview.pages)), selectedPages: JSON.stringify(lifecycleTargetSnapshot(preview.pages)), executionId: request.runAgain ? randomUUID() : null, currentBatchId: null, updatedAt: preview.now }
    if (previous) {
      await cancelLifecycleWork(transaction, previous.id, preview.now, 'rule-revised')
      await transaction('pageLifecycleRules').where('id', ruleId).update(row)
    } else await transaction('pageLifecycleRules').insert({ id: ruleId, ...row, createdAt: preview.now, retiredAt: null, lastScannedAt: null })
    for (const page of preview.pages) {
      await transaction('pageLifecycleRulePages').insert({ ruleId, pageId: page.id, originalRelativePath: pageLifecycleOriginalRelativePath(request.definition.selector, page.path), originalLocale: page.localeCode, consumedBodyEpoch: null, consumedCommentEpoch: null, intervalHighWater: -1, lastExecutionId: null, updatedAt: preview.now }).onConflict(['ruleId', 'pageId']).ignore()
      if (request.startObserving && request.definition.condition.kind !== 'interval') {
        await transaction('pages').where({ id: page.id, sourceRevision: page.sourceRevision }).forUpdate().first('id').then(current => { if (!current) lifecycleFailure('A selected page changed. Preview again.', 'LIFECYCLE_PREVIEW_STALE', 409) })
        await observePageLifecycleBaseline(transaction, { pageId: page.id, sourceRevision: String(page.sourceRevision), kind: request.definition.condition.kind === 'body-inactive' ? 'body' : 'comments', now: preview.now })
      }
    }
    await transaction('pageLifecyclePreviews').where('id', previewToken).update({ consumedAt: preview.now })
    return { ruleId, revision, status }
  })
}
export const cancelLifecycleWork = async (transaction: Knex.Transaction, ruleId: string, now: Date, reason: string): Promise<void> => {
  const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', ruleId).first()
  const effects = rule ? lifecycleDefinition(rule).effects : []
  const cycles = await transaction<LifecycleCycle>('pageLifecycleCycles').where('ruleId', ruleId).whereIn('status', ['queued', 'running', 'needs-review']).orderBy('id')
  const jobs = cycles.flatMap(cycle => cycle.jobId ? [cycle.jobId] : [])
  if (jobs.length) await transaction('durableJobs').whereIn('id', jobs).whereIn('state', ['pending', 'running', 'failed']).update({ state: 'cancelled', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, completedAt: now, updatedAt: now, lastError: reason })
  for (const cycle of cycles) {
    const receipts = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id)
    const committed = receipts.length > 0
    for (let index = 0; index < effects.length; index++) {
      if (receipts.some(receipt => receipt.effectIndex === index)) continue
      await transaction('pageLifecycleActionReceipts').insert({ cycleId: cycle.id, effectIndex: index, kind: effects[index]!.kind, state: 'cancelled', reason, beforeSourceRevision: cycle.nextExpectedSourceRevision, afterSourceRevision: cycle.nextExpectedSourceRevision, operationId: null, proposalId: null, outboxId: null, createdAt: now, updatedAt: now })
    }
    await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: committed ? 'partial' : 'cancelled', reason, updatedAt: now, completedAt: now })
  }
  await transaction('pageLifecycleBatches').where({ ruleId, status: 'running' }).update({ status: 'cancelled', completedAt: now })
  await transaction('pageLifecycleMoveProposals').where({ ruleId, status: 'awaiting-human' }).update({ status: 'cancelled', reason, settledAt: now })
  await transaction('pageLifecycleActionReceipts').whereIn('cycleId', cycles.map(cycle => cycle.id)).where('state', 'proposed').update({ state: 'cancelled', reason, updatedAt: now })
}
export const setPageLifecycleRuleStatus = async (input: PageLifecycleInput) => {
  const ruleId = z.uuid().parse(input.ruleId), expectedRevision = z.number().int().positive().parse(input.expectedRevision), action = z.enum(['disable', 'cancel']).parse(input.action)
  return Page.knex().transaction(async transaction => {
    const actor = await interactiveActor(transaction, input)
    await lockPageLifecycleRule(transaction, ruleId)
    const rule = await managedRule(transaction, actor, ruleId, true)
    if (rule.revision !== expectedRevision || ['retired', 'cancelled'].includes(rule.status)) return lifecycleFailure('The rule revision changed.', 'LIFECYCLE_STALE', 409)
    const now = await pageLifecycleDatabaseNow(transaction), status = action === 'cancel' ? 'cancelled' : 'disabled'
    await cancelLifecycleWork(transaction, ruleId, now, status)
    await transaction('pageLifecycleRules').where('id', ruleId).update({ status, revision: rule.revision + 1, reason: status, currentBatchId: null, updatedAt: now, ...(status === 'cancelled' ? { retiredAt: now } : {}) })
    return { ruleId, revision: rule.revision + 1, status }
  })
}
export const inspectPageLifecycleRule = async (input: PageLifecycleInput) => {
  const id = z.uuid().parse(input.ruleId)
  return Page.knex().transaction(async transaction => {
    const observedRule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', id).first()
    const nativeCommentsAvailable = observedRule && lifecycleDefinition(observedRule).condition.kind === 'comments-inactive' ? await lifecycleNativeCommentsAvailable(transaction) : false
    const actor = await interactiveActor(transaction, input), rule = await managedRule(transaction, actor, id)
    const definition = lifecycleDefinition(rule), pages = await lifecycleSelectPages(transaction, definition, actor.principal, actor.authority), pageIds = pages.map(page => page.id)
    const cursor = input.cursor === undefined ? undefined : z.uuid().parse(input.cursor)
    const cycles: LifecycleCycle[] = []
    let after = cursor
    for (;;) {
      const candidates: LifecycleCycle[] = await transaction<LifecycleCycle>('pageLifecycleCycles').where('ruleId', id).modify(query => { if (after) query.where('id', '>', after) }).orderBy('id').limit(50)
      if (candidates.length === 0) break
      const current = await transaction<Omit<LifecyclePage, 'tags' | 'tagIds'>>('pages').select(...lifecyclePageColumns).whereIn('id', candidates.map(cycle => cycle.pageId))
      const tags = await transaction<{ pageId: number; id: number; tag: string }>('pageTags').join('tags', 'tags.id', 'pageTags.tagId').whereIn('pageId', current.map(page => page.id)).select('pageTags.pageId', 'tags.id', 'tags.tag')
      for (const cycle of candidates) {
        const row = current.find(page => page.id === cycle.pageId)
        if (!row) continue
        const pageTags = tags.filter(tag => tag.pageId === row.id), page = { ...row, tags: pageTags, tagIds: pageTags.map(tag => tag.id) }
        if (lifecyclePagePermitted(actor.principal, actor.authority, page)) cycles.push(cycle)
        if (cycles.length === 26) break
      }
      if (cycles.length === 26 || candidates.length < 50) break
      after = candidates.at(-1)!.id
    }
    const selected = cycles.slice(0, 25), receipts = selected.length ? await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').whereIn('cycleId', selected.map(cycle => cycle.id)).orderBy('effectIndex') : []
    const now = await pageLifecycleDatabaseNow(transaction)
    const clocks = pageIds.length ? await transaction<PageLifecycleClock & { pageId: number }>('pageLifecycleClocks').whereIn('pageId', pageIds) : []
    return { rule: { ...rule, definition, selectedPages: lifecycleTargetSnapshot(pages) }, pages: pages.map(page => ({ pageId: page.id, sourceRevision: String(page.sourceRevision), ...pageLifecycleClockDisplay(definition.condition, definition.condition.kind !== 'comments-inactive' || nativeCommentsAvailable ? clocks.find(clock => clock.pageId === page.id) ?? null : null, now) })), cycles: selected.map(cycle => ({ ...cycle, receipts: receipts.filter(receipt => receipt.cycleId === cycle.id) })), hasMore: cycles.length > 25, nextCursor: cycles.length > 25 ? selected.at(-1)!.id : null }
  })
}

/** Explicitly resume only uncommitted effects after an infrastructure retry exhausted. */
export const resumePageLifecycleCycle = async (input: PageLifecycleInput) => Page.knex().transaction(async transaction => {
  const id = z.uuid().parse(input.cycleId)
  const observed = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', id).first()
  if (!observed) return lifecycleFailure('Lifecycle work is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  const observedRule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', observed.ruleId).first()
  const nativeCommentsAvailable = !observedRule || lifecycleDefinition(observedRule).condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
  const actor = await interactiveActor(transaction, input)
  await lockPageLifecycleRule(transaction, observed.ruleId)
  const page = await lockLifecycleNativePage(transaction, observed.pageId)
  const job = observed.jobId ? await transaction('durableJobs').where('id', observed.jobId).forUpdate().first() : undefined
  const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', observed.ruleId).forUpdate().first()
  const cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', id).forUpdate().first()
  if (!rule || !cycle || !job || !page || rule.humanOwnerId !== actor.account.id || rule.authVersion !== actor.account.authVersion || rule.revision !== cycle.ruleRevision || !['enabled', 'needs-attention'].includes(rule.status) || rule.status === 'needs-attention' && rule.reason !== 'infrastructure-retries-exhausted' || job.type !== 'page-lifecycle' || job.version !== 1 || job.state !== 'failed' || !pageLifecycleSelectorMatches(lifecycleDefinition(rule).selector, page) || !lifecyclePagePermitted(actor.principal, actor.authority, page)) return lifecycleFailure('This work cannot be resumed; inspect and preview current work.', 'LIFECYCLE_RESUME_REFUSED', 409)
  const receipts = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id).forUpdate()
  if (receipts.some(receipt => !['applied', 'skipped', 'proposed', 'fulfilled'].includes(receipt.state)) || receipts.length > 0 && String(page.sourceRevision) !== String(cycle.nextExpectedSourceRevision)) return lifecycleFailure('Partially committed work changed. A fresh preview is required.', 'LIFECYCLE_PARTIAL_STALE', 409)
  const now = await pageLifecycleDatabaseNow(transaction), clock = await transaction<PageLifecycleClock>('pageLifecycleClocks').where('pageId', page.id).first()
  const due = pageLifecycleDue(lifecycleDefinition(rule).condition, lifecycleDefinition(rule).condition.kind !== 'comments-inactive' || nativeCommentsAvailable ? clock ?? null : null, now)
  if (due.state !== 'due' || (cycle.cycleNo === null ? due.conditionKey !== cycle.conditionKey : due.cycleNo === null || due.cycleNo < Number(cycle.cycleNo)) || await transaction('pageAccessPasswords').where('pageId', page.id).first('pageId')) return lifecycleFailure('The clock or interactive guard changed. Preview again.', 'LIFECYCLE_RESUME_REFUSED', 409)
  if (rule.status !== 'enabled') {
    await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x504c524c])
    const site = await transaction('pageLifecycleRules').where('status', 'enabled').whereNot('id', rule.id).count<{ count: string }[]>({ count: '*' }).first()
    const owner = await transaction('pageLifecycleRules').where({ status: 'enabled', humanOwnerId: actor.account.id }).whereNot('id', rule.id).count<{ count: string }[]>({ count: '*' }).first()
    if (Number(site?.count) >= PAGE_LIFECYCLE_LIMITS.enabledSite || Number(owner?.count) >= PAGE_LIFECYCLE_LIMITS.enabledOwner) return lifecycleFailure('The enabled lifecycle rule limit has been reached.', 'LIFECYCLE_LIMIT', 409)
  }
  if (!await new DurableJobStore(transaction).retry(job.id, now)) return lifecycleFailure('This work is no longer failed.', 'LIFECYCLE_STALE', 409)
  await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: 'queued', reason: null, completedAt: null, updatedAt: now })
  await transaction('pageLifecycleRules').where('id', rule.id).update({ status: 'enabled', reason: null, updatedAt: now })
  return { cycleId: cycle.id, status: 'queued' }
})

/** Reader-only metadata: reload the current account/page context rather than trusting a retained reader projection. */
export const readPageLifecycleNotices = async (input: { transaction: Knex.Transaction; page: PageVisibilityRecord & { id: number }; requester: PagePrincipal; authority: PageRuleAuthority }) => {
  if (!canReadPage(input.requester, input.page, input.authority)) return []
  const { transaction } = input, id = principalId(input.requester)
  const actor = id === null || isApiPrincipal(input.requester) ? null : await lockLifecycleActor(transaction, id, undefined, input.requester)
  if (id !== null && !isApiPrincipal(input.requester) && !actor) return []
  const requester = actor?.principal ?? input.requester, authority = actor?.authority ?? await loadPageRuleAuthority(requester, transaction)
  const current = await transaction<Omit<LifecyclePage, 'tags' | 'tagIds'>>('pages').select(...lifecyclePageColumns).where('id', input.page.id).forShare().first()
  if (!current) return []
  const tags = await transaction<{ tag: string }>('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', current.id).select('tags.tag')
  if (!canReadPage(requester, { ...current, tags }, authority)) return []
  return transaction('pageLifecycleNotices as notice').join('pageLifecycleRules as rule', 'rule.id', 'notice.ruleId').where({ 'notice.pageId': current.id, 'rule.status': 'enabled' }).select('notice.ruleId', 'notice.text', 'notice.updatedAt').orderBy('notice.ruleId')
}
export const listPageLifecycleRules = async (input: PageLifecycleInput) => Page.knex().transaction(async transaction => {
  const actor = await interactiveActor(transaction, input), visible: LifecycleRule[] = []
  let after = input.cursor === undefined ? undefined : z.uuid().parse(input.cursor)
  for (;;) {
    const query = transaction<LifecycleRule>('pageLifecycleRules').orderBy('id').limit(100)
    if (!actor.authority.permissions.some(permission => permission === 'manage:pages' || permission === 'manage:system')) query.where('humanOwnerId', actor.account.id)
    if (after) query.where('id', '>', after)
    const rows = await query
    for (const rule of rows) {
      if (await canManageLifecycleRule(transaction, actor, rule)) visible.push(rule)
      if (visible.length === 101) break
    }
    if (visible.length === 101 || rows.length < 100) break
    const last = rows.at(-1)
    if (!last) break
    after = last.id
  }
  // Pagination and definitions disclose only authorized rules, never hidden totals.
  const rules = visible.slice(0, 100).map(rule => {
    const { selectedPages: _selected, ...metadata } = rule
    return { ...metadata, definition: lifecycleDefinition(rule) }
  })
  return { rules, hasMore: visible.length > 100, nextCursor: visible.length > 100 ? rules.at(-1)?.id ?? null : null }
})
export const inspectPageLifecycleProposal = async (input: PageLifecycleInput) => Page.knex().transaction(async transaction => {
  const actor = await interactiveActor(transaction, input), id = z.uuid().parse(input.proposalId)
  const proposal = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('id', id).first()
  if (!proposal) return lifecycleFailure('Move proposal is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  const page = await lockLifecycleNativePage(transaction, proposal.pageId)
  if (!page || !lifecyclePagePermitted(actor.principal, actor.authority, page) || !lifecycleDestinationPermitted(actor.principal, actor.authority, page, proposal.destinationPath)) return lifecycleFailure('Move proposal is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  const now = await pageLifecycleDatabaseNow(transaction)
  return { ...proposal, currentSourceRevision: String(page.sourceRevision), requiresNewPreview: String(page.sourceRevision) !== String(proposal.sourceRevision) || proposal.status !== 'awaiting-human' || new Date(proposal.expiresAt).valueOf() <= now.valueOf(), updateLinks: 'explicit-native-review-required', humanMoveInput: { id: proposal.pageId, destinationPath: proposal.destinationPath, destinationLocale: proposal.destinationLocale, expectedSourceRevision: String(proposal.sourceRevision), lifecycleProposalId: proposal.id } }
})

/** Invoked by the canonical native human move transaction, never by the timer. */
export const admitPageLifecycleHumanMove = async (transaction: Knex.Transaction, input: { proposalId: string; pageId: number; expectedSourceRevision: string; destinationPath: string; destinationLocale: string; requester: PagePrincipal; sessionId: string; nativePageIds?: readonly number[] }): Promise<(result: { id: number; sourceRevision: string | number; outboxId: string }) => Promise<void>> => {
  if (!input.sessionId || isApiPrincipal(input.requester)) return lifecycleFailure('A current interactive native move is required.', 'LIFECYCLE_HUMAN_REQUIRED', 403)
  const proposalRead = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('id', z.uuid().parse(input.proposalId)).first()
  if (!proposalRead || proposalRead.pageId !== input.pageId) return lifecycleFailure('Move proposal is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  const observedRule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', proposalRead.ruleId).first()
  const nativeCommentsAvailable = !observedRule || lifecycleDefinition(observedRule).condition.kind !== 'comments-inactive' || await lifecycleNativeCommentsAvailable(transaction)
  const actor = await interactiveActor(transaction, input)
  await lockPageLifecycleRule(transaction, proposalRead.ruleId)
  const page = await lockLifecycleNativePage(transaction, input.pageId, input.nativePageIds)
  const rule = await transaction<LifecycleRule>('pageLifecycleRules').where('id', proposalRead.ruleId).forUpdate().first()
  const cycle = await transaction<LifecycleCycle>('pageLifecycleCycles').where('id', proposalRead.cycleId).forUpdate().first()
  const proposal = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('id', proposalRead.id).forUpdate().first()
  const now = await pageLifecycleDatabaseNow(transaction)
  const clock = await transaction<PageLifecycleClock>('pageLifecycleClocks').where('pageId', input.pageId).forShare().first()
  const due = rule ? pageLifecycleDue(lifecycleDefinition(rule).condition, nativeCommentsAvailable ? clock ?? null : null, now) : null
  const sameClock = due?.state === 'due' && cycle && (due.cycleNo === null ? due.conditionKey === cycle.conditionKey : due.cycleNo >= Number(cycle.cycleNo))
  if (!page || !rule || !cycle || !proposal || !sameClock || cycle.status !== 'needs-review' || rule.status !== 'enabled' || rule.revision !== proposal.ruleRevision || proposal.status !== 'awaiting-human' || new Date(proposal.expiresAt).valueOf() <= now.valueOf() || page.visibility !== 'public' || page.ownerId !== null || String(page.sourceRevision) !== String(proposal.sourceRevision) || input.expectedSourceRevision !== String(proposal.sourceRevision) || proposal.sourcePath !== page.path || proposal.sourceLocale !== page.localeCode || input.destinationPath !== proposal.destinationPath || input.destinationLocale !== proposal.destinationLocale || !pageLifecycleSelectorMatches(lifecycleDefinition(rule).selector, page) || !lifecyclePagePermitted(actor.principal, actor.authority, page) || !lifecycleDestinationPermitted(actor.principal, actor.authority, page, proposal.destinationPath)) return lifecycleFailure('This move changed or expired. Request a fresh lifecycle preview.', 'LIFECYCLE_PROPOSAL_STALE', 409)
  return async result => {
    if (result.id !== page.id || !/^[1-9]\d*$/.test(String(result.sourceRevision)) || BigInt(result.sourceRevision) <= BigInt(proposal.sourceRevision)) throw new Error('Canonical lifecycle move result mismatch')
    const committedAt = await pageLifecycleDatabaseNow(transaction)
    const outboxId = await writeOutboxEvent(transaction, { type: 'page.lifecycle-move-result', version: 1, aggregateType: 'page', aggregateId: page.id, createdAt: committedAt, payload: { version: 1, pageId: page.id, ruleId: rule.id, cycleId: cycle.id, proposalId: proposal.id, sourceRevision: String(result.sourceRevision), outcome: 'moved', destinationPath: proposal.destinationPath, destinationLocale: proposal.destinationLocale } })
    await transaction('pageLifecycleMoveProposals').where('id', proposal.id).update({ status: 'fulfilled', resultSourceRevision: String(result.sourceRevision), fulfilledBy: actor.account.id, settledAt: committedAt, outboxId })
    await transaction('pageLifecycleActionReceipts').where({ cycleId: cycle.id, effectIndex: proposal.effectIndex, state: 'proposed' }).update({ state: 'fulfilled', afterSourceRevision: String(result.sourceRevision), operationId: result.outboxId, outboxId, updatedAt: committedAt })
    const remaining = await transaction<LifecycleReceipt>('pageLifecycleActionReceipts').where('cycleId', cycle.id)
    const success = remaining.length === lifecycleDefinition(rule).effects.length && remaining.every(receipt => ['applied', 'skipped', 'fulfilled'].includes(receipt.state))
    await transaction('pageLifecycleCycles').where('id', cycle.id).update({ status: success ? 'applied' : 'partial', nextExpectedSourceRevision: String(result.sourceRevision), updatedAt: committedAt, completedAt: committedAt })
  }
}
export const refusePageLifecycleProposal = async (input: PageLifecycleInput) => Page.knex().transaction(async transaction => {
  const actor = await interactiveActor(transaction, input), id = z.uuid().parse(input.proposalId)
  const current = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('id', id).first()
  if (!current) return lifecycleFailure('Move proposal is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  await lockPageLifecycleRule(transaction, current.ruleId)
  const page = await lockLifecycleNativePage(transaction, current.pageId)
  if (!page || !lifecyclePagePermitted(actor.principal, actor.authority, page)) return lifecycleFailure('Move proposal is unavailable.', 'LIFECYCLE_NOT_FOUND', 404)
  await transaction('pageLifecycleRules').where('id', current.ruleId).forUpdate().first()
  await transaction('pageLifecycleCycles').where('id', current.cycleId).forUpdate().first()
  const proposal = await transaction<LifecycleProposal>('pageLifecycleMoveProposals').where('id', id).forUpdate().first()
  if (proposal?.status !== 'awaiting-human') return lifecycleFailure('This proposal has already settled.', 'LIFECYCLE_STALE', 409)
  const now = await pageLifecycleDatabaseNow(transaction)
  await transaction('pageLifecycleMoveProposals').where('id', id).update({ status: 'refused', reason: 'human-refused', settledAt: now })
  await transaction('pageLifecycleActionReceipts').where({ cycleId: proposal.cycleId, effectIndex: proposal.effectIndex }).update({ state: 'refused', reason: 'human-refused', updatedAt: now })
  await transaction('pageLifecycleCycles').where('id', proposal.cycleId).update({ status: 'partial', reason: 'human-refused', updatedAt: now, completedAt: now })
  await transaction('pageLifecycleRules').where('id', proposal.ruleId).update({ status: 'needs-attention', reason: 'human-refused', updatedAt: now })
  return { proposalId: id, status: 'refused' }
})

import type { ApprovalStatus, PageApprovalInbox, PageApprovalInboxItem } from '../../shared/site-notifications.ts'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  canReadPage,
  canWritePage,
  managesSystem,
  pageAuthorizationContext,
  principalId,
  type PagePrincipal,
  type PageVisibilityRecord
} from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import errors from './errors.ts'
import { pageRequiresUnlock } from './page-protection.ts'

const { ApplicationError } = errors
const MAX_VISIBLE_APPROVALS = 100
const APPROVAL_CANDIDATE_BATCH_SIZE = 100
const MAX_PROCESSED_APPROVAL_CANDIDATES = 500
const APPROVAL_CURSOR_TTL_MS = 5 * 60 * 1_000
const MAX_APPROVAL_CURSORS = 128
const MAX_LIVE_APPROVAL_CURSORS_PER_OWNER = 4
const APPROVAL_CURSOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ApprovalAction = 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign'

type ApprovalTimestamp = Date | string | number

interface ApprovalPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
  updatedAt: ApprovalTimestamp
  authorId: number
  content: string
  contentType: string
  description: string
  editorKey: string
  hash: string
  isPublished: boolean | number
  localeCode: string
  sourceRevision: string | number
}

interface ApprovalRequestRow extends Record<string, unknown> {
  id: string
  pageId: number
  submitterId: number
  assigneeId: number | null
  status: ApprovalStatus
  revisionId: number
  revisionUpdatedAt: ApprovalTimestamp
  createdAt: ApprovalTimestamp
  updatedAt: ApprovalTimestamp
  closedAt: ApprovalTimestamp | null
}

interface ApprovalCursor {
  updatedAt: ApprovalTimestamp
  id: string
}

interface StoredApprovalCursor extends ApprovalCursor {
  ownerId: number
  expiresAt: number
}

interface ApprovalPageProjection extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
  updatedAt: ApprovalTimestamp
  localeCode: string
  tags: Array<{ tag: string }>
}

const approvalCursors = new Map<string, StoredApprovalCursor>()
const wireTimestamp = (value: ApprovalTimestamp): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Approval timestamp is invalid')
  return date.toISOString()
}
const wireNullableTimestamp = (value: ApprovalTimestamp | null): string | null => (value === null ? null : wireTimestamp(value))

interface WikiContext {
  auth: {
    checkAccess(user: PagePrincipal, permissions: readonly string[]): boolean
    checkPageAccess(user: PagePrincipal, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
    loadPageRuleAuthority(requester: PagePrincipal, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  models: {
    knex: Knex
    pages: {
      getPageFromDb(id: number): Promise<ApprovalPage | undefined>
      query(transaction?: Knex.Transaction): {
        patch(input: Record<string, unknown>): { where(criteria: Record<string, unknown>): Promise<number> }
      }
    }
    pageHistory: {
      addVersion(input: Record<string, unknown>): Promise<{ id: number }>
    }
  }
}
const loadPageTags = async (transaction: Knex.Transaction, pageId: number): Promise<Array<{ tag: string }>> => {
  const rows = await transaction<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  return rows.map(row => ({ tag: row.tag }))
}
const isApprovalTimestamp = (value: unknown): value is ApprovalTimestamp => {
  if (!(value instanceof Date || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) return false
  return Number.isFinite(new Date(value).valueOf())
}

const loadApprovalPageProjections = async (transaction: Knex, pageIds: readonly number[]): Promise<Map<number, ApprovalPageProjection>> => {
  const uniquePageIds = [...new Set(pageIds)]
  if (uniquePageIds.length === 0) return new Map()

  const pageRows = (await transaction('pages')
    .whereIn('pages.id', uniquePageIds)
    .select('pages.id', 'pages.title', 'pages.path', 'pages.localeCode', 'pages.visibility', 'pages.ownerId', 'pages.updatedAt')) as Array<
    Record<string, unknown>
  >
  const tagRows = (await transaction('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', uniquePageIds)
    .orderBy('pageTags.pageId', 'asc')
    .orderBy('tags.tag', 'asc')
    .select('pageTags.pageId as pageId', 'tags.tag as tag')) as Array<Record<string, unknown>>

  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  const malformedTagPages = new Set<number>()
  for (const row of tagRows) {
    const pageId = row.pageId
    if (typeof pageId !== 'number' || !Number.isSafeInteger(pageId) || pageId < 1) continue
    if (typeof row.tag !== 'string') {
      malformedTagPages.add(pageId)
      continue
    }
    const tags = tagsByPage.get(pageId) ?? []
    tags.push({ tag: row.tag })
    tagsByPage.set(pageId, tags)
  }

  const projections = new Map<number, ApprovalPageProjection>()
  for (const row of pageRows) {
    const id = row.id
    const ownerId = row.ownerId
    const visibility = row.visibility
    const tags = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? (tagsByPage.get(id) ?? []) : []
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof row.title !== 'string' ||
      typeof row.path !== 'string' ||
      row.path.length === 0 ||
      typeof row.localeCode !== 'string' ||
      (visibility !== 'public' && visibility !== 'private') ||
      (ownerId !== null && (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1)) ||
      !isApprovalTimestamp(row.updatedAt) ||
      malformedTagPages.has(id)
    ) {
      continue
    }
    const normalizedVisibility = visibility as 'public' | 'private'
    const normalizedOwnerId = ownerId as number | null
    const normalizedTitle = row.title as string
    const normalizedPath = row.path as string
    const normalizedLocaleCode = row.localeCode as string
    const normalizedUpdatedAt = row.updatedAt as ApprovalTimestamp
    projections.set(id, {
      id,
      title: normalizedTitle,
      path: normalizedPath,
      localeCode: normalizedLocaleCode,
      visibility: normalizedVisibility,
      ownerId: normalizedOwnerId,
      updatedAt: normalizedUpdatedAt,
      tags
    })
  }
  return projections
}

const pruneApprovalCursors = (now = Date.now()): void => {
  for (const [token, cursor] of approvalCursors) {
    if (cursor.expiresAt <= now) approvalCursors.delete(token)
  }
}

const invalidApprovalCursor = (): never => {
  throw new ApplicationError('Approval cursor expired', { status: 409, code: 'APPROVAL_CURSOR_EXPIRED' })
}

const readApprovalCursor = (ownerId: number, value: string | null | undefined): StoredApprovalCursor | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !APPROVAL_CURSOR_PATTERN.test(value)) return invalidApprovalCursor()
  pruneApprovalCursors()
  const cursor = approvalCursors.get(value)
  if (!cursor || cursor.expiresAt <= Date.now() || cursor.ownerId !== ownerId) return invalidApprovalCursor()
  return cursor
}

const equivalentApprovalCursor = (left: StoredApprovalCursor, ownerId: number, right: ApprovalCursor): boolean => {
  if (left.ownerId !== ownerId || left.id !== right.id) return false
  const leftTime = new Date(left.updatedAt).getTime()
  const rightTime = new Date(right.updatedAt).getTime()
  return Number.isFinite(leftTime) && leftTime === rightTime
}

const issueApprovalCursor = (ownerId: number, cursor: ApprovalCursor): string => {
  const now = Date.now()
  pruneApprovalCursors(now)

  for (const [token, stored] of approvalCursors) {
    if (equivalentApprovalCursor(stored, ownerId, cursor)) return token
  }

  let ownerCursorCount = 0
  let oldestOwnerToken: string | undefined
  for (const [token, stored] of approvalCursors) {
    if (stored.ownerId !== ownerId) continue
    ownerCursorCount += 1
    if (oldestOwnerToken === undefined) oldestOwnerToken = token
  }
  if (ownerCursorCount >= MAX_LIVE_APPROVAL_CURSORS_PER_OWNER && oldestOwnerToken !== undefined) approvalCursors.delete(oldestOwnerToken)
  if (approvalCursors.size >= MAX_APPROVAL_CURSORS) {
    throw new ApplicationError('Approval cursor capacity exhausted', { status: 503, code: 'NOTIFICATION_CURSOR_CAPACITY' })
  }

  const token = randomUUID()
  approvalCursors.set(token, {
    ownerId,
    updatedAt: cursor.updatedAt,
    id: cursor.id,
    expiresAt: now + APPROVAL_CURSOR_TTL_MS
  })
  return token
}

const wiki = (global as typeof globalThis & { WIKI: unknown }).WIKI as unknown as WikiContext

const actorId = (requester: PagePrincipal): number => {
  const id = principalId(requester)
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  if (id === null || id === 2 || email === 'api@localhost') throw new ApplicationError('Authentication is required', { status: 401, code: 'AUTH_REQUIRED' })
  return id
}

const requiredSourceRevision = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new ApplicationError('expectedSourceRevision must be a canonical positive decimal', { status: 400, code: 'INVALID_INPUT' })
  }
  return value
}

const reviewerEligible = (requester: PagePrincipal, page: ApprovalPage | ApprovalPageProjection, authority: PageRuleAuthority): boolean => {
  if (managesSystem(requester)) return true
  const context = pageAuthorizationContext(page)
  return context !== null && wiki.auth.checkPageAccess(requester, ['manage:pages'], context, authority)
}

const staleRevision = (request: ApprovalRequestRow, page: Pick<ApprovalPage, 'updatedAt'>): boolean =>
  !['published', 'rejected', 'cancelled'].includes(request.status) && new Date(request.revisionUpdatedAt).valueOf() !== new Date(page.updatedAt).valueOf()

const approvalEvent = async (
  transaction: Knex.Transaction,
  request: ApprovalRequestRow,
  type: string,
  actor: number,
  page: ApprovalPage,
  comment?: string
): Promise<void> => {
  await writeOutboxEvent(transaction, {
    type,
    version: 1,
    aggregateType: 'page-approval',
    aggregateId: request.id,
    payload: {
      requestId: request.id,
      pageId: request.pageId,
      revisionId: request.revisionId,
      status: request.status,
      actorId: actor,
      submitterId: request.submitterId,
      assigneeId: request.assigneeId,
      title: page.title,
      path: page.path,
      localeCode: page.localeCode,
      visibility: page.visibility,
      ...(comment ? { comment } : {})
    }
  })
}

const snapshotRevision = async (transaction: Knex.Transaction, page: ApprovalPage, action: string): Promise<number> => {
  const revision = await wiki.models.pageHistory.addVersion({
    ...page,
    action,
    versionDate: page.updatedAt,
    transaction
  })
  return revision.id
}

const publishPage = async (transaction: Knex.Transaction, page: ApprovalPage, actor: number): Promise<void> => {
  await snapshotRevision(transaction, page, 'approval-published')
  const changedRows = await wiki.models.pages
    .query(transaction)
    .patch({ isPublished: true, authorId: actor })
    .where({ id: page.id, sourceRevision: page.sourceRevision })
  if (changedRows !== 1) throw new ApplicationError('The approved revision is stale', { status: 409, code: 'APPROVAL_STALE' })

  const publishedPage = await transaction<ApprovalPage>('pages')
    .select('id', 'sourceRevision', 'content', 'localeCode', 'path', 'visibility', 'ownerId')
    .where({ id: page.id })
    .forUpdate()
    .first()
  if (!publishedPage) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  await enqueuePageMutationEffects(transaction, {
    pageId: publishedPage.id,
    sourceRevision: publishedPage.sourceRevision,
    desiredState: 'present',
    action: 'update',
    source: publishedPage.content,
    location: {
      locale: publishedPage.localeCode,
      path: publishedPage.path,
      visibility: publishedPage.visibility,
      ownerId: publishedPage.ownerId
    }
  })
}

const canViewRequest = (
  requester: PagePrincipal,
  request: ApprovalRequestRow,
  page: ApprovalPage | ApprovalPageProjection,
  authority: PageRuleAuthority
): boolean => {
  const id = principalId(requester)
  return canReadPage(requester, page, authority) && (id === request.submitterId || id === request.assigneeId || reviewerEligible(requester, page, authority))
}

export const getPageApproval = async (input: { requester: PagePrincipal; pageId: number; sessionId: string }): Promise<Record<string, unknown> | null> => {
  actorId(input.requester)
  const page = await wiki.models.pages.getPageFromDb(input.pageId)
  const authority = await wiki.auth.loadPageRuleAuthority(input.requester)
  if (!page || !canReadPage(input.requester, page, authority)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  if (await pageRequiresUnlock({ requester: input.requester, pageId: input.pageId, sessionId: input.sessionId })) {
    throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
  }
  const request = await wiki.models.knex<ApprovalRequestRow>('pageApprovalRequests').where({ pageId: input.pageId }).orderBy('createdAt', 'desc').first()
  if (!request || !canViewRequest(input.requester, request, page, authority)) return null
  const transitions = await wiki.models.knex('pageApprovalTransitions').where({ requestId: request.id }).orderBy('createdAt', 'asc')
  return {
    ...request,
    stale: staleRevision(request, page),
    canReview:
      reviewerEligible(input.requester, page, authority) &&
      (request.assigneeId === null || request.assigneeId === principalId(input.requester) || managesSystem(input.requester)),
    canSubmitter: request.submitterId === principalId(input.requester),
    transitions
  }
}

export const submitPageApproval = async (input: {
  requester: PagePrincipal
  pageId: number
  sessionId: string
  expectedSourceRevision: unknown
  assigneeId?: number
  comment?: string
}): Promise<ApprovalRequestRow> => {
  const submitterId = actorId(input.requester)
  const expectedSourceRevision = requiredSourceRevision(input.expectedSourceRevision)
  if (input.assigneeId !== undefined && (!Number.isSafeInteger(input.assigneeId) || input.assigneeId < 1)) {
    throw new ApplicationError('assigneeId must be a positive integer', { status: 400, code: 'INVALID_INPUT' })
  }
  const loadedPage = await wiki.models.pages.getPageFromDb(input.pageId)
  return wiki.models.knex.transaction(async transaction => {
    const currentPage = await transaction('pages').where({ id: input.pageId }).forUpdate().first()
    if (!currentPage) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    const page = (loadedPage ? { ...loadedPage, ...currentPage } : currentPage) as ApprovalPage
    page.tags = await loadPageTags(transaction, page.id)
    const authority = await wiki.auth.loadPageRuleAuthority(input.requester, transaction)
    if (!canWritePage(input.requester, page, authority)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    if (await pageRequiresUnlock({ requester: input.requester, pageId: page.id, sessionId: input.sessionId, transaction })) {
      throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
    }
    if (String(currentPage.sourceRevision) !== expectedSourceRevision) {
      throw new ApplicationError('The page changed before approval submission', { status: 409, code: 'APPROVAL_STALE' })
    }
    const active = await transaction<ApprovalRequestRow>('pageApprovalRequests')
      .where({ pageId: page.id })
      .whereIn('status', ['submitted', 'approved', 'changes-requested'])
      .first()
    if (active) throw new ApplicationError('This page already has an active approval request', { status: 409, code: 'APPROVAL_ACTIVE' })
    const revisionId = await snapshotRevision(transaction, page, 'approval-submitted')
    const now = new Date()
    const request: ApprovalRequestRow = {
      id: randomUUID(),
      pageId: page.id,
      submitterId,
      assigneeId: input.assigneeId ?? null,
      status: 'submitted',
      revisionId,
      revisionUpdatedAt: page.updatedAt,
      createdAt: now,
      updatedAt: now,
      closedAt: null
    }
    await transaction('pageApprovalRequests').insert(request)
    await transaction('pageApprovalTransitions').insert({
      id: randomUUID(),
      requestId: request.id,
      fromStatus: null,
      toStatus: 'submitted',
      actorId: submitterId,
      revisionId,
      comment: input.comment?.trim() || null,
      createdAt: now
    })
    await approvalEvent(transaction, request, 'approval.submitted', submitterId, page, input.comment)
    return request
  })
}

export const listApprovalInbox = async (requester: PagePrincipal, cursor?: string | null): Promise<PageApprovalInbox> => {
  const id = actorId(requester)
  const storedCursor = readApprovalCursor(id, cursor)
  const authority = await wiki.auth.loadPageRuleAuthority(requester)
  const administrator = managesSystem(requester)
  const items: PageApprovalInboxItem[] = []
  let queryCursor: ApprovalCursor | null = storedCursor
  let processed = 0
  let lastProcessedCursor: ApprovalCursor | null = null
  let nextCursor: string | null = null

  while (items.length < MAX_VISIBLE_APPROVALS && processed < MAX_PROCESSED_APPROVAL_CANDIDATES) {
    const batchLimit = Math.min(APPROVAL_CANDIDATE_BATCH_SIZE, MAX_PROCESSED_APPROVAL_CANDIDATES - processed)
    let query = wiki.models
      .knex<ApprovalRequestRow>('pageApprovalRequests')
      .select<ApprovalRequestRow[]>('pageApprovalRequests.*')
      .whereIn('pageApprovalRequests.status', ['submitted', 'approved', 'changes-requested'])

    if (!administrator) {
      query = query
        .innerJoin('pages', 'pages.id', 'pageApprovalRequests.pageId')
        .where(function () {
          this.where('pageApprovalRequests.submitterId', id).orWhere('pageApprovalRequests.assigneeId', id).orWhereNull('pageApprovalRequests.assigneeId')
        })
        .andWhere(function () {
          this.where('pages.visibility', 'public').orWhere(function () {
            this.where('pages.visibility', 'private').andWhere('pages.ownerId', id)
          })
        })
    }

    const currentCursor = queryCursor
    if (currentCursor) {
      query = query.andWhere(function () {
        this.where('pageApprovalRequests.updatedAt', '<', currentCursor.updatedAt).orWhere(function () {
          this.where('pageApprovalRequests.updatedAt', currentCursor.updatedAt).andWhere('pageApprovalRequests.id', '<', currentCursor.id)
        })
      })
    }

    const rows = await query.orderBy('pageApprovalRequests.updatedAt', 'desc').orderBy('pageApprovalRequests.id', 'desc').limit(batchLimit)
    if (rows.length === 0) break

    const pageById = await loadApprovalPageProjections(
      wiki.models.knex,
      rows.map(request => request.pageId)
    )

    let processedRowsInBatch = 0
    for (const request of rows) {
      if (processed >= MAX_PROCESSED_APPROVAL_CANDIDATES || items.length >= MAX_VISIBLE_APPROVALS) break
      processedRowsInBatch += 1
      processed += 1
      lastProcessedCursor = { updatedAt: request.updatedAt, id: String(request.id) }
      const page = pageById.get(request.pageId)
      if (!page || !canViewRequest(requester, request, page, authority)) continue
      items.push({
        ...request,
        revisionUpdatedAt: wireTimestamp(request.revisionUpdatedAt),
        createdAt: wireTimestamp(request.createdAt),
        updatedAt: wireTimestamp(request.updatedAt),
        closedAt: wireNullableTimestamp(request.closedAt),
        stale: staleRevision(request, page),
        title: page.title,
        path: page.path,
        localeCode: page.localeCode,
        visibility: page.visibility,
        canReview: reviewerEligible(requester, page, authority) && (request.assigneeId === null || request.assigneeId === id || administrator)
      })
    }
    queryCursor = lastProcessedCursor
    const shouldIssueCursor = processedRowsInBatch < rows.length || rows.length === batchLimit

    if (items.length >= MAX_VISIBLE_APPROVALS) {
      if (lastProcessedCursor && shouldIssueCursor) nextCursor = issueApprovalCursor(id, lastProcessedCursor)
      break
    }
    if (processed >= MAX_PROCESSED_APPROVAL_CANDIDATES) {
      if (lastProcessedCursor && shouldIssueCursor) nextCursor = issueApprovalCursor(id, lastProcessedCursor)
      break
    }
    if (rows.length < batchLimit) break
  }

  return { ownerId: id, items, nextCursor }
}

export const transitionApproval = async (input: {
  requester: PagePrincipal
  requestId: string
  action: ApprovalAction
  sessionId: string
  expectedSourceRevision?: unknown
  comment?: string
  assigneeId?: number
}): Promise<ApprovalRequestRow> => {
  const comment = input.comment?.trim() || ''
  if ((input.action === 'request-changes' || input.action === 'reject') && !comment) {
    throw new ApplicationError('A review comment is required', { status: 400, code: 'COMMENT_REQUIRED' })
  }
  const actor = actorId(input.requester)
  const expectedSourceRevision = input.action === 'resubmit' ? requiredSourceRevision(input.expectedSourceRevision) : undefined
  let published = false
  const result = await wiki.models.knex.transaction(async transaction => {
    const request = await transaction<ApprovalRequestRow>('pageApprovalRequests').where({ id: input.requestId }).forUpdate().first()
    if (!request) throw new ApplicationError('Approval request not found', { status: 404, code: 'APPROVAL_NOT_FOUND' })
    const currentPage = await transaction('pages').where({ id: request.pageId }).forUpdate().first()
    if (!currentPage) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    const page = currentPage as ApprovalPage
    page.tags = await loadPageTags(transaction, page.id)
    const authority = await wiki.auth.loadPageRuleAuthority(input.requester, transaction)
    if (!canViewRequest(input.requester, request, page, authority))
      throw new ApplicationError('Approval request not found', { status: 404, code: 'APPROVAL_NOT_FOUND' })
    if (await pageRequiresUnlock({ requester: input.requester, pageId: page.id, sessionId: input.sessionId, transaction })) {
      throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
    }
    const admin = managesSystem(input.requester)
    const reviewer = reviewerEligible(input.requester, page, authority) && (request.assigneeId === null || request.assigneeId === actor || admin)
    const submitter = request.submitterId === actor
    let nextStatus = request.status
    let revisionId = request.revisionId
    let revisionUpdatedAt = request.revisionUpdatedAt
    let assigneeId = request.assigneeId

    switch (input.action) {
      case 'approve':
        if (request.status !== 'submitted' || !reviewer) throw new ApplicationError('Approval is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (staleRevision(request, page)) throw new ApplicationError('The submitted revision is stale', { status: 409, code: 'APPROVAL_STALE' })
        nextStatus = 'approved'
        break
      case 'request-changes':
        if (request.status !== 'submitted' || !reviewer) throw new ApplicationError('Review is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        nextStatus = 'changes-requested'
        break
      case 'reject':
        if (request.status !== 'submitted' || !reviewer) throw new ApplicationError('Rejection is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        nextStatus = 'rejected'
        break
      case 'cancel':
        if (!submitter && !admin) throw new ApplicationError('Cancellation is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (!['submitted', 'approved', 'changes-requested'].includes(request.status))
          throw new ApplicationError('Approval request is already closed', { status: 409, code: 'APPROVAL_CLOSED' })
        nextStatus = 'cancelled'
        break
      case 'resubmit':
        if (request.status !== 'changes-requested' || (!submitter && !admin))
          throw new ApplicationError('Resubmission is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (!canWritePage(input.requester, page, authority))
          throw new ApplicationError('Resubmission is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (String(currentPage.sourceRevision) !== expectedSourceRevision)
          throw new ApplicationError('The page changed before approval resubmission', { status: 409, code: 'APPROVAL_STALE' })
        revisionId = await snapshotRevision(transaction, page, 'approval-resubmitted')
        revisionUpdatedAt = page.updatedAt
        nextStatus = 'submitted'
        break
      case 'publish':
        if (request.status !== 'approved' || !reviewer) throw new ApplicationError('Publication is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (staleRevision(request, page)) throw new ApplicationError('The approved revision is stale', { status: 409, code: 'APPROVAL_STALE' })
        await publishPage(transaction, page, actor)
        nextStatus = 'published'
        published = true
        break
      case 'reassign':
        if (!reviewer && !admin) throw new ApplicationError('Reassignment is not allowed', { status: 403, code: 'APPROVAL_FORBIDDEN' })
        if (input.assigneeId === undefined || !Number.isSafeInteger(input.assigneeId) || input.assigneeId < 1)
          throw new ApplicationError('assigneeId must be a positive integer', { status: 400, code: 'INVALID_INPUT' })
        assigneeId = input.assigneeId
        break
    }

    const now = new Date()
    const terminal = ['rejected', 'cancelled', 'published'].includes(nextStatus)
    const updated: ApprovalRequestRow = {
      ...request,
      status: nextStatus,
      revisionId,
      revisionUpdatedAt,
      assigneeId,
      updatedAt: now,
      closedAt: terminal ? now : null
    }
    await transaction('pageApprovalRequests').where({ id: request.id }).update({
      status: updated.status,
      revisionId: updated.revisionId,
      revisionUpdatedAt: updated.revisionUpdatedAt,
      assigneeId: updated.assigneeId,
      updatedAt: updated.updatedAt,
      closedAt: updated.closedAt
    })
    await transaction('pageApprovalTransitions').insert({
      id: randomUUID(),
      requestId: request.id,
      fromStatus: request.status,
      toStatus: nextStatus,
      actorId: actor,
      revisionId,
      comment: comment || null,
      createdAt: now
    })
    await approvalEvent(transaction, updated, `approval.${input.action.replaceAll('-', '')}`, actor, page, comment)
    if (published) {
      await writeOutboxEvent(transaction, {
        type: 'page.updated',
        version: 1,
        aggregateType: 'page',
        aggregateId: page.id,
        payload: {
          pageId: page.id,
          actorId: actor,
          actorName: input.requester && typeof input.requester === 'object' ? Reflect.get(input.requester, 'name') : 'Reviewer',
          title: page.title,
          path: page.path,
          localeCode: page.localeCode,
          ownerId: page.ownerId,
          tags: page.tags,
          visibility: page.visibility
        }
      })
    }
    return updated
  })

  return result
}

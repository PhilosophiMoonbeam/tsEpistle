import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canReadPage, canWritePage, managesSystem, principalId, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import errors from './errors.ts'
import { redactProtectedPageForSearch } from './page-protection.ts'

const { ApplicationError } = errors

type ApprovalStatus = 'submitted' | 'approved' | 'changes-requested' | 'rejected' | 'cancelled' | 'published'
type ApprovalAction = 'approve' | 'request-changes' | 'reject' | 'cancel' | 'resubmit' | 'publish' | 'reassign'

interface ApprovalPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  title: string
  updatedAt: string | Date
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
  revisionUpdatedAt: string | Date
  createdAt: string | Date
  updatedAt: string | Date
  closedAt: string | Date | null
}

interface WikiContext {
  auth: { checkAccess(user: PagePrincipal, permissions: readonly string[], context: Record<string, unknown>): boolean }
  data: { searchEngine: { updated(page: unknown): Promise<void> } }
  models: {
    knex: Knex
    pages: {
      getPageFromDb(id: number): Promise<ApprovalPage | undefined>
      query(transaction?: Knex.Transaction): {
        patch(input: Record<string, unknown>): { where(criteria: Record<string, unknown>): Promise<number> }
        findById(id: number): { select(...columns: string[]): Promise<Record<string, unknown> | undefined> }
      }
      cleanHTML(value: string): string
    }
    pageHistory: {
      addVersion(input: Record<string, unknown>): Promise<{ id: number }>
    }
  }
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

const reviewerEligible = (requester: PagePrincipal, page: ApprovalPage): boolean =>
  managesSystem(requester) || wiki.auth.checkAccess(requester, ['manage:pages'], { path: page.path, locale: page.localeCode, tags: page.tags })

const staleRevision = (request: ApprovalRequestRow, page: ApprovalPage): boolean =>
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

const loadRequestPage = async (id: string): Promise<{ request: ApprovalRequestRow; page: ApprovalPage }> => {
  const request = await wiki.models.knex<ApprovalRequestRow>('pageApprovalRequests').where({ id }).first()
  if (!request) throw new ApplicationError('Approval request not found', { status: 404, code: 'APPROVAL_NOT_FOUND' })
  const page = await wiki.models.pages.getPageFromDb(request.pageId)
  if (!page) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  return { request, page }
}

const canViewRequest = (requester: PagePrincipal, request: ApprovalRequestRow, page: ApprovalPage): boolean => {
  const id = principalId(requester)
  return canReadPage(requester, page) && (id === request.submitterId || id === request.assigneeId || reviewerEligible(requester, page))
}

export const getPageApproval = async (requester: PagePrincipal, pageId: number): Promise<Record<string, unknown> | null> => {
  actorId(requester)
  const page = await wiki.models.pages.getPageFromDb(pageId)
  if (!page || !canReadPage(requester, page)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
  const request = await wiki.models.knex<ApprovalRequestRow>('pageApprovalRequests').where({ pageId }).orderBy('createdAt', 'desc').first()
  if (!request || !canViewRequest(requester, request, page)) return null
  const transitions = await wiki.models.knex('pageApprovalTransitions').where({ requestId: request.id }).orderBy('createdAt', 'asc')
  return {
    ...request,
    stale: staleRevision(request, page),
    canReview: reviewerEligible(requester, page) && (request.assigneeId === null || request.assigneeId === principalId(requester) || managesSystem(requester)),
    canSubmitter: request.submitterId === principalId(requester),
    transitions
  }
}

export const submitPageApproval = async (input: {
  requester: PagePrincipal
  pageId: number
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
    const page = loadedPage ? ({ ...loadedPage, ...currentPage } as ApprovalPage) : undefined
    if (!page || !canWritePage(input.requester, page)) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
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

export const listApprovalInbox = async (requester: PagePrincipal): Promise<{ items: Array<Record<string, unknown>> }> => {
  const id = actorId(requester)
  const rows = await wiki.models
    .knex<ApprovalRequestRow>('pageApprovalRequests')
    .whereIn('status', ['submitted', 'approved', 'changes-requested'])
    .orderBy('updatedAt', 'desc')
    .limit(100)
  const items: Array<Record<string, unknown>> = []
  for (const request of rows) {
    const page = await wiki.models.pages.getPageFromDb(request.pageId)
    if (!page || !canViewRequest(requester, request, page)) continue
    if (request.assigneeId !== null && request.assigneeId !== id && request.submitterId !== id && !managesSystem(requester)) continue
    items.push({
      ...request,
      stale: staleRevision(request, page),
      title: page.title,
      path: page.path,
      localeCode: page.localeCode,
      visibility: page.visibility,
      canReview: reviewerEligible(requester, page) && (request.assigneeId === null || request.assigneeId === id || managesSystem(requester))
    })
  }
  return { items }
}

export const transitionApproval = async (input: {
  requester: PagePrincipal
  requestId: string
  action: ApprovalAction
  comment?: string
  assigneeId?: number
}): Promise<ApprovalRequestRow> => {
  const actor = actorId(input.requester)
  const loaded = await loadRequestPage(input.requestId)
  if (!canViewRequest(input.requester, loaded.request, loaded.page))
    throw new ApplicationError('Approval request not found', { status: 404, code: 'APPROVAL_NOT_FOUND' })
  const comment = input.comment?.trim() || ''
  if ((input.action === 'request-changes' || input.action === 'reject') && !comment) {
    throw new ApplicationError('A review comment is required', { status: 400, code: 'COMMENT_REQUIRED' })
  }

  let published = false
  const result = await wiki.models.knex.transaction(async transaction => {
    const request = await transaction<ApprovalRequestRow>('pageApprovalRequests').where({ id: input.requestId }).forUpdate().first()
    if (!request) throw new ApplicationError('Approval request not found', { status: 404, code: 'APPROVAL_NOT_FOUND' })
    const currentPage = await transaction('pages').where({ id: request.pageId }).forUpdate().first()
    if (!currentPage) throw new ApplicationError('Page not found', { status: 404, code: 'PAGE_NOT_FOUND' })
    const page = { ...loaded.page, ...currentPage } as ApprovalPage
    const admin = managesSystem(input.requester)
    const reviewer = reviewerEligible(input.requester, page) && (request.assigneeId === null || request.assigneeId === actor || admin)
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

  if (published) {
    const page = await wiki.models.pages.getPageFromDb(result.pageId)
    if (page && page.visibility === 'public') {
      const contents = await wiki.models.pages.query().findById(page.id).select('render')
      if (contents && typeof contents.render === 'string') {
        Reflect.set(page, 'safeContent', wiki.models.pages.cleanHTML(contents.render))
      }
      await redactProtectedPageForSearch(page)
      await wiki.data.searchEngine.updated(page)
    }
  }
  return result
}

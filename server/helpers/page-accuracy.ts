import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  classifyPageAccuracy,
  PageAccuracySourceRevisionSchema,
  PageAccuracyViewSchema,
  type PageAccuracyAttestation,
  type PageAccuracyView,
  type VerifyPageAccuracyInput
} from '../../shared/page-accuracy.ts'
import { canReadPage, canWritePage, type PageVisibilityRecord } from './page-access.ts'
import { canViewRestrictedPageFields } from './page-field-projection.ts'
import type { PageRuleAuthority } from './group-access.ts'
import { authorizePageCreationAccount } from '../operations/live-notes.ts'
import { pageRequiresUnlock } from '../operations/page-protection.ts'
import errors from '../operations/errors.ts'
import { recordPageReviewAttestation } from './page-review-events.ts'

interface AccuracyPage extends PageVisibilityRecord, Record<string, unknown> {
  id: number
  sourceRevision?: string | number
  updatedAt: Date | string
  authorId?: number
}
interface AttestationRow {
  id: string
  pageId: number
  sourceRevision: string
  verifiedBy: number | null
  verifiedAt: Date | string
  verifiedByName: string | null
}
interface AccuracyInput {
  knex: Knex
  requester: Express.User | undefined
  sessionId: string
  delegated: boolean
  loadAuthority(requester: Express.User | undefined, transaction: Knex.Transaction): Promise<PageRuleAuthority>
}
interface AccuracyContext {
  requester: Express.User | undefined
  authority: PageRuleAuthority
  page: AccuracyPage
  humanId: number | null
}

const { ApplicationError } = errors
const missing = (): never => {
  throw new ApplicationError('This page does not exist.', { status: 404, code: 'PAGE_NOT_FOUND' })
}
const browserAccount = (input: AccuracyInput): boolean => {
  const user = input.requester
  return (
    !input.delegated &&
    input.sessionId.length > 0 &&
    user !== undefined &&
    Number.isSafeInteger(user.id) &&
    Number(user.id) > 0 &&
    user.id !== 2 &&
    !('api' in user) &&
    !('grp' in user) &&
    (!('ownershipUserId' in user) || user.ownershipUserId === user.id)
  )
}
const displayName = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const loadContext = async (transaction: Knex.Transaction, input: AccuracyInput, pageId: number, requireHuman: boolean): Promise<AccuracyContext> => {
  let requester = input.requester
  let humanId: number | null = null
  if (browserAccount(input)) {
    // Reuse the established groups -> account locks, active-session check and
    // fresh membership permissions; never authorize from a delegated user id.
    const account = await authorizePageCreationAccount(transaction, requester)
    if (Reflect.get(account, 'isSystem') === false && Reflect.get(account, 'email') !== 'api@localhost') humanId = account.id
    requester = account
  }
  if (requireHuman && humanId === null) throw new ApplicationError('A current human browser account is required.', { status: 401, code: 'AUTH_REQUIRED' })
  const pageQuery = transaction<AccuracyPage>('pages').where({ id: pageId })
  const row = await (requireHuman ? pageQuery.forUpdate() : pageQuery.forShare()).first()
  if (!row) return missing()
  const authority = await input.loadAuthority(requester, transaction)
  const tags = await transaction('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', pageId).select('tags.tag')
  const page = { ...row, tags }
  if (!canReadPage(requester, page, authority)) return missing()
  if (await pageRequiresUnlock({ requester, pageId, sessionId: input.sessionId, transaction, readOnly: true })) {
    throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
  }
  return { requester, authority, page, humanId }
}

const projectAccuracy = async (
  transaction: Knex.Transaction,
  context: AccuracyContext,
  source: AccuracyPage,
  now: Date
): Promise<PageAccuracyView> => {
  const sourceRevision = PageAccuracySourceRevisionSchema.parse(String(source.sourceRevision))
  const matchingCurrent = String(context.page.sourceRevision) === sourceRevision
  const mayAttribute = canViewRestrictedPageFields({ requester: context.requester, page: context.page, authority: context.authority })
  let author: PageAccuracyView['author'] = null
  if (mayAttribute && typeof source.authorId === 'number' && Number.isSafeInteger(source.authorId) && source.authorId > 0) {
    const row = await transaction<{ id: number; name: string | null }>('users').where({ id: source.authorId }).select('id', 'name').first()
    if (row) author = { id: row.id, name: displayName(row.name) }
  }
  const row = matchingCurrent
    ? await transaction<AttestationRow>('pageAccuracyAttestations')
        .leftJoin('users', 'users.id', 'pageAccuracyAttestations.verifiedBy')
        .where({ 'pageAccuracyAttestations.pageId': source.id, 'pageAccuracyAttestations.sourceRevision': sourceRevision })
        .select('pageAccuracyAttestations.*', 'users.name as verifiedByName')
        .orderBy('pageAccuracyAttestations.verifiedAt', 'desc')
        .orderBy('pageAccuracyAttestations.id', 'desc')
        .first()
    : undefined
  const latestAttestation: PageAccuracyAttestation | null = row
    ? {
        id: row.id,
        pageId: row.pageId,
        sourceRevision: String(row.sourceRevision),
        verifiedBy: mayAttribute ? row.verifiedBy : null,
        verifiedByName: mayAttribute && row.verifiedBy !== null ? displayName(row.verifiedByName) : null,
        verifiedAt: new Date(row.verifiedAt).toISOString()
      }
    : null
  return PageAccuracyViewSchema.parse({
    sourceRevision,
    updatedAt: new Date(source.updatedAt).toISOString(),
    author,
    latestAttestation,
    canVerify: matchingCurrent && context.humanId !== null && canWritePage(context.requester, context.page, context.authority),
    asOf: now.toISOString(),
    status: classifyPageAccuracy(sourceRevision, latestAttestation, now.valueOf())
  })
}

/** Called only from the authorized, unlocked reader projection, not offline envelopes. */
export const readPageAccuracy = (input: AccuracyInput & { page: AccuracyPage }): Promise<PageAccuracyView> =>
  input.knex.transaction(async transaction => {
    const context = await loadContext(transaction, input, input.page.id, false)
    return projectAccuracy(transaction, context, input.page, new Date())
  })

export const attestPageAccuracy = (input: AccuracyInput & { pageId: number; mutation: VerifyPageAccuracyInput }): Promise<PageAccuracyView> =>
  input.knex.transaction(async transaction => {
    const context = await loadContext(transaction, input, input.pageId, true)
    if (!canWritePage(context.requester, context.page, context.authority)) {
      throw new ApplicationError('You do not have permission to verify this page.', { status: 403, code: 'PAGE_VERIFY_FORBIDDEN' })
    }
    if (String(context.page.sourceRevision) !== input.mutation.expectedSourceRevision) {
      throw new ApplicationError('The page changed. Reload it before verifying accuracy.', { status: 409, code: 'PAGE_ACCURACY_STALE' })
    }
    const now = new Date()
    const attestationId = randomUUID()
    // Every deliberate action appends a fact. Repeating an action never changes
    // an earlier record, and no content/approval/revision metadata is touched.
    await transaction('pageAccuracyAttestations').insert({
      id: attestationId,
      pageId: context.page.id,
      sourceRevision: input.mutation.expectedSourceRevision,
      verifiedBy: context.humanId,
      verifiedAt: now
    })
    await recordPageReviewAttestation(transaction, {
      pageId: context.page.id,
      sourceRevision: input.mutation.expectedSourceRevision,
      attestationId,
      verifiedAt: now
    })
    return projectAccuracy(transaction, context, context.page, now)
  })

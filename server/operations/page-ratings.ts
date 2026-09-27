import { z } from 'zod'
import type { Knex } from 'knex'
import {
  DEFAULT_PAGE_RATING_MODE,
  PageRatingModeSchema,
  PageRatingViewSchema,
  PageRatingVoteSchema,
  type PageRatingMode,
  type PageRatingView,
  type PageRatingVote
} from '../../shared/page-ratings.ts'
import { normalizePageFeatures } from '../../shared/page-features.ts'
import { DISCUSSION_SETTINGS_LOCK } from './discussion-settings.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { canReadPage, principalId, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { isApiPrincipal } from '../helpers/api-principal.ts'
import { pageRequiresUnlock } from './page-protection.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
const MAX_PAGE_ID = 2_147_483_647

interface WikiContext {
  config: { db: { type?: string }; features: Record<string, unknown> }
  auth: {
    loadPageRuleAuthority(requester: PagePrincipal | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  models: { knex: Knex }
}

interface PageRow extends PageVisibilityRecord {
  id: number
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  ownerId: number | null
  extra: unknown
}

interface AccountRow {
  id: number
  isActive: boolean
  authVersion: number
}

interface RatingSettingRow {
  key: string
  value: unknown
}
interface RatingCountRow {
  value: number | string
  count: number | string
  ownVote?: number | string | null
}

const wiki = WIKI as unknown as WikiContext
const RatingRecordSchema = z.record(z.string(), z.unknown())

const recordValue = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      const parsed = RatingRecordSchema.safeParse(JSON.parse(value))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  const parsed = RatingRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const authenticatedHumanId = (requester: PagePrincipal | undefined): number => {
  const email = requester && typeof requester === 'object' ? Reflect.get(requester, 'email') : undefined
  const id = principalId(requester)
  if (isApiPrincipal(requester) || id === null || id === 2 || email === 'api@localhost') {
    throw new ApplicationError('Authentication is required to rate pages.', { status: 401, code: 'AUTH_REQUIRED' })
  }
  return id
}

const validPageId = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ID) {
    throw new ApplicationError('Choose a valid page.', { status: 400, code: 'INVALID_PAGE_ID' })
  }
  return value
}

const parseVote = (value: unknown): PageRatingVote => {
  const parsed = PageRatingVoteSchema.safeParse(value)
  if (!parsed.success) throw new ApplicationError('Choose a valid vote for the active page-rating mode.', { status: 400, code: 'INVALID_PAGE_RATING' })
  return parsed.data
}

const unavailable = (): never => {
  throw new ApplicationError('Ratings are unavailable for this page.', { status: 403, code: 'PAGE_RATINGS_DISABLED' })
}

const notFound = (): never => {
  throw new ApplicationError('Page not found.', { status: 404, code: 'PAGE_NOT_FOUND' })
}

const requirePostgresRatingsPolicyLock = async (transaction: Knex.Transaction): Promise<void> => {
  if (wiki.config.db.type === 'postgres') {
    await transaction.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
  }
}

const currentRatingMode = async (transaction: Knex.Transaction): Promise<PageRatingMode> => {
  const setting = await transaction<RatingSettingRow>('settings').where('key', 'features').forShare().first('value')
  const flags = setting ? recordValue(setting.value) : wiki.config.features
  if (flags === null) return unavailable()
  if (flags.featurePageRatings !== true) return unavailable()
  const candidate = flags.pageRatingsMode
  if (candidate === undefined) return DEFAULT_PAGE_RATING_MODE
  const parsed = PageRatingModeSchema.safeParse(candidate)
  if (!parsed.success) throw new ApplicationError('The configured page-rating mode is invalid.', { status: 409, code: 'PAGE_RATING_MODE_INVALID' })
  return parsed.data
}

const pageAllowsRatings = (value: unknown): boolean => {
  if (value === undefined) return normalizePageFeatures(undefined).ratingsAllowed
  const extra = recordValue(value)
  if (!extra) return false
  return normalizePageFeatures(extra.pageFeatures).ratingsAllowed
}

const loadCurrentPage = async (transaction: Knex.Transaction, pageId: number): Promise<PageRow | undefined> => {
  const row = await transaction<PageRow>('pages').where('id', pageId).forShare().first()
  if (!row) return undefined
  const tags = await transaction<{ tag: string }>('pageTags')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', row.id)
    .orderBy('tags.tag', 'asc')
    .select('tags.tag')
  return { ...row, tags }
}

const currentAccount = async (
  transaction: Knex.Transaction,
  requester: PagePrincipal | undefined,
  userId: number,
  lock: 'share' | 'update'
): Promise<void> => {
  const query = transaction<AccountRow>('users').where('id', userId).select('id', 'isActive', 'authVersion')
  const account = await (lock === 'update' ? query.forUpdate() : query.forShare()).first()
  if (!accountSessionIsCurrent({ id: userId, authVersion: requester && Reflect.get(requester, 'authVersion') }, account)) {
    throw new ApplicationError('Sign in again before rating pages.', { status: 401, code: 'AUTH_REQUIRED' })
  }
}

interface AuthorizedRatingContext {
  mode: PageRatingMode
  userId: number
}
const authorize = async (
  transaction: Knex.Transaction,
  input: { requester: PagePrincipal | undefined; pageId: number; sessionId: string; mutation: boolean }
): Promise<AuthorizedRatingContext> => {
  const requester = input.requester
  if (requester === undefined) {
    throw new ApplicationError('Authentication is required to rate pages.', { status: 401, code: 'AUTH_REQUIRED' })
  }
  const userId = authenticatedHumanId(requester)
  const page = await loadCurrentPage(transaction, input.pageId)
  if (page === undefined) return notFound()

  const authority = await wiki.auth.loadPageRuleAuthority(requester, transaction)
  if (!canReadPage(requester, page, authority)) return notFound()

  const mode = await currentRatingMode(transaction)
  if (!pageAllowsRatings(page.extra)) unavailable()

  await currentAccount(transaction, requester, userId, input.mutation ? 'update' : 'share')
  if (await pageRequiresUnlock({ requester, pageId: page.id, sessionId: input.sessionId, transaction })) {
    throw new ApplicationError('Unlock this page before rating it.', { status: 403, code: 'PAGE_LOCKED' })
  }
  return { mode, userId }
}

const numericCount = (value: number | string): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Stored page rating count is invalid.')
  return parsed
}

const aggregate = async (
  transaction: Knex.Transaction,
  pageId: number,
  userId: number,
  kind: PageRatingMode
): Promise<PageRatingView> => {
  const rows = (await transaction('pageRatings')
    .where({ pageId, kind })
    .select('value')
    .count({ count: '*' })
    .max({ ownVote: transaction.raw('CASE WHEN ?? = ? THEN ?? END', ['userId', userId, 'value']) })
    .groupBy('value')) as unknown as RatingCountRow[]
  const distribution: Record<string, number> = kind === 'thumbs' ? { '-1': 0, '1': 0 } : { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  let count = 0
  let weightedTotal = 0
  let ownVote: number | null = null
  for (const row of rows) {
    const value = typeof row.value === 'number' ? row.value : Number(row.value)
    const occurrences = numericCount(row.count)
    if (!Object.hasOwn(distribution, String(value)) || !Number.isSafeInteger(value)) throw new Error('Stored page rating value is invalid.')
    distribution[String(value)] = occurrences
    count += occurrences
    weightedTotal += value * occurrences
    if (row.ownVote !== undefined && row.ownVote !== null) {
      const ownValue = typeof row.ownVote === 'number' ? row.ownVote : Number(row.ownVote)
      if (!Number.isSafeInteger(ownValue) || ownValue !== value) throw new Error('Stored page rating value is invalid.')
      ownVote = ownValue
    }
  }
  if (!Number.isSafeInteger(count)) throw new Error('Stored page rating total is invalid.')

  return PageRatingViewSchema.parse({
    kind,
    count,
    score: count === 0 ? null : weightedTotal / count,
    distribution,
    ownVote
  })
}

export const getPageRating = async (input: {
  requester?: PagePrincipal
  pageId: number
  sessionId?: string
}): Promise<PageRatingView> => {
  const pageId = validPageId(input.pageId)
  return wiki.models.knex.transaction(async transaction => {
    await requirePostgresRatingsPolicyLock(transaction)
    const context = await authorize(transaction, {
      requester: input.requester,
      pageId,
      sessionId: input.sessionId ?? '',
      mutation: false
    })
    return aggregate(transaction, pageId, context.userId, context.mode)
  })
}

export const putPageRating = async (input: {
  requester?: PagePrincipal
  pageId: number
  sessionId?: string
  vote: unknown
}): Promise<PageRatingView> => {
  const pageId = validPageId(input.pageId)
  const vote = parseVote(input.vote)
  return wiki.models.knex.transaction(async transaction => {
    await requirePostgresRatingsPolicyLock(transaction)
    const context = await authorize(transaction, {
      requester: input.requester,
      pageId,
      sessionId: input.sessionId ?? '',
      mutation: true
    })
    if (vote.kind !== context.mode) {
      throw new ApplicationError('The page-rating mode changed. Reload before voting.', { status: 409, code: 'PAGE_RATING_MODE_CHANGED' })
    }
    const now = new Date()
    await transaction('pageRatings')
      .insert({ pageId, userId: context.userId, kind: vote.kind, value: vote.value, createdAt: now, updatedAt: now })
      .onConflict(['pageId', 'userId'])
      .merge({ kind: vote.kind, value: vote.value, updatedAt: now })
    return aggregate(transaction, pageId, context.userId, context.mode)
  })
}

export const removePageRating = async (input: {
  requester?: PagePrincipal
  pageId: number
  sessionId?: string
}): Promise<PageRatingView> => {
  const pageId = validPageId(input.pageId)
  return wiki.models.knex.transaction(async transaction => {
    await requirePostgresRatingsPolicyLock(transaction)
    const context = await authorize(transaction, {
      requester: input.requester,
      pageId,
      sessionId: input.sessionId ?? '',
      mutation: true
    })
    await transaction('pageRatings').where({ pageId, userId: context.userId }).delete()
    return aggregate(transaction, pageId, context.userId, context.mode)
  })
}

export default { getPageRating, putPageRating, removePageRating }

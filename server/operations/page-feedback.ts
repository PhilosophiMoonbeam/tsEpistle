import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  FEEDBACK_MAX_BOARDS, FEEDBACK_MAX_IDEAS, FEEDBACK_CURSOR_TTL_MS,
  FeedbackBoardInputSchema, FeedbackCategoryInputSchema, FeedbackSubmitInputSchema, FeedbackVoteInputSchema,
  FeedbackSubscriptionInputSchema, FeedbackTransitionInputSchema, FeedbackSetCategoryInputSchema, FeedbackCreateAdmissionSchema,
  FeedbackMoveInputSchema, FeedbackDeleteInputSchema, normalizeFeedbackQuery, feedbackDefaultStatuses,
  type FeedbackState, type FeedbackBoard, type FeedbackIdea, type FeedbackList, type FeedbackTransitionResult,
  type FeedbackSubmitInput, type FeedbackTransitionInput, type FeedbackCreateAdmissionInput
} from '../../shared/page-feedback.ts'
import { canReadPage, canWritePage, managesSystem, pageAuthorizationContext, principalId, type PageAuthorizationContext, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import { pageRuleRequesterBinding, type PageRuleAuthority } from '../helpers/group-access.ts'
import { authorizePageCreationAccount } from './live-notes.ts'
import { pageRequiresUnlock } from './page-protection.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { writeOutboxEvent, type OutboxEventInput } from '../core/outbox.ts'
import { loadDiscussionNotificationAccess } from '../jobs/notification-access.ts'
import { snapshotFeedbackNotificationAudience } from '../jobs/governed-notifications.ts'
import errors from './errors.ts'
import { postFeedbackDiscussionInTransaction } from './comments.ts'

const { ApplicationError } = errors
const BOARD_LOCK = 72401677
const ACCOUNT_LOCK = 72401678
const DAY = 86400000
export interface FeedbackContextInput { requester: PagePrincipal; sessionId: string; ip?: string }
interface BoardRow { id: string; boardPageId: number; name: string; enabled: boolean; boardRevision: string }
interface IdeaRow {
  id: string; boardId: string; pageId: number; submittedBy: number | null; state: FeedbackState; previousState: FeedbackState | null;
  ideaRevision: string; categoryId: string | null; categoryLabel: string | null; submittedAt: Date | string;
  withdrawnAt: Date | string | null; moderatorWithdrawal: boolean
}
interface PageRow extends PageVisibilityRecord {
  id: number; title: string; sourceRevision: string; isPublished: boolean; publishStartDate: string | null; publishEndDate: string | null
}
interface VoteScoreRow { ideaId: string; voteCount: string | number; trendingCount: string | number; voted: boolean; updatedAt: Date | string }
interface Context { requester: PagePrincipal; authority: PageRuleAuthority; humanId: number | null; sessionId: string; now: Date; background: boolean }
export interface FeedbackDependencies {
  db: Knex
  secret: string
  loadAuthority(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority>
  checkManage(requester: PagePrincipal, page: PageRow, authority: PageRuleAuthority): boolean
  postComment(tx: Knex.Transaction, input: FeedbackContextInput & { pageId: number; draft: NonNullable<FeedbackTransitionInput['comment']>; rootTransitionEventId: string }): Promise<number>
  now?: () => Date
}
export interface FeedbackIdeaDetail {
  idea: FeedbackIdea
  history: Array<{ id: string; kind: string; fromState: FeedbackState | null; toState: FeedbackState | null; explanation: string | null; categoryLabel: string | null; createdAt: string }>
}
export interface FeedbackNotificationContext {
  boardId: string; ideaId: string; pageId: number; title: string; path: string; locale: string;
  visibility: 'public' | 'private'; submittedBy: number | null; subscriberIds: number[]
}
export interface FeedbackNotificationInput { requester: PagePrincipal; sessionId: string | null; boardId: string; ideaId: string }
export interface PageFeedbackOperations {
  listFeedbackBoards(input: FeedbackContextInput): Promise<FeedbackBoard[]>
  getFeedbackBoard(input: FeedbackContextInput & { boardId: string }): Promise<FeedbackBoard>
  getFeedbackIdea(input: FeedbackContextInput & { boardId: string; ideaId: string }): Promise<FeedbackIdeaDetail>
  listFeedbackIdeas(input: FeedbackContextInput & { boardId: string; query?: unknown }): Promise<FeedbackList>
  suggestFeedbackDuplicates(input: FeedbackContextInput & { boardId: string; q: string }): Promise<FeedbackIdea[]>
  prepareFeedbackSubmission(tx: Knex.Transaction, input: FeedbackContextInput & FeedbackCreateAdmissionInput): Promise<void>
  admitCreatedFeedbackIdea(tx: Knex.Transaction, input: FeedbackContextInput & FeedbackSubmitInput): Promise<{ ideaId: string; ideaRevision: string }>
  submitExistingFeedbackIdea(input: FeedbackContextInput & FeedbackSubmitInput): Promise<{ ideaId: string; ideaRevision: string }>
  setFeedbackVote(input: FeedbackContextInput & z.infer<typeof FeedbackVoteInputSchema>): Promise<{ voted: boolean; ideaRevision: string }>
  setFeedbackSubscription(input: FeedbackContextInput & z.infer<typeof FeedbackSubscriptionInputSchema>): Promise<{ subscribed: boolean }>
  transitionFeedbackIdea(input: FeedbackContextInput & FeedbackTransitionInput): Promise<FeedbackTransitionResult>
  getFeedbackRequestReceipt(input: FeedbackContextInput & { boardId: string; ideaId: string; requestId: string }): Promise<FeedbackTransitionResult | null>
  setFeedbackCategory(input: FeedbackContextInput & z.infer<typeof FeedbackSetCategoryInputSchema>): Promise<{ ideaRevision: string }>
  configureFeedbackBoard(input: FeedbackContextInput & z.infer<typeof FeedbackBoardInputSchema>): Promise<FeedbackBoard>
  configureFeedbackCategory(input: FeedbackContextInput & z.infer<typeof FeedbackCategoryInputSchema>): Promise<{ categoryId: string; boardRevision: string }>
  moveFeedbackIdea(input: FeedbackContextInput & z.infer<typeof FeedbackMoveInputSchema>): Promise<{ ideaId: string; boardId: string; ideaRevision: string }>
  deleteFeedbackMetadata(input: FeedbackContextInput & z.infer<typeof FeedbackDeleteInputSchema>): Promise<{ deleted: true }>
  feedbackNotificationContext(tx: Knex.Transaction, input: FeedbackNotificationInput): Promise<FeedbackNotificationContext | null>
}
function fail(message: string, status = 400, code = 'FEEDBACK_INVALID'): never { throw new ApplicationError(message, { status, code }) }
const missing = (): never => fail('This feedback board or idea is unavailable.', 404, 'FEEDBACK_NOT_FOUND')
const conflict = (): never => fail('The page or feedback changed. Reload before trying again.', 409, 'FEEDBACK_CONFLICT')
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const value = schema.safeParse(input)
  return value.success ? value.data : fail('Invalid feedback request.')
}
const dataOnly = (input: FeedbackContextInput & object): Record<string, unknown> => {
  const { requester: _requester, sessionId: _sessionId, ip: _ip, ...data } = input
  return data
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nextRevision = (value: string): string => String(BigInt(value) + 1n)
const iso = (value: Date | string): string => new Date(value).toISOString()
const lexical = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const idSchema = z.string().uuid()

export const createPageFeedbackStore = (deps: FeedbackDependencies): PageFeedbackOperations => {
  if (typeof deps.secret !== 'string' || deps.secret.length === 0) fail('Feedback cursor signing is unavailable.', 503, 'FEEDBACK_UNAVAILABLE')
  const context = async (tx: Knex.Transaction, input: FeedbackContextInput, mutation = false, background = false): Promise<Context> => {
    let requester = input.requester, humanId: number | null = null
    if (requester && requester.id !== 2 && principalId(requester) !== null && !('api' in requester) && !('grp' in requester)) {
      if (!input.sessionId && !background) fail('A current human browser account is required.', 401, 'AUTH_REQUIRED')
      const current = await authorizePageCreationAccount(tx, requester)
      requester = current
      if (Reflect.get(current, 'isSystem') === false && Reflect.get(current, 'email') !== 'api@localhost') humanId = current.id
    } else {
      await tx('groups').orderBy('id').forShare().select('id')
      // Anonymous/guest browsing does not make a guest an enrolled human.
    }
    if (mutation && humanId === null) fail('A current human browser account is required.', 401, 'AUTH_REQUIRED')
    return { requester, humanId, authority: await deps.loadAuthority(requester, tx), sessionId: input.sessionId, now: deps.now?.() ?? new Date(), background }
  }
  const pages = async (tx: Knex.Transaction, ids: number[], lock = false): Promise<Map<number, PageRow>> => {
    if (!ids.length) return new Map()
    const query = tx<PageRow>('pages').whereIn('id', [...new Set(ids)]).orderBy('id')
      .select('id', 'title', 'sourceRevision', 'path', 'localeCode', 'visibility', 'ownerId', 'isPublished', 'publishStartDate', 'publishEndDate')
    // Native comment/lifecycle producers need the page update fence too; never upgrade it after locking a board.
    const rows = await (lock ? query.forUpdate() : query)
    const tags = await tx('pageTags').join('tags', 'tags.id', 'pageTags.tagId').whereIn('pageTags.pageId', ids).select('pageTags.pageId', 'tags.tag')
    const tagsByPage = new Map<number, Array<{ tag: string }>>()
    for (const tag of tags) {
      const assigned = tagsByPage.get(tag.pageId) ?? []
      assigned.push({ tag: tag.tag }); tagsByPage.set(tag.pageId, assigned)
    }
    return new Map(rows.map(page => [page.id, { ...page, sourceRevision: String(page.sourceRevision), tags: tagsByPage.get(page.id) ?? [] }]))
  }
  const readable = async (tx: Knex.Transaction, ctx: Context, page: PageRow | undefined): Promise<boolean> => {
    if (!page || !canReadPage(ctx.requester, page, ctx.authority)) return false
    if ((!page.isPublished || !publicationWindowOpen(page, ctx.now.valueOf())) && !canWritePage(ctx.requester, page, ctx.authority)) return false
    if (ctx.background) {
      const access = await loadDiscussionNotificationAccess(tx, [page.id], [], ctx.requester, null)
      return !access.protectedPageIds.has(page.id) || access.unlockedPageIds.has(page.id) || managesSystem(ctx.requester)
    }
    return !(await pageRequiresUnlock({ requester: ctx.requester, pageId: page.id, sessionId: ctx.sessionId, transaction: tx, now: ctx.now, readOnly: true }))
  }
  const manages = (ctx: Context, page: PageRow): boolean => ctx.humanId !== null && deps.checkManage(ctx.requester, page, ctx.authority)
  const loadBoard = async (tx: Knex.Transaction, ctx: Context, boardId: string, lock = false, allowDisabled = false) => {
    parse(idSchema, boardId)
    const initial = await tx<BoardRow>('feedbackBoards').where({ id: boardId }).first()
    if (!initial) return missing()
    const anchor = (await pages(tx, [initial.boardPageId], lock)).get(initial.boardPageId)
    const query = tx<BoardRow>('feedbackBoards').where({ id: boardId })
    const board = await (lock ? query.forUpdate() : query).first()
    if (!board || !anchor || board.boardPageId !== initial.boardPageId || !(await readable(tx, ctx, anchor))) return missing()
    board.boardRevision = String(board.boardRevision)
    if (!board.enabled && (!allowDisabled || !manages(ctx, anchor))) return missing()
    return { board, anchor }
  }
  const loadIdea = async (tx: Knex.Transaction, ctx: Context, boardId: string, ideaId: string, lock = false) => {
    parse(idSchema, ideaId)
    parse(idSchema, boardId)
    // Discover ids without granting authority; acquire page locks before board/idea locks.
    const initial = await tx<IdeaRow>('feedbackIdeas').where({ id: ideaId, boardId }).first()
    const initialBoard = await tx<BoardRow>('feedbackBoards').where({ id: boardId }).first()
    if (!initial || !initialBoard) return missing()
    const loaded = await pages(tx, [initial.pageId, initialBoard.boardPageId], lock)
    const { board, anchor } = await loadBoard(tx, ctx, boardId, lock, true)
    const query = tx<IdeaRow>('feedbackIdeas').where({ id: ideaId, boardId })
    const idea = await (lock ? query.forUpdate() : query).first()
    const page = loaded.get(initial.pageId)
    if (!idea || !page || idea.pageId !== page.id || !(await readable(tx, ctx, page))) return missing()
    idea.ideaRevision = String(idea.ideaRevision)
    const moderator = manages(ctx, anchor) && manages(ctx, page)
    const author = ctx.humanId !== null && idea.submittedBy === ctx.humanId
    if (idea.state === 'withdrawn' && !moderator && !author) return missing()
    return { board, anchor, idea, page, moderator, author }
  }
  const revisions = (current: { board: BoardRow; idea: IdeaRow; page: PageRow }, input: { expectedBoardRevision?: string; expectedIdeaRevision?: string; expectedSourceRevision?: string }) => {
    if ((input.expectedBoardRevision !== undefined && current.board.boardRevision !== input.expectedBoardRevision) ||
      (input.expectedIdeaRevision !== undefined && current.idea.ideaRevision !== input.expectedIdeaRevision) ||
      (input.expectedSourceRevision !== undefined && current.page.sourceRevision !== input.expectedSourceRevision)) conflict()
  }
  const rate = async (tx: Knex.Transaction, ctx: Context) => {
    await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [ACCOUNT_LOCK, ctx.humanId!])
    const recent = await tx('feedbackWriteAdmissions').where('actorId', ctx.humanId!).where('createdAt', '>', new Date(ctx.now.valueOf() - 60000)).orderBy('createdAt').select('createdAt')
    if (recent.length >= 60) throw Object.assign(new ApplicationError('Too many feedback changes. Try again shortly.', { status: 429, code: 'FEEDBACK_RATE_LIMIT' }), { retryAfterMilliseconds: Math.max(1, new Date(recent[0]!.createdAt).valueOf() + 60000 - ctx.now.valueOf()) })
    await tx('feedbackWriteAdmissions').insert({ id: randomUUID(), actorId: ctx.humanId, createdAt: ctx.now })
  }
  const audit = async (tx: Knex.Transaction, ctx: Context, input: { boardId: string; ideaId?: string; kind: string; fromState?: string; toState?: string; explanation?: string; categoryLabel?: string | null; details?: Record<string, unknown>; id?: string }) => {
    const id = input.id ?? randomUUID()
    await tx('feedbackTransitions').insert({ ...input, id, actorId: ctx.humanId, details: JSON.stringify(input.details ?? {}), createdAt: ctx.now })
    return id
  }
  const boardView = async (tx: Knex.Transaction, ctx: Context, board: BoardRow, anchor: PageRow): Promise<FeedbackBoard> => ({
    id: board.id, boardPageId: board.boardPageId, name: board.name, enabled: board.enabled, boardRevision: String(board.boardRevision),
    canManage: manages(ctx, anchor), canSubmit: board.enabled && ctx.humanId !== null,
    categories: await tx('feedbackCategories').where({ boardId: board.id }).orderBy('displayOrder').orderBy('id').select('id', 'label', 'active', 'displayOrder')
  })
  const listFeedbackBoards = (input: FeedbackContextInput): Promise<FeedbackBoard[]> => deps.db.transaction(async tx => {
    const ctx = await context(tx, input), rows = await tx<BoardRow>('feedbackBoards').where({ enabled: true }).orderBy('id').limit(FEEDBACK_MAX_BOARDS + 1)
    if (rows.length > FEEDBACK_MAX_BOARDS) fail('The enabled board bound was exceeded.', 409)
    const loaded = await pages(tx, rows.map(row => row.boardPageId)), results: FeedbackBoard[] = []
    for (const board of rows) { const anchor = loaded.get(board.boardPageId); if (anchor && await readable(tx, ctx, anchor)) results.push(await boardView(tx, ctx, board, anchor)) }
    return results
  })
  const getFeedbackBoard = (input: FeedbackContextInput & { boardId: string }): Promise<FeedbackBoard> => deps.db.transaction(async tx => {
    const ctx = await context(tx, input), { board, anchor } = await loadBoard(tx, ctx, input.boardId, false, true)
    return boardView(tx, ctx, board, anchor)
  })
  const discover = async (tx: Knex.Transaction, ctx: Context, boardId: string, asOf: number, allowDisabled = false) => {
    const { board, anchor } = await loadBoard(tx, ctx, boardId, false, allowDisabled), rows = await tx<IdeaRow>('feedbackIdeas').where({ boardId }).limit(FEEDBACK_MAX_IDEAS + 1)
    if (rows.length > FEEDBACK_MAX_IDEAS) fail('The board membership bound was exceeded.', 409)
    const loaded = await pages(tx, rows.map(row => row.pageId)), admitted: Array<{ idea: IdeaRow; page: PageRow; moderator: boolean; author: boolean }> = []
    for (const idea of rows) {
      const page = loaded.get(idea.pageId)
      if (!page || !(await readable(tx, ctx, page))) continue
      const moderator = manages(ctx, anchor) && manages(ctx, page), author = ctx.humanId !== null && idea.submittedBy === ctx.humanId
      if (idea.state === 'withdrawn' && !moderator && !author) continue
      admitted.push({ idea, page, moderator, author })
    }
    const ids = admitted.map(row => row.idea.id)
    const ballots = ids.length ? await tx('feedbackVotes as vote').join('users as voter', 'voter.id', 'vote.userId').whereIn('vote.ideaId', ids)
      .where({ 'vote.voted': true, 'voter.isActive': true, 'voter.isSystem': false }).whereNot('voter.id', 2).whereNot('voter.email', 'api@localhost')
      .groupBy('vote.ideaId').select('vote.ideaId').count('* as voteCount')
      .select(tx.raw('count(*) FILTER (WHERE ?? >= ? AND ?? <= ?) AS ??', ['vote.activatedAt', new Date(asOf - 7 * DAY), 'vote.activatedAt', new Date(asOf), 'trendingCount']))
      .select(tx.raw('bool_or(?? = ?) AS ??', ['vote.userId', ctx.humanId ?? 0, 'voted'])).max('vote.updatedAt as updatedAt') as unknown as VoteScoreRow[] : []
    const votesByIdea = new Map(ballots.map(row => [String(row.ideaId), row]))
    const subscriptions = ctx.humanId !== null && ids.length ? await tx('feedbackSubscriptions').whereIn('ideaId', ids).where('userId', ctx.humanId).select('ideaId') : []
    const subscribedIds = new Set(subscriptions.map(row => String(row.ideaId)))
    const categories = await tx('feedbackCategories').where({ boardId }).select('id', 'label', 'active')
    const categoriesById = new Map(categories.map(row => [String(row.id), row]))
    const items: FeedbackIdea[] = admitted.map(({ idea, page, moderator, author }) => {
      const votes = votesByIdea.get(idea.id), category = idea.categoryId ? categoriesById.get(idea.categoryId) : undefined
      return {
        id: idea.id, boardId, pageId: page.id, title: page.title, path: page.path, locale: page.localeCode!, visibility: page.visibility,
        state: idea.state, ideaRevision: String(idea.ideaRevision), sourceRevision: String(page.sourceRevision),
        categoryId: category?.active ? category.id : null,
        categoryLabel: category?.active ? category.label : moderator && (category?.label ?? idea.categoryLabel) ? `Removed category: ${category?.label ?? idea.categoryLabel}` : null,
        submittedAt: iso(idea.submittedAt), withdrawnAt: idea.withdrawnAt ? iso(idea.withdrawnAt) : null,
        voteCount: idea.state === 'withdrawn' ? 0 : Number(votes?.voteCount ?? 0),
        trendingCount: idea.state === 'withdrawn' ? 0 : Number(votes?.trendingCount ?? 0),
        voted: votes?.voted === true, subscribed: subscribedIds.has(idea.id),
        canModerate: moderator, canWithdraw: idea.state !== 'withdrawn' && (author || moderator),
        canRestore: idea.state === 'withdrawn' && (moderator || (author && !idea.moderatorWithdrawal && idea.withdrawnAt !== null && ctx.now.valueOf() - new Date(idea.withdrawnAt).valueOf() <= 30 * DAY)),
        canEditSource: ctx.humanId !== null && canWritePage(ctx.requester, page, ctx.authority)
      }
    })
    // Current authorization and visible scores are bound into every continuation; never promise a historical ACL snapshot.
    const generation = hash({ authority: { permissions: ctx.authority.permissions, groups: ctx.authority.groups, tagAliases: ctx.authority.tagAliases }, authVersion: ctx.requester && Reflect.get(ctx.requester, 'authVersion'), requester: pageRuleRequesterBinding(ctx.requester), sessionId: ctx.sessionId, board, ballots: [...ballots].sort((a, b) => String(a.ideaId).localeCompare(String(b.ideaId))), items: [...items].sort((a, b) => a.id.localeCompare(b.id)) })
    return { board: await boardView(tx, ctx, board, anchor), items, generation }
  }
  const sign = (payload: string): Buffer => createHmac('sha256', deps.secret).update(`feedback:v1:${payload}`).digest()
  const encodeCursor = (value: object): string => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body).toString('base64url')}` }
  const decodeCursor = (value: string): { boardId: string; query: string; generation: string; requester: string; asOf: number; offset: number } => {
    try {
      const [body, signature, extra] = value.split('.'); if (!body || !signature || extra) return fail('Invalid feedback cursor.')
      const expected = sign(body), actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail('Invalid feedback cursor.')
      return parse(z.strictObject({ boardId: idSchema, query: z.string(), generation: z.string(), requester: z.string(), asOf: z.number().int(), offset: z.number().int().min(0).max(FEEDBACK_MAX_IDEAS) }), JSON.parse(Buffer.from(body, 'base64url').toString()))
    } catch { return fail('Invalid feedback cursor.') }
  }
  const listFeedbackIdeas = (input: FeedbackContextInput & { boardId: string; query?: unknown }): Promise<FeedbackList> => deps.db.transaction(async tx => {
    const ctx = await context(tx, input), query = normalizeFeedbackQuery(input.query ?? {}), binding = hash({ ...query, cursor: undefined }), requester = hash({ requester: pageRuleRequesterBinding(ctx.requester), session: ctx.sessionId })
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined, asOf = cursor?.asOf ?? ctx.now.valueOf()
    if (cursor && (cursor.boardId !== input.boardId || cursor.query !== binding || cursor.requester !== requester || asOf > ctx.now.valueOf() || ctx.now.valueOf() - asOf >= FEEDBACK_CURSOR_TTL_MS)) conflict()
    const current = await discover(tx, ctx, input.boardId, asOf)
    if (cursor && cursor.generation !== current.generation) conflict()
    const statuses = query.statuses ?? feedbackDefaultStatuses(query.sort), terms = lexical(query.q ?? '').split(' ').filter(Boolean)
    const publicItems = current.items.filter(item => item.state !== 'withdrawn')
    const facets: FeedbackList['facets'] = { statuses: {}, categories: {} }
    for (const item of publicItems) { facets.statuses[item.state] = (facets.statuses[item.state] ?? 0) + 1; const key = item.categoryId ?? 'uncategorized'; facets.categories[key] = (facets.categories[key] ?? 0) + 1 }
    const matches = current.items.filter(item => statuses.includes(item.state) && (!query.categoryIds || (item.categoryId !== null && query.categoryIds.includes(item.categoryId))) && terms.every(term => lexical(item.title).includes(term)))
    matches.sort((a, b) => (query.sort === 'trending' ? b.trendingCount - a.trendingCount : 0) || (query.sort !== 'newest' ? b.voteCount - a.voteCount : 0) || b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id))
    const offset = cursor?.offset ?? 0, items = matches.slice(offset, offset + query.limit), nextOffset = offset + items.length
    return { schemaVersion: 1, board: current.board, query, asOf: new Date(asOf).toISOString(), items, total: matches.length, permittedTotal: publicItems.length, facets,
      nextCursor: nextOffset < matches.length ? encodeCursor({ boardId: input.boardId, query: binding, generation: current.generation, requester, asOf, offset: nextOffset }) : null,
      state: publicItems.length === 0 && items.length === 0 ? 'empty' : matches.length === 0 ? 'no-matches' : 'ready' }
  }, { isolationLevel: 'repeatable read' })
  const suggestFeedbackDuplicates = (input: FeedbackContextInput & { boardId: string; q: string }): Promise<FeedbackIdea[]> => deps.db.transaction(async tx => {
    const q = parse(z.string().trim().max(200), input.q), ctx = await context(tx, input), tokens = lexical(q).split(' ').filter(Boolean)
    if (!tokens.length) { await loadBoard(tx, ctx, input.boardId); return [] }
    const { items } = await discover(tx, ctx, input.boardId, ctx.now.valueOf())
    return items.filter(item => item.state !== 'withdrawn').map(item => ({ item, score: tokens.filter(token => lexical(item.title).includes(token)).length }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, 5).map(row => row.item)
  })
  /** Acquire only actor authority/mutex before native asset/search/page creation fences. */
  const prepareFeedbackSubmission = async (tx: Knex.Transaction, input: FeedbackContextInput & FeedbackCreateAdmissionInput): Promise<void> => {
    const command = parse(FeedbackCreateAdmissionSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [ACCOUNT_LOCK, ctx.humanId!])
    // Do not retain anchor/board row locks ahead of native producer lock ordering.
    // Admission repeats current read/unlock/revision/cap checks after creation in this same transaction.
    const { board } = await loadBoard(tx, ctx, command.boardId)
    if (board.boardRevision !== command.expectedBoardRevision) conflict()
  }
  const admitCreatedFeedbackIdea = async (tx: Knex.Transaction, input: FeedbackContextInput & FeedbackSubmitInput): Promise<{ ideaId: string; ideaRevision: string }> => {
    const command = parse(FeedbackSubmitInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [ACCOUNT_LOCK, ctx.humanId!])
    const initialBoard = await tx<BoardRow>('feedbackBoards').where({ id: command.boardId }).first()
    if (!initialBoard) return missing()
    const loaded = await pages(tx, [command.pageId, initialBoard.boardPageId], true)
    const { board } = await loadBoard(tx, ctx, command.boardId, true), page = loaded.get(command.pageId)
    if (!page || !(await readable(tx, ctx, page))) return missing()
    if (!canWritePage(ctx.requester, page, ctx.authority)) fail('Current source write authority is required to submit this page.', 403)
    if (board.boardRevision !== command.expectedBoardRevision || page.sourceRevision !== command.expectedSourceRevision) conflict()
    if (await tx('feedbackIdeas').where({ pageId: page.id }).first('id')) fail('This page is already explicitly attached to a board.', 409, 'FEEDBACK_ALREADY_ATTACHED')
    const count = await tx('feedbackIdeas').where({ boardId: board.id }).count<{ count: string }[]>('* as count')
    if (Number(count[0]!.count) >= FEEDBACK_MAX_IDEAS) fail('This board has reached its explicit membership limit.', 409, 'FEEDBACK_BOARD_FULL')
    const admissions = await tx('feedbackAdmissions').where({ boardId: board.id, actorId: ctx.humanId! }).where('createdAt', '>', new Date(ctx.now.valueOf() - DAY)).orderBy('createdAt').select('createdAt')
    if (admissions.length >= 10) throw Object.assign(new ApplicationError('The rolling 24-hour submission limit has been reached.', { status: 429, code: 'FEEDBACK_SUBMISSION_LIMIT' }), { retryAfterMilliseconds: Math.max(1, new Date(admissions[0]!.createdAt).valueOf() + DAY - ctx.now.valueOf()) })
    const ideaId = randomUUID()
    await tx('feedbackIdeas').insert({ id: ideaId, boardId: board.id, pageId: page.id, submittedBy: ctx.humanId, state: 'proposed', ideaRevision: '1', submittedAt: ctx.now, createdAt: ctx.now, updatedAt: ctx.now })
    await tx('feedbackAdmissions').insert({ id: randomUUID(), boardId: board.id, actorId: ctx.humanId, createdAt: ctx.now })
    await audit(tx, ctx, { boardId: board.id, ideaId, kind: 'submitted', toState: 'proposed', details: { sourceRevision: page.sourceRevision } })
    return { ideaId, ideaRevision: '1' }
  }
  const submitExistingFeedbackIdea = (input: FeedbackContextInput & FeedbackSubmitInput) => deps.db.transaction(tx => admitCreatedFeedbackIdea(tx, input))
  const setFeedbackVote = (input: FeedbackContextInput & z.infer<typeof FeedbackVoteInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackVoteInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await rate(tx, ctx)
    const current = await loadIdea(tx, ctx, command.boardId, command.ideaId, true)
    revisions(current, command)
    const existing = await tx('feedbackVotes').where({ ideaId: command.ideaId, userId: ctx.humanId! }).first()
    if (Boolean(existing?.voted) === command.voted) return { voted: command.voted, ideaRevision: current.idea.ideaRevision }
    if (command.voted && (current.idea.state === 'closed' || current.idea.state === 'withdrawn')) fail('New priority votes are not allowed on this state.', 409, 'FEEDBACK_VOTING_CLOSED')
    const ballot = { voted: command.voted, activatedAt: command.voted ? ctx.now : existing?.activatedAt ?? null, updatedAt: ctx.now }
    if (existing) await tx('feedbackVotes').where({ ideaId: command.ideaId, userId: ctx.humanId! }).update(ballot)
    else await tx('feedbackVotes').insert({ ideaId: command.ideaId, userId: ctx.humanId, ...ballot })
    // Status/source revision is not changed by a ballot. The idea lock serializes status/vote races.
    return { voted: command.voted, ideaRevision: current.idea.ideaRevision }
  })
  const setFeedbackSubscription = (input: FeedbackContextInput & z.infer<typeof FeedbackSubscriptionInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackSubscriptionInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    const current = await loadIdea(tx, ctx, command.boardId, command.ideaId, true)
    if (!current.board.enabled) return missing()
    if (command.subscribed) await tx('feedbackSubscriptions').insert({ ideaId: command.ideaId, userId: ctx.humanId, createdAt: ctx.now }).onConflict(['ideaId', 'userId']).ignore()
    else await tx('feedbackSubscriptions').where({ ideaId: command.ideaId, userId: ctx.humanId! }).delete()
    return { subscribed: command.subscribed }
  })
  const transitionFeedbackIdea = (input: FeedbackContextInput & FeedbackTransitionInput): Promise<FeedbackTransitionResult> => deps.db.transaction(async tx => {
    const command = parse(FeedbackTransitionInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await rate(tx, ctx)
    await tx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [BOARD_LOCK, command.requestId])
    const current = await loadIdea(tx, ctx, command.boardId, command.ideaId, true)
    const prior = await tx('feedbackRequestReceipts').where({ requestId: command.requestId }).first()
    const commandHash = hash(command)
    if (prior) {
      if (prior.actorId !== ctx.humanId || prior.commandHash !== commandHash) conflict()
      return (typeof prior.result === 'string' ? JSON.parse(prior.result) : prior.result) as FeedbackTransitionResult
    }
    revisions(current, command)
    const { idea, moderator, author } = current, restore = idea.state === 'withdrawn' && command.targetState === 'proposed'
    if (idea.state === command.targetState) fail('Choose a different feedback state.', 409)
    if (command.targetState === 'withdrawn') {
      if (!moderator && !author) fail('Only the current submitter or a current moderator may withdraw this idea.', 403)
    } else if (restore) {
      const withinWindow = idea.withdrawnAt !== null && ctx.now.valueOf() - new Date(idea.withdrawnAt).valueOf() <= 30 * DAY
      if (!moderator && (!author || idea.moderatorWithdrawal || !withinWindow)) fail('A current moderator must restore this idea.', 403)
    } else if (!moderator || idea.state === 'withdrawn') fail('A current moderator is required for this transition.', 403)
    const ideaRevision = nextRevision(idea.ideaRevision), rootTransitionEventId = randomUUID()
    await tx('feedbackIdeas').where({ id: idea.id }).update({
      state: command.targetState, ideaRevision, previousState: command.targetState === 'withdrawn' ? idea.state : idea.previousState,
      withdrawnAt: command.targetState === 'withdrawn' ? ctx.now : null,
      moderatorWithdrawal: command.targetState === 'withdrawn' ? moderator : false, updatedAt: ctx.now
    })
    const commentId = command.comment ? await deps.postComment(tx, { requester: ctx.requester, sessionId: ctx.sessionId, ...(input.ip === undefined ? {} : { ip: input.ip }), pageId: current.page.id, draft: command.comment, rootTransitionEventId }) : null
    await audit(tx, ctx, { id: rootTransitionEventId, boardId: current.board.id, ideaId: idea.id, kind: 'status', fromState: idea.state, toState: command.targetState, explanation: command.explanation, categoryLabel: idea.categoryLabel, details: { sourceRevision: current.page.sourceRevision, ideaRevision, commentId } })
    const rootEvent: OutboxEventInput & { id: string; createdAt: Date } = {
      id: rootTransitionEventId, type: 'feedback.status-changed', version: 1, aggregateType: 'feedback-idea', aggregateId: idea.id, createdAt: ctx.now,
      payload: { boardId: current.board.id, ideaId: idea.id, pageId: current.page.id, actorId: ctx.humanId, rootTransitionEventId, commentId }
    }
    const recipientChannels = await snapshotFeedbackNotificationAudience(tx, rootEvent)
    await writeOutboxEvent(tx, { ...rootEvent, payload: { ...rootEvent.payload, recipientChannels } })
    const result: FeedbackTransitionResult = { requestId: command.requestId, boardId: current.board.id, ideaId: idea.id, ideaRevision, state: command.targetState, rootTransitionEventId, commentId }
    await tx('feedbackRequestReceipts').insert({ requestId: command.requestId, actorId: ctx.humanId, boardId: current.board.id, ideaId: idea.id, commandHash, result: JSON.stringify(result), createdAt: ctx.now })
    return result
  })
  const getFeedbackRequestReceipt = (input: FeedbackContextInput & { boardId: string; ideaId: string; requestId: string }): Promise<FeedbackTransitionResult | null> => deps.db.transaction(async tx => {
    parse(idSchema, input.requestId)
    const ctx = await context(tx, input, true)
    await loadIdea(tx, ctx, input.boardId, input.ideaId)
    const receipt = await tx('feedbackRequestReceipts').where({ requestId: input.requestId, boardId: input.boardId, ideaId: input.ideaId, actorId: ctx.humanId! }).first('result')
    return receipt ? (typeof receipt.result === 'string' ? JSON.parse(receipt.result) : receipt.result) as FeedbackTransitionResult : null
  })
  const setFeedbackCategory = (input: FeedbackContextInput & z.infer<typeof FeedbackSetCategoryInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackSetCategoryInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await rate(tx, ctx)
    const current = await loadIdea(tx, ctx, command.boardId, command.ideaId, true)
    if (!current.moderator) fail('Current moderation authority is required on both pages.', 403)
    revisions(current, command)
    const category = command.categoryId === null ? null : await tx('feedbackCategories').where({ id: command.categoryId, boardId: command.boardId, active: true }).first()
    if (command.categoryId !== null && !category) fail('Choose an active category belonging to this board.')
    if (current.idea.categoryId === command.categoryId) return { ideaRevision: current.idea.ideaRevision }
    const ideaRevision = nextRevision(current.idea.ideaRevision)
    await tx('feedbackIdeas').where({ id: current.idea.id }).update({ categoryId: command.categoryId, categoryLabel: category?.label ?? null, ideaRevision, updatedAt: ctx.now })
    await audit(tx, ctx, { boardId: command.boardId, ideaId: command.ideaId, kind: 'category', categoryLabel: category?.label ?? null, details: { previousCategoryLabel: current.idea.categoryLabel } })
    return { ideaRevision }
  })
  const configureFeedbackBoard = (input: FeedbackContextInput & z.infer<typeof FeedbackBoardInputSchema>): Promise<FeedbackBoard> => deps.db.transaction(async tx => {
    const command = parse(FeedbackBoardInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await tx.raw('SELECT pg_advisory_xact_lock(?)', [BOARD_LOCK])
    const anchor = (await pages(tx, [command.boardPageId], true)).get(command.boardPageId)
    if (!anchor || !(await readable(tx, ctx, anchor))) return missing()
    if (!manages(ctx, anchor)) fail('Current native page-management authority is required on the board anchor.', 403)
    const existing = command.boardId ? await tx<BoardRow>('feedbackBoards').where({ id: command.boardId }).forUpdate().first() : undefined
    if (command.boardId && !existing) return missing()
    if (existing && (existing.boardPageId !== command.boardPageId || String(existing.boardRevision) !== command.expectedBoardRevision)) conflict()
    if (!existing && command.expectedBoardRevision !== undefined) conflict()
    if (command.enabled && !existing?.enabled) {
      const count = await tx('feedbackBoards').where({ enabled: true }).count<{ count: string }[]>('* as count')
      if (Number(count[0]!.count) >= FEEDBACK_MAX_BOARDS) fail('The site has reached its enabled-board limit.', 409)
    }
    if (!existing && await tx('feedbackBoards').where({ boardPageId: command.boardPageId }).first('id')) fail('This anchor already has an explicitly configured board.', 409)
    const board: BoardRow = { id: existing?.id ?? randomUUID(), boardPageId: command.boardPageId, name: command.name, enabled: command.enabled, boardRevision: existing ? nextRevision(String(existing.boardRevision)) : '1' }
    if (existing) await tx('feedbackBoards').where({ id: board.id }).update({ name: board.name, enabled: board.enabled, boardRevision: board.boardRevision, updatedAt: ctx.now })
    else await tx('feedbackBoards').insert({ ...board, createdAt: ctx.now, updatedAt: ctx.now })
    await audit(tx, ctx, { boardId: board.id, kind: existing ? 'board-configured' : 'board-created', details: { enabled: board.enabled, name: board.name } })
    return boardView(tx, ctx, board, anchor)
  })
  const configureFeedbackCategory = (input: FeedbackContextInput & z.infer<typeof FeedbackCategoryInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackCategoryInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    await rate(tx, ctx)
    const { board, anchor } = await loadBoard(tx, ctx, command.boardId, true, true)
    if (!manages(ctx, anchor)) fail('Current board moderation authority is required.', 403)
    if (board.boardRevision !== command.expectedBoardRevision) conflict()
    const existing = command.categoryId ? await tx('feedbackCategories').where({ id: command.categoryId, boardId: command.boardId }).first() : undefined
    if (command.categoryId && !existing) return missing()
    const categoryId = existing?.id ?? randomUUID(), boardRevision = nextRevision(board.boardRevision)
    const category = { label: command.label, active: command.active, displayOrder: command.displayOrder, updatedAt: ctx.now }
    if (existing) await tx('feedbackCategories').where({ id: categoryId }).update(category)
    else await tx('feedbackCategories').insert({ id: categoryId, boardId: board.id, ...category, createdAt: ctx.now })
    await tx('feedbackBoards').where({ id: board.id }).update({ boardRevision, updatedAt: ctx.now })
    await audit(tx, ctx, { boardId: board.id, kind: 'category-configured', categoryLabel: command.label, details: { categoryId, previousLabel: existing?.label ?? null, active: command.active } })
    return { categoryId, boardRevision }
  })
  const moveFeedbackIdea = (input: FeedbackContextInput & z.infer<typeof FeedbackMoveInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackMoveInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    if (command.boardId === command.destinationBoardId) fail('Choose a different destination board.')
    await rate(tx, ctx)
    const ideaBefore = await tx<IdeaRow>('feedbackIdeas').where({ id: command.ideaId, boardId: command.boardId }).first()
    const boardsBefore = await tx<BoardRow>('feedbackBoards').whereIn('id', [command.boardId, command.destinationBoardId]).orderBy('id')
    if (!ideaBefore || boardsBefore.length !== 2) return missing()
    const loaded = await pages(tx, [ideaBefore.pageId, ...boardsBefore.map(board => board.boardPageId)], true)
    const boards = await tx<BoardRow>('feedbackBoards').whereIn('id', [command.boardId, command.destinationBoardId]).orderBy('id').forUpdate()
    const source = boards.find(board => board.id === command.boardId), destination = boards.find(board => board.id === command.destinationBoardId)
    const idea = await tx<IdeaRow>('feedbackIdeas').where({ id: command.ideaId, boardId: command.boardId }).forUpdate().first()
    const page = loaded.get(ideaBefore.pageId)
    if (!source || !destination || !idea || !page || !destination.enabled || boards.some(board => !loaded.has(board.boardPageId))) return missing()
    for (const candidate of [page, ...boards.map(board => loaded.get(board.boardPageId)!)]) {
      if (!(await readable(tx, ctx, candidate))) return missing()
      if (!manages(ctx, candidate)) fail('Current page-management authority is required on the idea and both anchors.', 403)
    }
    source.boardRevision = String(source.boardRevision); idea.ideaRevision = String(idea.ideaRevision)
    revisions({ board: source, idea, page }, command)
    if (String(destination.boardRevision) !== command.expectedDestinationBoardRevision) conflict()
    const count = await tx('feedbackIdeas').where({ boardId: destination.id }).count<{ count: string }[]>('* as count')
    if (Number(count[0]!.count) >= FEEDBACK_MAX_IDEAS) fail('The destination board is full.', 409)
    const ideaRevision = nextRevision(idea.ideaRevision)
    await tx('feedbackIdeas').where({ id: idea.id }).update({ boardId: destination.id, categoryId: null, categoryLabel: null, ideaRevision, updatedAt: ctx.now })
    await audit(tx, ctx, { boardId: source.id, ideaId: idea.id, kind: 'moved-out', explanation: command.explanation, categoryLabel: idea.categoryLabel, details: { destinationBoardId: destination.id } })
    await audit(tx, ctx, { boardId: destination.id, ideaId: idea.id, kind: 'moved-in', explanation: command.explanation, details: { sourceBoardId: source.id } })
    return { ideaId: idea.id, boardId: destination.id, ideaRevision }
  })
  const deleteFeedbackMetadata = (input: FeedbackContextInput & z.infer<typeof FeedbackDeleteInputSchema>) => deps.db.transaction(async tx => {
    const command = parse(FeedbackDeleteInputSchema, dataOnly(input)), ctx = await context(tx, input, true)
    if (command.ideaId) {
      if (!command.expectedIdeaRevision || !command.expectedSourceRevision) fail('Idea deletion requires current idea and source revisions.')
      const current = await loadIdea(tx, ctx, command.boardId, command.ideaId, true)
      if (!current.moderator) fail('Current page-management authority is required on both pages.', 403)
      revisions(current, { expectedBoardRevision: command.expectedBoardRevision, expectedIdeaRevision: command.expectedIdeaRevision, expectedSourceRevision: command.expectedSourceRevision })
      await tx('feedbackIdeas').where({ id: command.ideaId }).delete()
      await audit(tx, ctx, { boardId: command.boardId, kind: 'idea-metadata-deleted', details: { ideaId: command.ideaId, pageId: current.page.id } })
      return { deleted: true as const }
    }
    const before = await tx<BoardRow>('feedbackBoards').where({ id: command.boardId }).first()
    if (!before) return missing()
    const ideasBefore = await tx<IdeaRow>('feedbackIdeas').where({ boardId: command.boardId }).limit(FEEDBACK_MAX_IDEAS + 1)
    if (ideasBefore.length > FEEDBACK_MAX_IDEAS) fail('The board membership bound was exceeded.', 409)
    const loaded = await pages(tx, [before.boardPageId, ...ideasBefore.map(idea => idea.pageId)], true)
    const board = await tx<BoardRow>('feedbackBoards').where({ id: command.boardId }).forUpdate().first()
    if (!board || board.boardPageId !== before.boardPageId) return missing()
    if (board.enabled) fail('Disable the board before deliberately deleting its metadata.', 409)
    if (String(board.boardRevision) !== command.expectedBoardRevision) conflict()
    const currentIdeas = await tx<IdeaRow>('feedbackIdeas').where({ boardId: command.boardId }).orderBy('id').forUpdate()
    if (hash(currentIdeas.map(idea => idea.pageId).sort((a, b) => a - b)) !== hash(ideasBefore.map(idea => idea.pageId).sort((a, b) => a - b))) conflict()
    for (const id of [board.boardPageId, ...currentIdeas.map(idea => idea.pageId)]) {
      const page = loaded.get(id)
      if (!page || !(await readable(tx, ctx, page))) return missing()
      if (!manages(ctx, page)) fail('Current page-management authority is required on the anchor and every idea.', 403)
    }
    // Only board-owned metadata cascades. No canonical page, source, history, tag or comment is written.
    await tx('feedbackBoards').where({ id: board.id }).delete()
    return { deleted: true as const }
  })
  const getFeedbackIdea = (input: FeedbackContextInput & { boardId: string; ideaId: string }) => deps.db.transaction(async tx => {
    const ctx = await context(tx, input), current = await loadIdea(tx, ctx, input.boardId, input.ideaId)
    const listing = await discover(tx, ctx, input.boardId, ctx.now.valueOf(), true)
    const idea = listing.items.find(item => item.id === current.idea.id)
    if (!idea) return missing()
    const historyQuery = tx('feedbackTransitions').where({ ideaId: idea.id, boardId: current.board.id }).orderBy('createdAt').orderBy('id')
    if (!current.moderator) historyQuery.where('kind', 'status')
    const history = await historyQuery.select('id', 'kind', 'fromState', 'toState', 'explanation', 'categoryLabel', 'createdAt')
    return { idea, history: history.map(event => ({ ...event, createdAt: iso(event.createdAt) })) }
  })
  /** Delivery/inbox adapter: current recipient policy checks still belong to the native notification owner. */
  const feedbackNotificationContext = async (tx: Knex.Transaction, input: FeedbackNotificationInput): Promise<FeedbackNotificationContext | null> => {
    try {
      const ctx = await context(tx, { requester: input.requester, sessionId: input.sessionId ?? '' }, false, input.sessionId === null)
      if (ctx.humanId === null) return null
      const current = await loadIdea(tx, ctx, input.boardId, input.ideaId)
      if (!current.board.enabled) return null
      return { boardId: current.board.id, ideaId: current.idea.id, pageId: current.page.id, title: current.page.title, path: current.page.path,
        locale: current.page.localeCode!, visibility: current.page.visibility, submittedBy: current.idea.submittedBy,
        subscriberIds: (await tx('feedbackSubscriptions').where({ ideaId: current.idea.id }).select('userId')).map(row => Number(row.userId)) }
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status))) return null
      throw error
    }
  }
  return { listFeedbackBoards, getFeedbackBoard, getFeedbackIdea, listFeedbackIdeas, suggestFeedbackDuplicates, prepareFeedbackSubmission, admitCreatedFeedbackIdea,
    submitExistingFeedbackIdea, setFeedbackVote, setFeedbackSubscription, transitionFeedbackIdea, getFeedbackRequestReceipt,
    setFeedbackCategory, configureFeedbackBoard, configureFeedbackCategory, moveFeedbackIdea, deleteFeedbackMetadata, feedbackNotificationContext }
}

interface FeedbackRuntime {
  models: { knex: Knex }
  config: { sessionSecret: string }
  auth: {
    loadPageRuleAuthority(requester: PagePrincipal, tx?: Knex.Transaction): Promise<PageRuleAuthority>
    checkPageAccess(requester: PagePrincipal, permissions: readonly string[], context: PageAuthorizationContext, authority: PageRuleAuthority): boolean
  }
}
let runtimeOperations: PageFeedbackOperations | undefined
const getFeedbackOperations = (): PageFeedbackOperations => {
  if (runtimeOperations) return runtimeOperations
  const wiki = WIKI as unknown as FeedbackRuntime
  runtimeOperations = createPageFeedbackStore({
    db: wiki.models.knex, secret: wiki.config.sessionSecret,
    loadAuthority: (requester, tx) => wiki.auth.loadPageRuleAuthority(requester, tx),
    checkManage: (requester, page, authority) => {
      const context = pageAuthorizationContext(page)
      return context !== null && wiki.auth.checkPageAccess(requester, ['manage:pages'], context, authority)
    },
    postComment: postFeedbackDiscussionInTransaction
  })
  return runtimeOperations
}
export const listFeedbackBoards: PageFeedbackOperations['listFeedbackBoards'] = input => getFeedbackOperations().listFeedbackBoards(input)
export const getFeedbackBoard: PageFeedbackOperations['getFeedbackBoard'] = input => getFeedbackOperations().getFeedbackBoard(input)
export const getFeedbackIdea: PageFeedbackOperations['getFeedbackIdea'] = input => getFeedbackOperations().getFeedbackIdea(input)
export const listFeedbackIdeas: PageFeedbackOperations['listFeedbackIdeas'] = input => getFeedbackOperations().listFeedbackIdeas(input)
export const suggestFeedbackDuplicates: PageFeedbackOperations['suggestFeedbackDuplicates'] = input => getFeedbackOperations().suggestFeedbackDuplicates(input)
export const prepareFeedbackSubmission: PageFeedbackOperations['prepareFeedbackSubmission'] = (tx, input) => getFeedbackOperations().prepareFeedbackSubmission(tx, input)
export const admitCreatedFeedbackIdea: PageFeedbackOperations['admitCreatedFeedbackIdea'] = (tx, input) => getFeedbackOperations().admitCreatedFeedbackIdea(tx, input)
export const submitExistingFeedbackIdea: PageFeedbackOperations['submitExistingFeedbackIdea'] = input => getFeedbackOperations().submitExistingFeedbackIdea(input)
export const setFeedbackVote: PageFeedbackOperations['setFeedbackVote'] = input => getFeedbackOperations().setFeedbackVote(input)
export const setFeedbackSubscription: PageFeedbackOperations['setFeedbackSubscription'] = input => getFeedbackOperations().setFeedbackSubscription(input)
export const transitionFeedbackIdea: PageFeedbackOperations['transitionFeedbackIdea'] = input => getFeedbackOperations().transitionFeedbackIdea(input)
export const getFeedbackRequestReceipt: PageFeedbackOperations['getFeedbackRequestReceipt'] = input => getFeedbackOperations().getFeedbackRequestReceipt(input)
export const setFeedbackCategory: PageFeedbackOperations['setFeedbackCategory'] = input => getFeedbackOperations().setFeedbackCategory(input)
export const configureFeedbackBoard: PageFeedbackOperations['configureFeedbackBoard'] = input => getFeedbackOperations().configureFeedbackBoard(input)
export const configureFeedbackCategory: PageFeedbackOperations['configureFeedbackCategory'] = input => getFeedbackOperations().configureFeedbackCategory(input)
export const moveFeedbackIdea: PageFeedbackOperations['moveFeedbackIdea'] = input => getFeedbackOperations().moveFeedbackIdea(input)
export const deleteFeedbackMetadata: PageFeedbackOperations['deleteFeedbackMetadata'] = input => getFeedbackOperations().deleteFeedbackMetadata(input)
export const feedbackNotificationContext: PageFeedbackOperations['feedbackNotificationContext'] = (tx, input) => getFeedbackOperations().feedbackNotificationContext(tx, input)

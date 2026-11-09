import { z } from 'zod'
import { FeedbackBoardInputSchema, FeedbackCategoryInputSchema, FeedbackSubmitInputSchema, FeedbackVoteInputSchema, FeedbackSubscriptionInputSchema, FeedbackTransitionInputSchema, FeedbackSetCategoryInputSchema, FeedbackDeleteInputSchema, FeedbackMoveInputSchema, FeedbackStateSchema, FeedbackQuerySchema, feedbackQueryString, type FeedbackBoard, type FeedbackIdea, type FeedbackList, type FeedbackQuery } from '../../shared/page-feedback.ts'
import { PageReviewCommandSchema, PageReviewPreviewSchema, PageReviewViewSchema, type PageReviewCommand } from '../../shared/page-review-routing.ts'
import { PageLifecyclePreviewRequestSchema, PageLifecycleSaveRequestSchema, PageLifecycleRuleDefinitionSchema, type PageLifecyclePreview, type PageLifecyclePreviewRequest, type PageLifecycleSaveRequest } from '../../shared/page-lifecycle.ts'
import type { BrowserFetch } from './json-transport.ts'
import { wikiStore } from '../store/index.ts'

const uuid = z.uuid(), revision = z.string().regex(/^[1-9]\d*$/), id = z.number().int().positive()
const category = z.strictObject({ id: uuid, label: z.string(), active: z.boolean(), displayOrder: z.number().int() })
const boardSchema: z.ZodType<FeedbackBoard> = z.strictObject({ id: uuid, boardPageId: id, name: z.string(), enabled: z.boolean(), boardRevision: revision, canManage: z.boolean(), canSubmit: z.boolean(), categories: z.array(category) })
const ideaSchema: z.ZodType<FeedbackIdea> = z.strictObject({ id: uuid, boardId: uuid, pageId: id, title: z.string(), path: z.string(), locale: z.string(), visibility: z.enum(['public', 'private']), state: FeedbackStateSchema, ideaRevision: revision, sourceRevision: revision, categoryId: uuid.nullable(), categoryLabel: z.string().nullable(), submittedAt: z.string(), withdrawnAt: z.string().nullable(), voteCount: z.number().int().nonnegative(), trendingCount: z.number().int().nonnegative(), voted: z.boolean(), subscribed: z.boolean(), canModerate: z.boolean(), canWithdraw: z.boolean(), canRestore: z.boolean(), canEditSource: z.boolean() })
const listSchema: z.ZodType<FeedbackList> = z.strictObject({ schemaVersion: z.literal(1), board: boardSchema, query: FeedbackQuerySchema, asOf: z.string(), items: z.array(ideaSchema), total: z.number().int().nonnegative(), permittedTotal: z.number().int().nonnegative(), facets: z.strictObject({ statuses: z.record(z.string(), z.number()), categories: z.record(z.string(), z.number()) }), nextCursor: z.string().nullable(), state: z.enum(['ready', 'empty', 'no-matches']) })
const transitionSchema = z.strictObject({ requestId: uuid, boardId: uuid, ideaId: uuid, ideaRevision: revision, state: FeedbackStateSchema, rootTransitionEventId: uuid, commentId: id.nullable() })
const dueSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown-clock') }), z.strictObject({ state: z.literal('not-due') }), z.strictObject({ state: z.literal('due'), conditionKey: z.string(), epoch: z.string().nullable(), cycleNo: z.number().int().nullable(), dueAt: z.string() })])
const previewSchema: z.ZodType<PageLifecyclePreview> = z.strictObject({ previewToken: uuid, expiresAt: z.string(), fingerprint: z.string(), ruleId: uuid.nullable(), expectedRevision: z.number().int().positive().nullable(), startObserving: z.boolean(), runAgain: z.boolean(), warning: z.string().nullable(), pages: z.array(z.strictObject({ pageId: id, sourceRevision: revision, path: z.string(), localeCode: z.string(), protected: z.boolean(), clock: z.enum(['known-change', 'observed-baseline', 'unknown']), anchorAt: z.string().nullable(), historicalAgeUnknown: z.boolean(), due: dueSchema, effects: z.array(z.strictObject({ kind: z.enum(['add-tags', 'set-notice', 'propose-move', 'notify']), mode: z.enum(['unattended', 'human-review']), destinationPath: z.string().optional(), reason: z.string().optional() })) })) })
const lifecycleRule = z.looseObject({ id: uuid, revision: z.number().int().positive(), definition: PageLifecycleRuleDefinitionSchema, status: z.string(), reason: z.string().nullable() })
const receipt = z.looseObject({ effectIndex: z.number().int(), kind: z.string(), state: z.string(), reason: z.string().nullable(), proposalId: uuid.nullable() })
const cycle = z.looseObject({ id: uuid, pageId: id, status: z.string(), reason: z.string().nullable(), receipts: z.array(receipt) })
const inspection = z.strictObject({ rule: lifecycleRule, pages: z.array(z.looseObject({ pageId: id, sourceRevision: revision, due: z.unknown() })), cycles: z.array(cycle), hasMore: z.boolean(), nextCursor: uuid.nullable() })
const proposal = z.looseObject({ id: uuid, pageId: id, sourcePath: z.string(), sourceLocale: z.string(), destinationPath: z.string(), destinationLocale: z.string(), sourceRevision: z.union([revision, z.number().int().positive()]), currentSourceRevision: revision, requiresNewPreview: z.boolean(), status: z.string(), expiresAt: z.string(), humanMoveInput: z.strictObject({ id, destinationPath: z.string(), destinationLocale: z.string(), expectedSourceRevision: revision, lifecycleProposalId: uuid }) })
export type LifecycleInspection = z.infer<typeof inspection>
export type LifecycleProposal = z.infer<typeof proposal>
export class PageGovernanceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export function governanceOwnerMatches(authorityKey: string): boolean {
  if (!wikiStore.authRefreshSettled || wikiStore.authRefreshPending ||
    (wikiStore.authRefreshOutcome !== 'authenticated' && wikiStore.authRefreshOutcome !== 'anonymous')) return false
  if (wikiStore.authRefreshOutcome === 'authenticated' && (!Number.isSafeInteger(wikiStore.user.id) || wikiStore.user.id < 1 ||
    !Number.isSafeInteger(wikiStore.user.authVersion) || wikiStore.user.authVersion < 0)) return false
  try {
    const expected: unknown = JSON.parse(authorityKey)
    return Array.isArray(expected) && expected.length >= 6 &&
      expected[0] === wikiStore.user.id && expected[1] === wikiStore.user.authVersion &&
      expected[2] === wikiStore.offlineIdentityEpoch && expected[3] === wikiStore.authRefreshOutcome &&
      expected[4] === false && JSON.stringify(expected[5]) === JSON.stringify(wikiStore.user.permissions) &&
      wikiStore.user.authenticated === (wikiStore.authRefreshOutcome === 'authenticated')
  } catch { return false }
}
/** Capture one current browser owner for a native feature request, including canonical create/move handoffs. */
export function captureGovernanceFetch(fetchImpl: BrowserFetch, authorityKey?: string): BrowserFetch {
  const ownerKey = authorityKey ?? JSON.stringify([wikiStore.user.id, wikiStore.user.authVersion,
    wikiStore.offlineIdentityEpoch, wikiStore.authRefreshOutcome, wikiStore.authRefreshPending, wikiStore.user.permissions])
  if (!governanceOwnerMatches(ownerKey)) throw new PageGovernanceError(409, 'GOVERNANCE_OWNER_CHANGED', 'Current browser identity is unavailable or changed. Reload current authority before continuing.')
  const owner = wikiStore.user.authenticated ? `${wikiStore.user.id}:${wikiStore.user.authVersion}` : 'anonymous'
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/_api/')) throw new Error('A native same-origin governance request is required.')
    if (!governanceOwnerMatches(ownerKey)) throw new PageGovernanceError(409, 'GOVERNANCE_OWNER_CHANGED', 'The browser owner changed before the operation. No request was sent.')
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
    headers.set('X-Wiki-Governance-Owner', owner)
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') headers.set('X-Wiki-Csrf', siteConfig.agentCsrfToken)
    const response = await fetchImpl(input, { ...init, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers })
    if (!governanceOwnerMatches(ownerKey)) throw new PageGovernanceError(409, 'GOVERNANCE_OWNER_CHANGED', 'The browser owner changed while the operation was in flight. Inspect its current receipt before retrying.')
    return response
  }
}
export async function governanceRequest<T>(fetchImpl: BrowserFetch, path: string, schema: z.ZodType<T>, options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!path.startsWith('/_api/') || path.startsWith('//') || /[\\\r\n]/.test(path)) throw new Error('A native same-origin governance route is required.')
  const ownerKey = JSON.stringify([wikiStore.user.id, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch,
    wikiStore.authRefreshOutcome, wikiStore.authRefreshPending, wikiStore.user.permissions])
  const request = captureGovernanceFetch(fetchImpl, ownerKey)
  const response = await request(path, { method: options.method ?? 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal, headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  let payload: unknown
  try { payload = await response.json() } catch { throw new PageGovernanceError(response.status, 'INVALID_RESPONSE', 'The operation outcome could not be confirmed. Reload or inspect its receipt before retrying.') }
  if (!governanceOwnerMatches(ownerKey)) throw new PageGovernanceError(409, 'GOVERNANCE_OWNER_CHANGED', 'The browser owner changed while reading the operation result. Reload current authority; inspect a mutation receipt before retrying.')
  if (!response.ok) {
    const error = z.object({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional(), retryAfterMilliseconds: z.number().nonnegative().optional() }).safeParse(payload)
    let message = error.success ? error.data.error ?? error.data.message ?? 'The governance request failed.' : 'The governance request failed.'
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      message += retryAfter ? ` Retry-After: ${retryAfter}.` : error.success && error.data.retryAfterMilliseconds !== undefined ? ` Retry after ${Math.ceil(error.data.retryAfterMilliseconds / 1000)} seconds.` : ' Rate limited; wait and reload current state before an explicit retry.'
    }
    throw new PageGovernanceError(response.status, error.success ? error.data.code ?? 'REQUEST_FAILED' : 'REQUEST_FAILED', message)
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new PageGovernanceError(response.status, 'INVALID_RESPONSE', 'The governance response was invalid; no outcome has been assumed.')
  return parsed.data
}
const key = (value: string) => encodeURIComponent(uuid.parse(value))
const feedback = '/_api/page-feedback'
export const governanceApi = {
  boards: (signal?: AbortSignal) => governanceRequest(window.fetch.bind(window), `${feedback}/boards`, z.array(boardSchema), { signal }),
  boardConfig: (boardId: string) => governanceRequest(window.fetch.bind(window), `${feedback}/boards/${key(boardId)}/config`, boardSchema),
  board: (boardId: string, query: FeedbackQuery, signal?: AbortSignal) => governanceRequest(window.fetch.bind(window), `${feedback}/boards/${key(boardId)}?${feedbackQueryString(query)}`, listSchema, { signal }),
  duplicates: (boardId: string, q: string, signal?: AbortSignal) => governanceRequest(window.fetch.bind(window), `${feedback}/boards/${key(boardId)}/duplicates?q=${encodeURIComponent(q.trim().slice(0, 200))}`, z.array(ideaSchema), { signal }),
  configureBoard: (input: z.input<typeof FeedbackBoardInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/boards`, boardSchema, { method: 'POST', body: FeedbackBoardInputSchema.parse(input) }),
  category: (input: z.input<typeof FeedbackCategoryInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/boards/${key(input.boardId)}/categories`, z.strictObject({ categoryId: uuid, boardRevision: revision }), { method: 'POST', body: FeedbackCategoryInputSchema.parse(input) }),
  attach: (input: z.input<typeof FeedbackSubmitInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/submit`, z.strictObject({ ideaId: uuid, ideaRevision: revision }), { method: 'POST', body: FeedbackSubmitInputSchema.parse(input) }),
  vote: (input: z.input<typeof FeedbackVoteInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/vote`, z.strictObject({ voted: z.boolean(), ideaRevision: revision }), { method: 'POST', body: FeedbackVoteInputSchema.parse(input) }),
  subscribe: (input: z.input<typeof FeedbackSubscriptionInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/subscription`, z.strictObject({ subscribed: z.boolean() }), { method: 'POST', body: FeedbackSubscriptionInputSchema.parse(input) }),
  transition: (input: z.input<typeof FeedbackTransitionInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/transition`, transitionSchema, { method: 'POST', body: FeedbackTransitionInputSchema.parse(input) }),
  setCategory: (input: z.input<typeof FeedbackSetCategoryInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/category`, z.strictObject({ ideaRevision: revision }), { method: 'POST', body: FeedbackSetCategoryInputSchema.parse(input) }),
  moveIdea: (input: z.input<typeof FeedbackMoveInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/move`, z.strictObject({ ideaId: uuid, boardId: uuid, ideaRevision: revision }), { method: 'POST', body: FeedbackMoveInputSchema.parse(input) }),
  removeMetadata: (input: z.input<typeof FeedbackDeleteInputSchema>) => governanceRequest(window.fetch.bind(window), `${feedback}/delete`, z.strictObject({ deleted: z.literal(true) }), { method: 'POST', body: FeedbackDeleteInputSchema.parse(input) }),
  receipt: (boardId: string, ideaId: string, requestId: string) => governanceRequest(window.fetch.bind(window), `${feedback}/receipts/${key(requestId)}?boardId=${key(boardId)}&ideaId=${key(ideaId)}`, transitionSchema.nullable()),
  review: (pageId: number, signal?: AbortSignal) => governanceRequest(window.fetch.bind(window), `/_api/pages/${id.parse(pageId)}/review-routing`, PageReviewViewSchema, { signal }),
  previewReview: (pageId: number, input: z.input<typeof PageReviewPreviewSchema>) => governanceRequest(window.fetch.bind(window), `/_api/pages/${id.parse(pageId)}/review-routing/preview`, PageReviewViewSchema, { method: 'POST', body: PageReviewPreviewSchema.parse(input) }),
  updateReview: (pageId: number, input: PageReviewCommand) => governanceRequest(window.fetch.bind(window), `/_api/pages/${id.parse(pageId)}/review-routing`, PageReviewViewSchema, { method: 'PUT', body: PageReviewCommandSchema.parse(input) }),
  rules: (cursor?: string) => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/rules${cursor ? `?cursor=${key(cursor)}` : ''}`, z.strictObject({ rules: z.array(lifecycleRule), hasMore: z.boolean(), nextCursor: uuid.nullable() })),
  previewLifecycle: (input: PageLifecyclePreviewRequest) => governanceRequest(window.fetch.bind(window), '/_api/page-lifecycle/preview', previewSchema, { method: 'POST', body: PageLifecyclePreviewRequestSchema.parse(input) }),
  saveLifecycle: (input: PageLifecycleSaveRequest) => governanceRequest(window.fetch.bind(window), '/_api/page-lifecycle/rules', z.strictObject({ ruleId: uuid, revision: z.number().int().positive(), status: z.string() }), { method: 'POST', body: PageLifecycleSaveRequestSchema.parse(input) }),
  inspectLifecycle: (ruleId: string, cursor?: string) => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/rules/${key(ruleId)}${cursor ? `?cursor=${key(cursor)}` : ''}`, inspection),
  lifecycleStatus: (ruleId: string, expectedRevision: number, action: 'disable' | 'cancel') => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/rules/${key(ruleId)}/status`, z.strictObject({ ruleId: uuid, revision: z.number().int().positive(), status: z.string() }), { method: 'POST', body: { expectedRevision, action } }),
  proposal: (proposalId: string) => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/proposals/${key(proposalId)}`, proposal),
  refuse: (proposalId: string) => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/proposals/${key(proposalId)}/refuse`, z.strictObject({ proposalId: uuid, status: z.literal('refused') }), { method: 'POST', body: {} }),
  resume: (cycleId: string) => governanceRequest(window.fetch.bind(window), `/_api/page-lifecycle/cycles/${key(cycleId)}/resume`, z.strictObject({ cycleId: uuid, status: z.literal('queued') }), { method: 'POST', body: {} })
}

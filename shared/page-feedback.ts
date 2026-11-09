import { z } from 'zod'

export const FEEDBACK_SCHEMA_VERSION = 1 as const
export const FEEDBACK_MAX_BOARDS = 100
export const FEEDBACK_MAX_IDEAS = 5000
export const FEEDBACK_CURSOR_TTL_MS = 300000
export const FeedbackStateSchema = z.enum(['proposed', 'planned', 'in-progress', 'completed', 'closed', 'withdrawn'])
export const FeedbackSortSchema = z.enum(['top', 'trending', 'newest'])
export const FeedbackRevisionSchema = z.string().regex(/^[1-9][0-9]*$/)
const uuid = z.string().uuid()
const pageId = z.number().int().positive().max(2147483647)
export type FeedbackState = z.infer<typeof FeedbackStateSchema>
export type FeedbackSort = z.infer<typeof FeedbackSortSchema>

export const FeedbackQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  sort: FeedbackSortSchema.default('top'),
  statuses: z.array(FeedbackStateSchema).min(1).max(6).optional(),
  categoryIds: z.array(uuid).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(20)
}).transform(value => ({
  ...value,
  q: value.q || undefined,
  statuses: value.statuses === undefined ? undefined : [...new Set(value.statuses)].sort(),
  categoryIds: value.categoryIds?.length ? [...new Set(value.categoryIds)].sort() : undefined
}))
export type FeedbackQuery = z.infer<typeof FeedbackQuerySchema>
export const normalizeFeedbackQuery = (input: unknown): FeedbackQuery => FeedbackQuerySchema.parse(input)
export const feedbackDefaultStatuses = (sort: FeedbackSort): FeedbackState[] =>
  sort === 'top' ? ['proposed', 'planned', 'in-progress'] : ['proposed', 'planned', 'in-progress', 'completed']
export const feedbackQueryString = (input: unknown): string => {
  const query = normalizeFeedbackQuery(input), params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.sort !== 'top') params.set('sort', query.sort)
  if (query.statuses) params.set('statuses', query.statuses.join(','))
  if (query.categoryIds) params.set('categoryIds', query.categoryIds.join(','))
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit !== 20) params.set('limit', String(query.limit))
  return params.toString()
}
export const parseFeedbackQueryString = (input: string | URLSearchParams): FeedbackQuery => {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input
  const allowed: Record<string, true> = { q: true, sort: true, statuses: true, categoryIds: true, cursor: true, limit: true }
  for (const key of params.keys()) if (!Object.hasOwn(allowed, key) || params.getAll(key).length !== 1) throw new Error('Invalid feedback query parameter.')
  return normalizeFeedbackQuery(Object.fromEntries([...params.entries()].map(([key, value]) =>
    [key, key === 'statuses' || key === 'categoryIds' ? value.split(',') : key === 'limit' ? Number(value) : value])))
}
export const FeedbackBoardInputSchema = z.strictObject({
  boardId: uuid.optional(), boardPageId: pageId, name: z.string().trim().min(1).max(200), enabled: z.boolean(),
  expectedBoardRevision: FeedbackRevisionSchema.optional()
})
export const FeedbackCategoryInputSchema = z.strictObject({
  boardId: uuid, categoryId: uuid.optional(), label: z.string().trim().min(1).max(200), active: z.boolean(),
  displayOrder: z.number().int().min(0).max(100000), expectedBoardRevision: FeedbackRevisionSchema
})
export const FeedbackSubmitInputSchema = z.strictObject({
  boardId: uuid, pageId, expectedBoardRevision: FeedbackRevisionSchema, expectedSourceRevision: FeedbackRevisionSchema,
  acknowledged: z.literal(true)
})
export const FeedbackCreateAdmissionSchema = FeedbackSubmitInputSchema.omit({ pageId: true, expectedSourceRevision: true })
export type FeedbackCreateAdmissionInput = z.infer<typeof FeedbackCreateAdmissionSchema>
export const FeedbackVoteInputSchema = z.strictObject({ boardId: uuid, ideaId: uuid, voted: z.boolean(), expectedIdeaRevision: FeedbackRevisionSchema })
export const FeedbackSubscriptionInputSchema = z.strictObject({ boardId: uuid, ideaId: uuid, subscribed: z.boolean() })
export const FeedbackCommentDraftSchema = z.strictObject({ content: z.string().min(2).max(50000), replyTo: z.number().int().min(0).default(0), annotations: z.unknown().optional() })
export const FeedbackTransitionInputSchema = z.strictObject({
  boardId: uuid, ideaId: uuid, requestId: uuid, expectedBoardRevision: FeedbackRevisionSchema,
  expectedIdeaRevision: FeedbackRevisionSchema, expectedSourceRevision: FeedbackRevisionSchema,
  targetState: FeedbackStateSchema, explanation: z.string().trim().min(1).max(2000),
  comment: FeedbackCommentDraftSchema.optional()
})
export const FeedbackSetCategoryInputSchema = z.strictObject({
  boardId: uuid, ideaId: uuid, categoryId: uuid.nullable(), expectedBoardRevision: FeedbackRevisionSchema,
  expectedIdeaRevision: FeedbackRevisionSchema, expectedSourceRevision: FeedbackRevisionSchema
})
export const FeedbackMoveInputSchema = z.strictObject({
  boardId: uuid, ideaId: uuid, destinationBoardId: uuid, expectedBoardRevision: FeedbackRevisionSchema,
  expectedDestinationBoardRevision: FeedbackRevisionSchema, expectedIdeaRevision: FeedbackRevisionSchema,
  expectedSourceRevision: FeedbackRevisionSchema, explanation: z.string().trim().min(1).max(2000)
})
export const FeedbackDeleteInputSchema = z.strictObject({
  boardId: uuid, ideaId: uuid.optional(), expectedBoardRevision: FeedbackRevisionSchema,
  expectedIdeaRevision: FeedbackRevisionSchema.optional(), expectedSourceRevision: FeedbackRevisionSchema.optional(), confirmed: z.literal(true)
})
export interface FeedbackCategory { id: string; label: string; active: boolean; displayOrder: number }
export interface FeedbackBoard {
  id: string; boardPageId: number; name: string; enabled: boolean; boardRevision: string;
  canManage: boolean; canSubmit: boolean; categories: FeedbackCategory[]
}
export interface FeedbackIdea {
  id: string; boardId: string; pageId: number; title: string; path: string; locale: string; visibility: 'public' | 'private';
  state: FeedbackState; ideaRevision: string; sourceRevision: string; categoryId: string | null; categoryLabel: string | null;
  submittedAt: string; withdrawnAt: string | null; voteCount: number; trendingCount: number; voted: boolean; subscribed: boolean;
  canModerate: boolean; canWithdraw: boolean; canRestore: boolean; canEditSource: boolean
}
export interface FeedbackList {
  schemaVersion: 1; board: FeedbackBoard; query: FeedbackQuery; asOf: string; items: FeedbackIdea[]; total: number;
  permittedTotal: number; facets: { statuses: Partial<Record<FeedbackState, number>>; categories: Record<string, number> };
  nextCursor: string | null; state: 'ready' | 'empty' | 'no-matches'
}
export interface FeedbackTransitionResult {
  requestId: string; boardId: string; ideaId: string; ideaRevision: string; state: FeedbackState;
  rootTransitionEventId: string; commentId: number | null
}
export type FeedbackTransitionInput = z.infer<typeof FeedbackTransitionInputSchema>
export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitInputSchema>

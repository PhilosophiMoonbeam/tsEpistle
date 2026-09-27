import { z } from 'zod'

export const PageRatingModeSchema = z.enum(['thumbs', 'stars'])
export type PageRatingMode = z.infer<typeof PageRatingModeSchema>
export const DEFAULT_PAGE_RATING_MODE: PageRatingMode = 'thumbs'

export const PageRatingVoteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thumbs'), value: z.union([z.literal(-1), z.literal(1)]) }),
  z.strictObject({ kind: z.literal('stars'), value: z.number().int().min(1).max(5) })
])
export type PageRatingVote = z.infer<typeof PageRatingVoteSchema>

const CountSchema = z.number().int().nonnegative().safe()
const ScoreSchema = z.number().finite().nullable()
const ThumbsDistributionSchema = z.strictObject({
  '-1': CountSchema,
  '1': CountSchema
})
const StarsDistributionSchema = z.strictObject({
  '1': CountSchema,
  '2': CountSchema,
  '3': CountSchema,
  '4': CountSchema,
  '5': CountSchema
})

export const PageRatingViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('thumbs'),
    count: CountSchema,
    score: ScoreSchema,
    distribution: ThumbsDistributionSchema,
    ownVote: z.union([z.literal(-1), z.literal(1)]).nullable()
  }),
  z.strictObject({
    kind: z.literal('stars'),
    count: CountSchema,
    score: ScoreSchema,
    distribution: StarsDistributionSchema,
    ownVote: z.number().int().min(1).max(5).nullable()
  })
])
export type PageRatingView = z.infer<typeof PageRatingViewSchema>


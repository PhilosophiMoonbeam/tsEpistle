import { describe, expect, it } from '../bun-test.mts'
import {
  FeedbackQuerySchema, FeedbackTransitionInputSchema, FeedbackVoteInputSchema,
  feedbackDefaultStatuses, normalizeFeedbackQuery, parseFeedbackQueryString, feedbackQueryString
} from '../../../shared/page-feedback.ts'

const boardId = '00000000-0000-4000-8000-000000000001'
const ideaId = '00000000-0000-4000-8000-000000000002'
describe('feedback discovery and deliberate-command contract', () => {
  it('keeps explicit completed/closed selections through sort and URL navigation while clearing only omitted filters', () => {
    const explicit = normalizeFeedbackQuery({ sort: 'top', statuses: ['closed', 'completed', 'closed'], q: '  exact title  ', limit: 5 })
    expect(explicit.statuses).toEqual(['closed', 'completed'])
    const trending = parseFeedbackQueryString(feedbackQueryString({ ...explicit, sort: 'trending' }))
    expect(trending).toEqual({ ...explicit, sort: 'trending' })
    expect(parseFeedbackQueryString(feedbackQueryString(explicit))).toEqual(explicit)
    const cleared = normalizeFeedbackQuery({ q: '   ' })
    expect(feedbackQueryString(cleared)).toBe('')
    expect(cleared.statuses).toBeUndefined()
    expect(feedbackDefaultStatuses('top')).toEqual(['proposed', 'planned', 'in-progress'])
    expect(feedbackDefaultStatuses('trending')).toEqual(['proposed', 'planned', 'in-progress', 'completed'])
    expect(feedbackDefaultStatuses('newest')).toEqual(['proposed', 'planned', 'in-progress', 'completed'])
  })
  it('refuses ambiguous, empty explicit, oversized and undeclared filters rather than silently narrowing them', () => {
    for (const query of [{ statuses: [] }, { limit: 101 }, { limit: 0 }, { q: 'x'.repeat(201) }, { sort: 'popular' }, { inherited: true }])
      expect(FeedbackQuerySchema.safeParse(query).success).toBe(false)
    for (const query of ['statuses=', 'q=one&q=two', 'limit=20&unknown=x', 'sort=top&sort=newest'])
      expect(() => parseFeedbackQueryString(query)).toThrow()
  })
  it('requires explicit vote intent, revision fences and a plain explanation without accepting client trusted render', () => {
    expect(FeedbackVoteInputSchema.safeParse({ boardId, ideaId, voted: true, expectedIdeaRevision: '1' }).success).toBe(true)
    for (const value of [1, 'true', undefined])
      expect(FeedbackVoteInputSchema.safeParse({ boardId, ideaId, voted: value, expectedIdeaRevision: '1' }).success).toBe(false)
    const command = { boardId, ideaId, requestId: '00000000-0000-4000-8000-000000000003', expectedBoardRevision: '1', expectedIdeaRevision: '1', expectedSourceRevision: '1', targetState: 'planned', explanation: 'A reviewed priority decision.' }
    expect(FeedbackTransitionInputSchema.safeParse(command).success).toBe(true)
    for (const change of [{ explanation: '' }, { explanation: 'x'.repeat(2001) }, { expectedSourceRevision: '0' }, { comment: { content: 'A reply', render: '<script>trusted</script>' } }])
      expect(FeedbackTransitionInputSchema.safeParse({ ...command, ...change }).success).toBe(false)
  })
})

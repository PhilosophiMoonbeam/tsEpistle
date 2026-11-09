import { describe, expect, it } from '../bun-test.mts'
import { accuracyReviewClock, independentReviewClock, PageReviewCommandSchema, PageReviewRouteSchema, REVIEW_DAY_MS } from '../../../shared/page-review-routing.ts'

const epoch = Date.parse('2026-01-01T00:00:00.000Z')
const attestation = { id: 'bf21e770-7904-4430-8d92-32f710ea96c3', sourceRevision: '8', verifiedAt: new Date(epoch).toISOString() }
const clock = (now: number, proof: typeof attestation | null = attestation) => accuracyReviewClock({ sourceRevision: '8', attestation: proof, unverifiedAt: epoch, now })

describe('review routing and exact UTC clocks', () => {
  it('refuses mixed, empty, duplicate, opaque and implicit-reset routes', () => {
    for (const input of [{ mode: 'users', userIds: [] }, { mode: 'users', userIds: [7, 7] }, { mode: 'users', userIds: [7], groupIds: [3] }, { mode: 'groups', groupIds: ['3'] }, { mode: 'contacts', userIds: [] }]) expect(PageReviewRouteSchema.safeParse(input).success).toBe(false)
    expect(PageReviewCommandSchema.safeParse({ command: 'reset', mode: 'contacts', expectedSourceRevision: '8', expectedRoutingRevision: '3' }).success).toBe(true)
    expect(PageReviewCommandSchema.safeParse({ command: 'reset', mode: 'contacts', expectedSourceRevision: '8' }).success).toBe(false)
    expect(PageReviewCommandSchema.safeParse({ command: 'reschedule', expectedSourceRevision: '8', expectedRoutingRevision: '3', schedule: { mode: 'independent', anchorAt: '2026-01-01T00:00:00Z', intervalDays: 1 } }).success).toBe(false)
  })
  it('keeps exact30 inclusive, exact90 review-soon and +1ms overdue', () => {
    expect(clock(epoch + 30 * REVIEW_DAY_MS - 1).due).toBeNull()
    expect(clock(epoch + 30 * REVIEW_DAY_MS).due?.milestone).toBe('review-soon')
    expect(clock(epoch + 90 * REVIEW_DAY_MS).due?.milestone).toBe('review-soon')
    expect(clock(epoch + 90 * REVIEW_DAY_MS + 1).due).toMatchObject({ milestone: 'needs-verification', dueAt: epoch + 90 * REVIEW_DAY_MS + 1, coalescedThrough: 0 })
  })
  it('binds missing and changed-source epochs to canonical invalidation, never modification or old proof', () => {
    expect(clock(epoch + 1000, null).due).toMatchObject({ epochKey: '8:unverified', milestone: 'unverified', dueAt: epoch })
    expect(clock(epoch + REVIEW_DAY_MS, { ...attestation, sourceRevision: '7' }).due?.epochKey).toBe('8:unverified')
    expect(clock(epoch + 31 * REVIEW_DAY_MS, { ...attestation, id: '43777d80-688b-493c-a2ca-1f77063e10ac', verifiedAt: new Date(epoch + REVIEW_DAY_MS).toISOString() }).due?.epochKey).toBe('8:43777d80-688b-493c-a2ca-1f77063e10ac')
  })
  it('does not derive dates from invalid/future proofs and resumes only when server time catches up', () => {
    expect(clock(epoch - 1)).toEqual({ due: null, nextDueAt: null, unknownClock: true })
    expect(clock(epoch, { ...attestation, verifiedAt: 'corrupt' })).toEqual({ due: null, nextDueAt: null, unknownClock: true })
    expect(clock(epoch)).toMatchObject({ due: null, nextDueAt: epoch + 30 * REVIEW_DAY_MS, unknownClock: false })
  })
  it('catches up only greatest independent cycle with mathematical anchors across DST and restarts', () => {
    const anchor = '2026-03-07T12:00:00.000Z'
    const start = Date.parse(anchor)
    expect(independentReviewClock(anchor, 1, start - 1)).toMatchObject({ due: null, nextDueAt: start })
    expect(independentReviewClock(anchor, 1, start)).toMatchObject({ due: { cycleNo: 0, dueAt: start }, nextDueAt: start + REVIEW_DAY_MS })
    expect(independentReviewClock(anchor, 1, start + 10 * REVIEW_DAY_MS + 12345)).toMatchObject({ due: { cycleNo: 10, dueAt: start + 10 * REVIEW_DAY_MS, coalescedThrough: 9 }, nextDueAt: start + 11 * REVIEW_DAY_MS })
    expect(independentReviewClock('2026-03-07T12:00:00+01:00', 1, start).unknownClock).toBe(true)
  })
})

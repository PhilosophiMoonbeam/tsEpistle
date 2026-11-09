import { z } from 'zod'
import { PageAccuracySourceRevisionSchema } from './page-accuracy.ts'

export const REVIEW_DAY_MS = 86_400_000
export const REVIEW_AUDIENCE_WINDOW_MS = 7 * REVIEW_DAY_MS
const id = z.number().int().positive().safe()
const revision = z.union([z.literal('0'), PageAccuracySourceRevisionSchema])
const utc = z.iso.datetime().refine(value => value.endsWith('Z'), 'An explicit UTC timestamp is required.').transform(value => new Date(value).toISOString())
export const PageReviewRouteSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('contacts') }),
  z.strictObject({ mode: z.literal('users'), userIds: z.array(id).min(1).max(20).refine(values => new Set(values).size === values.length) }),
  z.strictObject({ mode: z.literal('groups'), groupIds: z.array(id).min(1).max(10).refine(values => new Set(values).size === values.length) })
])
export type PageReviewRoute = z.infer<typeof PageReviewRouteSchema>
export const PageReviewScheduleSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('accuracy-age') }),
  z.strictObject({ mode: z.literal('independent'), anchorAt: utc, intervalDays: z.number().int().min(1).max(3650), acknowledgeIndependentAccuracy: z.literal(true) })
])
export type PageReviewSchedule = z.infer<typeof PageReviewScheduleSchema>
const fence = { expectedSourceRevision: PageAccuracySourceRevisionSchema, expectedRoutingRevision: revision }
export const PageReviewCommandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('route'), ...fence, route: PageReviewRouteSchema }),
  z.strictObject({ command: z.literal('reset'), ...fence, mode: z.literal('contacts') }),
  z.strictObject({ command: z.literal('enable'), ...fence, enabled: z.boolean() }),
  z.strictObject({ command: z.literal('reschedule'), ...fence, schedule: PageReviewScheduleSchema }),
  z.strictObject({ command: z.literal('acknowledge'), ...fence, cycleId: z.uuid() }),
  z.strictObject({ command: z.literal('resend'), ...fence, cycleId: z.uuid(), userId: id, acknowledgePossibleDuplicate: z.literal(true) })
])
export type PageReviewCommand = z.infer<typeof PageReviewCommandSchema>
export const PageReviewPreviewSchema = z.strictObject({ ...fence, route: PageReviewRouteSchema.optional(), schedule: PageReviewScheduleSchema.optional() })
export const PageReviewDiagnosticSchema = z.enum(['disabled', 'no-current-contacts', 'no-eligible-recipients', 'opted-out', 'protected', 'unknown-clock', 'scheduled', 'queued', 'delivered', 'failed', 'unknown-email', 'suppressed'])
export const PageReviewViewSchema = z.strictObject({
  pageId: id, sourceRevision: PageAccuracySourceRevisionSchema, routingRevision: revision,
  mode: z.enum(['contacts', 'users', 'groups']), enabled: z.boolean(), schedule: PageReviewScheduleSchema,
  scheduleGeneration: PageAccuracySourceRevisionSchema,
  members: z.array(z.strictObject({ id, name: z.string().nullable(), unavailable: z.boolean() })),
  recipients: z.array(z.strictObject({ userId: id, name: z.string().nullable(), emailEnabled: z.boolean(), inAppEnabled: z.boolean() })),
  deliveries: z.array(z.strictObject({ userId: id, channel: z.enum(['in-app', 'email']), status: z.enum(['pending', 'sending', 'delivered', 'sent', 'suppressed', 'failed', 'unknown']), attempt: z.number().int().nonnegative(), acknowledgedAt: utc.nullable() })),
  diagnostic: PageReviewDiagnosticSchema, nextDueAt: utc.nullable(), currentDueAt: utc.nullable(), currentMilestone: z.string().nullable(), currentCycleId: z.uuid().nullable(),
  asOf: utc, accuracyUnaffected: z.literal(true)
})
export type PageReviewView = z.infer<typeof PageReviewViewSchema>
export type ReviewDue = { epochKey: string; milestone: string; dueAt: number; cycleNo: number | null; coalescedThrough: number | null; nextDueAt: number | null }
export type ReviewClock = { due: ReviewDue | null; nextDueAt: number | null; unknownClock: boolean }

/** Millisecond UTC arithmetic, never local calendar or now-plus-cadence arithmetic. */
export const independentReviewClock = (anchorAt: string, intervalDays: number, now: number): ReviewClock => {
  const anchor = Date.parse(anchorAt)
  if (!utc.safeParse(anchorAt).success || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650 || !Number.isFinite(now) || !Number.isFinite(anchor)) return { due: null, nextDueAt: null, unknownClock: true }
  if (now < anchor) return { due: null, nextDueAt: anchor, unknownClock: false }
  const step = intervalDays * REVIEW_DAY_MS
  const cycleNo = Math.floor((now - anchor) / step)
  const dueAt = anchor + cycleNo * step
  const nextDueAt = dueAt + step
  return { due: { epochKey: 'independent', milestone: `cycle:${cycleNo}`, dueAt, cycleNo, coalescedThrough: cycleNo > 0 ? cycleNo - 1 : null, nextDueAt }, nextDueAt, unknownClock: false }
}
export const accuracyReviewClock = (input: { sourceRevision: string; attestation: { id: string; sourceRevision: string; verifiedAt: unknown } | null; unverifiedAt: number; now: number }): ReviewClock => {
  const { sourceRevision, attestation, now, unverifiedAt } = input
  if (!PageAccuracySourceRevisionSchema.safeParse(sourceRevision).success || !Number.isFinite(now)) return { due: null, nextDueAt: null, unknownClock: true }
  if (!attestation || attestation.sourceRevision !== sourceRevision) {
    if (!Number.isFinite(unverifiedAt)) return { due: null, nextDueAt: null, unknownClock: true }
    return { due: now >= unverifiedAt ? { epochKey: `${sourceRevision}:unverified`, milestone: 'unverified', dueAt: unverifiedAt, cycleNo: null, coalescedThrough: null, nextDueAt: null } : null, nextDueAt: now < unverifiedAt ? unverifiedAt : null, unknownClock: false }
  }
  const verifiedAt = attestation.verifiedAt instanceof Date ? attestation.verifiedAt.valueOf() : typeof attestation.verifiedAt === 'string' && utc.safeParse(attestation.verifiedAt).success ? Date.parse(attestation.verifiedAt) : NaN
  if (!z.uuid().safeParse(attestation.id).success || !Number.isFinite(verifiedAt) || verifiedAt > now) return { due: null, nextDueAt: null, unknownClock: true }
  const soon = verifiedAt + 30 * REVIEW_DAY_MS
  const overdue = verifiedAt + 90 * REVIEW_DAY_MS + 1
  const epochKey = `${sourceRevision}:${attestation.id}`
  if (now < soon) return { due: null, nextDueAt: soon, unknownClock: false }
  if (now < overdue) return { due: { epochKey, milestone: 'review-soon', dueAt: soon, cycleNo: null, coalescedThrough: null, nextDueAt: overdue }, nextDueAt: overdue, unknownClock: false }
  return { due: { epochKey, milestone: 'needs-verification', dueAt: overdue, cycleNo: null, coalescedThrough: 0, nextDueAt: null }, nextDueAt: null, unknownClock: false }
}

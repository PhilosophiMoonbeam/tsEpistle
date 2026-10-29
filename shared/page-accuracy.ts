import { z } from 'zod'

const MAX_SOURCE_REVISION = '9223372036854775807'
export const PageAccuracySourceRevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .max(MAX_SOURCE_REVISION.length)
  .refine(value => value.length < MAX_SOURCE_REVISION.length || value <= MAX_SOURCE_REVISION, 'Source revision exceeds the database bigint range.')
const AccountIdSchema = z.number().int().positive().safe()
const TimestampSchema = z.iso.datetime()

export const VerifyPageAccuracyInputSchema = z.strictObject({
  expectedSourceRevision: PageAccuracySourceRevisionSchema
})
export type VerifyPageAccuracyInput = z.infer<typeof VerifyPageAccuracyInputSchema>

export const PageAccuracyAttestationSchema = z.strictObject({
  id: z.uuid(),
  pageId: AccountIdSchema,
  sourceRevision: PageAccuracySourceRevisionSchema,
  // Null means removed or withheld under the existing attribution privacy policy.
  verifiedBy: AccountIdSchema.nullable(),
  verifiedByName: z.string().min(1).nullable(),
  verifiedAt: TimestampSchema
})
export type PageAccuracyAttestation = z.infer<typeof PageAccuracyAttestationSchema>

export const PageAccuracyStatusSchema = z.enum(['verified-fresh', 'review-soon', 'needs-verification'])
export type PageAccuracyStatus = z.infer<typeof PageAccuracyStatusSchema>
export const PAGE_ACCURACY_DAY_MS = 86_400_000

/** Elapsed UTC time only: modification, transport and approval metadata are not proof. */
export const classifyPageAccuracy = (sourceRevision: unknown, attestation: unknown, now: number): PageAccuracyStatus => {
  if (!PageAccuracySourceRevisionSchema.safeParse(sourceRevision).success || !Number.isFinite(now)) return 'needs-verification'
  const parsed = PageAccuracyAttestationSchema.safeParse(attestation)
  if (!parsed.success || parsed.data.sourceRevision !== sourceRevision) return 'needs-verification'
  const age = now - Date.parse(parsed.data.verifiedAt)
  if (!Number.isFinite(age) || age < 0) return 'needs-verification'
  if (age < 30 * PAGE_ACCURACY_DAY_MS) return 'verified-fresh'
  return age <= 90 * PAGE_ACCURACY_DAY_MS ? 'review-soon' : 'needs-verification'
}

export const PageAccuracyViewSchema = z
  .strictObject({
    sourceRevision: PageAccuracySourceRevisionSchema,
    updatedAt: TimestampSchema,
    author: z.strictObject({ id: AccountIdSchema, name: z.string().min(1).nullable() }).nullable(),
    latestAttestation: PageAccuracyAttestationSchema.nullable(),
    canVerify: z.boolean(),
    asOf: TimestampSchema,
    status: PageAccuracyStatusSchema
  })
  .superRefine((value, context) => {
    if (value.latestAttestation !== null && value.latestAttestation.sourceRevision !== value.sourceRevision) {
      context.addIssue({ code: 'custom', path: ['latestAttestation'], message: 'Accuracy attestation must match the current source revision.' })
    }
    if (value.status !== classifyPageAccuracy(value.sourceRevision, value.latestAttestation, Date.parse(value.asOf))) {
      context.addIssue({ code: 'custom', path: ['status'], message: 'Accuracy status must match the server assessment time.' })
    }
  })
export type PageAccuracyView = z.infer<typeof PageAccuracyViewSchema>

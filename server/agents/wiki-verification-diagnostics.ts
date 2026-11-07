import { z } from 'zod'

/** Bounded metadata only: never retain source, candidate, provider labels or error bodies here. */
export interface WikiVerificationQuestionDiagnostic {
  readonly questionIndex: number
  readonly kind: 'support' | 'narration' | 'attachment-scope'
  readonly claimIndex: number | null
  readonly expected: 'supports' | 'bounded'
  readonly choice: 'supports' | 'contradicts' | 'not_supported' | 'bounded' | 'unbound' | 'not_established' | null
  readonly probabilities: Readonly<Record<string, number>> | null
  readonly confidence: number | null
  readonly accepted: boolean
  readonly reason: 'accepted' | 'unexpected_choice' | 'insufficient_probability' | 'invalid_response'
}

const WikiVerificationProbabilitySchema = z.number().finite().min(0).max(1)
const WikiVerificationQuestionDiagnosticSchema: z.ZodType<WikiVerificationQuestionDiagnostic> = z
  .strictObject({
    questionIndex: z.number().int().min(0).max(254),
    kind: z.enum(['support', 'narration', 'attachment-scope']),
    claimIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    expected: z.enum(['supports', 'bounded']),
    choice: z.enum(['supports', 'contradicts', 'not_supported', 'bounded', 'unbound', 'not_established']).nullable(),
    probabilities: z.record(z.string(), WikiVerificationProbabilitySchema).nullable(),
    confidence: WikiVerificationProbabilitySchema.nullable(),
    accepted: z.boolean(),
    reason: z.enum(['accepted', 'unexpected_choice', 'insufficient_probability', 'invalid_response'])
  })
  .superRefine((row, ctx) => {
    const invalid = (message: string): void => ctx.addIssue({ code: 'custom', message })
    if ((row.kind === 'support') !== (row.claimIndex !== null) || row.expected !== (row.kind === 'support' ? 'supports' : 'bounded'))
      invalid('Question kind, claim and expected choice must agree')
    const labels = row.expected === 'supports' ? ['supports', 'contradicts', 'not_supported'] : ['bounded', 'unbound', 'not_established']
    if (row.choice !== null && !labels.includes(row.choice)) invalid('Choice must belong to the issued label family')
    if (row.probabilities !== null) {
      const probabilities: Readonly<Record<string, number>> = row.probabilities
      if (Object.keys(probabilities).some(label => !labels.includes(label))) invalid('Probability labels must match the issued family')
      if (row.reason !== 'invalid_response') {
        if (!labels.every(label => Object.hasOwn(probabilities, label))) invalid('Valid answers require every issued probability')
        const total = Object.values(probabilities).reduce((sum, probability) => sum + probability, 0)
        if (Math.abs(total - 1) > 0.01 + Number.EPSILON * labels.length) invalid('Probabilities must sum to one within native precision')
      }
    }
    if (row.accepted !== (row.reason === 'accepted')) invalid('Acceptance and reason must agree')
    if (row.reason === 'invalid_response') return
    if (row.choice === null || row.probabilities === null || row.confidence === null) {
      invalid('Valid answers require the returned choice, probabilities and confidence')
      return
    }
    const probabilities: Readonly<Record<string, number>> = row.probabilities
    const expectedReason = row.choice !== row.expected ? 'unexpected_choice' : probabilities[row.expected]! > 0.8 ? 'accepted' : 'insufficient_probability'
    if (row.reason !== expectedReason) invalid('Reason must reflect selected expected probability, not confidence')
  })

export const WikiVerificationDiagnosticSchema = z
  .strictObject({
    version: z.literal(1),
    policy: z.literal('wiki-evidence-probability-v2'),
    minProbability: z.literal(0.8),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceScopes: z
      .array(z.enum(['complete-read', 'recent-excerpt', 'attachment']))
      .max(3)
      .refine(scopes => new Set(scopes).size === scopes.length, { message: 'Source scopes must be distinct' }),
    status: z.enum([
      'accepted',
      'semantic_rejection',
      'invalid_response',
      'transport_failure',
      'host_rejection',
      'cancelled',
      'receipt_rejection',
      'execution_failure'
    ]),
    questions: z.array(WikiVerificationQuestionDiagnosticSchema).max(64),
    omittedQuestions: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .superRefine((frame, ctx) => {
    const invalid = (message: string): void => ctx.addIssue({ code: 'custom', message })
    if (frame.questions.some((question, index) => question.questionIndex !== index)) invalid('Questions must preserve issuance order')
    if (frame.omittedQuestions > 255 - frame.questions.length || (frame.omittedQuestions > 0 && frame.questions.length !== 64))
      invalid('Question counts must fit the batch and persisted row limits')
    if (frame.status === 'accepted' && (frame.questions.length === 0 || frame.questions.some(question => !question.accepted)))
      invalid('Accepted batches require accepted answers')
    if (
      frame.status === 'semantic_rejection' &&
      (frame.questions.length === 0 ||
        frame.questions.some(question => question.reason === 'invalid_response') ||
        (frame.omittedQuestions === 0 && frame.questions.every(question => question.accepted)))
    )
      invalid('Semantic rejection requires a valid rejected answer')
    if (frame.status === 'invalid_response' && frame.questions.some(question => question.reason !== 'invalid_response'))
      invalid('Integrity-invalid batches cannot retain accepted rows')
  })
export type WikiVerificationDiagnostic = z.infer<typeof WikiVerificationDiagnosticSchema>

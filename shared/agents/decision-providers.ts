import { z } from 'zod'

const Name = z.string().trim().min(1).max(255)
const Model = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 0x1f || code === 0x7f) return false
    }
    return true
  })
export const DecisionProviderPricingSchema = z.strictObject({
  currency: z.literal('USD'),
  inputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  outputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  perRequest: z.number().finite().nonnegative().max(1_000_000),
  revision: z.string().min(1).max(128),
  source: z.string().min(1).max(512),
  verifiedAt: z.iso.date()
})
export type DecisionProviderPricing = z.infer<typeof DecisionProviderPricingSchema>

/** Explicit dialect: chat uses messages and choices[].message.content; legacy uses prompt and choices[].text. */
export const DecisionProviderConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('typesafe'),
    model: Model.refine(value => /^jev-(?:latest|preview|\d+\.\d+\.\d+)$/u.test(value)).default('jev-latest'),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    pricing: DecisionProviderPricingSchema.nullable().default(null)
  }),
  z.strictObject({
    kind: z.literal('openai-compatible'),
    model: Model,
    baseUrl: z.string().url().max(2_048),
    dialect: z.enum(['chat-completions', 'completions']),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    maxOutputTokens: z.number().int().min(64).max(4_096).default(1_024),
    pricing: DecisionProviderPricingSchema.nullable().default(null)
  })
])
export type DecisionProviderConfig = z.infer<typeof DecisionProviderConfigSchema>
export const DecisionProviderWriteSchema = z.strictObject({
  displayName: Name,
  config: DecisionProviderConfigSchema,
  // Values are write-only. Null explicitly clears managed credentials; omission retains them on update.
  secretValue: z
    .string()
    .min(1)
    .max(65_536)
    .regex(/^[\x21-\x7e]+$/u)
    .nullable()
    .optional()
})
export type DecisionProviderWrite = z.input<typeof DecisionProviderWriteSchema>
export interface DecisionProviderView {
  readonly id: string
  readonly displayName: string
  readonly revision: number
  readonly config: DecisionProviderConfig
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly secretConfigured: boolean
  readonly credentialSource: 'managed' | 'environment' | 'none'
  readonly checkedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}
export type DecisionJson = string | number | boolean | null | readonly DecisionJson[] | { readonly [key: string]: DecisionJson }
export type DecisionEntry = string | null | readonly DecisionJson[] | { readonly [key: string]: DecisionJson }
export interface DecisionRequest {
  readonly state: DecisionEntry
  readonly instructions: DecisionEntry
  readonly criteria: Readonly<Record<string, DecisionEntry>>
}
const DecisionTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Independent reported totals may include unclassified residual tokens; derived totals cannot. */
export const DecisionUsageSchema = z
  .strictObject({
    inputTokens: DecisionTokenCount,
    outputTokens: DecisionTokenCount,
    totalTokens: DecisionTokenCount,
    totalTokensSource: z.enum(['reported', 'derived'])
  })
  .refine(usage => {
    const sum = usage.inputTokens + usage.outputTokens
    return Number.isSafeInteger(sum) && usage.totalTokens >= sum && (usage.totalTokensSource !== 'derived' || usage.totalTokens === sum)
  })
export type DecisionUsage = Readonly<z.infer<typeof DecisionUsageSchema>>

export interface DecisionResult {
  readonly providerId: string
  readonly providerRevision: number
  readonly model: string
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
  readonly usage: DecisionUsage
  readonly latencyMs: number
  /** Configured estimate, never provider-measured billing. Null means pricing is unknown. */
  readonly estimatedCost: {
    readonly currency: 'USD'
    readonly amount: number
    readonly pricingRevision: string
    readonly source: string
    readonly verifiedAt: string
  } | null
  readonly estimatedCostMicros: number | null
}
export interface DecisionProviderCheck {
  readonly availableModels: readonly string[]
  readonly configuredModelAvailable: boolean
  readonly model: string
  readonly latencyMs: number
  readonly usage: DecisionResult['usage']
  readonly estimatedCostMicros: number | null
  readonly estimatedCost: DecisionResult['estimatedCost']
}
export const TYPESAFE_DECISION_PROVIDER_ID = '00000000-0000-4000-8000-000000000001'
/** Official Jev 1.13 pricing, reviewed 2026-10-04; not inherited by arbitrary/custom models. */
export const TYPESAFE_JEV_PRICING: DecisionProviderPricing = {
  currency: 'USD',
  inputPerMillion: 0.042,
  outputPerMillion: 0,
  perRequest: 0,
  revision: 'typesafe-jev-1.13.0-2026-10-04',
  source: 'https://docs.typesafe.ai/models',
  verifiedAt: '2026-10-04'
}

export interface DecisionProviderActor {
  readonly id: number
  readonly authVersion?: number
}

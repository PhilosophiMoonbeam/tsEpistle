import { z } from 'zod'
import type { AgentProviderCapabilities } from './contracts.ts'
import type { DecisionProviderActor, DecisionResult } from './decision-providers.ts'

export const ROUTING_TASK_CLASSES = ['conversation', 'retrieval', 'writing', 'coding', 'analysis', 'planning'] as const
export const ROUTING_COMPLEXITIES = ['simple', 'moderate', 'complex'] as const
export const RoutingTaskClassSchema = z.enum(ROUTING_TASK_CLASSES)
export const RoutingComplexitySchema = z.enum(ROUTING_COMPLEXITIES)
export type RoutingTaskClass = z.infer<typeof RoutingTaskClassSchema>
export type RoutingComplexity = z.infer<typeof RoutingComplexitySchema>
export const RoutingPolicyInputSchema = z.strictObject({
  enabled: z.boolean(),
  decisionProviderId: z.uuid().nullable(),
  minimumConfidence: z.number().finite().min(0.8).max(1),
  minimumSavingsRatio: z.number().finite().min(0.05).max(1),
  minimumSavingsMicros: z.number().int().min(1).max(1_000_000_000),
  switchCostMicros: z.number().int().nonnegative().max(1_000_000_000),
  classifierMaxStateBytes: z.number().int().min(256).max(16_384)
})
export type RoutingPolicyInput = z.infer<typeof RoutingPolicyInputSchema>
export const DEFAULT_ROUTING_POLICY: RoutingPolicyInput = {
  enabled: false,
  decisionProviderId: null,
  minimumConfidence: 0.95,
  minimumSavingsRatio: 0.2,
  minimumSavingsMicros: 1_000,
  switchCostMicros: 1_000,
  classifierMaxStateBytes: 4_096
}
export const RoutingModelPolicyInputSchema = z
  .strictObject({
    profileVersionId: z.uuid(),
    acceptableTasks: z
      .array(z.strictObject({ taskClass: RoutingTaskClassSchema, complexities: z.array(RoutingComplexitySchema).min(1).max(3) }))
      .min(1)
      .max(6),
    estimatedLatencyMs: z.number().int().positive().max(3_600_000).nullable()
  })
  .superRefine((value, context) => {
    if (
      new Set(value.acceptableTasks.map(task => task.taskClass)).size !== value.acceptableTasks.length ||
      value.acceptableTasks.some(task => new Set(task.complexities).size !== task.complexities.length)
    )
      context.addIssue({ code: 'custom', message: 'Task classes and complexities must be unique' })
  })
export type RoutingModelPolicyInput = z.infer<typeof RoutingModelPolicyInputSchema>
export const RoutingPolicyViewSchema = RoutingPolicyInputSchema.extend({ revision: z.number().int().positive(), updatedAt: z.iso.datetime().nullable() })
export const RoutingModelPolicyViewSchema = z.strictObject({
  profileId: z.uuid(),
  revision: z.number().int().positive(),
  profileVersionId: z.uuid(),
  acceptableTasks: RoutingModelPolicyInputSchema.shape.acceptableTasks,
  estimatedLatencyMs: RoutingModelPolicyInputSchema.shape.estimatedLatencyMs,
  updatedAt: z.iso.datetime()
})
export type RoutingPolicyView = z.infer<typeof RoutingPolicyViewSchema>
export type RoutingModelPolicyView = z.infer<typeof RoutingModelPolicyViewSchema>
export const RoutingAdminViewSchema = z.strictObject({ policy: RoutingPolicyViewSchema, models: z.array(RoutingModelPolicyViewSchema) })
export type RoutingAdminView = z.infer<typeof RoutingAdminViewSchema>
export type RoutingActor = DecisionProviderActor

/** Supplied only by the live owner-scoped provider registry; never accepted from HTTP bodies. */
export interface RoutingCandidate {
  readonly profileId: string
  readonly profileVersionId: string
  readonly model: string
  readonly enabled: boolean
  readonly authorized: boolean
  readonly credentialReady: boolean
  readonly conformed: boolean
  readonly capabilities: AgentProviderCapabilities
  readonly modalities: readonly ('text' | 'image' | 'audio' | 'video' | 'file')[]
  readonly generationTools?: readonly ('image' | 'video' | 'music')[]
  readonly transcription?: boolean
  /** Candidate-specific canonical replay estimate including its provider framing/tools/schema, never observed usage or reused compaction. */
  readonly canonicalReplayInputTokens?: number
  readonly pricing: { readonly inputPerMillion: number; readonly outputPerMillion: number; readonly revision: string } | null
}
export interface RoutingRequirements {
  readonly modalities: readonly ('text' | 'image' | 'audio' | 'video' | 'file')[]
  readonly nativeTools: boolean
  readonly nativeExternalMcp: boolean
  readonly nativeSchema: boolean
  readonly minimumOutputTokens: number
  readonly generationTools?: readonly ('image' | 'video' | 'music')[]
  readonly transcription?: boolean
}
export interface RoutingTurnInput {
  readonly ownerId: number
  readonly sessionId: string
  readonly runId: string
  readonly pinned: boolean
  readonly current: RoutingCandidate
  readonly candidates: readonly RoutingCandidate[]
  readonly requirements: RoutingRequirements
  /** Estimates, not measured usage. Incumbent includes its usable compaction; alternate always replays canonical history. */
  readonly currentInputTokens: number
  readonly fullHistoryInputTokens: number
  readonly expectedOutputTokens: number
  readonly classifierState: { readonly currentMessage: string; readonly recentSummary?: string }
  readonly signal?: AbortSignal
  readonly recordedDecision?: RoutingTurnDecision
}
export interface RoutingTurnDecision {
  readonly version: 1
  readonly ownerId: number
  readonly sessionId: string
  readonly runId: string
  readonly policyRevision: number
  readonly profileId: string
  readonly profileVersionId: string
  readonly modelPolicyRevision: number | null
  readonly switched: boolean
  readonly reason: string
  readonly taskClass: RoutingTaskClass | null
  readonly complexity: RoutingComplexity | null
  readonly classification: DecisionResult | null
  /** Conservative quota bound, not measured usage. Compatible input uses an explicitly labelled UTF8-byte tokenization proxy. */
  readonly classifierReservation: {
    readonly tokens: number
    readonly costMicros: number
    readonly basis: 'documented-native-context' | 'serialized-byte-proxy'
    readonly source: string
  } | null
  /** Preflight estimate from serialized bytes/framing, independently labelled and never substituted for reported usage. */
  readonly classifierExpectedCost: { readonly costMicros: number; readonly basis: 'serialized-byte-proxy'; readonly source: string } | null
  readonly classifierFailure: {
    readonly code: string
    readonly providerId: string | null
    readonly providerRevision: number | null
    readonly usage: DecisionResult['usage'] | null
    readonly latencyMs: number | null
    readonly estimatedCostMicros: number | null
  } | null
  readonly estimatedCurrentCostMicros: number | null
  readonly estimatedSelectedCostMicros: number | null
  readonly estimatedSavingsMicros: number | null
  /** Unmeasured failure exposure stays reserved/accounted; never interpreted as free. */
  readonly unknownExposure: { readonly tokens: number; readonly costMicros: number } | null
}
export interface RoutingBudgetReservation {
  readonly id: number
  readonly tokens: number
  readonly costMicros: number
}
export interface RoutingTurnHooks {
  readonly budget: {
    reserve(maximum: { readonly tokens: number; readonly costMicros: number }): Promise<RoutingBudgetReservation>
    reconcile(
      reservation: RoutingBudgetReservation,
      actual: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly costMicros: number }
    ): Promise<void>
    release(reservation: RoutingBudgetReservation): Promise<void>
  }
  /** Durably store selection AND classification usage in the existing owner/run fenced event before returning. */
  checkpoint(decision: RoutingTurnDecision): Promise<void>
}

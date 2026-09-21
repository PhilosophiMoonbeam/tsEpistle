import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentEventData } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError } from './repository.ts'

export const AGENT_COMPACTION_VERSION = 1
export const AGENT_COMPACTION_MAX_SUMMARY_BYTES = 32_768
export const AGENT_COMPACTION_OUTCOMES = ['context_compacted', 'context_compaction_rejected'] as const
export const AGENT_GROUNDED_HISTORY_DAYS = 2 * 365

export const agentGroundedExpiry = (createdAt: Date | string): string => {
  const milliseconds = new Date(createdAt).valueOf()
  if (!Number.isFinite(milliseconds)) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored context creation time is invalid', 500)
  return new Date(milliseconds + AGENT_GROUNDED_HISTORY_DAYS * 86_400_000).toISOString()
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const identity = z.string().min(1).max(256)
const expiry = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .nullable()
const metadataFields = {
  version: z.literal(AGENT_COMPACTION_VERSION),
  ownerId: z.number().int().positive(),
  sessionId: identity,
  sourceRunId: identity,
  providerProfileVersionId: identity,
  transportKind: identity,
  model: identity,
  capabilityRevision: identity,
  sourceSha256: digest,
  summarySha256: digest,
  groundedExpiresAt: expiry
}
const metadataSchema = z.discriminatedUnion('scope', [
  z.object({ ...metadataFields, scope: z.literal('history'), throughMessageId: identity, throughOrdinal: z.number().int().nonnegative() }).strict(),
  z.object({ ...metadataFields, scope: z.literal('active'), throughMessageId: z.null(), throughOrdinal: z.null() }).strict()
])

export type AgentCompactionMetadata = z.infer<typeof metadataSchema>
export type AgentHistoryCompactionMetadata = Extract<AgentCompactionMetadata, { readonly scope: 'history' }>
export interface AgentCompactionCanonicalSource {
  readonly id: string
  readonly ordinal: number
  readonly sourceSha256: string
  readonly groundedExpiresAt: string | null
}
export interface AgentCompactionCheckpoint {
  readonly content: string
  readonly metadata: AgentHistoryCompactionMetadata
}
export interface AgentCompactionContext {
  readonly checkpoint?: AgentCompactionCheckpoint
  /** Prefix digests are aligned with the canonical request messages, before any projection. */
  readonly sourcePrefixSha256: readonly string[]
  readonly groundedExpiresAt: string | null
}
export interface AgentCompactionReceipt {
  readonly turn: number
  readonly outcome: 'context_compacted'
  readonly usageVersion: 2
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly content: string
  readonly contentTruncated: false
  readonly actionCallIds: readonly string[]
  readonly finishReason?: string
  readonly groundedExpiresAt: string | null
  readonly compaction: AgentCompactionMetadata
}
export interface AgentCompactionExposure {
  readonly inputExposureTokens: number
  readonly outputExposureTokens: number
  readonly totalExposureTokens: number
  readonly costMicros: number
  readonly attempts: number
}
export interface AgentCompactionPolicy {
  readonly summaryOutputTokens: number
  readonly summaryBytes: number
  readonly narrativeTokens: number
  readonly triggerExposureTokens: number
  readonly turnBoundaryTriggerExposureTokens: number
  readonly targetExposureTokens: number
  readonly recentExposureTokens: number
}

export const agentCompactionSha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** The bound is on encoded content, not a presumed token-to-character ratio. */
export const agentCompactionSummaryBytes = (content: string): number => Buffer.byteLength(JSON.stringify(content), 'utf8')

export const agentCompactionPolicy = (contextTokens: number, profileOutputTokens: number, ordinaryOutputTokens: number): AgentCompactionPolicy => {
  const summaryOutputTokens = Math.max(1, Math.min(8_192, profileOutputTokens, Math.floor(contextTokens / 32)))
  const reserve = Math.max(0, contextTokens - ordinaryOutputTokens - 2 * summaryOutputTokens)
  const triggerExposureTokens = Math.max(0, Math.min(reserve, Math.floor(contextTokens * 0.9)))
  return {
    summaryOutputTokens,
    summaryBytes: Math.max(1, Math.min(AGENT_COMPACTION_MAX_SUMMARY_BYTES, Math.floor(contextTokens / 8))),
    narrativeTokens: Math.max(1, Math.min(4_096, Math.floor(summaryOutputTokens / 2))),
    triggerExposureTokens,
    turnBoundaryTriggerExposureTokens: Math.max(0, Math.min(triggerExposureTokens, Math.floor(contextTokens * 0.75))),
    targetExposureTokens: Math.max(0, Math.min(Math.floor(contextTokens * 0.6), triggerExposureTokens - summaryOutputTokens)),
    recentExposureTokens: Math.max(1, Math.min(20_000, Math.floor(contextTokens / 8)))
  }
}

export const agentCompactionMinimumExpiry = (...values: readonly (string | null | undefined)[]): string | null => {
  let earliest: string | null = null
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (!expiry.safeParse(value).success) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored context expiry is invalid', 500)
    if (earliest === null || value < earliest) earliest = value
  }
  return earliest
}

/** A chained digest avoids repeatedly hashing the entire growing history for each possible cut. */
export const agentCompactionSourcePrefixes = (sources: readonly AgentCompactionCanonicalSource[]): readonly string[] => {
  let previous = agentCompactionSha256('wiki.agent.context-compaction.v1')
  return sources.map(source => {
    previous = agentCompactionSha256(`${previous}:${canonicalJson(source)}`)
    return previous
  })
}

export const agentCompactionSourceDigest = (source: Readonly<Record<string, unknown>>): string => agentCompactionSha256(canonicalJson(source))

export const readAgentCompactionMetadata = (value: unknown): AgentCompactionMetadata => {
  const parsed = metadataSchema.safeParse(value)
  if (!parsed.success) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored context compaction metadata is invalid', 500)
  return parsed.data
}

export const readAgentCompactionCheckpoint = (data: AgentEventData): AgentCompactionCheckpoint | null => {
  if (data.outcome !== 'context_compacted') return null
  const metadata = readAgentCompactionMetadata(data.compaction)
  // Retention removes prose, never its accounting receipt. An expired receipt is not a checkpoint.
  if (data.contentPurged === true) return null
  if (
    data.usageVersion !== 2 ||
    data.finishReason !== 'stop' ||
    !Array.isArray(data.actionCallIds) ||
    data.actionCallIds.length !== 0 ||
    typeof data.content !== 'string' ||
    data.content.trim().length === 0 ||
    data.contentTruncated !== false ||
    agentCompactionSummaryBytes(data.content) > AGENT_COMPACTION_MAX_SUMMARY_BYTES ||
    agentCompactionSha256(data.content) !== metadata.summarySha256
  )
    throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Stored context compaction summary is invalid', 500)
  return metadata.scope === 'history' ? { content: data.content, metadata } : null
}

export const agentCompactionBindingMatches = (
  metadata: AgentCompactionMetadata,
  binding: {
    readonly ownerId: number
    readonly sessionId: string
    readonly providerProfileVersionId: string
    readonly transportKind: string
    readonly model: string
    readonly capabilityRevision: string
  }
): boolean =>
  metadata.ownerId === binding.ownerId &&
  metadata.sessionId === binding.sessionId &&
  metadata.providerProfileVersionId === binding.providerProfileVersionId &&
  metadata.transportKind === binding.transportKind &&
  metadata.model === binding.model &&
  metadata.capabilityRevision === binding.capabilityRevision

export const isAgentCompactionOutcome = (value: unknown): boolean => value === 'context_compacted' || value === 'context_compaction_rejected'

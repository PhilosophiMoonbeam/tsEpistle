import { z } from 'zod'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from './orchestration.ts'

const AgentOperationalLimitsSchema = z.object({
  provider: z.object({
    globalConcurrency: z.number().int().min(1).max(128).default(4),
    perUserConcurrency: z.number().int().min(1).max(32).default(1),
    pollingMilliseconds: z.number().int().min(250).max(60_000).default(1_000)
  }).passthrough(),
  orchestration: z.object({
    enabled: z.boolean().default(false),
    maxConcurrentChildren: z.number().int().min(1).max(8).default(3),
    maxChildren: z.number().int().min(2).max(32).default(6),
    plannerTurns: z.number().int().min(1).max(4).default(2),
    childTurns: z.number().int().min(1).max(8).default(4),
    childToolCalls: z.number().int().min(1).max(16).default(8),
    plannerTimeoutMilliseconds: z.number().int().min(5_000).max(120_000).default(30_000),
    childTimeoutMilliseconds: z.number().int().min(10_000).max(10 * 60_000).default(120_000),
    plannerMaxOutputTokens: z.number().int().min(256).max(4_096).default(1_024),
    childMaxOutputTokens: z.number().int().min(256).max(8_192).default(2_048),
    maxAggregateChildTokens: z.number().int().min(1_000).max(100_000).default(12_000),
    maxAggregateChildOutputCharacters: z.number().int().min(16_000).max(512_000).default(96_000)
  }).passthrough().default(DEFAULT_AGENT_ORCHESTRATION_LIMITS),
  retention: z.object({
    temporarySessionHours: z.number().int().min(1).max(30 * 24).default(24),
    savedSessionDays: z.number().int().min(1).max(10 * 365).default(90),
    mcpContentDays: z.number().int().min(1).max(365).default(7),
    auditDays: z.number().int().min(1).max(10 * 365).default(90),
    maintenanceBatchSize: z.number().int().min(1).max(10_000).default(100)
  }).passthrough(),
  sse: z.object({
    maximumConnectionsPerUser: z.number().int().min(1).max(20).default(3)
  }).passthrough().default({ maximumConnectionsPerUser: 3 }),
}).passthrough()
  .refine(value => value.provider.perUserConcurrency <= value.provider.globalConcurrency, {
    message: 'per-user provider concurrency cannot exceed global provider concurrency',
    path: ['provider', 'perUserConcurrency']
  })
  .refine(value => value.orchestration.maxConcurrentChildren <= value.orchestration.maxChildren, {
    message: 'orchestration concurrency cannot exceed the child limit',
    path: ['orchestration', 'maxConcurrentChildren']
  })

export type AgentOperationalLimits = z.infer<typeof AgentOperationalLimitsSchema>

export const parseAgentOperationalLimits = (agents: unknown): AgentOperationalLimits => AgentOperationalLimitsSchema.parse(agents)

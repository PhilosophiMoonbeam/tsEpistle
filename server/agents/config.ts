import { z } from 'zod'

const AgentOperationalLimitsSchema = z.object({
  provider: z.object({
    globalConcurrency: z.number().int().min(1).max(128).default(4),
    perUserConcurrency: z.number().int().min(1).max(32).default(1),
    pollingMilliseconds: z.number().int().min(250).max(60_000).default(1_000)
  }).passthrough(),
  retention: z.object({
    temporarySessionHours: z.number().int().min(1).max(30 * 24).default(24),
    mcpContentDays: z.number().int().min(1).max(365).default(7),
    auditDays: z.number().int().min(1).max(10 * 365).default(90),
    maintenanceBatchSize: z.number().int().min(1).max(10_000).default(100)
  }).passthrough(),
  sse: z.object({
    maximumConnectionsPerUser: z.number().int().min(1).max(20).default(3)
  }).passthrough().default({ maximumConnectionsPerUser: 3 }),
}).passthrough().refine(value => value.provider.perUserConcurrency <= value.provider.globalConcurrency, {
  message: 'per-user provider concurrency cannot exceed global provider concurrency',
  path: ['provider', 'perUserConcurrency']
})

export type AgentOperationalLimits = z.infer<typeof AgentOperationalLimitsSchema>

export const parseAgentOperationalLimits = (agents: unknown): AgentOperationalLimits => AgentOperationalLimitsSchema.parse(agents)

import knexModule from 'knex'
import { runAgentMaintenance, type AgentMaintenancePolicy } from '../agents/maintenance.ts'

const { knex: createKnex } = knexModule

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

const connection = process.env.AGENT_MAINTENANCE_DATABASE_URL?.trim()
if (!connection) throw new Error('AGENT_MAINTENANCE_DATABASE_URL is required')

const policy: AgentMaintenancePolicy = {
  batchSize: positiveInteger('AGENT_MAINTENANCE_BATCH_SIZE', 100),
  savedSessionDays: positiveInteger('AGENT_MAINTENANCE_SAVED_SESSION_DAYS', 90),
  mcpContentDays: positiveInteger('AGENT_MAINTENANCE_MCP_CONTENT_DAYS', 7),
  auditDays: positiveInteger('AGENT_MAINTENANCE_AUDIT_DAYS', 90),
  compactDeltaDays: positiveInteger('AGENT_MAINTENANCE_COMPACT_DELTA_DAYS', 1)
}
const maxBatches = positiveInteger('AGENT_MAINTENANCE_MAX_BATCHES', 100)
const knex = createKnex({ client: 'pg', connection, pool: { min: 0, max: 1 } })

try {
  const totals: Record<string, number> = {}
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await runAgentMaintenance(knex, policy)
    let changed = 0
    for (const [name, count] of Object.entries(result)) {
      totals[name] = (totals[name] ?? 0) + count
      changed += count
    }
    if (changed === 0) break
  }
  process.stdout.write(`${JSON.stringify({ maintenance: 'complete', totals })}\n`)
} finally {
  await knex.destroy()
}

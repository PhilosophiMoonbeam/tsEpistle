import knexModule from 'knex'
import { runAgentMaintenance, type AgentMaintenancePolicy, type AgentMaintenanceResult } from '../agents/maintenance.ts'

const { knex: createKnex } = knexModule

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

interface MaintenanceCompleteSummary {
  readonly maintenance: 'complete'
  readonly truncated: false
  readonly zeroChangeBatchObserved: true
  readonly batches: number
  readonly maxBatches: number
  readonly totals: Readonly<Record<string, number>>
  readonly remainingRisk: null
}

interface MaintenanceExhaustedSummary {
  readonly maintenance: 'exhausted'
  readonly truncated: true
  readonly zeroChangeBatchObserved: false
  readonly batches: number
  readonly maxBatches: number
  readonly totals: Readonly<Record<string, number>>
  readonly remainingRisk: {
    readonly reason: 'max_batches_reached'
    readonly rowsMayRemain: true
  }
}

export type AgentMaintenanceScriptSummary = MaintenanceCompleteSummary | MaintenanceExhaustedSummary

export interface AgentMaintenanceScriptResult {
  readonly summary: AgentMaintenanceScriptSummary
  readonly exitCode: 0 | 1
}

export const runAgentMaintenanceBatches = async (
  runBatch: () => Promise<AgentMaintenanceResult>,
  maxBatches: number
): Promise<AgentMaintenanceScriptResult> => {
  const totals: Record<string, number> = {}
  let batches = 0
  let zeroChangeBatchObserved = false

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await runBatch()
    let changed = 0
    for (const [name, count] of Object.entries(result)) {
      totals[name] = (totals[name] ?? 0) + count
      changed += count
    }
    batches = batch + 1
    if (changed === 0) {
      zeroChangeBatchObserved = true
      break
    }
  }

  if (zeroChangeBatchObserved) {
    return {
      summary: {
        maintenance: 'complete',
        truncated: false,
        zeroChangeBatchObserved: true,
        batches,
        maxBatches,
        totals,
        remainingRisk: null
      },
      exitCode: 0
    }
  }

  return {
    summary: {
      maintenance: 'exhausted',
      truncated: true,
      zeroChangeBatchObserved: false,
      batches,
      maxBatches,
      totals,
      remainingRisk: {
        reason: 'max_batches_reached',
        rowsMayRemain: true
      }
    },
    exitCode: 1
  }
}

const main = async (): Promise<void> => {
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
    const result = await runAgentMaintenanceBatches(() => runAgentMaintenance(knex, policy), maxBatches)
    process.stdout.write(`${JSON.stringify(result.summary)}\n`)
    process.exitCode = result.exitCode
  } finally {
    await knex.destroy()
  }
}

if (import.meta.main) await main()

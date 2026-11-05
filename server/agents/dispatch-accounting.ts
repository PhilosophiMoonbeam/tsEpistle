import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { assertAgentTokenUsage } from './providers/usage.ts'
import { AgentRepositoryError } from './repository.ts'

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const exposureSchema = z.strictObject({ tokens: amount, costMicros: amount })
const usageSchema = z.strictObject({ inputTokens: amount, outputTokens: amount, totalTokens: amount, costMicros: amount })
const baselineSchema = z.strictObject({ usage: usageSchema, exposure: exposureSchema })
export const AgentDispatchAccountingRecordSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    version: z.literal(1),
    operation: z.literal('reserved'),
    dispatchId: z.uuid(),
    exposure: exposureSchema,
    baseline: baselineSchema.optional()
  }),
  z.strictObject({ version: z.literal(1), operation: z.literal('reconciled'), dispatchId: z.uuid(), usage: usageSchema }),
  z.strictObject({ version: z.literal(1), operation: z.literal('released'), dispatchId: z.uuid() })
])
export type AgentDispatchAccountingRecord = z.infer<typeof AgentDispatchAccountingRecordSchema>
export type AgentDispatchAccountingState = z.infer<typeof baselineSchema>

const corrupt = (): never => {
  throw new AgentRepositoryError('AGENT_QUOTA_CORRUPT', 'Stored dispatch accounting is incomplete or invalid', 500)
}
const sum = (left: number, right: number): number => {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) return corrupt()
  return result
}

/**
 * The first reservation freezes pre-journal measured usage and unknown exposure.
 * Thereafter these identified records, not later presentation/model.turn events,
 * own accounting. A receipt committed immediately before worker death therefore
 * survives even when its presentation event never exists, and is never added a
 * second time when that presentation does exist. No aggregate quota hold is
 * treated as dispatched: unused parent sequence/admission capacity is not billed.
 *
 * Storage is additive (agentEvents, schemaVersion 1; payload version 1). Deploy
 * only after old workers drain. Old binaries cannot safely resume journaled runs;
 * rollback requires a journal-aware binary or settling those runs before rollback.
 */
export const readAgentDispatchAccounting = async (database: Knex | Knex.Transaction, runId: string): Promise<AgentDispatchAccountingState | null> => {
  const rows = (await database('agentEvents').where({ runId, type: 'dispatch.accounting' }).orderBy('sequence').select('data', 'dataSha256')) as Array<{
    data: string
    dataSha256: string
  }>
  if (rows.length === 0) return null
  let state: AgentDispatchAccountingState | undefined
  const active = new Map<string, z.infer<typeof exposureSchema>>()
  const identified = new Set<string>()
  for (const row of rows) {
    if (createHash('sha256').update(row.data).digest('hex') !== row.dataSha256) return corrupt()
    let record: AgentDispatchAccountingRecord
    try {
      record = AgentDispatchAccountingRecordSchema.parse(JSON.parse(row.data))
    } catch {
      return corrupt()
    }
    if (record.operation === 'reserved') {
      if (identified.has(record.dispatchId)) return corrupt()
      if (state === undefined) {
        if (record.baseline === undefined) return corrupt()
        state = record.baseline
        try {
          assertAgentTokenUsage(state.usage.inputTokens, state.usage.outputTokens, state.usage.totalTokens)
        } catch {
          return corrupt()
        }
      } else if (record.baseline !== undefined) return corrupt()
      identified.add(record.dispatchId)
      active.set(record.dispatchId, record.exposure)
      continue
    }
    if (state === undefined || !active.delete(record.dispatchId)) return corrupt()
    if (record.operation === 'reconciled') {
      const usage = record.usage
      try {
        assertAgentTokenUsage(usage.inputTokens, usage.outputTokens, usage.totalTokens)
      } catch {
        return corrupt()
      }
      state.usage.inputTokens = sum(state.usage.inputTokens, usage.inputTokens)
      state.usage.outputTokens = sum(state.usage.outputTokens, usage.outputTokens)
      state.usage.totalTokens = sum(state.usage.totalTokens, usage.totalTokens)
      state.usage.costMicros = sum(state.usage.costMicros, usage.costMicros)
    }
  }
  if (state === undefined) return corrupt()
  for (const exposure of active.values()) {
    state.exposure.tokens = sum(state.exposure.tokens, exposure.tokens)
    state.exposure.costMicros = sum(state.exposure.costMicros, exposure.costMicros)
  }
  return state
}

import type { Knex } from 'knex'

const TABLE = 'agentRuns'
const COLUMN = 'totalTokens'
const CHECK = 'agent_runs_total_tokens_check'
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/
const INVALID_LEGACY_USAGE = 'Cannot backfill agent run token totals: legacy directional token usage is invalid'

type LegacyRunRow = {
  readonly id: string
  readonly inputTokens: unknown
  readonly outputTokens: unknown
}

const isPostgres = (knex: Knex | Knex.Transaction): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

const safeLegacyTokenCount = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(INVALID_LEGACY_USAGE)
    return value
  }

  let parsed: bigint
  if (typeof value === 'bigint') parsed = value
  else if (typeof value === 'string' && DECIMAL_INTEGER.test(value)) {
    try {
      parsed = BigInt(value)
    } catch {
      throw new Error(INVALID_LEGACY_USAGE)
    }
  } else {
    throw new Error(INVALID_LEGACY_USAGE)
  }

  if (parsed < 0n || parsed > MAX_SAFE_INTEGER_BIGINT) throw new Error(INVALID_LEGACY_USAGE)
  return Number(parsed)
}

const safeLegacyTokenSum = (row: LegacyRunRow): number => {
  const inputTokens = safeLegacyTokenCount(row.inputTokens)
  const outputTokens = safeLegacyTokenCount(row.outputTokens)
  if (inputTokens > Number.MAX_SAFE_INTEGER - outputTokens) throw new Error(INVALID_LEGACY_USAGE)
  return inputTokens + outputTokens
}

const addTotalCheck = async (knex: Knex | Knex.Transaction): Promise<void> => {
  if (!isPostgres(knex)) return
  await knex.raw(
    `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${CHECK}" CHECK ("inputTokens" >= 0 AND "inputTokens" <= ${Number.MAX_SAFE_INTEGER} AND "outputTokens" >= 0 AND "outputTokens" <= ${Number.MAX_SAFE_INTEGER} AND "${COLUMN}" >= 0 AND "${COLUMN}" <= ${Number.MAX_SAFE_INTEGER} AND "${COLUMN}" >= "inputTokens" + "outputTokens")`
  )
}

const dropTotalCheck = async (knex: Knex | Knex.Transaction): Promise<void> => {
  if (!isPostgres(knex)) return
  await knex.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK}"`)
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE)) || (await knex.schema.hasColumn(TABLE, COLUMN))) return

  await knex.transaction(async transaction => {
    const rows = await transaction<LegacyRunRow>(TABLE).select('id', 'inputTokens', 'outputTokens')
    const totals = rows.map(row => ({ id: row.id, totalTokens: safeLegacyTokenSum(row) }))

    await transaction.schema.alterTable(TABLE, table => {
      table.bigInteger(COLUMN).notNullable().defaultTo(0)
    })

    for (const row of totals) {
      const updated = await transaction(TABLE)
        .where({ id: row.id })
        .update({ [COLUMN]: row.totalTokens })
      if (updated !== 1) throw new Error(INVALID_LEGACY_USAGE)
    }

    await addTotalCheck(transaction)
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return

  await knex.transaction(async transaction => {
    await dropTotalCheck(transaction)
    await transaction.schema.alterTable(TABLE, table => table.dropColumn(COLUMN))
  })
}

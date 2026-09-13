import type { Knex } from 'knex'

const TABLE = 'analytics'
const PROVIDER = 'yandex'
const FIELD = 'webvisor'
const ROLLBACK_ERROR = 'Cannot discard the explicit Yandex session replay setting. Restore a backup or apply a forward fix.'

type AnalyticsRow = {
  readonly isEnabled: unknown
  readonly key: string
  readonly config: unknown
}

const configRecord = (value: unknown): Record<string, unknown> | null => {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE))) return

  await knex.transaction(async transaction => {
    const row = await transaction<AnalyticsRow>(TABLE).where({ key: PROVIDER }).forUpdate().first('isEnabled', 'config')
    const config = configRecord(row?.config)
    if (!row || config === null || Object.hasOwn(config, FIELD)) return

    await transaction(TABLE)
      .where({ key: PROVIDER })
      .update({ config: JSON.stringify({ ...config, [FIELD]: row.isEnabled === true || row.isEnabled === 1 ? 'true' : 'false' }) })
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE))) return
  const row = await knex<AnalyticsRow>(TABLE).where({ key: PROVIDER }).first('config')
  const config = configRecord(row?.config)
  if (config !== null && Object.hasOwn(config, FIELD)) throw new Error(ROLLBACK_ERROR)
}

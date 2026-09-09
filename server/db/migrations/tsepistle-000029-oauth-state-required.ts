import type { Knex } from 'knex'

const AUTHENTICATION_TABLE = 'authentication'
const OAUTH2_STRATEGY = 'oauth2'
const CSRF_OPTION = 'enableCSRFProtection'

type JsonObject = Record<string, unknown>

type AuthenticationRow = {
  readonly key: string
  readonly strategyKey: string
  readonly config: unknown
}

type ParsedConfig = {
  readonly config: JsonObject
  readonly wasString: boolean
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseConfig = (value: unknown): ParsedConfig | null => {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isJsonObject(parsed) ? { config: parsed, wasString: true } : null
    } catch {
      return null
    }
  }
  return isJsonObject(value) ? { config: value, wasString: false } : null
}

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const rows = await transaction<AuthenticationRow>(AUTHENTICATION_TABLE)
      .select('key', 'strategyKey', 'config')

    for (const row of rows) {
      if (row.strategyKey !== OAUTH2_STRATEGY) continue

      const parsed = parseConfig(row.config)
      if (parsed === null || !Object.hasOwn(parsed.config, CSRF_OPTION)) continue

      const config = { ...parsed.config }
      delete config[CSRF_OPTION]
      await transaction(AUTHENTICATION_TABLE)
        .where({ key: row.key })
        .update({ config: parsed.wasString ? JSON.stringify(config) : config })
    }
  })
}

export const down = async (): Promise<void> => {
  throw new Error('Cannot roll down the OAuth state requirement because disabling OAuth state is not supported.')
}

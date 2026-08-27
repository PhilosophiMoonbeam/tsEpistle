import type { Knex } from 'knex'

const VERSIONS = 'agentProviderProfileVersions'
const PROFILES = 'agentProviderProfiles'
const CONFIGURATION = 'agentProviderConfiguration'

type AdapterConfig = Record<string, unknown>

type VersionRow = {
  readonly id: string
  readonly transportKind: string
  readonly adapterConfig: string
}

const normalizeEffort = (transport: string, value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  if (transport === 'openai-responses' || transport === 'openai-chat') {
    return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : undefined
  }
  if (transport === 'openresponses') {
    if (value === 'minimal') return 'low'
    return ['none', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : undefined
  }
  if (transport === 'anthropic-messages') {
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : undefined
  }
  if (transport === 'gemini-api') {
    if (value === 'none' || value === 'minimal') return 'minimal'
    if (value === 'xhigh' || value === 'max') return 'high'
    return ['low', 'medium', 'high'].includes(value) ? value : undefined
  }
  return undefined
}

const parseConfig = (value: string): AdapterConfig | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as AdapterConfig : null
  } catch {
    return null
  }
}

const invalidate = async (transaction: Knex.Transaction, versionIds: readonly string[]): Promise<void> => {
  if (versionIds.length === 0 || !await transaction.schema.hasTable(PROFILES)) return
  const current = transaction(PROFILES).whereIn('currentVersionId', versionIds)
  const hadDefault = await current.clone().where({ isGlobalDefault: true }).first('id')
  await current.update({
    status: 'disabled',
    conformed: false,
    isGlobalDefault: false,
    policyVersion: transaction.raw('?? + 1', ['policyVersion'])
  })
  if (hadDefault && await transaction.schema.hasTable(CONFIGURATION)) {
    await transaction(CONFIGURATION).where({ id: 1 }).increment('defaultGeneration', 1)
  }
}

const migrate = async (knex: Knex, transform: (row: VersionRow, config: AdapterConfig) => boolean): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS)) return
  const rows = await knex<VersionRow>(VERSIONS).select('id', 'transportKind', 'adapterConfig')
  await knex.transaction(async transaction => {
    const changedVersionIds: string[] = []
    for (const row of rows) {
      const config = parseConfig(row.adapterConfig)
      if (!config || !transform(row, config)) continue
      await transaction(VERSIONS).where({ id: row.id }).update({ adapterConfig: JSON.stringify(config), conformed: false })
      changedVersionIds.push(row.id)
    }
    await invalidate(transaction, changedVersionIds)
  })
}

export const up = async (knex: Knex): Promise<void> => await migrate(knex, (row, config) => {
  if (!Object.hasOwn(config, 'reasoningEffort')) return false
  const effort = normalizeEffort(row.transportKind, config.reasoningEffort)
  delete config.reasoningEffort
  if (effort !== undefined) {
    config.agentReasoningEffort = effort
    config.utilityReasoningEffort = effort
  }
  return true
})

export const down = async (knex: Knex): Promise<void> => await migrate(knex, (row, config) => {
  const hasAgentEffort = Object.hasOwn(config, 'agentReasoningEffort')
  const hasUtilityEffort = Object.hasOwn(config, 'utilityReasoningEffort')
  if (!hasAgentEffort && !hasUtilityEffort) return false
  const effort = normalizeEffort(row.transportKind, config.agentReasoningEffort ?? config.utilityReasoningEffort)
  delete config.agentReasoningEffort
  delete config.utilityReasoningEffort
  if (effort !== undefined) config.reasoningEffort = effort === 'max' ? 'xhigh' : effort
  return true
})

import type { Knex } from 'knex'

const VERSIONS = 'agentProviderProfileVersions'
const PROFILES = 'agentProviderProfiles'

interface VersionRow {
  readonly id: string
  readonly capabilities: string
  readonly capabilityRevision: string
}

const objectValue = (value: string, label: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError(`${label} must be a JSON object`)
  return parsed as Record<string, unknown>
}

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS)) return
  const rows = await knex<VersionRow>(VERSIONS).select('id', 'capabilities', 'capabilityRevision')
  await knex.transaction(async transaction => {
    for (const row of rows) {
      const capabilities = objectValue(row.capabilities, 'Provider capabilities')
      if (typeof capabilities.functions !== 'boolean' || typeof capabilities.parallelFunctions !== 'boolean') throw new TypeError('Stored provider function capabilities are invalid')
      const toolCalling = capabilities.functions ? 'native' : 'prompt'
      const parallelToolCalls = toolCalling === 'native' && capabilities.parallelFunctions
      delete capabilities.functions
      delete capabilities.parallelFunctions
      capabilities.toolCalling = toolCalling
      capabilities.parallelToolCalls = parallelToolCalls
      await transaction(VERSIONS).where({ id: row.id }).update({
        capabilities: JSON.stringify(capabilities),
        capabilityRevision: row.capabilityRevision.replace('wiki-protocol-capabilities-v1:', 'wiki-protocol-capabilities-v2:'),
        conformed: false
      })
    }
    if (await transaction.schema.hasTable(PROFILES)) await transaction(PROFILES).update({ status: 'disabled', conformed: false })
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS)) return
  const rows = await knex<VersionRow>(VERSIONS).select('id', 'capabilities', 'capabilityRevision')
  await knex.transaction(async transaction => {
    for (const row of rows) {
      const capabilities = objectValue(row.capabilities, 'Provider capabilities')
      if ((capabilities.toolCalling !== 'native' && capabilities.toolCalling !== 'prompt') || typeof capabilities.parallelToolCalls !== 'boolean') throw new TypeError('Stored provider tool-calling capabilities are invalid')
      const functions = capabilities.toolCalling === 'native'
      const parallelFunctions = functions && capabilities.parallelToolCalls
      delete capabilities.toolCalling
      delete capabilities.parallelToolCalls
      capabilities.functions = functions
      capabilities.parallelFunctions = parallelFunctions
      await transaction(VERSIONS).where({ id: row.id }).update({
        capabilities: JSON.stringify(capabilities),
        capabilityRevision: row.capabilityRevision.replace('wiki-protocol-capabilities-v2:', 'wiki-protocol-capabilities-v1:'),
        conformed: false
      })
    }
    if (await transaction.schema.hasTable(PROFILES)) await transaction(PROFILES).update({ status: 'disabled', conformed: false })
  })
}

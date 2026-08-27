import type { Knex } from 'knex'

const VERSIONS = 'agentProviderProfileVersions'
const PROFILES = 'agentProviderProfiles'
const CONFIGURATION = 'agentProviderConfiguration'
const TRANSPORT = 'gemini-api'

const invalidate = async (knex: Knex, capabilityRevision: string): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS)) return
  const versionIds = await knex(VERSIONS).where({ transportKind: TRANSPORT }).pluck<string>('id')
  if (versionIds.length === 0) return
  await knex.transaction(async transaction => {
    await transaction(VERSIONS).whereIn('id', versionIds).update({ capabilityRevision, conformed: false })
    if (!await transaction.schema.hasTable(PROFILES)) return
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
  })
}

export const up = async (knex: Knex): Promise<void> => await invalidate(knex, 'wiki-protocol-capabilities-v3:gemini-api')

export const down = async (knex: Knex): Promise<void> => await invalidate(knex, 'wiki-protocol-capabilities-v2:gemini-api')

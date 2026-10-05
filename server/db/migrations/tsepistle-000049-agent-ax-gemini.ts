import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

const PROFILES = 'agentProviderProfiles'
const VERSIONS = 'agentProviderProfileVersions'

/** New transport semantics require a new conformance receipt, never rewriting a run's immutable version. */
export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(PROFILES)) || !(await knex.schema.hasTable(VERSIONS))) return
  await knex.transaction(async transaction => {
    const profiles = await transaction(PROFILES).whereNotNull('currentVersionId').forUpdate().select('id', 'currentVersionId', 'isGlobalDefault')
    let defaultChanged = false
    for (const profile of profiles) {
      const old = await transaction(VERSIONS).where({ id: profile.currentVersionId, profileId: profile.id }).first()
      if (!old) throw new Error('Ax cutover found a missing provider profile version')
      const capabilityRevision = `wiki-protocol-capabilities-v4:${old.transportKind}`
      if (old.capabilityRevision === capabilityRevision) continue
      const maximum = await transaction(VERSIONS).where({ profileId: profile.id }).max({ version: 'version' }).first()
      const version = Number(maximum?.version) + 1
      if (!Number.isSafeInteger(version) || version < 2) throw new Error('Ax cutover found an invalid provider version')
      const id = randomUUID()
      await transaction(VERSIONS).insert({ ...old, id, version, capabilityRevision, conformed: false, createdAt: new Date() })
      await transaction(PROFILES)
        .where({ id: profile.id, currentVersionId: old.id })
        .update({
          currentVersionId: id,
          status: 'disabled',
          conformed: false,
          // Keep the selected default preference, but it cannot resolve while disabled.
          policyVersion: transaction.raw('?? + 1', ['policyVersion']),
          updatedAt: new Date()
        })
      defaultChanged ||= profile.isGlobalDefault === true || profile.isGlobalDefault === 1
    }
    if (defaultChanged && (await transaction.schema.hasTable('agentProviderConfiguration')))
      await transaction('agentProviderConfiguration').where({ id: 1 }).increment('defaultGeneration', 1)
    // Retire live opt-in only. Historical admitted runs, answers, citations,
    // encrypted provider state, secrets, prices, grants and ledger rows are untouched.
    if ((await transaction.schema.hasTable('agentSessions')) && (await transaction.schema.hasColumn('agentSessions', 'googleSearchEnabled'))) {
      await transaction('agentSessions')
        .where({ googleSearchEnabled: true })
        .update({
          googleSearchEnabled: false,
          version: transaction.raw('?? + 1', ['version']),
          updatedAt: new Date()
        })
    }
  })
}

export const down = async (): Promise<void> => {
  throw new Error('Ax provider cutover cannot restore retired Interactions transport; retained historical versions must remain immutable')
}

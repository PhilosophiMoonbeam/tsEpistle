import type { Knex } from 'knex'

/** Preserve sealed credentials and their bindings, but never reinterpret a preset as generic consent. */
export const up = async (db: Knex): Promise<void> => {
  await db.schema.alterTable('agentExternalMcpServers', table => { table.text('retiredOAuthConfiguration').nullable() })
  const endpoints = await db('agentExternalMcpServers').where('authMode', 'oauth').whereNotNull('oauthConfiguration').select('id', 'oauthConfiguration', 'revision') as { id: string; oauthConfiguration: string; revision: number }[]
  for (const endpoint of endpoints) {
    const configuration: unknown = JSON.parse(endpoint.oauthConfiguration)
    if (!configuration || typeof configuration !== 'object' || !Object.hasOwn(configuration, 'preset')) continue
    // Disabled status blocks callbacks, refresh and discovery. The incomplete generic
    // configuration cannot be saved/re-enabled without explicit issuer/client setup.
    // Do not touch grants, registrations, PKCE or secret references: reconfiguration
    // or deletion performs the existing explicit credential cleanup, not this upgrade.
    await db('agentExternalMcpServers').where('id', endpoint.id).update({
      retiredOAuthConfiguration: endpoint.oauthConfiguration,
      oauthConfiguration: JSON.stringify({ registrationMode: 'preregistered' }),
      status: 'disabled',
      revision: endpoint.revision + 1,
      updatedAt: new Date()
    })
  }
}

export const down = async (): Promise<void> => { throw new Error('Retired OAuth presets require explicit generic reconfiguration; refusing to restore old consent bindings.') }

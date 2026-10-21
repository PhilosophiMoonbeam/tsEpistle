import type { Knex } from 'knex'

// Keep this recovery contract independent of future preset/catalog changes.
const endpoints: Readonly<Record<string, true>> = {
  'https://gmailmcp.googleapis.com/mcp/v1': true,
  'https://drivemcp.googleapis.com/mcp/v1': true,
  'https://docsmcp.googleapis.com/mcp/v1': true,
  'https://sheetsmcp.googleapis.com/mcp/v1': true,
  'https://slidesmcp.googleapis.com/mcp/v1': true,
  'https://calendarmcp.googleapis.com/mcp/v1': true,
  'https://chatmcp.googleapis.com/mcp/v1': true,
  'https://people.googleapis.com/mcp/v1': true,
  'https://classroommcp.googleapis.com/mcp/v1': true
}
const retiredConfiguration = JSON.stringify({ registrationMode: 'preregistered' })

/** Recover configuration only; migration65's disabled authority and sealed consent stay retired. */
export const up = async (db: Knex): Promise<void> => {
  const retired = await db('agentExternalMcpServers').where({ authMode: 'oauth', status: 'disabled', oauthConfiguration: retiredConfiguration })
    .whereNotNull('retiredOAuthConfiguration').select('id', 'endpointUrl', 'revision', 'retiredOAuthConfiguration') as { id: string; endpointUrl: string; revision: number; retiredOAuthConfiguration: string }[]
  for (const endpoint of retired) {
    if (!Object.hasOwn(endpoints, endpoint.endpointUrl)) continue
    let configuration: unknown
    try { configuration = JSON.parse(endpoint.retiredOAuthConfiguration) } catch { continue }
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) continue
    const saved = configuration as Record<string, unknown>
    if (saved.preset !== 'google-workspace' || (saved.registrationMode !== 'automatic' && saved.registrationMode !== 'preregistered') ||
      Object.keys(saved).some(key => !['preset', 'registrationMode', 'scopes'].includes(key)) ||
      (saved.scopes !== undefined && (!Array.isArray(saved.scopes) || saved.scopes.length !== 0))) continue
    // Compare-and-update protects concurrent edits; no grants, registrations, PKCE,
    // secret references or archived configuration are read as credentials or rewritten.
    await db('agentExternalMcpServers').where({ id: endpoint.id, authMode: 'oauth', status: 'disabled', oauthConfiguration: retiredConfiguration,
      retiredOAuthConfiguration: endpoint.retiredOAuthConfiguration, revision: endpoint.revision }).update({
      oauthConfiguration: endpoint.retiredOAuthConfiguration,
      revision: endpoint.revision + 1,
      updatedAt: new Date()
    })
  }
}

export const down = async (): Promise<void> => { throw new Error('Restored presets require explicit endpoint reconfiguration; refusing to rewrite consent or subsequent edits.') }

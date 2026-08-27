/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import { AgentProviderRegistry, type AgentProviderSettingsInput } from '../../agents/providers/registry.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'

const profileInput: AgentProviderSettingsInput = {
  transportKind: 'openai-responses',
  model: 'gpt-test',
  utilityModel: null,
  baseUrl: 'https://api.example.test/v1/',
  authMode: 'bearer',
  secretReference: 'env:TEST_PROVIDER_KEY',
  adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {} },
  capabilities: { streaming: true, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 32_000, maxOutputTokens: 4_000 },
  capabilityRevision: 'fixture-v1',
  policies: { allowedModes: ['agent'], dailyTokens: 100_000, dailyCostMicros: 1_000_000, reservationTokens: 10_000, reservationCostMicros: 100_000, reservationMilliseconds: 60_000, promptVersion: 1, maxAttempts: 3 },
  pricingRevision: 'price-v1'
}

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentProviderProfiles', table => { table.string('id').primary(); table.string('displayName'); table.string('status'); table.boolean('isGlobalDefault'); table.string('exposureMode'); table.string('currentVersionId').nullable(); table.integer('policyVersion'); table.boolean('conformed'); table.integer('createdBy'); table.integer('updatedBy'); table.dateTime('createdAt'); table.dateTime('updatedAt'); table.dateTime('deletedAt').nullable() })
  await knex.raw('CREATE UNIQUE INDEX agent_provider_profiles_active_name_unique ON agentProviderProfiles (displayName) WHERE deletedAt IS NULL')
  await knex.schema.createTable('agentProviderProfileVersions', table => { table.string('id').primary(); table.string('profileId'); table.integer('version'); table.string('transportKind'); table.string('model'); table.string('utilityModel').nullable(); table.text('baseUrl'); table.string('authMode'); table.string('secretReference').nullable(); table.text('adapterConfig'); table.text('capabilities'); table.string('capabilityRevision'); table.text('policies'); table.string('pricingRevision'); table.boolean('conformed'); table.integer('createdBy'); table.dateTime('createdAt') })
  await knex.schema.createTable('agentProviderSecrets', table => { table.string('id').primary(); table.string('keyId'); table.string('algorithm'); table.binary('nonce'); table.binary('ciphertext'); table.binary('authTag'); table.integer('createdBy'); table.dateTime('createdAt') })
  await knex.schema.createTable('agentProviderConfiguration', table => { table.integer('id').primary(); table.integer('defaultGeneration'); table.dateTime('updatedAt'); table.integer('updatedBy').nullable() })
  await knex.schema.createTable('agentProviderGrants', table => { table.string('profileId'); table.integer('groupId') })
  await knex.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId') })
  await knex.schema.createTable('agentSessions', table => { table.string('id').primary(); table.integer('ownerId'); table.integer('version'); table.string('providerProfileId').nullable(); table.string('executionMode'); table.dateTime('deletedAt').nullable(); table.dateTime('updatedAt') })
  await knex.schema.createTable('agentRuns', table => { table.string('id'); table.string('sessionId'); table.string('status') })
}
const currentSettingsId = async (knex: Knex, profileId: string): Promise<string> => {
  const profile = await knex('agentProviderProfiles').where({ id: profileId }).first('currentVersionId') as { currentVersionId: string | null } | undefined
  if (!profile?.currentVersionId) throw new Error('Current provider settings are missing')
  return profile.currentVersionId
}


describe('agent provider profile registry', () => {
  let knex: Knex
  let registry: AgentProviderRegistry
  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(knex)
    registry = new AgentProviderRegistry(knex, { has: reference => reference === 'env:TEST_PROVIDER_KEY', get: () => null, store: () => { throw new Error('unexpected managed secret') }, delete: () => false }, { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } })
  })
  afterEach(async () => knex.destroy())

  it('updates mutable settings in place and rejects stale resolution after an admin change', async () => {
    const created = await registry.create({ ...profileInput, displayName: 'Primary', exposureMode: 'all_agent_users', actorId: 1 })
    const settingsId = await currentSettingsId(knex, created.id)
    expect(created).toMatchObject({ status: 'disabled', conformed: false, secretConfigured: true, destinationHost: 'api.example.test' })
    expect(created).not.toHaveProperty('secretReference')
    expect(created).not.toHaveProperty('currentVersionId')
    await expect(registry.setEnabled(created.id, true, 1)).rejects.toMatchObject({ code: 'PROFILE_NOT_READY' })
    await registry.setConformed(created.id, settingsId, true, 1)
    await registry.setEnabled(created.id, true, 1)
    await registry.setDefault(created.id, 1)
    await knex('agentSessions').insert({ id: 'session-1', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent', deletedAt: null, updatedAt: new Date() })

    const token = await registry.issueResolutionToken(7, 'session-1')
    const resolved = await registry.resolve({ ownerId: 7, sessionId: 'session-1', profileResolutionToken: token })
    expect(resolved).toMatchObject({ providerProfileVersionId: settingsId, transportKind: 'openai-responses', executionMode: 'agent', quotaLimits: { dailyTokens: 100_000 } })

    const updated = await registry.update(created.id, { ...profileInput, model: 'gpt-test-2', utilityModel: 'gpt-test-mini', capabilityRevision: 'fixture-v2', actorId: 1 })
    expect(updated).toMatchObject({ status: 'disabled', conformed: false, model: 'gpt-test-2', utilityModel: 'gpt-test-mini' })
    expect(await knex('agentProviderProfileVersions').where({ profileId: created.id }).select('id', 'model', 'utilityModel')).toEqual([{ id: settingsId, model: 'gpt-test-2', utilityModel: 'gpt-test-mini' }])
    await expect(registry.resolve({ ownerId: 7, sessionId: 'session-1', profileResolutionToken: token })).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
  })
  it('accepts Gemini 3.x Interactions profiles and rejects legacy models or ambiguous credentials', async () => {
    const geminiInput: AgentProviderSettingsInput = {
      ...profileInput,
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      utilityModel: 'gemini-3.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      capabilities: { ...profileInput.capabilities, parallelToolCalls: true, usage: 'stream' }
    }
    await expect(registry.create({ ...geminiInput, displayName: 'Gemini', exposureMode: 'all_agent_users', actorId: 1 })).resolves.toMatchObject({
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      utilityModel: 'gemini-3.5-flash-lite',
      authMode: 'google-api-key',
      destinationHost: 'generativelanguage.googleapis.com'
    })
    await expect(registry.create({ ...geminiInput, authMode: 'bearer', displayName: 'Gemini bearer', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_AUTH' })
    await expect(registry.create({ ...geminiInput, model: 'gemini-2.5-flash', displayName: 'Legacy Gemini model', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    await expect(registry.create({ ...geminiInput, model: 'models/gemini-3.7-flash', displayName: 'Gemini model path', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    await expect(registry.create({ ...geminiInput, adapterConfig: { ...geminiInput.adapterConfig, temperature: 0.5 }, displayName: 'Gemini temperature', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
    await expect(registry.create({ ...geminiInput, adapterConfig: { ...geminiInput.adapterConfig, additionalHeaders: { 'x-goog-api-key': 'override' } }, displayName: 'Gemini header override', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_HEADERS' })
  })

  it('stores role-specific reasoning effort and rejects protocol-invalid levels', async () => {
    const created = await registry.create({
      ...profileInput,
      adapterConfig: {
        ...profileInput.adapterConfig,
        agentReasoningEffort: 'max',
        utilityReasoningEffort: 'minimal'
      },
      displayName: 'Reasoning',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    await expect(registry.getAdmin(created.id)).resolves.toMatchObject({
      adapterConfig: { agentReasoningEffort: 'max', utilityReasoningEffort: 'minimal' }
    })
    await expect(registry.create({
      ...profileInput,
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      utilityModel: null,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      adapterConfig: { ...profileInput.adapterConfig, agentReasoningEffort: 'max' },
      displayName: 'Invalid Gemini reasoning',
      exposureMode: 'all_agent_users',
      actorId: 1
    })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
    await expect(registry.create({
      ...profileInput,
      transportKind: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      authMode: 'anthropic-api-key',
      adapterConfig: { ...profileInput.adapterConfig, utilityReasoningEffort: 'minimal' },
      displayName: 'Invalid Anthropic reasoning',
      exposureMode: 'all_agent_users',
      actorId: 1
    })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
    await expect(registry.create({
      ...profileInput,
      transportKind: 'openresponses',
      adapterConfig: { ...profileInput.adapterConfig, agentReasoningEffort: 'minimal' },
      displayName: 'Invalid OpenResponses reasoning',
      exposureMode: 'all_agent_users',
      actorId: 1
    })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
  })


  it('automatically makes the first eligible all-user profile the global default', async () => {
    const primary = await registry.create({ ...profileInput, displayName: 'Primary', exposureMode: 'all_agent_users', actorId: 1 })
    await registry.setConformed(primary.id, await currentSettingsId(knex, primary.id), true, 1)
    await registry.setEnabled(primary.id, true, 1)

    expect(await knex('agentProviderProfiles').where({ id: primary.id }).first('status', 'isGlobalDefault')).toMatchObject({ status: 'enabled', isGlobalDefault: 1 })
    expect(await knex('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration')).toMatchObject({ defaultGeneration: 2 })

    const secondary = await registry.create({ ...profileInput, displayName: 'Secondary', exposureMode: 'all_agent_users', actorId: 1 })
    await registry.setConformed(secondary.id, await currentSettingsId(knex, secondary.id), true, 1)
    await registry.setEnabled(secondary.id, true, 1)

    expect(await knex('agentProviderProfiles').where({ id: primary.id }).first('isGlobalDefault')).toMatchObject({ isGlobalDefault: 1 })
    expect(await knex('agentProviderProfiles').where({ id: secondary.id }).first('isGlobalDefault')).toMatchObject({ isGlobalDefault: 0 })
    expect(await knex('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration')).toMatchObject({ defaultGeneration: 2 })
  })
  it('stores a UI-supplied credential as an encrypted managed reference in the profile transaction', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 7) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } })
    const created = await managedRegistry.create({ ...profileInput, secretReference: null, secretValue: 'provider-key-from-ui', displayName: 'Managed', exposureMode: 'all_agent_users', actorId: 1 })
    expect(created).toMatchObject({ secretConfigured: true, status: 'disabled', conformed: false })
    const version = await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('secretReference') as { secretReference: string }
    expect(version.secretReference).toMatch(/^managed:/)
    const stored = await knex('agentProviderSecrets').first('ciphertext') as { ciphertext: Buffer }
    expect(stored.ciphertext.toString('utf8')).not.toContain('provider-key-from-ui')
    expect(await vault.get(version.secretReference)).toBe('provider-key-from-ui')
  })

  it('edits mutable settings while retaining an unrevealed credential', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 8) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } })
    const created = await managedRegistry.create({ ...profileInput, secretReference: null, secretValue: 'retained-provider-key', displayName: 'Editable', exposureMode: 'all_agent_users', actorId: 1 })
    const settingsId = await currentSettingsId(knex, created.id)
    const previousReference = (await knex('agentProviderProfileVersions').where({ id: settingsId }).first('secretReference') as { secretReference: string }).secretReference
    const updated = await managedRegistry.update(created.id, { ...profileInput, displayName: 'Renamed', model: 'gpt-revised', baseUrl: 'https://gateway.example.test/api', secretReference: null, actorId: 1 })
    expect(updated).toMatchObject({ displayName: 'Renamed', model: 'gpt-revised', baseUrl: 'https://gateway.example.test/api', destinationHost: 'gateway.example.test', secretConfigured: true })
    expect(updated).not.toHaveProperty('secretReference')
    const settings = await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('id', 'secretReference') as { id: string; secretReference: string }
    expect(settings).toEqual({ id: settingsId, secretReference: previousReference })
    expect(await vault.get(settings.secretReference)).toBe('retained-provider-key')
  })

  it('soft-removes a profile, revokes resolution, deletes managed credentials, and permits name reuse', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 9) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } })
    const created = await managedRegistry.create({ ...profileInput, secretReference: null, secretValue: 'removed-provider-key', displayName: 'Removable', exposureMode: 'all_agent_users', actorId: 1 })
    await managedRegistry.setConformed(created.id, await currentSettingsId(knex, created.id), true, 1)
    await managedRegistry.setEnabled(created.id, true, 1)
    await managedRegistry.setDefault(created.id, 1)
    await knex('agentSessions').insert({ id: 'session-remove', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent', deletedAt: null, updatedAt: new Date() })
    const token = await managedRegistry.issueResolutionToken(7, 'session-remove')
    const reference = (await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('secretReference') as { secretReference: string }).secretReference

    await managedRegistry.remove(created.id, 2)

    await expect(managedRegistry.get(created.id)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    expect(await managedRegistry.listAll()).toEqual([])
    expect(await vault.get(reference)).toBeNull()
    expect(await knex('agentProviderProfiles').where({ id: created.id }).first('status', 'isGlobalDefault', 'deletedAt')).toMatchObject({ status: 'disabled', isGlobalDefault: 0, deletedAt: expect.anything() })
    await expect(managedRegistry.resolve({ ownerId: 7, sessionId: 'session-remove', profileResolutionToken: token })).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
    await expect(managedRegistry.remove(created.id, 2)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    await expect(managedRegistry.create({ ...profileInput, displayName: 'Removable', exposureMode: 'all_agent_users', actorId: 1 })).resolves.toMatchObject({ displayName: 'Removable' })
  })

  it('fails closed for private endpoints, forbidden headers, incompatible modes, and group visibility', async () => {
    await expect(registry.create({ ...profileInput, baseUrl: 'https://127.0.0.1/v1', displayName: 'Private', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_URL' })
    await expect(registry.create({ ...profileInput, adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: { Authorization: 'secret' } }, displayName: 'Headers', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_HEADERS' })
    await expect(registry.create({ ...profileInput, secretReference: 'sk-literal-secret', displayName: 'Literal secret', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_SECRET', status: 400 })
    await expect(registry.create({ ...profileInput, transportKind: 'legacy-completions', displayName: 'Legacy', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CAPABILITIES' })
    await expect(registry.create({
      ...profileInput,
      transportKind: 'legacy-completions',
      capabilities: { ...profileInput.capabilities, streaming: false, toolCalling: 'prompt', parallelToolCalls: false, structuredOutput: 'prompt-only' },
      displayName: 'Legacy prompt tools',
      exposureMode: 'all_agent_users',
      actorId: 1
    })).resolves.toMatchObject({ transportKind: 'legacy-completions', capabilities: { toolCalling: 'prompt', parallelToolCalls: false } })

    const grouped = await registry.create({ ...profileInput, displayName: 'Grouped', exposureMode: 'groups', groupIds: [4], actorId: 1 })
    await registry.setConformed(grouped.id, await currentSettingsId(knex, grouped.id), true, 1)
    await registry.setEnabled(grouped.id, true, 1)
    expect(await registry.listVisible(7)).toEqual([])
    await knex('userGroups').insert({ userId: 7, groupId: 4 })
    const [visible] = await registry.listVisible(7)
    expect(visible).toMatchObject({ id: grouped.id, name: 'Grouped', transport: 'openai-responses', model: 'gpt-test', isGlobalDefault: false })
    expect(visible).not.toHaveProperty('versionId')
    await knex('agentSessions').insert({ id: 'session-2', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent', deletedAt: null, updatedAt: new Date() })
    await registry.setSessionProfile({ ownerId: 7, sessionId: 'session-2', expectedSessionVersion: 1, profileId: grouped.id })
    expect(await knex('agentSessions').where({ id: 'session-2' }).first('providerProfileId', 'version')).toMatchObject({ providerProfileId: grouped.id, version: 2 })
    expect(await registry.getAdmin(grouped.id)).toMatchObject({ exposureMode: 'groups', groupIds: [4] })
    await knex('agentSessions').where({ id: 'session-2' }).update({ providerProfileId: null, version: 3 })
    const token = await registry.issueResolutionToken(7, 'session-2')
    await expect(registry.resolve({ ownerId: 7, sessionId: 'session-2', profileResolutionToken: token })).resolves.toMatchObject({ executionMode: 'agent' })
  })
})

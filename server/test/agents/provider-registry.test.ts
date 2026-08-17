/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import { AgentProviderRegistry, type AgentProviderVersionInput } from '../../agents/providers/registry.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'

const profileInput: AgentProviderVersionInput = {
  transportKind: 'openai-responses',
  model: 'gpt-test',
  baseUrl: 'https://api.example.test/v1/',
  authMode: 'bearer',
  secretReference: 'env:TEST_PROVIDER_KEY',
  adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {} },
  capabilities: { streaming: true, functions: true, parallelFunctions: false, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 32_000, maxOutputTokens: 4_000 },
  capabilityRevision: 'fixture-v1',
  policies: { allowedModes: ['agent'], dailyTokens: 100_000, dailyCostMicros: 1_000_000, reservationTokens: 10_000, reservationCostMicros: 100_000, reservationMilliseconds: 60_000, promptVersion: 1, maxAttempts: 3 },
  pricingRevision: 'price-v1'
}

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentProviderProfiles', table => { table.string('id').primary(); table.string('displayName').unique(); table.string('status'); table.boolean('isGlobalDefault'); table.string('exposureMode'); table.string('currentVersionId').nullable(); table.integer('policyVersion'); table.boolean('conformed'); table.integer('createdBy'); table.integer('updatedBy'); table.dateTime('createdAt'); table.dateTime('updatedAt') })
  await knex.schema.createTable('agentProviderProfileVersions', table => { table.string('id').primary(); table.string('profileId'); table.integer('version'); table.string('transportKind'); table.string('model'); table.text('baseUrl'); table.string('authMode'); table.string('secretReference').nullable(); table.text('adapterConfig'); table.text('capabilities'); table.string('capabilityRevision'); table.text('policies'); table.string('pricingRevision'); table.boolean('conformed'); table.integer('createdBy'); table.dateTime('createdAt') })
  await knex.schema.createTable('agentProviderSecrets', table => { table.string('id').primary(); table.string('keyId'); table.string('algorithm'); table.binary('nonce'); table.binary('ciphertext'); table.binary('authTag'); table.integer('createdBy'); table.dateTime('createdAt') })
  await knex.schema.createTable('agentProviderConfiguration', table => { table.integer('id').primary(); table.integer('defaultGeneration'); table.dateTime('updatedAt'); table.integer('updatedBy').nullable() })
  await knex.schema.createTable('agentProviderGrants', table => { table.string('profileId'); table.integer('groupId') })
  await knex.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId') })
  await knex.schema.createTable('agentSessions', table => { table.string('id').primary(); table.integer('ownerId'); table.integer('version'); table.string('providerProfileId').nullable(); table.string('executionMode'); table.dateTime('deletedAt').nullable(); table.dateTime('updatedAt') })
  await knex.schema.createTable('agentRuns', table => { table.string('id'); table.string('sessionId'); table.string('status') })
  await knex.schema.createTable('agentSessionSkills', table => { table.string('sessionId'); table.string('skillVersionId'); table.integer('ordinal') })
}

describe('agent provider profile registry', () => {
  let knex: Knex
  let registry: AgentProviderRegistry
  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(knex)
    registry = new AgentProviderRegistry(knex, { has: reference => reference === 'env:TEST_PROVIDER_KEY', get: () => null, store: () => { throw new Error('unexpected managed secret') } }, { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } })
  })
  afterEach(async () => knex.destroy())

  it('pins a conformed immutable version and rejects stale resolution after an admin revision', async () => {
    const created = await registry.create({ ...profileInput, displayName: 'Primary', exposureMode: 'all_agent_users', actorId: 1 })
    expect(created).toMatchObject({ status: 'disabled', conformed: false, secretConfigured: true, destinationHost: 'api.example.test' })
    expect(created).not.toHaveProperty('secretReference')
    await expect(registry.setEnabled(created.id, true, 1)).rejects.toMatchObject({ code: 'PROFILE_NOT_READY' })
    await registry.setConformed(created.id, created.currentVersionId, true, 1)
    await registry.setEnabled(created.id, true, 1)
    await registry.setDefault(created.id, 1)
    await knex('agentSessions').insert({ id: 'session-1', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent', deletedAt: null, updatedAt: new Date() })
    await knex('agentSessionSkills').insert({ sessionId: 'session-1', skillVersionId: 'skill-v1', ordinal: 0 })

    const token = await registry.issueResolutionToken(7, 'session-1')
    const resolved = await registry.resolve({ ownerId: 7, sessionId: 'session-1', profileResolutionToken: token })
    expect(resolved).toMatchObject({ providerProfileVersionId: created.currentVersionId, transportKind: 'openai-responses', executionMode: 'agent', skillVersionIds: ['skill-v1'], quotaLimits: { dailyTokens: 100_000 } })

    const revised = await registry.revise(created.id, { ...profileInput, model: 'gpt-test-2', capabilityRevision: 'fixture-v2', actorId: 1 })
    expect(revised).toMatchObject({ currentVersion: 2, status: 'disabled', conformed: false, model: 'gpt-test-2' })
    expect(await knex('agentProviderProfileVersions').where({ profileId: created.id }).orderBy('version').pluck('model')).toEqual(['gpt-test', 'gpt-test-2'])
    await expect(registry.resolve({ ownerId: 7, sessionId: 'session-1', profileResolutionToken: token })).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
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

  it('fails closed for private endpoints, forbidden headers, incompatible modes, and group visibility', async () => {
    await expect(registry.create({ ...profileInput, baseUrl: 'https://127.0.0.1/v1', displayName: 'Private', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_URL' })
    await expect(registry.create({ ...profileInput, adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: { Authorization: 'secret' } }, displayName: 'Headers', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_HEADERS' })
    await expect(registry.create({ ...profileInput, secretReference: 'sk-literal-secret', displayName: 'Literal secret', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_SECRET', status: 400 })
    await expect(registry.create({ ...profileInput, transportKind: 'legacy-completions', displayName: 'Legacy', exposureMode: 'all_agent_users', actorId: 1 })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CAPABILITIES' })

    const grouped = await registry.create({ ...profileInput, displayName: 'Grouped', exposureMode: 'groups', groupIds: [4], actorId: 1 })
    await registry.setConformed(grouped.id, grouped.currentVersionId, true, 1)
    await registry.setEnabled(grouped.id, true, 1)
    expect(await registry.listVisible(7)).toEqual([])
    await knex('userGroups').insert({ userId: 7, groupId: 4 })
    expect((await registry.listVisible(7)).map(profile => profile.id)).toEqual([grouped.id])
    await knex('agentSessions').insert({ id: 'session-2', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent', deletedAt: null, updatedAt: new Date() })
    await registry.setSessionProfile({ ownerId: 7, sessionId: 'session-2', expectedSessionVersion: 1, profileId: grouped.id, executionMode: 'agent' })
    expect(await knex('agentSessions').where({ id: 'session-2' }).first('providerProfileId', 'version')).toMatchObject({ providerProfileId: grouped.id, version: 2 })
  })
})

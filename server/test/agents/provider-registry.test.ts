import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { DEFAULT_ROUTING_POLICY } from '../../../shared/agents/routing.ts'
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
  capabilities: {
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: false,
    structuredOutput: 'native-json-schema',
    usage: 'terminal',
    cancellation: true,
    maxContextTokens: 32_000,
    maxOutputTokens: 4_000
  },
  capabilityRevision: 'fixture-v1',
  policies: {
    allowedModes: ['agent'],
    dailyTokens: 100_000,
    dailyCostMicros: 1_000_000,
    reservationTokens: 10_000,
    reservationCostMicros: 100_000,
    reservationMilliseconds: 60_000,
    promptVersion: 1,
    maxAttempts: 3
  },
  pricingRevision: 'price-v1|1000000|2000000'
}

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.integer('authVersion').notNullable().defaultTo(0)
  })
  await knex.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions').notNullable()
  })
  await knex('users').insert({ id: 7, isActive: true })
  await knex('groups').insert({ id: 100, permissions: JSON.stringify(['use:agents']) })
  await knex.schema.createTable('agentProviderProfiles', table => {
    table.string('id').primary()
    table.string('displayName')
    table.string('status')
    table.boolean('isGlobalDefault')
    table.string('exposureMode')
    table.string('currentVersionId').nullable()
    table.integer('policyVersion')
    table.boolean('conformed')
    table.integer('createdBy')
    table.integer('updatedBy')
    table.dateTime('createdAt')
    table.dateTime('updatedAt')
    table.dateTime('deletedAt').nullable()
  })
  await knex.raw('CREATE UNIQUE INDEX agent_provider_profiles_active_name_unique ON agentProviderProfiles (displayName) WHERE deletedAt IS NULL')
  await knex.schema.createTable('agentProviderProfileVersions', table => {
    table.string('id').primary()
    table.string('profileId')
    table.integer('version')
    table.string('transportKind')
    table.string('model')
    table.string('utilityModel').nullable()
    table.text('baseUrl')
    table.string('authMode')
    table.string('secretReference').nullable()
    table.text('adapterConfig')
    table.text('capabilities')
    table.string('capabilityRevision')
    table.text('policies')
    table.string('pricingRevision')
    table.boolean('conformed')
    table.integer('createdBy')
    table.dateTime('createdAt')
  })
  await knex.schema.createTable('agentProviderSecrets', table => {
    table.string('id').primary()
    table.string('keyId')
    table.string('algorithm')
    table.binary('nonce')
    table.binary('ciphertext')
    table.binary('authTag')
    table.integer('createdBy')
    table.dateTime('createdAt')
  })
  await knex.schema.createTable('agentProviderConfiguration', table => {
    table.integer('id').primary()
    table.integer('defaultGeneration')
    table.dateTime('updatedAt')
    table.integer('updatedBy').nullable()
  })
  await knex.schema.createTable('agentProviderGrants', table => {
    table.string('profileId')
    table.integer('groupId')
  })
  await knex.schema.createTable('userGroups', table => {
    table.integer('userId')
    table.integer('groupId')
  })
  await knex.schema.createTable('agentSessions', table => {
    table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    table.string('id').primary()
    table.integer('ownerId')
    table.integer('version')
    table.string('providerProfileId').nullable()
    table.string('executionMode')
    table.dateTime('deletedAt').nullable()
    table.dateTime('updatedAt')
  })
  await knex.schema.createTable('agentRuns', table => {
    table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    table.string('id')
    table.string('sessionId')
    table.string('goalId').nullable()
    table.string('status')
    table.string('providerProfileVersionId').nullable()
    table.integer('ownerId')
    table.string('executionMode')
    table.integer('profilePolicyVersion')
    table.integer('defaultGeneration')
    table.string('transportKind')
    table.string('model')
    table.string('capabilityRevision')
    table.string('pricingRevision')
    table.integer('promptVersion')
    table.dateTime('queuedAt')
  })
  await knex.schema.createTable('agentEvents', table => {
    table.string('id').primary()
    table.string('runId')
    table.string('type')
    table.text('data')
    table.string('dataSha256')
  })
  await knex.schema.createTable('agentRoutingPolicy', table => {
    table.integer('id').primary()
    table.integer('revision')
    table.text('config')
    table.dateTime('updatedAt').nullable()
  })
  await knex('agentRoutingPolicy').insert({ id: 1, revision: 1, config: JSON.stringify(DEFAULT_ROUTING_POLICY), updatedAt: null })
  await knex.schema.createTable('agentRoutingModelPolicies', table => {
    table.string('profileId').primary()
    table.string('profileVersionId')
    table.integer('revision')
    table.text('config')
    table.dateTime('updatedAt')
  })
}
const currentSettingsId = async (knex: Knex, profileId: string): Promise<string> => {
  const profile = (await knex('agentProviderProfiles').where({ id: profileId }).first('currentVersionId')) as { currentVersionId: string | null } | undefined
  if (!profile?.currentVersionId) throw new Error('Current provider settings are missing')
  return profile.currentVersionId
}

describe('agent provider profile registry', () => {
  let knex: Knex
  let registry: AgentProviderRegistry
  let secretAvailable: boolean
  beforeEach(async () => {
    secretAvailable = true
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(knex)
    registry = new AgentProviderRegistry(
      knex,
      {
        has: reference => secretAvailable && reference === 'env:TEST_PROVIDER_KEY',
        get: () => null,
        store: () => {
          throw new Error('unexpected managed secret')
        },
        delete: () => false
      },
      { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } }
    )
  })
  afterEach(async () => knex.destroy())

  const createReadyProfile = async (displayName: string, exposureMode: 'all_agent_users' | 'groups' = 'all_agent_users', groupIds: number[] = []) => {
    const profile = await registry.create({ ...profileInput, displayName, exposureMode, groupIds, actorId: 1 })
    const versionId = await currentSettingsId(knex, profile.id)
    await registry.setConformed(profile.id, versionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, versionId)
    return { profile, versionId }
  }

  it('uses the administrator default instead of a historical session pin without changing the session row', async () => {
    const historical = await createReadyProfile('Alpha historical choice')
    const automatic = await createReadyProfile('Zulu administrator default')
    await registry.setDefault(automatic.profile.id, 1)
    await knex('agentSessions').insert({
      id: 'historical-session',
      ownerId: 7,
      version: 9,
      providerProfileId: historical.profile.id,
      executionMode: 'agent',
      updatedAt: '2026-08-17T00:00:00.000Z'
    })
    const before = await knex('agentSessions').where({ id: 'historical-session' }).first()
    const token = await registry.issueResolutionToken(7, 'historical-session')
    expect(await knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'historical-session' }))).toMatchObject({
      providerProfileVersionId: automatic.versionId
    })
    expect(
      await knex.transaction(transaction => registry.resolve(transaction, { ownerId: 7, sessionId: 'historical-session', profileResolutionToken: token }))
    ).toMatchObject({ providerProfileVersionId: automatic.versionId })
    expect(await knex('agentSessions').where({ id: 'historical-session' }).first()).toEqual(before)
  })

  it('falls back by eligible display name then UUID and invalidates a token when live fallback authority changes', async () => {
    const unavailable = await createReadyProfile('Global default')
    await registry.setDefault(unavailable.profile.id, 1)
    const zulu = await createReadyProfile('Zulu fallback')
    const alpha = await createReadyProfile('Alpha fallback', 'groups', [101])
    await knex('groups').insert({ id: 101, permissions: '[]' })
    await knex('userGroups').insert({ userId: 7, groupId: 101 })
    await registry.setEnabled(unavailable.profile.id, false, 1, unavailable.versionId)
    await knex('agentSessions').insert({ id: 'fallback-session', ownerId: 7, version: 1, providerProfileId: unavailable.profile.id, executionMode: 'agent' })
    const token = await registry.issueResolutionToken(7, 'fallback-session')
    expect(await knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'fallback-session' }))).toMatchObject({
      providerProfileVersionId: alpha.versionId
    })
    await knex('userGroups').where({ userId: 7, groupId: 101 }).delete()
    expect(await knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'fallback-session' }))).toMatchObject({
      providerProfileVersionId: zulu.versionId
    })
    await expect(
      Promise.resolve(
        knex.transaction(transaction => registry.resolve(transaction, { ownerId: 7, sessionId: 'fallback-session', profileResolutionToken: token }))
      )
    ).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED' })
    await knex('userGroups').insert({ userId: 7, groupId: 101 })
    // Exercise deterministic tie-breaking independently of today's active-name uniqueness constraint.
    await knex.raw('DROP INDEX agent_provider_profiles_active_name_unique')
    await knex('agentProviderProfiles').whereIn('id', [alpha.profile.id, zulu.profile.id]).update({ displayName: 'Same fallback' })
    const first = alpha.profile.id < zulu.profile.id ? alpha : zulu
    expect(await knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'fallback-session' }))).toMatchObject({
      providerProfileVersionId: first.versionId
    })
    expect(await knex('agentSessions').where({ id: 'fallback-session' }).first('providerProfileId', 'version')).toEqual({
      providerProfileId: unavailable.profile.id,
      version: 1
    })
  })

  it.each(['grant', 'secret', 'profile-conformance', 'version-conformance', 'status', 'deleted', 'mode'] as const)(
    'rechecks current %s eligibility when issuing tokens and resolving automatic admission',
    async revocation => {
      const ready = await createReadyProfile('Only eligible profile', 'groups', [101])
      await knex('groups').insert({ id: 101, permissions: '[]' })
      await knex('userGroups').insert({ userId: 7, groupId: 101 })
      await knex('agentSessions').insert({ id: 'live-session', ownerId: 7, version: 1, providerProfileId: ready.profile.id, executionMode: 'agent' })
      const token = await registry.issueResolutionToken(7, 'live-session')
      expect(await knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'live-session' }))).toMatchObject({
        providerProfileVersionId: ready.versionId
      })
      if (revocation === 'grant') await knex('userGroups').where({ userId: 7, groupId: 101 }).delete()
      if (revocation === 'secret') secretAvailable = false
      if (revocation === 'profile-conformance') await knex('agentProviderProfiles').where({ id: ready.profile.id }).update({ conformed: false })
      if (revocation === 'version-conformance') await knex('agentProviderProfileVersions').where({ id: ready.versionId }).update({ conformed: false })
      if (revocation === 'status') await knex('agentProviderProfiles').where({ id: ready.profile.id }).update({ status: 'disabled' })
      if (revocation === 'deleted') await knex('agentProviderProfiles').where({ id: ready.profile.id }).update({ deletedAt: new Date() })
      if (revocation === 'mode')
        await knex('agentProviderProfileVersions')
          .where({ id: ready.versionId })
          .update({ policies: JSON.stringify({ ...profileInput.policies, allowedModes: ['generation-only'] }) })
      await expect(registry.issueResolutionToken(7, 'live-session')).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
      await expect(
        Promise.resolve(knex.transaction(transaction => registry.resolveCurrent(transaction, { ownerId: 7, sessionId: 'live-session' })))
      ).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
      await expect(
        Promise.resolve(
          knex.transaction(transaction => registry.resolve(transaction, { ownerId: 7, sessionId: 'live-session', profileResolutionToken: token }))
        )
      ).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED' })
      expect(await knex('agentSessions').where({ id: 'live-session' }).first('providerProfileId', 'version')).toEqual({
        providerProfileId: ready.profile.id,
        version: 1
      })
    }
  )

  it('lists only currently granted credential-ready primary models and independently resolves alternates without changing session preference', async () => {
    await knex('groups').insert([
      { id: 101, permissions: '[]' },
      { id: 102, permissions: '[]' }
    ])
    await knex('userGroups').insert([
      { userId: 7, groupId: 100 },
      { userId: 7, groupId: 101 }
    ])
    const incumbent = await createReadyProfile('Default')
    const alternate = await createReadyProfile('Accessible group', 'groups', [101])
    const denied = await createReadyProfile('Other group', 'groups', [102])
    await registry.setDefault(incumbent.profile.id, 1)
    await knex('agentSessions').insert([
      { id: 'automatic', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent' },
      { id: 'same-owner-pinned', ownerId: 7, version: 1, providerProfileId: incumbent.profile.id, executionMode: 'agent' }
    ])
    const candidates = await knex.transaction(transaction => registry.listRoutingCandidates(transaction, { ownerId: 7, sessionId: 'automatic' }))
    expect(candidates.map(candidate => candidate.profileId).sort()).toEqual([incumbent.profile.id, alternate.profile.id].sort())
    expect(candidates.map(candidate => candidate.profileId)).not.toContain(denied.profile.id)
    expect(candidates[0]?.pricing).toMatchObject({ inputPerMillion: 1, outputPerMillion: 2 })
    const selected = await knex.transaction(transaction =>
      registry.resolveRoutingCandidate(transaction, {
        ownerId: 7,
        sessionId: 'automatic',
        profileId: alternate.profile.id,
        profileVersionId: alternate.versionId
      })
    )
    expect(selected.providerProfileVersionId).toBe(alternate.versionId)
    expect(await knex('agentSessions').orderBy('id').select('id', 'providerProfileId', 'version')).toEqual([
      { id: 'automatic', providerProfileId: null, version: 1 },
      { id: 'same-owner-pinned', providerProfileId: incumbent.profile.id, version: 1 }
    ])
    await knex('userGroups').where({ userId: 7, groupId: 101 }).delete()
    await expect(
      (async () =>
        await knex.transaction(transaction =>
          registry.resolveRoutingCandidate(transaction, {
            ownerId: 7,
            sessionId: 'automatic',
            profileId: alternate.profile.id,
            profileVersionId: alternate.versionId
          })
        ))()
    ).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
    secretAvailable = false
    expect(await knex.transaction(transaction => registry.listRoutingCandidates(transaction, { ownerId: 7, sessionId: 'automatic' }))).toEqual([])
  })

  it('appends immutable settings versions and rejects stale resolution after an admin change', async () => {
    const created = await registry.create({ ...profileInput, displayName: 'Primary', exposureMode: 'all_agent_users', actorId: 1 })
    const settingsId = await currentSettingsId(knex, created.id)
    expect(created).toMatchObject({ status: 'disabled', conformed: false, secretConfigured: true, destinationHost: 'api.example.test' })
    expect(created).not.toHaveProperty('secretReference')
    expect(created).not.toHaveProperty('currentVersionId')
    await expect(Promise.resolve(registry.setEnabled(created.id, true, 1, settingsId))).rejects.toMatchObject({ code: 'PROFILE_NOT_READY' })
    await registry.setConformed(created.id, settingsId, true, 1)
    await registry.setEnabled(created.id, true, 1, settingsId)
    await registry.setDefault(created.id, 1)
    await knex('agentSessions').insert({
      id: 'session-1',
      ownerId: 7,
      version: 1,
      providerProfileId: null,
      executionMode: 'agent',
      deletedAt: null,
      updatedAt: new Date()
    })

    const token = await registry.issueResolutionToken(7, 'session-1')
    const resolved = await knex.transaction(transaction => registry.resolve(transaction, { ownerId: 7, sessionId: 'session-1', profileResolutionToken: token }))
    expect(resolved).toMatchObject({
      providerProfileVersionId: settingsId,
      transportKind: 'openai-responses',
      executionMode: 'agent',
      quotaLimits: { dailyTokens: 100_000 }
    })

    const updated = await registry.update(created.id, {
      ...profileInput,
      model: 'gpt-test-2',
      utilityModel: 'gpt-test-mini',
      capabilityRevision: 'fixture-v2',
      actorId: 1
    })
    const updatedSettingsId = await currentSettingsId(knex, created.id)
    expect(updatedSettingsId).not.toBe(settingsId)
    expect(updated).toMatchObject({ status: 'disabled', conformed: false, model: 'gpt-test-2', utilityModel: 'gpt-test-mini' })
    expect(
      await knex('agentProviderProfileVersions').where({ profileId: created.id }).orderBy('version').select('id', 'version', 'model', 'utilityModel')
    ).toEqual([
      { id: settingsId, version: 1, model: 'gpt-test', utilityModel: null },
      { id: updatedSettingsId, version: 2, model: 'gpt-test-2', utilityModel: 'gpt-test-mini' }
    ])
    await expect(Promise.resolve(registry.setConformed(created.id, settingsId, true, 1))).rejects.toMatchObject({
      code: 'PROFILE_VERSION_CHANGED',
      status: 409
    })
    await expect(Promise.resolve(registry.setEnabled(created.id, true, 1, settingsId))).rejects.toMatchObject({ code: 'PROFILE_VERSION_CHANGED', status: 409 })
    await expect(
      (async () =>
        await knex.transaction(transaction => registry.resolve(transaction, { ownerId: 7, sessionId: 'session-1', profileResolutionToken: token })))()
    ).rejects.toMatchObject({
      code: 'PROFILE_RESOLUTION_CHANGED',
      status: 409
    })
  })
  it('accepts native Gemini chat profiles and rejects non-chat models or ambiguous credentials', async () => {
    const geminiInput: AgentProviderSettingsInput = {
      ...profileInput,
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      utilityModel: 'gemini-3.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      capabilities: { ...profileInput.capabilities, parallelToolCalls: true, usage: 'stream' }
    }
    expect(await registry.create({ ...geminiInput, displayName: 'Gemini', exposureMode: 'all_agent_users', actorId: 1 })).toMatchObject({
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      utilityModel: 'gemini-3.5-flash-lite',
      authMode: 'google-api-key',
      destinationHost: 'generativelanguage.googleapis.com'
    })
    await expect(
      Promise.resolve(registry.create({ ...geminiInput, authMode: 'bearer', displayName: 'Gemini bearer', exposureMode: 'all_agent_users', actorId: 1 }))
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_AUTH' })
    await expect(
      Promise.resolve(
        registry.create({ ...geminiInput, model: 'gemini-3.8-live', displayName: 'Live Gemini model', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    await expect(
      Promise.resolve(
        registry.create({ ...geminiInput, model: 'models/gemini-3.7-flash', displayName: 'Gemini model path', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_MODEL' })
    const temperatureProfile = await registry.create({
      ...geminiInput,
      adapterConfig: { ...geminiInput.adapterConfig, temperature: 0.5 },
      displayName: 'Gemini temperature',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    expect(temperatureProfile).not.toHaveProperty('adapterConfig')
    expect(await registry.getAdmin(temperatureProfile.id)).toMatchObject({ adapterConfig: { temperature: 0.5 } })
    await expect(
      Promise.resolve(
        registry.create({
          ...geminiInput,
          adapterConfig: { ...geminiInput.adapterConfig, additionalHeaders: { 'x-goog-api-key': 'override' } },
          displayName: 'Gemini header override',
          exposureMode: 'all_agent_users',
          actorId: 1
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_HEADERS' })
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
    expect(await registry.getAdmin(created.id)).toMatchObject({
      adapterConfig: { agentReasoningEffort: 'max', utilityReasoningEffort: 'minimal' }
    })
    await expect(
      Promise.resolve(
        registry.create({
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
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
    await expect(
      Promise.resolve(
        registry.create({
          ...profileInput,
          transportKind: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com/v1',
          authMode: 'anthropic-api-key',
          adapterConfig: { ...profileInput.adapterConfig, utilityReasoningEffort: 'minimal' },
          displayName: 'Invalid Anthropic reasoning',
          exposureMode: 'all_agent_users',
          actorId: 1
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
    await expect(
      Promise.resolve(
        registry.create({
          ...profileInput,
          transportKind: 'openresponses',
          adapterConfig: { ...profileInput.adapterConfig, agentReasoningEffort: 'minimal' },
          displayName: 'Invalid OpenResponses reasoning',
          exposureMode: 'all_agent_users',
          actorId: 1
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' })
  })

  it('automatically makes the first eligible all-user profile the global default', async () => {
    const primary = await registry.create({ ...profileInput, displayName: 'Primary', exposureMode: 'all_agent_users', actorId: 1 })
    await registry.setConformed(primary.id, await currentSettingsId(knex, primary.id), true, 1)
    await registry.setEnabled(primary.id, true, 1, await currentSettingsId(knex, primary.id))

    expect(await knex('agentProviderProfiles').where({ id: primary.id }).first('status', 'isGlobalDefault')).toMatchObject({
      status: 'enabled',
      isGlobalDefault: 1
    })
    expect(await knex('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration')).toMatchObject({ defaultGeneration: 2 })

    const secondary = await registry.create({ ...profileInput, displayName: 'Secondary', exposureMode: 'all_agent_users', actorId: 1 })
    await registry.setConformed(secondary.id, await currentSettingsId(knex, secondary.id), true, 1)
    await registry.setEnabled(secondary.id, true, 1, await currentSettingsId(knex, secondary.id))

    expect(await knex('agentProviderProfiles').where({ id: primary.id }).first('isGlobalDefault')).toMatchObject({ isGlobalDefault: 1 })
    expect(await knex('agentProviderProfiles').where({ id: secondary.id }).first('isGlobalDefault')).toMatchObject({ isGlobalDefault: 0 })
    expect(await knex('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration')).toMatchObject({ defaultGeneration: 2 })
  })

  it('stores a UI-supplied credential as an encrypted managed reference in the profile transaction', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 7) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, {
      currentKeyId: 'primary',
      keys: { primary: 'a-profile-resolution-secret-with-rotation-room' }
    })
    const created = await managedRegistry.create({
      ...profileInput,
      secretReference: null,
      secretValue: 'provider-key-from-ui',
      displayName: 'Managed',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    expect(created).toMatchObject({ secretConfigured: true, status: 'disabled', conformed: false })
    const version = (await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('secretReference')) as { secretReference: string }
    expect(version.secretReference).toMatch(/^managed:/)
    const stored = (await knex('agentProviderSecrets').first('ciphertext')) as { ciphertext: Buffer }
    expect(stored.ciphertext.toString('utf8')).not.toContain('provider-key-from-ui')
    expect(await vault.get(version.secretReference)).toBe('provider-key-from-ui')
  })

  it('appends settings while retaining an unrevealed credential', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 8) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, {
      currentKeyId: 'primary',
      keys: { primary: 'a-profile-resolution-secret-with-rotation-room' }
    })
    const created = await managedRegistry.create({
      ...profileInput,
      secretReference: null,
      secretValue: 'retained-provider-key',
      displayName: 'Editable',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    const settingsId = await currentSettingsId(knex, created.id)
    const previousReference = ((await knex('agentProviderProfileVersions').where({ id: settingsId }).first('secretReference')) as { secretReference: string })
      .secretReference
    const updated = await managedRegistry.update(created.id, {
      ...profileInput,
      displayName: 'Renamed',
      model: 'gpt-revised',
      baseUrl: 'https://gateway.example.test/api',
      secretReference: null,
      actorId: 1
    })
    const currentVersionId = await currentSettingsId(knex, created.id)
    expect(updated).toMatchObject({
      displayName: 'Renamed',
      model: 'gpt-revised',
      baseUrl: 'https://gateway.example.test/api',
      destinationHost: 'gateway.example.test',
      secretConfigured: true
    })
    expect(updated).not.toHaveProperty('secretReference')
    expect(currentVersionId).not.toBe(settingsId)
    expect(await knex('agentProviderProfileVersions').where({ profileId: created.id }).orderBy('version').select('id', 'version', 'secretReference')).toEqual([
      { id: settingsId, version: 1, secretReference: previousReference },
      { id: currentVersionId, version: 2, secretReference: previousReference }
    ])
    expect(await vault.get(previousReference)).toBe('retained-provider-key')
  })

  it('retains credentials referenced by all immutable versions, even without an admitted run', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 12) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, {
      currentKeyId: 'primary',
      keys: { primary: 'a-profile-resolution-secret-with-rotation-room' }
    })
    const retained = await managedRegistry.create({
      ...profileInput,
      secretReference: null,
      secretValue: 'admitted-key',
      displayName: 'Retained',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    const admittedVersionId = await currentSettingsId(knex, retained.id)
    const admittedReference = (
      (await knex('agentProviderProfileVersions').where({ id: admittedVersionId }).first('secretReference')) as { secretReference: string }
    ).secretReference
    await knex('agentRuns').insert({ id: 'queued-run', sessionId: 'queued-session', status: 'queued', providerProfileVersionId: admittedVersionId })

    await managedRegistry.update(retained.id, {
      ...profileInput,
      secretReference: null,
      secretValue: 'replacement-key',
      model: 'replacement-model',
      actorId: 2
    })
    expect(await vault.get(admittedReference)).toBe('admitted-key')

    const historical = await managedRegistry.create({
      ...profileInput,
      secretReference: null,
      secretValue: 'historical-key',
      displayName: 'Historical',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    const historicalVersionId = await currentSettingsId(knex, historical.id)
    const historicalReference = (
      (await knex('agentProviderProfileVersions').where({ id: historicalVersionId }).first('secretReference')) as { secretReference: string }
    ).secretReference
    await managedRegistry.update(historical.id, { ...profileInput, secretReference: null, secretValue: 'current-key', model: 'current-model', actorId: 2 })
    expect(await vault.get(historicalReference)).toBe('historical-key')
    expect(await knex('agentProviderProfileVersions').where({ id: historicalVersionId }).first('model', 'secretReference')).toEqual({
      model: profileInput.model,
      secretReference: historicalReference
    })
  })
  it('soft-removes a profile, revokes resolution, retains historical credentials, and permits name reuse', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 9) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, {
      currentKeyId: 'primary',
      keys: { primary: 'a-profile-resolution-secret-with-rotation-room' }
    })
    const created = await managedRegistry.create({
      ...profileInput,
      secretReference: null,
      secretValue: 'removed-provider-key',
      displayName: 'Removable',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    await managedRegistry.setConformed(created.id, await currentSettingsId(knex, created.id), true, 1)
    await managedRegistry.setEnabled(created.id, true, 1, await currentSettingsId(knex, created.id))
    await managedRegistry.setDefault(created.id, 1)
    await knex('agentSessions').insert({
      id: 'session-remove',
      ownerId: 7,
      version: 1,
      providerProfileId: null,
      executionMode: 'agent',
      deletedAt: null,
      updatedAt: new Date()
    })
    const token = await managedRegistry.issueResolutionToken(7, 'session-remove')
    const reference = ((await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('secretReference')) as { secretReference: string })
      .secretReference

    await managedRegistry.remove(created.id, 2)

    await expect(Promise.resolve(managedRegistry.get(created.id))).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    expect(await managedRegistry.listAll()).toEqual([])
    expect(await vault.get(reference)).toBe('removed-provider-key')
    expect(await knex('agentProviderProfiles').where({ id: created.id }).first('status', 'isGlobalDefault', 'deletedAt')).toMatchObject({
      status: 'disabled',
      isGlobalDefault: 0,
      deletedAt: expect.anything()
    })
    await expect(
      (async () =>
        await knex.transaction(transaction =>
          managedRegistry.resolve(transaction, { ownerId: 7, sessionId: 'session-remove', profileResolutionToken: token })
        ))()
    ).rejects.toMatchObject({
      code: 'PROFILE_RESOLUTION_CHANGED',
      status: 409
    })
    await expect(Promise.resolve(managedRegistry.remove(created.id, 2))).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    expect(await managedRegistry.create({ ...profileInput, displayName: 'Removable', exposureMode: 'all_agent_users', actorId: 1 })).toMatchObject({
      displayName: 'Removable'
    })
  })

  it('persists explicit LLM image/document input opt-ins and routes their modalities', async () => {
    const mediaInputs = { images: true, documents: true, audio: false, video: false }
    const input = {
      ...profileInput,
      transportKind: 'gemini-api' as const,
      model: 'gemini-3.7-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key' as const,
      adapterConfig: { ...profileInput.adapterConfig, mediaInputs },
      displayName: 'Input Gemini',
      exposureMode: 'all_agent_users' as const,
      actorId: 1
    }
    const created = await registry.create(input)
    const versionId = await currentSettingsId(knex, created.id)
    await registry.setConformed(created.id, versionId, true, 1)
    await registry.setEnabled(created.id, true, 1, versionId)
    await knex('userGroups').insert({ userId: 7, groupId: 100 })
    await knex('agentSessions').insert({ id: 'media-routing', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent' })
    const candidates = await knex.transaction(transaction => registry.listRoutingCandidates(transaction, { ownerId: 7, sessionId: 'media-routing' }))
    expect((await registry.getAdmin(created.id)).adapterConfig.mediaInputs).toEqual(mediaInputs)
    expect(candidates[0]?.modalities).toEqual(['text', 'image', 'file'])

    const updated = await registry.update(created.id, {
      ...input,
      adapterConfig: { ...input.adapterConfig, mediaInputs: { ...mediaInputs, images: false } }
    })
    expect(updated.adapterConfig.mediaInputs).toEqual({ ...mediaInputs, images: false })
    const historical = await knex('agentProviderProfileVersions').where({ id: versionId }).first('adapterConfig')
    expect(JSON.parse(historical.adapterConfig).mediaInputs).toEqual(mediaInputs)
    const textOnly = await registry.create({ ...profileInput, displayName: 'Text only', exposureMode: 'all_agent_users', actorId: 1 })
    expect((await registry.getAdmin(textOnly.id)).adapterConfig.mediaInputs ?? { images: false, documents: false, audio: false, video: false }).toEqual({
      images: false,
      documents: false,
      audio: false,
      video: false
    })
  })

  it('reads immutable historical media settings but rejects legacy generation config on new writes', async () => {
    const created = await registry.create({
      ...profileInput,
      transportKind: 'gemini-api',
      model: 'gemini-3.7-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      displayName: 'Historical Gemini',
      exposureMode: 'all_agent_users',
      actorId: 1
    })
    const versionId = await currentSettingsId(knex, created.id)
    const media = {
      attachments: true,
      imageGeneration: { model: 'gemini-3.1-flash-image' as const, pricingRevision: 'image-v1|500000|60000000' },
      transcription: { model: 'gemini-3.5-transcribe' as const, pricingRevision: 'speech-v1|1000000|2000000' }
    }
    // Only pre-cutover stored versions can contain this block.
    await knex('agentProviderProfileVersions')
      .where({ id: versionId })
      .update({
        adapterConfig: JSON.stringify({ ...profileInput.adapterConfig, media })
      })
    expect((await registry.getAdmin(created.id)).adapterConfig.media).toEqual(media)
    await registry.setConformed(created.id, versionId, true, 1)
    await registry.setEnabled(created.id, true, 1, versionId)
    await knex('userGroups').insert({ userId: 7, groupId: 100 })
    await knex('agentSessions').insert({ id: 'historical-routing', ownerId: 7, version: 1, providerProfileId: null, executionMode: 'agent' })
    const candidates = await knex.transaction(transaction => registry.listRoutingCandidates(transaction, { ownerId: 7, sessionId: 'historical-routing' }))
    expect(candidates[0]?.modalities).toEqual(['text', 'image', 'file'])
    const invalid = { ...profileInput, adapterConfig: { ...profileInput.adapterConfig, media }, actorId: 1 }
    await expect(registry.create({ ...invalid, displayName: 'Legacy write', exposureMode: 'all_agent_users' })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_CONFIG',
      status: 400
    })
    await expect(registry.update(created.id, invalid)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG', status: 400 })
  })

  it.each([
    { transportKind: 'openai-chat' as const, mediaInputs: { images: false, documents: true, audio: false, video: false } },
    { transportKind: 'anthropic-messages' as const, mediaInputs: { images: false, documents: false, audio: true, video: false } },
    { transportKind: 'openai-responses' as const, mediaInputs: { images: false, documents: false, audio: false, video: true } }
  ])('rejects unsupported $transportKind media input combinations before persisting', async ({ transportKind, mediaInputs }) => {
    await expect(
      registry.create({
        ...profileInput,
        transportKind,
        authMode: transportKind === 'anthropic-messages' ? 'anthropic-api-key' : 'bearer',
        adapterConfig: { ...profileInput.adapterConfig, mediaInputs },
        displayName: 'Impossible inputs',
        exposureMode: 'all_agent_users',
        actorId: 1
      })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG', status: 400 })
    expect(await registry.listAll()).toEqual([])
  })

  it('rolls back a truly unreferenced temporary credential when profile creation fails', async () => {
    const vault = new DatabaseAgentSecretRegistry(knex, { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 10) } })
    const managedRegistry = new AgentProviderRegistry(knex, vault, {
      currentKeyId: 'primary',
      keys: { primary: 'a-profile-resolution-secret-with-rotation-room' }
    })
    const input = {
      ...profileInput,
      secretReference: null,
      secretValue: 'retained-key',
      displayName: 'Duplicate',
      exposureMode: 'all_agent_users' as const,
      actorId: 1
    }
    const created = await managedRegistry.create(input)
    const reference = (await knex('agentProviderProfileVersions').where({ profileId: created.id }).first('secretReference')).secretReference
    await expect(managedRegistry.create({ ...input, secretValue: 'temporary-failed-create-key' })).rejects.toThrow()
    expect(await knex('agentProviderSecrets').select('id')).toEqual([{ id: reference.slice('managed:'.length) }])
    expect(await vault.get(reference)).toBe('retained-key')
    expect(await knex('agentProviderProfileVersions').select('profileId')).toEqual([{ profileId: created.id }])
  })

  it('fails closed for private endpoints, forbidden headers, incompatible modes, and invalid credentials', async () => {
    await expect(
      Promise.resolve(
        registry.create({ ...profileInput, baseUrl: 'https://127.0.0.1/v1', displayName: 'Private', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_URL' })
    await expect(
      Promise.resolve(
        registry.create({
          ...profileInput,
          adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: { Authorization: 'secret' } },
          displayName: 'Headers',
          exposureMode: 'all_agent_users',
          actorId: 1
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_HEADERS' })
    await expect(
      Promise.resolve(
        registry.create({ ...profileInput, secretReference: 'sk-literal-secret', displayName: 'Literal secret', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_SECRET', status: 400 })
    await expect(
      Promise.resolve(
        registry.create({ ...profileInput, pricingRevision: 'price-v2|0|2000000', displayName: 'Unpriced input', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PRICING', status: 400 })
    await expect(
      Promise.resolve(
        registry.create({ ...profileInput, transportKind: 'legacy-completions', displayName: 'Legacy', exposureMode: 'all_agent_users', actorId: 1 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CAPABILITIES' })
    expect(
      await registry.create({
        ...profileInput,
        transportKind: 'legacy-completions',
        capabilities: { ...profileInput.capabilities, streaming: false, toolCalling: 'prompt', parallelToolCalls: false, structuredOutput: 'prompt-only' },
        displayName: 'Legacy prompt tools',
        exposureMode: 'all_agent_users',
        actorId: 1
      })
    ).toMatchObject({ transportKind: 'legacy-completions', capabilities: { toolCalling: 'prompt', parallelToolCalls: false } })
  })
})

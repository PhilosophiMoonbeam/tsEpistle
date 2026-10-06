import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import {
  AgentMediaInputsSchema,
  AgentMediaProviderConfigSchema,
  type AgentMediaProviderActor,
  type AgentMediaProviderWrite
} from '../../../shared/agents/media-providers.ts'
import { AgentMediaProviderRegistry, assertAgentMediaBinding, listAgentMediaBindings, resolveAgentMediaBindings } from '../../agents/media-providers.ts'
import { AgentProviderAdapterConfigSchema, CreateAgentProviderProfileSchema } from '../../agents/providers/registry.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addMedia } from '../../db/migrations/tsepistle-000055-agent-media-providers.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createAgentMediaTestDatabase } from './media-database.ts'

const postgresConnection = getPostgresTestConnection('_agent_media_providers_test', import.meta.path)

const actor: AgentMediaProviderActor = { id: 7, authVersion: 3 }
const image: AgentMediaProviderWrite = {
  displayName: 'Images',
  exposureMode: 'all_agent_users',
  secretValue: 'fixture-image-key',
  config: {
    kind: 'image',
    api: 'gemini-generate-content',
    model: 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: 30_000,
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    pricing: { kind: 'tokens', pricingRevision: 'image-v1|500000|60000000' }
  }
}
const initializeBaseDatabase = async (db: Knex): Promise<void> => {
  if (db.client.config.client !== 'pg') await db.raw('PRAGMA foreign_keys = ON')
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable()
    table.integer('authVersion').notNullable()
  })
  await db.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions').notNullable()
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId').references('id').inTable('users')
    table.integer('groupId').references('id').inTable('groups')
    table.primary(['userId', 'groupId'])
  })
  await db('users').insert([
    { id: 7, isActive: true, authVersion: 3 },
    { id: 8, isActive: true, authVersion: 2 },
    { id: 9, isActive: true, authVersion: 1 }
  ])
  await db('groups').insert([
    { id: 1, permissions: JSON.stringify(['manage:system']) },
    { id: 2, permissions: JSON.stringify(['use:agents']) },
    { id: 3, permissions: '[]' }
  ])
  await db('userGroups').insert([
    { userId: 7, groupId: 1 },
    { userId: 8, groupId: 2 }
  ])
  await addSecrets(db)
}

describe('independent media provider authority and immutable bindings', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  let vault: DatabaseAgentSecretRegistry
  let registry: AgentMediaProviderRegistry
  beforeEach(async () => {
    ;({ db, destroy: destroyDatabase } = await createAgentMediaTestDatabase(postgresConnection))
    await initializeBaseDatabase(db)
    await addMedia(db)
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } })
    registry = new AgentMediaProviderRegistry(db, vault)
  })
  afterEach(async () => destroyDatabase())

  it('requires live system authority for writes and Agent-enabled group authority even for unrestricted media', async () => {
    await expect(registry.create(image, { id: 8, authVersion: 2 })).rejects.toMatchObject({ code: 'MEDIA_ADMIN_REQUIRED', status: 403 })
    await expect(registry.create(image, { id: 7, authVersion: 2 })).rejects.toMatchObject({ code: 'MEDIA_ADMIN_REQUIRED', status: 403 })
    const created = await registry.create(image, actor)
    await registry.setEnabled(created.id, true, created.revision, actor)
    await expect(listAgentMediaBindings(db, 9)).rejects.toMatchObject({ code: 'AGENT_ACCESS_REVOKED' })
    await db('groups').where({ id: 1 }).update({ permissions: '[]' })
    await expect(registry.list(actor)).rejects.toMatchObject({ code: 'MEDIA_ADMIN_REQUIRED' })
    expect(await db('agentMediaProviders').select('id')).toHaveLength(1)
  })

  it('skips an unauthorized default and chooses the authorized display-name fallback inside admission', async () => {
    const restricted = await registry.create({ ...image, displayName: 'Default', exposureMode: 'groups', groupIds: [3] }, actor)
    const restrictedEnabled = await registry.setEnabled(restricted.id, true, restricted.revision, actor)
    await registry.setDefault(restricted.id, restrictedEnabled.revision, actor)
    const zulu = await registry.create({ ...image, displayName: 'Zulu' }, actor)
    await registry.setEnabled(zulu.id, true, zulu.revision, actor)
    const alpha = await registry.create({ ...image, displayName: 'Alpha' }, actor)
    await registry.setEnabled(alpha.id, true, alpha.revision, actor)
    expect(await db.transaction(tx => resolveAgentMediaBindings(tx, 8, ['image']))).toEqual({ image: alpha.profileVersionId })
    await expect(assertAgentMediaBinding(db, 8, 'image', restricted.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
    await db('userGroups').insert({ userId: 8, groupId: 3 })
    expect(await resolveAgentMediaBindings(db, 8, ['image'])).toEqual({ image: restricted.profileVersionId })
    await db('userGroups').where({ userId: 8, groupId: 3 }).delete()
    await expect(assertAgentMediaBinding(db, 8, 'image', restricted.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
    expect(await listAgentMediaBindings(db, 8)).toEqual({ image: alpha.profileVersionId })
    await expect(resolveAgentMediaBindings(db, 8, ['music'])).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
  })

  it('keeps defaults independent by operation and requires a usable enabled profile before assigning one', async () => {
    const first = await registry.create(image, actor)
    await expect(registry.setDefault(first.id, first.revision, actor)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_NOT_READY' })
    const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
    await registry.setDefault(first.id, enabled.revision, actor)
    const speech = await registry.create(
      { ...image, displayName: 'Speech', config: { ...image.config, kind: 'transcription', model: 'gemini-3.5-transcribe' } },
      actor
    )
    const speechEnabled = await registry.setEnabled(speech.id, true, speech.revision, actor)
    await registry.setDefault(speech.id, speechEnabled.revision, actor)
    expect(
      (await registry.list(actor))
        .filter(profile => profile.isDefault)
        .map(profile => profile.config.kind)
        .sort()
    ).toEqual(['image', 'transcription'])
    const draft = await registry.create({ displayName: 'No credential', exposureMode: 'all_agent_users', config: image.config }, actor)
    await expect(registry.setEnabled(draft.id, true, draft.revision, actor)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_NOT_READY' })
    const editedDraft = await registry.update(
      draft.id,
      {
        displayName: draft.displayName,
        exposureMode: draft.exposureMode,
        config: { ...image.config, api: 'openai-images', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1' }
      },
      draft.revision,
      actor
    )
    expect(editedDraft).toMatchObject({ enabled: false, isDefault: false, secretConfigured: false, config: { api: 'openai-images' } })
  })

  it('rejects stale or missing revisions without appending versions or changing enable/default state', async () => {
    const first = await registry.create(image, actor)
    const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
    await expect(registry.update(first.id, { ...image, displayName: 'Stale' }, first.revision, actor)).rejects.toMatchObject({
      code: 'MEDIA_PROVIDER_REVISION_CHANGED'
    })
    await expect(registry.remove(first.id, first.revision, actor)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_REVISION_CHANGED' })
    await expect(registry.setEnabled(first.id, false, first.revision, actor)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_REVISION_CHANGED' })
    await expect(registry.setDefault(first.id, undefined as unknown as number, actor)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_REVISION_CHANGED' })
    expect(await registry.list(actor)).toMatchObject([{ id: first.id, revision: enabled.revision, enabled: true, isDefault: false }])
    expect(await db('agentMediaProviderVersions').where({ providerId: first.id })).toHaveLength(1)
  })

  it('pins edited model/prices/credentials in a new version, rejects prior bindings, and retains every historical secret', async () => {
    const first = await registry.create(image, actor)
    const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
    const previous = await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first()
    const updated = await registry.update(
      first.id,
      {
        displayName: image.displayName,
        exposureMode: image.exposureMode,
        config: { ...image.config, model: 'gemini-3.1-flash-image', pricing: { kind: 'tokens', pricingRevision: 'edited-price|900000|80000000' } }
      },
      enabled.revision,
      actor
    )
    expect(updated.profileVersionId).not.toBe(first.profileVersionId)
    expect(await assertAgentMediaBinding(db, 8, 'image', updated.profileVersionId)).toMatchObject({
      config: { model: 'gemini-3.1-flash-image', pricing: { pricingRevision: 'edited-price|900000|80000000' } },
      secretReference: previous.secretReference
    })
    await expect(assertAgentMediaBinding(db, 8, 'image', first.profileVersionId)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_CHANGED' })
    await expect(assertAgentMediaBinding(db, 8, 'music', updated.profileVersionId)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_CHANGED' })
    expect(await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first()).toEqual(previous)
    const replaced = await registry.update(first.id, { ...image, secretValue: 'replacement-key' }, updated.revision, actor)
    expect(await vault.get(previous.secretReference)).toBe('fixture-image-key')
    await registry.remove(first.id, replaced.revision, actor)
    expect(await vault.get(previous.secretReference)).toBe('fixture-image-key')
    expect(await db('agentMediaProviderVersions').where({ providerId: first.id })).toHaveLength(3)
    expect(await registry.list(actor)).toEqual([])
    await expect(assertAgentMediaBinding(db, 8, 'image', replaced.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
  })

  const vendorChanges: readonly AgentMediaProviderWrite['config'][] = [
    { ...image.config, api: 'openai-images', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1' },
    {
      ...image.config,
      api: 'stability-images',
      model: 'stable-image-core',
      baseUrl: 'https://api.stability.ai/v2beta',
      pricing: { kind: 'fixed', pricingRevision: 'stability-v1', costMicros: 30_000 }
    }
  ]
  for (const config of vendorChanges) {
    for (const credential of ['managed-omitted', 'environment-omitted', 'environment-repeated'] as const) {
      it(`rejects ${config.api} origin changes with ${credential} credentials before committing configuration`, async () => {
        const name = `MEDIA_ORIGIN_${randomUUID().replaceAll('-', '').toUpperCase()}`
        const secretReference = `env:${name}`
        process.env[name] = 'fixture-image-key'
        try {
          const first = await registry.create(
            {
              displayName: image.displayName,
              config: image.config,
              exposureMode: 'groups',
              groupIds: [2],
              ...(credential === 'managed-omitted' ? { secretValue: 'fixture-image-key' } : { secretReference })
            },
            actor
          )
          const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
          const original = await registry.setDefault(first.id, enabled.revision, actor)
          const version = await db('agentMediaProviderVersions').where({ id: original.profileVersionId }).first()
          const configuration = await db('agentMediaProviderConfiguration').where({ id: 1 }).first()
          await expect(
            registry.update(
              first.id,
              {
                displayName: 'Changed vendor',
                config,
                exposureMode: 'all_agent_users',
                ...(credential === 'environment-repeated' ? { secretReference } : {})
              },
              original.revision,
              actor
            )
          ).rejects.toMatchObject({ code: 'INVALID_MEDIA_PROVIDER_CONFIG', status: 400 })
          expect(await registry.list(actor)).toEqual([original])
          expect(await db('agentMediaProviderVersions').where({ providerId: first.id })).toEqual([version])
          expect(await db('agentMediaProviderConfiguration').where({ id: 1 }).first()).toEqual(configuration)
          expect(await assertAgentMediaBinding(db, 8, 'image', original.profileVersionId)).toMatchObject({
            config: image.config,
            secretReference: version.secretReference
          })
          expect(await vault.get(version.secretReference)).toBe('fixture-image-key')
        } finally {
          delete process.env[name]
        }
      })
    }
  }

  it('accepts explicit cross-origin replacement assertions and clearing without rewriting historical credentials', async () => {
    const name = `MEDIA_REPLACEMENT_${randomUUID().replaceAll('-', '').toUpperCase()}`
    const secretReference = `env:${name}`
    process.env[name] = 'replacement-environment-key'
    try {
      const first = await registry.create(image, actor)
      const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
      let current = await registry.setDefault(first.id, enabled.revision, actor)
      const original = await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first()
      // Explicitly supplying even the same bytes is an administrator assertion, not an inferred vendor check.
      current = await registry.update(first.id, { ...image, config: vendorChanges[0]!, secretValue: 'fixture-image-key' }, current.revision, actor)
      expect(current).toMatchObject({ enabled: true, isDefault: true, secretConfigured: true })
      expect(await assertAgentMediaBinding(db, 8, 'image', current.profileVersionId)).toMatchObject({ config: vendorChanges[0] })
      current = await registry.update(
        first.id,
        { displayName: image.displayName, exposureMode: image.exposureMode, config: vendorChanges[1]!, secretReference },
        current.revision,
        actor
      )
      expect(await assertAgentMediaBinding(db, 8, 'image', current.profileVersionId)).toMatchObject({ secretReference })
      current = await registry.update(first.id, { ...image, secretValue: null }, current.revision, actor)
      expect(current).toMatchObject({ enabled: false, isDefault: false, secretConfigured: false })
      expect(await listAgentMediaBindings(db, 8)).toEqual({})
      expect(await vault.get(original.secretReference)).toBe('fixture-image-key')
    } finally {
      delete process.env[name]
    }
  })

  it('retains the Google credential and grants across GenerateContent and Interactions on the same origin', async () => {
    const first = await registry.create({ ...image, exposureMode: 'groups', groupIds: [2] }, actor)
    const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
    const original = await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first()
    const updated = await registry.update(
      first.id,
      {
        displayName: image.displayName,
        exposureMode: 'groups',
        groupIds: [2],
        config: {
          ...image.config,
          kind: 'music',
          api: 'gemini-interactions',
          model: 'lyria-3.5',
          pricing: { kind: 'fixed', pricingRevision: 'music-v1', costMicros: 80_000 }
        }
      },
      enabled.revision,
      actor
    )
    expect(updated).toMatchObject({ enabled: true, secretConfigured: true, groupIds: [2] })
    expect(await assertAgentMediaBinding(db, 8, 'music', updated.profileVersionId)).toMatchObject({ secretReference: original.secretReference })
    expect(await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first()).toEqual(original)
  })

  it('clears credentials only on an explicit null and revokes dispatch after owner Agent access is removed', async () => {
    const first = await registry.create(image, actor)
    const enabled = await registry.setEnabled(first.id, true, first.revision, actor)
    const original = await db('agentMediaProviderVersions').where({ id: first.profileVersionId }).first('secretReference')
    const cleared = await registry.update(
      first.id,
      { displayName: image.displayName, config: image.config, exposureMode: image.exposureMode, secretValue: null },
      enabled.revision,
      actor
    )
    expect(cleared).toMatchObject({ enabled: false, secretConfigured: false })
    expect(await vault.get(original.secretReference)).toBe('fixture-image-key')
    const restored = await registry.update(first.id, image, cleared.revision, actor)
    const restoredEnabled = await registry.setEnabled(first.id, true, restored.revision, actor)
    await db('userGroups').where({ userId: 8, groupId: 2 }).delete()
    await expect(assertAgentMediaBinding(db, 8, 'image', restoredEnabled.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_ACCESS_REVOKED' })
  })

  it('validates media-only model edits and explicit input permissions without reviving legacy generation writes', () => {
    expect(AgentMediaProviderConfigSchema.safeParse({ ...image.config, baseUrl: 'https://evil.example/v1beta' }).success).toBe(false)
    expect(AgentMediaInputsSchema.safeParse({ images: 'true' }).success).toBe(false)
    const legacy = {
      timeoutMs: 30_000,
      maxRetries: 0,
      media: { attachments: true, imageGeneration: { model: 'gemini-3.1-flash-image', pricingRevision: 'image-v1|1|2' } }
    }
    expect(AgentProviderAdapterConfigSchema.parse(legacy).mediaInputs).toBeUndefined()
    const profile = {
      displayName: 'Inference',
      exposureMode: 'all_agent_users',
      transportKind: 'openai-chat',
      model: 'custom-model',
      utilityModel: null,
      baseUrl: 'https://api.openai.com/v1',
      authMode: 'bearer',
      secretReference: 'env:TEST_KEY',
      capabilityRevision: 'test-v1',
      pricingRevision: 'test-v1|1|2',
      adapterConfig: { timeoutMs: 30_000, maxRetries: 0, mediaInputs: { images: true, documents: false, audio: true, video: false } },
      capabilities: {
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 16_000,
        maxOutputTokens: 4_000
      },
      policies: {
        allowedModes: ['agent'],
        dailyTokens: 100_000,
        dailyCostMicros: 1_000_000,
        reservationTokens: 16_000,
        reservationCostMicros: 100_000,
        reservationMilliseconds: 60_000,
        promptVersion: 1
      }
    }
    expect(CreateAgentProviderProfileSchema.safeParse(profile).success).toBe(true)
    expect(CreateAgentProviderProfileSchema.safeParse({ ...profile, adapterConfig: legacy }).success).toBe(false)
    expect(
      CreateAgentProviderProfileSchema.safeParse({ ...profile, adapterConfig: { ...profile.adapterConfig, mediaInputs: { documents: true } } }).success
    ).toBe(false)
    expect(CreateAgentProviderProfileSchema.safeParse({ ...profile, transportKind: 'openai-responses' }).success).toBe(false)
  })
})

describe('legacy independent media migration', () => {
  it('copies exact operation models/prices/grants/credentials while preserving all LLM rows and disabling former unsupported products', async () => {
    const { db, destroy } = await createAgentMediaTestDatabase(postgresConnection)
    try {
      await initializeBaseDatabase(db)
      await db.schema.createTable('agentProviderProfiles', table => {
        table.uuid('id').primary()
        table.string('displayName')
        table.uuid('currentVersionId')
        table.string('status')
        table.boolean('conformed')
        table.boolean('isGlobalDefault')
        table.string('exposureMode')
        table.integer('createdBy')
        table.integer('updatedBy')
        table.dateTime('deletedAt').nullable()
      })
      await db.schema.createTable('agentProviderProfileVersions', table => {
        table.uuid('id').primary()
        table.uuid('profileId')
        table.text('adapterConfig')
        table.text('capabilities')
        table.string('baseUrl')
        table.string('transportKind')
        table.string('authMode')
        table.string('secretReference')
        table.boolean('conformed')
      })
      await db.schema.createTable('agentProviderGrants', table => {
        table.uuid('profileId')
        table.integer('groupId')
      })
      const profileId = randomUUID(),
        versionId = randomUUID()
      const vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } })
      const secretReference = await db.transaction(tx => vault.store('legacy-shared-key', 7, tx))
      const media = {
        imageGeneration: { model: 'gemini-2.5-flash-image', pricingRevision: 'legacy-image|500000|60000000' },
        transcription: { model: 'gemini-3.5-transcribe', pricingRevision: 'legacy-transcribe|1000000|2000000' },
        videoGeneration: { model: 'gemini-omni-1.1-flash', pricingRevision: 'legacy-video|1500000|17500000', textOutputMicrosPerMillionTokens: 1000000 },
        musicGeneration: { model: 'lyria-3.5', costMicrosPerSong: 80000 }
      }
      await db('agentProviderProfiles').insert({
        id: profileId,
        displayName: 'Legacy',
        currentVersionId: versionId,
        status: 'enabled',
        conformed: true,
        isGlobalDefault: true,
        exposureMode: 'groups',
        createdBy: 7,
        updatedBy: 7,
        deletedAt: null
      })
      await db('agentProviderProfileVersions').insert({
        id: versionId,
        profileId,
        adapterConfig: JSON.stringify({ timeoutMs: 30_000, media }),
        capabilities: JSON.stringify({ maxContextTokens: 2_000_000, maxOutputTokens: 65_536 }),
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        transportKind: 'gemini-api',
        authMode: 'google-api-key',
        secretReference,
        conformed: true
      })
      await db('agentProviderGrants').insert({ profileId, groupId: 3 })
      const previousProfiles = await db('agentProviderProfiles'),
        previousVersions = await db('agentProviderProfileVersions'),
        previousSecrets = await db('agentProviderSecrets')
      await addMedia(db)
      expect(await db('agentProviderProfiles')).toEqual(previousProfiles)
      expect(await db('agentProviderProfileVersions')).toEqual(previousVersions)
      expect(await db('agentProviderSecrets')).toEqual(previousSecrets)
      const registry = new AgentMediaProviderRegistry(db, vault),
        profiles = await registry.list(actor)
      expect(profiles).toHaveLength(4)
      expect(profiles.find(profile => profile.config.kind === 'image')).toMatchObject({
        enabled: true,
        isDefault: true,
        exposureMode: 'groups',
        groupIds: [3],
        config: {
          model: 'gemini-2.5-flash-image',
          maxInputTokens: 32_768,
          maxOutputTokens: 8_192,
          pricing: { pricingRevision: 'legacy-image|500000|60000000' }
        }
      })
      expect(profiles.find(profile => profile.config.kind === 'video')).toMatchObject({
        enabled: false,
        isDefault: false,
        config: { api: 'gemini-interactions' }
      })
      expect(profiles.find(profile => profile.config.kind === 'music')).toMatchObject({
        enabled: false,
        config: { pricing: { kind: 'fixed', costMicros: 80000 } }
      })
      expect(profiles.find(profile => profile.config.kind === 'transcription')).toMatchObject({ enabled: true })
      expect((await db('agentMediaProviderVersions').select('secretReference')).every(row => row.secretReference === secretReference)).toBe(true)
      await expect(resolveAgentMediaBindings(db, 8, ['image'])).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
      await db('userGroups').insert({ userId: 8, groupId: 3 })
      expect(Object.keys(await listAgentMediaBindings(db, 8)).sort()).toEqual(['image', 'transcription'])
    } finally {
      await destroy()
    }
  })
})

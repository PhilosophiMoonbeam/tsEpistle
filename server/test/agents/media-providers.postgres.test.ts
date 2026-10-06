import type { Knex } from 'knex'
import type { AgentMediaProviderActor, AgentMediaProviderView, AgentMediaProviderWrite } from '../../../shared/agents/media-providers.ts'
import { AgentMediaProviderRegistry, assertAgentMediaBinding, listAgentMediaBindings, resolveAgentMediaBindings } from '../../agents/media-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addMedia } from '../../db/migrations/tsepistle-000055-agent-media-providers.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createAgentMediaTestDatabase } from './media-database.ts'

const connection = getPostgresTestConnection('_media_defaults_test', import.meta.path)
const suite = connection ? describe : describe.skip
const firstActor: AgentMediaProviderActor = { id: 7, authVersion: 3 }
const secondActor: AgentMediaProviderActor = { id: 9, authVersion: 1 }
const ownerId = 8
const image: AgentMediaProviderWrite = {
  displayName: 'Images',
  exposureMode: 'groups',
  groupIds: [2],
  secretValue: 'fixture-initial-image-key',
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
const edits: readonly AgentMediaProviderWrite[] = [
  {
    ...image,
    displayName: 'First concurrent edit',
    secretValue: 'fixture-first-edited-key',
    config: { ...image.config, model: 'gemini-3.1-flash-image', pricing: { kind: 'tokens', pricingRevision: 'first-edit|900000|80000000' } }
  },
  {
    ...image,
    displayName: 'Second concurrent edit',
    secretValue: 'fixture-second-edited-key',
    config: { ...image.config, model: 'gemini-3-pro-image-preview', pricing: { kind: 'tokens', pricingRevision: 'second-edit|1000000|90000000' } }
  }
]

const concurrently = async (
  db: Knex,
  operations: readonly (() => Promise<AgentMediaProviderView>)[]
): Promise<PromiseSettledResult<AgentMediaProviderView>[]> => {
  // Warm separate pooled connections so opening a second connection cannot serialize the writers.
  const connections = await Promise.all(operations.map(() => db.transaction()))
  await Promise.all(connections.map(transaction => transaction.commit()))
  const start = Promise.withResolvers<void>()
  const pending = operations.map(async operation => {
    await start.promise
    return operation()
  })
  const settled = Promise.allSettled(pending)
  start.resolve()
  return settled
}
const revisionWinner = (results: readonly PromiseSettledResult<AgentMediaProviderView>[]): { profile: AgentMediaProviderView; index: number } => {
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(results.find(result => result.status === 'rejected')).toMatchObject({
    reason: { code: 'MEDIA_PROVIDER_REVISION_CHANGED', status: 409 }
  })
  const index = results.findIndex(result => result.status === 'fulfilled')
  const winner = results[index]
  if (winner?.status !== 'fulfilled') throw new Error('Expected one committed native media mutation')
  return { profile: winner.value, index }
}

suite('PostgreSQL competing media default and profile writers', () => {
  let db: Knex
  let destroyDatabase: (() => Promise<void>) | undefined
  let vault: DatabaseAgentSecretRegistry
  let firstRegistry: AgentMediaProviderRegistry
  let secondRegistry: AgentMediaProviderRegistry

  beforeEach(async () => {
    ;({ db, destroy: destroyDatabase } = await createAgentMediaTestDatabase(connection))
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
      { id: firstActor.id, isActive: true, authVersion: firstActor.authVersion },
      { id: secondActor.id, isActive: true, authVersion: secondActor.authVersion },
      { id: ownerId, isActive: true, authVersion: 2 }
    ])
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']) },
      { id: 2, permissions: JSON.stringify(['use:agents']) }
    ])
    await db('userGroups').insert([
      { userId: firstActor.id, groupId: 1 },
      { userId: secondActor.id, groupId: 1 },
      { userId: ownerId, groupId: 2 }
    ])
    await addSecrets(db)
    await addMedia(db)
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } })
    firstRegistry = new AgentMediaProviderRegistry(db, vault)
    secondRegistry = new AgentMediaProviderRegistry(db, vault)
  })
  afterEach(async () => {
    await destroyDatabase?.()
    destroyDatabase = undefined
  })

  const enable = async (input: AgentMediaProviderWrite): Promise<AgentMediaProviderView> => {
    const created = await firstRegistry.create(input, firstActor)
    return firstRegistry.setEnabled(created.id, true, created.revision, firstActor)
  }
  const transcriptionDefault = async (): Promise<AgentMediaProviderView> => {
    const enabled = await enable({
      ...image,
      displayName: 'Speech',
      secretValue: 'fixture-speech-key',
      config: { ...image.config, kind: 'transcription', model: 'gemini-3.5-transcribe' }
    })
    return firstRegistry.setDefault(enabled.id, enabled.revision, firstActor)
  }

  // Different live administrators avoid serializing the race on the unrelated per-account lock.
  // These cases protect competing SQL writers, not the single-writer registry contract.
  it('serializes competing image defaults without disturbing an authorized transcription default', async () => {
    const speech = await transcriptionDefault()
    const first = await enable({ ...image, displayName: 'First image' })
    const second = await enable({ ...image, displayName: 'Second image' })
    const results = await concurrently(db, [
      () => firstRegistry.setDefault(first.id, first.revision, firstActor),
      () => secondRegistry.setDefault(second.id, second.revision, secondActor)
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const profiles = await firstRegistry.list(firstActor)
    const defaults = profiles.filter(profile => profile.isDefault)
    expect(defaults.filter(profile => profile.config.kind === 'image')).toHaveLength(1)
    expect(defaults.filter(profile => profile.config.kind === 'transcription')).toEqual([speech])
    const imageDefault = defaults.find(profile => profile.config.kind === 'image')!
    expect([first.id, second.id]).toContain(imageDefault.id)
    expect(imageDefault).toMatchObject({ enabled: true, secretConfigured: true, exposureMode: 'groups', groupIds: [2] })
    expect(await resolveAgentMediaBindings(db, ownerId, ['image', 'transcription'])).toEqual({
      image: imageDefault.profileVersionId,
      transcription: speech.profileVersionId
    })
    expect(await assertAgentMediaBinding(db, ownerId, 'image', imageDefault.profileVersionId)).toMatchObject({ providerId: imageDefault.id })
    expect(await db('agentMediaProviders').where({ enabled: true, isDefault: true }).whereNull('deletedAt').select('id')).toHaveLength(2)
  })

  it('commits only one same-revision config and credential edit and preserves the prior immutable version', async () => {
    const speech = await transcriptionDefault()
    const enabled = await enable(image)
    const initial = await firstRegistry.setDefault(enabled.id, enabled.revision, firstActor)
    const historical = await db('agentMediaProviderVersions').where({ id: initial.profileVersionId }).first()
    const credentialsBefore = await db('agentProviderSecrets').select('id')
    const results = await concurrently(db, [
      () => firstRegistry.update(initial.id, edits[0]!, initial.revision, firstActor),
      () => secondRegistry.update(initial.id, edits[1]!, initial.revision, secondActor)
    ])
    const { profile: winner, index } = revisionWinner(results)
    const expected = edits[index]!
    const profiles = await firstRegistry.list(firstActor)
    const current = profiles.find(profile => profile.id === initial.id)!
    expect(current).toEqual(winner)
    expect(current).toMatchObject({
      displayName: expected.displayName,
      config: expected.config,
      revision: initial.revision + 1,
      enabled: true,
      isDefault: true,
      groupIds: [2]
    })
    expect(current.profileVersionId).not.toBe(initial.profileVersionId)
    expect(profiles.find(profile => profile.id === speech.id)).toEqual(speech)
    expect(profiles.filter(profile => profile.isDefault && profile.config.kind === 'image')).toHaveLength(1)
    const binding = await assertAgentMediaBinding(db, ownerId, 'image', current.profileVersionId)
    expect(binding.config).toEqual(expected.config)
    expect(binding.secretReference).not.toBe(historical.secretReference)
    expect(await vault.get(binding.secretReference)).toBe(expected.secretValue)
    expect(await vault.get(historical.secretReference)).toBe(image.secretValue)
    expect(await resolveAgentMediaBindings(db, ownerId, ['image', 'transcription'])).toEqual({
      image: current.profileVersionId,
      transcription: speech.profileVersionId
    })
    await expect(assertAgentMediaBinding(db, ownerId, 'image', initial.profileVersionId)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_CHANGED' })
    await expect(secondRegistry.update(initial.id, edits[1 - index]!, initial.revision, secondActor)).rejects.toMatchObject({
      code: 'MEDIA_PROVIDER_REVISION_CHANGED',
      status: 409
    })
    expect(await firstRegistry.list(firstActor)).toEqual(profiles)
    expect(await db('agentMediaProviderVersions').where({ id: initial.profileVersionId }).first()).toEqual(historical)
    expect(await db('agentMediaProviderVersions').where({ providerId: initial.id })).toHaveLength(2)
    expect(await db('agentProviderSecrets').select('id')).toHaveLength(credentialsBefore.length + 1)
  })

  it('fences a same-revision edit against disable rather than losing config, credentials or default revocation', async () => {
    const speech = await transcriptionDefault()
    const enabled = await enable(image)
    const initial = await firstRegistry.setDefault(enabled.id, enabled.revision, firstActor)
    const historical = await db('agentMediaProviderVersions').where({ id: initial.profileVersionId }).first()
    const credentialsBefore = await db('agentProviderSecrets').select('id')
    const results = await concurrently(db, [
      () => firstRegistry.update(initial.id, edits[0]!, initial.revision, firstActor),
      () => secondRegistry.setEnabled(initial.id, false, initial.revision, secondActor)
    ])
    const { profile: winner, index } = revisionWinner(results)
    const edited = index === 0
    const profiles = await firstRegistry.list(firstActor)
    const current = profiles.find(profile => profile.id === initial.id)!
    expect(current).toEqual(winner)
    expect(current).toMatchObject({
      revision: initial.revision + 1,
      enabled: edited,
      isDefault: edited,
      config: edited ? edits[0]!.config : image.config,
      groupIds: [2]
    })
    expect(profiles.find(profile => profile.id === speech.id)).toEqual(speech)
    expect(profiles.filter(profile => profile.isDefault && profile.config.kind === 'image')).toHaveLength(edited ? 1 : 0)
    if (edited) {
      expect(current.profileVersionId).not.toBe(initial.profileVersionId)
      await expect(secondRegistry.setEnabled(initial.id, false, initial.revision, secondActor)).rejects.toMatchObject({
        code: 'MEDIA_PROVIDER_REVISION_CHANGED',
        status: 409
      })
    } else {
      expect(current.profileVersionId).toBe(initial.profileVersionId)
      await expect(firstRegistry.update(initial.id, edits[0]!, initial.revision, firstActor)).rejects.toMatchObject({
        code: 'MEDIA_PROVIDER_REVISION_CHANGED',
        status: 409
      })
      await expect(assertAgentMediaBinding(db, ownerId, 'image', current.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED' })
    }
    expect(await listAgentMediaBindings(db, ownerId)).toEqual({
      ...(edited ? { image: current.profileVersionId } : {}),
      transcription: speech.profileVersionId
    })
    const currentVersion = await db('agentMediaProviderVersions').where({ id: current.profileVersionId }).first()
    expect(await vault.get(currentVersion.secretReference)).toBe(edited ? edits[0]!.secretValue : image.secretValue)
    expect(await firstRegistry.list(firstActor)).toEqual(profiles)
    expect(await db('agentMediaProviderVersions').where({ id: initial.profileVersionId }).first()).toEqual(historical)
    expect(await db('agentMediaProviderVersions').where({ providerId: initial.id })).toHaveLength(edited ? 2 : 1)
    expect(await db('agentProviderSecrets').select('id')).toHaveLength(credentialsBefore.length + (edited ? 1 : 0))
  })
})

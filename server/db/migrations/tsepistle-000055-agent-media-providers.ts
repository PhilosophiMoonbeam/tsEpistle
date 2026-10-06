import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { AgentMediaProviderConfigSchema, type AgentMediaKind, type AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async db => {
    if (await db.schema.hasTable('agentMediaProviders')) return
    await db.schema.createTable('agentMediaProviderConfiguration', table => {
      table.integer('id').primary()
      table.bigInteger('revision').notNullable().defaultTo(1)
      table.check('"id" = 1 AND "revision" > 0')
    })
    await db('agentMediaProviderConfiguration').insert({ id: 1, revision: 1 })
    await db.schema.createTable('agentMediaProviders', table => {
      table.uuid('id').primary()
      table.string('displayName', 255).notNullable()
      table.uuid('currentVersionId').nullable()
      table.bigInteger('revision').notNullable().defaultTo(1)
      table.boolean('enabled').notNullable().defaultTo(false)
      table.boolean('isDefault').notNullable().defaultTo(false)
      table.string('exposureMode', 32).notNullable()
      table.integer('createdBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
      table.timestamp('deletedAt', { useTz: true }).nullable()
      table.check('"revision" > 0')
      table.check('NOT "isDefault" OR ("enabled" AND "deletedAt" IS NULL)')
      table.check("\"exposureMode\" IN ('all_agent_users', 'groups')")
      table.index(['enabled', 'exposureMode'], 'agent_media_providers_access_idx')
    })
    await db.schema.createTable('agentMediaProviderVersions', table => {
      table.uuid('id').primary()
      table.uuid('providerId').notNullable().references('id').inTable('agentMediaProviders').onDelete('RESTRICT')
      table.integer('version').notNullable()
      table.text('config').notNullable()
      table.string('secretReference', 255).nullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.unique(['providerId', 'version'], { indexName: 'agent_media_versions_sequence_unique' })
      table.unique(['providerId', 'id'], { indexName: 'agent_media_versions_owner_unique' })
      table.index('secretReference', 'agent_media_versions_secret_idx')
      table.check('"version" > 0')
    })
    await db.schema.alterTable('agentMediaProviders', table => {
      table
        .foreign(['id', 'currentVersionId'], 'agent_media_current_version_fk')
        .references(['providerId', 'id'])
        .inTable('agentMediaProviderVersions')
        .onDelete('RESTRICT')
    })
    await db.schema.createTable('agentMediaProviderGrants', table => {
      table.uuid('providerId').notNullable().references('id').inTable('agentMediaProviders').onDelete('RESTRICT')
      table.integer('groupId').notNullable().references('id').inTable('groups').onDelete('CASCADE')
      table.primary(['providerId', 'groupId'], 'agent_media_grants_pk')
    })
    if (!(await db.schema.hasTable('agentProviderProfiles')) || !(await db.schema.hasTable('agentProviderProfileVersions'))) return
    const profiles = await db('agentProviderProfiles')
      .whereNull('deletedAt')
      .whereNotNull('currentVersionId')
      .orderBy('isGlobalDefault', 'desc')
      .orderBy('displayName')
      .orderBy('id')
    const defaults: Partial<Record<AgentMediaKind, true>> = {}
    for (const profile of profiles) {
      const old = await db('agentProviderProfileVersions').where({ id: profile.currentVersionId, profileId: profile.id }).first()
      if (!old) throw new Error('Media provider migration found a missing current LLM version')
      const adapter = typeof old.adapterConfig === 'string' ? JSON.parse(old.adapterConfig) : old.adapterConfig
      if (!adapter?.media) continue
      // Independent operation bounds must not inherit a multi-million-token LLM
      // context window: reserve only the implemented bounded prompt/reference path.
      const maxInputTokens = 32_768
      const maxOutputTokens = 8_192
      const operations = [
        ['image', adapter.media.imageGeneration],
        ['video', adapter.media.videoGeneration],
        ['music', adapter.media.musicGeneration],
        ['transcription', adapter.media.transcription]
      ] as const
      const grants = await db('agentProviderGrants').where({ profileId: profile.id }).select('groupId')
      for (const [kind, operation] of operations) {
        if (!operation) continue
        const pricing: AgentMediaProviderConfig['pricing'] =
          kind === 'music'
            ? { kind: 'fixed', pricingRevision: `legacy-media-${old.id}`, costMicros: operation.costMicrosPerSong }
            : {
                kind: 'tokens',
                pricingRevision: operation.pricingRevision,
                ...(kind === 'video' ? { textOutputMicrosPerMillionTokens: operation.textOutputMicrosPerMillionTokens } : {})
              }
        const config = AgentMediaProviderConfigSchema.parse({
          kind,
          api: kind === 'video' || kind === 'music' ? 'gemini-interactions' : 'gemini-generate-content',
          model: operation.model,
          baseUrl: old.baseUrl.replace(/\/$/u, ''),
          timeoutMs: adapter.timeoutMs,
          maxInputTokens,
          maxOutputTokens,
          pricing
        })
        const native = old.transportKind === 'gemini-api' && old.authMode === 'google-api-key'
        const working =
          profile.status === 'enabled' && (profile.conformed === true || profile.conformed === 1) && (old.conformed === true || old.conformed === 1)
        // Omni/Lyria were never dispatched by the former GenerateContent engine.
        const enabled = (kind === 'image' || kind === 'transcription') && native && working && old.secretReference !== null
        const isDefault = enabled && !defaults[kind]
        if (isDefault) defaults[kind] = true
        const id = randomUUID(),
          versionId = randomUUID(),
          now = new Date()
        await db('agentMediaProviders').insert({
          id,
          displayName: `${profile.displayName} / ${kind}`.slice(0, 255),
          currentVersionId: null,
          revision: 1,
          enabled,
          isDefault,
          exposureMode: profile.exposureMode,
          createdBy: profile.createdBy,
          updatedBy: profile.updatedBy,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        })
        await db('agentMediaProviderVersions').insert({
          id: versionId,
          providerId: id,
          version: 1,
          config: JSON.stringify(config),
          secretReference: old.secretReference,
          createdAt: now
        })
        await db('agentMediaProviders').where({ id }).update({ currentVersionId: versionId })
        if (grants.length) await db('agentMediaProviderGrants').insert(grants.map((grant: { groupId: number }) => ({ providerId: id, groupId: grant.groupId })))
      }
    }
  })
}

export const down = async (): Promise<void> => {
  throw new Error('Independent media provider versions, credentials and admitted bindings must be retained; refuse destructive rollback')
}

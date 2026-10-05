import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { up, down } from '../../db/migrations/tsepistle-000049-agent-ax-gemini.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `agent_ax_${randomUUID().replaceAll('-', '')}`

suite('PostgreSQL immutable Ax provider cutover', () => {
  let root: Knex
  let db: Knex
  beforeAll(async () => {
    root = knexModule({ client: 'pg', connection: connection ?? undefined })
    await root.raw(`CREATE SCHEMA "${schema}"`)
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 1 } })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.uuid('currentVersionId').nullable()
      table.boolean('isGlobalDefault').notNullable()
      table.boolean('conformed').notNullable()
      table.string('status').notNullable()
      table.integer('policyVersion').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.uuid('profileId').references('id').inTable('agentProviderProfiles').notNullable()
      table.integer('version').notNullable()
      table.string('transportKind').notNullable()
      table.string('model').notNullable()
      table.string('baseUrl').notNullable()
      table.string('authMode').notNullable()
      table.string('secretReference').notNullable()
      table.text('adapterConfig').notNullable()
      table.text('capabilities').notNullable()
      table.string('capabilityRevision').notNullable()
      table.string('pricingRevision').notNullable()
      table.text('policies').notNullable()
      table.boolean('conformed').notNullable()
      table.integer('createdBy').notNullable()
      table.timestamp('createdAt').notNullable()
      table.unique(['profileId', 'version'])
    })
    await db.schema.createTable('agentProviderConfiguration', table => {
      table.integer('id').primary()
      table.integer('defaultGeneration').notNullable()
    })
    await db.schema.createTable('agentProviderGrants', table => {
      table.uuid('profileId')
      table.integer('groupId')
    })
    await db.schema.createTable('agentProviderSecrets', table => {
      table.uuid('id').primary()
      table.string('keyId')
      table.string('algorithm')
      table.binary('nonce')
      table.binary('authTag')
      table.binary('ciphertext')
      table.integer('createdBy')
      table.timestamp('createdAt')
    })
    await db.schema.createTable('agentSessions', table => {
      table.uuid('id').primary()
      table.boolean('googleSearchEnabled').notNullable()
      table.integer('version').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('providerProfileVersionId').references('id').inTable('agentProviderProfileVersions')
      table.boolean('googleSearchEnabled')
      table.bigInteger('totalTokens')
    })
    await db.schema.createTable('agentMessages', table => {
      table.uuid('id').primary()
      table.text('content')
      table.text('googleSearchGrounding')
      table.binary('providerStateCiphertext')
    })
    await db.schema.createTable('agentUsageLedger', table => {
      table.uuid('id').primary()
      table.bigInteger('totalTokens')
      table.bigInteger('costMicros')
    })
  })
  afterAll(async () => {
    if (db) await db.destroy()
    if (root) {
      await root.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await root.destroy()
    }
  })

  it('creates unconformed current versions for every adapter without rewriting retained versions, authority or accounting', async () => {
    const now = new Date('2026-09-01T00:00:00Z')
    const retained: Record<string, unknown>[] = []
    const secrets = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'test-fixture', keys: { 'test-fixture': Buffer.alloc(32, 1) } })
    for (const transportKind of ['gemini-api', 'openai-responses', 'openai-chat', 'anthropic-messages', 'openresponses', 'legacy-completions']) {
      const profileId = randomUUID()
      const versionId = randomUUID()
      await db('agentProviderProfiles').insert({
        id: profileId,
        currentVersionId: versionId,
        isGlobalDefault: transportKind === 'gemini-api',
        conformed: true,
        status: 'enabled',
        policyVersion: 3,
        updatedAt: now
      })
      const secretReference = await db.transaction(transaction => secrets.store('credential-fixture', 7, transaction))
      const version = {
        id: versionId,
        profileId,
        version: 7,
        transportKind,
        model: transportKind === 'gemini-api' ? 'gemini-3.7-flash' : 'test-model',
        baseUrl: 'https://provider.example.test/v1',
        authMode: 'bearer',
        secretReference,
        adapterConfig: '{"timeoutMs":10000,"maxRetries":0,"additionalHeaders":{}}',
        capabilities: '{"usage":"stream"}',
        capabilityRevision: 'previous-capability-revision',
        pricingRevision: 'price-v1|1000000|2000000',
        policies: '{"dailyTokens":100000}',
        conformed: true,
        createdBy: 7,
        createdAt: now
      }
      await db('agentProviderProfileVersions').insert(version)
      retained.push(await db('agentProviderProfileVersions').where({ id: versionId }).first())
      await db('agentProviderGrants').insert({ profileId, groupId: 9 })
      await db('agentRuns').insert({ id: randomUUID(), providerProfileVersionId: versionId, googleSearchEnabled: true, totalTokens: 99 })
    }
    await db('agentProviderConfiguration').insert({ id: 1, defaultGeneration: 12 })
    const sessionId = randomUUID()
    await db('agentSessions').insert({ id: sessionId, googleSearchEnabled: true, version: 2, updatedAt: now })
    const messageId = randomUUID()
    await db('agentMessages').insert({
      id: messageId,
      content: 'Retained grounded answer.',
      googleSearchGrounding: '{"citations":[{"url":"https://example.com/source"}]}',
      providerStateCiphertext: Buffer.from('opaque-retained-state')
    })
    await db('agentUsageLedger').insert({ id: randomUUID(), totalTokens: 99, costMicros: 123 })
    const before = {
      runs: await db('agentRuns').select('*').orderBy('id'),
      messages: await db('agentMessages').select('*'),
      ledger: await db('agentUsageLedger').select('*'),
      grants: await db('agentProviderGrants').select('*').orderBy('profileId')
    }
    const secretRows = await db('agentProviderSecrets').select('*').orderBy('id')

    await up(db)

    for (const old of retained) {
      expect(await db('agentProviderProfileVersions').where({ id: old.id }).first()).toEqual(old)
      const profile = await db('agentProviderProfiles').where({ id: old.profileId }).first()
      expect(profile).toMatchObject({ status: 'disabled', conformed: false, policyVersion: 4 })
      const current = await db('agentProviderProfileVersions').where({ id: profile.currentVersionId }).first()
      expect(current).toMatchObject({
        profileId: old.profileId,
        version: 8,
        transportKind: old.transportKind,
        secretReference: old.secretReference,
        pricingRevision: old.pricingRevision,
        adapterConfig: old.adapterConfig,
        policies: old.policies,
        conformed: false,
        capabilityRevision: `wiki-protocol-capabilities-v4:${old.transportKind}`
      })
      expect(current.id).not.toBe(old.id)
      expect(await secrets.get(String(current.secretReference))).toBe('credential-fixture')
    }
    expect(await db('agentProviderConfiguration').first()).toMatchObject({ defaultGeneration: 13 })
    expect(await db('agentSessions').where({ id: sessionId }).first()).toMatchObject({ googleSearchEnabled: false, version: 3 })
    expect(await db('agentRuns').select('*').orderBy('id')).toEqual(before.runs)
    expect(await db('agentMessages').select('*')).toEqual(before.messages)
    expect(await db('agentUsageLedger').select('*')).toEqual(before.ledger)
    expect(await db('agentProviderGrants').select('*').orderBy('profileId')).toEqual(before.grants)
    expect(await db('agentProviderSecrets').select('*').orderBy('id')).toEqual(secretRows)

    await up(db)
    expect(await db('agentProviderProfileVersions').count('id as count').first()).toEqual({ count: '12' })
    expect(await db('agentProviderConfiguration').first()).toMatchObject({ defaultGeneration: 13 })
    await expect(down()).rejects.toThrow('cannot restore retired Interactions')
  })
})

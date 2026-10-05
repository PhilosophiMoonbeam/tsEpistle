import { randomUUID } from 'node:crypto'
import type { lookup } from 'node:dns/promises'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addDecisionProviders, down as removeDecisionProviders } from '../../db/migrations/tsepistle-000051-agent-decision-providers.ts'
import { DecisionProviderRegistry, type DecisionProviderTransportOptions } from '../../agents/decision-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { TYPESAFE_DECISION_PROVIDER_ID, type DecisionProviderActor, type DecisionProviderWrite } from '../../../shared/agents/decision-providers.ts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `decision_providers_${randomUUID().replaceAll('-', '')}`
const actor: DecisionProviderActor = { id: 7, authVersion: 3 }
const config: DecisionProviderWrite = { displayName: 'Managed Jev', config: { kind: 'typesafe', model: 'jev-latest', timeoutMs: 1_000 } }
const compatible: DecisionProviderWrite = {
  displayName: 'Compatible decisions',
  config: { kind: 'openai-compatible', baseUrl: 'https://classifier.example/v1', dialect: 'chat-completions', model: 'decision-model', timeoutMs: 1_000 }
}
const publicDns = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup
const decision = {
  state: 'A short definition question',
  instructions: 'Select effort',
  criteria: { simple: 'Short factual answer', complex: 'Multi-step work' }
}

suite('PostgreSQL decision provider persistence and current authorization', () => {
  let db: Knex
  let secrets: DatabaseAgentSecretRegistry
  let registry: DecisionProviderRegistry
  let bootstrap: Record<string, unknown>
  let environmentKey: string | null
  let usedCredentials: string[]
  let transport: DecisionProviderTransportOptions
  beforeAll(async () => {
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.specificType('permissions', 'text[]').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('id').inTable('users')
      table.integer('groupId').references('id').inTable('groups')
      table.primary(['userId', 'groupId'])
    })
    await addSecrets(db)
    await addDecisionProviders(db)
    bootstrap = await db('agentDecisionProviders').where({ id: TYPESAFE_DECISION_PROVIDER_ID }).first()
    secrets = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } })
  })
  beforeEach(async () => {
    await db('agentDecisionProviders').delete()
    await db('agentProviderSecrets').delete()
    await db('userGroups').delete()
    await db('groups').delete()
    await db('users').delete()
    await db('users').insert([
      { id: 7, isActive: true, authVersion: 3 },
      { id: 8, isActive: true, authVersion: 2 },
      { id: 9, isActive: false, authVersion: 1 }
    ])
    await db('groups').insert([
      { id: 1, permissions: ['manage:system'] },
      { id: 2, permissions: ['use:agents'] }
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 1 },
      { userId: 8, groupId: 2 },
      { userId: 9, groupId: 1 }
    ])
    await db('agentDecisionProviders').insert(bootstrap)
    environmentKey = 'fixture-environment-key'
    usedCredentials = []
    transport = {
      resolve: publicDns,
      environmentKey: () => environmentKey,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(String(input))
          usedCredentials.push(new Headers(init?.headers).get('authorization') ?? '')
          if (url.pathname === '/v1/models')
            return Response.json(
              url.hostname === 'api.typesafe.ai'
                ? { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] }
                : { data: [{ id: 'decision-model' }] }
            )
          const body = JSON.parse(String(init?.body))
          const criteria = url.hostname === 'api.typesafe.ai' ? body.questions.decision.criteria : JSON.parse(body.messages[1].content).criteria
          const labels = Object.keys(criteria)
          const answer = { choice: labels[0], probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 1 : 0])), confidence: 1 }
          return Response.json(
            url.hostname === 'api.typesafe.ai'
              ? { model: 'jev-1.13.0', answers: { decision: { type: 'choice', ...answer } }, usage: { input_tokens: 100, output_tokens: 3 } }
              : {
                  id: 'fixture',
                  created: 0,
                  object: 'chat.completion',
                  model: 'decision-model',
                  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
                  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
                }
          )
        },
        { preconnect: () => {} }
      ) as typeof fetch
    }
    registry = new DecisionProviderRegistry(db, secrets, transport)
  })
  afterAll(async () => {
    if (db) await db.destroy()
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  it('bootstraps native Jev without copying environment credentials into the database or LLM profiles', async () => {
    expect(await registry.selectRuntime()).toMatchObject({
      id: TYPESAFE_DECISION_PROVIDER_ID,
      config: { kind: 'typesafe', model: 'jev-latest', pricing: { inputPerMillion: 0.042, outputPerMillion: 0 } }
    })
    const view = await registry.get(TYPESAFE_DECISION_PROVIDER_ID, actor)
    expect(view).toMatchObject({ enabled: true, isDefault: true, secretConfigured: true, credentialSource: 'environment' })
    expect(await db('agentProviderSecrets')).toHaveLength(0)
    expect(await db.schema.hasTable('agentProviderProfiles')).toBe(false)
    expect(await registry.decide(decision)).toMatchObject({
      providerId: TYPESAFE_DECISION_PROVIDER_ID,
      usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, totalTokensSource: 'derived' }
    })
    expect(usedCredentials).toEqual(['Bearer fixture-environment-key'])
    environmentKey = 'fixture unusable'
    await expect(registry.selectRuntime()).rejects.toMatchObject({ code: 'DECISION_CREDENTIAL_UNAVAILABLE' })
    expect(usedCredentials).toEqual(['Bearer fixture-environment-key'])
    environmentKey = null
    await expect(registry.selectRuntime()).rejects.toMatchObject({ code: 'DECISION_CREDENTIAL_UNAVAILABLE' })
  })

  it('persists checked, enabled and default selection across registry instances using encrypted managed credentials', async () => {
    let view = await registry.create({ ...config, secretValue: 'fixture-managed-key' }, actor)
    expect(view).toMatchObject({ enabled: false, isDefault: false, revision: 1, credentialSource: 'managed' })
    expect(view).not.toHaveProperty('secretReference')
    expect(view).not.toHaveProperty('secretValue')
    const raw = await db('agentDecisionProviders').where({ id: view.id }).first()
    expect(raw.secretReference).toMatch(/^managed:/)
    const stored = await db('agentProviderSecrets').first()
    expect(Buffer.from(stored.ciphertext).toString()).not.toContain('fixture-managed-key')
    await expect(registry.setEnabled(view.id, true, view.revision, actor)).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_READY' })
    const checked = await registry.check(view.id, view.revision, actor)
    expect(checked).toMatchObject({
      availableModels: ['jev-latest'],
      configuredModelAvailable: true,
      model: 'jev-1.13.0',
      usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, totalTokensSource: 'derived' }
    })
    view = await registry.setEnabled(view.id, true, view.revision, actor)
    view = await registry.setDefault(view.id, view.revision, actor)
    const fresh = new DecisionProviderRegistry(db, secrets, transport)
    expect(await fresh.selectRuntime()).toMatchObject({ id: view.id, revision: view.revision })
    await fresh.decide(decision)
    expect(usedCredentials.every(value => value === 'Bearer fixture-managed-key')).toBe(true)
    expect(await db('agentDecisionProviders').where({ isDefault: true })).toHaveLength(1)
    await expect(removeDecisionProviders(db)).rejects.toThrow('refuse destructive rollback')
  })

  it('does not mark an absent pinned version ready when inference answers with a different Jev model', async () => {
    const view = await registry.create({ ...config, config: { ...config.config, model: 'jev-9.99.0' }, secretValue: 'fixture-pin' }, actor)
    await expect(registry.check(view.id, view.revision, actor)).rejects.toMatchObject({
      code: 'DECISION_MODEL_MISMATCH',
      providerId: view.id,
      providerRevision: view.revision,
      usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, totalTokensSource: 'derived' }
    })
    expect(await registry.get(view.id, actor)).toMatchObject({ checkedAt: null, enabled: false, isDefault: false })
    await expect(registry.setEnabled(view.id, true, view.revision, actor)).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_READY' })
  })

  it('rejects unusable managed bearer values without changing configuration or storing a secret', async () => {
    for (const secretValue of ['fixture key', 'fixture\nkey', 'fixtureékey']) {
      await expect(registry.create({ ...config, secretValue }, actor)).rejects.toMatchObject({ code: 'INVALID_DECISION_PROVIDER_CONFIG' })
    }
    expect(await db('agentProviderSecrets')).toHaveLength(0)
    expect(await db('agentDecisionProviders')).toHaveLength(1)
  })

  it('retains omitted managed secrets, explicitly clears them, and never falls through a broken managed credential', async () => {
    let view = await registry.create({ ...config, secretValue: 'fixture-managed-first' }, actor)
    view = await registry.update(view.id, { ...config, displayName: 'Retained' }, view.revision, actor)
    await registry.check(view.id, view.revision, actor)
    expect(usedCredentials.every(value => value === 'Bearer fixture-managed-first')).toBe(true)
    await db('agentProviderSecrets').delete()
    await expect(registry.check(view.id, view.revision, actor)).rejects.toMatchObject({ code: 'DECISION_CREDENTIAL_UNAVAILABLE' })
    expect((await registry.get(view.id, actor)).credentialSource).toBe('managed')
    view = await registry.update(view.id, { ...config, secretValue: null }, view.revision, actor)
    expect(view).toMatchObject({ credentialSource: 'environment', secretConfigured: true, enabled: false, checkedAt: null })
    usedCredentials = []
    await registry.check(view.id, view.revision, actor)
    expect(usedCredentials.every(value => value === 'Bearer fixture-environment-key')).toBe(true)
  })

  it('requires custom credentials and honors a disabled default instead of silently switching back to environment Jev', async () => {
    let view = await registry.create(compatible, actor)
    expect(view).toMatchObject({ secretConfigured: false, credentialSource: 'none' })
    await expect(registry.check(view.id, view.revision, actor)).rejects.toMatchObject({ code: 'DECISION_CREDENTIAL_UNAVAILABLE' })
    view = await registry.update(view.id, { ...compatible, secretValue: 'fixture-compatible' }, view.revision, actor)
    expect(await registry.check(view.id, view.revision, actor)).toMatchObject({
      configuredModelAvailable: true,
      availableModels: ['decision-model'],
      model: 'decision-model',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, totalTokensSource: 'reported' }
    })
    view = await registry.setEnabled(view.id, true, view.revision, actor)
    view = await registry.setDefault(view.id, view.revision, actor)
    expect(await registry.decide(decision)).toMatchObject({
      providerId: view.id,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, totalTokensSource: 'reported' }
    })
    expect(usedCredentials.every(value => value === 'Bearer fixture-compatible')).toBe(true)
    await registry.setEnabled(view.id, false, view.revision, actor)
    await expect(registry.selectRuntime()).rejects.toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE' })
    await expect(registry.selectRuntime(view.id)).rejects.toMatchObject({ code: 'DECISION_PROVIDER_UNAVAILABLE' })
  })

  it('serializes optimistic writes so a stale concurrent mutation cannot overwrite settings or leak an orphan secret', async () => {
    const view = await registry.create({ ...config, secretValue: 'fixture-first' }, actor)
    const secondDb = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    try {
      const other = new DecisionProviderRegistry(
        secondDb,
        new DatabaseAgentSecretRegistry(secondDb, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } }),
        transport
      )
      const outcomes = await Promise.allSettled([
        registry.update(view.id, { ...config, displayName: 'Write A', secretValue: 'fixture-a' }, view.revision, actor),
        other.update(view.id, { ...config, displayName: 'Write B', secretValue: 'fixture-b' }, view.revision, actor)
      ])
      expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
      expect(outcomes.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'DECISION_PROVIDER_REVISION_CHANGED' } })
      expect(await db('agentProviderSecrets')).toHaveLength(1)
      expect(await registry.get(view.id, actor)).toMatchObject({ revision: 2, enabled: false, checkedAt: null })
    } finally {
      await secondDb.destroy()
    }
  })

  it('checks current account generation, activation and live membership instead of trusting stale administrator claims', async () => {
    for (const denied of [
      { id: 7, authVersion: 2 },
      { id: 8, authVersion: 2 },
      { id: 9, authVersion: 1 },
      { id: 2, authVersion: 0 }
    ]) {
      await expect(registry.list(denied)).rejects.toMatchObject({ code: 'DECISION_ADMIN_REQUIRED', status: 403 })
      await expect(registry.create({ ...config, secretValue: 'fixture-denied' }, denied)).rejects.toMatchObject({ code: 'DECISION_ADMIN_REQUIRED' })
    }
    await db('groups').where({ id: 1 }).update({ permissions: [] })
    await expect(registry.get(TYPESAFE_DECISION_PROVIDER_ID, actor)).rejects.toMatchObject({ code: 'DECISION_ADMIN_REQUIRED' })
    expect(await db('agentProviderSecrets')).toHaveLength(0)
    expect(await db('agentDecisionProviders')).toHaveLength(1)
  })

  it('invalidates readiness and default after a config change and deletes replaced credentials atomically', async () => {
    let view = await registry.create({ ...config, secretValue: 'fixture-old' }, actor)
    await registry.check(view.id, view.revision, actor)
    view = await registry.setEnabled(view.id, true, view.revision, actor)
    view = await registry.setDefault(view.id, view.revision, actor)
    const oldReference = (await db('agentDecisionProviders').where({ id: view.id }).first()).secretReference
    view = await registry.update(view.id, { ...config, secretValue: 'fixture-new' }, view.revision, actor)
    expect(view).toMatchObject({ enabled: false, isDefault: false, checkedAt: null })
    expect(await secrets.get(oldReference)).toBeNull()
    expect(await db('agentProviderSecrets')).toHaveLength(1)
    await registry.remove(view.id, view.revision, actor)
    expect(await db('agentProviderSecrets')).toHaveLength(0)
    await expect(registry.get(view.id, actor)).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_FOUND' })
  })

  it('does not mark a changed configuration ready when an older connection check finishes', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const baseFetch = transport.fetch!
    const checking = new DecisionProviderRegistry(db, secrets, {
      ...transport,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (new URL(String(input)).pathname === '/v1/systemone') {
            started.resolve()
            await release.promise
          }
          return baseFetch(input, init)
        },
        { preconnect: () => {} }
      ) as typeof fetch
    })
    const view = await registry.create({ ...config, secretValue: 'fixture-check' }, actor)
    const result = checking.check(view.id, view.revision, actor).then(
      value => ({ value }),
      error => ({ error })
    )
    await started.promise
    await registry.update(view.id, { ...config, displayName: 'Changed while checking' }, view.revision, actor)
    release.resolve()
    expect(await result).toMatchObject({
      error: { code: 'DECISION_PROVIDER_REVISION_CHANGED', usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, totalTokensSource: 'derived' } }
    })
    expect(await registry.get(view.id, actor)).toMatchObject({ revision: 2, checkedAt: null, enabled: false })
  })

  it('rejects an in-flight runtime decision after admin disable while retaining its measured usage', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const baseFetch = transport.fetch!
    const active = new DecisionProviderRegistry(db, secrets, {
      ...transport,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (new URL(String(input)).pathname === '/v1/systemone') {
            started.resolve()
            await release.promise
          }
          return baseFetch(input, init)
        },
        { preconnect: () => {} }
      ) as typeof fetch
    })
    const pending = active.decide(decision).then(
      value => ({ value }),
      error => ({ error })
    )
    await started.promise
    await registry.setEnabled(TYPESAFE_DECISION_PROVIDER_ID, false, 1, actor)
    release.resolve()
    expect(await pending).toMatchObject({
      error: {
        code: 'DECISION_PROVIDER_REVISION_CHANGED',
        usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, totalTokensSource: 'derived' },
        estimatedCostMicros: 5
      }
    })
  })
})

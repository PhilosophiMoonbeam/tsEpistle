import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { AgentRunClaim } from '../../agents/coordinator.ts'
import { AgentSpecialistStore, type BeginSpecialistInvocationInput, type CompleteSpecialistInvocationInput } from '../../agents/specialists.ts'
import { up as addSpecialists } from '../../db/migrations/tsepistle-000054-agent-specialists.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('PostgreSQL independent specialist transaction fences', () => {
  let db: Knex
  let secondDb: Knex
  let schema: string
  let store: AgentSpecialistStore
  let secondStore: AgentSpecialistStore
  let begin: BeginSpecialistInvocationInput
  let completion: CompleteSpecialistInvocationInput
  let root: AgentRunClaim
  beforeEach(async () => {
    schema = `agent_specialists_${randomUUID().replaceAll('-', '')}`
    const admin = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }
    db = createKnex({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    secondDb = createKnex({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('agentSessions', table => {
      table.uuid('id').primary()
      table.integer('ownerId').notNullable()
      table.timestamp('expiresAt', { useTz: true }).nullable()
      table.timestamp('deletedAt', { useTz: true }).nullable()
    })
    await db.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
      table.integer('ownerId').notNullable()
      table.string('status').notNullable()
      table.integer('attempts').notNullable()
      table.string('leaseOwner').notNullable()
      table.uuid('leaseToken').notNullable()
      table.timestamp('leaseExpiresAt', { useTz: true }).notNullable()
      table.timestamp('cancelRequestedAt', { useTz: true }).nullable()
    })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.uuid('currentVersionId').notNullable()
      table.integer('policyVersion').notNullable()
      table.string('status').notNullable()
      table.boolean('conformed').notNullable()
      table.string('exposureMode').notNullable()
      table.timestamp('deletedAt', { useTz: true }).nullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.uuid('profileId').notNullable()
      table.string('model').notNullable()
      table.string('transportKind').notNullable()
      table.string('capabilityRevision').notNullable()
      table.boolean('conformed').notNullable()
    })
    await db.schema.createTable('agentRoutingPolicy', table => {
      table.integer('id').primary()
      table.text('config').notNullable()
    })
    await db('agentRoutingPolicy').insert({ id: 1, config: '{}' })
    await addSpecialists(db)
    const binding = {
      profileId: randomUUID(),
      profileVersionId: randomUUID(),
      model: 'specialist-model',
      transportKind: 'openai-compatible',
      capabilityRevision: 'capability-1',
      profilePolicyVersion: 1,
      ownerAuthVersion: 1
    }
    await db('users').insert({ id: 7, isActive: true, authVersion: 1 })
    await db('agentProviderProfiles').insert({
      id: binding.profileId,
      currentVersionId: binding.profileVersionId,
      policyVersion: 1,
      status: 'enabled',
      conformed: true,
      exposureMode: 'all_agent_users',
      deletedAt: null
    })
    await db('agentProviderProfileVersions').insert({
      id: binding.profileVersionId,
      profileId: binding.profileId,
      model: binding.model,
      transportKind: binding.transportKind,
      capabilityRevision: binding.capabilityRevision,
      conformed: true
    })
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + 86_400_000)
    await db('agentSessions').insert({ id: sessionId, ownerId: 7, expiresAt, deletedAt: null })
    root = {
      id: randomUUID(),
      sessionId,
      ownerId: 7,
      status: 'running',
      attempts: 1,
      leaseOwner: 'postgres-specialist-test',
      leaseToken: randomUUID(),
      leaseExpiresAt: expiresAt.toISOString(),
      cancelRequestedAt: null,
      providerProfileVersionId: binding.profileVersionId,
      transportKind: binding.transportKind,
      model: binding.model,
      executionMode: 'agent',
      googleSearchEnabled: false,
      capabilityRevision: binding.capabilityRevision,
      pricingRevision: 'price-1',
      promptVersion: 1,
      totalTokens: 0,
      maxAttempts: 3,
      eventSequence: 1,
      sideEffectsStarted: false,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      goalId: null,
      goalContinuation: null,
      clientRequestId: randomUUID(),
      clientRequestSha256: 'c'.repeat(64),
      errorCode: null,
      errorMessage: null,
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null
    }
    await db('agentRuns').insert({
      id: root.id,
      sessionId,
      ownerId: 7,
      status: 'running',
      attempts: 1,
      leaseOwner: root.leaseOwner,
      leaseToken: root.leaseToken,
      leaseExpiresAt: expiresAt,
      cancelRequestedAt: null
    })
    begin = {
      contextId: null,
      contextVersion: null,
      binding,
      scopeSha256: 'a'.repeat(64),
      taskClass: 'coding',
      complexity: 'moderate',
      maximumContexts: 1,
      maximumContextBytes: 65_536,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    }
    completion = {
      history: [
        { role: 'user', content: 'Independent task' },
        { role: 'assistant', content: 'Successful context' }
      ],
      state: { transcript: ['opaque host snapshot'] },
      report: 'Committed report',
      authoritySha256: 'b'.repeat(64),
      maximumContextBytes: 65_536,
      maximumReportBytes: 4096
    }
    store = new AgentSpecialistStore(db)
    secondStore = new AgentSpecialistStore(secondDb)
  })
  afterEach(async () => {
    await secondDb?.destroy()
    await db?.destroy()
    const admin = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  it('deduplicates simultaneous begins and concurrent completion across native connections', async () => {
    const starts = await Promise.all([store.begin(root, begin), secondStore.begin(root, begin)])
    expect(starts.map(result => result.replayed).sort()).toEqual([false, true])
    expect(starts[0]?.invocation.id).toBe(starts[1]?.invocation.id)
    const invocationId = starts[0]!.invocation.id
    const receipts = await Promise.all([store.complete(root, invocationId, completion), secondStore.complete(root, invocationId, completion)])
    expect(receipts[0]).toEqual(receipts[1])
    expect(await db('agentSpecialistContexts').select('version', 'turnCount')).toEqual([{ version: 2, turnCount: 1 }])
    expect(await db('agentSpecialistInvocations')).toHaveLength(1)
  })

  it('serializes separate-root reuse claims on a retained context and fences cancellation before commit', async () => {
    const started = await store.begin(root, begin)
    await store.complete(root, started.invocation.id, completion)
    const retained = await db('agentSpecialistContexts').first()
    const first: AgentRunClaim = { ...root, id: randomUUID(), leaseToken: randomUUID() }
    const second: AgentRunClaim = { ...root, id: randomUUID(), leaseToken: randomUUID() }
    for (const claim of [first, second])
      await db('agentRuns').insert({
        id: claim.id,
        sessionId: claim.sessionId,
        ownerId: 7,
        status: 'running',
        attempts: 1,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: new Date(claim.leaseExpiresAt),
        cancelRequestedAt: null
      })
    const reuse = { ...begin, contextId: started.context.id, contextVersion: 2 }
    const results = await Promise.allSettled([store.begin(first, reuse), secondStore.begin(second, reuse)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'AGENT_SPECIALIST_CONTEXT_BUSY' } })
    const index = results.findIndex(result => result.status === 'fulfilled')
    const winner = results[index]
    if (winner?.status !== 'fulfilled') throw new Error('Expected exactly one native winning claim')
    const claim = index === 0 ? first : second
    const cancelling = await secondDb.transaction()
    await cancelling('agentRuns').where({ id: claim.id }).forUpdate().update({ cancelRequestedAt: new Date() })
    const commit = store.complete(claim, winner.value.invocation.id, { ...completion, report: 'Cancelled mutation' })
    // The committed cancellation precedes the row-locked persistence attempt.
    await cancelling.commit()
    await expect(commit).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
    expect(await db('agentSpecialistContexts').first()).toEqual(retained)
    expect(await store.readInvocation({ ownerId: 7, rootSessionId: claim.sessionId, rootRunId: claim.id })).toMatchObject({ status: 'running', report: null })
  })
})

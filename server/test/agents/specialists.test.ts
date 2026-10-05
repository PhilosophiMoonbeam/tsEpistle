import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { SpecialistContext, SpecialistProviderBinding } from '../../../shared/agents/specialists.ts'
import type { AgentRunClaim } from '../../agents/coordinator.ts'
import { AgentSpecialistStore, type BeginSpecialistInvocationInput, type CompleteSpecialistInvocationInput } from '../../agents/specialists.ts'
import { up as addSpecialists, down as removeSpecialists } from '../../db/migrations/tsepistle-000054-agent-specialists.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const scopeSha256 = 'a'.repeat(64)
const authoritySha256 = 'b'.repeat(64)
const legacyPolicy = {
  enabled: true,
  decisionProviderId: null,
  minimumConfidence: 0.99,
  minimumSavingsRatio: 0.3,
  minimumSavingsMicros: 1234,
  switchCostMicros: 17,
  classifierMaxStateBytes: 4096,
  retainedUnknownSetting: 'preserve'
}

interface SpecialistFixture {
  readonly binding: SpecialistProviderBinding
  readonly rootSessionId: string
  readonly rootExpiresAt: Date
  readonly expiresAt: string
  readonly claim: (sessionId?: string, ownerId?: number) => Promise<AgentRunClaim>
  readonly begin: BeginSpecialistInvocationInput
  readonly completion: CompleteSpecialistInvocationInput
}

const createTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable()
    table.integer('authVersion').notNullable()
  })
  await db.schema.createTable('agentSessions', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
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
    table.timestamp('deletedAt').nullable()
  })
  await db.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.uuid('profileId').notNullable()
    table.string('model').notNullable()
    table.string('transportKind').notNullable()
    table.string('capabilityRevision').notNullable()
    table.boolean('conformed').notNullable()
  })
  await db.schema.createTable('agentProviderGrants', table => {
    table.uuid('profileId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('agentRoutingPolicy', table => {
    table.integer('id').primary()
    table.text('config').notNullable()
    table.integer('revision').notNullable()
  })
  await db.schema.createTable('agentUsageLedger', table => {
    table.uuid('id').primary()
    table.integer('totalTokens').notNullable()
  })
  await db.schema.createTable('agentEvents', table => {
    table.uuid('id').primary()
    table.text('data').notNullable()
  })
  await db('agentRoutingPolicy').insert({ id: 1, config: JSON.stringify(legacyPolicy), revision: 19 })
  await db('agentUsageLedger').insert({ id: randomUUID(), totalTokens: 917 })
  await db('agentEvents').insert({ id: randomUUID(), data: 'retained usage event' })
  await addSpecialists(db)
}

/** Fixture owns only real DB inputs; the tested store creates all specialist rows. */
const fixture = async (db: Knex): Promise<SpecialistFixture> => {
  const binding: SpecialistProviderBinding = {
    profileId: randomUUID(),
    profileVersionId: randomUUID(),
    model: 'specialist-model',
    transportKind: 'openai-compatible',
    capabilityRevision: 'capability-1',
    profilePolicyVersion: 1,
    ownerAuthVersion: 1
  }
  const rootSessionId = randomUUID()
  const rootExpiresAt = new Date(Date.now() + 86_400_000)
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  await db('users').insert([
    { id: 7, isActive: true, authVersion: 1 },
    { id: 8, isActive: true, authVersion: 1 }
  ])
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
  await db('agentSessions').insert({ id: rootSessionId, ownerId: 7, expiresAt: rootExpiresAt, deletedAt: null })
  const claim = async (sessionId = rootSessionId, ownerId = 7): Promise<AgentRunClaim> => {
    const row = {
      id: randomUUID(),
      sessionId,
      ownerId,
      status: 'running' as const,
      attempts: 1,
      leaseOwner: 'specialist-test',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 86_400_000),
      cancelRequestedAt: null
    }
    await db('agentRuns').insert(row)
    return {
      ...row,
      leaseExpiresAt: row.leaseExpiresAt.toISOString(),
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
  }
  const begin = {
    contextId: null,
    contextVersion: null,
    binding,
    scopeSha256,
    taskClass: 'coding' as const,
    complexity: 'moderate' as const,
    maximumContexts: 4,
    maximumContextBytes: 65_536,
    expiresAt
  }
  const completion = {
    history: [
      { role: 'user' as const, content: 'Independent task' },
      { role: 'assistant' as const, content: 'Specialist result' }
    ],
    state: { transcript: [{ role: 'assistant', content: 'opaque host snapshot' }], observations: [] },
    report: 'Bounded report',
    authoritySha256,
    maximumContextBytes: 65_536,
    maximumReportBytes: 4096
  }
  return { binding, rootSessionId, rootExpiresAt, expiresAt, claim, begin, completion }
}

describe('native SQLite specialist persistence', () => {
  let db: Knex
  let store: AgentSpecialistStore
  let f: SpecialistFixture
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await db.raw('PRAGMA foreign_keys = ON')
    await createTables(db)
    f = await fixture(db)
    store = new AgentSpecialistStore(db)
  })
  afterEach(async () => {
    await db?.destroy()
  })

  it('additively backfills policy without changing administrator settings, revisions, events or ledger', async () => {
    const row = await db('agentRoutingPolicy').where({ id: 1 }).first()
    expect(JSON.parse(row.config)).toEqual({
      ...legacyPolicy,
      specialistEnabled: false,
      specialistMaxContexts: 4,
      specialistMaxContextBytes: 65_536,
      specialistMaxReportTokens: 1024,
      specialistMaxTurns: 3
    })
    expect(row.revision).toBe(19)
    expect(await db('agentUsageLedger').select('totalTokens')).toEqual([{ totalTokens: 917 }])
    expect(await db('agentEvents').select('data')).toEqual([{ data: 'retained usage event' }])
    await db('agentRoutingPolicy').update({ config: JSON.stringify({ ...JSON.parse(row.config), specialistEnabled: true }) })
    await expect(removeSpecialists(db)).rejects.toThrow('Cannot discard administrator specialist policy')
    expect(await db.schema.hasTable('agentSpecialistContexts')).toBe(true)
  })

  it('replays one completed immutable root-run receipt without another invocation or context commit', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    expect(started.replayed).toBe(false)
    const receipt = await store.complete(root, started.invocation.id, f.completion)
    expect(receipt).toMatchObject({ status: 'completed', reused: false, contextVersion: 2, report: 'Bounded report' })
    expect(await store.begin(root, f.begin)).toMatchObject({ replayed: true, invocation: receipt })
    expect(await store.complete(root, started.invocation.id, f.completion)).toEqual(receipt)
    await store.fail(root, started.invocation.id, 'PROVIDER_FAILED')
    await expect(store.complete(root, started.invocation.id, { ...f.completion, report: 'Changed receipt' })).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_INVOCATION_CONFLICT'
    })
    expect(await db('agentSpecialistInvocations')).toHaveLength(1)
    expect(await store.readInvocation({ ownerId: 7, rootSessionId: f.rootSessionId, rootRunId: root.id })).toEqual(receipt)
    expect(await store.list({ ownerId: 7, rootSessionId: f.rootSessionId, scopeSha256, maximumContexts: 4 })).toMatchObject([
      { version: 2, turnCount: 1, history: f.completion.history, state: f.completion.state }
    ])
    expect(await store.listInvocations(7, f.rootSessionId, [root.id])).toEqual([receipt])
    expect(await store.listInvocations(7, f.rootSessionId, [])).toEqual([])
    expect(await store.listInvocations(7, f.rootSessionId, [randomUUID()])).toEqual([])
    await expect(
      store.listInvocations(
        7,
        f.rootSessionId,
        Array.from({ length: 101 }, () => randomUUID())
      )
    ).rejects.toMatchObject({ code: 'INVALID_SPECIALIST_INPUT' })
    await expect(removeSpecialists(db)).rejects.toThrow('Cannot discard specialist context or invocation receipts')
  })

  it('treats simultaneous same-root begin as one durable running no-dispatch receipt', async () => {
    const root = await f.claim()
    const results = await Promise.all([store.begin(root, f.begin), store.begin(root, f.begin)])
    expect(results.map(result => result.replayed).sort()).toEqual([false, true])
    expect(results[0]?.invocation.id).toBe(results[1]?.invocation.id)
    expect(await db('agentSpecialistContexts')).toHaveLength(1)
    expect(await db('agentSpecialistInvocations')).toHaveLength(1)
    await db('agentRuns').where({ id: root.id }).update({ attempts: 2, leaseToken: randomUUID() })
    const replacement = await db('agentRuns').where({ id: root.id }).first()
    const replay = await store.begin({ ...root, attempts: 2, leaseToken: replacement.leaseToken }, f.begin)
    expect(replay).toMatchObject({ replayed: true, invocation: { status: 'running' } })
    await expect(store.complete({ ...root, attempts: 2, leaseToken: replacement.leaseToken }, replay.invocation.id, f.completion)).rejects.toMatchObject({
      code: 'RUN_LEASE_LOST'
    })
    expect(await db('agentSpecialistContexts').first('turnCount')).toEqual({ turnCount: 0 })
  })

  it('cannot reuse a context across root conversations or owners and never exposes it through another owner receipt view', async () => {
    const root = await f.claim()
    const { context, invocation } = await store.begin(root, f.begin)
    await store.complete(root, invocation.id, f.completion)
    const reuse = { ...f.begin, contextId: context.id, contextVersion: 2 }
    for (const ownerId of [7, 8]) {
      const sessionId = randomUUID()
      await db('agentSessions').insert({ id: sessionId, ownerId, expiresAt: f.rootExpiresAt, deletedAt: null })
      await expect(store.begin(await f.claim(sessionId, ownerId), reuse)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    }
    expect(await store.readInvocation({ ownerId: 8, rootSessionId: f.rootSessionId, rootRunId: root.id })).toBeNull()
    expect(await store.listInvocations(8, f.rootSessionId)).toEqual([])
    expect(await store.list({ ownerId: 7, rootSessionId: f.rootSessionId, scopeSha256: 'd'.repeat(64), maximumContexts: 4 })).toEqual([])
  })

  it('rejects immutable binding, source scope, task and optimistic-version mismatches without changing successful context', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    await store.complete(root, started.invocation.id, f.completion)
    const retained = await db('agentSpecialistContexts').first()
    const reuse = { ...f.begin, contextId: started.context.id, contextVersion: 2 }
    for (const input of [
      { ...reuse, contextVersion: 1 },
      { ...reuse, scopeSha256: 'd'.repeat(64) },
      { ...reuse, complexity: 'complex' as const },
      { ...reuse, taskClass: 'analysis' as const },
      { ...reuse, binding: { ...f.binding, model: 'other-model' } },
      { ...reuse, binding: { ...f.binding, profileVersionId: randomUUID() } },
      { ...reuse, binding: { ...f.binding, ownerAuthVersion: 2 } }
    ]) {
      await expect(store.begin(await f.claim(), input)).rejects.toMatchObject({ status: 409 })
      expect(await db('agentSpecialistContexts').first()).toEqual(retained)
    }
    await expect(store.begin(root, { ...f.begin, scopeSha256: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'AGENT_SPECIALIST_INVOCATION_CONFLICT' })
  })

  it('serializes competing reuse claims and commits only the claimed context version', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    await store.complete(root, started.invocation.id, f.completion)
    const first = await f.claim()
    const second = await f.claim()
    const reuse = { ...f.begin, contextId: started.context.id, contextVersion: 2 }
    const results = await Promise.allSettled([store.begin(first, reuse), store.begin(second, reuse)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'AGENT_SPECIALIST_CONTEXT_BUSY' } })
    const index = results.findIndex(result => result.status === 'fulfilled')
    const winner = results[index]
    if (winner?.status !== 'fulfilled') throw new Error('Expected one real invocation')
    const claim = index === 0 ? first : second
    await store.complete(claim, winner.value.invocation.id, {
      ...f.completion,
      history: [...f.completion.history, { role: 'user', content: 'Continuation' }, { role: 'assistant', content: 'Continued result' }],
      report: 'Continued report'
    })
    await expect(store.begin(await f.claim(), reuse)).rejects.toMatchObject({ code: 'AGENT_SPECIALIST_VERSION_CHANGED' })
    expect(await store.list({ ownerId: 7, rootSessionId: f.rootSessionId, scopeSha256, maximumContexts: 4 })).toMatchObject([
      { version: 3, turnCount: 2, lastReport: 'Continued report' }
    ])
  })

  it.each(['cancelled', 'failed', 'lease-token', 'attempt', 'lease-expired', 'owner-auth', 'profile-policy', 'profile-grant'] as const)(
    '%s completion cannot mutate a retained successful context',
    async changedFence => {
      const root = await f.claim()
      const started = await store.begin(root, f.begin)
      await store.complete(root, started.invocation.id, f.completion)
      const retained = await db('agentSpecialistContexts').first()
      const continuationRoot = await f.claim()
      const continuation = await store.begin(continuationRoot, { ...f.begin, contextId: started.context.id, contextVersion: 2 })
      if (changedFence === 'cancelled') await db('agentRuns').where({ id: continuationRoot.id }).update({ cancelRequestedAt: new Date() })
      if (changedFence === 'failed') await db('agentRuns').where({ id: continuationRoot.id }).update({ status: 'failed' })
      if (changedFence === 'lease-token') await db('agentRuns').where({ id: continuationRoot.id }).update({ leaseToken: randomUUID() })
      if (changedFence === 'attempt') await db('agentRuns').where({ id: continuationRoot.id }).update({ attempts: 2 })
      if (changedFence === 'lease-expired')
        await db('agentRuns')
          .where({ id: continuationRoot.id })
          .update({ leaseExpiresAt: new Date(Date.now() - 1000) })
      if (changedFence === 'owner-auth') await db('users').where({ id: 7 }).update({ authVersion: 2 })
      if (changedFence === 'profile-policy') await db('agentProviderProfiles').where({ id: f.binding.profileId }).update({ policyVersion: 2 })
      if (changedFence === 'profile-grant') await db('agentProviderProfiles').where({ id: f.binding.profileId }).update({ exposureMode: 'groups' })
      await expect(store.complete(continuationRoot, continuation.invocation.id, { ...f.completion, report: 'Unauthorized report' })).rejects.toMatchObject({
        status: 409
      })
      expect(await db('agentSpecialistContexts').first()).toEqual(retained)
      expect(await store.readInvocation({ ownerId: 7, rootSessionId: f.rootSessionId, rootRunId: continuationRoot.id })).toMatchObject({
        status: 'running',
        report: null
      })
    }
  )

  it('failed invocation preserves history/state and remains a no-dispatch receipt on retry', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    await store.complete(root, started.invocation.id, f.completion)
    const retained = await db('agentSpecialistContexts').first()
    const continuationRoot = await f.claim()
    const reuse = { ...f.begin, contextId: started.context.id, contextVersion: 2 }
    const continuation = await store.begin(continuationRoot, reuse)
    await store.fail(continuationRoot, continuation.invocation.id, 'PROVIDER_FAILED')
    expect(await store.begin(continuationRoot, reuse)).toMatchObject({ replayed: true, invocation: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    await expect(store.complete(continuationRoot, continuation.invocation.id, f.completion)).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_INVOCATION_FAILED'
    })
    expect(await db('agentSpecialistContexts').first()).toEqual(retained)
  })

  it('rejects authority change, lost history, oversize snapshot and UTF-8 report without truncation', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    await store.complete(root, started.invocation.id, f.completion)
    const retained = await db('agentSpecialistContexts').first()
    const continuationRoot = await f.claim()
    const continuation = await store.begin(continuationRoot, { ...f.begin, contextId: started.context.id, contextVersion: 2 })
    for (const [input, code] of [
      [{ ...f.completion, authoritySha256: 'd'.repeat(64) }, 'AGENT_SPECIALIST_AUTHORITY_CHANGED'],
      [{ ...f.completion, history: [] }, 'AGENT_SPECIALIST_HISTORY_CHANGED'],
      [{ ...f.completion, history: [{ role: 'user' as const, content: 'Rewritten history' }, f.completion.history[1]!] }, 'AGENT_SPECIALIST_HISTORY_CHANGED'],
      [{ ...f.completion, state: { huge: 'x'.repeat(65_536) } }, 'AGENT_SPECIALIST_CONTEXT_TOO_LARGE'],
      [{ ...f.completion, report: 'é'.repeat(2050) }, 'AGENT_SPECIALIST_REPORT_TOO_LARGE']
    ] as const) {
      await expect(store.complete(continuationRoot, continuation.invocation.id, input)).rejects.toMatchObject({ code })
      expect(await db('agentSpecialistContexts').first()).toEqual(retained)
    }
    await store.complete(continuationRoot, continuation.invocation.id, {
      ...f.completion,
      history: [...f.completion.history, { role: 'user', content: 'Still continuable' }]
    })
    expect(await db('agentSpecialistContexts').first('version')).toEqual({ version: 3 })
  })

  it('bounds new-context caps and host expiry without evicting any active context', async () => {
    const root = await f.claim()
    const started = await store.begin(root, { ...f.begin, maximumContexts: 1 })
    const retained = await db('agentSpecialistContexts').first()
    await expect(store.begin(await f.claim(), { ...f.begin, maximumContexts: 1 })).rejects.toMatchObject({ code: 'AGENT_SPECIALIST_CONTEXT_LIMIT' })
    await expect(store.begin(await f.claim(), { ...f.begin, expiresAt: new Date(f.rootExpiresAt.valueOf() + 1000).toISOString() })).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_EXPIRED'
    })
    await expect(store.begin(await f.claim(), { ...f.begin, expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_EXPIRED'
    })
    expect(await store.expire(new Date(f.rootExpiresAt.valueOf() + 1000))).toBe(0)
    expect(await db('agentSpecialistContexts').first()).toEqual(retained)
    expect(await db('agentSpecialistInvocations').first('id', 'status')).toEqual({ id: started.invocation.id, status: 'running' })
    // Even logically expired contexts count against the cap while their root invocation is active.
    await db('agentSpecialistContexts')
      .where({ id: started.context.id })
      .update({ expiresAt: new Date(Date.now() - 1000) })
    await expect(store.begin(await f.claim(), { ...f.begin, maximumContexts: 1 })).rejects.toMatchObject({ code: 'AGENT_SPECIALIST_CONTEXT_LIMIT' })
  })

  it('scrubs expired idle payloads and receipt reports while retaining statuses, usage and anti-replay identity', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    const completed = await store.complete(root, started.invocation.id, f.completion)
    const future = new Date(f.rootExpiresAt.valueOf() + 1000)
    expect(
      await store.list({ ownerId: 7, rootSessionId: f.rootSessionId, scopeSha256, maximumContexts: 4, now: new Date(new Date(f.expiresAt).valueOf() + 1000) })
    ).toEqual([])
    expect(await store.expire(future)).toBe(1)
    expect(await store.expire(future)).toBe(0)
    const persisted: SpecialistContext = JSON.parse((await db('agentSpecialistContexts').first('data')).data)
    expect(persisted).toMatchObject({ history: [], state: null, lastReport: '', version: 2, turnCount: 1 })
    expect(await store.readInvocation({ ownerId: 7, rootSessionId: f.rootSessionId, rootRunId: root.id })).toEqual({ ...completed, report: null })
    await expect(store.begin(root, f.begin)).rejects.toMatchObject({ code: 'AGENT_SPECIALIST_EXPIRED' })
    expect(await db('agentSpecialistInvocations')).toHaveLength(1)
    expect(await db('agentUsageLedger').select('totalTokens')).toEqual([{ totalTokens: 917 }])
    expect(await db('agentEvents').select('data')).toEqual([{ data: 'retained usage event' }])
  })

  it('fails closed on tampered canonical context and receipt bytes', async () => {
    const root = await f.claim()
    const started = await store.begin(root, f.begin)
    await store.complete(root, started.invocation.id, f.completion)
    const receiptRow = await db('agentSpecialistInvocations').first()
    await db('agentSpecialistInvocations')
      .where({ id: receiptRow.id })
      .update({ data: receiptRow.data.replace('Bounded report', 'Forged report') })
    await expect(store.readInvocation({ ownerId: 7, rootSessionId: f.rootSessionId, rootRunId: root.id })).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_CORRUPT'
    })
    await db('agentSpecialistInvocations').where({ id: receiptRow.id }).update({ data: receiptRow.data })
    const row = await db('agentSpecialistContexts').first()
    await db('agentSpecialistContexts').where({ id: row.id }).update({ version: 3 })
    await expect(store.list({ ownerId: 7, rootSessionId: f.rootSessionId, scopeSha256, maximumContexts: 4 })).rejects.toMatchObject({
      code: 'AGENT_SPECIALIST_CORRUPT'
    })
    expect(createHash('sha256').update(row.data).digest('hex')).toBe(row.dataSha256)
  })

  it('deleting the root cascades specialist contexts and receipts but leaves ordinary usage rows intact', async () => {
    const root = await f.claim()
    await store.begin(root, f.begin)
    await db('agentSessions').where({ id: f.rootSessionId }).delete()
    expect(await db('agentSpecialistContexts')).toEqual([])
    expect(await db('agentSpecialistInvocations')).toEqual([])
    expect(await db('agentRuns')).toEqual([])
    expect(await db('agentUsageLedger').select('totalTokens')).toEqual([{ totalTokens: 917 }])
  })
})

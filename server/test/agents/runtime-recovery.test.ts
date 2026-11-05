import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { getOwnedAgentRun, type AgentRunRecord } from '../../agents/coordinator.ts'
import { getOwnedAgentGoal } from '../../agents/goals.ts'
import { updateAgentSession } from '../../agents/repository.ts'
import type { SubmitAgentMessageInput } from '../../agents/runtime.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createAgentMediaTestDatabase } from './media-database.ts'
import { createRoutingTables, routingFixture, type RoutingFixture } from './runtime-routing.fixture.ts'

const connection = getPostgresTestConnection('_runtime_recovery_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('owned runtime request recovery and cancellation', () => {
  let destroyDatabase: (() => Promise<void>) | undefined
  let db: Knex
  let f: RoutingFixture | undefined

  beforeEach(async () => {
    destroyDatabase = undefined
    f = undefined
    const database = await createAgentMediaTestDatabase(connection)
    destroyDatabase = database.destroy
    db = database.db
    await createRoutingTables(db)
    f = await routingFixture(db)
  })

  afterEach(async () => {
    try {
      await f?.runtime.shutdown()
    } finally {
      await destroyDatabase?.()
    }
  })

  const messageInput = async (sessionId: string, ttlSeconds = 300): Promise<SubmitAgentMessageInput> => {
    const saved = await db('agentSessions').where({ id: sessionId }).first('version')
    return {
      ownerId: 7,
      sessionId,
      clientRequestId: randomUUID(),
      expectedSessionVersion: Number(saved.version),
      profileResolutionToken: await f!.registry.issueResolutionToken(7, sessionId, ttlSeconds),
      content: 'Write a short greeting'
    }
  }

  const expectSingleAdmission = async (run: AgentRunRecord): Promise<void> => {
    expect(await db('agentRuns').where({ sessionId: run.sessionId }).select('id')).toEqual([{ id: run.id }])
    expect(await db('agentMessages').where({ sessionId: run.sessionId }).orderBy('ordinal').select('id', 'runId')).toEqual([
      { id: run.userMessageId, runId: run.id },
      { id: run.assistantMessageId, runId: run.id }
    ])
    expect(await db('agentEvents').where({ runId: run.id, type: 'run.queued' }).select('sequence')).toEqual([{ sequence: 1 }])
    expect(await db('agentQuotaReservations').where({ ownerId: run.ownerId }).select('runId')).toEqual([{ runId: run.id }])
  }

  it('recovers the original request after an owned title update without reopening fresh admission', async () => {
    const fixture = f!
    const input = await messageInput(await fixture.session())
    const admitted = await fixture.runtime.submit(input)
    expect(admitted.replayed).toBe(false)
    expect(await fixture.runtime.submit(input)).toMatchObject({ replayed: true, run: { id: admitted.run.id } })

    const renamed = await updateAgentSession(db, {
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedSessionVersion,
      title: 'Renamed while the admitted answer is pending'
    })
    expect(renamed.version).toBe(input.expectedSessionVersion + 1)

    // A new send still needs the current session version and fresh resolution.
    await expect(fixture.runtime.submit({ ...input, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'SESSION_VERSION_CHANGED' })
    await expect(fixture.runtime.submit({ ...input, clientRequestId: randomUUID(), expectedSessionVersion: renamed.version })).rejects.toMatchObject({
      code: 'PROFILE_RESOLUTION_CHANGED'
    })
    await expect(fixture.runtime.submit({ ...input, ownerId: 8 })).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })

    await expect(fixture.runtime.submit(input)).resolves.toMatchObject({ replayed: true, run: { id: admitted.run.id } })
    await expect(fixture.runtime.submit({ ...input, content: 'Write a different greeting' })).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_MISMATCH' })
    await expectSingleAdmission(admitted.run)
  })

  it('recovers an admitted request with its expired resolution token but rejects that token for a new send', async () => {
    const fixture = f!
    const input = await messageInput(await fixture.session(), 30)
    const admitted = await fixture.runtime.submit(input)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    try {
      // Prove this is a genuinely expired, otherwise valid signed token.
      await expect(fixture.runtime.submit({ ...input, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED' })
      await expect(fixture.runtime.submit(input)).resolves.toMatchObject({ replayed: true, run: { id: admitted.run.id } })
      await expect(fixture.runtime.submit({ ...input, content: 'Write a different greeting' })).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_MISMATCH' })
      await expectSingleAdmission(admitted.run)
    } finally {
      clock.mockRestore()
    }
  })

  it('recovers an admitted request with a renewed resolution token without accepting changed client content', async () => {
    const fixture = f!
    const input = await messageInput(await fixture.session(), 30)
    const admitted = await fixture.runtime.submit(input)
    // Different TTLs make renewal deterministic even within the same second.
    const renewedToken = await fixture.registry.issueResolutionToken(input.ownerId, input.sessionId, 900)
    expect(renewedToken).not.toBe(input.profileResolutionToken)
    const renewed = { ...input, profileResolutionToken: renewedToken }

    // The renewed token passes resolution; it cannot bypass the active-run guard.
    await expect(fixture.runtime.submit({ ...renewed, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'SESSION_RUN_ACTIVE' })
    await expect(fixture.runtime.submit(renewed)).resolves.toMatchObject({ replayed: true, run: { id: admitted.run.id } })
    await expect(fixture.runtime.submit({ ...renewed, content: 'Write a different greeting' })).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_MISMATCH' })
    await expectSingleAdmission(admitted.run)
  })

  it('leaves an active goal and its newer continuation untouched when cancellation addresses its terminal old run', async () => {
    const fixture = f!
    const input = await messageInput(await fixture.session())
    const execute = fixture.engine.execute
    fixture.engine.execute = async (request, sink) => ({
      ...(await execute(request, sink)),
      executionLimit: { reason: 'evidence', publication: 'partial' }
    })
    const created = await fixture.runtime.createGoal({
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      goalId: randomUUID(),
      clientRequestId: input.clientRequestId,
      expectedSessionVersion: input.expectedSessionVersion,
      profileResolutionToken: input.profileResolutionToken,
      objective: input.content
    })
    expect(await fixture.runtime.runOnce()).toBe(true)
    const terminal = await getOwnedAgentRun(db, input.ownerId, created.run.id)
    expect(terminal).toMatchObject({ status: 'partial', goalContinuation: 0, completionOutcome: 'blocked', cancelRequestedAt: null })
    const blocked = await getOwnedAgentGoal(db, input.ownerId, created.goal.id)
    expect(blocked.status).toBe('blocked')

    const continued = await fixture.runtime.resumeGoal({
      ownerId: input.ownerId,
      goalId: created.goal.id,
      expectedVersion: blocked.version,
      runId: randomUUID(),
      clientRequestId: randomUUID()
    })
    expect(continued).toMatchObject({ replayed: false, goal: { status: 'active' }, run: { status: 'queued', goalContinuation: 1 } })
    const current = await getOwnedAgentRun(db, input.ownerId, continued.run!.id)
    const goal = await getOwnedAgentGoal(db, input.ownerId, created.goal.id)
    const events = await db('agentEvents').whereIn('runId', [terminal.id, current.id]).orderBy('id').select('*')

    await expect(fixture.runtime.cancel(8, terminal.id)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
    expect(await fixture.runtime.cancel(input.ownerId, terminal.id)).toEqual(terminal)
    expect(await getOwnedAgentGoal(db, input.ownerId, goal.id)).toEqual(goal)
    expect(await getOwnedAgentRun(db, input.ownerId, current.id)).toEqual(current)
    expect(await getOwnedAgentRun(db, input.ownerId, terminal.id)).toEqual(terminal)
    expect(await db('agentEvents').whereIn('runId', [terminal.id, current.id]).orderBy('id').select('*')).toEqual(events)

    fixture.engine.execute = execute
    expect(await fixture.runtime.runOnce()).toBe(true)
    expect(await getOwnedAgentRun(db, input.ownerId, current.id)).toMatchObject({ status: 'succeeded', cancelRequestedAt: null })
    expect(await getOwnedAgentGoal(db, input.ownerId, goal.id)).toMatchObject({ status: 'completed' })
    expect(fixture.requests).toHaveLength(2)
  })

  it('still fences actual root dispatch after cancellation of an active owned run', async () => {
    const fixture = f!
    const admitted = await fixture.submit(await fixture.session())
    const execute = fixture.engine.execute
    let initiallyAuthorized = false
    let cancellation: AgentRunRecord | undefined
    let dispatchFailure: unknown
    fixture.beforeInference(async () => {
      cancellation = await fixture.runtime.cancel(7, admitted.run.id)
    })
    fixture.engine.execute = async (request, sink) => {
      // Check the same public dispatch boundary before and after cancellation.
      await request.authorizeDispatch!()
      initiallyAuthorized = true
      try {
        // The fixture cancels immediately before its actual authorizeDispatch,
        // before recording a delivered request or reserving root model usage.
        return await execute(request, sink)
      } catch (error) {
        dispatchFailure = error
        throw error
      }
    }

    expect(await fixture.runtime.runOnce()).toBe(true)
    expect(initiallyAuthorized).toBe(true)
    expect(cancellation).toMatchObject({ id: admitted.run.id, status: 'running' })
    expect(cancellation!.cancelRequestedAt).not.toBeNull()
    expect(dispatchFailure).toMatchObject({ code: 'RUN_LEASE_LOST' })
    expect(fixture.requests).toHaveLength(0)
    expect(await getOwnedAgentRun(db, 7, admitted.run.id)).toMatchObject({ status: 'cancelled' })
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    // The earlier deterministic classifier remains charged; root dispatch did not occur.
    expect(Number(reservation.consumedTokens)).toBe(190)
    expect(Number(reservation.consumedCostMicros)).toBe(13)
  })
})

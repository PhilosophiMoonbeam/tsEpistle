import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Knex } from 'knex'
import { admitAgentRunInTransaction } from '../../agents/coordinator.ts'
import { createAgentSession } from '../../agents/repository.ts'
import type { AgentProductRuntime } from '../../agents/runtime.ts'
import { describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createRestartRegistry, createRestartRuntime, type RestartWorkerConfiguration } from './dispatch-restart-worker.fixture.ts'
import { createAgentMediaTestDatabase } from './media-database.ts'
import { createRoutingTables } from './runtime-routing.fixture.ts'

const connection = getPostgresTestConnection('_dispatch_restart_test', import.meta.path)
const suite = connection ? describe : describe.skip
const measured = { inputTokens: 7, outputTokens: 3, totalTokens: 10, costMicros: 13 }

// Deadline watchdogs only: success awaits real HTTP/process signals, never a
// guessed delay. Fake timers cannot drive the separate worker or PostgreSQL.
const bounded = async <T>(operation: Promise<T>, label: string, milliseconds = 20_000): Promise<T> => {
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
  try {
    return await Promise.race([operation, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

const closeServer = async (server: Server): Promise<void> => {
  const closed = Promise.withResolvers<void>()
  server.close(error => (error ? closed.reject(error) : closed.resolve()))
  server.closeAllConnections()
  await closed.promise
}

interface AcceptedQuotaHold {
  readonly tokens: number
  readonly costMicros: number
}

interface RestartWire {
  readonly origin: string
  readonly accepted: Promise<void>
  readonly holds: readonly AcceptedQuotaHold[]
  readonly dispatches: readonly AcceptedQuotaHold[]
  requests(): number
  close(): Promise<void>
}

/** The first complete HTTP request is accepted but receives no response bytes.
 * It could have been billed remotely; disconnect/SIGKILL proves no zero-usage
 * receipt. Later calls receive an ordinary native OpenAI usage receipt.
 */
const createWire = async (blockFirst: boolean, db: Knex, runId: string): Promise<RestartWire> => {
  const accepted = Promise.withResolvers<void>()
  let requests = 0
  const holds: AcceptedQuotaHold[] = []
  const dispatches: AcceptedQuotaHold[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 1_000_000) throw new Error('Restart request exceeded its fixture bound')
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; stream?: boolean; messages?: unknown[] }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || body.stream === true || !Array.isArray(body.messages) || ++requests > 2)
        throw new Error('Unexpected bounded restart wire request')
      const held = await db('agentQuotaReservations').where({ runId }).first('reservedTokens', 'reservedCostMicros')
      if (!held) throw new Error('Accepted native request has no durable quota hold')
      const dispatch = {
        tokens: Number(request.headers['x-restart-dispatch-tokens']),
        costMicros: Number(request.headers['x-restart-dispatch-cost-micros'])
      }
      if (!Number.isSafeInteger(dispatch.tokens) || dispatch.tokens <= 0 || !Number.isSafeInteger(dispatch.costMicros) || dispatch.costMicros <= 0)
        throw new Error('Accepted native request has no observed dispatch reservation')
      dispatches.push(dispatch)
      holds.push({ tokens: Number(held.reservedTokens), costMicros: Number(held.reservedCostMicros) })
      accepted.resolve()
      if (blockFirst && requests === 1) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A local restart accounting response.' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
        })
      )
    })().catch(error => {
      accepted.reject(error)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Restart fixture protocol failure' } }))
    })
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
  } catch (error) {
    server.closeAllConnections()
    server.close()
    throw error
  }
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accepted: accepted.promise,
    holds,
    dispatches,
    requests: () => requests,
    close: () => closeServer(server)
  }
}

const admit = async (db: Knex, largeUndispatchedHold = false) => {
  const registry = createRestartRegistry(db)
  const profile = await registry.create({
    displayName: 'Owned dispatch restart wire',
    transportKind: 'openai-chat',
    model: 'restart-fixture-model',
    utilityModel: null,
    baseUrl: 'https://restart-provider.example.test/v1',
    authMode: 'bearer',
    secretReference: 'env:DISPATCH_RESTART_FIXTURE_KEY',
    adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {} },
    capabilities: {
      streaming: false,
      toolCalling: 'native',
      parallelToolCalls: false,
      structuredOutput: 'native-json-schema',
      usage: 'terminal',
      cancellation: true,
      maxContextTokens: 64_000,
      maxOutputTokens: 4_000
    },
    capabilityRevision: 'restart-fixture-v1',
    // One micro per input token, two per output/residual token.
    pricingRevision: 'restart-fixture-v1|1000000|2000000',
    policies: {
      allowedModes: ['agent', 'generation-only'],
      dailyTokens: 1_000_000,
      dailyCostMicros: 2_000_000,
      reservationTokens: largeUndispatchedHold ? 100_000 : 1,
      reservationCostMicros: largeUndispatchedHold ? 200_000 : 1,
      reservationMilliseconds: 60_000,
      promptVersion: 1,
      maxAttempts: 2
    },
    exposureMode: 'all_agent_users',
    actorId: 1
  })
  const version = await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')
  // Conformance is fixture setup, not the subject of this accounting regression.
  await registry.setConformed(profile.id, version.currentVersionId, true, 1)
  await registry.setEnabled(profile.id, true, 1, version.currentVersionId)
  await registry.setDefault(profile.id, 1)
  const session = await createAgentSession(db, {
    ownerId: 7,
    title: 'Dispatch restart',
    retention: 'saved',
    providerProfileId: null,
    executionMode: 'generation-only'
  })
  // Use the public coordinator admission boundary: generation-only isolates one
  // real ordinary native dispatch from synthesis, utility and native decisions.
  // Registry token issuance intentionally offers agent-mode sessions only.
  return db.transaction(async transaction => {
    const resolved = await registry.resolveCurrent(transaction, { ownerId: 7, sessionId: session.id })
    return admitAgentRunInTransaction(transaction, {
      ...resolved,
      ownerId: 7,
      sessionId: session.id,
      clientRequestId: randomUUID(),
      expectedSessionVersion: session.version,
      content: 'Reply with one short greeting.',
      skillVersionIds: [],
      reservationExpiresAt: new Date(Date.now() + resolved.reservationMilliseconds)
    })
  })
}

suite('dispatch accounting across hard worker restart', () => {
  it('retains an accepted request with unknown usage in addition to the reclaimed attempt receipt', async () => {
    const database = await createAgentMediaTestDatabase(connection)
    let wire: RestartWire | undefined
    let worker: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined
    let stderr: Promise<string> | undefined
    let recovered: AgentProductRuntime | undefined
    try {
      const db = database.db
      await createRoutingTables(db)
      const admitted = await admit(db)
      wire = await createWire(true, db, admitted.run.id)
      const schema = (await db.raw('SELECT current_schema() AS schema')).rows[0].schema as string
      const configuration: RestartWorkerConfiguration = { connection: connection!, schema, localOrigin: wire.origin }
      worker = Bun.spawn([process.execPath, '--no-env-file', `${import.meta.dir}/dispatch-restart-worker.fixture.ts`], {
        env: { ...Bun.env, WIKI_DISPATCH_RESTART_WORKER: JSON.stringify(configuration) },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe'
      })
      stderr = new Response(worker.stderr).text()
      await bounded(
        Promise.race([
          wire.accepted,
          worker.exited.then(async code => {
            const diagnostic = (await stderr!).replaceAll(connection!.password, '[REDACTED]').slice(0, 2_000)
            throw new Error(`Restart worker exited before transport acceptance (${code}): ${diagnostic}`)
          })
        ]),
        'First transport acceptance'
      )
      expect(wire.requests()).toBe(1)
      const before = await db('agentRuns').where({ id: admitted.run.id }).first()
      expect(before).toMatchObject({ status: 'running', attempts: 1, sideEffectsStarted: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      // Neither the response nor its real usage exists yet. Do not infer that
      // *all* accounting state is absent: aggregate quota is already durable,
      // and a repair may persist dispatch records in other event purposes.
      const usageEvents = await db('agentEvents').where({ runId: admitted.run.id }).whereIn('type', ['model.turn', 'usage.updated']).select('data')
      expect(usageEvents.map(row => JSON.parse(row.data)).some(data => Number(data.totalTokens) > 0 || Number(data.costMicros) > 0)).toBe(false)
      const held = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
      // Capture E where the real producer reserves its actual request, before
      // the mapped native HTTP send. The aggregate hold also includes unused
      // sequence capacity, so neither that hold nor the journal is our oracle.
      const { tokens: exposureTokens, costMicros: exposureCostMicros } = wire.dispatches[0]!
      expect(exposureTokens).toBeGreaterThan(measured.totalTokens)
      expect(exposureCostMicros).toBe(2 * exposureTokens)
      expect(Number(held.reservedTokens)).toBeGreaterThan(exposureTokens)
      expect(Number(held.reservedCostMicros)).toBeGreaterThan(exposureCostMicros)

      worker.kill('SIGKILL')
      await bounded(worker.exited, 'Killed worker exit', 5_000)
      expect(worker.signalCode).toBe('SIGKILL')
      // Advance only the dead worker's lease, not usage, quota or attempts. The
      // next claim and all accounting are owned by a fresh real runtime.
      await db('agentRuns')
        .where({ id: admitted.run.id, leaseToken: before.leaseToken })
        .update({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      recovered = createRestartRuntime(db, wire.origin)
      expect(await bounded(recovered.runOnce(), 'Reclaimed run settlement')).toBe(true)
      expect(wire.requests()).toBe(2)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({
        status: 'succeeded',
        attempts: 2,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        estimatedCostMicros: 13
      })
      const settled = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
      // Unknown first receipt is NOT 0 and is NOT replaced by the retry's 10/13.
      // Charge E + 10 tokens and 2E + 13 micros, not 10/13 and not both maxima.
      expect({ status: settled.status, tokens: Number(settled.consumedTokens), costMicros: Number(settled.consumedCostMicros) }).toEqual({
        status: 'consumed',
        tokens: exposureTokens + 10,
        costMicros: exposureCostMicros + 13
      })
      // Retrospective charging alone is insufficient: the second native send
      // must already hold the unknown first exposure plus at least its eventual
      // measured receipt, rather than reusing the first request's allowance.
      expect(wire.holds[1]!.tokens).toBeGreaterThanOrEqual(exposureTokens + measured.totalTokens)
      expect(wire.holds[1]!.costMicros).toBeGreaterThanOrEqual(exposureCostMicros + measured.costMicros)
      const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
      expect({
        tokens: Number(daily.consumedTokens),
        costMicros: Number(daily.consumedCostMicros),
        heldTokens: Number(daily.reservedTokens),
        heldCostMicros: Number(daily.reservedCostMicros)
      }).toEqual({
        tokens: exposureTokens + 10,
        costMicros: exposureCostMicros + 13,
        heldTokens: 0,
        heldCostMicros: 0
      })
    } finally {
      try {
        if (worker) {
          if (worker.exitCode === null) worker.kill('SIGKILL')
          await bounded(worker.exited, 'Worker teardown', 5_000)
          await stderr
        }
      } finally {
        try {
          await recovered?.shutdown()
        } finally {
          try {
            await wire?.close()
          } finally {
            await database.destroy()
          }
        }
      }
    }
  }, 90_000)

  it('retains a reconciled receipt when the worker dies before its model-turn presentation commits', async () => {
    const database = await createAgentMediaTestDatabase(connection)
    let wire: RestartWire | undefined
    let worker: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined
    let stderr: Promise<string> | undefined
    let recovered: AgentProductRuntime | undefined
    let releaseObserver: (() => Promise<void>) | undefined
    try {
      const db = database.db
      await createRoutingTables(db)
      const admitted = await admit(db, true)
      wire = await createWire(false, db, admitted.run.id)
      const schema = (await db.raw('SELECT current_schema() AS schema')).rows[0].schema as string
      const lockKey = Number.parseInt(admitted.run.id.slice(0, 8), 16) & 0x7fffffff
      const observer = await db.client.acquireConnection()
      const receipt = Promise.withResolvers<void>()
      const observe = (notification: { channel: string; payload?: string }): void => {
        if (notification.channel !== 'dispatch_restart_reconciled' || notification.payload !== admitted.run.id) return
        void db('agentEvents')
          .where({ runId: admitted.run.id, type: 'dispatch.accounting' })
          .select('data')
          .then(rows => {
            if (rows.some(row => JSON.parse(row.data).operation === 'reconciled')) receipt.resolve()
          }, receipt.reject)
      }
      observer.on('notification', observe)
      releaseObserver = async () => {
        observer.removeListener('notification', observe)
        try {
          await observer.query('SELECT pg_advisory_unlock($1, $2)', [16431, lockKey])
          await observer.query('UNLISTEN dispatch_restart_reconciled')
        } finally {
          await db.client.releaseConnection(observer)
        }
      }
      await observer.query('LISTEN dispatch_restart_reconciled')
      await observer.query('SELECT pg_advisory_lock($1, $2)', [16431, lockKey])
      // Block only the *later* presentation transaction in real PostgreSQL. The
      // ordinary producer receives an actual native HTTP receipt and runtime's
      // central reconciliation must already be independently durable. There is
      // no production injection hook or manufactured usage/accounting event.
      // This test-owned notification is delivered only after receipt commit.
      await db.raw(`CREATE FUNCTION dispatch_restart_presentation_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.type = 'dispatch.accounting' AND (NEW.data::jsonb ->> 'operation') = 'reconciled' THEN
            PERFORM pg_notify('dispatch_restart_reconciled', NEW."runId"::text);
          END IF;
          IF NEW.type = 'model.turn' THEN PERFORM pg_advisory_xact_lock(16431, ${lockKey}); END IF;
          RETURN NEW;
        END $$`)
      await db.raw(
        'CREATE TRIGGER dispatch_restart_presentation_gate BEFORE INSERT ON "agentEvents" FOR EACH ROW EXECUTE FUNCTION dispatch_restart_presentation_gate()'
      )
      const configuration: RestartWorkerConfiguration = { connection: connection!, schema, localOrigin: wire.origin }
      worker = Bun.spawn([process.execPath, '--no-env-file', `${import.meta.dir}/dispatch-restart-worker.fixture.ts`], {
        env: { ...Bun.env, WIKI_DISPATCH_RESTART_WORKER: JSON.stringify(configuration) },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe'
      })
      stderr = new Response(worker.stderr).text()
      await bounded(
        Promise.race([
          receipt.promise,
          worker.exited.then(async code => {
            const diagnostic = (await stderr!).replaceAll(connection!.password, '[REDACTED]').slice(0, 2_000)
            throw new Error(`Receipt-gap worker exited before durable reconciliation (${code}): ${diagnostic}`)
          })
        ]),
        'Durable native receipt before presentation'
      )
      expect(wire.requests()).toBe(1)
      expect(
        await db('agentEvents').where({ runId: admitted.run.id }).whereIn('type', ['model.turn', 'usage.updated']).count({ count: '*' }).first()
      ).toMatchObject({ count: '0' })
      const before = await db('agentRuns').where({ id: admitted.run.id }).first('leaseToken')
      worker.kill('SIGKILL')
      await bounded(worker.exited, 'Receipt-gap killed worker exit', 5_000)
      expect(worker.signalCode).toBe('SIGKILL')
      await releaseObserver()
      releaseObserver = undefined
      await db.raw('DROP TRIGGER dispatch_restart_presentation_gate ON "agentEvents"')
      await db.raw('DROP FUNCTION dispatch_restart_presentation_gate()')
      await db('agentRuns')
        .where({ id: admitted.run.id, leaseToken: before.leaseToken })
        .update({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      recovered = createRestartRuntime(db, wire.origin)
      expect(await bounded(recovered.runOnce(), 'Reconciled receipt-gap recovery')).toBe(true)
      expect(wire.requests()).toBe(2)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({
        status: 'succeeded',
        attempts: 2,
        inputTokens: 14,
        outputTokens: 6,
        totalTokens: 20,
        estimatedCostMicros: 26
      })
      const settled = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
      expect({ status: settled.status, tokens: Number(settled.consumedTokens), costMicros: Number(settled.consumedCostMicros) }).toEqual({
        status: 'consumed',
        tokens: 20,
        costMicros: 26
      })
      const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
      expect({
        tokens: Number(daily.consumedTokens),
        costMicros: Number(daily.consumedCostMicros),
        heldTokens: Number(daily.reservedTokens),
        heldCostMicros: Number(daily.reservedCostMicros)
      }).toEqual({ tokens: 20, costMicros: 26, heldTokens: 0, heldCostMicros: 0 })
    } finally {
      try {
        if (worker) {
          if (worker.exitCode === null) worker.kill('SIGKILL')
          await bounded(worker.exited, 'Receipt-gap worker teardown', 5_000)
          await stderr
        }
      } finally {
        try {
          await releaseObserver?.()
        } finally {
          try {
            await recovered?.shutdown()
          } finally {
            try {
              await wire?.close()
            } finally {
              await database.destroy()
            }
          }
        }
      }
    }
  }, 90_000)

  it('charges a completed receipt once and releases the unused aggregate admission hold', async () => {
    const database = await createAgentMediaTestDatabase(connection)
    let wire: RestartWire | undefined
    let runtime: AgentProductRuntime | undefined
    try {
      const db = database.db
      await createRoutingTables(db)
      const admitted = await admit(db, true)
      wire = await createWire(false, db, admitted.run.id)
      runtime = createRestartRuntime(db, wire.origin)
      expect(await bounded(runtime.runOnce(), 'Completed control settlement')).toBe(true)
      expect(wire.requests()).toBe(1)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ status: 'succeeded', totalTokens: 10, estimatedCostMicros: 13 })
      const settled = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
      expect({ status: settled.status, tokens: Number(settled.consumedTokens), costMicros: Number(settled.consumedCostMicros) }).toEqual({
        status: 'consumed',
        tokens: measured.totalTokens,
        costMicros: measured.costMicros
      })
      const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
      expect({
        tokens: Number(daily.consumedTokens),
        costMicros: Number(daily.consumedCostMicros),
        heldTokens: Number(daily.reservedTokens),
        heldCostMicros: Number(daily.reservedCostMicros)
      }).toEqual({
        tokens: 10,
        costMicros: 13,
        heldTokens: 0,
        heldCostMicros: 0
      })
    } finally {
      try {
        await runtime?.shutdown()
      } finally {
        try {
          await wire?.close()
        } finally {
          await database.destroy()
        }
      }
    }
  }, 60_000)
})

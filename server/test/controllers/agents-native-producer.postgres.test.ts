import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import cookieParser from 'cookie-parser'
import express from 'express'
import session from 'express-session'
import {
  AgentEventSchema,
  AgentRunStreamReadySchema,
  type AgentEvent,
  type AgentMemoryContextProjection,
  type AgentPresetId
} from '../../../shared/agents/contracts.ts'
import { AgentProviderConformanceRunner } from '../../agents/providers/conformance.ts'
import { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentProviderRegistry } from '../../agents/providers/registry.ts'
import type { AgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { AgentProductRuntime } from '../../agents/runtime.ts'
import { up as addAgentMemory } from '../../db/migrations/2.5.147.ts'
import { createAgentMediaTestDatabase } from '../agents/media-database.ts'
import { createNativeProviderWireFixture, nativeFixtureMemory, type NativeProviderWireFixture } from '../agents/native-provider-wire-fixture.ts'
import { createRoutingTables } from '../agents/runtime-routing.fixture.ts'
import { fixtureDecisionProviders } from '../agents/synthesis-fixture.ts'
import { describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_native_producer_test', import.meta.path)
const suite = connection ? describe : describe.skip
const origin = 'https://wiki.example.test'
const csrf = 'native-producer-fixture-csrf'
type SessionState = session.Session & Partial<session.SessionData> & { fixtureOwnerId?: number; agentCsrfToken?: string }
interface SessionProjection {
  session: { id: string; version: number; profileResolutionToken: string }
  memoryContext: AgentMemoryContextProjection
}
interface DurableEvent {
  id: string
  runId: string
  sequence: number
  type: string
  schemaVersion: number
  attempt: number
  data: string
  dataSha256: string
}
interface SseEvent {
  sequence: number
  type: string
  envelope: AgentEvent
}
const parseSse = (text: string): SseEvent[] =>
  text
    .split(/\r?\n\r?\n/u)
    .filter(block => block.startsWith('id: '))
    .map(block => {
      const lines = block.split(/\r?\n/u)
      const sequence = Number(lines.find(line => line.startsWith('id: '))!.slice(4))
      const type = lines.find(line => line.startsWith('event: '))!.slice(7)
      const envelope = AgentEventSchema.parse(JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6)))
      if (sequence !== envelope.sequence || type !== envelope.type) throw new Error('SSE frame does not match the canonical durable event')
      return { sequence, type, envelope }
    })
const parseReady = (text: string) => {
  const first = text.split(/\r?\n\r?\n/u)[0]!
  expect(first.startsWith('event: stream.ready\n')).toBe(true)
  expect(first).not.toMatch(/^id:/mu)
  return AgentRunStreamReadySchema.parse(
    JSON.parse(
      first
        .split(/\r?\n/u)
        .find(line => line.startsWith('data: '))!
        .slice(6)
    )
  )
}
const closeServer = async (server: Server): Promise<void> => {
  const closed = Promise.withResolvers<void>()
  server.close(error => (error ? closed.reject(error) : closed.resolve()))
  server.closeAllConnections()
  await closed.promise
}

suite('native provider producer to owned PostgreSQL and host SSE', () => {
  // Consumer risk not covered by the existing fake-engine HTTP or mock-service
  // engine tests: a real memory tool result must survive native factory decoding,
  // frozen-session semantics, durable event projection, live/replayed SSE ownership,
  // and dispatch reservation reconciliation in the same admitted run.
  it('saves changed memory without refreshing its originating snapshot and settles its real producer receipts', async () => {
    const database = await createAgentMediaTestDatabase(connection)
    const db = database.db
    let wire: NativeProviderWireFixture | undefined
    let host: Server | undefined
    let runtime: AgentProductRuntime | undefined
    const streams: AbortController[] = []
    const store = new session.MemoryStore()
    try {
      await createRoutingTables(db)
      await addAgentMemory(db)
      // The existing routing schema fixture intentionally omits conformance's
      // report table. Match the existing durable report contract, not fake rows.
      await db.schema.createTable('agentProviderConformanceReports', table => {
        table.uuid('id').primary()
        table.uuid('profileVersionId').notNullable().references('id').inTable('agentProviderProfileVersions')
        table.string('status', 16).notNullable()
        table.text('checks').notNullable()
        table.string('errorCode', 128).nullable()
        table.integer('actorId').nullable().references('id').inTable('users')
        table.dateTime('startedAt').notNullable()
        table.dateTime('completedAt').notNullable()
      })
      const loadFixtureUser = async (id: number) => {
        const user = await db('users').where({ id }).first('id', 'authVersion', 'isActive')
        if (!user) return undefined
        const groups = await db('groups')
          .join('userGroups', 'groups.id', 'userGroups.groupId')
          .where('userGroups.userId', id)
          .select('groups.id', 'groups.permissions')
        return { ...user, groups: groups.map(group => ({ ...group, permissions: JSON.parse(group.permissions) as string[] })) }
      }
      // Objection user-loading seam only: identity/permission rows are real owned
      // fixtures. No maintained/full spawned-app login or passport proof is claimed.
      vi.stubGlobal('WIKI', {
        models: {
          knex: db,
          users: {
            query: () => ({
              findById: (id: number) => ({
                withGraphFetched: () => ({ modifyGraph: () => loadFixtureUser(id) })
              })
            })
          }
        }
      })
      const [{ AxAgentEngine }, { createWikiActionSessionProvider }, { default: createAgentsHostController }] = await Promise.all([
        import('../../agents/providers/engine.ts'),
        import('../../agents/providers/wiki-actions.ts'),
        import('../../controllers/agents-host.ts')
      ])
      wire = await createNativeProviderWireFixture()
      const secrets: AgentSecretRegistry = {
        has: reference => reference === 'env:NATIVE_FIXTURE_KEY',
        get: reference => (reference === 'env:NATIVE_FIXTURE_KEY' ? 'ephemeral-local-wire-only' : null),
        store: () => {
          throw new Error('Native fixture does not store credentials')
        },
        delete: () => false
      }
      const registry = new AgentProviderRegistry(db, secrets, {
        currentKeyId: 'fixture',
        keys: { fixture: 'native-fixture-profile-resolution-key-only' }
      })
      const profile = await registry.create({
        displayName: 'Owned native wire fixture',
        transportKind: 'openai-chat',
        model: 'native-fixture-model',
        utilityModel: null,
        baseUrl: 'https://provider.example.test/v1',
        authMode: 'bearer',
        secretReference: 'env:NATIVE_FIXTURE_KEY',
        adapterConfig: { timeoutMs: 5_000, maxRetries: 0, additionalHeaders: {} },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 64_000,
          maxOutputTokens: 2_000
        },
        capabilityRevision: 'native-fixture-v1',
        pricingRevision: 'native-fixture-v1|1000000|2000000',
        policies: {
          allowedModes: ['agent'],
          dailyTokens: 2_000_000,
          dailyCostMicros: 4_000_000,
          reservationTokens: 500_000,
          reservationCostMicros: 1_000_000,
          reservationMilliseconds: 60_000,
          promptVersion: 1,
          maxAttempts: 1
        },
        exposureMode: 'all_agent_users',
        actorId: 1
      })
      const version = await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')
      const factory = new AgentProviderFactory(db, secrets, wire.implementation, wire.resolve)
      // Run the actual native conformance handshake BEFORE enabling admission.
      // Its pre-aborted probe must never appear at the local HTTP responder.
      const report = await new AgentProviderConformanceRunner(db, factory, registry).run(profile.id, 1)
      expect(report).toMatchObject({
        status: 'passed',
        errorCode: null,
        checks: expect.arrayContaining([
          { name: 'pre-dispatch-cancellation', passed: true },
          { name: 'buffered-response', passed: true },
          { name: 'declared-usage', passed: true },
          { name: 'native-tool-round-trip', passed: true }
        ])
      })
      expect(wire.requests).toHaveLength(3)
      expect(wire.requests.some(request => request.messages.some(message => message.content?.includes('pre-cancelled')))).toBe(false)
      expect(await db('agentProviderConformanceReports').where({ id: report.id }).first('status')).toEqual({ status: 'passed' })
      await registry.setEnabled(profile.id, true, 1, version.currentVersionId)
      await registry.setDefault(profile.id, 1)
      const actions = createWikiActionSessionProvider(db, {
        enabled: true,
        providerEnabled: true,
        orchestrationEnabled: false,
        skillsEnabled: false,
        browserEnabled: false,
        proposalsEnabled: false,
        writesEnabled: false,
        writeCreateEnabled: false,
        writePatchEnabled: false,
        writeMoveEnabled: false,
        writeRestoreEnabled: false,
        writeDeleteEnabled: false,
        snapshotSigningSecret: new Uint8Array(32).fill(9)
      })
      const engine = new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders })
      runtime = new AgentProductRuntime(db, registry, engine, {
        memorySigningSecret: 'native-fixture-controller-resolution-only',
        workerId: `native-fixture-${randomUUID()}`,
        globalConcurrency: 1,
        perUserConcurrency: 1,
        orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false },
        goals: { enabled: false, maxContinuations: 1, maxTokens: 500_000, maxToolCalls: 8, maxDurationMilliseconds: 60_000 },
        authorizeMedia: async ownerId => {
          const user = await loadFixtureUser(ownerId)
          if (!user?.isActive || !user.groups.some(group => group.permissions.includes('use:agents')))
            throw new Error('Owned fixture user authority was revoked')
        }
      })
      const app = express()
      app.use(cookieParser())
      app.use(session({ secret: 'native-local-session-fixture-only', store, resave: false, saveUninitialized: false }))
      // Explicit test auth seam, not a production login route. Only these two
      // owned identities can seed a signed session cookie; no auth headers bypass
      // the controller's user, permission, origin or CSRF checks.
      app.get('/fixture-session/:ownerId', (req, res) => {
        const ownerId = Number(req.params.ownerId)
        if (ownerId !== 7 && ownerId !== 8) return res.sendStatus(404)
        const state = req.session as SessionState
        state.fixtureOwnerId = ownerId
        state.agentCsrfToken = csrf
        return res.sendStatus(204)
      })
      app.use(
        createAgentsHostController({
          auth: {
            authenticate(req, res, next) {
              const ownerId = (req.session as SessionState).fixtureOwnerId
              if (!ownerId) {
                res.sendStatus(401)
                return
              }
              void loadFixtureUser(ownerId)
                .then(user => {
                  if (!user?.isActive) {
                    res.sendStatus(401)
                    return
                  }
                  req.authContext = { kind: 'user', userId: ownerId, ownershipUserId: ownerId, principal: { id: ownerId } }
                  req.user = {
                    id: ownerId,
                    authVersion: user.authVersion,
                    groups: user.groups.map(group => group.id),
                    permissions: [...new Set(user.groups.flatMap(group => group.permissions))]
                  } as Express.User
                  next()
                })
                .catch(next)
            }
          },
          config: {
            host: origin,
            sessionSecret: 'native-fixture-controller-resolution-only',
            agents: {
              enabled: true,
              provider: { enabled: true },
              orchestration: { enabled: false },
              goals: { enabled: false },
              retention: { temporarySessionHours: 1 },
              skills: { enabled: false, namespace: 'system/agent-skills' },
              proposals: { enabled: false },
              writes: {
                enabled: false,
                create: { enabled: false },
                patch: { enabled: false },
                move: { enabled: false },
                restore: { enabled: false },
                delete: { enabled: false }
              }
            }
          },
          logger: { error: () => {} },
          models: { knex: db },
          providerRegistry: registry,
          agentRuntime: runtime
        })
      )
      host = app.listen(0, '127.0.0.1')
      await once(host, 'listening')
      const baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
      const request = (path: string, init: RequestInit = {}) =>
        fetch(`${baseUrl}${path}`, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(30_000)
        })
      expect((await request('/_api/agents/sessions')).status).toBe(401)
      const cookieFor = async (ownerId: number) => {
        const seeded = await request(`/fixture-session/${ownerId}`)
        expect(seeded.status).toBe(204)
        const cookie = seeded.headers.get('set-cookie')?.split(';', 1)[0]
        if (!cookie) throw new Error('Owned fixture session cookie missing')
        return cookie
      }
      const cookie = await cookieFor(7)
      const foreignCookie = await cookieFor(8)
      const headers = { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf, 'content-type': 'application/json' }
      expect(
        (
          await request('/_api/agents/sessions', {
            method: 'POST',
            headers: { ...headers, 'x-wiki-csrf': 'incorrect' },
            body: JSON.stringify({ retention: 'saved' })
          })
        ).status
      ).toBe(403)
      const createSession = async (): Promise<SessionProjection> => {
        const response = await request('/_api/agents/sessions', { method: 'POST', headers, body: JSON.stringify({ retention: 'saved' }) })
        expect(response.status).toBe(201)
        return (await response.json()) as SessionProjection
      }
      const first = await createSession()
      const frozenBefore = (await db('agentSessions').where({ id: first.session.id }).first('memorySnapshot')).memorySnapshot as string
      expect(JSON.parse(frozenBefore)).toEqual({ agent: [], user: [] })
      expect(first.memoryContext).toMatchObject({
        ownerId: 7,
        sessionId: first.session.id,
        frozen: {
          snapshotId: first.session.id,
          user: { state: 'available', characters: 0, limit: 1375 },
          agent: { state: 'available', characters: 0, limit: 2200 }
        },
        nextSession: { user: 'unchanged', agent: 'unchanged' }
      })
      const execute = async (state: SessionProjection, changed: boolean, presetId?: AgentPresetId) => {
        wire!.expectChanged(changed)
        const body = {
          clientRequestId: randomUUID(),
          expectedSessionVersion: state.session.version,
          profileResolutionToken: state.session.profileResolutionToken,
          content: '  Remember my preference for concise answers.\r\nKeep café and e\u0301 exactly.  ',
          ...(presetId === undefined ? {} : { presetId })
        }
        const beforeWire = wire!.requests.length
        const admissionResponse = await request(`/_api/agents/sessions/${state.session.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        })
        expect(admissionResponse.status).toBe(202)
        const admission = (await admissionResponse.json()) as { run: { id: string; status: string }; replayed: boolean }
        expect(admission).toMatchObject({ replayed: false, run: { status: 'queued' } })
        const runId = admission.run.id
        const replayResponse = await request(`/_api/agents/sessions/${state.session.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        })
        expect(replayResponse.status).toBe(202)
        expect(await replayResponse.json()).toMatchObject({ replayed: true, run: { id: runId } })
        if (presetId !== undefined) {
          const mismatch = await request(`/_api/agents/sessions/${state.session.id}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, presetId: 'page-summary' })
          })
          expect(mismatch.status).toBe(409)
          expect(await mismatch.json()).toMatchObject({ error: 'RUN_IDEMPOTENCY_MISMATCH' })
        }
        expect(await db('agentRuns').where({ sessionId: state.session.id })).toHaveLength(1)
        expect(await db('agentMessages').where({ sessionId: state.session.id })).toHaveLength(2)
        expect(await db('agentQuotaReservations').where({ runId })).toHaveLength(1)
        expect(wire!.requests).toHaveLength(beforeWire)
        expect((await request(`/_api/agents/runs/${runId}/events`, { headers: { cookie: foreignCookie } })).status).toBe(404)
        const abort = new AbortController()
        streams.push(abort)
        const live = await request(`/_api/agents/runs/${runId}/events`, {
          headers: { cookie, accept: 'text/event-stream' },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
        })
        expect(live.status).toBe(200)
        expect(live.headers.get('x-accel-buffering')).toBe('no')
        const liveBody = live.text()
        void liveBody.catch(() => {})
        expect(await runtime!.runOnce()).toBe(true)
        const run = await db('agentRuns').where({ id: runId }).first()
        expect(run).toMatchObject({ status: 'succeeded', leaseToken: null, errorCode: null })
        const events = await db<DurableEvent>('agentEvents').where({ runId }).orderBy('sequence')
        const liveText = await liveBody
        expect(parseReady(liveText)).toEqual({ schemaVersion: 1, ownerId: 7, sessionId: state.session.id, runId, replayThroughSequence: 1 })
        const delivered = parseSse(liveText)
        expect(delivered.map(event => event.sequence)).toEqual(events.map(event => event.sequence))
        for (const [index, event] of events.entries()) {
          expect(event.sequence).toBe(index + 1)
          expect(createHash('sha256').update(event.data).digest('hex')).toBe(event.dataSha256)
          expect(delivered[index]).toMatchObject({
            sequence: event.sequence,
            type: event.type,
            envelope: {
              id: event.id,
              runId,
              sequence: event.sequence,
              type: event.type,
              schemaVersion: event.schemaVersion,
              attempt: event.attempt,
              data: JSON.parse(event.data)
            }
          })
        }
        expect(events[0]?.type).toBe('run.queued')
        const queued = JSON.parse(events[0]!.data)
        if (presetId === undefined) expect(queued).not.toHaveProperty('presetId')
        else expect(queued.presetId).toBe(presetId)
        expect(events.at(-1)?.type).toBe('run.completed')
        expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ runId, status: 'succeeded' })
        const memoryCompleted = events.filter(event => event.type === 'tool.completed' && JSON.parse(event.data).actionName === 'memory.manage')
        expect(memoryCompleted).toHaveLength(1)
        const completed = JSON.parse(memoryCompleted[0]!.data) as { actionCallId: string; result: string }
        // tool.completed.result is the CANONICAL action output JSON, not the
        // provider-facing receipt projection. Assert both real boundaries below.
        expect(JSON.parse(completed.result)).toMatchObject({
          changed,
          target: 'user',
          entries: [nativeFixtureMemory],
          characters: nativeFixtureMemory.length,
          limit: 1375,
          message: changed ? 'Memory saved for new conversations.' : 'Memory already exists; no duplicate was added.'
        })
        const started = events.find(event => event.type === 'tool.started' && JSON.parse(event.data).actionCallId === completed.actionCallId)
        expect(started).toBeDefined()
        expect(started!.sequence).toBeLessThan(memoryCompleted[0]!.sequence)
        expect(events.filter(event => event.type === 'tool.failed')).toHaveLength(0)
        const saved = delivered.filter(event => event.envelope.type === 'memory.saved')
        expect(saved).toHaveLength(changed ? 1 : 0)
        if (changed)
          expect(saved[0]!.envelope).toMatchObject({
            runId,
            attempt: 1,
            data: {
              ownerId: 7,
              sessionId: state.session.id,
              snapshotId: state.session.id,
              origin: 'memory.manage',
              operationId: completed.actionCallId,
              operation: 'add',
              changed: true,
              targets: [{ target: 'user', characters: nativeFixtureMemory.length, limit: 1375 }]
            }
          })
        const included = delivered.map(event => event.envelope).filter(event => event.type === 'memory.contextIncluded')
        if (state.memoryContext.frozen.user.state === 'available' && state.memoryContext.frozen.user.characters > 0) {
          expect(included.length).toBeGreaterThan(0)
          expect(new Set(included.map(event => event.data.deliveryId)).size).toBe(included.length)
          for (const event of included)
            expect(event).toMatchObject({
              runId,
              attempt: 1,
              data: {
                ownerId: 7,
                sessionId: state.session.id,
                snapshotId: state.session.id,
                targets: [
                  {
                    target: 'user',
                    characters: state.memoryContext.frozen.user.characters,
                    limit: 1375,
                    snapshotId: state.memoryContext.frozen.user.snapshotId
                  }
                ]
              }
            })
        } else expect(included).toHaveLength(0)
        for (const event of delivered.filter(event => event.envelope.type === 'memory.saved' || event.envelope.type === 'memory.contextIncluded')) {
          expect(event.envelope.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
          expect(JSON.stringify(event.envelope)).not.toContain(nativeFixtureMemory)
        }
        expect(events.some(event => event.type === 'model.turn')).toBe(true)
        expect(events.some(event => event.type === 'message.completed')).toBe(true)
        const runtimeCalls = wire!.requests.slice(beforeWire)
        expect(runtimeCalls.length).toBeGreaterThanOrEqual(3)
        expect(runtimeCalls[0]!.messages.filter(message => message.role === 'user').map(message => message.content)).toContain(body.content)
        const usage = JSON.parse(events.filter(event => event.type === 'usage.updated').at(-1)!.data)
        const totalTokens = runtimeCalls.length * 10
        const totalCostMicros = runtimeCalls.length * 13
        expect(usage).toMatchObject({
          usageVersion: 2,
          inputTokens: runtimeCalls.length * 7,
          outputTokens: runtimeCalls.length * 3,
          totalTokens,
          costMicros: totalCostMicros
        })
        expect(usage.unsettledExposure).toBeUndefined()
        expect(Number(run.totalTokens)).toBe(totalTokens)
        expect(Number(run.estimatedCostMicros)).toBe(totalCostMicros)
        const reservation = await db('agentQuotaReservations').where({ runId }).first()
        expect(reservation.status).toBe('consumed')
        expect(reservation.reconciledAt).not.toBeNull()
        expect(Number(reservation.consumedTokens)).toBe(totalTokens)
        expect(Number(reservation.consumedCostMicros)).toBe(totalCostMicros)
        const cursor = memoryCompleted[0]!.sequence
        const replay = await request(`/_api/agents/runs/${runId}/events`, {
          headers: { cookie, accept: 'text/event-stream', 'last-event-id': String(cursor) }
        })
        expect(replay.status).toBe(200)
        const replayText = await replay.text()
        expect(parseReady(replayText)).toEqual({ schemaVersion: 1, ownerId: 7, sessionId: state.session.id, runId, replayThroughSequence: events.length })
        expect(parseSse(replayText).map(event => event.sequence)).toEqual(events.filter(event => event.sequence > cursor).map(event => event.sequence))
        const projected = await request(`/_api/agents/sessions/${state.session.id}`, { headers: { cookie } })
        expect(projected.status).toBe(200)
        const thread = (await projected.json()) as {
          messages: Array<{ role: string; status: string; content: string; presetId?: AgentPresetId }>
          memoryContext: AgentMemoryContextProjection
        }
        expect(thread.memoryContext.frozen).toEqual(state.memoryContext.frozen)
        expect(thread.memoryContext).toMatchObject({
          latestSaved: { user: { state: 'available', characters: nativeFixtureMemory.length, limit: 1375 } },
          nextSession: { user: changed ? 'changed' : 'unchanged', agent: 'unchanged' }
        })
        if (changed && saved[0]!.envelope.type === 'memory.saved') {
          const target = saved[0]!.envelope.data.targets[0]!
          expect(thread.memoryContext.latestSaved.user).toMatchObject(target)
        }
        expect(thread.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'complete' })
        expect(thread.messages[0]).toMatchObject({ role: 'user', content: body.content })
        if (presetId === undefined) expect(thread.messages[0]).not.toHaveProperty('presetId')
        else expect(thread.messages[0]!.presetId).toBe(presetId)
        expect(thread.messages.at(-1)).not.toHaveProperty('presetId')
        expect(thread.messages.at(-1)!.content).toContain(changed ? 'Memory operation changed user memory.' : 'Memory operation made no change to user memory.')
        return { runtimeCalls, totalTokens, totalCostMicros }
      }
      const changed = await execute(first, true, 'catch-up')
      expect(
        changed.runtimeCalls[0]!.messages.filter(message => message.role === 'system').some(message => message.content?.includes('Frozen memory (JSON)'))
      ).toBe(false)
      expect((await db('agentSessions').where({ id: first.session.id }).first('memorySnapshot')).memorySnapshot).toBe(frozenBefore)
      expect(await db('agentMemories').where({ ownerId: 7 }).select('target', 'content', 'version')).toEqual([
        { target: 'user', content: nativeFixtureMemory, version: 1 }
      ])
      expect(await db('agentMemories').where({ ownerId: 8 }).select('id')).toEqual([])
      const second = await createSession()
      expect(second.session.id).not.toBe(first.session.id)
      expect(JSON.parse((await db('agentSessions').where({ id: second.session.id }).first('memorySnapshot')).memorySnapshot)).toEqual({
        agent: [],
        user: [nativeFixtureMemory]
      })
      const unchanged = await execute(second, false)
      const frozenPrompt = unchanged.runtimeCalls[0]!.messages.find(message => message.role === 'system' && message.content?.includes('Frozen memory (JSON)'))
      expect(frozenPrompt?.content).toContain(JSON.stringify({ userProfile: [nativeFixtureMemory], agentNotes: [] }))
      expect((await db('agentSessions').where({ id: first.session.id }).first('memorySnapshot')).memorySnapshot).toBe(frozenBefore)
      expect(await db('agentMemories').where({ ownerId: 7 }).select('version')).toEqual([{ version: 1 }])
      expect(wire.receipts).toEqual([
        expect.objectContaining({
          kind: 'receipt',
          status: 'applied',
          representation: 'operation-receipt',
          receipt: {
            operation: 'memory.manage',
            action: 'add',
            saveEligible: true,
            changed: true,
            target: 'user',
            characters: nativeFixtureMemory.length,
            limit: 1375
          }
        }),
        expect.objectContaining({
          kind: 'receipt',
          status: 'no-change',
          representation: 'operation-receipt',
          receipt: {
            operation: 'memory.manage',
            action: 'add',
            saveEligible: false,
            changed: false,
            target: 'user',
            characters: nativeFixtureMemory.length,
            limit: 1375
          }
        })
      ])
      const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
      expect(Number(daily.reservedTokens)).toBe(0)
      expect(Number(daily.reservedCostMicros)).toBe(0)
      expect(Number(daily.consumedTokens)).toBe(changed.totalTokens + unchanged.totalTokens)
      expect(Number(daily.consumedCostMicros)).toBe(changed.totalCostMicros + unchanged.totalCostMicros)
      expect(wire.validatedUrls).toHaveLength(wire.requests.length)
      expect(wire.resolvedHosts).toHaveLength(wire.requests.length)
      expect(wire.validatedUrls.every(url => url === 'https://provider.example.test/v1/chat/completions')).toBe(true)
    } finally {
      for (const controller of streams) controller.abort()
      try {
        await runtime?.shutdown()
      } finally {
        try {
          if (host) await closeServer(host)
        } finally {
          try {
            await wire?.close()
          } finally {
            store.clear()
            vi.unstubAllGlobals()
            await database.destroy()
          }
        }
      }
    }
  }, 90_000)
})

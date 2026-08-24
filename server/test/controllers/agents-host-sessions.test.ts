/** @vitest-environment node */
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import cookieParser from 'cookie-parser'
import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import createAgentsHostController from '../../controllers/agents-host.ts'
import { AgentProductRuntime, type AgentEngine } from '../../agents/runtime.ts'

interface TestSessionState { agentCsrfToken?: string }

const createTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('users', table => table.integer('id').primary())
  await db('users').insert([{ id: 7 }, { id: 8 }])
  await db.schema.createTable('agentSessions', table => {
    table.uuid('id').primary(); table.integer('ownerId').notNullable(); table.string('title').notNullable(); table.string('retention').notNullable(); table.uuid('providerProfileId').nullable(); table.string('executionMode').notNullable(); table.integer('version').notNullable(); table.text('summary').nullable(); table.integer('summaryThroughOrdinal').nullable(); table.dateTime('createdAt').notNullable(); table.dateTime('updatedAt').notNullable(); table.dateTime('lastActivityAt').notNullable(); table.dateTime('expiresAt').nullable(); table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentMessages', table => {
    table.uuid('id').primary(); table.uuid('sessionId').notNullable(); table.uuid('runId').nullable(); table.integer('ordinal').notNullable(); table.string('role').notNullable(); table.string('status').notNullable(); table.text('content').notNullable(); table.text('citations').nullable(); table.binary('providerStateCiphertext').nullable(); table.string('providerStateSha256').nullable(); table.dateTime('createdAt').notNullable(); table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('agentRuns', table => {
    table.uuid('id').primary(); table.uuid('sessionId').notNullable(); table.uuid('userMessageId').notNullable(); table.uuid('assistantMessageId').notNullable(); table.integer('ownerId').notNullable(); table.uuid('clientRequestId').notNullable(); table.string('clientRequestSha256').notNullable(); table.string('profileResolutionSha256').notNullable(); table.string('status').notNullable(); table.integer('attempts').notNullable(); table.integer('maxAttempts').notNullable(); table.integer('eventSequence').notNullable(); table.dateTime('availableAt').notNullable(); table.string('leaseOwner').nullable(); table.uuid('leaseToken').nullable(); table.dateTime('leaseExpiresAt').nullable(); table.dateTime('cancelRequestedAt').nullable(); table.boolean('sideEffectsStarted').notNullable(); table.uuid('providerProfileVersionId').notNullable(); table.string('transportKind').notNullable(); table.string('model').notNullable(); table.string('executionMode').notNullable(); table.integer('profilePolicyVersion').notNullable(); table.integer('defaultGeneration').notNullable(); table.string('capabilityRevision').notNullable(); table.string('pricingRevision').notNullable(); table.integer('promptVersion').notNullable(); table.integer('inputTokens').notNullable(); table.integer('outputTokens').notNullable(); table.integer('estimatedCostMicros').nullable(); table.string('errorCode').nullable(); table.text('errorMessage').nullable(); table.dateTime('queuedAt').notNullable(); table.dateTime('startedAt').nullable(); table.dateTime('updatedAt').notNullable(); table.dateTime('completedAt').nullable()
  })
  await db.schema.createTable('agentEvents', table => {
    table.uuid('id').primary(); table.uuid('runId').notNullable(); table.integer('sequence').notNullable(); table.string('type').notNullable(); table.integer('attempt').notNullable(); table.integer('schemaVersion').notNullable(); table.string('dataSha256').notNullable(); table.text('data').notNullable(); table.dateTime('createdAt').notNullable()
  })
  await db.schema.createTable('agentSessionSkills', table => { table.uuid('sessionId'); table.uuid('skillVersionId'); table.integer('ordinal') })
  await db.schema.createTable('agentSkillVersions', table => { table.uuid('id').primary(); table.uuid('skillId'); table.bigInteger('sourceRevision'); table.dateTime('sourceUpdatedAt'); table.integer('sourceHistoryId'); table.text('frontmatter'); table.text('skillMarkdown'); table.binary('resourceBundle'); table.text('resourceManifest'); table.string('contentHash'); table.string('approvalStatus'); table.integer('approvedBy'); table.dateTime('approvedAt'); table.dateTime('createdAt') })
  await db.schema.createTable('agentSkills', table => { table.uuid('id').primary(); table.string('name'); table.integer('rootPageId'); table.text('rootPath'); table.integer('assetFolderId'); table.string('status'); table.string('exposureMode'); table.uuid('currentVersionId'); table.boolean('isAgentDiscoverable').notNullable().defaultTo(true); table.integer('ownerUserId'); table.dateTime('deletedAt'); table.integer('createdBy'); table.integer('updatedBy'); table.dateTime('createdAt'); table.dateTime('updatedAt') })
  await db.schema.createTable('agentSkillGrants', table => { table.uuid('skillId'); table.integer('groupId') })
  await db.schema.createTable('agentRunSkills', table => { table.uuid('runId'); table.uuid('skillVersionId'); table.integer('ordinal') })
  await db.schema.createTable('pages', table => { table.integer('id'); table.string('localeCode'); table.text('path'); table.string('title'); table.string('contentType') })
  await db.schema.createTable('agentProposals', table => { table.uuid('id'); table.uuid('sessionId'); table.string('sourceKind'); table.string('actionName'); table.string('risk'); table.string('status'); table.string('summary'); table.integer('pageId'); table.integer('baseSourceRevision'); table.string('authoritySha256'); table.string('inputHash'); table.string('patchSha256'); table.string('resultCanonicalSha256'); table.string('diffSha256'); table.text('diff'); table.dateTime('contentPurgedAt'); table.dateTime('expiresAt'); table.dateTime('createdAt') })
  await db.schema.alterTable('agentProposals', table => { table.text('operation') })
  await db.schema.createTable('agentApprovals', table => { table.uuid('id'); table.uuid('proposalId'); table.string('status'); table.dateTime('requestedAt'); table.dateTime('expiresAt'); table.dateTime('decidedAt'); table.text('decisionNote') })
  await db.schema.createTable('agentArtifacts', table => { table.uuid('id'); table.uuid('sessionId'); table.uuid('runId'); table.integer('ownerId'); table.string('kind'); table.string('mimeType'); table.integer('byteLength'); table.binary('payload'); table.string('sha256'); table.integer('width'); table.integer('height'); table.dateTime('createdAt'); table.dateTime('expiresAt') })
  await db.schema.createTable('agentSkillUses', table => { table.uuid('id'); table.uuid('skillVersionId'); table.uuid('runId'); table.uuid('sessionId'); table.integer('requesterUserId'); table.integer('requesterApiKeyId'); table.uuid('transportRequestId'); table.string('externalSessionSha256'); table.text('resourcePath'); table.string('purpose'); table.string('contentHash'); table.dateTime('createdAt') })
  await db.schema.createTable('agentQuotaDaily', table => { table.integer('ownerId'); table.date('day'); table.bigInteger('reservedTokens'); table.bigInteger('consumedTokens'); table.bigInteger('reservedCostMicros'); table.bigInteger('consumedCostMicros'); table.dateTime('updatedAt'); table.primary(['ownerId', 'day']) })
  await db.schema.createTable('agentQuotaReservations', table => { table.uuid('runId').primary(); table.integer('ownerId'); table.date('day'); table.bigInteger('reservedTokens'); table.bigInteger('reservedCostMicros'); table.bigInteger('consumedTokens'); table.bigInteger('consumedCostMicros'); table.string('status'); table.dateTime('expiresAt'); table.dateTime('heartbeatAt'); table.dateTime('reconciledAt').nullable() })
}

describe('ordinary-origin agent session API', () => {
  let db: Knex
  let server: Server
  let baseUrl: string
  let cookie: string
  let ownerId = 7
  const csrf = 'csrf-token'
  let runtime: AgentProductRuntime
  let engineCurrentPage: unknown
  let engineSkills: readonly { readonly id: string; readonly name: string }[] = []

  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createTables(db)
    const fakeEngine: AgentEngine = {
      async execute(request, sink) {
        engineCurrentPage = request.currentPage
        engineSkills = request.skills.map(skill => ({ id: skill.id, name: skill.name }))
        await sink.text('Hello ')
        await sink.text('from the deterministic engine.')
        return { inputTokens: 3, outputTokens: 5, costMicros: 8, suggestions: [{ id: 'continue', label: 'Continue', prompt: 'Continue' }] }
      }
    }
    runtime = new AgentProductRuntime(db, {
      async resolve() {
        return {
          profileResolutionSha256: 'a'.repeat(64),
          providerProfileVersionId: '00000000-0000-4000-8000-000000000070',
          transportKind: 'test',
          model: 'deterministic',
          executionMode: 'agent',
          profilePolicyVersion: 1,
          defaultGeneration: 1,
          capabilityRevision: 'test-v1',
          pricingRevision: 'test-v1',
          promptVersion: 1,
          skillVersionIds: [],
          quota: { tokens: 100, costMicros: 100 },
          quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
          reservationMilliseconds: 60_000
        }
      }
    }, fakeEngine, { workerId: 'test-worker', globalConcurrency: 1, perUserConcurrency: 1 })
    const app = express()
    app.use(cookieParser())
    app.use(session({ secret: 'ordinary-host-test-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => { const state = req.session as typeof req.session & TestSessionState; state.agentCsrfToken = csrf; res.sendStatus(204) })
    app.use(createAgentsHostController({
      auth: {
        authenticate(req, _res, next) {
          req.authContext = { kind: 'user', userId: ownerId, ownershipUserId: ownerId, principal: { id: ownerId } }
          req.user = { id: ownerId, groups: [], permissions: ['use:agents'] } as Express.User
          next()
        }
      },
      config: { host: 'https://wiki.example.test', sessionSecret: 'profile-resolution-secret', agents: { enabled: true, provider: { enabled: true }, retention: { temporarySessionHours: 24 }, skills: { enabled: true, namespace: 'system/agent-skills' }, proposals: { enabled: false }, writes: { enabled: false, create: { enabled: false }, patch: { enabled: false }, move: { enabled: false }, restore: { enabled: false }, delete: { enabled: false } } } },
      models: { knex: db },
      agentRuntime: runtime
    }))
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    await listening.promise
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    const seeded = await fetch(`${baseUrl}/seed`)
    cookie = seeded.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterAll(async () => {
    const closed = Promise.withResolvers<void>()
    server.close(error => error ? closed.reject(error) : closed.resolve())
    await closed.promise
    await runtime.shutdown()
    await db.destroy()
  })


  it('requires same-origin metadata and CSRF for session mutations', async () => {
    const body = JSON.stringify({ retention: 'saved', executionMode: 'agent', providerProfileId: null })
    const denied = await fetch(`${baseUrl}/_api/agents/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin' }, body })
    expect(denied.status).toBe(403)
    const accepted = await fetch(`${baseUrl}/_api/agents/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf }, body })
    expect(accepted.status).toBe(201)
    const state = await accepted.json() as { session: { id: string, profileResolutionToken: string } }
    expect(state.session.profileResolutionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const own = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}`, { headers: { cookie } })
    expect(own.status).toBe(200)
    ownerId = 8
    const foreign = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}`, { headers: { cookie } })
    expect(foreign.status).toBe(404)
    ownerId = 7
  })

  it('replays validated SSE events and closes at the terminal sequence', async () => {
    const now = '2026-08-17T00:00:00.000Z'
    const sessionId = '00000000-0000-4000-8000-000000000061'
    const runId = '00000000-0000-4000-8000-000000000062'
    await db('agentSessions').insert({ id: sessionId, ownerId: 7, title: '', retention: 'saved', providerProfileId: null, executionMode: 'agent', version: 1, summary: null, summaryThroughOrdinal: null, createdAt: now, updatedAt: now, lastActivityAt: now, expiresAt: null, deletedAt: null })
    await db('agentRuns').insert({ id: runId, sessionId, userMessageId: '00000000-0000-4000-8000-000000000063', assistantMessageId: '00000000-0000-4000-8000-000000000064', ownerId: 7, clientRequestId: '00000000-0000-4000-8000-000000000065', clientRequestSha256: 'a'.repeat(64), profileResolutionSha256: 'b'.repeat(64), status: 'succeeded', attempts: 1, maxAttempts: 3, eventSequence: 1, availableAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, sideEffectsStarted: false, providerProfileVersionId: '00000000-0000-4000-8000-000000000066', transportKind: 'openai-responses', model: 'test', executionMode: 'agent', profilePolicyVersion: 1, defaultGeneration: 1, capabilityRevision: 'v1', pricingRevision: 'v1', promptVersion: 1, inputTokens: 0, outputTokens: 0, estimatedCostMicros: null, errorCode: null, errorMessage: null, queuedAt: now, startedAt: now, updatedAt: now, completedAt: now })
    const data = JSON.stringify({ runId, status: 'succeeded' })
    await db('agentEvents').insert({ id: '00000000-0000-4000-8000-000000000067', runId, sequence: 1, type: 'run.completed', attempt: 1, schemaVersion: 1, dataSha256: createHash('sha256').update(data).digest('hex'), data, createdAt: now })
    const response = await fetch(`${baseUrl}/_api/agents/runs/${runId}/events`, { headers: { cookie, accept: 'text/event-stream' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const text = await response.text()
    expect(text).toContain('id: 1\nevent: run.completed\n')
    expect(text).toContain('"status":"succeeded"')
  })
  it('submits, executes, reconnects, and replays a deterministic engine run through REST and SSE', async () => {
    const headers = { cookie, 'content-type': 'application/json', origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf }
    const created = await fetch(`${baseUrl}/_api/agents/sessions`, { method: 'POST', headers, body: JSON.stringify({ retention: 'saved', executionMode: 'agent', providerProfileId: null }) })
    const state = await created.json() as { session: { id: string, version: number, profileResolutionToken: string } }
    const request = {
      clientRequestId: '00000000-0000-4000-8000-000000000071',
      expectedSessionVersion: state.session.version,
      profileResolutionToken: state.session.profileResolutionToken,
      content: 'Answer deterministically.',
      currentPage: { id: 42, locale: 'en', path: 'home', observedUpdatedAt: '2026-08-17T00:00:00.000Z' },
    }
    const admitted = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}/messages`, { method: 'POST', headers, body: JSON.stringify(request) })
    expect(admitted.status).toBe(202)
    const admission = await admitted.json() as { run: { id: string, sessionId: string, status: string, attempt: number, eventSequence: number, canCancel: boolean, createdAt: string, startedAt: string | null, completedAt: string | null, errorCode: string | null, errorMessage: string | null }, replayed: boolean }
    expect(admission).toMatchObject({
      replayed: false,
      run: {
        sessionId: state.session.id,
        status: 'queued',
        attempt: 0,
        eventSequence: 1,
        canCancel: true,
        createdAt: expect.any(String),
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null
      }
    })
    const retry = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}/messages`, { method: 'POST', headers, body: JSON.stringify(request) })
    expect(retry.status).toBe(202)
    expect((await retry.json() as { run: { id: string }, replayed: boolean })).toMatchObject({ run: { id: admission.run.id }, replayed: true })

    expect(await runtime.runOnce()).toBe(true)
    expect(engineCurrentPage).toEqual(request.currentPage)
    const reconnected = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}`, { headers: { cookie } })
    const thread = await reconnected.json() as { messages: Array<{ role: string, status: string, content: string }> }
    expect(thread.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'complete', content: 'Hello from the deterministic engine.' })
    const completed = await fetch(`${baseUrl}/_api/agents/runs/${admission.run.id}`, { headers: { cookie } })
    expect(await completed.json()).toMatchObject({ run: { status: 'succeeded' } })
    const events = await fetch(`${baseUrl}/_api/agents/runs/${admission.run.id}/events`, { headers: { cookie, accept: 'text/event-stream' } })
    const replay = await events.text()
    expect(replay).toContain('event: message.delta')
    expect(replay).toContain('event: message.completed')
    expect(replay).toContain('event: suggestions.updated')
  })
  it('manages owner-scoped skills and applies a manual invocation to one run', async () => {
    const headers = { cookie, 'content-type': 'application/json', origin: 'https://wiki.example.test', 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf }
    const markdown = '---\nname: qa-helper\ndescription: Follow the QA checklist\n---\n# Instructions\n\nCheck the acceptance criteria.\n'
    const createdResponse = await fetch(`${baseUrl}/_api/agents/personal-skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'qa-helper', skillMarkdown: markdown, isAgentDiscoverable: false })
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json() as { skill: { id: string; versionId: string; isAgentDiscoverable: boolean } }).skill
    expect(created.isAgentDiscoverable).toBe(false)
    expect(await (await fetch(`${baseUrl}/_api/agents/skills`, { headers: { cookie } })).json()).toMatchObject({
      skills: [{ id: created.id, versionId: created.versionId, exposureMode: 'owner', isAgentDiscoverable: false }]
    })
    ownerId = 8
    expect(await (await fetch(`${baseUrl}/_api/agents/personal-skills`, { headers: { cookie } })).json()).toEqual({ skills: [] })
    expect(await (await fetch(`${baseUrl}/_api/agents/skills`, { headers: { cookie } })).json()).toEqual({ skills: [] })
    ownerId = 7

    const sessionResponse = await fetch(`${baseUrl}/_api/agents/sessions`, { method: 'POST', headers, body: JSON.stringify({ retention: 'saved', executionMode: 'agent', providerProfileId: null }) })
    const state = await sessionResponse.json() as { session: { id: string; version: number; profileResolutionToken: string } }
    const admittedResponse = await fetch(`${baseUrl}/_api/agents/sessions/${state.session.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientRequestId: '00000000-0000-4000-8000-000000000072',
        expectedSessionVersion: state.session.version,
        profileResolutionToken: state.session.profileResolutionToken,
        content: 'Use my QA process.',
        invokedSkillVersionIds: [created.versionId]
      })
    })
    expect(admittedResponse.status).toBe(202)
    const admitted = await admittedResponse.json() as { run: { id: string } }
    expect(await db('agentRunSkills').where({ runId: admitted.run.id }).select('skillVersionId', 'ordinal')).toEqual([{ skillVersionId: created.versionId, ordinal: 0 }])
    expect(await runtime.runOnce()).toBe(true)
    expect(engineSkills).toEqual([{ id: created.versionId, name: 'qa-helper' }])

    const updatedResponse = await fetch(`${baseUrl}/_api/agents/personal-skills/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedVersionId: created.versionId, skillMarkdown: markdown.replace('acceptance criteria', 'acceptance criteria and evidence'), isAgentDiscoverable: true })
    })
    expect(updatedResponse.status).toBe(200)
    const updated = (await updatedResponse.json() as { skill: { versionId: string } }).skill
    expect(updated.versionId).not.toBe(created.versionId)
    expect((await fetch(`${baseUrl}/_api/agents/personal-skills/${created.id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expectedVersionId: updated.versionId })
    })).status).toBe(200)
    expect(await (await fetch(`${baseUrl}/_api/agents/skills`, { headers: { cookie } })).json()).toEqual({ skills: [] })
  })
  it('serves intact unexpired screenshot artifacts only to their owner', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000068'
    const payload = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    await db('agentArtifacts').insert({
      id: artifactId,
      sessionId: '00000000-0000-4000-8000-000000000061',
      runId: '00000000-0000-4000-8000-000000000062',
      ownerId: 7,
      kind: 'browser-screenshot',
      mimeType: 'image/png',
      byteLength: payload.byteLength,
      payload,
      sha256: createHash('sha256').update(payload).digest('hex'),
      width: 1280,
      height: 720,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    })
    const own = await fetch(`${baseUrl}/_api/agents/artifacts/${artifactId}/content`, { headers: { cookie } })
    expect(own.status).toBe(200)
    expect(own.headers.get('content-type')).toContain('image/png')
    expect(own.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await own.arrayBuffer())).toEqual(payload)
    ownerId = 8
    expect((await fetch(`${baseUrl}/_api/agents/artifacts/${artifactId}/content`, { headers: { cookie } })).status).toBe(404)
    ownerId = 7
  })
})


describe('ordinary-origin agent API routing', () => {
  let db: Knex
  let server: Server
  let baseUrl: string
  let cookie: string
  let permissions: string[] = ['use:agents']
  let ordinaryAuthCalls = 0
  const csrf = 'ordinary-origin-agent-csrf-token-at-least-thirty-two-bytes'

  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createTables(db)
    const app = express()
    app.use(cookieParser())
    app.use(session({ secret: 'ordinary-agent-host-test-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => {
      Reflect.set(req.session, 'agentCsrfToken', csrf)
      res.sendStatus(204)
    })
    app.use(createAgentsHostController({
      auth: {
        authenticate(req, _res, next) {
          ordinaryAuthCalls += 1
          req.authContext = { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } }
          req.user = { id: 7, groups: [], permissions } as Express.User
          next()
        },
      },
      config: {
        host: 'https://wiki.example.test',
        sessionSecret: 'embedded-profile-resolution-secret',
        agents: {
          enabled: true,
          provider: { enabled: false },
          retention: { temporarySessionHours: 24 },
          skills: { enabled: false, namespace: 'system/agent-skills' },
          browser: { enabled: false },
          mcp: { enabled: false },
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
      models: {
        knex: db
      }
    }))
    app.get('/ordinary', (_req, res) => res.sendStatus(204))
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    await listening.promise
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    const seeded = await fetch(`${baseUrl}/seed`)
    cookie = seeded.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterAll(async () => {
    const closed = Promise.withResolvers<void>()
    server.close(error => error ? closed.reject(error) : closed.resolve())
    await closed.promise
    await db.destroy()
  })

  it('falls through ordinary routes without applying isolated host behavior', async () => {
    const response = await fetch(`${baseUrl}/ordinary`)
    expect(response.status).toBe(204)
    expect(ordinaryAuthCalls).toBe(0)
  })

  it('uses ordinary user auth and session CSRF for same-origin mutations', async () => {
    const body = JSON.stringify({ retention: 'saved', executionMode: 'agent', providerProfileId: null })
    const headers = {
      cookie,
      'content-type': 'application/json',
      origin: 'https://wiki.example.test',
      'sec-fetch-site': 'same-origin',
      'x-wiki-csrf': csrf
    }
    const wrongOrigin = await fetch(`${baseUrl}/_api/agents/sessions`, {
      method: 'POST',
      headers: { ...headers, origin: 'https://attacker.example.test' },
      body
    })
    expect(wrongOrigin.status).toBe(403)
    const accepted = await fetch(`${baseUrl}/_api/agents/sessions`, { method: 'POST', headers, body })
    expect(accepted.status).toBe(201)
    expect(ordinaryAuthCalls).toBe(2)
  })

  it('exposes administration only to ordinary manage:system users', async () => {
    permissions = ['use:agents']
    expect((await fetch(`${baseUrl}/_api/agents/admin/runtime`, { headers: { cookie } })).status).toBe(403)
    permissions = ['manage:system']
    const response = await fetch(`${baseUrl}/_api/agents/admin/runtime`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ runtime: { enabled: true, providerEnabled: false } })
  })
})

import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionAuthority } from '../../agents/actions/kernel.ts'
import { BrowserActionService } from '../../agents/browser/actions.ts'
import type { BrowserWorkerAction, BrowserWorkerResult } from '../../agents/browser/runtime.ts'

const runId = '00000000-0000-4000-8000-000000000101'
const sessionId = '00000000-0000-4000-8000-000000000102'
const authority = { version: 1, actionName: 'browser.navigate', requestId: runId, transport: 'agent', requester: { kind: 'user', userId: 7 }, groupIds: [], permissions: ['use:agents', 'use:agent-browser'], featureFlags: {}, allowedActions: null, authoritySha256: 'a'.repeat(64) } as unknown as ActionAuthority
const observation = { contextId: 'context-value-0001', documentEpoch: '00000000-0000-4000-8000-000000000103', url: 'https://example.com/docs', title: 'Docs', text: 'Evidence', refs: [], observedAt: '2026-08-17T00:00:00.000Z' }

describe('browser action service', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentRuns', table => { table.uuid('id'); table.uuid('sessionId'); table.integer('ownerId'); table.string('status'); table.uuid('leaseToken'); table.dateTime('leaseExpiresAt'); table.dateTime('cancelRequestedAt').nullable() })
    await db.schema.createTable('agentBrowserTargets', table => { table.text('canonicalUrl'); table.boolean('enabled') })
    await db.schema.createTable('agentArtifacts', table => { table.uuid('id'); table.uuid('sessionId'); table.uuid('runId'); table.integer('ownerId'); table.string('kind'); table.string('mimeType'); table.integer('byteLength'); table.string('sha256'); table.binary('payload'); table.integer('width'); table.integer('height'); table.dateTime('expiresAt'); table.text('metadata') })
    await db('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running', leaseToken: '00000000-0000-4000-8000-000000000104', leaseExpiresAt: new Date(Date.now() + 60_000), cancelRequestedAt: null })
    await db('agentBrowserTargets').insert([{ canonicalUrl: 'https://example.com/docs', enabled: true }, { canonicalUrl: 'https://disabled.example.com/', enabled: false }])
  })
  afterEach(async () => db.destroy())

  it('passes only live approved HTTPS targets and monotonic run identity to the worker', async () => {
    const calls: Array<{ sequence: number; action: BrowserWorkerAction }> = []
    const execute = vi.fn(async (identity: { sequence: number }, _limits: unknown, action: BrowserWorkerAction): Promise<BrowserWorkerResult> => {
      calls.push({ sequence: identity.sequence, action })
      return action.kind === 'navigate' ? { kind: 'navigated', observation } : { kind: 'observed', observation }
    })
    const service = new BrowserActionService(db, { execute } as never)
    await expect(service.navigate({ url: 'https://example.com/docs' }, { authority, signal: new AbortController().signal })).resolves.toEqual(observation)
    await expect(service.observe({}, { authority, signal: new AbortController().signal })).resolves.toEqual(observation)
    expect(calls.map(call => call.sequence)).toEqual([1, 2])
    expect(calls[0]?.action).toMatchObject({ kind: 'navigate', attestedUrls: ['https://example.com/docs'] })
  })

  it('persists a bounded screenshot as a private expiring artifact', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const service = new BrowserActionService(db, { execute: async (): Promise<BrowserWorkerResult> => ({ kind: 'screenshot', bytes: png, mimeType: 'image/png', width: 1280, height: 720 }) } as never)
    const result = await service.screenshot({}, { authority, signal: new AbortController().signal })
    expect(result).toMatchObject({ mimeType: 'image/png', width: 1280, height: 720 })
    const row = await db('agentArtifacts').where({ id: result.artifactId }).first()
    expect(row).toMatchObject({ sessionId, runId, ownerId: 7, kind: 'browser-screenshot', byteLength: png.byteLength })
    expect(Buffer.from(row.payload)).toEqual(png)
  })
})

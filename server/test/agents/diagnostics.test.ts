import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'

import { exportAgentSessionDiagnostics } from '../../agents/diagnostics.ts'

const sessionId = '00000000-0000-4000-8000-000000000101'
const runId = '00000000-0000-4000-8000-000000000102'
interface DiagnosticExportView {
  readonly totals: Readonly<Record<string, number>>
  readonly messages: readonly Readonly<Record<string, unknown>>[]
  readonly runs: readonly {
    readonly diagnostics: {
      readonly toolCalls: readonly Readonly<Record<string, unknown>>[]
      readonly findings: readonly Readonly<Record<string, unknown>>[]
    }
    readonly timeline: readonly { readonly dataSha256: string }[]
  }[]
  readonly limitations: { readonly modelRationale: string }
}

const now = '2026-08-24T12:00:00.000Z'

const createTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('agentSessions', table => {
    table.uuid('id').primary(); table.integer('ownerId'); table.string('title'); table.string('titleSource'); table.string('retention'); table.uuid('folderId').nullable(); table.uuid('providerProfileId').nullable(); table.string('executionMode'); table.integer('version'); table.text('summary').nullable(); table.integer('summaryThroughOrdinal').nullable(); table.text('memorySnapshot'); table.dateTime('createdAt'); table.dateTime('updatedAt'); table.dateTime('lastActivityAt'); table.dateTime('expiresAt').nullable(); table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentMessages', table => {
    table.uuid('id').primary(); table.uuid('sessionId'); table.uuid('runId').nullable(); table.integer('ordinal'); table.string('role'); table.string('status'); table.text('content'); table.text('citations').nullable(); table.string('providerStateSha256').nullable(); table.dateTime('createdAt'); table.dateTime('updatedAt')
  })
  await db.schema.createTable('agentRuns', table => {
    table.uuid('id').primary(); table.uuid('sessionId'); table.uuid('userMessageId'); table.uuid('assistantMessageId'); table.uuid('clientRequestId'); table.string('status'); table.integer('attempts'); table.integer('maxAttempts'); table.integer('eventSequence'); table.dateTime('availableAt'); table.dateTime('cancelRequestedAt').nullable(); table.boolean('sideEffectsStarted'); table.uuid('providerProfileVersionId'); table.string('transportKind'); table.string('model'); table.string('executionMode'); table.integer('profilePolicyVersion'); table.integer('defaultGeneration'); table.string('capabilityRevision'); table.string('pricingRevision'); table.integer('promptVersion'); table.integer('inputTokens'); table.integer('outputTokens'); table.integer('estimatedCostMicros').nullable(); table.string('errorCode').nullable(); table.text('errorMessage').nullable(); table.dateTime('queuedAt'); table.dateTime('startedAt').nullable(); table.dateTime('updatedAt'); table.dateTime('completedAt').nullable()
  })
  await db.schema.createTable('agentEvents', table => {
    table.uuid('id').primary(); table.uuid('runId'); table.integer('sequence'); table.string('type'); table.integer('attempt'); table.integer('schemaVersion'); table.string('dataSha256'); table.text('data'); table.dateTime('createdAt')
  })
  await db.schema.createTable('agentRunSkills', table => { table.uuid('runId'); table.uuid('skillVersionId'); table.integer('ordinal') })
  await db.schema.createTable('agentSkillVersions', table => { table.uuid('id').primary(); table.uuid('skillId'); table.string('contentHash'); table.text('skillMarkdown') })
  await db.schema.createTable('agentSkills', table => { table.uuid('id').primary(); table.string('name') })
}

const appendEvent = async (db: Knex, sequence: number, type: string, data: Record<string, unknown>): Promise<void> => {
  const encoded = JSON.stringify(data)
  await db('agentEvents').insert({
    id: `00000000-0000-4000-8000-${String(200 + sequence).padStart(12, '0')}`,
    runId,
    sequence,
    type,
    attempt: 1,
    schemaVersion: 1,
    dataSha256: createHash('sha256').update(encoded).digest('hex'),
    data: encoded,
    createdAt: now
  })
}

describe('agent conversation diagnostics', () => {
  let db: Knex | undefined

  afterEach(async () => db?.destroy())

  it('exports complete turns and derives evidence retries and duplicate historical page reads', async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(db)
    const userMessageId = '00000000-0000-4000-8000-000000000103'
    const assistantMessageId = '00000000-0000-4000-8000-000000000104'
    await db('agentSessions').insert({ id: sessionId, ownerId: 7, title: 'Amber Falcon', titleSource: 'utility', retention: 'saved', providerProfileId: null, executionMode: 'agent', version: 2, summary: null, summaryThroughOrdinal: null, memorySnapshot: '{"agent":[],"user":[]}', createdAt: now, updatedAt: now, lastActivityAt: now, expiresAt: null, deletedAt: null })
    await db('agentMessages').insert([
      { id: userMessageId, sessionId, runId, ordinal: 1, role: 'user', status: 'complete', content: 'Who is Amber Falcon?', citations: null, providerStateSha256: null, createdAt: now, updatedAt: now },
      { id: assistantMessageId, sessionId, runId, ordinal: 2, role: 'assistant', status: 'complete', content: 'Amber Falcon.', citations: null, providerStateSha256: 'a'.repeat(64), createdAt: now, updatedAt: now }
    ])
    await db('agentRuns').insert({ id: runId, sessionId, userMessageId, assistantMessageId, clientRequestId: '00000000-0000-4000-8000-000000000105', status: 'succeeded', attempts: 1, maxAttempts: 3, eventSequence: 7, availableAt: now, cancelRequestedAt: null, sideEffectsStarted: false, providerProfileVersionId: '00000000-0000-4000-8000-000000000106', transportKind: 'openai-responses', model: 'gpt-test', executionMode: 'agent', profilePolicyVersion: 1, defaultGeneration: 1, capabilityRevision: 'cap-1', pricingRevision: 'price-1', promptVersion: 1, inputTokens: 149, outputTokens: 1_366, estimatedCostMicros: 0, errorCode: null, errorMessage: null, queuedAt: now, startedAt: now, updatedAt: now, completedAt: now })

    const pageResult = JSON.stringify({ id: 6, title: 'Incident Runbook', path: 'incident-runbook', sourceRevision: '1', content: 'Amber Falcon is a synthetic incident.' })
    await appendEvent(db, 1, 'tool.started', { actionCallId: 'get-1', actionName: 'pages.get', title: 'Get page' })
    await appendEvent(db, 2, 'tool.completed', { actionCallId: 'get-1', actionName: 'pages.get', result: pageResult })
    await appendEvent(db, 3, 'evidence.provenance', { accepted: false, issues: ['Citation did not support its claim.'], finalCitationIds: [] })
    await appendEvent(db, 4, 'evidence.provenance', { accepted: false, issues: ['Citation did not support its claim.'], finalCitationIds: [] })
    await appendEvent(db, 5, 'tool.started', { actionCallId: 'get-2', actionName: 'pages.get', title: 'Get page' })
    await appendEvent(db, 6, 'tool.completed', { actionCallId: 'get-2', actionName: 'pages.get', result: pageResult })
    await appendEvent(db, 7, 'evidence.provenance', { accepted: true, issues: [], finalCitationIds: [] })

    const exported = await exportAgentSessionDiagnostics(db, sessionId) as unknown as DiagnosticExportView

    expect(exported.totals).toEqual({ inputTokens: 149, outputTokens: 1_366, totalTokens: 1_515, estimatedCostMicros: 0 })
    expect(exported.messages).toEqual([
      expect.objectContaining({ ordinal: 1, role: 'user', content: 'Who is Amber Falcon?' }),
      expect.objectContaining({ ordinal: 2, role: 'assistant', content: 'Amber Falcon.', providerContinuation: { sha256: 'a'.repeat(64), contentExported: false } })
    ])
    expect(exported.runs[0].diagnostics.toolCalls).toEqual([
      expect.objectContaining({ actionCallId: 'get-1', inputRecorded: false, duplicateOfActionCallId: null, requestReason: 'model_requested' }),
      expect.objectContaining({ actionCallId: 'get-2', inputRecorded: false, duplicateOfActionCallId: 'get-1', requestedAfterRejectedEvidenceDrafts: 2, requestReason: 'model_requested_after_evidence_rejection' })
    ])
    expect(exported.runs[0].diagnostics.findings).toEqual([
      expect.objectContaining({ kind: 'duplicate_page_reads', count: 1 }),
      expect.objectContaining({ kind: 'evidence_retries', count: 2 }),
      { kind: 'page_answer_accepted_without_citations' }
    ])
    expect(JSON.stringify(exported)).not.toContain('providerStateCiphertext')
    expect(exported.limitations.modelRationale).toContain('neither retained nor exported')
    expect(exported.runs[0]?.timeline.every(event => typeof event.dataSha256 === 'string')).toBe(true)
  })
})

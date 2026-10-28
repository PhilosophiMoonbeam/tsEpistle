import { describe, expect, it } from '../../server/test/bun-test.mts'
import {
  AGENT_ACTION_BY_TOOL_NAME,
  AGENT_ACTION_NAMES,
  AGENT_EVENT_TYPES,
  AGENT_TASK_KINDS,
  AGENT_FEATURE_FLAG_KEYS,
  AGENT_TOOL_NAMES,
  agentProviderReasoningEfforts,
  AgentMemoryContextProjectionSchema,
  AgentMemoryReceiptEventSchema,
  AgentMemorySavedDataSchema,
  AgentManualMemorySavedReceiptSchema,
  AgentRunStreamReadySchema,
  AgentEventSchema
} from './contracts.ts'
import { AgentKnowledgeContextSchema, AgentSourceContextProjectionSchema } from './knowledge-context.ts'

describe('frozen agent contracts', () => {
  it('keeps action, event, and feature identifiers unique', () => {
    expect(new Set(AGENT_ACTION_NAMES).size).toBe(AGENT_ACTION_NAMES.length)
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length)
    expect(new Set(AGENT_FEATURE_FLAG_KEYS).size).toBe(AGENT_FEATURE_FLAG_KEYS.length)
    expect(AGENT_ACTION_NAMES).not.toContain('pages.prepareImportOkf')
    expect(AGENT_FEATURE_FLAG_KEYS).toContain('agents.orchestration.enabled')
    expect(AGENT_EVENT_TYPES).toEqual(expect.arrayContaining(['task.planCreated', 'task.created', 'subagent.started', 'subagent.completed', 'run.partial']))
    expect(AGENT_TASK_KINDS).toEqual(['source_scout', 'fact_check', 'conflict_check'])
  })

  it('uses one unique stable tool name for every action', () => {
    const toolNames = Object.values(AGENT_TOOL_NAMES)
    expect(new Set(toolNames).size).toBe(toolNames.length)
    expect(toolNames.every(name => name.startsWith('wiki_'))).toBe(true)
    expect(new Set(Object.keys(AGENT_TOOL_NAMES))).toEqual(new Set(AGENT_ACTION_NAMES))
    expect(Object.keys(AGENT_ACTION_BY_TOOL_NAME)).toHaveLength(AGENT_ACTION_NAMES.length)
    for (const action of AGENT_ACTION_NAMES) {
      expect(AGENT_ACTION_BY_TOOL_NAME[AGENT_TOOL_NAMES[action]]).toBe(action)
    }
    expect(AGENT_TOOL_NAMES).toMatchObject({
      'pages.get': 'wiki_get_page',
      'pages.discover': 'wiki_discover_pages',
      'pages.prepareCreate': 'wiki_prepare_page_create',
      'memory.manage': 'wiki_manage_memory'
    })
    expect(toolNames).not.toContain('wiki_prepare_okf_import')
  })

  it('keeps protocol-specific reasoning effort values exact', () => {
    expect(agentProviderReasoningEfforts('openai-responses')).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(agentProviderReasoningEfforts('openresponses')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(agentProviderReasoningEfforts('anthropic-messages')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(agentProviderReasoningEfforts('gemini-api')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(agentProviderReasoningEfforts('legacy-completions')).toEqual([])
  })

  it('keeps eight committed attachments separate from a ninth current hint and pending selection', () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1, locale: 'en', path: `page-${index + 1}`, title: `Page ${index + 1}`,
      visibility: 'public' as const, sourceRevision: '3'
    }))
    const hint = { id: 9, locale: 'en', path: 'historical', observedUpdatedAt: '2026-10-27T00:00:00Z' }
    const identities = sources.map(({ id, locale, path }) => ({ id, locale, path }))
    const projection = {
      identity: { kind: 'draft', ownerId: 1, draftId: 'draft', sessionId: 'session' },
      generation: 4, scope: { kind: 'all' },
      attachedSources: sources.map(source => ({ source, access: 'accessible' })),
      pendingSources: [{ id: 10, locale: 'en', path: 'pending' }],
      currentPage: { included: true, origin: 'historical', hint, access: 'accessible' },
      accessibleIdentities: [...identities, { id: 9, locale: 'en', path: 'historical' }]
    }
    expect(AgentSourceContextProjectionSchema.safeParse(projection).success).toBe(true)
    expect(AgentSourceContextProjectionSchema.safeParse({
      ...projection, accessibleIdentities: [...projection.accessibleIdentities, projection.pendingSources[0]]
    }).success).toBe(false)
    expect(AgentSourceContextProjectionSchema.safeParse({
      ...projection, attachedSources: [...projection.attachedSources, { source: { ...sources[0], id: 11 }, access: 'accessible' }]
    }).success).toBe(false)
    expect(AgentSourceContextProjectionSchema.safeParse({
      ...projection, currentPage: { ...projection.currentPage, hint: { ...hint, ...identities[0] } },
      accessibleIdentities: identities
    }).success).toBe(true)
    expect(AgentSourceContextProjectionSchema.safeParse({
      ...projection, attachedSources: [], accessibleIdentities: [{ id: 9, locale: 'en', path: 'historical' }]
    }).success).toBe(true)
    expect(AgentKnowledgeContextSchema.safeParse({
      scope: { kind: 'all' }, sources: sources.map(source => ({ ...source, path: '界'.repeat(1024), title: '界'.repeat(500) }))
    }).success).toBe(false)
  })

  it('represents unavailable historical memory without asserting empty loaded counts', () => {
    const unknown = {
      ownerId: 1, sessionId: 'session',
      frozen: { snapshotId: null, user: { state: 'unavailable' }, agent: { state: 'unknown' } },
      latestSaved: { user: { state: 'error' }, agent: { state: 'offline' } },
      nextSession: { user: 'unknown', agent: 'unknown' }
    }
    expect(AgentMemoryContextProjectionSchema.safeParse(unknown).success).toBe(true)
    expect(AgentMemoryContextProjectionSchema.safeParse({
      ...unknown, frozen: { ...unknown.frozen, user: { state: 'unavailable', characters: 0, limit: 1375 } }
    }).success).toBe(false)
    const user = { state: 'available', target: 'user', characters: 12, limit: 1375, snapshotId: 'a'.repeat(64) }
    const loaded = {
      ...unknown, frozen: { ...unknown.frozen, snapshotId: 'session', user },
      latestSaved: { ...unknown.latestSaved, user: { ...user, characters: 20, snapshotId: 'b'.repeat(64) } },
      nextSession: { user: 'changed', agent: 'unknown' }
    }
    expect(AgentMemoryContextProjectionSchema.safeParse(loaded).success).toBe(true)
    expect(AgentMemoryContextProjectionSchema.safeParse({
      ...loaded, nextSession: { user: 'unchanged', agent: 'unknown' }
    }).success).toBe(false)
  })

  it('accepts pre-execution attempt0 admission events without allowing attempt0 memory receipts', () => {
    const queued = {
      id: 'queued-event', runId: 'run', sequence: 1, attempt: 0, schemaVersion: 1,
      type: 'run.queued', createdAt: '2026-10-27T00:00:00Z', data: {}
    }
    expect(AgentEventSchema.safeParse(queued).success).toBe(true)
    expect(AgentEventSchema.safeParse({ ...queued, type: 'goal.created' }).success).toBe(true)
    expect(AgentEventSchema.safeParse({ ...queued, attempt: -1 }).success).toBe(false)
    const targets = [{ target: 'user', characters: 12, limit: 1375, snapshotId: 'a'.repeat(64) }]
    const included = {
      ...queued, type: 'memory.contextIncluded',
      data: { ownerId: 1, sessionId: 'session', snapshotId: 'session', deliveryId: 'dispatch', targets }
    }
    expect(AgentEventSchema.safeParse({ ...included, attempt: 1 }).success).toBe(true)
    expect(AgentEventSchema.safeParse(included).success).toBe(false)
    const saved = {
      ...queued, type: 'memory.saved',
      data: { ownerId: 1, sessionId: 'session', snapshotId: 'session', origin: 'memory.manage', operationId: 'tool', operation: 'add', changed: true, targets }
    }
    expect(AgentEventSchema.safeParse({ ...saved, attempt: 1 }).success).toBe(true)
    expect(AgentEventSchema.safeParse(saved).success).toBe(false)
  })

  it('validates nonempty delivery receipts and rejects memory text, wrong limits and replay-invalid envelopes', () => {
    const event = {
      id: 'event', runId: 'run', sequence: 9, attempt: 1, schemaVersion: 1,
      type: 'memory.contextIncluded', createdAt: '2026-10-27T00:00:00Z',
      data: {
        ownerId: 1, sessionId: 'session', snapshotId: 'session', deliveryId: 'dispatch',
        targets: [{ target: 'user', characters: 12, limit: 1375, snapshotId: 'a'.repeat(64) }]
      }
    }
    expect(AgentMemoryReceiptEventSchema.safeParse(event).success).toBe(true)
    const ready = { schemaVersion: 1, ownerId: 1, sessionId: 'session', runId: 'run', replayThroughSequence: 8 }
    expect(AgentRunStreamReadySchema.safeParse(ready).success).toBe(true)
    expect(AgentRunStreamReadySchema.safeParse({ ...ready, replayThroughSequence: -1 }).success).toBe(false)
    expect(AgentMemoryReceiptEventSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false)
    expect(AgentMemoryReceiptEventSchema.safeParse({ ...event, attempt: 0 }).success).toBe(false)
    expect(AgentMemoryReceiptEventSchema.safeParse({ ...event, data: { ...event.data, text: 'private' } }).success).toBe(false)
    expect(AgentMemoryReceiptEventSchema.safeParse({
      ...event, data: { ...event.data, targets: [{ ...event.data.targets[0], characters: 0 }] }
    }).success).toBe(false)
    expect(AgentMemoryReceiptEventSchema.safeParse({
      ...event, data: { ...event.data, targets: [{ ...event.data.targets[0], limit: 2200 }] }
    }).success).toBe(false)
  })

  it('permits only changed add/replace save receipts with explicit manual version identity', () => {
    const saved = {
      ownerId: 1, sessionId: 'session', snapshotId: 'session', origin: 'memory.manage',
      operationId: 'tool', operation: 'replace', changed: true,
      targets: [{ target: 'agent', characters: 40, limit: 2200, snapshotId: 'b'.repeat(64) }]
    }
    expect(AgentMemorySavedDataSchema.safeParse(saved).success).toBe(true)
    for (const operation of ['remove', 'clear']) {
      expect(AgentMemorySavedDataSchema.safeParse({ ...saved, operation }).success).toBe(false)
    }
    expect(AgentMemorySavedDataSchema.safeParse({ ...saved, changed: false }).success).toBe(false)
    const manual = {
      schemaVersion: 1, origin: 'manual', ownerId: 1, sessionId: null,
      runId: null, attempt: null, snapshotId: null, entryId: 'entry', entryVersion: 2,
      operation: 'replace', changed: true, targets: saved.targets
    }
    expect(AgentManualMemorySavedReceiptSchema.safeParse(manual).success).toBe(true)
    expect(AgentManualMemorySavedReceiptSchema.safeParse({ ...manual, entryVersion: 1 }).success).toBe(false)
    expect(AgentManualMemorySavedReceiptSchema.safeParse({ ...manual, runId: 'invented-run' }).success).toBe(false)
  })
})

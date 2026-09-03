import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { DecideAgentApprovalRequest } from '../../shared/agents/contracts.ts'
import {
  AgentApiError,
  cancelAgentRun,
  createAgentGoal,
  createAgentMemory,
  createAgentThread,
  createPersonalAgentSkill,
  decideAgentProposal,
  deleteAgentSession,
  getAgentMemories,
  getAgentThread,
  listAgentProfiles,
  listAgentSessions,
  listPersonalAgentSkills,
  removePersonalAgentSkill,
  resetAgentHistory,
  subscribeAgentRun,
  submitAgentMessage,
  updateAgentSession,
  updateAgentSkillPreferences,
  updatePersonalAgentSkill
} from './agents-api.ts'
import { renderSafeMarkdown } from './safe-markdown.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agents client boundary', () => {
  it('rejects malformed thread responses instead of rendering unvalidated provider data', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ session: { id: 'not-a-uuid' }, messages: '<script>' }), { status: 201, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    await expect(Promise.resolve(createAgentThread(fetcher, 'csrf', { retention: 'saved', providerProfileId: null }))).rejects.toThrow()
  })

  it('sends mutating requests with same-origin credentials and the session CSRF token', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await deleteAgentSession(fetcher, 'csrf-token', '00000000-0000-4000-8000-000000000001')
    expect(fetcher).toHaveBeenCalledWith(
      '/_api/agents/sessions/00000000-0000-4000-8000-000000000001',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': 'csrf-token' } })
    )
  })

  it('resets all history through the CSRF-protected collection endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await resetAgentHistory(fetcher, 'csrf-token')
    expect(fetcher).toHaveBeenCalledWith(
      '/_api/agents/sessions',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': 'csrf-token' } })
    )
  })

  it('validates and writes bounded personal memory through owner-scoped endpoints', async () => {
    const entry = {
      id: '00000000-0000-4000-8000-000000000031',
      target: 'user',
      content: 'Prefers concise answers.',
      version: 1,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    const responses = [
      Response.json({ user: { entries: [entry], characters: 24, limit: 1_375 }, agent: { entries: [], characters: 0, limit: 2_200 } }),
      Response.json({ changed: true, message: 'Saved', target: 'user', entries: [entry.content], characters: 24, limit: 1_375 }, { status: 201 })
    ]
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch

    expect(await getAgentMemories(fetcher, 'csrf')).toMatchObject({ user: { entries: [entry] } })
    expect(await createAgentMemory(fetcher, 'csrf', { target: 'user', content: entry.content })).toMatchObject({ changed: true, target: 'user' })
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/_api/agents/memories',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ target: 'user', content: entry.content }) })
    )
  })

  it('turns an empty 403 response into an actionable chat error', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch
    await expect(
      Promise.resolve(
        submitAgentMessage(fetcher, 'csrf', '00000000-0000-4000-8000-000000000001', {
          clientRequestId: '00000000-0000-4000-8000-000000000002',
          expectedSessionVersion: 1,
          profileResolutionToken: 'token',
          content: 'Create a page'
        })
      )
    ).rejects.toThrow('Refresh the page')
  })

  it('trims empty error strings and exposes bounded status and retryability metadata', async () => {
    const forbidden = vi.fn(async () => Response.json({ message: '   ' }, { status: 403 })) as unknown as typeof fetch
    const unavailable = vi.fn(async () => Response.json({ error: 'x'.repeat(1_000) }, { status: 503 })) as unknown as typeof fetch

    const forbiddenError = await getAgentThread(forbidden, 'csrf', '00000000-0000-4000-8000-000000000001').catch(error => error)
    const unavailableError = await getAgentThread(unavailable, 'csrf', '00000000-0000-4000-8000-000000000001').catch(error => error)

    expect(forbiddenError).toBeInstanceOf(AgentApiError)
    expect(forbiddenError).toMatchObject({ status: 403, retryable: false })
    expect((forbiddenError as Error).message).toContain('Refresh the page')
    expect(unavailableError).toMatchObject({ status: 503, retryable: true })
    expect((unavailableError as Error).message).toHaveLength(512)
  })

  it('forwards read cancellation and URL-encodes opaque session pagination metadata', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async () => Response.json({ sessions: [], nextCursor: 'opaque-keyset-cursor' })) as unknown as typeof fetch

    await expect(listAgentSessions(fetcher, 'csrf', { limit: 25, cursor: 'previous/cursor?part=1', signal: controller.signal })).resolves.toEqual({
      sessions: [],
      nextCursor: 'opaque-keyset-cursor'
    })
    expect(fetcher).toHaveBeenCalledWith(
      '/_api/agents/sessions?limit=25&cursor=previous%2Fcursor%3Fpart%3D1',
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it('turns a malformed successful history response into a bounded gateway error', async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [{ id: 'invalid' }], nextCursor: null })) as unknown as typeof fetch

    const error = await listAgentSessions(fetcher, 'csrf').catch(reason => reason)

    expect(error).toBeInstanceOf(AgentApiError)
    expect(error).toMatchObject({ status: 502, retryable: true })
    expect((error as Error).message.length).toBeLessThanOrEqual(512)
  })

  it('rejects invalid history cursors before fetching', async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [], nextCursor: null })) as unknown as typeof fetch

    for (const cursor of ['', 'x'.repeat(513)]) {
      const error = await listAgentSessions(fetcher, 'csrf', { cursor }).catch(reason => reason)
      expect(error).toBeInstanceOf(AgentApiError)
      expect(error).toMatchObject({ status: 400, retryable: false })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts the canonical projected run from a pending cancellation response', async () => {
    const run = {
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: '00000000-0000-4000-8000-000000000002',
      status: 'running',
      attempt: 1,
      eventSequence: 4,
      canCancel: true,
      createdAt: '2026-08-30T00:00:00.000Z',
      startedAt: '2026-08-30T00:00:01.000Z',
      completedAt: null,
      errorCode: null,
      errorMessage: null
    }
    const fetcher = vi.fn(async () => Response.json({ run }, { status: 202 })) as unknown as typeof fetch

    await expect(cancelAgentRun(fetcher, 'csrf', run.id)).resolves.toEqual(run)
    expect(fetcher).toHaveBeenCalledWith(
      `/_api/agents/runs/${run.id}/cancel`,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ 'x-wiki-csrf': 'csrf' }) })
    )
  })

  it('accepts only canonical nonregressing SSE event IDs and forwards EventSource EOF errors', () => {
    const listeners = new Map<string, (event: MessageEvent) => void>()
    class FakeEventSource {
      readonly close = vi.fn()
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener as (event: MessageEvent) => void)
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const event = vi.fn()
    const error = vi.fn()

    const source = subscribeAgentRun('00000000-0000-4000-8000-000000000001', 7, { event, error })
    listeners.get('run.started')?.({ lastEventId: '8' } as MessageEvent)
    listeners.get('run.started')?.({ lastEventId: ' 9 ' } as MessageEvent)
    listeners.get('run.started')?.({ lastEventId: '08' } as MessageEvent)
    listeners.get('run.started')?.({ lastEventId: '6' } as MessageEvent)
    listeners.get('run.started')?.({ lastEventId: '1e2' } as MessageEvent)
    listeners.get('error')?.(new MessageEvent('error'))

    expect(event.mock.calls.map(call => call[1])).toEqual([8, 7, 7, 7, 7])
    expect(error).toHaveBeenCalledTimes(1)
    expect(source).toBeInstanceOf(FakeEventSource)
  })

  it('accepts the mutable provider selection contract without internal version fields', async () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'OpenAI',
      transport: 'openai-responses',
      model: 'gpt-test',
      utilityModel: null,
      destinationHost: 'api.example.test',
      capabilities: {
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 100_000,
        maxOutputTokens: 4_000
      },
      capabilityRevision: 'cap-1',
      policyVersion: 2,
      isGlobalDefault: true
    }
    const fetcher = vi.fn(async () => Response.json({ profiles: [profile] })) as unknown as typeof fetch
    expect(await listAgentProfiles(fetcher, 'csrf')).toEqual([profile])
  })

  it('validates personal skill documents across create, list, update, and remove requests', async () => {
    const skill = {
      id: '00000000-0000-4000-8000-000000000011',
      name: 'qa-helper',
      description: 'QA helper',
      isAgentDiscoverable: false,
      versionId: '00000000-0000-4000-8000-000000000012',
      contentHash: 'a'.repeat(64),
      skillMarkdown: '---\nname: qa-helper\ndescription: QA helper\n---\nCheck it.\n',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    const responses = [
      Response.json({ skill }, { status: 201 }),
      Response.json({ skills: [skill] }),
      Response.json({ skill: { ...skill, versionId: '00000000-0000-4000-8000-000000000013' } }),
      Response.json({ deleted: true })
    ]
    const fetcher = vi.fn(async () => responses.shift() ?? Response.json({})) as unknown as typeof fetch

    expect(await createPersonalAgentSkill(fetcher, 'csrf', { name: skill.name, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: false })).toEqual(skill)
    expect(await listPersonalAgentSkills(fetcher, 'csrf')).toEqual([skill])
    expect(
      await updatePersonalAgentSkill(fetcher, 'csrf', skill.id, {
        expectedVersionId: skill.versionId,
        skillMarkdown: skill.skillMarkdown,
        isAgentDiscoverable: true
      })
    ).toMatchObject({ versionId: '00000000-0000-4000-8000-000000000013' })
    expect(await removePersonalAgentSkill(fetcher, 'csrf', skill.id, skill.versionId)).toBeUndefined()
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/_api/agents/personal-skills',
      expect.objectContaining({
        body: JSON.stringify({ name: skill.name, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: false })
      })
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/_api/agents/personal-skills/${skill.id}`,
      expect.objectContaining({
        body: JSON.stringify({ expectedVersionId: skill.versionId, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: true })
      })
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      `/_api/agents/personal-skills/${skill.id}`,
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'same-origin',
        body: JSON.stringify({ expectedVersionId: skill.versionId })
      })
    )
  })
  it('stores cross-conversation skill preferences by stable skill identity', async () => {
    const skillId = '00000000-0000-4000-8000-000000000020'
    const fetchMock = vi.fn(async () => Response.json({ skillIds: [skillId] }))
    const fetcher = fetchMock as unknown as typeof fetch

    expect(await updateAgentSkillPreferences(fetcher, 'csrf', { skillIds: [skillId] })).toEqual([skillId])
    expect(fetcher).toHaveBeenCalledWith(
      '/_api/agents/skill-preferences',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        body: expect.any(String)
      })
    )
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { skillIds: string[]; transportRequestId: string }
    expect(request.skillIds).toEqual([skillId])
    expect(request.transportRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('sends explicitly invoked skill versions with one message', async () => {
    const versionId = '00000000-0000-4000-8000-000000000021'
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          run: {
            id: '00000000-0000-4000-8000-000000000022',
            sessionId: '00000000-0000-4000-8000-000000000023',
            status: 'queued',
            attempt: 0,
            eventSequence: 1,
            canCancel: true,
            createdAt: '2026-08-17T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            errorCode: null,
            errorMessage: null
          },
          replayed: false
        },
        { status: 202 }
      )
    ) as unknown as typeof fetch
    const input = {
      clientRequestId: '00000000-0000-4000-8000-000000000024',
      expectedSessionVersion: 1,
      profileResolutionToken: 'token',
      content: 'Use my process',
      invokedSkillVersionIds: [versionId]
    }
    await submitAgentMessage(fetcher, 'csrf', '00000000-0000-4000-8000-000000000023', input)
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/messages'), expect.objectContaining({ body: JSON.stringify(input) }))
  })

  it('creates a goal only through the dedicated typed endpoint', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000023'
    const goalId = '00000000-0000-4000-8000-000000000025'
    const now = '2026-08-17T00:00:00.000Z'
    const goal = {
      id: goalId,
      sessionId,
      objective: 'Finish the incident review.',
      status: 'active',
      version: 1,
      currentRunId: '00000000-0000-4000-8000-000000000022',
      continuationCount: 0,
      maxContinuations: 3,
      consumedTokens: 0,
      maxTokens: 48_000,
      consumedToolCalls: 0,
      maxToolCalls: 96,
      startedAt: now,
      deadlineAt: '2026-08-17T01:00:00.000Z',
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      completion: null
    }
    const run = {
      id: goal.currentRunId,
      sessionId,
      status: 'queued',
      attempt: 0,
      eventSequence: 2,
      canCancel: true,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    }
    const fetcher = vi.fn(async () => Response.json({ goal, run, replayed: false }, { status: 202 })) as unknown as typeof fetch
    const input = {
      goalId,
      clientRequestId: '00000000-0000-4000-8000-000000000026',
      expectedSessionVersion: 1,
      profileResolutionToken: 'token',
      objective: goal.objective
    }

    expect(await createAgentGoal(fetcher, 'csrf', sessionId, input)).toEqual({ goal, run, replayed: false })
    expect(fetcher).toHaveBeenCalledWith(`/_api/agents/sessions/${sessionId}/goals`, expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }))
  })

  it('accepts partial runs with typed task progress and recovery-required proposals', async () => {
    const now = '2026-08-17T00:00:00.000Z'
    const sessionId = '00000000-0000-4000-8000-000000000041'
    const runId = '00000000-0000-4000-8000-000000000042'
    const task = {
      id: '00000000-0000-4000-8000-000000000043',
      runId,
      kind: 'fact_check',
      title: 'Verify deployment date',
      question: 'Which date is supported?',
      sourceScope: ['operations/deployments'],
      requiredEvidenceCount: 2,
      status: 'completed',
      subagentRunId: '00000000-0000-4000-8000-000000000044',
      attempt: 1,
      outcome: 'partial',
      evidenceCount: 1,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      completedAt: now
    }
    const proposal = {
      id: '00000000-0000-4000-8000-000000000045',
      sourceKind: 'agent',
      actionName: 'pages.preparePatch',
      risk: 'proposal',
      status: 'recovery_required',
      summary: 'Manual recovery is required',
      target: null,
      pageLink: null,
      baseSourceRevision: null,
      authoritySha256: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      patchSha256: null,
      resultCanonicalSha256: null,
      diffSha256: null,
      diff: null,
      expiresAt: now,
      approval: null
    }
    const thread = {
      session: {
        id: sessionId,
        title: 'Deployment',
        retention: 'saved',
        folderId: null,
        status: 'active',
        executionMode: 'agent',
        version: 1,
        providerProfileId: null,
        profileResolutionToken: 'token',
        skills: [],
        currentRun: {
          id: runId,
          sessionId,
          status: 'partial',
          attempt: 1,
          eventSequence: 8,
          canCancel: false,
          createdAt: now,
          startedAt: now,
          completedAt: now,
          errorCode: null,
          errorMessage: null
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        expiresAt: null
      },
      messages: [],
      tools: [],
      tasks: [task],
      goal: null,
      proposals: [proposal],
      artifacts: [],
      historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
      suggestions: []
    }
    const fetcher = vi.fn(async () => Response.json(thread)) as unknown as typeof fetch
    expect(await getAgentThread(fetcher, 'csrf', sessionId)).toMatchObject({
      tasks: [task],
      proposals: [proposal],
      historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
    })
  })
  it('sends approved destructive and denied decisions with the exact shared request fields', async () => {
    const proposalId = '00000000-0000-4000-8000-000000000041'
    const approvalId = '00000000-0000-4000-8000-000000000042'
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) =>
      Response.json({
        proposalId,
        approvalId,
        status: JSON.parse(String(init?.body)).decision,
        decidedAt: '2026-08-30T00:00:00.000Z'
      })
    ) as unknown as typeof fetch
    const approved: DecideAgentApprovalRequest = {
      decision: 'approved',
      confirmationPath: '/docs/obsolete'
    }
    const denied: DecideAgentApprovalRequest = {
      decision: 'denied',
      decisionNote: 'Keep this page.'
    }

    await decideAgentProposal(fetcher, 'csrf-token', proposalId, approvalId, approved)
    await decideAgentProposal(fetcher, 'csrf-token', proposalId, approvalId, denied)

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/_api/agents/proposals/${proposalId}/approvals/${approvalId}/decision`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', confirmationPath: '/docs/obsolete' })
      })
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/_api/agents/proposals/${proposalId}/approvals/${approvalId}/decision`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'denied', decisionNote: 'Keep this page.' })
      })
    )
  })

  it('patches session title and retention through the session endpoint', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000088'
    const threadResponse = {
      session: {
        id: sessionId,
        title: 'Renamed topic',
        retention: 'saved',
        folderId: null,
        status: 'active',
        executionMode: 'agent',
        version: 3,
        providerProfileId: null,
        profileResolutionToken: 'token',
        skills: [],
        currentRun: null,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        lastActivityAt: '2026-08-30T00:00:00.000Z',
        expiresAt: null
      },
      messages: [],
      proposals: [],
      tools: [],
      tasks: [],
      artifacts: [],
      goal: null,
      historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
      suggestions: []
    }
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(threadResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const updated = await updateAgentSession(fetcher, 'csrf-token', sessionId, {
      expectedSessionVersion: 2,
      title: 'Renamed topic',
      retention: 'saved'
    })
    expect(updated.session.title).toBe('Renamed topic')
    expect(fetcher).toHaveBeenCalledWith(
      `/_api/agents/sessions/${sessionId}`,
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'x-wiki-csrf': 'csrf-token', accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ expectedSessionVersion: 2, title: 'Renamed topic', retention: 'saved' })
      })
    )
  })

  it('renders Markdown with raw HTML and active URL schemes disabled', () => {
    const rendered = renderSafeMarkdown('[safe](https://wiki.example.test/page) <img src=x onerror=alert(1)> [bad](javascript:alert(1))')
    expect(rendered).toContain('https://wiki.example.test/page')
    expect(rendered).toContain('noopener noreferrer')
    expect(rendered).not.toMatch(/<img|href="javascript:|onerror="/i)
  })
})

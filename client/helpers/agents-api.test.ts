import { describe, expect, it, vi } from 'vitest'
import { createAgentGoal, createAgentMemory, createAgentThread, createPersonalAgentSkill, deleteAgentSession, getAgentMemories, getAgentThread, listAgentProfiles, listPersonalAgentSkills, removePersonalAgentSkill, resetAgentHistory, submitAgentMessage, updateAgentSkillPreferences, updatePersonalAgentSkill } from './agents-api.ts'
import { renderSafeMarkdown } from './safe-markdown.ts'

describe('agents client boundary', () => {
  it('rejects malformed thread responses instead of rendering unvalidated provider data', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ session: { id: 'not-a-uuid' }, messages: '<script>' }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(createAgentThread(fetcher, 'csrf', { retention: 'saved', providerProfileId: null })).rejects.toThrow()
  })

  it('sends mutating requests with same-origin credentials and the session CSRF token', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await deleteAgentSession(fetcher, 'csrf-token', '00000000-0000-4000-8000-000000000001')
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/sessions/00000000-0000-4000-8000-000000000001', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': 'csrf-token' } }))
  })

  it('resets all history through the CSRF-protected collection endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await resetAgentHistory(fetcher, 'csrf-token')
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/sessions', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': 'csrf-token' } }))
  })

  it('validates and writes bounded personal memory through owner-scoped endpoints', async () => {
    const entry = { id: '00000000-0000-4000-8000-000000000031', target: 'user', content: 'Prefers concise answers.', version: 1, createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z' }
    const responses = [
      Response.json({ user: { entries: [entry], characters: 24, limit: 1_375 }, agent: { entries: [], characters: 0, limit: 2_200 } }),
      Response.json({ changed: true, message: 'Saved', target: 'user', entries: [entry.content], characters: 24, limit: 1_375 }, { status: 201 })
    ]
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch

    await expect(getAgentMemories(fetcher, 'csrf')).resolves.toMatchObject({ user: { entries: [entry] } })
    await expect(createAgentMemory(fetcher, 'csrf', { target: 'user', content: entry.content })).resolves.toMatchObject({ changed: true, target: 'user' })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/_api/agents/memories', expect.objectContaining({ method: 'POST', body: JSON.stringify({ target: 'user', content: entry.content }) }))
  })

  it('turns an empty 403 response into an actionable chat error', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch
    await expect(submitAgentMessage(fetcher, 'csrf', '00000000-0000-4000-8000-000000000001', {
      clientRequestId: '00000000-0000-4000-8000-000000000002',
      expectedSessionVersion: 1,
      profileResolutionToken: 'token',
      content: 'Create a page'
    })).rejects.toThrow('Refresh the page')
  })

  it('accepts the mutable provider selection contract without internal version fields', async () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'OpenAI',
      transport: 'openai-responses',
      model: 'gpt-test',
      utilityModel: null,
      destinationHost: 'api.example.test',
      capabilities: { streaming: true, toolCalling: 'native', parallelToolCalls: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 },
      capabilityRevision: 'cap-1',
      policyVersion: 2,
      isGlobalDefault: true
    }
    const fetcher = vi.fn(async () => Response.json({ profiles: [profile] })) as unknown as typeof fetch
    await expect(listAgentProfiles(fetcher, 'csrf')).resolves.toEqual([profile])
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

    await expect(createPersonalAgentSkill(fetcher, 'csrf', { name: skill.name, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: false })).resolves.toEqual(skill)
    await expect(listPersonalAgentSkills(fetcher, 'csrf')).resolves.toEqual([skill])
    await expect(updatePersonalAgentSkill(fetcher, 'csrf', skill.id, { expectedVersionId: skill.versionId, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: true })).resolves.toMatchObject({ versionId: '00000000-0000-4000-8000-000000000013' })
    await expect(removePersonalAgentSkill(fetcher, 'csrf', skill.id, skill.versionId)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenNthCalledWith(1, '/_api/agents/personal-skills', expect.objectContaining({
      body: JSON.stringify({ name: skill.name, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: false })
    }))
    expect(fetcher).toHaveBeenNthCalledWith(3, `/_api/agents/personal-skills/${skill.id}`, expect.objectContaining({
      body: JSON.stringify({ expectedVersionId: skill.versionId, skillMarkdown: skill.skillMarkdown, isAgentDiscoverable: true })
    }))
    expect(fetcher).toHaveBeenNthCalledWith(4, `/_api/agents/personal-skills/${skill.id}`, expect.objectContaining({
      method: 'DELETE',
      credentials: 'same-origin',
      body: JSON.stringify({ expectedVersionId: skill.versionId })
    }))
  })
  it('stores cross-conversation skill preferences by stable skill identity', async () => {
    const skillId = '00000000-0000-4000-8000-000000000020'
    const fetchMock = vi.fn(async () => Response.json({ skillIds: [skillId] }))
    const fetcher = fetchMock as unknown as typeof fetch

    await expect(updateAgentSkillPreferences(fetcher, 'csrf', { skillIds: [skillId] })).resolves.toEqual([skillId])
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/skill-preferences', expect.objectContaining({
      method: 'PUT',
      credentials: 'same-origin',
      body: expect.any(String)
    }))
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { skillIds: string[]; transportRequestId: string }
    expect(request.skillIds).toEqual([skillId])
    expect(request.transportRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })


  it('sends explicitly invoked skill versions with one message', async () => {
    const versionId = '00000000-0000-4000-8000-000000000021'
    const fetcher = vi.fn(async () => Response.json({
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
    }, { status: 202 })) as unknown as typeof fetch
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

    await expect(createAgentGoal(fetcher, 'csrf', sessionId, input)).resolves.toEqual({ goal, run, replayed: false })
    expect(fetcher).toHaveBeenCalledWith(`/_api/agents/sessions/${sessionId}/goals`, expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }))
  })


  it('accepts partial runs with typed task progress and no child packet exposure', async () => {
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
        currentRun: { id: runId, sessionId, status: 'partial', attempt: 1, eventSequence: 8, canCancel: false, createdAt: now, startedAt: now, completedAt: now, errorCode: null, errorMessage: null },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        expiresAt: null
      },
      messages: [],
      tools: [],
      tasks: [task],
      goal: null,
      proposals: [],
      artifacts: [],
      suggestions: []
    }
    const fetcher = vi.fn(async () => Response.json(thread)) as unknown as typeof fetch

    await expect(getAgentThread(fetcher, 'csrf', sessionId)).resolves.toMatchObject({ tasks: [task] })
  })
  it('renders Markdown with raw HTML and active URL schemes disabled', () => {
    const rendered = renderSafeMarkdown('[safe](https://wiki.example.test/page) <img src=x onerror=alert(1)> [bad](javascript:alert(1))')
    expect(rendered).toContain('https://wiki.example.test/page')
    expect(rendered).toContain('noopener noreferrer')
    expect(rendered).not.toMatch(/<img|href="javascript:|onerror="/i)
  })
})

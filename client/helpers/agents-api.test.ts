import { describe, expect, it, vi } from 'vitest'
import { createAgentThread, deleteAgentSession, listAgentProfiles } from './agents-api.ts'
import { renderSafeMarkdown } from './safe-markdown.ts'

describe('agents client boundary', () => {
  it('rejects malformed thread responses instead of rendering unvalidated provider data', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ session: { id: 'not-a-uuid' }, messages: '<script>' }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(createAgentThread(fetcher, 'csrf', { retention: 'saved', executionMode: 'agent', providerProfileId: null })).rejects.toThrow()
  })

  it('sends mutating requests with same-origin credentials and the session CSRF token', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    await deleteAgentSession(fetcher, 'csrf-token', '00000000-0000-4000-8000-000000000001')
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/sessions/00000000-0000-4000-8000-000000000001', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', headers: { 'x-wiki-csrf': 'csrf-token' } }))
  })

  it('accepts the mutable provider selection contract without internal version fields', async () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'OpenAI',
      transport: 'openai-responses',
      model: 'gpt-test',
      destinationHost: 'api.example.test',
      executionModes: ['agent', 'generation-only'],
      capabilities: { streaming: true, functions: true, parallelFunctions: true, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 },
      capabilityRevision: 'cap-1',
      policyVersion: 2,
      isGlobalDefault: true
    }
    const fetcher = vi.fn(async () => Response.json({ profiles: [profile] })) as unknown as typeof fetch
    await expect(listAgentProfiles(fetcher, 'csrf')).resolves.toEqual([profile])
  })

  it('renders Markdown with raw HTML and active URL schemes disabled', () => {
    const rendered = renderSafeMarkdown('[safe](https://wiki.example.test/page) <img src=x onerror=alert(1)> [bad](javascript:alert(1))')
    expect(rendered).toContain('https://wiki.example.test/page')
    expect(rendered).toContain('noopener noreferrer')
    expect(rendered).not.toMatch(/<img|href="javascript:|onerror="/i)
  })
})

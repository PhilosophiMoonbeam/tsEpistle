import { describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_TRANSPORTS } from '../../shared/agents/contracts.ts'
import {
  AGENT_PROVIDER_PROTOCOL_OPTIONS,
  agentProviderProtocolDefaults,
  agentProviderProtocolOption,
  isAgentProviderTransport
} from './agent-provider-protocols.ts'

describe('agent provider protocol presentation', () => {
  it('covers every persisted transport once with an operator-facing label', () => {
    expect(AGENT_PROVIDER_PROTOCOL_OPTIONS.map(option => option.value)).toEqual(AGENT_PROVIDER_TRANSPORTS)
    expect(new Set(AGENT_PROVIDER_PROTOCOL_OPTIONS.map(option => option.title)).size).toBe(AGENT_PROVIDER_TRANSPORTS.length)
    expect(agentProviderProtocolOption('openai-chat').title).toBe('OpenAI-compatible Chat Completions')
    expect(agentProviderProtocolOption('legacy-completions').title).toContain('generation only')
  })

  it('distinguishes message-and-tool chat from text-only completions', () => {
    expect(agentProviderProtocolDefaults('openai-chat')).toMatchObject({
      baseUrl: '',
      authMode: 'bearer',
      streaming: true,
      functions: true,
      structuredOutput: 'tool-result',
      usage: 'stream',
      agentMode: true,
      generationMode: true
    })
    expect(agentProviderProtocolDefaults('legacy-completions')).toEqual({
      baseUrl: '',
      authMode: 'bearer',
      structuredOutput: 'prompt-only',
      usage: 'terminal',
      streaming: false,
      functions: false,
      parallelFunctions: false,
      cancellation: true,
      agentMode: false,
      generationMode: true
    })
  })

  it('applies vendor defaults only to native vendor protocols', () => {
    expect(agentProviderProtocolDefaults('openai-responses').baseUrl).toBe('https://api.openai.com/v1')
    expect(agentProviderProtocolDefaults('anthropic-messages')).toMatchObject({
      baseUrl: 'https://api.anthropic.com/v1',
      authMode: 'anthropic-api-key',
      structuredOutput: 'tool-result'
    })
    expect(agentProviderProtocolDefaults('openresponses').baseUrl).toBe('')
  })

  it('rejects unknown transport values before form state changes', () => {
    expect(isAgentProviderTransport('openresponses')).toBe(true)
    expect(isAgentProviderTransport('responses')).toBe(false)
    expect(isAgentProviderTransport(null)).toBe(false)
  })
})

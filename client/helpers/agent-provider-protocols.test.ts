import { describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_TRANSPORTS } from '../../shared/agents/contracts.ts'
import {
  AGENT_PROVIDER_PRICING_REVISION,
  AGENT_PROVIDER_PROTOCOL_OPTIONS,
  agentProviderCapabilityRevision,
  agentProviderProtocolDefaults,
  agentProviderProtocolExecutionModes,
  agentProviderProtocolOption,
  isAgentProviderTransport
} from './agent-provider-protocols.ts'

describe('agent provider protocol presentation', () => {
  it('covers every persisted transport once with an operator-facing label', () => {
    expect(AGENT_PROVIDER_PROTOCOL_OPTIONS.map(option => option.value)).toEqual(AGENT_PROVIDER_TRANSPORTS)
    expect(new Set(AGENT_PROVIDER_PROTOCOL_OPTIONS.map(option => option.title)).size).toBe(AGENT_PROVIDER_TRANSPORTS.length)
    expect(agentProviderProtocolOption('openai-chat').title).toBe('OpenAI-compatible Chat Completions')
    expect(agentProviderProtocolOption('legacy-completions').title).toBe('Legacy text Completions')
  })

  it('distinguishes native from prompt-emulated tool calling', () => {
    expect(agentProviderProtocolDefaults('openai-chat')).toMatchObject({
      baseUrl: '',
      authMode: 'bearer',
      streaming: true,
      toolCalling: 'native',
      parallelToolCalls: true,
      structuredOutput: 'tool-result',
      usage: 'stream',
    })
    expect(agentProviderProtocolDefaults('legacy-completions')).toEqual({
      baseUrl: '',
      authMode: 'bearer',
      structuredOutput: 'prompt-only',
      usage: 'terminal',
      streaming: false,
      toolCalling: 'prompt',
      parallelToolCalls: false,
      cancellation: true,
    })
  })

  it('enables parallel tools only for native tool-capable protocols', () => {
    for (const transport of ['openai-responses', 'openresponses', 'openai-chat', 'anthropic-messages'] as const) {
      expect(agentProviderProtocolDefaults(transport)).toMatchObject({ toolCalling: 'native', parallelToolCalls: true })
    }
    expect(agentProviderProtocolDefaults('legacy-completions')).toMatchObject({ toolCalling: 'prompt', parallelToolCalls: false })
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

  it('exposes every protocol through an action-capable execution mode', () => {
    expect(agentProviderProtocolExecutionModes('openai-responses')).toEqual(['agent'])
    expect(agentProviderProtocolExecutionModes('openai-chat')).toEqual(['agent'])
    expect(agentProviderProtocolExecutionModes('anthropic-messages')).toEqual(['agent'])
    expect(agentProviderProtocolExecutionModes('legacy-completions')).toEqual(['agent'])
    expect(agentProviderCapabilityRevision('openresponses')).toBe('wiki-protocol-capabilities-v2:openresponses')
    expect(AGENT_PROVIDER_PRICING_REVISION).toBe('unpriced-v1')
  })

  it('rejects unknown transport values before form state changes', () => {
    expect(isAgentProviderTransport('openresponses')).toBe(true)
    expect(isAgentProviderTransport('responses')).toBe(false)
    expect(isAgentProviderTransport(null)).toBe(false)
  })
})

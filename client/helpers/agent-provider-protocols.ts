import { AGENT_PROVIDER_TRANSPORTS, type AgentProviderTransport } from '../../shared/agents/contracts.ts'

export type AgentProviderAuthMode = 'bearer' | 'api-key-header' | 'anthropic-api-key' | 'google-api-key'
export type AgentProviderStructuredOutput = 'native-json-schema' | 'tool-result' | 'prompt-only'
export type AgentProviderUsageMode = 'stream' | 'terminal' | 'estimated'
export type AgentProviderToolCalling = 'native' | 'prompt'
export type AgentProviderExecutionMode = 'agent'

export const AGENT_PROVIDER_PRICING_REVISION = 'unpriced-v1'


export interface AgentProviderProtocolOption {
  readonly value: AgentProviderTransport
  readonly title: string
  readonly group: 'Responses APIs' | 'Compatibility APIs' | 'Native provider APIs'
  readonly startsGroup: boolean
  readonly description: string
  readonly endpoint: string
}

export interface AgentProviderProtocolDefaults {
  readonly baseUrl: string
  readonly authMode: AgentProviderAuthMode
  readonly structuredOutput: AgentProviderStructuredOutput
  readonly usage: AgentProviderUsageMode
  readonly streaming: boolean
  readonly toolCalling: AgentProviderToolCalling
  readonly parallelToolCalls: boolean
  readonly cancellation: boolean
}

export const AGENT_PROVIDER_PROTOCOL_OPTIONS = [
  {
    value: 'openai-responses',
    title: 'OpenAI Responses API',
    group: 'Responses APIs',
    startsGroup: true,
    description: "OpenAI's item-based POST /v1/responses API, with tools and semantic streaming.",
    endpoint: '/responses'
  },
  {
    value: 'openresponses',
    title: 'OpenResponses-compatible API',
    group: 'Responses APIs',
    startsGroup: false,
    description: 'Vendor-neutral POST /v1/responses contract with strict request, event, sequence, and terminal-marker validation.',
    endpoint: '/responses'
  },
  {
    value: 'openai-chat',
    title: 'OpenAI-compatible Chat Completions',
    group: 'Compatibility APIs',
    startsGroup: true,
    description: 'Message-based POST /v1/chat/completions API with native or prompt-emulated tool calling verified during conformance.',
    endpoint: '/chat/completions'
  },
  {
    value: 'legacy-completions',
    title: 'Legacy text Completions',
    group: 'Compatibility APIs',
    startsGroup: false,
    description: 'Prompt-in/text-out POST /v1/completions API with strict prompt-emulated, single-action tool turns.',
    endpoint: '/completions'
  },
  {
    value: 'anthropic-messages',
    title: 'Anthropic Messages API',
    group: 'Native provider APIs',
    startsGroup: true,
    description: 'Native Anthropic POST /v1/messages API with message content blocks and tools.',
    endpoint: '/messages'
  },
  {
    value: 'gemini-api',
    title: 'Google Gemini API',
    group: 'Native provider APIs',
    startsGroup: false,
    description: 'Native Gemini generateContent API with streaming, function calls, parallel actions, and opaque thought-signature continuation.',
    endpoint: '/models/{model}:generateContent'
  }
] as const satisfies readonly AgentProviderProtocolOption[]

const optionByTransport = new Map<AgentProviderTransport, AgentProviderProtocolOption>(
  AGENT_PROVIDER_PROTOCOL_OPTIONS.map(option => [option.value, option])
)

const defaultsByTransport: Readonly<Record<AgentProviderTransport, AgentProviderProtocolDefaults>> = {
  'openai-responses': {
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'bearer',
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    cancellation: true
  },
  openresponses: {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    cancellation: true
  },
  'openai-chat': {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'tool-result',
    usage: 'stream',
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    cancellation: true
  },
  'legacy-completions': {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'prompt-only',
    usage: 'terminal',
    streaming: false,
    toolCalling: 'prompt',
    parallelToolCalls: false,
    cancellation: true
  },
  'anthropic-messages': {
    baseUrl: 'https://api.anthropic.com/v1',
    authMode: 'anthropic-api-key',
    structuredOutput: 'tool-result',
    usage: 'stream',
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    cancellation: true
  },
  'gemini-api': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authMode: 'google-api-key',
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: true,
    cancellation: true
  }
}
const executionModesByTransport: Readonly<Record<AgentProviderTransport, readonly AgentProviderExecutionMode[]>> = {
  'openai-responses': ['agent'],
  openresponses: ['agent'],
  'openai-chat': ['agent'],
  'legacy-completions': ['agent'],
  'anthropic-messages': ['agent'],
  'gemini-api': ['agent']
}

export const agentProviderProtocolExecutionModes = (transport: AgentProviderTransport): readonly AgentProviderExecutionMode[] => executionModesByTransport[transport]

export const agentProviderCapabilityRevision = (transport: AgentProviderTransport): string => `wiki-protocol-capabilities-v2:${transport}`

export const agentProviderProtocolOption = (transport: AgentProviderTransport): AgentProviderProtocolOption => {
  const option = optionByTransport.get(transport)
  if (!option) throw new Error(`Unsupported agent provider protocol: ${transport}`)
  return option
}

export const agentProviderProtocolDefaults = (transport: AgentProviderTransport): AgentProviderProtocolDefaults => defaultsByTransport[transport]

export const isAgentProviderTransport = (value: unknown): value is AgentProviderTransport => typeof value === 'string' && (AGENT_PROVIDER_TRANSPORTS as readonly string[]).includes(value)

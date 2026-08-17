import { AGENT_PROVIDER_TRANSPORTS, type AgentProviderTransport } from '../../shared/agents/contracts.ts'

export type AgentProviderAuthMode = 'bearer' | 'api-key-header' | 'anthropic-api-key'
export type AgentProviderStructuredOutput = 'native-json-schema' | 'tool-result' | 'prompt-only'
export type AgentProviderUsageMode = 'stream' | 'terminal' | 'estimated'
export type AgentProviderExecutionMode = 'agent' | 'generation-only'

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
  readonly functions: boolean
  readonly parallelFunctions: boolean
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
    description: 'Message-based POST /v1/chat/completions API. Tools and streaming must pass conformance for agent mode.',
    endpoint: '/chat/completions'
  },
  {
    value: 'legacy-completions',
    title: 'Legacy text Completions — generation only',
    group: 'Compatibility APIs',
    startsGroup: false,
    description: 'Prompt-in/text-out POST /v1/completions API. No messages, streaming, or tools; generation-only runs.',
    endpoint: '/completions'
  },
  {
    value: 'anthropic-messages',
    title: 'Anthropic Messages API',
    group: 'Native provider APIs',
    startsGroup: true,
    description: 'Native Anthropic POST /v1/messages API with message content blocks and tools.',
    endpoint: '/messages'
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
    functions: true,
    parallelFunctions: true,
    cancellation: true
  },
  openresponses: {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'native-json-schema',
    usage: 'stream',
    streaming: true,
    functions: true,
    parallelFunctions: true,
    cancellation: true
  },
  'openai-chat': {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'tool-result',
    usage: 'stream',
    streaming: true,
    functions: true,
    parallelFunctions: true,
    cancellation: true
  },
  'legacy-completions': {
    baseUrl: '',
    authMode: 'bearer',
    structuredOutput: 'prompt-only',
    usage: 'terminal',
    streaming: false,
    functions: false,
    parallelFunctions: false,
    cancellation: true
  },
  'anthropic-messages': {
    baseUrl: 'https://api.anthropic.com/v1',
    authMode: 'anthropic-api-key',
    structuredOutput: 'tool-result',
    usage: 'stream',
    streaming: true,
    functions: true,
    parallelFunctions: true,
    cancellation: true
  }
}
const executionModesByTransport: Readonly<Record<AgentProviderTransport, readonly AgentProviderExecutionMode[]>> = {
  'openai-responses': ['agent', 'generation-only'],
  openresponses: ['agent', 'generation-only'],
  'openai-chat': ['agent', 'generation-only'],
  'legacy-completions': ['generation-only'],
  'anthropic-messages': ['agent', 'generation-only']
}

export const agentProviderProtocolExecutionModes = (transport: AgentProviderTransport): readonly AgentProviderExecutionMode[] => executionModesByTransport[transport]

export const agentProviderCapabilityRevision = (transport: AgentProviderTransport): string => `wiki-protocol-capabilities-v1:${transport}`

export const agentProviderProtocolOption = (transport: AgentProviderTransport): AgentProviderProtocolOption => {
  const option = optionByTransport.get(transport)
  if (!option) throw new Error(`Unsupported agent provider protocol: ${transport}`)
  return option
}

export const agentProviderProtocolDefaults = (transport: AgentProviderTransport): AgentProviderProtocolDefaults => defaultsByTransport[transport]

export const isAgentProviderTransport = (value: unknown): value is AgentProviderTransport => typeof value === 'string' && (AGENT_PROVIDER_TRANSPORTS as readonly string[]).includes(value)

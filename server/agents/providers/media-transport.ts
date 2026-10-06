import type { AgentMediaProviderConfig } from '../../../shared/agents/media-providers.ts'
import type { AgentProviderFetch } from './factory.ts'

export interface AgentMediaInput {
  bytes: Uint8Array
  mimeType: string
  displayName?: string
}

export interface AgentMediaUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface AgentMediaDispatchHooks {
  maxInputTokens?: number
  maxOutputTokens?: number
  beforeUpload?: () => Promise<void>
  beforeDispatch?: (usage: AgentMediaUsage) => Promise<void>
  onDispatch?: () => void
}

export interface AgentMediaGenerationInput extends AgentMediaDispatchHooks {
  prompt?: string
  files?: readonly AgentMediaInput[]
}

export interface AgentMediaResult {
  text: string
  usage: AgentMediaUsage
  files: { bytes: Buffer; mimeType: string }[]
  usageSource: 'reported' | 'estimated'
  outputTokensByModality?: { text: number; video: number }
}

/** One immutable configured operation, with no implicit fallback or paid retries. */
export interface AgentMediaTransport {
  generate(input: AgentMediaGenerationInput, signal?: AbortSignal): Promise<AgentMediaResult>
}

export interface AgentMediaTransportOptions {
  config: AgentMediaProviderConfig
  apiKey: string
  /** Factory-owned DNS-pinned, official endpoint and exact model guard. */
  fetch: AgentProviderFetch
}

import type { AxAIFeatures } from '@ax-llm/ax'
import { agentProviderMediaInputMimeTypes, normalizeAgentMediaMimeType, type AgentMediaInputs } from '../../../shared/agents/media-providers.ts'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../../shared/agents/media-limits.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentProviderTransportKind } from './registry.ts'

const MODALITIES: Readonly<Record<string, keyof AgentMediaInputs>> = {
  'image/png': 'images',
  'image/jpeg': 'images',
  'image/webp': 'images',
  'application/pdf': 'documents',
  'audio/webm': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/mp4': 'audio',
  'audio/mpeg': 'audio',
  'audio/aac': 'audio',
  'audio/flac': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video'
}
const NO_MIME_TYPES: readonly string[] = []
// Provider input declarations are immutable, request-local prepared configuration.
const mimeTypesByInputs = new WeakMap<Readonly<AgentMediaInputs>, Partial<Record<AgentProviderTransportKind, readonly string[]>>>()
const inputMimeTypesFor = (inputs: Readonly<AgentMediaInputs> | undefined, transportKind: AgentProviderTransportKind): readonly string[] => {
  if (!inputs) return NO_MIME_TYPES
  let byTransport = mimeTypesByInputs.get(inputs)
  if (!byTransport) {
    byTransport = {}
    mimeTypesByInputs.set(inputs, byTransport)
  }
  return (byTransport[transportKind] ??= agentProviderMediaInputMimeTypes(transportKind, inputs))
}

export const agentMediaInputModality = (mimeType: string): keyof AgentMediaInputs | undefined => MODALITIES[normalizeAgentMediaMimeType(mimeType)]

/** Explicit model opt-ins and implemented wire formats are authority; native metadata supplies positive limits only. */
export const assertAgentMediaInput = (
  mimeType: string,
  byteLength: number,
  inputs: Readonly<AgentMediaInputs> | undefined,
  transportKind: AgentProviderTransportKind,
  media?: AxAIFeatures['media']
): void => {
  const canonicalType = normalizeAgentMediaMimeType(mimeType)
  const modality = MODALITIES[canonicalType]
  if (!modality || !inputs?.[modality] || !inputMimeTypesFor(inputs, transportKind).includes(canonicalType))
    throw new AgentRepositoryError('AGENT_MEDIA_INPUT_UNSUPPORTED', 'This model is not enabled to consume the attachment format.', 409)
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > (modality === 'documents' ? AGENT_PDF_ATTACHMENT_MAX_BYTES : AGENT_ATTACHMENT_MAX_BYTES)
  )
    throw new AgentRepositoryError('AGENT_MEDIA_INPUT_LIMIT', 'The attachment exceeds the model input limit.', 413)
  const hint = modality === 'images' ? media?.images : modality === 'audio' ? media?.audio : modality === 'documents' ? media?.files : undefined
  if (hint && 'maxSize' in hint && typeof hint.maxSize === 'number' && hint.maxSize > 0 && byteLength > hint.maxSize)
    throw new AgentRepositoryError('AGENT_MEDIA_INPUT_LIMIT', 'The attachment exceeds the model input limit.', 413)
}

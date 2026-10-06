import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../shared/agents/media-limits.ts'
import type { AgentMediaCapabilities } from '../../shared/agents/contracts.ts'
import { normalizeAgentMediaMimeType } from '../../shared/agents/media-providers.ts'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
  'audio/flac'
] as const
const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const
export type AgentGenerationTool = 'image' | 'video' | 'music'

export const agentToolAcceptsImages = (capabilities: AgentMediaCapabilities | undefined, tool: 'image' | 'video'): boolean => {
  if (!capabilities || !(tool === 'image' ? capabilities.imageGeneration : capabilities.videoGeneration)) return false
  if (capabilities.mediaToolInputs !== undefined) return capabilities.mediaToolInputs[tool]?.images === true
  return tool === 'image' && capabilities.attachments
}

/** Exact live formats are authoritative; old sessions never acquire audio/video input. */
export const agentAttachmentMimeTypes = (
  capabilities: AgentMediaCapabilities | undefined,
  generationTools?: readonly AgentGenerationTool[]
): readonly string[] => {
  if (!capabilities) return []
  const inputs = capabilities.inputModalities
  const llmTypes = capabilities.inputMimeTypes ?? [
    ...(inputs?.images || (!inputs && capabilities.attachments) ? IMAGE_TYPES : []),
    ...(inputs?.documents || (!inputs && capabilities.attachments) ? ['application/pdf'] : [])
  ]
  const references = (generationTools === undefined ? (['image', 'video'] as const) : generationTools).some(
    tool => tool !== 'music' && agentToolAcceptsImages(capabilities, tool)
  )
  return references ? [...new Set([...llmTypes, ...IMAGE_TYPES])] : llmTypes
}

export interface AgentMediaSubmission {
  readonly attachmentIds: readonly string[]
  readonly generationTools?: readonly AgentGenerationTool[]
}
/** Returns a validation localization key for the caller to translate, or null for an accepted file. */
export const validateAgentAttachment = (
  file: Pick<File, 'type' | 'size'>,
  capabilities?: AgentMediaCapabilities,
  generationTools?: readonly AgentGenerationTool[]
): string | null => {
  const mimeType = normalizeAgentMediaMimeType(file.type)
  const supported: readonly string[] = capabilities ? [...IMAGE_TYPES, 'application/pdf', ...AUDIO_TYPES, ...VIDEO_TYPES] : [...IMAGE_TYPES, 'application/pdf']
  if (!supported.includes(mimeType)) return 'common:agentComposerMedia.unsupportedFileType'
  if (capabilities && !agentAttachmentMimeTypes(capabilities, generationTools).includes(mimeType)) return 'common:agentComposerMedia.inputTypeDisabled'
  if (file.size === 0) return 'common:agentComposerMedia.emptyFile'
  if (file.size > (file.type === 'application/pdf' ? AGENT_PDF_ATTACHMENT_MAX_BYTES : AGENT_ATTACHMENT_MAX_BYTES))
    return file.type === 'application/pdf'
      ? 'common:agentComposerMedia.pdfTooLarge'
      : file.type.startsWith('image/')
        ? 'common:agentComposerMedia.imageTooLarge'
        : 'common:agentComposerMedia.mediaTooLarge'
  return null
}

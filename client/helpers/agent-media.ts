import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../shared/agents/media-limits.ts'

export interface AgentMediaSubmission {
  readonly attachmentIds: readonly string[]
  readonly generationTools?: readonly ('image' | 'video' | 'music')[]
}
/** Returns a validation localization key for the caller to translate, or null for an accepted file. */
export const validateAgentAttachment = (file: Pick<File, 'type' | 'size'>): string | null => {
  if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.type)) return 'common:agentComposerMedia.unsupportedFileType'
  if (file.size === 0) return 'common:agentComposerMedia.emptyFile'
  if (file.size > (file.type === 'application/pdf' ? AGENT_PDF_ATTACHMENT_MAX_BYTES : AGENT_ATTACHMENT_MAX_BYTES))
    return file.type === 'application/pdf' ? 'common:agentComposerMedia.pdfTooLarge' : 'common:agentComposerMedia.imageTooLarge'
  return null
}

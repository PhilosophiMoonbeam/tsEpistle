import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_PDF_ATTACHMENT_MAX_BYTES } from '../../shared/agents/media-limits.ts'

export interface AgentMediaSubmission {
  readonly attachmentIds: readonly string[]
  readonly responseMode: 'text' | 'image'
}
export const validateAgentAttachment = (file: Pick<File, 'type' | 'size'>): string | null => {
  if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.type)) return 'Choose a PNG, JPEG, WebP image, or PDF.'
  if (file.size === 0) return 'Empty files cannot be attached.'
  if (file.size > (file.type === 'application/pdf' ? AGENT_PDF_ATTACHMENT_MAX_BYTES : AGENT_ATTACHMENT_MAX_BYTES))
    return file.type === 'application/pdf' ? 'Each PDF must be 100 MB or smaller.' : 'Each image must be 10 MB or smaller.'
  return null
}

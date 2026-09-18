export interface AgentMediaSubmission {
  readonly attachmentIds: readonly string[]
  readonly responseMode: 'text' | 'image'
}
export const validateAgentAttachment = (file: Pick<File, 'type' | 'size'>): string | null => {
  if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.type)) return 'Choose a PNG, JPEG, WebP image, or PDF.'
  if (file.size === 0) return 'Empty files cannot be attached.'
  if (file.size > 10 * 1024 * 1024) return 'Each attachment must be 10 MB or smaller.'
  return null
}

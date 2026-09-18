/** Original private attachments; prepared provider copies have their own smaller ceiling. */
export const AGENT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const AGENT_PDF_ATTACHMENT_MAX_BYTES = 250 * 1024 * 1024

/** Generated outputs stay private and use the same owner/global storage budgets. */
export const AGENT_GENERATED_VIDEO_MAX_BYTES = 64 * 1024 * 1024
export const AGENT_GENERATED_AUDIO_MAX_BYTES = 16 * 1024 * 1024

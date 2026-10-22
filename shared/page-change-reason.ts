import { z } from 'zod'

export const MAX_PAGE_CHANGE_REASON_LENGTH = 200

// Validate the submitted value before trimming: line breaks, control characters
// and directional formatting must not disappear during normalization.
export const PageChangeReasonSchema = z
  .string()
  .max(MAX_PAGE_CHANGE_REASON_LENGTH)
  .refine(value => !/[\p{Cc}\p{Bidi_Control}\u2028\u2029\u206a-\u206f]/u.test(value), 'Change reason must be a single line without controls or bidi formatting')
  .transform(value => value.trim() || undefined)
  .optional()

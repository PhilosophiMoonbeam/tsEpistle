import { z } from 'zod'

const lockVersion = z.string().max(19).regex(/^(0|[1-9]\d*)$/).refine(value => /^(0|[1-9]\d*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n)
export const PageEditLockInputSchema = z.strictObject({
  isEditLocked: z.boolean(),
  expectedLockVersion: lockVersion,
  reason: z.string().trim().min(1).max(500).refine(value => {
    for (const character of value) {
      const point = character.charCodeAt(0)
      if (point <= 0x1f || point >= 0x7f && point <= 0x9f || point >= 0x202a && point <= 0x202e || point >= 0x2066 && point <= 0x2069) return false
    }
    return true
  }, 'Use a single-line reason without control or direction-formatting characters.')
})
export const PageEditLockViewSchema = z.strictObject({
  isEditLocked: z.boolean(),
  lockVersion,
  canManage: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  updatedBy: z.number().int().positive().nullable(),
  reason: z.string().nullable()
})
export type PageEditLockInput = z.infer<typeof PageEditLockInputSchema>
export type PageEditLockView = z.infer<typeof PageEditLockViewSchema>

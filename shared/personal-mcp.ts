import { z } from 'zod'

export const PersonalMcpAccessSchema = z.enum(['read-only', 'read-write'])
export type PersonalMcpAccess = z.infer<typeof PersonalMcpAccessSchema>
export const IssuePersonalMcpKeyInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(255),
  expirationDays: z.number().int().min(1).max(90),
  access: PersonalMcpAccessSchema
})
export type IssuePersonalMcpKeyInput = z.infer<typeof IssuePersonalMcpKeyInputSchema>
export const PersonalMcpKeySchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string(),
  access: PersonalMcpAccessSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  isRevoked: z.boolean()
})
export type PersonalMcpKey = z.infer<typeof PersonalMcpKeySchema>
export const PersonalMcpKeysResponseSchema = z.strictObject({
  enabled: z.boolean(), endpoint: z.string(), canIssue: z.boolean(), keys: z.array(PersonalMcpKeySchema)
})
export const IssuePersonalMcpKeyResponseSchema = z.strictObject({ key: z.string().min(1), item: PersonalMcpKeySchema })
export const RevokePersonalMcpKeyResponseSchema = z.strictObject({ id: z.number().int().positive(), isRevoked: z.literal(true) })

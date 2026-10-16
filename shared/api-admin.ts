import { z } from 'zod'
import { PersonalMcpKeySchema } from './personal-mcp.ts'

export const ApiKeyGrantSchema = z.object({
  groupId: z.number().int().positive().nullable()
})
export type ApiKeyGrant = z.infer<typeof ApiKeyGrantSchema>
export const ApiGroupPageRuleSchema = z.object({
  match: z.string(),
  path: z.string(),
  deny: z.boolean(),
  roles: z.array(z.string()),
  locales: z.array(z.string())
})
export type ApiGroupPageRule = z.infer<typeof ApiGroupPageRuleSchema>
export const ApiAssignableGroupSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  permissions: z.array(z.string()),
  pageRuleCount: z.number().int().nonnegative(),
  pageRules: z.array(ApiGroupPageRuleSchema)
})
export type ApiAssignableGroup = z.infer<typeof ApiAssignableGroupSchema>
export const ApiConnectionInfoSchema = z.object({
  groups: z.array(ApiAssignableGroupSchema)
})
export type ApiConnectionInfo = z.infer<typeof ApiConnectionInfoSchema>
export const AdminPersonalMcpKeySchema = PersonalMcpKeySchema.extend({
  owner: z.strictObject({
    id: z.number().int().positive(),
    name: z.string(),
    email: z.string(),
    isActive: z.boolean()
  }).nullable()
})
export type AdminPersonalMcpKey = z.infer<typeof AdminPersonalMcpKeySchema>
export const API_KEY_EXPIRATIONS = ['30d', '90d', '180d', '1y', '3y'] as const
export const apiKeyState = (key: { isRevoked: boolean; expiration: string }, now = Date.now()): 'active' | 'expired' | 'revoked' | 'unknown' => {
  if (key.isRevoked) return 'revoked'
  const expiry = Date.parse(key.expiration)
  if (!Number.isFinite(expiry)) return 'unknown'
  return expiry <= now ? 'expired' : 'active'
}

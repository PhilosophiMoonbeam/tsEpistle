import { z } from 'zod'

export const ExternalMcpServerInputSchema = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  endpointUrl: z.string().max(2_048).url(),
  status: z.enum(['enabled', 'disabled']),
  authMode: z.enum(['none', 'bearer']),
  // Omitted keeps this endpoint's credential; authMode none removes it. References are never accepted.
  secretValue: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[\x21-\x7e]+$/u)
    .nullable()
    .optional()
})
export const CreateAdminExternalMcpServerSchema = ExternalMcpServerInputSchema.extend({
  groupIds: z.array(z.number().int().positive()).max(1_000)
}).strict()
export const ExternalMcpGroupPolicyInputSchema = z.strictObject({ allowPersonalEndpoints: z.boolean() })
export const ExternalMcpGrantsInputSchema = z.strictObject({ groupIds: z.array(z.number().int().positive()).max(1_000) })
export type ExternalMcpServerInput = z.infer<typeof ExternalMcpServerInputSchema>
export type CreateAdminExternalMcpServerInput = z.infer<typeof CreateAdminExternalMcpServerSchema>

export interface ExternalMcpServerView {
  readonly id: string
  readonly displayName: string
  readonly endpointUrl: string
  readonly destinationHost: string
  readonly namespace: string
  readonly scope: 'admin' | 'personal'
  readonly ownerId: number | null
  readonly status: 'enabled' | 'disabled'
  readonly revision: number
  readonly authMode: 'none' | 'bearer'
  readonly secretConfigured: boolean
  readonly groupIds: readonly number[]
  readonly trust: 'untrusted'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ExternalMcpGroupPolicyView {
  readonly groupId: number
  readonly allowPersonalEndpoints: boolean
  /** Zero means no saved policy; personal endpoints are denied by default. */
  readonly revision: number
}

/** Client catalogs/results are attributed external data, never Wiki evidence or authority. */
export interface ExternalMcpAttribution {
  readonly serverId: string
  readonly namespace: string
  readonly displayName: string
  readonly destinationHost: string
  readonly trust: 'untrusted'
  readonly authority: 'external'
}

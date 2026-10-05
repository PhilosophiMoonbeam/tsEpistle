import { z } from 'zod'
import { type RoutingComplexity, type RoutingTaskClass, RoutingTaskClassSchema } from './routing.ts'

export interface SpecialistHistoryMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface SpecialistProviderBinding {
  readonly profileId: string
  readonly profileVersionId: string
  readonly model: string
  readonly transportKind: string
  readonly capabilityRevision: string
  readonly profilePolicyVersion: number
  readonly ownerAuthVersion: number
}

/** Host-only independent context. Never include history or engine snapshots in a browser DTO. */
export interface SpecialistContext {
  readonly id: string
  readonly ownerId: number
  readonly rootSessionId: string
  readonly binding: SpecialistProviderBinding
  readonly scopeSha256: string
  readonly taskClass: RoutingTaskClass
  readonly complexity: RoutingComplexity
  readonly version: number
  readonly turnCount: number
  readonly history: readonly SpecialistHistoryMessage[]
  readonly state: Readonly<Record<string, unknown>> | null
  readonly lastReport: string
  readonly authoritySha256: string | null
  readonly expiresAt: string
  readonly lastUsedAt: string
}

export const SpecialistInvocationViewSchema = z.strictObject({
  id: z.uuid(),
  contextId: z.uuid(),
  rootRunId: z.uuid(),
  profileVersionId: z.uuid(),
  model: z.string().min(1).max(256),
  taskClass: RoutingTaskClassSchema,
  status: z.enum(['running', 'completed', 'failed']),
  reused: z.boolean(),
  contextVersion: z.number().int().positive(),
  report: z.string().nullable(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
    .nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable()
})
export type SpecialistInvocationView = z.infer<typeof SpecialistInvocationViewSchema>

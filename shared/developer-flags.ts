import { z } from 'zod'

export const DeveloperFlagKeySchema = z.enum(['ldapdebug', 'sqllog'])
export type DeveloperFlagKey = z.infer<typeof DeveloperFlagKeySchema>

export const DeveloperFlagsSchema = z
  .object({
    ldapdebug: z.boolean(),
    sqllog: z.boolean()
  })
  .strict()
export type DeveloperFlags = z.infer<typeof DeveloperFlagsSchema>

export const DeveloperFlagEventSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.iso.datetime(),
    actorId: z.number().int().positive().nullable(),
    apiKeyId: z.number().int().positive().nullable(),
    reason: z.string().min(3).max(1000),
    changed: z.array(DeveloperFlagKeySchema).min(1).max(2),
    policy: DeveloperFlagsSchema
  })
  .strict()
export type DeveloperFlagEvent = z.infer<typeof DeveloperFlagEventSchema>

export const DeveloperFlagsRevisionSchema = z.string().uuid().or(z.literal(''))

export const DeveloperFlagsWorkspaceSchema = z
  .object({
    observedAt: z.iso.datetime(),
    fingerprint: z.string().length(64),
    revision: DeveloperFlagsRevisionSchema,
    saved: z.object({
      policy: DeveloperFlagsSchema,
      source: z.enum(['reviewed-administration', 'database', 'effective-configuration']),
      state: z.enum(['active', 'staged'])
    }),
    deployment: z.object({
      defaults: DeveloperFlagsSchema,
      description: z.string()
    }),
    process: z.object({
      instanceId: z.string(),
      observedAt: z.iso.datetime(),
      policy: DeveloperFlagsSchema,
      sqlQueryLoggingApplied: z.boolean(),
      settingsCurrent: z.boolean(),
      state: z.enum(['applied', 'needs-attention'])
    }),
    history: z.array(DeveloperFlagEventSchema).max(50)
  })
  .strict()
export type DeveloperFlagsWorkspace = z.infer<typeof DeveloperFlagsWorkspaceSchema>

export const DeveloperFlagsSaveInputSchema = z
  .object({
    policy: DeveloperFlagsSchema,
    fingerprint: z.string().length(64),
    reason: z.string().trim().min(3).max(1000)
  })
  .strict()
export type DeveloperFlagsSaveInput = z.infer<typeof DeveloperFlagsSaveInputSchema>

export const DeveloperFlagsSaveResultSchema = z
  .object({
    revision: z.string().uuid(),
    policy: DeveloperFlagsSchema,
    application: z.literal('needs-attention')
  })
  .strict()
export type DeveloperFlagsSaveResult = z.infer<typeof DeveloperFlagsSaveResultSchema>

export const DeveloperFlagsApplyInputSchema = z
  .object({
    fingerprint: z.string().length(64)
  })
  .strict()
export type DeveloperFlagsApplyInput = z.infer<typeof DeveloperFlagsApplyInputSchema>

export const DeveloperFlagsApplyResultSchema = z
  .object({
    revision: DeveloperFlagsRevisionSchema,
    applied: z.boolean(),
    published: z.boolean()
  })
  .strict()
export type DeveloperFlagsApplyResult = z.infer<typeof DeveloperFlagsApplyResultSchema>

export const developerFlagChangedFields = (previous: DeveloperFlags, next: DeveloperFlags): DeveloperFlagKey[] =>
  (Object.keys(previous) as DeveloperFlagKey[]).filter(key => previous[key] !== next[key])

import { z } from 'zod'

export const LOGGING_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const
export const LOGGING_FORMATS = ['default', 'json'] as const

export const LoggingLevelSchema = z.enum(LOGGING_LEVELS)
export const LoggingFormatSchema = z.enum(LOGGING_FORMATS)
export const LoggingScalarSchema = z.union([z.string().max(65536), z.number().finite(), z.boolean()])
export const isValidSentryDsn = (value: string): boolean => {
  if (value.trim().length === 0 || value !== value.trim()) return false
  try {
    const parsed = new URL(value)
    const project = parsed.pathname.split('/').filter(Boolean).at(-1)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username.length > 0 &&
      parsed.hostname.length > 0 &&
      typeof project === 'string' &&
      /^\d+$/.test(project)
    )
  } catch {
    return false
  }
}

export const LoggingSecretChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .min(1)
        .max(65536)
        .refine(value => value.trim().length > 0, 'Enter a nonblank replacement value.')
    })
    .strict()
])

export const LoggingDestinationDraftSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    isEnabled: z.boolean(),
    level: LoggingLevelSchema,
    config: z.record(z.string().min(1).max(120), LoggingScalarSchema),
    secrets: z.record(z.string().min(1).max(120), LoggingSecretChangeSchema)
  })
  .strict()

export const LoggingConsoleDraftSchema = z
  .object({
    level: LoggingLevelSchema,
    format: LoggingFormatSchema
  })
  .strict()

export const LoggingWorkspaceDraftSchema = z
  .object({
    fingerprint: z.string().length(64),
    reason: z.string().trim().min(3).max(1000),
    console: LoggingConsoleDraftSchema,
    destinations: z.array(LoggingDestinationDraftSchema).min(1).max(100)
  })
  .strict()

export const LoggingApplySchema = z.object({ fingerprint: z.string().length(64) }).strict()

export type LoggingSecretChange = z.infer<typeof LoggingSecretChangeSchema>
export type LoggingDestinationDraft = z.infer<typeof LoggingDestinationDraftSchema>
export type LoggingConsoleDraft = z.infer<typeof LoggingConsoleDraftSchema>
export type LoggingWorkspaceDraft = z.infer<typeof LoggingWorkspaceDraftSchema>

export interface LoggingDestinationField {
  key: string
  title: string
  hint: string | null
  type: 'string' | 'number' | 'boolean'
  enum: readonly string[] | null
  sensitive: boolean
  required: boolean
}

export interface LoggingDestination {
  key: string
  title: string
  description: string | null
  logo: string | null
  website: string | null
  availability: 'available' | 'unavailable'
  availabilityReason: string | null
  isEnabled: boolean
  level: z.infer<typeof LoggingLevelSchema>
  fields: LoggingDestinationField[]
  config: Record<string, z.infer<typeof LoggingScalarSchema>>
  secrets: Record<string, boolean>
  runtime: {
    state: 'active' | 'inactive' | 'unavailable' | 'failed' | 'unapplied'
    message: string | null
  }
}

export interface LoggingRuntimeSnapshot {
  settingsCurrent: boolean
  state: 'ready' | 'partially-applied' | 'unapplied'
  observedAt: string | null
  console: {
    level: z.infer<typeof LoggingLevelSchema> | null
    format: z.infer<typeof LoggingFormatSchema> | null
  }
  message: string | null
}

export interface LoggingConfigurationEvent {
  id: string
  createdAt: string
  actorId: number | null
  apiKeyId: number | null
  reason: string
  changed: string[]
}

export interface LoggingWorkspace {
  fingerprint: string
  revision: string
  observedAt: string
  console: LoggingConsoleDraft
  destinations: LoggingDestination[]
  runtime: LoggingRuntimeSnapshot
  history: LoggingConfigurationEvent[]
  liveTrail: {
    enabled: true
    maxLines: number
    maxBytes: number
    maxConnectionEvents: number
    message: string
  }
}

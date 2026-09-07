import { z } from 'zod'
import { LocaleCodeSchema } from './locale-policy.ts'

export const UtilityOperationKindSchema = z.enum([
  'auth-certificates',
  'auth-guest-reset',
  'cache-pages',
  'cache-temporary-uploads',
  'content-rebuild-tree',
  'content-rerender',
  'content-migrate-locale',
  'content-purge-history',
  'export',
  // Historical receipts remain readable; this retired kind is rejected by the operation API.
  'import-v1-users',
  'import-v1-content',
  'telemetry-save',
  'telemetry-reset-client-id'
])
export type UtilityOperationKind = z.infer<typeof UtilityOperationKindSchema>

export const UtilityHistoryRetentionPeriods = ['P1D', 'P1M', 'P3M', 'P6M', 'P1Y', 'P2Y', 'P3Y', 'P5Y'] as const
export const UtilityHistoryRetentionPeriodSchema = z.enum(UtilityHistoryRetentionPeriods)
export type UtilityHistoryRetentionPeriod = z.infer<typeof UtilityHistoryRetentionPeriodSchema>

const UtilityImportTargetSchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).max(1000).nullable()
})

export const UtilityOperationSchema = z.object({
  id: z.uuid(),
  kind: UtilityOperationKindSchema,
  state: z.enum(['running', 'succeeded', 'failed', 'uncertain']),
  phase: z.enum(['queued', 'reviewing', 'working', 'complete', 'interrupted']),
  actorId: z.number().int().positive().nullable(),
  apiKeyId: z.number().int().positive().nullable(),
  reason: z.string().min(3).max(1000),
  createdAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedByOperationId: z.uuid().nullable(),
  progress: z.number().int().min(0).max(100).nullable(),
  summary: z.string().min(1).max(1000),
  result: z
    .object({
      processed: z.number().int().nonnegative().optional(),
      succeeded: z.number().int().nonnegative().optional(),
      failed: z.number().int().nonnegative().optional(),
      skipped: z.number().int().nonnegative().optional()
    })
    .strict()
    .nullable()
})
export type UtilityOperation = z.infer<typeof UtilityOperationSchema>

export const UtilitiesWorkspaceSchema = z.object({
  observedAt: z.iso.datetime(),
  fingerprint: z.string().length(64),
  telemetry: z.object({ enabled: z.boolean(), clientId: z.string().nullable() }),
  importTargets: z.object({
    disk: UtilityImportTargetSchema,
    git: UtilityImportTargetSchema
  }),
  locales: z.array(z.object({ code: LocaleCodeSchema, name: z.string().trim().min(1).max(160) }).strict()).max(300),
  operations: z.array(UtilityOperationSchema).max(50)
})
export type UtilitiesWorkspace = z.infer<typeof UtilitiesWorkspaceSchema>

export const utilityOperationTitle = (kind: UtilityOperationKind): string =>
  ({
    'auth-certificates': 'Regenerate authentication certificates',
    'auth-guest-reset': 'Reset guest access',
    'cache-pages': 'Flush pages and assets cache',
    'cache-temporary-uploads': 'Delete temporary uploads',
    'content-rebuild-tree': 'Rebuild page tree',
    'content-rerender': 'Rerender all pages',
    'content-migrate-locale': 'Migrate pages to another locale',
    'content-purge-history': 'Purge page history',
    export: 'Export workspace data',
    'import-v1-users': 'Legacy user import (retired)',
    'import-v1-content': 'Import Wiki.js 1.x content',
    'telemetry-save': 'Update telemetry preference',
    'telemetry-reset-client-id': 'Reset telemetry client ID'
  })[kind]

export const utilityOperationConfirmation = (kind: UtilityOperationKind): string =>
  ({
    'auth-certificates': 'REGENERATE CERTIFICATES',
    'auth-guest-reset': 'RESET GUEST',
    'cache-pages': 'FLUSH CACHE',
    'cache-temporary-uploads': 'DELETE TEMPORARY UPLOADS',
    'content-rebuild-tree': 'REBUILD PAGE TREE',
    'content-rerender': 'RERENDER ALL PAGES',
    'content-migrate-locale': 'MIGRATE PAGES',
    'content-purge-history': 'PURGE HISTORY',
    export: 'START EXPORT',
    'import-v1-users': 'IMPORT USERS',
    'import-v1-content': 'IMPORT CONTENT',
    'telemetry-save': 'SAVE TELEMETRY',
    'telemetry-reset-client-id': 'RESET CLIENT ID'
  })[kind]

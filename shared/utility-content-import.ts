import { z } from 'zod'

export const STORAGE_GIT_CONTENT_REVIEW_MAX_BYTES = 2 * 1024 * 1024
const reviewEncoder = new TextEncoder()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1).max(4096)
const pageId = z.number().int().positive().safe()
export const StorageImportScopeSchema = z.object({
  actorId: pageId.nullable(),
  apiKeyId: pageId.nullable(),
  targetKey: z.enum(['disk', 'git']),
  configurationRevision: z.string().min(1).max(256)
}).strict().refine(scope => (scope.actorId === null) !== (scope.apiKeyId === null), 'One current administrator identity is required.')
export type StorageImportScope = z.infer<typeof StorageImportScopeSchema>

const StorageImportMappingSchema = z.object({
  sourcePath: identity,
  sourceSha256: digest,
  locale: z.string().min(1).max(35),
  path: identity,
  existingPageId: pageId.nullable(),
  expectedSourceRevision: z.string().min(1).max(256).nullable()
}).strict().refine(mapping => (mapping.existingPageId === null) === (mapping.expectedSourceRevision === null), 'An existing page requires its reviewed revision.')
export type StorageImportMapping = z.infer<typeof StorageImportMappingSchema>

const StorageGitContentOwnerSchema = z.object({
  kind: z.enum(['page', 'asset']),
  id: pageId,
  path: identity,
  locale: z.string().max(35),
  revision: z.string().min(1).max(256),
  sha256: digest,
  sourceSha256: digest.optional(),
  sourceOwned: z.boolean()
}).strict()
export const StorageGitContentChoiceSchema = z.object({
  sourcePath: identity,
  sourceSha256: digest,
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable().optional(),
  sourceAvailable: z.boolean().optional(),
  action: z.enum(['include', 'retain', 'remap', 'remove']),
  owner: StorageGitContentOwnerSchema.nullable(),
  destinationPath: identity.optional()
}).strict()
export type StorageGitContentChoice = z.infer<typeof StorageGitContentChoiceSchema>
export const StorageGitContentPolicySchema = z.object({
  sourceKey: digest,
  choices: z.array(StorageGitContentChoiceSchema).max(10000)
}).strict()
export const StorageGitContentEntrySchema = z.object({
  sourcePath: identity,
  sourceSha256: digest,
  sourceKey: digest,
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable().optional(),
  hidden: z.boolean(),
  previous: z.boolean(),
  sourceAvailable: z.boolean(),
  automatic: z.boolean(),
  kind: z.enum(['page', 'asset']),
  owner: StorageGitContentOwnerSchema.nullable(),
  diagnostics: z.array(z.string().max(4096)).max(100)
}).strict()
export type StorageGitContentEntry = z.infer<typeof StorageGitContentEntrySchema>
export const StorageImportReviewSchema = z.object({
  scope: StorageImportScopeSchema,
  snapshot: digest,
  mappings: z.array(StorageImportMappingSchema).max(10000),
  gitContent: z.array(StorageGitContentChoiceSchema).max(10000).optional(),
}).strict().refine(review => review.gitContent === undefined ||
  reviewEncoder.encode(JSON.stringify(review.gitContent)).byteLength <= STORAGE_GIT_CONTENT_REVIEW_MAX_BYTES,
  'Exact Git content choices exceed 2 MiB. Review fewer sources in this batch; unselected canonical records are retained. No settings or content have changed.')
export type StorageImportReview = z.infer<typeof StorageImportReviewSchema>

export const StorageImportPreviewSchema = z.object({
  locales: z.array(z.string().min(1).max(35)).max(10000),
  scope: StorageImportScopeSchema,
  snapshot: digest,
  entries: z.array(z.object({
    sourcePath: identity,
    kind: z.enum(['file', 'directory']),
    sourceSha256: digest.nullable()
  }).strict()).max(10000),
  pages: z.array(z.object({
    sourcePath: identity,
    sourceSha256: digest,
    contentType: z.string().min(1).max(64),
    locale: z.string().max(35),
    path: z.string().max(4096),
    format: z.enum(['okf_valid', 'okf_invalid', 'legacy_wiki', 'legacy_v1', 'plain_markdown']),
    owned: z.boolean(),
    existingPageId: pageId.nullable(),
    expectedSourceRevision: z.string().min(1).max(256).nullable(),
    diagnostics: z.array(z.string().max(4096)).max(100)
  }).strict()).max(10000),
  destinations: z.array(z.object({
    id: pageId,
    locale: z.string().min(1).max(35),
    path: identity,
    sourceRevision: z.string().min(1).max(256)
  }).strict()).max(10000),
  gitContent: z.array(StorageGitContentEntrySchema).max(10000).optional(),
}).strict()
export type StorageImportPreview = z.infer<typeof StorageImportPreviewSchema>

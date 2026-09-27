import { z } from 'zod'

export const DELETED_PAGE_RECOVERY_PAGE_SIZE = 50
export const DELETED_PAGE_RECOVERY_MAX_PAGE_SIZE = 100

const PositiveIntegerSchema = z.number().int().positive().safe()
const SourceRevisionSchema = z.string().regex(/^[1-9][0-9]*$/)
const PagePathSchema = z.string().min(1).max(1024)
const LocaleCodeSchema = z.string().min(1).max(35)
const TagsSchema = z.array(z.string().min(1)).max(10_000)

export const DeletedPageRecoveryListRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(DELETED_PAGE_RECOVERY_MAX_PAGE_SIZE).default(DELETED_PAGE_RECOVERY_PAGE_SIZE),
  beforeVersionId: PositiveIntegerSchema.optional()
})
export type DeletedPageRecoveryListRequest = z.input<typeof DeletedPageRecoveryListRequestSchema>

export const DeletedPageRecoveryRestoreRequestSchema = z.strictObject({
  destination: z.strictObject({
    path: PagePathSchema,
    localeCode: LocaleCodeSchema
  }),
  ownerId: PositiveIntegerSchema.optional()
})
export type DeletedPageRecoveryRestoreRequest = z.infer<typeof DeletedPageRecoveryRestoreRequestSchema>

export const DeletedPageRecoveryItemSchema = z.strictObject({
  pageId: PositiveIntegerSchema,
  deletionVersionId: PositiveIntegerSchema,
  deletionRevision: SourceRevisionSchema.nullable(),
  title: z.string(),
  description: z.string(),
  path: PagePathSchema,
  localeCode: LocaleCodeSchema,
  contentType: z.string().min(1),
  editorKey: z.string().min(1),
  visibility: z.enum(['public', 'private']),
  ownerId: PositiveIntegerSchema.nullable(),
  tags: TagsSchema,
  deletedAt: z.iso.datetime().nullable(),
  restoreMode: z.enum(['preserve', 'quarantine']),
  protection: z.strictObject({
    isProtected: z.boolean(),
    version: PositiveIntegerSchema.nullable()
  })
})
export type DeletedPageRecoveryItem = z.infer<typeof DeletedPageRecoveryItemSchema>

export const DeletedPageRecoveryListSchema = z.strictObject({
  items: z.array(DeletedPageRecoveryItemSchema).max(DELETED_PAGE_RECOVERY_MAX_PAGE_SIZE),
  hasMore: z.boolean(),
  nextBeforeVersionId: PositiveIntegerSchema.nullable()
})
export type DeletedPageRecoveryList = z.infer<typeof DeletedPageRecoveryListSchema>

export const DeletedPageRecoveryInspectSchema = DeletedPageRecoveryItemSchema.extend({
  sourceRevision: SourceRevisionSchema,
  content: z.string(),
  ownerResolutionRequired: z.boolean()
})
export type DeletedPageRecoveryInspect = z.infer<typeof DeletedPageRecoveryInspectSchema>

export const DeletedPageRecoveryResultSchema = z.strictObject({
  pageId: PositiveIntegerSchema,
  sourceRevision: SourceRevisionSchema,
  path: PagePathSchema,
  localeCode: LocaleCodeSchema,
  quarantined: z.boolean()
})
export type DeletedPageRecoveryResult = z.infer<typeof DeletedPageRecoveryResultSchema>

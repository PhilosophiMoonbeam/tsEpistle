import { z } from 'zod'

export const PAGE_CREATION_OWNER_HEADER = 'X-Page-Creation-Owner'
export const PAGE_CREATION_INVENTORY_LIMIT = 50
export const PageCreationRequestIdSchema = z.uuid().transform(value => value.toLowerCase())
export const PageCreationOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('live-note'),
    noteId: z.uuid().transform(value => value.toLowerCase()),
    revision: z.number().int().nonnegative().safe()
  }),
  z.strictObject({
    kind: z.literal('agent-answer'),
    sessionId: z.uuid().transform(value => value.toLowerCase()),
    messageId: z.uuid().transform(value => value.toLowerCase())
  })
])
export const PageCreationFieldsSchema = z
  .strictObject({
    creationRequestId: PageCreationRequestIdSchema.optional(),
    creationOrigin: PageCreationOriginSchema.optional()
  })
  .refine(value => value.creationOrigin === undefined || value.creationRequestId !== undefined, {
    message: 'A creation origin requires a creation request ID.'
  })
export const PageCreationDestinationSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  sourceRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .max(64),
  path: z.string().min(1),
  locale: z.string().min(1),
  title: z.string(),
  visibility: z.enum(['public', 'private']),
  isPublished: z.boolean()
})
export const PageCreationCommittedSchema = z.strictObject({
  status: z.literal('committed'),
  requestId: PageCreationRequestIdSchema,
  sourceRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .max(64),
  createdAt: z.iso.datetime(),
  creationOrigin: PageCreationOriginSchema.nullable(),
  destination: PageCreationDestinationSchema.nullable()
})
export const PageCreationStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown'), requestId: PageCreationRequestIdSchema }),
  PageCreationCommittedSchema
])
export const PageCreationInventorySchema = z.strictObject({
  items: z.array(PageCreationCommittedSchema).max(PAGE_CREATION_INVENTORY_LIMIT),
  hasMore: z.boolean(),
  nextCursor: PageCreationRequestIdSchema.nullable()
})
export type PageCreationOrigin = z.infer<typeof PageCreationOriginSchema>
export type PageCreationFields = z.infer<typeof PageCreationFieldsSchema>
export type PageCreationCommitted = z.infer<typeof PageCreationCommittedSchema>
export type PageCreationStatus = z.infer<typeof PageCreationStatusSchema>
export type PageCreationInventory = z.infer<typeof PageCreationInventorySchema>

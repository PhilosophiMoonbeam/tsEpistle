import { z } from 'zod'

export const PAGE_LINKS_SCHEMA_VERSION = 1 as const
export const PAGE_LINKS_PAGE_SIZE = 20
export const PAGE_LINKS_CURSOR_MAX_LENGTH = 512

const PageIdSchema = z.number().finite().int().positive().safe()
const SourceRevisionSchema = z.string().regex(/^[1-9][0-9]*$/)

export const PageLinksDirectionSchema = z.enum(['incoming', 'outgoing'])
export type PageLinksDirection = z.infer<typeof PageLinksDirectionSchema>

export const PageLinksRequestSchema = z.strictObject({
  pageId: PageIdSchema,
  direction: PageLinksDirectionSchema,
  cursor: z.string().min(1).max(PAGE_LINKS_CURSOR_MAX_LENGTH).optional()
})
export type PageLinksRequest = z.infer<typeof PageLinksRequestSchema>

export const PageLinkItemSchema = z.strictObject({
  id: PageIdSchema,
  locale: z.string().min(1).max(35),
  path: z.string().min(1).max(2048),
  title: z.string().max(1024)
})
export type PageLinkItem = z.infer<typeof PageLinkItemSchema>

export const PageLinksReadyResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(PAGE_LINKS_SCHEMA_VERSION),
    state: z.literal('ready'),
    pageId: PageIdSchema,
    direction: PageLinksDirectionSchema,
    sourceRevision: SourceRevisionSchema,
    items: z.array(PageLinkItemSchema).max(PAGE_LINKS_PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(PAGE_LINKS_CURSOR_MAX_LENGTH).nullable()
  })
  .superRefine((value, context) => {
    if (value.hasMore !== (value.nextCursor !== null)) {
      context.addIssue({ code: 'custom', path: ['nextCursor'], message: 'Cursor state must match hasMore.' })
    }
    if (value.hasMore && value.items.length !== PAGE_LINKS_PAGE_SIZE) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'A page with more results must be full.' })
    }
  })
export type PageLinksReadyResponse = z.infer<typeof PageLinksReadyResponseSchema>

export const PageLinksRefreshResponseSchema = z.strictObject({
  schemaVersion: z.literal(PAGE_LINKS_SCHEMA_VERSION),
  state: z.literal('refresh'),
  pageId: PageIdSchema,
  direction: PageLinksDirectionSchema,
  sourceRevision: SourceRevisionSchema
})
export type PageLinksRefreshResponse = z.infer<typeof PageLinksRefreshResponseSchema>

export const PageLinksResponseSchema = z.discriminatedUnion('state', [PageLinksReadyResponseSchema, PageLinksRefreshResponseSchema])
export type PageLinksResponse = z.infer<typeof PageLinksResponseSchema>

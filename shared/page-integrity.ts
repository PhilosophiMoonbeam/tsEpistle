import { z } from 'zod'
import { isPageEditorKey, type PageEditorKey } from './page-editors.ts'

export const PAGE_INTEGRITY_BATCH_MAX = 25
export const PAGE_INTEGRITY_BATCH_DEFAULT = 15
export const PAGE_INTEGRITY_MAX_CHECKS_PER_PAGE = 11
export const PAGE_INTEGRITY_MAX_VISIBLE_CHECKS = 150

export const PAGE_INTEGRITY_CHECK_CODES = [
  'SOURCE_REVISION_INVALID',
  'SOURCE_EDITOR_COMPATIBILITY',
  'MARKDOWN_OKF_VALIDITY',
  'RENDERED_SOURCE_REVISION',
  'PAGE_IDENTITY',
  'PROJECTION_RENDER_RECEIPT',
  'PROJECTION_LINKS_RECEIPT',
  'PROJECTION_SEARCH_RECEIPT',
  'PROJECTION_KNOWLEDGE_RECEIPT',
  'SEARCH_INDEX_STATE',
  'PROTECTED_ASSET_REFERENCE',
  'PAGE_INSPECTION_ERROR'
] as const

export type PageIntegrityCheckCode = (typeof PAGE_INTEGRITY_CHECK_CODES)[number]

const pageIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const watermarkSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sourceRevisionSchema = z.string().min(1).max(40).regex(/^[1-9][0-9]*$/).nullable()

export const PageIntegrityScanRequestSchema = z.strictObject({
  cursor: watermarkSchema.nullable().default(null),
  upperWatermark: watermarkSchema.nullable().default(null),
  limit: z.number().int().min(1).max(PAGE_INTEGRITY_BATCH_MAX).default(PAGE_INTEGRITY_BATCH_DEFAULT)
}).superRefine((request, context) => {
  if (request.upperWatermark === null && request.cursor !== null) {
    context.addIssue({ code: 'custom', path: ['upperWatermark'], message: 'A cursor requires an upper watermark.' })
  }
  if (request.upperWatermark !== null && request.cursor !== null && request.cursor > request.upperWatermark) {
    context.addIssue({ code: 'custom', path: ['cursor'], message: 'The cursor cannot exceed the upper watermark.' })
  }
})
export type PageIntegrityScanRequest = z.infer<typeof PageIntegrityScanRequestSchema>

export const PageIntegrityCheckSchema = z.strictObject({
  pageId: pageIdSchema,
  checkCode: z.enum(PAGE_INTEGRITY_CHECK_CODES),
  outcome: z.enum(['healthy', 'finding', 'changed', 'skipped', 'error']),
  severity: z.enum(['info', 'warning', 'error']),
  sourceRevision: sourceRevisionSchema,
  remediation: z.string().min(1).max(240)
})
export type PageIntegrityCheck = z.infer<typeof PageIntegrityCheckSchema>

export const PageIntegrityLocalStorageSchema = z.strictObject({
  key: z.enum(['disk', 'git']),
  enabled: z.boolean(),
  status: z.enum(['operational', 'warning', 'error', 'paused', 'pending', 'unknown']),
  lastAttempt: z.iso.datetime().nullable(),
  hasRecordedOperation: z.boolean()
})

export const PageIntegrityScanResponseSchema = z.strictObject({
  upperWatermark: watermarkSchema,
  nextCursor: watermarkSchema.nullable(),
  state: z.enum(['running', 'complete', 'cancelled']),
  pagesScanned: z.number().int().min(0).max(PAGE_INTEGRITY_BATCH_MAX),
  checks: z.array(PageIntegrityCheckSchema).max(PAGE_INTEGRITY_BATCH_MAX * PAGE_INTEGRITY_MAX_CHECKS_PER_PAGE),
  localStorage: z.array(PageIntegrityLocalStorageSchema).max(2)
}).superRefine((response, context) => {
  if (response.state === 'running' && (response.nextCursor === null || response.pagesScanned === 0)) {
    context.addIssue({ code: 'custom', path: ['nextCursor'], message: 'A running scan must advance its cursor.' })
  }
  if (response.state === 'complete' && response.nextCursor !== null) {
    context.addIssue({ code: 'custom', path: ['nextCursor'], message: 'A completed scan has no next cursor.' })
  }
})
export type PageIntegrityScanResponse = z.infer<typeof PageIntegrityScanResponseSchema>

const editorContentTypes: Readonly<Record<PageEditorKey, readonly string[]>> = Object.freeze({
  markdown: ['markdown'],
  'visual-markdown': ['markdown'],
  ckeditor: ['html'],
  asciidoc: ['asciidoc'],
  code: []
})

export const pageEditorIsCompatible = (editorKey: unknown, contentType: unknown): boolean => {
  if (!isPageEditorKey(editorKey) || typeof contentType !== 'string' || contentType.length === 0) return false
  const acceptedTypes = editorContentTypes[editorKey]
  return acceptedTypes.length === 0 || acceptedTypes.includes(contentType)
}

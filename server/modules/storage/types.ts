import type { OkfMetadata } from '../../okf/format.ts'

export type StoragePageDocumentFormat = 'okf_valid' | 'okf_invalid' | 'legacy_wiki' | 'legacy_v1' | 'plain_markdown'

export interface StoragePageFields {
  title?: string
  description?: string
  isPublished?: boolean
  tags: string[]
}

export interface StoragePageDocumentInput {
  rawDocument: string | Uint8Array
  contentType: string
  locale: string
  pagePath: string
  importer: string
  now?: Date
}

export interface StoragePageDocument {
  format: StoragePageDocumentFormat
  body: string
  title?: string
  description?: string
  isPublished?: boolean
  tags: string[]
  fields: StoragePageFields
  okfMetadata: OkfMetadata | null
  diagnostics: readonly string[]
  sha256: string
}

export interface StoragePageProcessResult {
  relPath: string
  format?: StoragePageDocumentFormat
  sha256?: string
  ok: boolean
  document?: StoragePageDocument
  page?: unknown
  error?: string
}

export interface StorageImportResult extends StoragePageProcessResult {
  kind: 'page' | 'asset'
}

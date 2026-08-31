import { createHash } from 'node:crypto'
import * as yaml from 'js-yaml'
import {
  OKF_MAX_DOCUMENT_BYTES,
  importOkfLinks,
  parseOkfDocument,
  type OkfMetadata
} from '../../okf/format.ts'
import type {
  StoragePageDocument,
  StoragePageDocumentInput,
  StoragePageDocumentFormat,
  StoragePageFields
} from './types.ts'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
const LEGACY_V1 = /^\s*<!--\s*(?:TITLE|SUBTITLE):/iu
const TYPE_KEY = /^(?:[ \t]*)type[ \t]*:/mu


const sourceText = (source: string | Uint8Array): string => typeof source === 'string' ? source : Buffer.from(source).toString('utf8')

const sourceHash = (source: string | Uint8Array): string => createHash('sha256').update(source).digest('hex')

const diagnostic = (error: unknown): string => {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return code === undefined ? error.message : `${code}: ${error.message}`
  }
  return String(error)
}

const parseYaml = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = yaml.load(value, { schema: yaml.JSON_SCHEMA })
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

const tagsFrom = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(tag => tag.trim()).filter(Boolean)
  return []
}

const fieldsFrom = (metadata: Record<string, unknown> | null): StoragePageFields => ({
  ...(typeof metadata?.title === 'string' ? { title: metadata.title } : {}),
  ...(typeof metadata?.description === 'string' ? { description: metadata.description } : {}),
  ...(typeof metadata?.isPublished === 'boolean' ? { isPublished: metadata.isPublished } : {}),
  tags: tagsFrom(metadata?.tags)
})

const defaultMetadata = (fields: StoragePageFields, importer: string, now: Date): OkfMetadata => ({
  type: 'Reference',
  status: 'stable',
  ...(fields.title === undefined ? {} : { title: fields.title }),
  ...(fields.description === undefined || fields.description.trim().length === 0 ? {} : { description: fields.description }),
  tags: [...fields.tags],
  generated: { by: importer, at: now.toISOString() }
})

const result = (
  format: StoragePageDocumentFormat,
  source: string | Uint8Array,
  body: string,
  fields: StoragePageFields,
  okfMetadata: OkfMetadata | null,
  diagnostics: readonly string[]
): StoragePageDocument => ({
  format,
  body,
  ...fields,
  fields,
  okfMetadata,
  diagnostics,
  sha256: sourceHash(source)
})

/**
 * Classifies one bounded page source without consulting storage or enrichment.
 * The input source is retained only for hashing; the returned body is decoded text.
 */
export const classifyStoragePageDocument = (input: StoragePageDocumentInput): StoragePageDocument => {
  const source = input.rawDocument
  const text = sourceText(source)
  const now = input.now ?? new Date()
  const importer = input.importer.trim()
  if (importer.length === 0) throw new TypeError('Storage page importer identity must not be empty')
  const byteLength = typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : source.byteLength
  if (byteLength > OKF_MAX_DOCUMENT_BYTES) {
    return result(
      'okf_invalid',
      source,
      text,
      { tags: [] },
      null,
      [`OKF_DOCUMENT_TOO_LARGE: OKF document exceeds ${OKF_MAX_DOCUMENT_BYTES} bytes`]
    )
  }

  // A claimed OKF document is never allowed to silently degrade into a legacy page.
  // Check the bounded prefix before parsing so an oversized source is quarantined.
  const frontmatter = text.length <= OKF_MAX_DOCUMENT_BYTES ? FRONTMATTER.exec(text) : null
  const claimsOkf = frontmatter !== null
    ? (parseYaml(frontmatter[1] ?? '')?.type !== undefined || TYPE_KEY.test(frontmatter[1] ?? ''))
    : /^---\r?\n[\s\S]{0,65536}?\r?\n---/u.test(text.slice(0, 65_548)) && TYPE_KEY.test(text.slice(0, 65_548))

  if (claimsOkf) {
    try {
      const parsed = parseOkfDocument(text, now)
      const body = importOkfLinks(parsed.body, input.locale, input.pagePath)
      const fields: StoragePageFields = {
        ...(parsed.metadata.title === undefined ? {} : { title: parsed.metadata.title }),
        ...(parsed.metadata.description === undefined ? {} : { description: parsed.metadata.description }),
        tags: parsed.metadata.tags === undefined ? [] : [...parsed.metadata.tags]
      }
      return result('okf_valid', source, body, fields, parsed.metadata, [])
    } catch (error: unknown) {
      return result('okf_invalid', source, text, { tags: [] }, null, [diagnostic(error)])
    }
  }

  const legacyFrontmatter = FRONTMATTER.exec(text)
  if (legacyFrontmatter !== null) {
    const metadata = parseYaml(legacyFrontmatter[1] ?? '')
    if (metadata !== null) {
      const fields = fieldsFrom(metadata)
      const body = text.slice(legacyFrontmatter[0].length).replace(/^\r?\n/u, '').replaceAll('\r\n', '\n')
      return result('legacy_wiki', source, body, fields, defaultMetadata(fields, importer, now), [])
    }
  }

  if (LEGACY_V1.test(text)) {
    const titleMatch = /^\s*<!--\s*TITLE:\s*([\s\S]*?)\s*-->/iu.exec(text)
    const subtitleMatch = /^\s*(?:<!--\s*TITLE:[\s\S]*?-->\s*)?<!--\s*SUBTITLE:\s*([\s\S]*?)\s*-->/iu.exec(text)
    const fields: StoragePageFields = {
      ...(titleMatch?.[1] === undefined ? {} : { title: titleMatch[1].trim() }),
      ...(subtitleMatch?.[1] === undefined ? {} : { description: subtitleMatch[1].trim() }),
      tags: []
    }
    const body = text
      .replace(/^\s*<!--\s*TITLE:[\s\S]*?-->\s*/iu, '')
      .replace(/^<!--\s*SUBTITLE:[\s\S]*?-->\s*/iu, '')
      .replaceAll('\r\n', '\n')
    return result('legacy_v1', source, body, fields, defaultMetadata(fields, importer, now), [])
  }

  const fields: StoragePageFields = { tags: [] }
  return result('plain_markdown', source, text.replaceAll('\r\n', '\n'), fields, defaultMetadata(fields, importer, now), [])
}

export const parseStoragePageDocument = classifyStoragePageDocument

export default classifyStoragePageDocument

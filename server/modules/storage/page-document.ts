import { createHash } from 'node:crypto'
import * as yaml from 'js-yaml'
import {
  OKF_MAX_DOCUMENT_BYTES,
  exportOkfLinks,
  importOkfLinks,
  okfConceptId,
  okfFilePath,
  parseOkfDocument,
  renderOkfDocument,
  validateStoredOkfMetadata,
  type OkfMetadata,
  type OkfPageDocument
} from '../../okf/format.ts'
import pageHelper from '../../helpers/page.ts'
import type {
  StoragePageDocument,
  StoragePageDocumentInput,
  StoragePageDocumentFormat,
  StoragePageFields
} from './types.ts'

export interface StoragePageEncodingInput {
  readonly path: string
  readonly localeCode: string
  readonly title: string
  readonly description: string
  readonly contentType: string
  readonly content: string | Record<string, unknown>
  readonly sourceRevision: string | number | bigint
  readonly authorId: number
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
  readonly extra?: Record<string, unknown> | null
  readonly isPublished: boolean | number
  readonly editorKey: string
  readonly tags?: readonly (string | { readonly tag?: unknown })[]
}

const encodingTags = (tags: StoragePageEncodingInput['tags']): string[] =>
  (tags ?? []).flatMap(tag => {
    if (typeof tag === 'string') return tag.trim().length > 0 ? [tag.trim()] : []
    return typeof tag?.tag === 'string' && tag.tag.trim().length > 0 ? [tag.tag.trim()] : []
  })

const encodingDate = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new TypeError('Storage page dates must be valid ISO datetimes')
  return date.toISOString()
}

/**
 * Encode one DB-owned page for storage.
 *
 * Markdown is always emitted as canonical OKF. Existing valid metadata is
 * authoritative and is never passed through a mutation boundary, while the
 * bounded x-wiki extension carries the DB facts needed to round-trip the
 * page. Other content types retain the historical page metadata serializer.
 */
export const encodeStoragePageDocument = (
  page: StoragePageEncodingInput
): OkfPageDocument | string | Record<string, unknown> => {
  const tags = encodingTags(page.tags)
  if (page.contentType !== 'markdown') {
    return pageHelper.injectPageMetadata({
      title: page.title,
      description: page.description,
      isPublished: page.isPublished === true || page.isPublished === 1,
      updatedAt: page.updatedAt,
      tags: tags.map(tag => ({ tag })),
      editorKey: page.editorKey,
      createdAt: page.createdAt,
      contentType: page.contentType,
      content: page.content
    })
  }

  if (typeof page.content !== 'string') throw new TypeError('Markdown storage content must be a string')

  let stored: ReturnType<typeof validateStoredOkfMetadata> = null
  if (page.extra !== null && page.extra !== undefined && Object.hasOwn(page.extra, 'okf')) {
    stored = validateStoredOkfMetadata(page.extra.okf)
    if (stored === null) throw new TypeError('Storage page extra.okf must contain valid OKF metadata')
  }
  const metadata: OkfMetadata = {
    ...(stored?.metadata ?? { type: 'Reference', status: 'stable' }),
    title: page.title,
    ...(page.description.trim().length > 0 ? { description: page.description } : {}),
    tags,
    'x-wiki': {
      published: page.isPublished === true || page.isPublished === 1,
      editor: page.editorKey,
      source_revision: String(page.sourceRevision),
      created_at: encodingDate(page.createdAt),
      updated_at: encodingDate(page.updatedAt)
    }
  }
  const markdown = renderOkfDocument(metadata, exportOkfLinks(page.content))
  return {
    version: '0.2',
    conceptId: okfConceptId(page.localeCode, page.path),
    filePath: okfFilePath(page.localeCode, page.path),
    markdown,
    sha256: sourceHash(markdown),
    metadata,
    trust: validateStoredOkfMetadata(metadata)!.trust
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
const FRONTMATTER_OPENER = /^---\r?\n/u
const LEGACY_V1 = /^\s*<!--\s*(?:TITLE|SUBTITLE):/iu
const TYPE_KEY = /^(?:[ \t]*)type[ \t]*:/mu
const MAX_TREE_DEPTH = 20


const sourceText = (source: string | Uint8Array): string => typeof source === 'string' ? source : Buffer.from(source).toString('utf8')

const sourceHash = (source: string | Uint8Array): string => createHash('sha256').update(source).digest('hex')

const diagnostic = (error: unknown): string => {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return code === undefined ? error.message : `${code}: ${error.message}`
  }
  return String(error)
}

interface ParsedYaml {
  readonly metadata: Record<string, unknown> | null
  readonly error: unknown | null
}

const parseYaml = (value: string): ParsedYaml => {
  try {
    const parsed = yaml.load(value, {
      schema: yaml.JSON_SCHEMA,
      maxDepth: MAX_TREE_DEPTH + 1,
      maxAliases: 0,
      maxTotalMergeKeys: 0
    })
    return {
      metadata: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null,
      error: null
    }
  } catch (error: unknown) {
    return { metadata: null, error }
  }
}

const tagsFrom = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(tag => tag.trim()).filter(Boolean)
  return []
}

const okfPublishedFrom = (metadata: OkfMetadata): boolean | undefined => {
  const extension = metadata['x-wiki']
  if (typeof extension !== 'object' || extension === null || Array.isArray(extension) || !Object.hasOwn(extension, 'published'))
    return undefined
  const published = (extension as Record<string, unknown>).published
  if (typeof published !== 'boolean')
    throw new TypeError('OKF extension x-wiki.published must be a boolean')
  return published
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

  // A claimed or malformed OKF document is never allowed to silently degrade
  // into a legacy page.
  const beginsWithFrontmatter = FRONTMATTER_OPENER.test(text)
  const frontmatter = FRONTMATTER.exec(text)
  if (beginsWithFrontmatter && frontmatter === null) {
    return result(
      'okf_invalid',
      source,
      text,
      { tags: [] },
      null,
      ['INVALID_FRONTMATTER: YAML frontmatter is missing a bounded closing delimiter']
    )
  }
  const parsedFrontmatter = frontmatter === null ? null : parseYaml(frontmatter[1] ?? '')

  if (parsedFrontmatter !== null && parsedFrontmatter.error !== null)
    return result('okf_invalid', source, text, { tags: [] }, null, [diagnostic(parsedFrontmatter.error)])

  const frontmatterMetadata = parsedFrontmatter?.metadata ?? null
  const claimsOkf = frontmatter !== null && (
    (frontmatterMetadata !== null && Object.hasOwn(frontmatterMetadata, 'type'))
    || TYPE_KEY.test(frontmatter[1] ?? '')
  )

  if (claimsOkf) {
    try {
      const parsed = parseOkfDocument(text, now)
      const body = importOkfLinks(parsed.body, input.locale, input.pagePath)
      const published = okfPublishedFrom(parsed.metadata)
      const fields: StoragePageFields = {
        ...(parsed.metadata.title === undefined ? {} : { title: parsed.metadata.title }),
        ...(parsed.metadata.description === undefined ? {} : { description: parsed.metadata.description }),
        ...(published === undefined ? {} : { isPublished: published }),
        tags: parsed.metadata.tags === undefined ? [] : [...parsed.metadata.tags]
      }
      return result('okf_valid', source, body, fields, parsed.metadata, [])
    } catch (error: unknown) {
      return result('okf_invalid', source, text, { tags: [] }, null, [diagnostic(error)])
    }
  }

  if (frontmatter !== null && frontmatterMetadata !== null) {
    const fields = fieldsFrom(frontmatterMetadata)
    const body = text.slice(frontmatter[0].length).replace(/^\r?\n/u, '').replaceAll('\r\n', '\n')
    return result('legacy_wiki', source, body, fields, defaultMetadata(fields, importer, now), [])
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

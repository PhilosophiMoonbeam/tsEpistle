import { createHash } from 'node:crypto'
import { JSON_SCHEMA, load } from 'js-yaml'
import { z } from 'zod'

import { SkillPathError, validateSkillVirtualPath } from './virtual-path.ts'

const MAX_SKILL_BYTES = 64 * 1024
const MAX_SKILL_LINES = 500
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_COMPATIBILITY_LENGTH = 500
const MAX_RESOURCE_BYTES = 128 * 1024
const MAX_BUNDLE_BYTES = 512 * 1024
const MAX_RESOURCES = 32
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ACTIVE_CONTENT = /<(?:script|iframe|object|embed|svg|math)\b|(?:javascript|data\s*:\s*text\/html)\s*:/i
const YAML_ALIAS = /(^|[\s[{,])[&*][A-Za-z0-9_-]+(?=\s|$|[\]},])/m
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ['generic-bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{32,}={0,2}\b/i]
]
const KNOWN_FRONTMATTER: Readonly<Record<string, true>> = {
  name: true,
  description: true,
  license: true,
  compatibility: true,
  metadata: true,
  'allowed-tools': true
}
const ALLOWED_MEDIA_TYPES: Readonly<Record<string, true>> = {
  'text/markdown': true,
  'text/plain': true,
  'application/json': true,
  'application/javascript': true,
  'text/javascript': true,
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true
}
const FrontmatterRecordSchema = z.record(z.string(), z.unknown())
const MetadataSchema = z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), z.string().max(512))



export interface ParsedSkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly license: string | null
  readonly compatibility: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly allowedTools: readonly string[]
  readonly unknown: Readonly<Record<string, unknown>>
}

export interface ParsedSkillMarkdown {
  readonly bytes: Buffer
  readonly text: string
  readonly body: string
  readonly frontmatter: ParsedSkillFrontmatter
  readonly references: readonly string[]
  readonly contentHash: string
}

export interface SkillResourceInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly sourceId: string
  readonly sourceRevision: string
  readonly symbolicLink?: boolean
}

export interface ApprovedSkillResource {
  readonly path: string
  readonly bytes: Buffer
  readonly mediaType: string
  readonly size: number
  readonly sha256: string
  readonly sourceId: string
  readonly sourceRevision: string
  readonly executable: false
}

export interface ApprovedSkillBundle {
  readonly entry: ParsedSkillMarkdown
  readonly resources: readonly ApprovedSkillResource[]
  readonly manifestJson: string
  readonly contentHash: string
  readonly totalBytes: number
}

export class SkillValidationError extends Error {
  readonly code = 'INVALID_SKILL'
}

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SkillValidationError(`${label} is not valid UTF-8`)
  }
}

const requiredString = (record: Readonly<Record<string, unknown>>, key: string, maxLength: number): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new SkillValidationError(`Skill frontmatter ${key} must be a bounded single-line string`)
  }
  return value.trim()
}

const optionalString = (record: Readonly<Record<string, unknown>>, key: string, maxLength: number): string | null => {
  if (record[key] === undefined) return null
  return requiredString(record, key, maxLength)
}

const normalizeMetadata = (value: unknown): Readonly<Record<string, string>> => {
  if (value === undefined) return {}
  const parsed = MetadataSchema.safeParse(value)
  if (!parsed.success) throw new SkillValidationError('Skill metadata must contain bounded string keys and values')
  return parsed.data
}

const normalizeAllowedTools = (value: unknown): readonly string[] => {
  if (value === undefined) return []
  const tools = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value
  if (!Array.isArray(tools) || tools.length > 64 || tools.some(tool => typeof tool !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool))) {
    throw new SkillValidationError('Skill allowed-tools must contain bounded tool names')
  }
  return [...new Set(tools)].sort()
}

const unknownFrontmatter = (record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !KNOWN_FRONTMATTER[key]))

const extractReferences = (body: string): readonly string[] => {
  const references = new Set<string>()
  const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const match of body.matchAll(markdownLink)) {
    const target = match[1]
    if (!target || target.startsWith('#')) continue
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('//')) {
      throw new SkillValidationError('Skill resources must not use mutable remote URLs')
    }
    const clean = target.startsWith('./') ? target.slice(2) : target
    try {
      references.add(validateSkillVirtualPath(clean))
    } catch (error: unknown) {
      if (error instanceof SkillPathError) throw new SkillValidationError(error.message)
      throw error
    }
  }
  return [...references].sort()
}



const assertNoSecret = (text: string, label: string): void => {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new SkillValidationError(`${label} matches blocked secret pattern ${name}`)
  }
}

export const parseSkillMarkdown = (bytes: Uint8Array, expectedName: string): ParsedSkillMarkdown => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_BYTES) throw new SkillValidationError('SKILL.md exceeds its byte limit')
  const text = decodeUtf8(bytes, 'SKILL.md')
  if (text.includes('\0')) throw new SkillValidationError('SKILL.md contains NUL')
  if (text.split(/\r?\n/).length > MAX_SKILL_LINES) throw new SkillValidationError('SKILL.md exceeds 500 lines')
  if (ACTIVE_CONTENT.test(text)) throw new SkillValidationError('SKILL.md contains blocked active content')
  assertNoSecret(text, 'SKILL.md')

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new SkillValidationError('SKILL.md must begin with YAML frontmatter')
  const yamlSource = match[1] ?? ''
  if (YAML_ALIAS.test(yamlSource)) throw new SkillValidationError('SKILL.md frontmatter aliases and anchors are forbidden')

  let loaded: unknown
  try {
    loaded = load(yamlSource, { json: true, schema: JSON_SCHEMA })
  } catch {
    throw new SkillValidationError('SKILL.md frontmatter is invalid YAML')
  }
  const parsedRecord = FrontmatterRecordSchema.safeParse(loaded)
  if (!parsedRecord.success) throw new SkillValidationError('SKILL.md frontmatter must be an object')
  const frontmatterRecord = parsedRecord.data

  const name = requiredString(frontmatterRecord, 'name', 64)
  if (!SKILL_NAME.test(name) || name !== expectedName) {
    throw new SkillValidationError('Skill name must match the root page name and use lowercase hyphens')
  }
  const description = requiredString(frontmatterRecord, 'description', MAX_DESCRIPTION_LENGTH)
  const body = text.slice(match[0].length)
  if (body.trim().length === 0) throw new SkillValidationError('SKILL.md instructions are empty')

  const frontmatter: ParsedSkillFrontmatter = {
    name,
    description,
    license: optionalString(frontmatterRecord, 'license', 255),
    compatibility: optionalString(frontmatterRecord, 'compatibility', MAX_COMPATIBILITY_LENGTH),
    metadata: normalizeMetadata(frontmatterRecord.metadata),
    allowedTools: normalizeAllowedTools(frontmatterRecord['allowed-tools']),
    unknown: unknownFrontmatter(frontmatterRecord)
  }
  const canonicalBytes = Buffer.from(bytes)
  return {
    bytes: canonicalBytes,
    text,
    body,
    frontmatter,
    references: extractReferences(body),
    contentHash: createHash('sha256').update(canonicalBytes).digest('hex')
  }
}

const validateMediaType = (path: string, mediaType: string): void => {
  const normalized = mediaType.toLowerCase().split(';', 1)[0]?.trim()
  if (!normalized || !ALLOWED_MEDIA_TYPES[normalized] || /\.(?:html?|xhtml|svg|xml)$/i.test(path)) {
    throw new SkillValidationError(`Skill resource ${path} has a blocked media type`)
  }
}

export const buildApprovedSkillBundle = (entryBytes: Uint8Array, expectedName: string, resources: readonly SkillResourceInput[]): ApprovedSkillBundle => {
  const entry = parseSkillMarkdown(entryBytes, expectedName)
  if (resources.length > MAX_RESOURCES) throw new SkillValidationError('Skill bundle has too many resources')

  const supplied = new Map<string, SkillResourceInput>()
  for (const resource of resources) {
    const path = validateSkillVirtualPath(resource.path)
    if (path === 'SKILL.md' || supplied.has(path)) throw new SkillValidationError(`Skill resource path ${path} is duplicated or reserved`)
    supplied.set(path, resource)
  }

  const approved: ApprovedSkillResource[] = []
  let totalBytes = entry.bytes.byteLength
  for (const reference of entry.references) {
    const resource = supplied.get(reference)
    if (!resource) throw new SkillValidationError(`Referenced skill resource ${reference} is missing`)
    if (resource.symbolicLink) throw new SkillValidationError(`Skill resource ${reference} must not be a symbolic link`)
    if (resource.bytes.byteLength === 0 || resource.bytes.byteLength > MAX_RESOURCE_BYTES) {
      throw new SkillValidationError(`Skill resource ${reference} exceeds its byte limit`)
    }
    validateMediaType(reference, resource.mediaType)
    const normalizedMediaType = resource.mediaType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
    if (normalizedMediaType.startsWith('text/') || normalizedMediaType === 'application/json' || normalizedMediaType.includes('javascript')) {
      const text = decodeUtf8(resource.bytes, reference)
      if (text.includes('\0') || ACTIVE_CONTENT.test(text)) throw new SkillValidationError(`Skill resource ${reference} contains blocked active content`)
      assertNoSecret(text, reference)
    }
    const resourceBytes = Buffer.from(resource.bytes)
    totalBytes += resourceBytes.byteLength
    approved.push({
      path: reference,
      bytes: resourceBytes,
      mediaType: normalizedMediaType,
      size: resourceBytes.byteLength,
      sha256: createHash('sha256').update(resourceBytes).digest('hex'),
      sourceId: resource.sourceId,
      sourceRevision: resource.sourceRevision,
      executable: false
    })
  }
  if (supplied.size !== approved.length) throw new SkillValidationError('Skill bundle contains resources not explicitly referenced by SKILL.md')
  if (totalBytes > MAX_BUNDLE_BYTES) throw new SkillValidationError('Skill bundle exceeds its total byte limit')

  approved.sort((left, right) => left.path.localeCompare(right.path))
  const manifest = approved.map(resource => ({
    executable: false,
    mediaType: resource.mediaType,
    path: resource.path,
    sha256: resource.sha256,
    size: resource.size,
    sourceId: resource.sourceId,
    sourceRevision: resource.sourceRevision
  }))
  const manifestJson = JSON.stringify(manifest)
  const hash = createHash('sha256').update(entry.bytes)
  for (const resource of approved) {
    hash.update('\0').update(resource.path).update('\0').update(resource.sha256).update('\0').update(resource.mediaType)
  }
  return { entry, resources: approved, manifestJson, contentHash: hash.digest('hex'), totalBytes }
}

export const intersectAllowedTools = (available: readonly string[], allowedTools: readonly string[]): readonly string[] => {
  if (allowedTools.length === 0) return [...available]
  const allowed = new Set(allowedTools)
  return available.filter(tool => allowed.has(tool))
}

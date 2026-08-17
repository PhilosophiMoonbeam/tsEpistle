import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { ApprovedSkillResource } from './parser.ts'
import { SkillValidationError } from './parser.ts'
import { validateSkillVirtualPath } from './virtual-path.ts'

const MAGIC = Buffer.from('WSK1')
const MAX_BUNDLE_BYTES = 512 * 1024
const MAX_RESOURCES = 32
const MAX_FIELD_BYTES = 1024

export interface DecodedSkillResource {
  readonly path: string
  readonly bytes: Buffer
  readonly mediaType: string
  readonly sha256: string
  readonly sourceId: string
  readonly sourceRevision: string
  readonly executable: false
}

const readUInt16 = (buffer: Buffer, offset: number): number => {
  if (offset + 2 > buffer.byteLength) throw new SkillValidationError('Skill resource bundle is truncated')
  return buffer.readUInt16BE(offset)
}

const readUInt32 = (buffer: Buffer, offset: number): number => {
  if (offset + 4 > buffer.byteLength) throw new SkillValidationError('Skill resource bundle is truncated')
  return buffer.readUInt32BE(offset)
}

const encodeField = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FIELD_BYTES || bytes.byteLength > 0xffff) {
    throw new SkillValidationError('Skill resource bundle field is empty or too long')
  }
  const length = Buffer.allocUnsafe(2)
  length.writeUInt16BE(bytes.byteLength)
  return Buffer.concat([length, bytes])
}

export const encodeSkillResourceBundle = (resources: readonly ApprovedSkillResource[]): Buffer => {
  if (resources.length > MAX_RESOURCES) throw new SkillValidationError('Skill resource bundle has too many resources')
  const count = Buffer.allocUnsafe(2)
  count.writeUInt16BE(resources.length)
  const chunks: Buffer[] = [MAGIC, count]
  let previousPath = ''
  for (const resource of resources) {
    if (resource.path <= previousPath) throw new SkillValidationError('Skill resource bundle paths must be uniquely sorted')
    previousPath = resource.path
    const dataLength = Buffer.allocUnsafe(4)
    dataLength.writeUInt32BE(resource.bytes.byteLength)
    chunks.push(
      encodeField(resource.path),
      encodeField(resource.mediaType),
      encodeField(resource.sha256),
      encodeField(resource.sourceId),
      encodeField(resource.sourceRevision),
      dataLength,
      resource.bytes
    )
  }
  const bundle = Buffer.concat(chunks)
  if (bundle.byteLength > MAX_BUNDLE_BYTES) throw new SkillValidationError('Encoded skill resource bundle exceeds its byte limit')
  return bundle
}

const readField = (buffer: Buffer, offset: number): readonly [string, number] => {
  const length = readUInt16(buffer, offset)
  const start = offset + 2
  const end = start + length
  if (length === 0 || length > MAX_FIELD_BYTES || end > buffer.byteLength) throw new SkillValidationError('Skill resource bundle field is invalid')
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(start, end))
  } catch {
    throw new SkillValidationError('Skill resource bundle field is not valid UTF-8')
  }
  return [value, end]
}

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const decodeSkillResourceBundle = (input: Uint8Array): readonly DecodedSkillResource[] => {
  const buffer = Buffer.from(input)
  if (buffer.byteLength < 6 || buffer.byteLength > MAX_BUNDLE_BYTES || !buffer.subarray(0, 4).equals(MAGIC)) {
    throw new SkillValidationError('Skill resource bundle header is invalid')
  }
  const count = readUInt16(buffer, 4)
  if (count > MAX_RESOURCES) throw new SkillValidationError('Skill resource bundle has too many resources')

  const resources: DecodedSkillResource[] = []
  let offset = 6
  let previousPath = ''
  for (let index = 0; index < count; index += 1) {
    let path: string
    let mediaType: string
    let sha256: string
    let sourceId: string
    let sourceRevision: string
    ;[path, offset] = readField(buffer, offset)
    ;[mediaType, offset] = readField(buffer, offset)
    ;[sha256, offset] = readField(buffer, offset)
    ;[sourceId, offset] = readField(buffer, offset)
    ;[sourceRevision, offset] = readField(buffer, offset)
    validateSkillVirtualPath(path)
    if (path <= previousPath || !HashSchema.safeParse(sha256).success) throw new SkillValidationError('Skill resource bundle manifest is invalid')
    previousPath = path

    const dataLength = readUInt32(buffer, offset)
    offset += 4
    const dataEnd = offset + dataLength
    if (dataLength === 0 || dataEnd > buffer.byteLength) throw new SkillValidationError('Skill resource bundle data is invalid')
    const bytes = Buffer.from(buffer.subarray(offset, dataEnd))
    offset = dataEnd
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new SkillValidationError('Skill resource bundle hash does not match its bytes')
    resources.push({ path, bytes, mediaType, sha256, sourceId, sourceRevision, executable: false })
  }
  if (offset !== buffer.byteLength) throw new SkillValidationError('Skill resource bundle has trailing bytes')
  return resources
}

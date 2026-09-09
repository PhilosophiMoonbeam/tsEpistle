import pageHelper from '../../../helpers/page.ts'
import { OKF_MAX_DOCUMENT_BYTES } from '../../../okf/format.ts'
import { isStorageInternalPath, isStorageReservedPath } from '../internal-path.ts'
import { IMPORT_MAX_ASSET_BYTES, IMPORT_MAX_BYTES, IMPORT_MAX_ENTRIES, ImportBudget, boundedImportAssetLimit } from '../import-budget.ts'
import { BoundedProcessError, GIT_NATIVE_RECORD_LIMIT_BYTES, GIT_NATIVE_STDOUT_LIMIT_BYTES, type BoundedProcessResult } from './bounded-process.ts'

export interface GitNativeCommandOptions {
  readonly captureStdout?: boolean
  readonly onStdoutChunk?: (chunk: Buffer) => void | Promise<void>
  readonly maxStdoutBytes?: number
  readonly deadlineMs?: number
  readonly monitor?: () => void | Promise<void>
}

export interface GitNativeCommand {
  run(args: readonly string[], options?: GitNativeCommandOptions): Promise<BoundedProcessResult>
}

export interface GitTreeEntry {
  readonly mode: '040000' | '100644' | '100755'
  readonly type: 'tree' | 'blob'
  readonly oid: string
  readonly path: string
  readonly size: number
}

export interface GitTreeAdmission {
  readonly revision: string
  readonly entries: readonly GitTreeEntry[]
  readonly filesByPath: ReadonlyMap<string, GitTreeEntry>
  readonly entriesCount: number
  readonly bytes: number
}

export interface GitTreeAdmissionOptions {
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly maxAssetBytes?: number
  readonly maxStdoutBytes?: number
}

export type GitChangeStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X' | 'B'

export interface GitNameStatusChange {
  readonly status: GitChangeStatus
  readonly score?: number
  readonly oldPath: string
  readonly path: string
}

export interface GitNameStatusOptions {
  readonly maxChanges?: number
  readonly maxRecordBytes?: number
  readonly maxStdoutBytes?: number
}

const revisionPattern = /^(?:[0-9a-f]{7,64}|HEAD|[A-Za-z0-9._/-]+)$/u
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const statusPattern = /^(A|C|D|M|R|T|U|X|B)([0-9]{1,3})?$/u

const decoder = new TextDecoder('utf-8', { fatal: true })

function parseUtf8 (bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes)
  } catch (error: unknown) {
    throw new BoundedProcessError('parser', `Git ${label} is not valid UTF-8`, { cause: error })
  }
}

export function assertGitRevision (revision: string): void {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 128 || revision.startsWith('-') || !revisionPattern.test(revision)) {
    throw new BoundedProcessError('parser', 'Git revision is not a safe object identifier')
  }
}

export function assertGitPath (relativePath: string): void {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.length > GIT_NATIVE_RECORD_LIMIT_BYTES ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.split('/').some(part => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new BoundedProcessError('parser', `Git tree contains an unsafe path: ${relativePath}`)
  }
  if (isStorageInternalPath(relativePath) || isStorageReservedPath(relativePath)) {
    throw new BoundedProcessError('parser', `Git tree contains an internal path: ${relativePath}`)
  }
}

function parseTreeRecord (record: Buffer, maxAssetBytes: number): GitTreeEntry {
  if (record.byteLength > GIT_NATIVE_RECORD_LIMIT_BYTES) throw new BoundedProcessError('parser', `Git ls-tree record exceeded ${GIT_NATIVE_RECORD_LIMIT_BYTES} bytes`)
  const separator = record.indexOf(0x09)
  if (separator < 0) throw new BoundedProcessError('parser', 'Git ls-tree record is missing its path separator')
  const header = parseUtf8(record.subarray(0, separator), 'ls-tree header').trim()
  const parts = header.split(/\s+/u)
  if (parts.length !== 4) throw new BoundedProcessError('parser', 'Git ls-tree record has an invalid header')
  const [modeText, typeText, oid, sizeText] = parts
  const mode = modeText as GitTreeEntry['mode']
  const type = typeText as GitTreeEntry['type']
  if (mode !== '040000' && mode !== '100644' && mode !== '100755') {
    throw new BoundedProcessError('parser', `Git tree contains a disallowed mode: ${mode ?? ''}`)
  }
  if ((mode === '040000' && type !== 'tree') || (mode !== '040000' && type !== 'blob')) {
    throw new BoundedProcessError('parser', 'Git ls-tree mode and object type do not agree')
  }
  if (oid === undefined || !objectPattern.test(oid)) throw new BoundedProcessError('parser', 'Git ls-tree record contains an invalid object identifier')
  const size = mode === '040000' && sizeText === '-'
    ? 0
    : sizeText !== undefined && /^[0-9]+$/u.test(sizeText) && Number.isSafeInteger(Number(sizeText))
      ? Number(sizeText)
      : -1
  if (size < 0) throw new BoundedProcessError('parser', 'Git ls-tree record contains an invalid object size')
  const relativePath = parseUtf8(record.subarray(separator + 1), 'ls-tree path')
  assertGitPath(relativePath)
  if (mode !== '040000') {
    const contentType = pageHelper.getContentType(relativePath)
    const limit = contentType ? OKF_MAX_DOCUMENT_BYTES : maxAssetBytes
    if (size > limit) throw new BoundedProcessError('parser', `Git tree file exceeds its ${limit}-byte limit: ${relativePath}`)
  }
  return {
    mode,
    type,
    oid,
    path: relativePath,
    size
  }
}

class NulRecordParser {
  #buffer = Buffer.alloc(0)
  #recordBytes = 0
  readonly #maxRecordBytes: number
  readonly #onRecord: (record: Buffer) => void

  constructor (maxRecordBytes: number, onRecord: (record: Buffer) => void) {
    this.#maxRecordBytes = maxRecordBytes
    this.#onRecord = onRecord
  }

  push (chunk: Buffer): void {
    if (chunk.byteLength === 0) return
    this.#recordBytes += chunk.byteLength
    if (this.#recordBytes > this.#maxRecordBytes && chunk.indexOf(0) < 0) {
      throw new BoundedProcessError('parser', `Git NUL record exceeded ${this.#maxRecordBytes} bytes`)
    }
    this.#buffer = this.#buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])
    let separator = this.#buffer.indexOf(0)
    while (separator >= 0) {
      const record = this.#buffer.subarray(0, separator)
      if (record.byteLength > this.#maxRecordBytes) throw new BoundedProcessError('parser', `Git NUL record exceeded ${this.#maxRecordBytes} bytes`)
      this.#onRecord(Buffer.from(record))
      this.#buffer = this.#buffer.subarray(separator + 1)
      this.#recordBytes = this.#buffer.byteLength
      separator = this.#buffer.indexOf(0)
    }
    if (this.#buffer.byteLength > this.#maxRecordBytes) throw new BoundedProcessError('parser', `Git NUL record exceeded ${this.#maxRecordBytes} bytes`)
  }

  finish (): void {
    if (this.#buffer.byteLength !== 0) throw new BoundedProcessError('parser', 'Git command ended with an unterminated NUL record')
  }
}

export async function admitGitTree (
  command: GitNativeCommand,
  revision: string,
  options: GitTreeAdmissionOptions = {}
): Promise<GitTreeAdmission> {
  assertGitRevision(revision)
  const maxEntries = options.maxEntries ?? IMPORT_MAX_ENTRIES
  const maxBytes = options.maxBytes ?? IMPORT_MAX_BYTES
  const configuredAssetLimit = options.maxAssetBytes ?? IMPORT_MAX_ASSET_BYTES
  const maxAssetBytes = boundedImportAssetLimit(configuredAssetLimit)
  const budget = new ImportBudget(maxEntries, maxBytes)
  const entries: GitTreeEntry[] = []
  const filesByPath = new Map<string, GitTreeEntry>()
  const parser = new NulRecordParser(GIT_NATIVE_RECORD_LIMIT_BYTES, record => {
    const entry = parseTreeRecord(record, maxAssetBytes)
    if (filesByPath.has(entry.path)) throw new BoundedProcessError('parser', `Git tree contains a duplicate path: ${entry.path}`)
    try {
      budget.reserve(entry.size)
    } catch (error: unknown) {
      throw new BoundedProcessError('parser', error instanceof Error ? error.message : String(error), { cause: error })
    }
    entries.push(entry)
    filesByPath.set(entry.path, entry)
  })
  await command.run(
    ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', revision],
    {
      captureStdout: false,
      onStdoutChunk: chunk => parser.push(chunk),
      maxStdoutBytes: options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES
    }
  )
  parser.finish()
  return {
    revision,
    entries,
    filesByPath,
    entriesCount: budget.entries,
    bytes: budget.bytes
  }
}

function parseStatusToken (token: string): { readonly status: GitChangeStatus; readonly score?: number } {
  const match = statusPattern.exec(token)
  if (!match) throw new BoundedProcessError('parser', `Git diff emitted an invalid status: ${token}`)
  const code = match[1] as GitChangeStatus
  const scoreText = match[2]
  return scoreText === undefined ? { status: code } : { status: code, score: Number(scoreText) }
}

export async function streamGitNameStatus (
  command: GitNativeCommand,
  fromRevision: string,
  toRevision: string,
  options: GitNameStatusOptions = {}
): Promise<GitNameStatusChange[]> {
  assertGitRevision(fromRevision)
  assertGitRevision(toRevision)
  const maxChanges = options.maxChanges ?? IMPORT_MAX_ENTRIES
  const maxRecordBytes = options.maxRecordBytes ?? GIT_NATIVE_RECORD_LIMIT_BYTES
  if (!Number.isSafeInteger(maxChanges) || maxChanges < 0) throw new RangeError('Git change limit must be a non-negative safe integer')
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new RangeError('Git record limit must be a positive safe integer')
  const changes: GitNameStatusChange[] = []

  // Rename/copy records contain status, old path, and new path. This parser
  // keeps only the current record's fields, never the complete command output.
  const fields: string[] = []
  let recordBytes = 0
  const renameParser = new NulRecordParser(maxRecordBytes, record => {
    recordBytes += record.byteLength + 1
    if (recordBytes > maxRecordBytes) throw new BoundedProcessError('parser', `Git diff record exceeded ${maxRecordBytes} bytes`)
    const token = parseUtf8(record, 'diff status/path')
    fields.push(token)
    const status = fields[0] === undefined ? undefined : parseStatusToken(fields[0])
    const required = status && (status.status === 'R' || status.status === 'C') ? 3 : 2
    if (fields.length < required) return
    if (fields.length > required) throw new BoundedProcessError('parser', 'Git diff emitted too many fields for a status record')
    const first = fields[1]
    const second = fields[2]
    if (first === undefined) throw new BoundedProcessError('parser', 'Git diff status record is missing its path')
    assertGitPath(first)
    if (!status) throw new BoundedProcessError('parser', 'Git diff status record is missing its status')
    if (status.status === 'R' || status.status === 'C') {
      if (second === undefined) throw new BoundedProcessError('parser', 'Git diff rename record is missing its destination')
      assertGitPath(second)
      if (changes.length >= maxChanges) throw new BoundedProcessError('parser', `Git diff exceeded its ${maxChanges}-change limit`)
      changes.push({ status: status.status, oldPath: first, path: second, ...(status.score === undefined ? {} : { score: status.score }) })
    } else {
      if (changes.length >= maxChanges) throw new BoundedProcessError('parser', `Git diff exceeded its ${maxChanges}-change limit`)
      changes.push({ status: status.status, oldPath: first, path: first, ...(status.score === undefined ? {} : { score: status.score }) })
    }
    fields.length = 0
    recordBytes = 0
  })

  await command.run(
    ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', fromRevision, toRevision, '--'],
    {
      captureStdout: false,
      onStdoutChunk: chunk => renameParser.push(chunk),
      maxStdoutBytes: options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES
    }
  )
  renameParser.finish()
  if (fields.length !== 0) throw new BoundedProcessError('parser', 'Git diff ended with an incomplete status record')
  return changes
}

 

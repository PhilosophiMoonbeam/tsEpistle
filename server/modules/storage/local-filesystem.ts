import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import type { Dir, Stats } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const COPY_CHUNK_BYTES = 64 * 1024

type ErrorWithCode = { readonly code?: unknown }

export interface StorageFileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
}

export interface StorageFileIdentityExpectation {
  readonly dev?: number
  readonly ino?: number
  readonly size?: number
}

export type StorageWalkKind = 'file' | 'directory' | 'symlink' | 'other'

export interface StorageWalkEntry {
  readonly relativePath: string
  readonly kind: StorageWalkKind
  readonly identity: StorageFileIdentity
}

export interface StorageWalkOptions {
  /** Unsafe entries are rejected by default. Set false only for a no-follow inventory. */
  readonly rejectUnsafe?: boolean
  /** Skip a named child before it is inspected, opened, or descended into. */
  readonly shouldSkip?: (relativePath: string) => boolean
  /** Admit an entry before it is yielded or, for directories, descended into. */
  readonly admit?: (entry: StorageWalkEntry) => void | Promise<void>
}

export class StorageFilesystemError extends Error {
  readonly code: string

  constructor (code: string, message: string) {
    super(message)
    this.name = 'StorageFilesystemError'
    this.code = code
  }
}

function errorCode (value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as ErrorWithCode
  return typeof candidate.code === 'string' ? candidate.code : undefined
}

function isMissing (value: unknown): boolean {
  return errorCode(value) === 'ENOENT'
}

function isRejectedPathError (value: unknown): boolean {
  const code = errorCode(value)
  return code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'EINVAL'
}

function rejectPath (relativePath: string, reason: string): StorageFilesystemError {
  return new StorageFilesystemError('STORAGE_PATH_REJECTED', `${reason}: ${relativePath}`)
}

function unavailable (reason: string): StorageFilesystemError {
  return new StorageFilesystemError('STORAGE_UNAVAILABLE', reason)
}

function assertLinuxSupport (): void {
  if (
    process.platform !== 'linux' ||
    typeof fsConstants.O_RDONLY !== 'number' ||
    typeof fsConstants.O_DIRECTORY !== 'number' ||
    typeof fsConstants.O_NOFOLLOW !== 'number' ||
    typeof fsConstants.O_NONBLOCK !== 'number' ||
    typeof fsConstants.O_WRONLY !== 'number' ||
    typeof fsConstants.O_CREAT !== 'number' ||
    typeof fsConstants.O_EXCL !== 'number' ||
    typeof fsConstants.O_APPEND !== 'number'
  ) {
    throw unavailable('Descriptor-confined local storage requires Linux no-follow filesystem flags')
  }
}

const ROOT_FLAGS = (): number => fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
const DIRECTORY_FLAGS = ROOT_FLAGS
const FILE_FLAGS = (): number => fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
const TEMPORARY_FLAGS = (): number => fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW

function procFdPath (fd: number, child?: string): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw unavailable('A valid descriptor is required for local storage')
  return child === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${child}`
}

function isPathContained (root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function descriptorRealPath (handle: FileHandle): Promise<string> {
  try {
    return await realpath(procFdPath(handle.fd))
  } catch (error: unknown) {
    throw unavailable(`Cannot verify descriptor confinement: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function identityOf (stats: Stats): StorageFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs
  }
}

function sameIdentity (left: StorageFileIdentity, right: StorageFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameEntryIdentity (left: StorageFileIdentity, right: StorageFileIdentity): boolean {
  return sameIdentity(left, right) && left.mode === right.mode
}

function assertRegular (stats: Stats, relativePath: string): void {
  if (!stats.isFile()) throw rejectPath(relativePath, 'Local storage path is not a regular file')
}

function assertDirectory (stats: Stats, relativePath: string): void {
  if (!stats.isDirectory()) throw rejectPath(relativePath, 'Local storage path is not a directory')
}

function assertLimit (maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Bounded local storage operations require a non-negative safe integer byte limit')
  }
}

function canonicalRelativeParts (relativePath: string, allowEmpty = false): string[] {
  if (typeof relativePath !== 'string') throw rejectPath(String(relativePath), 'Local storage path must be a string')
  const normalized = relativePath.replace(/\\/g, '/')
  if (allowEmpty && normalized === '') return []
  const parts = normalized.split('/')
  const hasWindowsDrive = /^[A-Za-z]:\//u.test(normalized) || /^[A-Za-z]:$/u.test(normalized)
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    hasWindowsDrive ||
    normalized.includes('\0') ||
    parts.some(part => part.length === 0 || part === '.' || part === '..') ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw rejectPath(relativePath, 'Local storage path is not canonical and relative')
  }
  return parts
}


function assertExpectedIdentity (
  expected: StorageFileIdentityExpectation | undefined,
  actual: StorageFileIdentity,
  relativePath: string
): void {
  if (expected === undefined) return
  if (
    (expected.dev !== undefined && expected.dev !== actual.dev) ||
    (expected.ino !== undefined && expected.ino !== actual.ino) ||
    (expected.size !== undefined && expected.size !== actual.size)
  ) {
    throw rejectPath(relativePath, 'Local storage file changed during validation')
  }
}

async function closeHandles (handles: readonly FileHandle[]): Promise<void> {
  let firstError: unknown
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    const handle = handles[index]
    if (handle === undefined) continue
    try {
      await handle.close()
    } catch (error: unknown) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
}

async function closeDirectoryIterator (directory: Dir): Promise<void> {
  try {
    await directory.close()
  } catch (error: unknown) {
    if (errorCode(error) !== 'ERR_DIR_CLOSED') throw error
  }

}
async function safeUnlink (parent: FileHandle, leaf: string): Promise<void> {
  try {
    await unlink(procFdPath(parent.fd, leaf))
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
}

async function lstatAt (parent: FileHandle, leaf: string, relativePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(procFdPath(parent.fd, leaf))
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    if (isRejectedPathError(error)) throw rejectPath(relativePath, 'Local storage path cannot be safely inspected')
    throw error
  }
}

async function openDirectoryAt (parent: FileHandle, leaf: string, relativePath: string): Promise<FileHandle> {
  try {
    return await open(procFdPath(parent.fd, leaf), DIRECTORY_FLAGS())
  } catch (error: unknown) {
    if (isRejectedPathError(error)) throw rejectPath(relativePath, 'Local storage directory is not safely confined')
    throw error
  }
}

async function openRegularFileAt (parent: FileHandle, leaf: string, relativePath: string): Promise<FileHandle> {
  try {
    return await open(procFdPath(parent.fd, leaf), FILE_FLAGS())
  } catch (error: unknown) {
    if (isRejectedPathError(error)) throw rejectPath(relativePath, 'Local storage file is not safely confined')
    throw error
  }
}

interface DirectoryChain {
  readonly handles: FileHandle[]
  readonly parent: FileHandle
}


async function openRootForOperation (
  canonicalRoot: string,
  expectedRoot: StorageFileIdentity,
  rootAnchor: FileHandle
): Promise<FileHandle> {
  const anchorPath = await descriptorRealPath(rootAnchor)
  if (anchorPath !== canonicalRoot) throw unavailable('Configured local storage root changed during validation')
  let root: FileHandle
  try {
    root = await open(canonicalRoot, ROOT_FLAGS())
  } catch (error: unknown) {
    if (isRejectedPathError(error)) throw unavailable('Configured local storage root is not a safe Linux directory')
    throw error
  }
  try {
    const stats = await root.stat()
    assertDirectory(stats, '.')
    const actual = identityOf(stats)
    if (!sameIdentity(expectedRoot, actual)) throw unavailable('Configured local storage root changed during validation')
    const actualPath = await descriptorRealPath(root)
    if (actualPath !== canonicalRoot) throw unavailable('Configured local storage root is not descriptor-confined')
    return root
  } catch (error: unknown) {
    try {
      await root.close()
    } catch {
      // Preserve the validation error.
    }
    throw error
  }
}

async function openDirectoryChain (
  canonicalRoot: string,
  expectedRoot: StorageFileIdentity,
  rootAnchor: FileHandle,
  parts: readonly string[],
  createMissing: boolean
): Promise<DirectoryChain> {
  const root = await openRootForOperation(canonicalRoot, expectedRoot, rootAnchor)
  const handles: FileHandle[] = [root]
  let parent = root
  const walked: string[] = []
  try {
    for (const part of parts) {
      walked.push(part)
      const relativePath = walked.join('/')
      let child: FileHandle | undefined
      try {
        child = await openDirectoryAt(parent, part, relativePath)
      } catch (error: unknown) {
        if (!createMissing || !isMissing(error)) throw error
        try {
          await mkdir(procFdPath(parent.fd, part), { mode: 0o700 })
        } catch (mkdirError: unknown) {
          if (!isMissing(mkdirError) && errorCode(mkdirError) !== 'EEXIST') throw mkdirError
        }
        child = await openDirectoryAt(parent, part, relativePath)
      }
      const stats = await child.stat()
      assertDirectory(stats, relativePath)
      const childPath = await descriptorRealPath(child)
      if (!isPathContained(canonicalRoot, childPath)) throw rejectPath(relativePath, 'Local storage directory escapes the configured root')
      handles.push(child)
      parent = child
    }
    return { handles, parent }
  } catch (error: unknown) {
    try {
      await closeHandles(handles)
    } catch {
      // Preserve the validation error.
    }
    throw error
  }
}

async function inspectLeaf (
  parent: FileHandle,
  leaf: string,
  relativePath: string,
  expected?: StorageFileIdentityExpectation
): Promise<{ readonly handle: FileHandle; readonly stats: Stats; readonly identity: StorageFileIdentity }> {
  const entry = await lstatAt(parent, leaf, relativePath)
  if (entry === undefined) {
    const missing = new Error(`Local storage file does not exist: ${relativePath}`)
    Object.defineProperty(missing, 'code', { value: 'ENOENT', enumerable: false })
    throw missing
  }
  if (!entry.isFile()) throw rejectPath(relativePath, 'Local storage leaf is not a regular file')
  const handle = await openRegularFileAt(parent, leaf, relativePath)
  try {
    const stats = await handle.stat()
    assertRegular(stats, relativePath)
    const identity = identityOf(stats)
    const listedIdentity = identityOf(entry)
    if (!sameIdentity(identity, listedIdentity)) throw rejectPath(relativePath, 'Local storage leaf changed during validation')
    assertExpectedIdentity(expected, identity, relativePath)
    return { handle, stats, identity }
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // Preserve the validation error.
    }
    throw error
  }
}

async function inspectDestination (
  parent: FileHandle,
  leaf: string,
  relativePath: string
): Promise<StorageFileIdentity | undefined> {
  const entry = await lstatAt(parent, leaf, relativePath)
  if (entry === undefined) return undefined
  if (!entry.isFile()) throw rejectPath(relativePath, 'Local storage destination is not a regular file')
  return identityOf(entry)
}

export class StorageFileHandle {
  readonly relativePath: string
  readonly stats: Stats
  readonly identity: StorageFileIdentity
  readonly #handle: FileHandle
  readonly #handles: readonly FileHandle[]
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor (
    relativePath: string,
    handle: FileHandle,
    handles: readonly FileHandle[],
    stats: Stats,
    identity: StorageFileIdentity
  ) {
    this.relativePath = relativePath
    this.#handle = handle
    this.#handles = handles
    this.stats = stats
    this.identity = identity
  }

  get closed (): boolean {
    return this.#closed
  }

  /** The descriptor is safe to pass to an awaited consumer; it is never a pathname. */
  get handle (): FileHandle {
    this.assertOpen()
    return this.#handle
  }

  assertOpen (): void {
    if (this.#closed) throw new StorageFilesystemError('STORAGE_HANDLE_CLOSED', `Local storage handle is closed: ${this.relativePath}`)
  }

  async readBounded (maxBytes: number): Promise<Buffer> {
    this.assertOpen()
    assertLimit(maxBytes)
    const before = await this.#handle.stat()
    assertRegular(before, this.relativePath)
    const beforeIdentity = identityOf(before)
    if (!sameIdentity(this.identity, beforeIdentity)) throw rejectPath(this.relativePath, 'Local storage file identity changed')
    const snapshotSize = before.size
    if (!Number.isSafeInteger(snapshotSize) || snapshotSize < 0) {
      throw new RangeError(`Local storage file has an invalid size: ${this.relativePath}`)
    }
    if (snapshotSize > maxBytes) throw new RangeError(`Local storage file exceeds ${maxBytes} bytes: ${this.relativePath}`)

    if (snapshotSize === 0) {
      const probe = Buffer.allocUnsafe(1)
      const result = await this.#handle.read(probe, 0, 1, 0)
      if (result.bytesRead !== 0) throw new RangeError(`Local storage file grew during bounded read: ${this.relativePath}`)
      const after = await this.#handle.stat()
      const afterIdentity = identityOf(after)
      if (!sameIdentity(beforeIdentity, afterIdentity) || before.size !== after.size) {
        throw rejectPath(this.relativePath, 'Local storage file changed during bounded read')
      }
      return Buffer.alloc(0)
    }

    const contents = Buffer.allocUnsafe(snapshotSize)
    let offset = 0
    while (offset < snapshotSize) {
      const result = await this.#handle.read(contents, offset, snapshotSize - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    const result = await this.#handle.read(probe, 0, 1, snapshotSize)
    if (result.bytesRead !== 0) throw new RangeError(`Local storage file grew during bounded read: ${this.relativePath}`)
    const after = await this.#handle.stat()
    const afterIdentity = identityOf(after)
    if (!sameIdentity(beforeIdentity, afterIdentity) || before.size !== after.size) {
      throw rejectPath(this.relativePath, 'Local storage file changed during bounded read')
    }
    return contents.subarray(0, offset)
  }

  async copyTo (destination: FileHandle, maxBytes: number): Promise<number> {
    this.assertOpen()
    return copyBounded(this, destination, maxBytes)
  }

  async close (): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#closePromise = closeHandles(this.#handles)
    return this.#closePromise
  }
}

type ReadableDescriptor = StorageFileHandle | FileHandle

function descriptorForRead (source: ReadableDescriptor): { readonly handle: FileHandle; readonly relativePath: string } {
  if (source instanceof StorageFileHandle) {
    source.assertOpen()
    return { handle: source.handle, relativePath: source.relativePath }
  }
  return { handle: source, relativePath: '<descriptor>' }
}

export async function copyBounded (
  source: ReadableDescriptor,
  destination: FileHandle,
  maxBytes: number
): Promise<number> {
  assertLimit(maxBytes)
  const sourceDescriptor = descriptorForRead(source)
  if (sourceDescriptor.handle.fd === destination.fd) throw new StorageFilesystemError('STORAGE_PATH_REJECTED', 'Local storage source and destination descriptors must differ')
  const before = await sourceDescriptor.handle.stat()
  assertRegular(before, sourceDescriptor.relativePath)
  const beforeIdentity = identityOf(before)
  if (source instanceof StorageFileHandle && !sameIdentity(source.identity, beforeIdentity)) {
    throw rejectPath(source.relativePath, 'Local storage source identity changed')
  }
  if (before.size > maxBytes) throw new RangeError(`Local storage source exceeds ${maxBytes} bytes: ${sourceDescriptor.relativePath}`)

  let copied = 0
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, maxBytes)))
  try {
    while (copied < maxBytes) {
      const remaining = maxBytes - copied
      const result = await sourceDescriptor.handle.read(buffer, 0, Math.min(buffer.byteLength, remaining), copied)
      if (result.bytesRead === 0) break
      let written = 0
      while (written < result.bytesRead) {
        const writeResult = await destination.write(buffer, written, result.bytesRead - written)
        if (writeResult.bytesWritten === 0) throw new Error(`Failed to copy local storage file: ${sourceDescriptor.relativePath}`)
        written += writeResult.bytesWritten
      }
      copied += result.bytesRead
    }
    if (copied === maxBytes) {
      const probe = Buffer.allocUnsafe(1)
      const result = await sourceDescriptor.handle.read(probe, 0, 1, maxBytes)
      if (result.bytesRead !== 0) throw new RangeError(`Local storage source exceeds ${maxBytes} bytes: ${sourceDescriptor.relativePath}`)
    }
    const after = await sourceDescriptor.handle.stat()
    const afterIdentity = identityOf(after)
    if (!sameIdentity(beforeIdentity, afterIdentity) || before.size !== after.size) {
      throw rejectPath(sourceDescriptor.relativePath, 'Local storage source changed during bounded copy')
    }
    return copied
  } catch (error: unknown) {
    if (error instanceof StorageFilesystemError || error instanceof RangeError) throw error
    throw error
  }
}

export class StorageRootHandle {
  readonly #canonicalRoot: string
  readonly #rootAnchor: FileHandle
  readonly #rootIdentity: StorageFileIdentity
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor (canonicalRoot: string, rootAnchor: FileHandle, rootIdentity: StorageFileIdentity) {
    this.#canonicalRoot = canonicalRoot
    this.#rootAnchor = rootAnchor
    this.#rootIdentity = rootIdentity
  }

  get closed (): boolean {
    return this.#closed
  }

  #assertOpen (): void {
    if (this.#closed) throw new StorageFilesystemError('STORAGE_HANDLE_CLOSED', 'Local storage root handle is closed')
  }

  async openFile (relativePath: string, expected?: StorageFileIdentityExpectation): Promise<StorageFileHandle> {
    this.#assertOpen()
    const parts = canonicalRelativeParts(relativePath)
    const canonicalPath = parts.join('/')
    const chain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, parts.slice(0, -1), false)
    const leaf = parts.at(-1)
    if (leaf === undefined) {
      await closeHandles(chain.handles)
      throw rejectPath(relativePath, 'Local storage file path is empty')
    }
    try {
      const inspected = await inspectLeaf(chain.parent, leaf, canonicalPath, expected)
      const filePath = await descriptorRealPath(inspected.handle)
      if (!isPathContained(this.#canonicalRoot, filePath)) throw rejectPath(canonicalPath, 'Local storage file escapes the configured root')
      return new StorageFileHandle(canonicalPath, inspected.handle, [...chain.handles, inspected.handle], inspected.stats, inspected.identity)
    } catch (error: unknown) {
      try {
        await closeHandles(chain.handles)
      } catch {
        // Preserve the validation error.
      }
      throw error
    }
  }

  async ensureDirectory (relativePath: string): Promise<void> {
    this.#assertOpen()
    const parts = canonicalRelativeParts(relativePath, true)
    if (parts.length === 0) return
    const chain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, parts, true)
    await closeHandles(chain.handles)
  }

  async #writeAtomicWithProducer (
    relativePath: string,
    maxBytes: number,
    producer: (temporary: FileHandle, canonicalPath: string) => Promise<number>
  ): Promise<void> {
    this.#assertOpen()
    assertLimit(maxBytes)
    const parts = canonicalRelativeParts(relativePath)
    const leaf = parts.at(-1)
    if (leaf === undefined) throw rejectPath(relativePath, 'Local storage destination path is empty')
    const canonicalPath = parts.join('/')
    const chain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, parts.slice(0, -1), true)
    const temporaryLeaf = `.${leaf}.${process.pid}.${randomUUID()}.tmp`
    let temporary: FileHandle | undefined
    let temporaryCreated = false
    try {
      temporary = await open(procFdPath(chain.parent.fd, temporaryLeaf), TEMPORARY_FLAGS(), 0o600)
      temporaryCreated = true
      const written = await producer(temporary, canonicalPath)
      if (!Number.isSafeInteger(written) || written < 0 || written > maxBytes) {
        throw new RangeError(`Local storage atomic output exceeds ${maxBytes} bytes: ${canonicalPath}`)
      }
      await temporary.sync()
      const temporaryStats = await temporary.stat()
      assertRegular(temporaryStats, canonicalPath)
      if (temporaryStats.size !== written || temporaryStats.size > maxBytes) {
        throw new Error(`Local storage temporary size mismatch: ${canonicalPath}`)
      }
      const existing = await inspectDestination(chain.parent, leaf, canonicalPath)
      if (existing !== undefined) {
        const current = await lstatAt(chain.parent, leaf, canonicalPath)
        if (current === undefined || !current.isFile() || !sameIdentity(existing, identityOf(current))) {
          throw rejectPath(canonicalPath, 'Local storage destination changed during atomic replacement')
        }
      }
      await temporary.close()
      temporary = undefined
      await rename(procFdPath(chain.parent.fd, temporaryLeaf), procFdPath(chain.parent.fd, leaf))
      temporaryCreated = false
    } catch (error: unknown) {
      if (temporary !== undefined) {
        try {
          await temporary.close()
        } catch {
          // Preserve the write error.
        }
      }
      if (temporaryCreated) await safeUnlink(chain.parent, temporaryLeaf)
      throw error
    } finally {
      if (temporary !== undefined) {
        try {
          await temporary.close()
        } catch {
          // Preserve the operation result.
        }
      }
      await closeHandles(chain.handles)
    }
  }

  async writeAtomic (relativePath: string, data: string | Uint8Array): Promise<void> {
    this.#assertOpen()
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    await this.#writeAtomicWithProducer(relativePath, bytes.byteLength, async (temporary, canonicalPath) => {
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await temporary.write(bytes, offset, bytes.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error(`Failed to write local storage file: ${canonicalPath}`)
        offset += result.bytesWritten
      }
      return offset
    })
  }

  async writeAtomicStream (
    relativePath: string,
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number
  ): Promise<void> {
    this.#assertOpen()
    assertLimit(maxBytes)
    const iterator = chunks[Symbol.asyncIterator]()
    let iteratorClosed = false
    const closeIterator = async (): Promise<void> => {
      if (iteratorClosed) return
      iteratorClosed = true
      if (iterator.return !== undefined) await iterator.return()
    }
    let operationFailed = false
    let operationError: unknown
    try {
      await this.#writeAtomicWithProducer(relativePath, maxBytes, async (temporary, canonicalPath) => {
        let written = 0
        while (true) {
          const next = await iterator.next()
          if (next.done) break
          const chunk = next.value
          if (!(chunk instanceof Uint8Array)) throw new TypeError(`Local storage atomic stream yielded a non-byte chunk: ${canonicalPath}`)
          if (chunk.byteLength > maxBytes - written) {
            throw new RangeError(`Local storage atomic output exceeds ${maxBytes} bytes: ${canonicalPath}`)
          }
          let offset = 0
          while (offset < chunk.byteLength) {
            const result = await temporary.write(chunk, offset, chunk.byteLength - offset)
            if (result.bytesWritten === 0) throw new Error(`Failed to write local storage file: ${canonicalPath}`)
            offset += result.bytesWritten
          }
          written += chunk.byteLength
        }
        return written
      })
    } catch (error: unknown) {
      operationFailed = true
      operationError = error
    }
    let iteratorCloseFailed = false
    let iteratorCloseError: unknown
    try {
      await closeIterator()
    } catch (error: unknown) {
      iteratorCloseFailed = true
      iteratorCloseError = error
    }
    if (operationFailed) throw operationError
    if (iteratorCloseFailed) throw iteratorCloseError
  }

  async removeFile (relativePath: string): Promise<boolean> {
    this.#assertOpen()
    const parts = canonicalRelativeParts(relativePath)
    const leaf = parts.at(-1)
    if (leaf === undefined) throw rejectPath(relativePath, 'Local storage file path is empty')
    const canonicalPath = parts.join('/')
    let chain: DirectoryChain
    try {
      chain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, parts.slice(0, -1), false)
    } catch (error: unknown) {
      if (isMissing(error)) return false
      throw error
    }
    let file: FileHandle | undefined
    try {
      const listed = await lstatAt(chain.parent, leaf, canonicalPath)
      if (listed === undefined) return false
      if (!listed.isFile()) throw rejectPath(canonicalPath, 'Local storage removal requires a regular file')
      file = await openRegularFileAt(chain.parent, leaf, canonicalPath)
      const stats = await file.stat()
      assertRegular(stats, canonicalPath)
      const identity = identityOf(stats)
      if (!sameIdentity(identity, identityOf(listed))) throw rejectPath(canonicalPath, 'Local storage file changed during removal')
      const current = await lstatAt(chain.parent, leaf, canonicalPath)
      if (current === undefined) return false
      if (!current.isFile() || !sameIdentity(identity, identityOf(current))) throw rejectPath(canonicalPath, 'Local storage file changed during removal')
      await unlink(procFdPath(chain.parent.fd, leaf))
      return true
    } catch (error: unknown) {
      if (isMissing(error)) return false
      if (isRejectedPathError(error)) throw rejectPath(canonicalPath, 'Local storage file cannot be safely removed')
      throw error
    } finally {
      if (file !== undefined) {
        try {
          await file.close()
        } catch {
          // Preserve the operation result.
        }
      }
      await closeHandles(chain.handles)
    }
  }

  async move (sourcePath: string, destinationPath: string): Promise<boolean> {
    this.#assertOpen()
    const sourceParts = canonicalRelativeParts(sourcePath)
    const destinationParts = canonicalRelativeParts(destinationPath)
    const source = sourceParts.join('/')
    const destination = destinationParts.join('/')
    if (source === destination) {
      const handle = await this.openFile(source)
      await handle.close()
      return true
    }
    let sourceChain: DirectoryChain
    try {
      sourceChain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, sourceParts.slice(0, -1), false)
    } catch (error: unknown) {
      if (isMissing(error)) return false
      throw error
    }
    const destinationChain = await openDirectoryChain(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor, destinationParts.slice(0, -1), false)
    const sourceLeaf = sourceParts.at(-1)
    const destinationLeaf = destinationParts.at(-1)
    if (sourceLeaf === undefined || destinationLeaf === undefined) {
      await closeHandles(sourceChain.handles)
      await closeHandles(destinationChain.handles)
      throw rejectPath(sourcePath, 'Local storage move path is empty')
    }
    let sourceHandle: FileHandle | undefined
    try {
      const sourceListed = await lstatAt(sourceChain.parent, sourceLeaf, source)
      if (sourceListed === undefined) return false
      if (!sourceListed.isFile()) throw rejectPath(source, 'Local storage move source is not a regular file')
      sourceHandle = await openRegularFileAt(sourceChain.parent, sourceLeaf, source)
      const sourceStats = await sourceHandle.stat()
      assertRegular(sourceStats, source)
      const sourceIdentity = identityOf(sourceStats)
      if (!sameIdentity(sourceIdentity, identityOf(sourceListed))) throw rejectPath(source, 'Local storage move source changed during validation')
      const destinationListed = await lstatAt(destinationChain.parent, destinationLeaf, destination)
      if (destinationListed !== undefined && !destinationListed.isFile()) throw rejectPath(destination, 'Local storage move destination is not a regular file')
      if (destinationListed !== undefined) {
        const destinationIdentity = identityOf(destinationListed)
        const current = await lstatAt(destinationChain.parent, destinationLeaf, destination)
        if (current === undefined || !current.isFile() || !sameIdentity(destinationIdentity, identityOf(current))) {
          throw rejectPath(destination, 'Local storage move destination changed during validation')
        }
      }
      await rename(procFdPath(sourceChain.parent.fd, sourceLeaf), procFdPath(destinationChain.parent.fd, destinationLeaf))
      return true
    } catch (error: unknown) {
      if (isMissing(error)) return false
      if (isRejectedPathError(error)) throw rejectPath(source, 'Local storage move path cannot be safely renamed')
      throw error
    } finally {
      if (sourceHandle !== undefined) {
        try {
          await sourceHandle.close()
        } catch {
          // Preserve the move result.
        }
      }
      await closeHandles(sourceChain.handles)
      await closeHandles(destinationChain.handles)
    }
  }

  async *walk (options: StorageWalkOptions = {}): AsyncGenerator<StorageWalkEntry> {
    this.#assertOpen()
    const rejectUnsafe = options.rejectUnsafe !== false
    const root = await openRootForOperation(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor)
    try {
      yield* this.#walkDirectory(root, '', rejectUnsafe, options)
    } finally {
      await root.close()
    }
  }

  async *#walkDirectory (
    directory: FileHandle,
    prefix: string,
    rejectUnsafe: boolean,
    options: StorageWalkOptions
  ): AsyncGenerator<StorageWalkEntry> {
    let entries: Dir | undefined
    try {
      entries = await opendir(procFdPath(directory.fd), { bufferSize: 32 })
      for await (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (options.shouldSkip?.(relativePath) === true) continue
        canonicalRelativeParts(relativePath)
        const listed = await lstatAt(directory, entry.name, relativePath)
        if (listed === undefined) continue
        const listedIdentity = identityOf(listed)
        if (listed.isSymbolicLink()) {
          if (rejectUnsafe) throw rejectPath(relativePath, 'Local storage walk encountered a symbolic link')
          const candidate: StorageWalkEntry = { relativePath, kind: 'symlink', identity: listedIdentity }
          await options.admit?.(candidate)
          yield candidate
          continue
        }
        if (listed.isDirectory()) {
          let child: FileHandle
          try {
            child = await openDirectoryAt(directory, entry.name, relativePath)
          } catch (error: unknown) {
            if (!rejectUnsafe && isRejectedPathError(error)) {
              const candidate: StorageWalkEntry = { relativePath, kind: 'other', identity: listedIdentity }
              await options.admit?.(candidate)
              yield candidate
              continue
            }
            throw error
          }
          try {
            const stats = await child.stat()
            assertDirectory(stats, relativePath)
            const childIdentity = identityOf(stats)
            if (!sameIdentity(childIdentity, listedIdentity)) throw rejectPath(relativePath, 'Local storage directory changed during walk')
            const childPath = await descriptorRealPath(child)
            if (!isPathContained(this.#canonicalRoot, childPath)) throw rejectPath(relativePath, 'Local storage directory escapes the configured root')
            const candidate: StorageWalkEntry = { relativePath, kind: 'directory', identity: childIdentity }
            await options.admit?.(candidate)
            yield candidate
            yield* this.#walkDirectory(child, relativePath, rejectUnsafe, options)
          } finally {
            await child.close()
          }
          continue
        }
        if (listed.isFile()) {
          let file: FileHandle
          try {
            file = await openRegularFileAt(directory, entry.name, relativePath)
          } catch (error: unknown) {
            if (!rejectUnsafe && isRejectedPathError(error)) {
              const candidate: StorageWalkEntry = { relativePath, kind: 'other', identity: listedIdentity }
              await options.admit?.(candidate)
              yield candidate
              continue
            }
            throw error
          }
          try {
            const stats = await file.stat()
            assertRegular(stats, relativePath)
            const fileIdentity = identityOf(stats)
            if (!sameIdentity(fileIdentity, listedIdentity)) throw rejectPath(relativePath, 'Local storage file changed during walk')
            const filePath = await descriptorRealPath(file)
            if (!isPathContained(this.#canonicalRoot, filePath)) throw rejectPath(relativePath, 'Local storage file escapes the configured root')
            const candidate: StorageWalkEntry = { relativePath, kind: 'file', identity: fileIdentity }
            await options.admit?.(candidate)
            yield candidate
          } finally {
            await file.close()
          }
          continue
        }
        if (rejectUnsafe) throw rejectPath(relativePath, 'Local storage walk encountered a non-regular entry')
        const candidate: StorageWalkEntry = { relativePath, kind: 'other', identity: listedIdentity }
        await options.admit?.(candidate)
        yield candidate
      }
    } finally {
      if (entries !== undefined) await closeDirectoryIterator(entries)
    }
  }


  async purgeContents (): Promise<void> {
    this.#assertOpen()
    const root = await openRootForOperation(this.#canonicalRoot, this.#rootIdentity, this.#rootAnchor)
    try {
      await this.#purgeDirectory(root, '')
    } finally {
      await root.close()
    }
  }

  async #purgeDirectory (directory: FileHandle, prefix: string): Promise<void> {
    const entries = await readdir(procFdPath(directory.fd), { withFileTypes: true })
    const sorted = entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of sorted) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      canonicalRelativeParts(relativePath)
      const listed = await lstatAt(directory, entry.name, relativePath)
      if (listed === undefined) continue
      const listedIdentity = identityOf(listed)
      if (listed.isSymbolicLink()) {
        const current = await lstatAt(directory, entry.name, relativePath)
        if (current === undefined) continue
        if (!current.isSymbolicLink() || !sameEntryIdentity(listedIdentity, identityOf(current))) throw rejectPath(relativePath, 'Local storage link changed during purge')
        await unlink(procFdPath(directory.fd, entry.name))
        continue
      }
      if (listed.isDirectory()) {
        let child: FileHandle
        try {
          child = await openDirectoryAt(directory, entry.name, relativePath)
        } catch (error: unknown) {
          if (isRejectedPathError(error)) throw rejectPath(relativePath, 'Local storage directory cannot be safely purged')
          throw error
        }
        try {
          const stats = await child.stat()
          assertDirectory(stats, relativePath)
          const childIdentity = identityOf(stats)
          if (!sameIdentity(childIdentity, listedIdentity)) throw rejectPath(relativePath, 'Local storage directory changed during purge')
          const childPath = await descriptorRealPath(child)
          if (!isPathContained(this.#canonicalRoot, childPath)) throw rejectPath(relativePath, 'Local storage directory escapes the configured root')
          await this.#purgeDirectory(child, relativePath)
        } finally {
          await child.close()
        }
        const current = await lstatAt(directory, entry.name, relativePath)
        if (current === undefined) continue
        if (!current.isDirectory() || !sameIdentity(listedIdentity, identityOf(current))) throw rejectPath(relativePath, 'Local storage directory changed during purge')
        await rmdir(procFdPath(directory.fd, entry.name))
        continue
      }
      if (!listed.isFile()) throw rejectPath(relativePath, 'Local storage purge encountered a non-regular entry')
      const file = await openRegularFileAt(directory, entry.name, relativePath)
      try {
        const stats = await file.stat()
        assertRegular(stats, relativePath)
        const fileIdentity = identityOf(stats)
        if (!sameIdentity(fileIdentity, listedIdentity)) throw rejectPath(relativePath, 'Local storage file changed during purge')
      } finally {
        await file.close()
      }
      const current = await lstatAt(directory, entry.name, relativePath)
      if (current === undefined) continue
      if (!current.isFile() || !sameIdentity(listedIdentity, identityOf(current))) throw rejectPath(relativePath, 'Local storage file changed during purge')
      await unlink(procFdPath(directory.fd, entry.name))
    }
  }

  async copyBounded (source: StorageFileHandle, destination: FileHandle, maxBytes: number): Promise<number> {
    this.#assertOpen()
    return copyBounded(source, destination, maxBytes)
  }

  async close (): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#closePromise = this.#rootAnchor.close()
    return this.#closePromise
  }
}

export async function openStorageRoot (rootPath: string): Promise<StorageRootHandle> {
  assertLinuxSupport()
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(rootPath)
  } catch (error: unknown) {
    if (isRejectedPathError(error)) throw unavailable('Configured local storage root cannot be canonicalized')
    throw error
  }
  let root: FileHandle
  try {
    root = await open(canonicalRoot, ROOT_FLAGS())
  } catch (error: unknown) {
    if (isRejectedPathError(error)) throw unavailable('Configured local storage root must be a Linux directory')
    throw error
  }
  try {
    const stats = await root.stat()
    assertDirectory(stats, '.')
    const identity = identityOf(stats)
    const descriptorPath = await descriptorRealPath(root)
    if (descriptorPath !== canonicalRoot || !isPathContained(canonicalRoot, descriptorPath)) {
      throw unavailable('Configured local storage root is not descriptor-confined')
    }
    return new StorageRootHandle(canonicalRoot, root, identity)
  } catch (error: unknown) {
    try {
      await root.close()
    } catch {
      // Preserve the validation error.
    }
    throw error
  }
}

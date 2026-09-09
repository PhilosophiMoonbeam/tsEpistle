import type { StorageConfig, StorageAssetIdentity, StorageContext, StoragePlugin, UnknownRecord } from '../../types.ts'
import { wiki } from '../../types.ts'
import fs from 'fs-extra'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import moment from 'moment'
import { randomUUID } from 'node:crypto'

import pageHelper from '../../../helpers/page.ts'
import commonDisk from './common.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
import { okfFilePath } from '../../../okf/format.ts'
import {
  openStorageRoot,
  type StorageFileHandle,
  type StorageRootHandle,
  type StorageWalkEntry
} from '../local-filesystem.ts'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ENTRIES, ImportBudget } from '../import-budget.ts'
import { isStorageInternalPath, isStorageReservedPath } from '../internal-path.ts'
import type { StorageLocalLocation } from '../../types.ts'

interface DiskStorageContext extends StorageContext<StorageConfig> {
  root: StorageRootHandle | null
  backupLimits?: Partial<StorageBackupLimits>
  deactivated(): Promise<void>
  sync(options?: { manual: boolean }): Promise<void>
}

interface PageExportRow {
  id: number
  path: string
  localeCode: string
  title: string
  description: string
  contentType: string
  content: string | Record<string, unknown>
  sourceRevision: string | number
  authorId: number
  createdAt: Date | string
  updatedAt: Date | string
  extra: Record<string, unknown>
  isPublished: boolean
  editorKey: string
}

interface PageTag extends UnknownRecord {
  tag: string
}

interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

function isPageExportRow (value: unknown): value is PageExportRow {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value && typeof value.id === 'number' &&
    'path' in value && typeof value.path === 'string' &&
    'localeCode' in value && typeof value.localeCode === 'string' &&
    'title' in value && typeof value.title === 'string' &&
    'description' in value && typeof value.description === 'string' &&
    'contentType' in value && typeof value.contentType === 'string' &&
    'content' in value &&
    (typeof value.content === 'string' ||
      (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    'sourceRevision' in value && (typeof value.sourceRevision === 'string' || typeof value.sourceRevision === 'number') &&
    'authorId' in value && typeof value.authorId === 'number' &&
    'createdAt' in value && (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    'updatedAt' in value && (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    'extra' in value && typeof value.extra === 'object' && value.extra !== null && !Array.isArray(value.extra) &&
    'isPublished' in value && typeof value.isPublished === 'boolean' &&
    'editorKey' in value && typeof value.editorKey === 'string'
}

function isAssetExportRow (value: unknown): value is AssetExportRow {
  return typeof value === 'object' &&
    value !== null &&
    'filename' in value && typeof value.filename === 'string' &&
    'folderId' in value && (value.folderId === null || typeof value.folderId === 'number') &&
    'data' in value && Buffer.isBuffer(value.data)
}

function serializeContent (content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function serializePage (page: StoragePageEncodingInput): string {
  const encoded = encodeStoragePageDocument(page)
  if (page.contentType === 'markdown') {
    if (typeof encoded === 'object' && encoded !== null && 'markdown' in encoded && typeof encoded.markdown === 'string') return encoded.markdown
    throw new TypeError('Markdown page encoder did not return a document')
  }
  if (typeof encoded === 'string') return encoded
  const serialized = JSON.stringify(encoded)
  if (serialized === undefined) throw new TypeError('Page encoder returned an unserializable document')
  return serialized
}

function storageRootPath (config: StorageConfig): string {
  return path.resolve(wiki.ROOTPATH, config.path)
}

function requireRoot (context: DiskStorageContext): StorageRootHandle {
  if (context.root === null || context.root === undefined || context.root.closed) throw new Error('Disk storage is not initialized')
  return context.root
}

const TAR_BLOCK_BYTES = 512
const TAR_END_BLOCKS = 2
const BACKUP_OUTPUT_MAX_BYTES = 272 * 1024 * 1024
const BACKUP_READ_CHUNK_BYTES = 64 * 1024

interface StorageBackupLimits {
  maxEntries: number
  maxRawBytes: number
  maxOutputBytes: number
}

/** Internal limits are intentionally not part of the storage module configuration. */
export const backupArchiveLimits: StorageBackupLimits = {
  maxEntries: IMPORT_MAX_ENTRIES,
  maxRawBytes: IMPORT_MAX_BYTES,
  maxOutputBytes: BACKUP_OUTPUT_MAX_BYTES
}

function tarPathParts (relativePath: string): { name: string; prefix?: string } {
  const encodedLength = Buffer.byteLength(relativePath)
  if (encodedLength <= 100) return { name: relativePath }
  const slashPositions: number[] = []
  for (let index = relativePath.indexOf('/'); index >= 0; index = relativePath.indexOf('/', index + 1)) slashPositions.push(index)
  for (const slash of slashPositions.reverse()) {
    const prefix = relativePath.slice(0, slash)
    const name = relativePath.slice(slash + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
  }
  throw new RangeError(`Backup path is too long for a ustar archive: ${relativePath}`)
}

function writeTarOctal (header: Buffer, offset: number, length: number, value: number): void {
  const digits = Math.max(0, Math.floor(value)).toString(8)
  if (digits.length > length - 1) throw new RangeError('Backup archive field is too large')
  const encoded = digits.padStart(length - 1, '0') + '\0'
  header.write(encoded, offset, length, 'ascii')
}

function tarHeader (entry: StorageWalkEntry, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES)
  const parts = tarPathParts(entry.relativePath)
  header.write(parts.name, 0, 100, 'utf8')
  writeTarOctal(header, 100, 8, entry.identity.mode & 0o7777)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, size)
  writeTarOctal(header, 136, 12, entry.identity.mtimeMs / 1000)
  header.fill(0x20, 148, 156)
  header[156] = entry.kind === 'directory' ? 0x35 : 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  if (parts.prefix) header.write(parts.prefix, 345, 155, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = checksum.toString(8).padStart(6, '0') + '\0 '
  header.write(checksumText, 148, 8, 'ascii')
  return header
}

function assertBackupLimit (value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
}

function normalizeBackupLimits (limits: Partial<StorageBackupLimits> | undefined): StorageBackupLimits {
  const normalized = {
    maxEntries: limits?.maxEntries ?? backupArchiveLimits.maxEntries,
    maxRawBytes: limits?.maxRawBytes ?? backupArchiveLimits.maxRawBytes,
    maxOutputBytes: limits?.maxOutputBytes ?? backupArchiveLimits.maxOutputBytes
  }
  assertBackupLimit(normalized.maxEntries, 'Backup entry limit')
  assertBackupLimit(normalized.maxRawBytes, 'Backup raw byte limit')
  assertBackupLimit(normalized.maxOutputBytes, 'Backup output byte limit')
  return normalized
}

function sameBackupIdentity (
  expected: StorageWalkEntry['identity'],
  actual: { dev: number; ino: number; size: number; mode: number; mtimeMs: number }
): boolean {
  return expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mode === actual.mode &&
    expected.mtimeMs === actual.mtimeMs
}

function assertBackupIdentity (
  expected: StorageWalkEntry['identity'],
  actual: { dev: number; ino: number; size: number; mode: number; mtimeMs: number },
  relativePath: string
): void {
  if (!sameBackupIdentity(expected, actual)) {
    throw new Error(`Backup source changed during archive: ${relativePath}`)
  }
}

async function *readBackupFileChunks (
  source: StorageFileHandle,
  entry: StorageWalkEntry
): AsyncGenerator<Uint8Array> {
  const expected = entry.identity
  const size = expected.size
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`Backup source has an invalid size: ${entry.relativePath}`)
  const before = await source.handle.stat()
  if (!before.isFile()) throw new Error(`Backup source is no longer a regular file: ${entry.relativePath}`)
  assertBackupIdentity(expected, before, entry.relativePath)

  let offset = 0
  while (offset < size) {
    const chunk = Buffer.allocUnsafe(Math.min(BACKUP_READ_CHUNK_BYTES, size - offset))
    const result = await source.handle.read(chunk, 0, chunk.byteLength, offset)
    if (result.bytesRead === 0) throw new Error(`Backup source shrank during archive: ${entry.relativePath}`)
    offset += result.bytesRead
    yield chunk.subarray(0, result.bytesRead)
  }

  const probe = Buffer.allocUnsafe(1)
  const probeResult = await source.handle.read(probe, 0, 1, size)
  if (probeResult.bytesRead !== 0) throw new Error(`Backup source grew during archive: ${entry.relativePath}`)
  const after = await source.handle.stat()
  if (!after.isFile()) throw new Error(`Backup source is no longer a regular file: ${entry.relativePath}`)
  assertBackupIdentity(expected, after, entry.relativePath)
}

function backupShouldSkip (relativePath: string): boolean {
  if (isStorageInternalPath(relativePath)) return true
  return isStorageReservedPath(relativePath)
}

async function *tarChunks (
  root: StorageRootHandle,
  limits: StorageBackupLimits
): AsyncGenerator<Uint8Array> {
  const budget = new ImportBudget(limits.maxEntries, limits.maxRawBytes)
  for await (const entry of root.walk({
    shouldSkip: backupShouldSkip,
    admit: candidate => {
      if (candidate.kind === 'directory') {
        budget.reserve()
        return
      }
      if (candidate.kind === 'file') {
        budget.reserve(candidate.identity.size)
        return
      }
      throw new Error(`Backup encountered an unsafe storage entry: ${candidate.relativePath}`)
    }
  })) {
    if (entry.kind === 'directory') {
      yield tarHeader(entry, 0)
      continue
    }
    if (entry.kind !== 'file') throw new Error(`Backup encountered an unsafe storage entry: ${entry.relativePath}`)

    let source: StorageFileHandle | undefined
    try {
      source = await root.openFile(entry.relativePath, entry.identity)
      assertBackupIdentity(entry.identity, source.identity, entry.relativePath)
      yield tarHeader(entry, entry.identity.size)
      for await (const chunk of readBackupFileChunks(source, entry)) yield chunk
      const padding = (TAR_BLOCK_BYTES - (entry.identity.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
      if (padding > 0) yield Buffer.alloc(padding)
      const verified = await root.openFile(entry.relativePath, entry.identity)
      try {
        assertBackupIdentity(entry.identity, verified.identity, entry.relativePath)
      } finally {
        await verified.close()
      }
    } finally {
      if (source !== undefined) await source.close()
    }
  }
  yield Buffer.alloc(TAR_BLOCK_BYTES * TAR_END_BLOCKS)
}

async function *gzipChunks (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const input = Readable.from(source)
  const gzip = zlib.createGzip()
  const transfer = pipeline(input, gzip)
  try {
    for await (const chunk of gzip) yield chunk as Buffer
    await transfer
  } finally {
    input.destroy()
    gzip.destroy()
    await transfer.catch(() => {})
  }
}


const plugin: StoragePlugin<StorageConfig, DiskStorageContext> & {
  root: StorageRootHandle | null
  backupLimits: StorageBackupLimits
} = {
  root: null,
  backupLimits: backupArchiveLimits,
  async activated () {},
  async deactivated () {
    const root = this.root
    this.root = null
    if (root) await root.close()
  },
  async init () {
    wiki.logger.info('(STORAGE/DISK) Initializing...')
    await this.deactivated()
    const rootPath = storageRootPath(this.config)
    // The configured root is application-owned bootstrap state; every child operation uses S0.
    await fs.ensureDir(rootPath)
    this.root = await openStorageRoot(rootPath)
    wiki.logger.info('(STORAGE/DISK) Initialization completed.')
  },
  async sync ({ manual } = { manual: false }) {
    if (!this.config.createDailyBackups && !manual) return
    const root = requireRoot(this)
    const directory = manual ? '_manual' : '_daily'
    await root.ensureDirectory(directory)
    const dateFilename = manual ? `${moment().format('YYYYMMDD-HHmmss')}-${randomUUID()}` : moment().format('DD')
    const archivePath = `${directory}/wiki-${dateFilename}.tar.gz`
    wiki.logger.info('(STORAGE/DISK) Creating backup archive...')
    const limits = normalizeBackupLimits(this.backupLimits)
    await root.writeAtomicStream(archivePath, gzipChunks(tarChunks(root, limits)), limits.maxOutputBytes)
    wiki.logger.info('(STORAGE/DISK) Backup archive created successfully.')
  },
  async created (page) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Creating file [${page.localeCode}] ${page.path}...`)
    const fileName = pageFileName(page, true)
    await root.writeAtomic(fileName, serializePage(page))
  },
  async updated (page) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Updating file [${page.localeCode}] ${page.path}...`)
    const fileName = pageFileName(page, true)
    await root.writeAtomic(fileName, serializePage(page))
  },
  async deleted (page) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Deleting file [${page.localeCode}] ${page.path}...`)
    const fileName = pageFileName(page, true)
    await root.removeFile(fileName)
  },
  async renamed (page) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Renaming file [${page.localeCode}] ${page.path} to [${page.destinationLocaleCode}] ${page.destinationPath}...`)
    const sourceFileName = pageFileName({
      path: page.path,
      localeCode: page.localeCode,
      contentType: page.contentType
    }, wiki.config.lang.namespacing)
    const destinationFileName = pageFileName({
      path: page.destinationPath,
      localeCode: page.destinationLocaleCode,
      contentType: page.contentType
    }, wiki.config.lang.namespacing)
    await root.ensureDirectory(path.posix.dirname(destinationFileName) === '.' ? '' : path.posix.dirname(destinationFileName))
    await root.move(sourceFileName, destinationFileName)
  },
  async assetUploaded (asset) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Creating new file ${asset.path}...`)
    await root.writeAtomic(asset.path, asset.data)
  },
  async assetDeleted (asset) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Deleting file ${asset.path}...`)
    await root.removeFile(asset.path)
  },
  async assetRenamed (asset) {
    const root = requireRoot(this)
    wiki.logger.info(`(STORAGE/DISK) Renaming file from ${asset.path} to ${asset.destinationPath}...`)
    await root.ensureDirectory(path.posix.dirname(asset.destinationPath) === '.' ? '' : path.posix.dirname(asset.destinationPath))
    await root.move(asset.path, asset.destinationPath)
  },
  async getLocalLocation (asset: StorageAssetIdentity): Promise<StorageLocalLocation | void> {
    if (typeof asset.path !== 'string' || isStorageInternalPath(asset.path) || isStorageReservedPath(asset.path)) return
    const root = requireRoot(this)
    return {
      open: async () => root.openFile(asset.path)
    }
  },
  async dump () {
    const root = requireRoot(this)
    wiki.logger.info('(STORAGE/DISK) Dumping all content to disk...')
    await pipeline(
      wiki.models.knex.column(
        'id', 'path', 'localeCode', 'title', 'description', 'contentType', 'content',
        'sourceRevision', 'authorId', 'extra', 'isPublished', 'updatedAt', 'createdAt', 'editorKey'
      ).select().from('pages').where({ visibility: 'public' }).stream(),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isPageExportRow(value)) throw new TypeError('Invalid page export row')
            const pageObject = await wiki.models.pages.query().findOne({ id: value.id })
            if (!pageObject) throw new Error(`Page ${value.id} was not found`)
            const tags = await pageObject.$relatedQuery('tags')
            if (!tags.every((tag): tag is PageTag => typeof tag.tag === 'string')) throw new TypeError(`Invalid tags for page ${value.id}`)
            const page = { ...value, tags }
            const fileName = pageFileName(page, true)
            wiki.logger.info(`(STORAGE/DISK) Dumping page ${fileName}...`)
            await root.writeAtomic(fileName, serializePage(page))
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

    const assetFolders = await wiki.models.assetFolders.getAllPaths()
    await pipeline(
      wiki.models.knex.column('filename', 'folderId', 'data').select().from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isAssetExportRow(value)) throw new TypeError('Invalid asset export row')
            let filename = value.filename
            if (value.folderId !== null && value.folderId > 0) {
              const folderPath = assetFolders[value.folderId]
              if (!folderPath) throw new Error(`Asset folder ${value.folderId} was not found`)
              filename = `${folderPath}/${filename}`
            }
            wiki.logger.info(`(STORAGE/DISK) Dumping asset ${filename}...`)
            await root.writeAtomic(filename, value.data)
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )
    wiki.logger.info('(STORAGE/DISK) All content was dumped to disk successfully.')
  },
  async backup () {
    return this.sync({ manual: true })
  },
  async importAll () {
    const root = requireRoot(this)
    wiki.logger.info('(STORAGE/DISK) Importing all content from local disk folder to the DB...')
    const results = await commonDisk.importFromDisk({ root, moduleName: 'DISK' })
    wiki.logger.info('(STORAGE/DISK) Import completed.')
    return results
  }
}

function pageFileName (
  page: { localeCode: string; path: string; contentType: string },
  namespaceNonDefaultLocale: boolean
): string {
  if (page.contentType === 'markdown') return okfFilePath(page.localeCode, page.path)
  const legacyFileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
  return namespaceNonDefaultLocale && wiki.config.lang.code !== page.localeCode
    ? `${page.localeCode}/${legacyFileName}`
    : legacyFileName
}

export default plugin

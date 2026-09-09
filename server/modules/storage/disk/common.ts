import path from 'node:path'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import mimeTypesModule from 'mime-types'
import _ from 'lodash'
import pageHelper from '../../../helpers/page.ts'

import { wiki, type WikiUser } from '../../types.ts'
import type {
  StorageFileIdentityExpectation,
  StorageFileHandle,
  StorageRootHandle,
  StorageWalkEntry
} from '../local-filesystem.ts'
import { isStorageGitMetadataPath } from '../internal-path.ts'
import { OKF_MAX_DOCUMENT_BYTES, parseOkfFilePath } from '../../../okf/format.ts'
import type { StorageImportResult, StoragePageProcessResult } from '../types.ts'
import { classifyStoragePageDocument } from '../page-document.ts'
import { IMPORT_MAX_ASSET_BYTES, IMPORT_MAX_ENTRIES, ImportBudget, boundedImportAssetLimit } from '../import-budget.ts'

const mime = mimeTypesModule.lookup

interface ImportSource {
  root: StorageRootHandle
  moduleName: 'DISK' | 'GIT'
  maxAssetBytes?: number
  admission?: StorageImportAdmission
}

export interface ImportFile {
  readonly relPath: string
  readonly stats: StorageFileIdentityExpectation
}

export interface StorageImportFile {
  readonly file: ImportFile
  readonly contentType?: string
}

export interface StorageImportAdmission {
  readonly root: StorageRootHandle
  readonly budget: ImportBudget
  readonly entries: readonly StorageWalkEntry[]
  readonly filesByPath: ReadonlyMap<string, StorageWalkEntry>
  readonly files: readonly StorageImportFile[]
}

export interface StorageInventoryOptions {
  readonly budget?: ImportBudget
  readonly maxAssetBytes?: number
  readonly shouldSkip?: (relativePath: string) => boolean
}

interface ImportPageSource {
  root: StorageRootHandle
  contentType: string
  relPath: string
  user: WikiUser
  source?: StorageFileHandle
}

interface ImportAssetSource {
  file: ImportFile
  root: StorageRootHandle
  moduleName: 'DISK' | 'GIT'
  relPath: string
  user: WikiUser
  maxAssetBytes?: number
  source?: StorageFileHandle
}

function toError (value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function errorCode (value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  const code = value.code
  return typeof code === 'string' ? code : undefined
}

export function isImportSourceMissing (value: unknown): boolean {
  return errorCode(value) === 'ENOENT'
}

function importAssetLimit (override?: number): number {
  const configured = override ?? wiki.config.uploads.maxFileSize
  return boundedImportAssetLimit(configured ?? IMPORT_MAX_ASSET_BYTES)
}
export async function collectStorageEntries (
  root: StorageRootHandle,
  options: StorageInventoryOptions = {}
): Promise<StorageImportAdmission> {
  const budget = options.budget ?? new ImportBudget()
  const entries: StorageWalkEntry[] = []
  const filesByPath = new Map<string, StorageWalkEntry>()
  const files: StorageImportFile[] = []
  const assetLimit = options.maxAssetBytes === undefined ? undefined : importAssetLimit(options.maxAssetBytes)
  const shouldSkip = (relativePath: string): boolean =>
    isStorageGitMetadataPath(relativePath) || options.shouldSkip?.(relativePath) === true

  const admit = (entry: StorageWalkEntry): void => {
    budget.reserve(entry.kind === 'file' ? entry.identity.size : 0)
    entries.push(entry)
    if (entry.kind !== 'file') return
    filesByPath.set(entry.relativePath, entry)
    if (entry.identity.size < 1 || entry.relativePath.length <= 3) return
    const contentType = pageHelper.getContentType(entry.relativePath)
    if (contentType) {
      if (entry.identity.size > OKF_MAX_DOCUMENT_BYTES) {
        throw new RangeError(`Imported page exceeds ${OKF_MAX_DOCUMENT_BYTES} bytes: ${entry.relativePath}`)
      }
      files.push({
        file: { relPath: entry.relativePath, stats: entry.identity },
        contentType
      })
      return
    }
    if (assetLimit !== undefined && entry.identity.size > assetLimit) {
      throw new RangeError(`Imported asset exceeds ${assetLimit} bytes: ${entry.relativePath}`)
    }
    files.push({ file: { relPath: entry.relativePath, stats: entry.identity } })
  }

  for await (const _entry of root.walk({ shouldSkip, admit })) {
    // Admission occurs before yielding; consuming the stream completes descriptor cleanup.
  }

  return { root, budget, entries, filesByPath, files }
}

export async function validateStoragePaths (
  root: StorageRootHandle,
  paths: readonly string[],
  admission?: StorageImportAdmission
): Promise<void> {
  const seen = new Set<string>()
  for (const relativePath of paths) {
    if (!relativePath || seen.has(relativePath)) continue
    if (seen.size >= (admission?.budget.maxEntries ?? IMPORT_MAX_ENTRIES)) {
      throw new RangeError(`Import exceeds ${admission?.budget.maxEntries ?? IMPORT_MAX_ENTRIES}-entry limit while validating paths`)
    }
    seen.add(relativePath)
    const expected = admission?.filesByPath.get(relativePath)?.identity
    if (admission !== undefined && expected === undefined) admission.budget.reserve(0)
    let source: StorageFileHandle | undefined
    try {
      source = await root.openFile(relativePath, expected)
    } catch (error: unknown) {
      if (!isImportSourceMissing(error)) throw error
      continue
    }
    await source.close()
  }
}


async function stageAsset (source: StorageFileHandle, maxBytes: number): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wiki-storage-import-'))
  try {
    await chmod(directory, 0o700)
    const stagedPath = path.join(directory, 'asset')
    const staged = await open(stagedPath, 'wx', 0o600)
    try {
      const copied = await source.copyTo(staged, maxBytes)
      if (copied !== source.stats.size) throw new Error(`Imported asset size changed: ${source.relativePath}`)
    } finally {
      await staged.close()
    }
    return { directory, path: stagedPath }
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}


const plugin = {
  assetFolders: null as Record<number, string> | null,

  async importFromDisk ({
    root,
    moduleName,
    maxAssetBytes,
    admission
  }: ImportSource): Promise<StorageImportResult[]> {
    const assetLimit = importAssetLimit(maxAssetBytes)
    const plan = admission ?? await collectStorageEntries(root, { maxAssetBytes: assetLimit })
    if (plan.root !== root) throw new Error('Storage import admission belongs to a different root')
    for (const item of plan.files) {
      if (item.contentType) {
        if (item.file.stats.size !== undefined && item.file.stats.size > OKF_MAX_DOCUMENT_BYTES) {
          throw new RangeError(`Imported page exceeds ${OKF_MAX_DOCUMENT_BYTES} bytes: ${item.file.relPath}`)
        }
      } else if (item.file.stats.size !== undefined && item.file.stats.size > assetLimit) {
        throw new RangeError(`Imported asset exceeds ${assetLimit} bytes: ${item.file.relPath}`)
      }
    }

    const rootUser = await wiki.models.users.getRootUser()
    const results: StorageImportResult[] = []
    for (const item of plan.files) {
      let source: StorageFileHandle | undefined
      try {
        source = await root.openFile(item.file.relPath, item.file.stats)
        wiki.logger.info(`(STORAGE/${moduleName}) Processing ${item.file.relPath}...`)
        if (item.contentType) {
          const pageResult = await this.processPage({
            user: rootUser,
            relPath: item.file.relPath,
            root,
            contentType: item.contentType,
            moduleName,
            source
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process page ${item.file.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          await this.processAsset({
            user: rootUser,
            relPath: item.file.relPath,
            root,
            file: item.file,
            moduleName,
            maxAssetBytes: assetLimit,
            source
          })
          results.push({ kind: 'asset', relPath: item.file.relPath, ok: true })
        }
      } catch (error: unknown) {
        const message = toError(error).message
        results.push({
          kind: item.contentType ? 'page' : 'asset',
          relPath: item.file.relPath,
          ok: false,
          error: message
        })
        wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process ${item.contentType ? 'page' : 'asset'} ${item.file.relPath}`)
        wiki.logger.warn(message)
      } finally {
        if (source) await source.close()
      }
    }
    this.clearFolderCache()
    return results
  },

  async processPage ({ user, root, relPath, contentType, moduleName, source }: ImportPageSource & { moduleName: 'DISK' | 'GIT' }): Promise<StoragePageProcessResult> {
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    const contentPath = pageHelper.getPagePath(normalizedRelPath)
    const secureSource = source ?? await root.openFile(normalizedRelPath)
    const closeSource = source === undefined
    try {
      const itemContents = await secureSource.readBounded(OKF_MAX_DOCUMENT_BYTES)
      const okfProducer = moduleName === 'DISK' ? 'import:disk' : 'import:git'
      const document = classifyStoragePageDocument({
        rawDocument: itemContents,
        contentType,
        locale: contentPath.locale,
        pagePath: contentPath.path,
        importer: okfProducer
      })
      if (document.format === 'okf_invalid') {
        return {
          relPath: normalizedRelPath,
          format: document.format,
          sha256: document.sha256,
          ok: false,
          document,
          error: document.diagnostics.join('; ') || 'Invalid OKF document'
        }
      }
      let pageIdentity = contentPath
      if (document.format === 'okf_valid') {
        const canonicalIdentity = parseOkfFilePath(normalizedRelPath)
        if (canonicalIdentity === null) {
          return {
            relPath: normalizedRelPath,
            format: document.format,
            sha256: document.sha256,
            ok: false,
            document,
            error: `OKF page path is not canonical: ${normalizedRelPath}`
          }
        }
        pageIdentity = {
          locale: canonicalIdentity.locale,
          path: canonicalIdentity.pagePath
        }
      }
      const currentPage = await wiki.models.pages.getPageFromDb({
        path: pageIdentity.path,
        locale: pageIdentity.locale,
        visibility: 'public',
        ownerId: null
      })
      const currentPublishedState = currentPage && 'isPublished' in currentPage && typeof currentPage.isPublished === 'boolean' ? currentPage.isPublished : true
      if (currentPage) {
        wiki.logger.info(`(STORAGE/${moduleName}) Page marked as modified: ${normalizedRelPath}`)
        const page = await wiki.models.pages.updatePage({
          id: currentPage.id,
          expectedSourceRevision: String(currentPage.sourceRevision),
          title: document.title ?? currentPage.title,
          description: document.description ?? currentPage.description ?? '',
          tags:
            document.format === 'okf_valid'
              ? document.tags
              : document.tags.length > 0
                ? document.tags
                : currentPage.tags.flatMap(tag => (typeof tag.tag === 'string' ? [tag.tag] : [])),
          isPublished: document.isPublished ?? currentPublishedState,
          visibility: 'public',
          content: document.body,
          user,
          okfMetadata: document.okfMetadata ?? undefined,
          okfProducer,
          skipStorage: true
        })
        return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
      }
      wiki.logger.info(`(STORAGE/${moduleName}) Page marked as new: ${normalizedRelPath}`)
      const editors = wiki.models.editors
      const getDefaultEditor: (contentType: string) => Promise<string> = editors.getDefaultEditor
      const pageEditor = await getDefaultEditor.call(editors, contentType)
      const page = await wiki.models.pages.createPage({
        path: pageIdentity.path,
        locale: pageIdentity.locale,
        title: document.title ?? pageIdentity.path.split('/').at(-1) ?? pageIdentity.path,
        description: document.description ?? '',
        tags: document.tags,
        isPublished: document.isPublished ?? true,
        visibility: 'public',
        content: document.body,
        user,
        editor: pageEditor,
        okfMetadata: document.okfMetadata ?? undefined,
        okfProducer,
        skipStorage: true
      })
      return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
    } finally {
      if (closeSource) await secureSource.close()
    }
  },

  async resolveAssetFolder (relPath: string): Promise<number | null> {
    if (!this.assetFolders) this.assetFolders = await wiki.models.assetFolders.getAllPaths()
    const assetFolders = this.assetFolders
    const folderPath = path.posix.dirname(relPath.replace(/\\/g, '/'))
    let folderId: number | null = _.toInteger(_.findKey(assetFolders, folder => folder === folderPath)) || null

    if (!folderId && folderPath !== '.') {
      const folderParts = folderPath.split('/')
      const currentFolderPath: string[] = []
      let currentFolderParentId: number | null = null
      for (const folderPart of folderParts) {
        currentFolderPath.push(folderPart)
        const currentPath = currentFolderPath.join('/')
        const existingFolderId = _.findKey(assetFolders, folder => folder === currentPath)
        if (!existingFolderId) {
          const newFolder = await wiki.models.assetFolders.query().insert({
            slug: folderPart,
            name: folderPart,
            parentId: currentFolderParentId
          })
          const newFolderId = _.toInteger((newFolder as { id?: unknown }).id)
          if (newFolderId < 1) throw new TypeError('Invalid asset folder id')
          assetFolders[newFolderId] = currentPath
          currentFolderParentId = newFolderId
        } else {
          currentFolderParentId = _.toInteger(existingFolderId)
        }
      }
      folderId = currentFolderParentId
    }
    return folderId
  },

  async processAsset ({ user, root, relPath, file, moduleName, maxAssetBytes, source }: ImportAssetSource): Promise<void> {
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    wiki.logger.info(`(STORAGE/${moduleName}) Asset marked for import: ${normalizedRelPath}`)
    const secureSource = source ?? await root.openFile(normalizedRelPath, file.stats)
    const closeSource = source === undefined
    let stagedDirectory: string | undefined
    try {
      const assetLimit = importAssetLimit(maxAssetBytes)
      if (secureSource.stats.size > assetLimit) throw new RangeError(`Imported asset exceeds ${assetLimit} bytes: ${normalizedRelPath}`)
      const filePathInfo = path.posix.parse(normalizedRelPath)
      const folderId = await this.resolveAssetFolder(normalizedRelPath)
      const staged = await stageAsset(secureSource, assetLimit)
      stagedDirectory = staged.directory

      await wiki.models.assets.upload({
        mode: 'import',
        originalname: filePathInfo.base,
        ext: filePathInfo.ext,
        mimetype: mime(filePathInfo.base) || 'application/octet-stream',
        size: secureSource.stats.size,
        maxBytes: assetLimit,
        folderId,
        path: staged.path,
        assetPath: normalizedRelPath,
        user,
        skipStorage: true
      })
    } finally {
      if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true })
      if (closeSource) await secureSource.close()
    }
  },

  clearFolderCache (): void {
    this.assetFolders = null
  }
}

export default plugin

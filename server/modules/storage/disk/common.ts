import path from 'node:path'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import mimeTypesModule from 'mime-types'
import _ from 'lodash'
import pageHelper from '../../../helpers/page.ts'

import type { WikiRuntime, WikiUser, QueryBuilder, UnknownRecord } from '../../types.ts'
import type { StorageFileIdentityExpectation, StorageFileHandle, StorageRootHandle, StorageWalkEntry } from '../local-filesystem.ts'
import { isStorageGitMetadataPath } from '../internal-path.ts'
import { OKF_MAX_DOCUMENT_BYTES, parseOkfFilePath } from '../../../okf/format.ts'
import type { StorageImportResult, StoragePageProcessResult } from '../types.ts'
import { classifyStoragePageImport, type StoragePageIngestionOptions } from '../page-document.ts'
import { IMPORT_MAX_ASSET_BYTES, IMPORT_MAX_ENTRIES, ImportBudget, boundedImportAssetLimit } from '../import-budget.ts'
import { assertStorageAssetDestinationAllowed } from '../../../helpers/storage-path-admission.ts'
import type { CanonicalTransactionHook } from '../../../models/pages.ts'
import {
  loadStoragePageImportOwners,
  recordStoragePageImportOwner,
  storagePageImportOwnerMatches,
  type StoragePageImportMoveBinding
} from '../../../helpers/storage-page-import-owner.ts'
import {
  guardStorageImportReview,
  prepareStorageImportIdentities,
  type StorageImportResolvedPage,
  type StorageImportIdentityPlan,
  type StorageAssetImportReview
} from '../import-identity.ts'
import { collectGitContentEntries } from '../git/content-visibility.ts'
import { assertGitPath } from '../git/admission.ts'
import { currentGitMutationTurn } from '../git/mutation-lock.ts'

const mime = mimeTypesModule.lookup

const getWiki = (): WikiRuntime => {
  const runtime = globalThis as unknown as { WIKI: WikiRuntime }
  return runtime.WIKI
}

interface ImportSource {
  root: StorageRootHandle
  moduleName: 'DISK' | 'GIT'
  maxAssetBytes?: number
  admission?: StorageImportAdmission
  ingestion?: StoragePageIngestionOptions
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
  ingestion?: StoragePageIngestionOptions
  identity?: StorageImportResolvedPage
  noOpOnly?: boolean
  acceptedMoveBinding?: StoragePageImportMoveBinding
}

interface ImportAssetSource {
  file: ImportFile
  root: StorageRootHandle
  moduleName: 'DISK' | 'GIT'
  relPath: string
  user: WikiUser
  maxAssetBytes?: number
  source?: StorageFileHandle
  expectedSha256?: string
  importReview?: StorageAssetImportReview
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  const code = value.code
  return typeof code === 'string' ? code : undefined
}

export function isImportSourceMissing(value: unknown): boolean {
  return errorCode(value) === 'ENOENT'
}

function importAssetLimit(override?: number): number {
  const wiki = getWiki()
  const configured = override ?? wiki.config.uploads.maxFileSize
  return boundedImportAssetLimit(configured ?? IMPORT_MAX_ASSET_BYTES)
}
export async function collectStorageEntries(root: StorageRootHandle, options: StorageInventoryOptions = {}): Promise<StorageImportAdmission> {
  const budget = options.budget ?? new ImportBudget()
  const entries: StorageWalkEntry[] = []
  const filesByPath = new Map<string, StorageWalkEntry>()
  const files: StorageImportFile[] = []
  const assetLimit = options.maxAssetBytes === undefined ? undefined : importAssetLimit(options.maxAssetBytes)
  const shouldSkip = (relativePath: string): boolean => isStorageGitMetadataPath(relativePath) || options.shouldSkip?.(relativePath) === true

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

export async function validateStoragePaths(root: StorageRootHandle, paths: readonly string[], admission?: StorageImportAdmission): Promise<void> {
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

/** Preflight every page, regardless of optional README ingestion settings. */
export async function assertStorageImportIdentities(
  admission: StorageImportAdmission,
  ingestion: StoragePageIngestionOptions = {},
  moduleName: 'DISK' | 'GIT'
): Promise<StorageImportIdentityPlan> {
  return prepareStorageImportIdentities(admission, ingestion, moduleName)
}

async function stageAsset(source: StorageFileHandle, maxBytes: number): Promise<{ directory: string; path: string }> {
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

  async importFromDisk({ root, moduleName, maxAssetBytes, admission, ingestion = {} }: ImportSource): Promise<StorageImportResult[]> {
    const wiki = getWiki()
    const assetLimit = importAssetLimit(maxAssetBytes)
    if (admission !== undefined && admission.root !== root) throw new Error('Storage import admission belongs to a different root')
    const plan = moduleName === 'GIT'
      ? await collectGitContentEntries(root, assetLimit)
      : admission ?? (await collectStorageEntries(root, { maxAssetBytes: assetLimit }))
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
    if (moduleName === 'GIT') {
      // The native Git provider captures WIKI at load time and calls this module;
      // defer that plugin boundary until runtime installation to avoid the cycle.
      const provider = (await import('../git/storage.ts')).default
      const files = plan.files.map(item => ({
        file: { stats: item.file.stats }, oldPath: item.file.relPath, relPath: item.file.relPath,
        binary: !item.contentType, status: 'A' as const, insertions: 1, deletions: 0, before: 0, after: 1, importAll: true
      }))
      try {
        return await provider.processFiles.call({ ...provider, root, config: ingestion } as never,
          { admission: plan, files }, await wiki.models.users.getRootUser())
      } finally { this.clearFolderCache() }
    }
    const identities = await assertStorageImportIdentities(plan, ingestion, moduleName)
    const sourceHashes = new Map(identities.preview.entries.map(entry => [entry.sourcePath, entry.sourceSha256]))

    const rootUser = await wiki.models.users.getRootUser()
    const results: StorageImportResult[] = []
    for (const item of plan.files) {
      let source: StorageFileHandle | undefined
      try {
        source = await root.openFile(item.file.relPath, item.file.stats)
        wiki.logger.info(`(STORAGE/${moduleName}) Processing ${item.file.relPath}...`)
        if (item.contentType) {
          const identity = identities.pages.get(item.file.relPath)
          const pageResult = await this.processPage({
            user: rootUser,
            relPath: item.file.relPath,
            root,
            contentType: item.contentType,
            moduleName,
            source,
            ingestion,
            ...(identity === undefined ? {} : { identity })
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process page ${item.file.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          const expectedSha256 = sourceHashes.get(item.file.relPath)
          await this.processAsset({
            user: rootUser,
            relPath: item.file.relPath,
            root,
            file: item.file,
            moduleName,
            maxAssetBytes: assetLimit,
            ...(expectedSha256 == null ? {} : { expectedSha256 }),
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

  async processPage({
    user,
    root,
    relPath,
    contentType,
    moduleName,
    source,
    ingestion = {},
    identity,
    noOpOnly = false,
    acceptedMoveBinding
  }: ImportPageSource & { moduleName: 'DISK' | 'GIT' }): Promise<StoragePageProcessResult> {
    const wiki = getWiki()
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    if (moduleName === 'GIT') assertGitPath(normalizedRelPath)
    let planned = identity
    const secureSource = source ?? (await root.openFile(normalizedRelPath))
    const closeSource = source === undefined
    try {
      const itemContents = await secureSource.readBounded(OKF_MAX_DOCUMENT_BYTES)
      if (planned === undefined) {
        const original = pageHelper.getPagePath(normalizedRelPath)
        const imported = classifyStoragePageImport({
          rawDocument: itemContents, contentType, locale: original.locale, pagePath: original.path,
          importer: moduleName === 'DISK' ? 'import:disk' : 'import:git'
        }, normalizedRelPath, ingestion)
        const document = imported.document
        if (document.format === 'okf_invalid' || (document.format === 'okf_valid' && parseOkfFilePath(normalizedRelPath) === null)) {
          return {
            relPath: normalizedRelPath, format: document.format, sha256: document.sha256, document, ok: false,
            error: document.format === 'okf_invalid'
              ? document.diagnostics.join('; ') || 'Invalid OKF document'
              : `OKF page path is not canonical: ${normalizedRelPath}`
          }
        }
        const inventory = moduleName === 'GIT'
          ? await collectGitContentEntries(root, importAssetLimit())
          : await collectStorageEntries(root)
        planned = (await assertStorageImportIdentities(inventory, ingestion, moduleName)).pages.get(normalizedRelPath)
        if (planned === undefined) throw new Error(`Page has no admitted storage identity: ${normalizedRelPath}`)
      }
      if (createHash('sha256').update(itemContents).digest('hex') !== planned.sourceSha256) {
        throw new Error(`Storage import source changed after preflight: ${normalizedRelPath}`)
      }
      const okfProducer = moduleName === 'DISK' ? 'import:disk' : 'import:git'
      const document = planned.document
      const pageIdentity = planned.identity
      const existingPageId = planned.existingPageId
      const expectedSourceRevision = planned.expectedSourceRevision
      const acceptedOwner = {
        sourceKey: planned.sourceKey,
        sourcePath: normalizedRelPath,
        sourceSha256: planned.sourceSha256,
        locationKey: planned.locationKey,
        mapped: planned.mapped
      }
      const okfMetadata = document.okfMetadata
      const currentPage = await wiki.models.pages.getPageFromDb({
        path: pageIdentity.path,
        locale: pageIdentity.locale,
        visibility: 'public',
        ownerId: null
      })
      if ((currentPage?.id ?? null) !== planned.existingPageId ||
          (currentPage == null ? null : String(currentPage.sourceRevision)) !== planned.expectedSourceRevision) {
        throw new Error(`Storage import destination changed after preflight: ${normalizedRelPath}`)
      }
      await guardStorageImportReview()
      const accepted = currentPage
        ? (await loadStoragePageImportOwners(wiki.models.knex, { pageIds: [currentPage.id], limit: 1 }))[0]
        : undefined
      const matchesNative = accepted !== undefined && currentPage !== null && storagePageImportOwnerMatches(accepted, currentPage)
      const matchesSource = accepted !== undefined && Object.entries(acceptedOwner).every(([key, value]) => Reflect.get(accepted, key) === value)
      const matchesMove = (record: typeof accepted): boolean =>
        acceptedMoveBinding !== undefined && acceptedMoveBinding.phase === 'moved' && record !== undefined &&
        record.status === 'active' && record.pageId === existingPageId &&
        record.nativeRevision === expectedSourceRevision && record.nativeRevision === acceptedMoveBinding.moveNativeRevision &&
        record.nativePath === pageIdentity.path && record.nativeLocaleCode === pageIdentity.locale &&
        record.sourceKey === acceptedOwner.sourceKey && record.locationKey === acceptedOwner.locationKey &&
        record.mapped === acceptedOwner.mapped && record.sourcePath === acceptedMoveBinding.oldSourcePath &&
        record.sourceSha256 === acceptedMoveBinding.oldSourceSha256 &&
        normalizedRelPath === acceptedMoveBinding.newSourcePath && acceptedOwner.sourceSha256 === acceptedMoveBinding.newSourceSha256 &&
        _.isEqual(record.moveBinding, acceptedMoveBinding)
      const completingMove = acceptedMoveBinding !== undefined && matchesNative && matchesMove(accepted)
      if (acceptedMoveBinding !== undefined && !completingMove) throw new Error('Native Git move completion has no exact accepted move binding')
      const gitTurn = moduleName === 'GIT' ? currentGitMutationTurn() : undefined
      const canonicalTransactionHook: CanonicalTransactionHook = async (transaction, committed) => {
        await guardStorageImportReview(transaction)
        await gitTurn?.assertHeld(transaction)
        if (acceptedMoveBinding !== undefined) {
          const [persisted] = await loadStoragePageImportOwners(transaction, { pageIds: [committed.id], limit: 1 })
          if (!matchesMove(persisted)) throw new Error('Native Git move binding changed before completion')
        }
        await recordStoragePageImportOwner(transaction, {
          owner: acceptedOwner,
          pageId: committed.id,
          sourceRevision: committed.sourceRevision,
          outboxId: committed.outboxId,
          ...(acceptedMoveBinding === undefined ? {} : { moveBinding: { ...acceptedMoveBinding, phase: 'completed' } })
        })
        await gitTurn?.assertHeld(transaction)
      }
      const currentPublishedState = currentPage && 'isPublished' in currentPage && typeof currentPage.isPublished === 'boolean' ? currentPage.isPublished : true
      if (currentPage) {
        if (expectedSourceRevision === null) throw new Error(`Storage import destination has no admitted revision: ${normalizedRelPath}`)
        const expectedTags = document.format === 'okf_valid' || document.tags.length > 0 ? [...document.tags].sort() : null
        const currentTags = currentPage.tags.flatMap(tag => typeof tag.tag === 'string' ? [tag.tag] : []).sort()
        const sameState =
            currentPage.content === document.body &&
            (document.title === undefined || document.title === currentPage.title) &&
            (document.description === undefined || document.description === currentPage.description) &&
            (document.isPublished === undefined || document.isPublished === currentPublishedState) &&
            (expectedTags === null || _.isEqual(expectedTags, currentTags))
        if (matchesNative && matchesSource && sameState) {
          return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page: currentPage }
        }
        if (noOpOnly) throw new Error('Native Git replay has no exact owned revision for a write. Preserve this page and preview a fresh, explicitly reviewed native destination ID and revision.')
        if (!completingMove && planned.reviewedReplacement !== true &&
            (!matchesNative || accepted?.sourceKey !== planned.sourceKey || accepted.sourcePath !== normalizedRelPath ||
             accepted.locationKey !== planned.locationKey || accepted.mapped !== planned.mapped)) {
          throw new Error('Storage import has no exact accepted native revision. Preview and explicitly review this destination before replacing it.')
        }
        wiki.logger.info(`(STORAGE/${moduleName}) Page marked as modified: ${normalizedRelPath}`)
        const page = await wiki.models.pages.updatePage({
          id: currentPage.id,
          expectedSourceRevision,
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
          okfMetadata,
          okfProducer,
          skipStorage: true,
          canonicalTransactionHook,
          ...(planned.reviewedReplacement === true || completingMove ? { forceStorageImportWrite: true } : {})
        })
        return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
      }
      if (noOpOnly) throw new Error('Native Git replay has no positively accepted canonical source. Preserve existing records and review a fresh destination.')
      wiki.logger.info(`(STORAGE/${moduleName}) Page marked as new: ${normalizedRelPath}`)
      const editors = wiki.models.editors
      const getDefaultEditor: (contentType: string) => Promise<string> = editors.getDefaultEditor
      const pageEditor = await getDefaultEditor.call(editors, contentType)
      await guardStorageImportReview()
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
        okfMetadata,
        okfProducer,
        skipStorage: true,
        canonicalTransactionHook
      })
      return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
    } finally {
      if (closeSource) await secureSource.close()
    }
  },

  async resolveAssetFolder(relPath: string, transaction?: Knex.Transaction): Promise<number | null> {
    const wiki = getWiki()
    if (transaction !== undefined) {
      const folderPath = path.posix.dirname(relPath.replace(/\\/g, '/'))
      if (folderPath === '.') return null
      const folders = wiki.models.assetFolders as unknown as { query(transaction: Knex.Transaction): QueryBuilder<UnknownRecord> }
      let parentId: number | null = null
      for (const slug of folderPath.split('/')) {
        const existing = await folders.query(transaction).findOne({ slug, parentId })
        const row = existing ?? await folders.query(transaction).insert({ slug, name: slug, parentId })
        const id = _.toInteger((row as { id?: unknown }).id)
        if (id < 1) throw new TypeError('Invalid asset folder id')
        parentId = id
      }
      return parentId
    }
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

  async processAsset({ user, root, relPath, file, moduleName, maxAssetBytes, source, expectedSha256, importReview }: ImportAssetSource): Promise<void> {
    const wiki = getWiki()
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    assertStorageAssetDestinationAllowed(normalizedRelPath)
    wiki.logger.info(`(STORAGE/${moduleName}) Asset marked for import: ${normalizedRelPath}`)
    const secureSource = source ?? (await root.openFile(normalizedRelPath, file.stats))
    const closeSource = source === undefined
    let stagedDirectory: string | undefined
    try {
      const assetLimit = importAssetLimit(maxAssetBytes)
      if (secureSource.stats.size > assetLimit) throw new RangeError(`Imported asset exceeds ${assetLimit} bytes: ${normalizedRelPath}`)
      if (importReview === undefined && expectedSha256 !== undefined && await secureSource.sha256Bounded(assetLimit) !== expectedSha256) {
        throw new Error(`Storage import source changed after preflight: ${normalizedRelPath}`)
      }
      await guardStorageImportReview()
      const filePathInfo = path.posix.parse(normalizedRelPath)
      const folderId = importReview === undefined ? await this.resolveAssetFolder(normalizedRelPath) : null
      const staged = await stageAsset(secureSource, assetLimit)
      stagedDirectory = staged.directory

      await guardStorageImportReview()
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
        ...(importReview === undefined ? {} : {
          importReview: { ...importReview, resolveFolder: (transaction: Knex.Transaction) => this.resolveAssetFolder(normalizedRelPath, transaction) },
          expectedImportSha256: expectedSha256
        }),
        skipStorage: true
      })
    } finally {
      if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true })
      if (closeSource) await secureSource.close()
    }
  },

  clearFolderCache(): void {
    this.assetFolders = null
  }
}

export default plugin

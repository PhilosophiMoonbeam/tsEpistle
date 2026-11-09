import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { hasAsciiControlCharacters } from '../../../shared/text-safety.ts'
import {
  StorageImportReviewSchema,
  type StorageImportReview,
  type StorageImportMapping,
  type StorageImportScope,
  type StorageImportPreview
} from '../../../shared/utility-content-import.ts'
import { storageStableValue } from '../../helpers/storage-configuration-key.ts'
import { IMPORT_MAX_ENTRIES } from './import-budget.ts'
import { classifyStoragePageImport, type StoragePageIngestionOptions } from './page-document.ts'
import type { StoragePageDocument } from './types.ts'
import { OKF_MAX_DOCUMENT_BYTES, parseOkfFilePath } from '../../okf/format.ts'
import pageHelper from '../../helpers/page.ts'
import type { WikiRuntime } from '../types.ts'
import type { StorageImportAdmission } from './disk/common.ts'
export { StorageImportReviewSchema, StorageImportScopeSchema } from '../../../shared/utility-content-import.ts'
import { assertGitPath } from './git/admission.ts'
import {
  gitDotContentPath, gitPreviousContent, gitContentDigest, gitContentChoices,
  resolveGitContentChoices, gitContentAction, refreshGitRetainedSources
} from './git/content-visibility.ts'
import type { StorageGitContentEntry, StorageGitContentChoice } from '../../../shared/utility-content-import.ts'
import assetHelper from '../../helpers/asset.ts'
import {
  loadStoragePageImportOwners, storagePageImportOwnerMatches, type StoragePageImportOwnerRecord
} from '../../helpers/storage-page-import-owner.ts'
export type { StorageImportReview, StorageImportMapping, StorageImportScope, StorageImportPreview } from '../../../shared/utility-content-import.ts'

export interface StoragePageIdentity {
  readonly locale: string
  readonly path: string
}

interface ReviewContext {
  readonly review: StorageImportReview
  readonly guard: () => Promise<void>
  readonly transactionGuard?: (transaction: Knex.Transaction) => Promise<void>
}
const reviewContext = new AsyncLocalStorage<ReviewContext>()

/** The administrative operation supplies its existing authority/settings review fence. */
export function withStorageImportReview<T>(review: unknown, guard: () => Promise<void>, work: () => Promise<T>, transactionGuard?: (transaction: Knex.Transaction) => Promise<void>): Promise<T> {
  const parsed = StorageImportReviewSchema.parse(review)
  const seen = new Set<string>()
  for (const mapping of parsed.mappings) {
    if (seen.has(mapping.sourcePath)) throw new Error(`Duplicate reviewed import mapping: ${mapping.sourcePath}`)
    seen.add(mapping.sourcePath)
    assertNativeStoragePageIdentity(mapping, mapping.sourcePath)
  }
  return reviewContext.run({ review: parsed, guard, ...(transactionGuard === undefined ? {} : { transactionGuard }) }, work)
}

export function currentStorageImportReview(): StorageImportReview | undefined {
  return reviewContext.getStore()?.review
}

export async function guardStorageImportReview(transaction?: Knex.Transaction): Promise<void> {
  const context = reviewContext.getStore()
  if (transaction !== undefined && context?.transactionGuard !== undefined) await context.transactionGuard(transaction)
  else await context?.guard()
}

/** Match native page admission, without native createPage's slash trimming or any spelling rewrite. */
export function assertNativeStoragePageIdentity(identity: StoragePageIdentity, source: string): void {
  if (!identity.locale || !identity.path || identity.path.length > 2048 ||
      /[. \\]/u.test(identity.path) || hasAsciiControlCharacters(identity.path) ||
      identity.path.split('/').some(part => !part) ||
      /[/\\ ]/u.test(identity.locale) || hasAsciiControlCharacters(identity.locale)) {
    throw new Error(`Unsupported native page identity for ${source}; review an explicit valid destination mapping`)
  }
}

export function storageImportIdentityKey(identity: StoragePageIdentity): string {
  return `${identity.locale.normalize('NFC').toLowerCase()}\0${identity.path.normalize('NFC').toLowerCase()}`
}

export function storageImportSourceKey(rootIdentity: string, moduleName: 'DISK' | 'GIT', options: StoragePageIngestionOptions): string {
  return createHash('sha256').update(storageStableValue({
    rootIdentity, moduleName,
    mapReadmeToHome: options.mapReadmeToHome === true,
    ...(moduleName === 'GIT' ? { repoUrl: options.repoUrl ?? '', branch: options.branch ?? '' } : {})
  })).digest('hex')
}

export function storageImportLocationKey(moduleName: 'DISK' | 'GIT', options: StoragePageIngestionOptions): string {
  return createHash('sha256').update(storageStableValue({
    moduleName, mapReadmeToHome: options.mapReadmeToHome === true,
    ...(moduleName === 'DISK'
      ? { path: options.path ?? '' }
      : { repoUrl: options.repoUrl ?? '', branch: options.branch ?? '', localRepoPath: options.localRepoPath ?? '' })
  })).digest('hex')
}

export interface StorageAssetImportSource {
  readonly sourceKey: string
  readonly sourcePath: string
  readonly sourceSha256: string
  readonly mapped: boolean
  readonly locationKey: string
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function readStorageAssetImportSource(owner: Record<string, unknown> | undefined): StorageAssetImportSource | undefined {
  if (owner === undefined || typeof owner.sourceKey !== 'string' || typeof owner.sourcePath !== 'string' ||
      typeof owner.sourceSha256 !== 'string' || typeof owner.locationKey !== 'string') return undefined
  return {
    sourceKey: owner.sourceKey, sourcePath: owner.sourcePath, sourceSha256: owner.sourceSha256,
    locationKey: owner.locationKey, mapped: owner.mapped === true
  }
}

export interface StorageAssetImportOwner extends StorageAssetImportSource {
  readonly assetSha256: string
  readonly assetId: number
}
export function storageAssetImportOwner(metadata: unknown): StorageAssetImportOwner | undefined {
  let decoded = metadata
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded) } catch { return undefined }
  }
  const value = record(record(decoded)?.storage_import)
  const owner = readStorageAssetImportSource(value)
  if (owner === undefined || typeof value?.assetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.assetSha256) ||
      typeof value.assetId !== 'number' || !Number.isSafeInteger(value.assetId) || value.assetId < 1) return undefined
  return { ...owner, assetSha256: value.assetSha256, assetId: value.assetId }
}

/** Trusted native hooks: authority before namespace locks, proof after row locks, final commit fencing. */
export interface StorageAssetImportReview {
  readonly previousPath?: string
  readonly resolveFolder?: (transaction: Knex.Transaction) => Promise<number | null>
  prepare(transaction: Knex.Transaction): Promise<void>
  check(transaction: Knex.Transaction): Promise<StorageAssetImportSource>
  beforeCommit(transaction: Knex.Transaction): Promise<void>
}

export interface StorageImportResolvedPage {
  readonly identity: StoragePageIdentity
  readonly document: StoragePageDocument
  readonly sourceSha256: string
  readonly sourceKey: string
  readonly locationKey: string
  readonly existingPageId: number | null
  readonly expectedSourceRevision: string | null
  readonly mapped: boolean
  readonly reviewedReplacement?: boolean
}

export interface StorageImportIdentityPlan {
  readonly preview: StorageImportPreview
  readonly pages: ReadonlyMap<string, StorageImportResolvedPage>
  readonly previous: ReadonlyMap<string, StorageImportResolvedPage | null>
  readonly gitContent?: ReadonlyMap<string, StorageGitContentEntry>
  readonly gitChoices?: ReadonlyMap<string, StorageGitContentChoice>
}

export interface StorageImportPreviousSource {
  readonly sourcePath: string
  readonly destinationSourcePath?: string
  readonly contentType: string
  readonly rawDocument: Buffer
}

interface StorageImportCanonicalPage {
  readonly id: number
  readonly localeCode: string
  readonly path: string
  readonly sourceRevision: string | number | bigint
}

interface StorageImportInventory {
  readonly canonicalPages: readonly StorageImportCanonicalPage[]
  readonly ownedBySource: ReadonlyMap<string, readonly StoragePageImportOwnerRecord[]>
  readonly owners: readonly StoragePageImportOwnerRecord[]
  readonly liveOwnerPageIds: ReadonlySet<number>
  readonly documents: ReadonlyMap<string, StoragePageDocument>
  readonly candidates: ReadonlyMap<string, StoragePageIdentity>
  readonly assetDestinations: readonly { id: number; path: string }[]
}
const inventories = new WeakMap<StorageImportPreview, StorageImportInventory>()

/** Read-only, descriptor-confined inventory; no candidate is silently normalized into admission. */
export async function buildStorageImportPreview(
  admission: StorageImportAdmission,
  ingestion: StoragePageIngestionOptions,
  moduleName: 'DISK' | 'GIT',
  scope: StorageImportScope
): Promise<StorageImportPreview> {
  // WIKI is installed after module loading in ordinary callers and native fixtures.
  const runtime = globalThis as unknown as { WIKI: WikiRuntime }
  const wiki = runtime.WIKI
  if (scope.targetKey !== moduleName.toLowerCase()) throw new Error('Import review belongs to a different storage target')
  if (moduleName === 'GIT') for (const entry of admission.entries) assertGitPath(entry.relativePath)
  const sourceKey = storageImportSourceKey(admission.root.sourceIdentity, moduleName, ingestion)
  const locationKey = storageImportLocationKey(moduleName, ingestion)
  const localeRows = await wiki.models.knex('locales').select('code').orderBy('code').limit(IMPORT_MAX_ENTRIES + 1)
  if (localeRows.length > IMPORT_MAX_ENTRIES) throw new RangeError('Import locale inventory exceeds its bound')
  const locales = localeRows.map(row => {
    if (typeof row.code !== 'string' || !row.code) throw new Error('Installed import locale inventory is invalid')
    return row.code
  })
  const canonicalPages = await wiki.models.pages.query()
    .where({ visibility: 'public' }).select('id', 'localeCode', 'path', 'sourceRevision')
    .limit(IMPORT_MAX_ENTRIES + 1)
  if (canonicalPages.length > IMPORT_MAX_ENTRIES) throw new RangeError(`Import destination inventory exceeds ${IMPORT_MAX_ENTRIES} entries`)
  const sourceOwners = await loadStoragePageImportOwners(wiki.models.knex, { sourceKey, limit: IMPORT_MAX_ENTRIES })
  const destinationOwners = await loadStoragePageImportOwners(wiki.models.knex, {
    pageIds: canonicalPages.map(page => page.id), limit: IMPORT_MAX_ENTRIES
  })
  const ownersById = new Map([...sourceOwners, ...destinationOwners].map(owner => [owner.pageId, owner]))
  const owners = [...ownersById.values()].sort((a, b) => a.pageId - b.pageId)
  const liveOwnerPages = sourceOwners.length === 0 ? [] : await wiki.models.knex('pages')
    .whereIn('id', sourceOwners.map(owner => owner.pageId)).select('id').limit(IMPORT_MAX_ENTRIES + 1)
  if (liveOwnerPages.length > IMPORT_MAX_ENTRIES) throw new RangeError('Import associated page inventory exceeds its bound')
  const liveOwnerPageIds = new Set(liveOwnerPages.map(page => Number(page.id)))
  const destinations = canonicalPages.map(page => ({
    id: page.id, locale: page.localeCode, path: page.path, sourceRevision: String(page.sourceRevision)
  })).sort((a, b) => a.id - b.id)
  const byIdentity = new Map<string, typeof canonicalPages>()
  for (const page of canonicalPages) {
    const key = storageImportIdentityKey({ locale: page.localeCode, path: page.path })
    const matching = byIdentity.get(key)
    if (matching === undefined) byIdentity.set(key, [page])
    else matching.push(page)
  }
  const canonicalPagesById = new Map(canonicalPages.map(page => [page.id, page]))
  const bySource = new Map<string, StoragePageImportOwnerRecord[]>()
  for (const owner of sourceOwners) {
    if (owner.status !== 'active') continue
    const matching = bySource.get(owner.sourcePath)
    if (matching === undefined) bySource.set(owner.sourcePath, [owner])
    else matching.push(owner)
  }
  const documents = new Map<string, StoragePageDocument>()
  const candidates = new Map<string, StoragePageIdentity>()
  const entries: StorageImportPreview['entries'][number][] = []
  const pages: StorageImportPreview['pages'][number][] = []
  const admitted = new Map(admission.files.map(item => [item.file.relPath, item]))
  for (const entry of [...admission.entries].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw new Error(`Unsafe storage import entry: ${entry.relativePath}`)
    let sha256: string | null = null
    if (entry.kind === 'file') {
      const source = await admission.root.openFile(entry.relativePath, entry.identity)
      try {
        const item = admitted.get(entry.relativePath)
        if (item?.contentType !== undefined) {
          const original = pageHelper.getPagePath(entry.relativePath)
          const imported = classifyStoragePageImport({
            rawDocument: await source.readBounded(OKF_MAX_DOCUMENT_BYTES),
            contentType: item.contentType,
            locale: original.locale,
            pagePath: original.path,
            importer: moduleName === 'DISK' ? 'import:disk' : 'import:git'
          }, entry.relativePath, ingestion)
          const document = imported.document
          documents.set(entry.relativePath, document)
          candidates.set(entry.relativePath, imported.identity)
          sha256 = document.sha256
          const associated = bySource.get(entry.relativePath) ?? []
          if (associated.length > 1) throw new Error(`Multiple canonical owners for import source: ${entry.relativePath}`)
          const associatedOwner = associated[0]
          const identity = associatedOwner?.mapped === true && document.format !== 'okf_valid'
            ? { locale: associatedOwner.nativeLocaleCode, path: associatedOwner.nativePath }
            : imported.identity
          const matching = byIdentity.get(storageImportIdentityKey(identity)) ?? []
          const current = matching.length === 1 ? matching[0] : undefined
          const owner = current === undefined ? undefined : ownersById.get(current.id)
          const diagnostics = [...document.diagnostics]
          if (associatedOwner !== undefined && (associatedOwner.nativeLocaleCode !== identity.locale || associatedOwner.nativePath !== identity.path)) {
            diagnostics.push(`Source ${entry.relativePath} already owns ${associatedOwner.nativeLocaleCode}/${associatedOwner.nativePath}; review that existing association before importing`)
          }
          if (document.format === 'okf_valid' && parseOkfFilePath(entry.relativePath) === null) diagnostics.push(`OKF page path is not canonical: ${entry.relativePath}`)
          try {
            assertNativeStoragePageIdentity(identity, entry.relativePath)
          } catch (error) {
            diagnostics.push(error instanceof Error ? error.message : String(error))
          }
          if (matching.length > 1) diagnostics.push(`Ambiguous existing destination for ${entry.relativePath}; reconcile canonical case/Unicode aliases`)
          pages.push({
            sourcePath: entry.relativePath,
            sourceSha256: sha256,
            contentType: item.contentType,
            ...identity,
            format: document.format,
            owned: current !== undefined && owner !== undefined && owner.sourceKey === sourceKey && owner.locationKey === locationKey &&
              owner.sourcePath === entry.relativePath && storagePageImportOwnerMatches(owner, current),
            existingPageId: current?.id ?? null,
            expectedSourceRevision: current === undefined ? null : String(current.sourceRevision),
            diagnostics
          })
        } else {
          sha256 = await source.sha256Bounded(admission.budget.maxBytes)
        }
      } finally {
        await source.close()
      }
    }
    entries.push({ sourcePath: entry.relativePath, kind: entry.kind, sourceSha256: sha256 })
  }
  const gitContent: StorageGitContentEntry[] = []
  const assetDestinations: { id: number; path: string }[] = []
  if (moduleName === 'GIT') {
    const configuredChoices = gitContentChoices(ingestion, sourceKey)
    const configuredByPath = new Map(configuredChoices.map(choice => [choice.sourcePath, choice]))
    const assetRows = await wiki.models.knex('assets').select('*').limit(IMPORT_MAX_ENTRIES + 1)
    if (assetRows.length > IMPORT_MAX_ENTRIES) throw new RangeError('Git native asset inventory exceeds its bound')
    const nativeSources: { sourcePath: string; sourceSha256: string }[] = []
    for (const sourceOwners of bySource.values()) nativeSources.push(...sourceOwners)
    for (const asset of assetRows) {
      const owner = storageAssetImportOwner(asset.metadata)
      if (owner?.sourceKey === sourceKey && owner.assetId === Number(asset.id)) nativeSources.push(owner)
    }
    for (const source of nativeSources) assertGitPath(source.sourcePath)
    await refreshGitRetainedSources(admission, sourceKey, nativeSources)
    const sourceEntries = new Map<string, { sha256: string; previous: boolean; available: boolean; revision: string | null }>(
      entries.filter(entry => entry.kind === 'file' && entry.sourceSha256 !== null).map(entry => [entry.sourcePath, {
        sha256: entry.sourceSha256!, previous: false, available: true, revision: null
      }]))
    const previous = new Map(gitPreviousContent(admission).map(source => [source.path, source]))
    const crossingDestinations = new Set([...previous.values()].flatMap(source =>
      source.destinationPath !== undefined && gitDotContentPath(source.path) !== gitDotContentPath(source.destinationPath)
        ? [source.destinationPath] : []))
    for (const source of previous.values()) sourceEntries.set(source.path, {
      sha256: createHash('sha256').update(source.bytes).digest('hex'), previous: true, available: true, revision: source.revision
    })
    for (const owner of sourceOwners) {
      if (owner.status === 'active' && (gitDotContentPath(owner.sourcePath) || configuredByPath.has(owner.sourcePath)) && !sourceEntries.has(owner.sourcePath)) {
        sourceEntries.set(owner.sourcePath, { sha256: owner.sourceSha256, previous: true, available: false,
          revision: configuredByPath.get(owner.sourcePath)?.sourceRevision ?? null })
      }
    }
    for (const choice of configuredChoices) {
      if (!sourceEntries.has(choice.sourcePath)) sourceEntries.set(choice.sourcePath, {
        sha256: choice.sourceSha256, previous: true, available: false, revision: choice.sourceRevision ?? null
      })
    }
    const folders = assetRows.some(asset => asset.folderId != null && asset.folderId !== 0)
      ? await wiki.models.assetFolders.getAllPaths() : {}
    const assetsByPath = new Map<string, typeof assetRows>()
    const assetsBySource = new Map<string, typeof assetRows>()
    const nativeAssetPaths = new Map<number, string>()
    const nativeAssetHashes = new Map<number, string>()
    let nativeAssetBytes = 0
    const nativeAssetSha256 = async (id: number): Promise<string> => {
      const existing = nativeAssetHashes.get(id)
      if (existing !== undefined) return existing
      const data = await wiki.models.knex('assetData').where({ id })
        .whereRaw('length(data) <= ?', [admission.budget.maxBytes - nativeAssetBytes]).first('data')
      if (!data || !(data.data instanceof Uint8Array)) throw new Error(`Git asset bytes are unavailable or exceed the inventory bound: ${id}`)
      nativeAssetBytes += data.data.byteLength
      const sha256 = createHash('sha256').update(data.data).digest('hex')
      nativeAssetHashes.set(id, sha256)
      return sha256
    }
    for (const asset of assetRows) {
      const folder = asset.folderId == null || asset.folderId === 0 ? '' : folders[Number(asset.folderId)]
      if (folder === undefined) throw new Error('Git native asset folder is unavailable')
      const name = folder ? `${folder}/${asset.filename}` : String(asset.filename)
      assetDestinations.push({ id: Number(asset.id), path: name })
      nativeAssetPaths.set(Number(asset.id), name)
      const nativeOwner = storageAssetImportOwner(asset.metadata)
      if (nativeOwner?.sourceKey === sourceKey && nativeOwner.assetId === Number(asset.id)) {
        const associated = assetsBySource.get(nativeOwner.sourcePath)
        if (associated === undefined) assetsBySource.set(nativeOwner.sourcePath, [asset])
        else associated.push(asset)
        if (!sourceEntries.has(nativeOwner.sourcePath)) {
          sourceEntries.set(nativeOwner.sourcePath, { sha256: nativeOwner.sourceSha256, previous: true, available: false,
            revision: configuredByPath.get(nativeOwner.sourcePath)?.sourceRevision ?? null })
        }
      }
      const matching = assetsByPath.get(name)
      if (matching === undefined) assetsByPath.set(name, [asset])
      else matching.push(asset)
      if ((gitDotContentPath(name) || configuredByPath.has(name)) && !sourceEntries.has(name)) {
        sourceEntries.set(name, { sha256: configuredByPath.get(name)?.sourceSha256 ?? await nativeAssetSha256(Number(asset.id)),
          previous: true, available: false, revision: configuredByPath.get(name)?.sourceRevision ?? null })
      }
    }
    for (const [sourcePath, source] of sourceEntries) {
      const hidden = gitDotContentPath(sourcePath)
      const old = previous.get(sourcePath)
      const crossing = old?.destinationPath !== undefined && gitDotContentPath(old.destinationPath) !== hidden
      const pageType = pageHelper.getContentType(sourcePath)
      if (pageType && !hidden && old === undefined && !crossingDestinations.has(sourcePath) && !configuredByPath.has(sourcePath)) continue
      if (gitContent.length >= IMPORT_MAX_ENTRIES) throw new RangeError('Git content review exceeds 10,000 entries. Reduce the source inventory or reconcile legacy records through native administration before previewing again; canonical content is preserved.')
      assertGitPath(sourcePath)
      const associated = bySource.get(sourcePath) ?? []
      if (associated.length > 1) throw new Error(`Ambiguous Git content source ownership: ${sourcePath}`)
      const proof = associated[0]
      const page = proof === undefined ? undefined : canonicalPagesById.get(proof.pageId)
      let owner: StorageGitContentEntry['owner'] = null
      if (pageType && page !== undefined && proof !== undefined) {
        owner = { kind: 'page', id: page.id, path: page.path, locale: page.localeCode,
          revision: String(page.sourceRevision), sha256: proof.sourceSha256,
          sourceOwned: source.available && proof.sourceKey === sourceKey && proof.locationKey === locationKey &&
            proof.sourcePath === sourcePath && proof.sourceSha256 === source.sha256 && storagePageImportOwnerMatches(proof, page) }
      } else if (!pageType) {
        const configured = configuredByPath.get(sourcePath)
        const associated = assetsBySource.get(sourcePath) ?? []
        if (associated.length > 1) throw new Error(`Multiple native asset owners for Git source: ${sourcePath}`)
        const associatedPath = associated[0] === undefined
          ? configured?.action === 'remap' ? configured.destinationPath : configured?.owner?.kind === 'asset' ? configured.owner.path : undefined
          : nativeAssetPaths.get(Number(associated[0].id))
        const nativePath = associatedPath ?? sourcePath
        const matching = assetsByPath.get(nativePath) ?? []
        if (matching.length > 1 || nativePath !== sourcePath && (assetsByPath.get(sourcePath)?.length ?? 0) > 0) {
          throw new Error(`Ambiguous Git asset source association: ${sourcePath}`)
        }
        const asset = matching[0]
        if (asset !== undefined) {
          const sha256 = await nativeAssetSha256(Number(asset.id))
          owner = { kind: 'asset', id: Number(asset.id), path: nativePath, locale: '',
            revision: gitContentDigest({ asset, sha256 }), sha256,
            sourceOwned: false }
          const nativeOwner = storageAssetImportOwner(asset.metadata)
          const nativeAssociation = nativeOwner?.sourceKey === sourceKey && nativeOwner.sourcePath === sourcePath && nativeOwner.assetId === Number(asset.id) &&
            nativeOwner.assetSha256 === sha256
          owner.sourceSha256 = nativeAssociation ? nativeOwner.sourceSha256 : source.sha256
          owner.sourceOwned = source.available && asset.hash === assetHelper.generateHash(nativePath) && nativeAssociation
        }
      }
      gitContent.push({
        sourcePath, sourceSha256: source.sha256, sourceKey, sourceRevision: source.revision,
        hidden, previous: source.previous, sourceAvailable: source.available,
        automatic: !hidden && !crossing && !crossingDestinations.has(sourcePath) && old?.retained !== true &&
          (!pageType || old !== undefined && (proof?.mapped !== true || owner?.sourceOwned === true)),
        kind: pageType ? 'page' : 'asset', owner,
        diagnostics: !source.available ? ['Actual old Git bytes are unavailable. Explicit retention is allowed; restore the exact source pin before any remap/removal.']
          : owner === null ? [] : owner.kind === 'asset' && !owner.sourceOwned
            ? ['This native asset is not verified as owned by this exact source. Retain never adopts it. A foreign source must first be reconciled through native asset administration; only a reviewed actual native import/replacement may establish a new association.']
            : ['Canonical records are preserved unless their exact native source and current owned revision authorize a change.']
      })
    }
    gitContent.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
  }
  const snapshot = createHash('sha256').update(storageStableValue({
    scope, sourceKey,
    ingestion: { mapReadmeToHome: ingestion.mapReadmeToHome === true, stripLeadingH1: ingestion.stripLeadingH1 === true },
    entries, destinations, locales, assetDestinations: assetDestinations.sort((a, b) => a.id - b.id), gitContent: gitContent.map(entry => ({
      ...entry, owner: entry.owner === null ? null : { ...entry.owner, sourceOwned: false }
    })),
    owners, liveOwnerPageIds: [...liveOwnerPageIds].sort((a, b) => a - b)
  })).digest('hex')
  const preview: StorageImportPreview = { scope, snapshot, entries, pages, destinations, locales, ...(moduleName === 'GIT' ? { gitContent } : {}) }
  inventories.set(preview, { canonicalPages, ownedBySource: bySource, owners, liveOwnerPageIds, documents, candidates, assetDestinations })
  return preview
}

function resolveStorageImportPreview(preview: StorageImportPreview, mappings: readonly StorageImportMapping[], choices: readonly StorageGitContentChoice[] = [], freshlyReviewed = false): Map<string, {
  identity: StoragePageIdentity
  existingPageId: number | null
  expectedSourceRevision: string | null
  reviewedReplacement?: boolean
}> {
  const mapped = new Map<string, StorageImportMapping>()
  for (const mapping of mappings) {
    if (mapped.has(mapping.sourcePath)) throw new Error(`Duplicate reviewed import mapping: ${mapping.sourcePath}`)
    mapped.set(mapping.sourcePath, mapping)
  }
  const byDestination = new Map<string, StorageImportPreview['destinations']>()
  for (const destination of preview.destinations) {
    const key = storageImportIdentityKey(destination)
    const matching = byDestination.get(key)
    if (matching === undefined) byDestination.set(key, [destination])
    else matching.push(destination)
  }
  const identities = new Map<string, string>()
  const resolved = new Map<string, Pick<StorageImportResolvedPage, 'identity' | 'existingPageId' | 'expectedSourceRevision' | 'reviewedReplacement'>>()
  const gitChoices = resolveGitContentChoices(preview, choices)
  const gitEntries = new Map(preview.gitContent?.map(entry => [entry.sourcePath, entry]) ?? [])
  const assetRemaps = new Set<string>()
  for (const [sourcePath, choice] of gitChoices) {
    if (choice.action !== 'remap') continue
    const entry = gitEntries.get(sourcePath)!
    const owner = entry.owner!
    const destinationPath = choice.destinationPath!
    if (destinationPath === owner.path) throw new Error(`Git remap must select a different native destination: ${sourcePath}`)
    if (owner.kind === 'page') {
      const identity = { locale: owner.locale, path: destinationPath }
      assertNativeStoragePageIdentity(identity, sourcePath)
      if (!preview.locales.includes(identity.locale)) throw new Error(`Git remap locale is not installed: ${sourcePath}`)
      const key = storageImportIdentityKey(identity)
      if ((byDestination.get(key)?.length ?? 0) > 0 || identities.has(key)) throw new Error(`Git remap destination is occupied or ambiguous: ${sourcePath}`)
      identities.set(key, sourcePath)
    } else {
      if (assetRemaps.has(destinationPath) || inventories.get(preview)?.assetDestinations.some(asset => asset.path === destinationPath)) {
        throw new Error(`Git asset remap destination is occupied or ambiguous: ${sourcePath}`)
      }
      assetRemaps.add(destinationPath)
    }
  }
  for (const source of preview.pages) {
    const gitEntry = gitEntries.get(source.sourcePath)
    if (gitEntry !== undefined && gitEntry.hidden) {
      const action = gitContentAction(gitEntry, gitChoices)
      if (action !== 'include') {
        mapped.delete(source.sourcePath)
        continue
      }
    }
    const mapping = mapped.get(source.sourcePath)
    mapped.delete(source.sourcePath)
    if (source.format === 'okf_invalid') throw new Error(`Invalid page document ${source.sourcePath}: ${source.diagnostics.join('; ')}`)
    if (source.format === 'okf_valid' && parseOkfFilePath(source.sourcePath) === null) throw new Error(`OKF page path is not canonical: ${source.sourcePath}`)
    const identity = mapping === undefined ? { locale: source.locale, path: source.path } : { locale: mapping.locale, path: mapping.path }
    assertNativeStoragePageIdentity(identity, source.sourcePath)
    if (!preview.locales.includes(identity.locale)) throw new Error(`Page locale is not installed for ${source.sourcePath}: ${identity.locale}`)
    if (source.format === 'okf_valid' && (identity.locale !== source.locale || identity.path !== source.path)) {
      throw new Error(`Canonical OKF identity cannot be remapped: ${source.sourcePath}`)
    }
    if (mapping !== undefined && mapping.sourceSha256 !== source.sourceSha256) throw new Error(`Reviewed import source changed: ${source.sourcePath}`)
    const key = storageImportIdentityKey(identity)
    const previous = identities.get(key)
    if (previous !== undefined) {
      throw new Error(`Ambiguous page import: ${previous} and ${source.sourcePath} resolve to the same destination`)
    }
    identities.set(key, source.sourcePath)
    const existing = byDestination.get(key) ?? []
    if (existing.length > 1) throw new Error(`Ambiguous existing destination for ${source.sourcePath}; reconcile canonical case/Unicode aliases`)
    const current = existing[0]
    const associated = inventories.get(preview)?.ownedBySource.get(source.sourcePath)?.[0]
    if (associated !== undefined && associated.pageId !== current?.id) {
      throw new Error(`Source ${source.sourcePath} already owns another canonical destination; review its existing page association instead of creating a second owner`)
    }
    if (current !== undefined && (current.locale !== identity.locale || current.path !== identity.path)) {
      throw new Error(`Destination spelling conflicts with an existing page for ${source.sourcePath}; select its exact native identity`)
    }
    const reviewedReplacement = freshlyReviewed && current !== undefined && (mapping !== undefined ||
      gitChoices.get(source.sourcePath)?.action === 'include' && gitEntry?.owner?.kind === 'page' &&
      gitEntry.owner.id === current.id && gitEntry.owner.revision === current.sourceRevision)
    if (mapping !== undefined) {
      if ((current?.id ?? null) !== mapping.existingPageId || (current?.sourceRevision ?? null) !== mapping.expectedSourceRevision) {
        throw new Error(`Reviewed import destination changed: ${source.sourcePath}`)
      }
    } else if (current !== undefined && !source.owned && !reviewedReplacement) {
      throw new Error(`Existing page ownership is unreviewed for ${source.sourcePath}; explicitly associate the source with its destination and revision`)
    }
    resolved.set(source.sourcePath, {
      identity,
      existingPageId: current?.id ?? null,
      expectedSourceRevision: current?.sourceRevision ?? null,
      ...(reviewedReplacement ? { reviewedReplacement: true } : {})
    })
  }
  if (mapped.size > 0) throw new Error(`Reviewed import source is absent from the inventory: ${mapped.keys().next().value}`)
  return resolved
}

/** Reusable before configuration publication as well as before the first content mutation. */
export function validateStorageImportReview(preview: StorageImportPreview, input: unknown): void {
  const review = StorageImportReviewSchema.parse(input)
  if (review.snapshot !== preview.snapshot || storageStableValue(review.scope) !== storageStableValue(preview.scope)) {
    throw new Error('Storage import review is stale; inventory, destination ownership or reviewed configuration changed')
  }
  resolveStorageImportPreview(preview, review.mappings, review.gitContent, true)
}

export async function prepareStorageImportIdentities(
  admission: StorageImportAdmission,
  ingestion: StoragePageIngestionOptions,
  moduleName: 'DISK' | 'GIT',
  previousSources: readonly StorageImportPreviousSource[] = []
): Promise<StorageImportIdentityPlan> {
  const review = currentStorageImportReview()
  const scope: StorageImportScope = review?.scope ?? { actorId: null, apiKeyId: null, targetKey: moduleName === 'DISK' ? 'disk' : 'git', configurationRevision: 'unreviewed' }
  const preview = await buildStorageImportPreview(admission, ingestion, moduleName, scope)
  const previous = new Map<string, StorageImportResolvedPage | null>()
  const inventory = inventories.get(preview)
  if (inventory === undefined) throw new Error('Storage import inventory is unavailable')
  const sourceKey = storageImportSourceKey(admission.root.sourceIdentity, moduleName, ingestion)
  const locationKey = storageImportLocationKey(moduleName, ingestion)
  const choices = moduleName === 'GIT' ? gitContentChoices(ingestion, sourceKey, review?.gitContent) : []
  const gitChoices = resolveGitContentChoices(preview, choices)
  const gitEntries = new Map(preview.gitContent?.map(entry => [entry.sourcePath, entry]) ?? [])
  const sourcesByPath = new Map(preview.pages.map(page => [page.sourcePath, page]))
  const pagesById = new Map(inventory.canonicalPages.map(page => [page.id, page]))
  const occupiedIdentities = new Set(preview.destinations.map(page => storageImportIdentityKey(page)))
  const renameOwners = new Map<string, StoragePageImportOwnerRecord>()
  for (const requested of previousSources) {
    const entry = gitEntries.get(requested.sourcePath)
    const action = entry === undefined ? 'include' : gitContentAction(entry, gitChoices)
    if (action === 'retain' || action === 'conflict' || action === 'remove' || action === 'remap' || entry?.hidden && action !== 'include') continue
    const destinationEntry = requested.destinationSourcePath === undefined ? undefined : gitEntries.get(requested.destinationSourcePath)
    const destinationVisible = destinationEntry === undefined || !destinationEntry.hidden || gitContentAction(destinationEntry, gitChoices) === 'include'
    const source = destinationVisible ? requested : { ...requested, destinationSourcePath: undefined }
    const original = pageHelper.getPagePath(source.sourcePath)
    const imported = classifyStoragePageImport({
      rawDocument: source.rawDocument, contentType: source.contentType,
      locale: original.locale, pagePath: original.path, importer: 'import:git'
    }, source.sourcePath, ingestion)
    if (imported.document.format === 'okf_invalid' ||
        (imported.document.format === 'okf_valid' && parseOkfFilePath(source.sourcePath) === null)) {
      throw new Error(`Invalid previous Git page document: ${source.sourcePath}`)
    }
    const matching = inventory.ownedBySource.get(source.sourcePath) ?? []
    if (matching.length > 1) throw new Error(`Multiple canonical owners for previous Git source: ${source.sourcePath}`)
    const destination = source.destinationSourcePath === undefined ? undefined : sourcesByPath.get(source.destinationSourcePath)
    const boundOwners = source.destinationSourcePath === undefined ? [] : inventory.owners.filter(owner => {
      const binding = owner.moveBinding
      return owner.status === 'active' && owner.sourceKey === sourceKey && owner.locationKey === locationKey &&
        binding !== null && binding.oldSourcePath === source.sourcePath && binding.oldSourceSha256 === imported.document.sha256 &&
        binding.newSourcePath === source.destinationSourcePath && binding.newSourceSha256 === destination?.sourceSha256
    })
    if (boundOwners.length > 1) throw new Error(`Multiple native move bindings for previous Git source: ${source.sourcePath}`)
    const owner = boundOwners[0] ?? matching[0]
    if (owner === undefined) {
      const receipts = inventory.owners.filter(receipt => receipt.status === 'deleted' && receipt.sourceKey === sourceKey &&
        receipt.locationKey === locationKey && receipt.sourcePath === source.sourcePath && receipt.sourceSha256 === imported.document.sha256)
      if (source.destinationSourcePath !== undefined || receipts.length === 0 ||
          receipts.some(receipt => inventory.liveOwnerPageIds.has(receipt.pageId) ||
            occupiedIdentities.has(storageImportIdentityKey({ locale: receipt.nativeLocaleCode, path: receipt.nativePath })))) {
        throw new Error(`Previous Git deletion ownership is unavailable or reused: ${source.sourcePath}`)
      }
      previous.set(source.sourcePath, null)
      continue
    }
    const current = pagesById.get(owner.pageId)
    if (owner.sourceKey !== sourceKey || owner.locationKey !== locationKey || current === undefined ||
        !storagePageImportOwnerMatches(owner, current)) {
      throw new Error(`Previous Git source is stale for its canonical owner: ${source.sourcePath}`)
    }
    const binding = boundOwners[0]?.moveBinding
    const boundMove = binding !== undefined && binding !== null
    if (owner.moveBinding?.phase === 'moved' && !boundMove) {
      throw new Error(`Previous Git native move binding changed: ${source.sourcePath}`)
    }
    if (boundMove) {
      const accepted = binding.phase === 'moved'
        ? owner.sourcePath === binding.oldSourcePath && owner.sourceSha256 === binding.oldSourceSha256 &&
          owner.nativeRevision === binding.moveNativeRevision && owner.operationId === binding.moveOperationId
        : owner.sourcePath === binding.newSourcePath && owner.sourceSha256 === binding.newSourceSha256
      if (!accepted || matching[0] !== undefined && matching[0].pageId !== owner.pageId) {
        throw new Error(`Previous Git native move binding changed: ${source.sourcePath}`)
      }
    } else if (owner.sourcePath !== source.sourcePath || owner.sourceSha256 !== imported.document.sha256) {
      throw new Error(`Previous Git source is stale for its canonical owner: ${source.sourcePath}`)
    }
    const identity = { locale: owner.nativeLocaleCode, path: owner.nativePath }
    assertNativeStoragePageIdentity(identity, source.sourcePath)
    if (!owner.mapped && !boundMove && storageImportIdentityKey(identity) !== storageImportIdentityKey(imported.identity)) {
      throw new Error(`Previous Git source destination changed: ${source.sourcePath}`)
    }
    previous.set(source.sourcePath, {
      identity, document: imported.document, sourceKey, sourceSha256: imported.document.sha256, locationKey,
      existingPageId: owner.pageId, expectedSourceRevision: owner.nativeRevision, mapped: owner.mapped
    })
    if (source.destinationSourcePath !== undefined) {
      if (destination === undefined) throw new Error(`Git rename has no admitted page destination: ${source.destinationSourcePath}`)
      if (destination.existingPageId !== null && destination.existingPageId !== owner.pageId) {
        throw new Error(`Git rename destination is already owned: ${source.destinationSourcePath}`)
      }
      if (destination.existingPageId === owner.pageId) destination.owned = true
      renameOwners.set(source.destinationSourcePath, owner)
    }
  }
  if (review !== undefined) validateStorageImportReview(preview, review)
  const resolved = resolveStorageImportPreview(preview, review?.mappings ?? [], choices, review !== undefined)
  const pages = new Map<string, StorageImportResolvedPage>()
  for (const [sourcePath, destination] of resolved) {
    const document = inventory.documents.get(sourcePath)
    if (document === undefined) throw new Error(`Storage import document is unavailable: ${sourcePath}`)
    const classifiedIdentity = inventory.candidates.get(sourcePath)!
    const associated = inventory.ownedBySource.get(sourcePath)?.[0] ?? renameOwners.get(sourcePath)
    pages.set(sourcePath, {
      ...destination, document, sourceSha256: document.sha256, sourceKey,
      locationKey,
      mapped: associated?.locationKey === locationKey && associated.mapped ||
        document.format !== 'okf_valid' && (destination.identity.path !== classifiedIdentity.path || destination.identity.locale !== classifiedIdentity.locale)
    })
  }
  await guardStorageImportReview()
  return { preview, pages, previous, ...(moduleName === 'GIT' ? { gitContent: new Map(preview.gitContent?.map(entry => [entry.sourcePath, entry])), gitChoices } : {}) }
}

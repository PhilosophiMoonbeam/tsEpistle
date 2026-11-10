import type {
  QueryBuilder,
  StorageConfig,
  StorageAssetIdentity,
  StorageAssetRelocation,
  StorageContext,
  StoragePlugin,
  StoragePluginActionResult,
  WikiAsset,
  WikiUser
} from '../../types.ts'
import { wiki } from '../../types.ts'
import type { Knex } from 'knex'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import _ from 'lodash'

import pageHelper from '../../../helpers/page.ts'
import assetHelper from '../../../helpers/asset.ts'
import commonDisk, { collectStorageEntries, isImportSourceMissing, validateStoragePaths } from '../disk/common.ts'
import type { StorageImportAdmission } from '../disk/common.ts'
import type { StorageImportResult } from '../types.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
import { PageChangeReasonSchema } from '../../../../shared/page-change-reason.ts'
import { isStorageGitBranchName, storageGitRepositoryIssue } from '../../../../shared/storage-workspace.ts'
import {
  assertAssetLocationAssetSettled,
  assertAssetLocationReservations,
  lockAssetLocation,
  withAssetLocationLocks
} from '../../../helpers/asset-location-lock.ts'
import {
  pullRemoteAuthoritative,
  reattachUnrelatedHistory,
  recoverInterruptedGitOperation,
  sharesHistoryWith,
  type GitRepositoryCommand
} from './repository.ts'
import { admitGitTree, assertGitPath, streamGitNameStatus, type GitChangeStatus, type GitNameStatusChange, type GitNativeCommand } from './admission.ts'
import {
  BoundedProcessError,
  GIT_NATIVE_DEADLINE_MS,
  GIT_NATIVE_METADATA_ENTRY_LIMIT,
  GIT_NATIVE_METADATA_LIMIT_BYTES,
  GIT_NATIVE_MONITOR_INTERVAL_MS,
  GIT_NATIVE_STDERR_LIMIT_BYTES,
  GIT_NATIVE_STDOUT_LIMIT_BYTES,
  GIT_NATIVE_WORKTREE_ENTRY_LIMIT,
  GIT_NATIVE_WORKTREE_LIMIT_BYTES,
  observeDirectoryTree,
  runBoundedProcess
} from './bounded-process.ts'
import { isStorageGitMetadataPath, isStorageInternalPath, isStorageReservedPath } from '../internal-path.ts'
import { OKF_MAX_DOCUMENT_BYTES } from '../../../okf/format.ts'
import { gitStorageSshCommand, gitStorageHttpRemote, writeGitStorageConnectionFile } from './connection.ts'
import { openStorageRoot, type StorageFileIdentityExpectation, type StorageFileHandle, type StorageRootHandle } from '../local-filesystem.ts'
import type { StorageLocalLocation } from '../../types.ts'
import { currentGitMutationTurn, GitStorageBusyError, withGitMutationLock } from './mutation-lock.ts'
import type { StorageMutationDispatch } from '../../../jobs/storage-mutations.ts'
import { storagePagePath } from '../../../helpers/storage-page-path.ts'
import { assertNoPublicStoragePageAtPath, assertStorageAssetDestinationAllowed } from '../../../helpers/storage-path-admission.ts'
import {
  assertNativeStoragePageIdentity, guardStorageImportReview, prepareStorageImportIdentities,
  storageImportLocationKey, storageImportSourceKey, storageAssetImportOwner, type StorageAssetImportReview, type StorageImportPreviousSource
} from '../import-identity.ts'
import {
  bindGitPreviousContent, collectGitContentEntries, gitContentAction, gitContentDigest,
  gitDotContentPath, gitPreviousContent, gitRetainedContentRef, inspectGitPreviousContent, type GitPreviousContent
} from './content-visibility.ts'
import type { StorageGitContentEntry, StorageGitContentChoice } from '../../../../shared/utility-content-import.ts'
import type { PageRuleAuthority } from '../../../helpers/group-access.ts'
import {
  loadStoragePageImportOwners, recordStoragePageImportOwner, storagePageImportOwnerMatches,
  type StoragePageExportHook, type StoragePageImportMoveBinding, type StoragePageImportOwnerRecord
} from '../../../helpers/storage-page-import-owner.ts'
import type { CanonicalTransactionHook } from '../../../models/pages.ts'
import { PageProjectionPayloadSchema } from '../../../core/page-mutation-outbox.ts'
import { requireSystemAuthority } from '../../../helpers/system-authority.ts'

export interface GitStorageFile {
  file: { stats: StorageFileIdentityExpectation }
  oldPath: string
  relPath: string
  binary: boolean
  status?: GitChangeStatus
  insertions: number
  deletions: number
  before: number
  after: number
  importAll: boolean
}

export interface GitStorageImportPlan {
  readonly admission: StorageImportAdmission
  readonly files: readonly GitStorageFile[]
}
interface GitStorageImportResult extends StorageImportResult {
  outcome?: 'conflict'
}

interface GitStorageContext extends StorageContext<StorageConfig> {
  git: boolean | null
  repoPath: string
  root: StorageRootHandle | null
  quarantined?: boolean
  targetKey?: string
  initializing?: boolean
  init(): Promise<void>
  sync(options?: { manual: boolean }): Promise<StoragePluginActionResult>
  processFiles(plan: GitStorageImportPlan, user: WikiUser): Promise<GitStorageImportResult[]>
}

interface GitStoragePlugin extends StoragePlugin<StorageConfig, GitStorageContext> {
  git: boolean | null
  repoPath: string
  root: StorageRootHandle | null
  quarantined?: boolean
  processFiles(this: GitStorageContext, plan: GitStorageImportPlan, user: WikiUser): Promise<GitStorageImportResult[]>
  syncUntracked(this: GitStorageContext): Promise<void>
  purge(this: GitStorageContext): Promise<void>
  withMutationTurn?(this: GitStorageContext, work: (dispatch: StorageMutationDispatch) => Promise<void>, signal: AbortSignal): Promise<void>
  updated(this: GitStorageContext, page: Parameters<StorageMutationDispatch['writePage']>[0], onWritten?: StoragePageExportHook): Promise<void>
  assetUploaded(this: GitStorageContext, asset: Omit<Parameters<StorageMutationDispatch['writeAsset']>[0], 'authorId'>): Promise<void>
  assetDeleted(this: GitStorageContext, asset: Omit<Parameters<StorageMutationDispatch['removePath']>[0], 'authorId'>): Promise<void>
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
  extra: Record<string, unknown>
  isPublished: boolean
  updatedAt: Date | string
  createdAt: Date | string
  editorKey: string
  tags?: { tag: string }[]
}

function gitPagePath(page: Pick<PageExportRow, 'path' | 'localeCode' | 'contentType'>, alwaysNamespace: boolean): string {
  return storagePagePath(page, {
    defaultLocale: wiki.config.lang.code,
    namespaceNonDefaultLocale: wiki.config.lang.namespacing === true,
    alwaysNamespace
  })
}


interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

function isPageExportRow(value: unknown): value is PageExportRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'localeCode' in value &&
    typeof value.localeCode === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'description' in value &&
    typeof value.description === 'string' &&
    'contentType' in value &&
    typeof value.contentType === 'string' &&
    'content' in value &&
    (typeof value.content === 'string' || (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    'sourceRevision' in value &&
    (typeof value.sourceRevision === 'string' || typeof value.sourceRevision === 'number') &&
    'authorId' in value &&
    typeof value.authorId === 'number' &&
    'extra' in value &&
    typeof value.extra === 'object' &&
    value.extra !== null &&
    !Array.isArray(value.extra) &&
    'isPublished' in value &&
    typeof value.isPublished === 'boolean' &&
    'updatedAt' in value &&
    (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    'createdAt' in value &&
    (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    'editorKey' in value &&
    typeof value.editorKey === 'string'
  )
}

function serializePage(page: StoragePageEncodingInput): string {
  const encoded = encodeStoragePageDocument(page)
  if (page.contentType === 'markdown') {
    if (typeof encoded === 'object' && encoded !== null && 'markdown' in encoded && typeof encoded.markdown === 'string') return encoded.markdown
    throw new TypeError('Markdown page encoder did not return a document')
  }
  return typeof encoded === 'string' ? encoded : JSON.stringify(encoded)
}
function isAssetExportRow(value: unknown): value is AssetExportRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    typeof value.filename === 'string' &&
    'folderId' in value &&
    (typeof value.folderId === 'number' || value.folderId === null) &&
    'data' in value &&
    Buffer.isBuffer(value.data)
  )
}
function requireRoot(context: GitStorageContext): StorageRootHandle {
  if (context.quarantined || context.root === null || context.root === undefined || context.root.closed) throw new Error('Git storage is not initialized')
  return context.root
}

function requireGit(context: GitStorageContext): void {
  if (context.quarantined || !context.git) throw new Error('Git storage is not initialized')
}

function mutationGit(context: GitStorageContext): GitNativeCommand {
  requireGit(context)
  return nativeGit(context, currentGitMutationTurn().deadlineAt)
}

async function destinationHasCanonicalBytes(root: StorageRootHandle, relativePath: string, data: Buffer, contentSha256: string): Promise<boolean> {
  let destination: StorageFileHandle
  try {
    destination = await root.openFile(relativePath)
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  try {
    const destinationBytes = await destination.readBounded(data.byteLength + 1)
    if (destinationBytes.byteLength !== data.byteLength || createHash('sha256').update(destinationBytes).digest('hex') !== contentSha256) {
      throw new Error('Storage destination does not contain the canonical asset bytes')
    }
    return true
  } finally {
    await destination.close()
  }
}

function gitExecutable(context: GitStorageContext): string {
  const configured = context.config.gitBinaryPath
  return typeof configured === 'string' && configured.trim().length > 0 ? configured : 'git'
}

function assertBranch(branch: string): void {
  if (typeof branch !== 'string' || !isStorageGitBranchName(branch)) {
    throw new Error('Enter a valid Git branch name of at most 255 characters.')
  }
}

async function observeGitStorage(context: GitStorageContext, deadlineAt: number): Promise<void> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new BoundedProcessError('deadline', 'Git synchronization exceeded its deadline')
  try {
    await observeDirectoryTree(path.join(context.repoPath, '.git'), {
      maxEntries: GIT_NATIVE_METADATA_ENTRY_LIMIT,
      maxBytes: GIT_NATIVE_METADATA_LIMIT_BYTES,
      deadlineAt
    })
  } catch (error) {
    if (!context.initializing || !isImportSourceMissing(error)) throw error
  }
  await observeDirectoryTree(context.repoPath, {
    maxEntries: GIT_NATIVE_WORKTREE_ENTRY_LIMIT,
    maxBytes: GIT_NATIVE_WORKTREE_LIMIT_BYTES,
    deadlineAt,
    shouldSkip: isStorageGitMetadataPath
  })
}

function nativeGit(context: GitStorageContext, deadlineAt: number): GitNativeCommand {
  return {
    async run(args, options = {}) {
      const turn = currentGitMutationTurn()
      await turn.assertHeld()
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw new BoundedProcessError('deadline', 'Git synchronization exceeded its deadline')
      await observeGitStorage(context, deadlineAt)
      const result = await runBoundedProcess({
        command: gitExecutable(context),
        args,
        cwd: context.repoPath,
        env: { GIT_TERMINAL_PROMPT: '0' },
        deadlineMs: remaining,
        signal: turn.signal,
        maxStdoutBytes: options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES,
        maxStderrBytes: GIT_NATIVE_STDERR_LIMIT_BYTES,
        captureStdout: options.captureStdout ?? true,
        ...(options.onStdoutChunk === undefined ? {} : { onStdoutChunk: options.onStdoutChunk }),
        monitor: async () => {
          await turn.assertHeld()
          await observeGitStorage(context, deadlineAt)
          if (options.monitor) await options.monitor()
        },
        monitorIntervalMs: GIT_NATIVE_MONITOR_INTERVAL_MS
      })
      return result
    }
  }
}

function nativeRepository(command: GitNativeCommand): GitRepositoryCommand {
  return {
    async run(args) {
      const result = await command.run(args, { captureStdout: true, maxStdoutBytes: 8 * 1024 })
      return result.stdout.toString('utf8')
    }
  }
}

async function runNativeText(command: GitNativeCommand, args: readonly string[]): Promise<string> {
  const result = await command.run(args, { captureStdout: true, maxStdoutBytes: 8 * 1024 })
  return result.stdout.toString('utf8').trim()
}

async function resolveCommit(command: GitNativeCommand, revision: string, optional = false): Promise<string | null> {
  try {
    const value = await runNativeText(command, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new BoundedProcessError('parser', 'Git returned an invalid commit identifier')
    return value
  } catch (error: unknown) {
    if (optional && error instanceof BoundedProcessError && error.kind === 'exit') return null
    throw error
  }
}

async function fetchConfiguredBranch(command: GitNativeCommand, branch: string): Promise<string> {
  assertBranch(branch)
  await command.run(['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-progress', 'origin', branch], { captureStdout: false })
  const remoteRef = `refs/remotes/origin/${branch}`
  const fetched = await resolveCommit(command, remoteRef)
  if (fetched === null) throw new Error('Invalid branch! Make sure it exists on the remote first.')
  return fetched
}

async function quarantineGitContext(context: GitStorageContext): Promise<void> {
  const root = context.root
  context.root = null
  context.git = null
  context.quarantined = true
  if (root !== null && root !== undefined) {
    try {
      await root.close()
    } catch (error: unknown) {
      wiki.logger.warn(error)
    }
  }
}

function shouldQuarantineGitFailure(error: unknown): boolean {
  return error instanceof BoundedProcessError && error.quarantine
}


type GitAssetQuery = QueryBuilder<WikiAsset>

function queryGitAssets(transaction: Knex.Transaction): GitAssetQuery {
  return (wiki.models.assets.query as unknown as (transaction: Knex.Transaction) => GitAssetQuery)(transaction)
}

function sameGitPageAcceptance(left: StoragePageImportOwnerRecord | undefined, right: StoragePageImportOwnerRecord): boolean {
  return left !== undefined && left.pageId === right.pageId && left.status === right.status &&
    left.sourceKey === right.sourceKey && left.sourcePath === right.sourcePath && left.sourceSha256 === right.sourceSha256 &&
    left.locationKey === right.locationKey && left.mapped === right.mapped &&
    left.nativeRevision === right.nativeRevision && left.nativePath === right.nativePath && left.nativeLocaleCode === right.nativeLocaleCode &&
    left.operationId === right.operationId && _.isEqual(left.moveBinding, right.moveBinding)
}

function gitPageDeleteHook(association: StoragePageImportOwnerRecord, user: WikiUser): CanonicalTransactionHook {
  const turn = currentGitMutationTurn()
  return async (transaction, committed) => {
    await requireSystemAuthority(transaction, { user }, true)
    await guardStorageImportReview(transaction)
    const [persisted] = await loadStoragePageImportOwners(transaction, { pageIds: [association.pageId], limit: 1 })
    if (committed.id !== association.pageId || BigInt(committed.sourceRevision) <= BigInt(association.nativeRevision) ||
        persisted?.deletedAt == null || !sameGitPageAcceptance(persisted, {
          ...association, status: 'deleted', nativeRevision: committed.sourceRevision, operationId: committed.outboxId
        })) {
      throw new Error('Native Git deletion lost its exact accepted source association')
    }
    await turn.assertHeld(transaction)
  }
}

/** Validate the actual move before its durable ledger binding becomes authoritative. */
async function assertGitPageMoveEffect(
  transaction: Knex.Transaction,
  binding: StoragePageImportMoveBinding,
  pageId: number,
  destination: { path: string; locale: string },
  previousContent: string
): Promise<void> {
  const effect = await transaction('pageMutationOutbox').where({
    pageId, sourceRevision: binding.moveNativeRevision, effectKind: 'knowledge'
  }).first('payload', 'payloadSha256', 'desiredState')
  if (!effect || typeof effect.payload !== 'string' || effect.desiredState !== 'present' ||
      createHash('sha256').update(effect.payload).digest('hex') !== effect.payloadSha256) {
    throw new Error('The exact native Git move effect is unavailable')
  }
  const payload = PageProjectionPayloadSchema.parse(JSON.parse(effect.payload))
  if (payload.action !== 'move' || payload.effectKind !== 'knowledge' || payload.desiredState !== 'present' ||
      payload.pageId !== pageId || payload.sourceRevision !== binding.moveNativeRevision ||
      payload.sourceSha256 !== createHash('sha256').update(previousContent).digest('hex') ||
      payload.location?.path !== destination.path || payload.location.locale !== destination.locale ||
      payload.location.visibility !== 'public' || payload.location.ownerId !== null ||
      payload.previousLocation?.path !== binding.previousNativePath || payload.previousLocation.locale !== binding.previousNativeLocaleCode ||
      payload.previousLocation.visibility !== 'public' || payload.previousLocation.ownerId !== null) {
    throw new Error('The actual native Git move identities or revision changed')
  }
}


const previousPageSources = new WeakMap<GitStorageFile, Buffer>()


async function buildGitImportPlan(
  root: StorageRootHandle,
  admission: StorageImportAdmission,
  changes: readonly GitNameStatusChange[],
  command: GitNativeCommand,
  previousCommit: string
): Promise<GitStorageImportPlan> {
  if (admission.root !== root) throw new Error('Git import admission belongs to a different storage root')
  const seen = new Set<string>()
  const files: GitStorageFile[] = []
  const previousContent: GitPreviousContent[] = []
  let previousBytes = 0
  const paths: string[] = []
  for (const change of changes) {
    const key = `${change.status}\0${change.oldPath}\0${change.path}`
    if (seen.has(key)) throw new BoundedProcessError('parser', `Git diff emitted a duplicate change: ${change.path}`)
    seen.add(key)
    assertGitPath(change.oldPath)
    assertGitPath(change.path)
    paths.push(change.oldPath, change.path)
    if (change.status === 'U' || change.status === 'X' || change.status === 'B') {
      throw new BoundedProcessError('parser', `Git diff emitted an unsupported status: ${change.status}`)
    }
    const entry = admission.filesByPath.get(change.path)
    const fileEntry = entry !== undefined && entry.kind === 'file' ? entry : undefined
    const fileStats = fileEntry?.identity ?? { size: 0 }
    const isDelete = change.status === 'D'
    const isRename = change.status === 'R'
    const binary = pageHelper.getContentType(change.path) === false
    const planned: GitStorageFile = {
      file: { stats: fileStats },
      oldPath: change.oldPath,
      relPath: change.path,
      binary,
      status: change.status,
      insertions: change.status === 'A' || change.status === 'M' || change.status === 'T' || isRename ? 1 : 0,
      deletions: change.status === 'D' || change.status === 'M' || change.status === 'T' || isRename ? 1 : 0,
      before: isDelete || change.status === 'A' ? 0 : 1,
      after: isDelete ? 0 : 1,
      importAll: false
    }
    if (isDelete || isRename) {
      const previous = await command.run(['show', `${previousCommit}:${change.oldPath}`], {
        maxStdoutBytes: pageHelper.getContentType(change.oldPath) ? OKF_MAX_DOCUMENT_BYTES : admission.budget.maxBytes
      })
      previousBytes += previous.stdout.byteLength
      if (previousBytes > admission.budget.maxBytes) throw new RangeError('Git previous source bytes exceed the import bound')
      previousPageSources.set(planned, previous.stdout)
      previousContent.push({ path: change.oldPath, bytes: previous.stdout, revision: previousCommit, ...(isRename ? { destinationPath: change.path } : {}) })
    }
    files.push(planned)
  }
  await validateStoragePaths(root, paths, admission)
  bindGitPreviousContent(admission, previousContent)
  return { admission, files }
}

function serializeGitMutation<Args extends unknown[], Result>(
  method: (this: GitStorageContext, ...args: Args) => Promise<Result>
): (this: GitStorageContext, ...args: Args) => Promise<Result> {
  return async function (...args) {
    return withGitMutationLock(wiki.models.knex, this.targetKey ?? 'git', async turn => {
      try {
        await turn.assertHeld()
        return await method.apply(this, args)
      } catch (error) {
        if (shouldQuarantineGitFailure(error)) await quarantineGitContext(this)
        throw error
      }
    })
  }
}

async function isGitIgnored(command: GitNativeCommand, filePath: string): Promise<boolean> {
  try {
    await command.run(['check-ignore', '--quiet', '--', filePath])
    return true
  } catch (error) {
    if (error instanceof BoundedProcessError && error.kind === 'exit' && error.code === 1) return false
    throw error
  }
}

async function isGitTracked(command: GitNativeCommand, filePath: string): Promise<boolean> {
  try {
    await command.run(['ls-files', '--error-unmatch', '--', filePath], { captureStdout: false })
    return true
  } catch (error) {
    if (error instanceof BoundedProcessError && error.kind === 'exit' && error.code === 1) return false
    throw error
  }
}

async function commitGitPaths(command: GitNativeCommand, message: string, paths: readonly string[], author?: string): Promise<void> {
  try {
    await command.run(['diff', '--cached', '--quiet', '--', ...paths])
    return // An already-completed durable effect is safe to retry.
  } catch (error) {
    if (!(error instanceof BoundedProcessError && error.kind === 'exit' && error.code === 1)) throw error
  }
  await command.run([
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    message,
    ...(author === undefined ? [] : ['--author', author]),
    ...(paths.length === 0 ? [] : ['--only', '--', ...paths])
  ])
}

async function hasPendingCanonicalMutations(context: GitStorageContext): Promise<boolean> {
  const db = wiki.models.knex
  const row = await db('durableJobs')
    .where(identity => identity.where('type', 'storage-mutation').whereIn('version', [1, 2]).orWhere({ type: 'asset-relocation', version: 1 }))
    .whereNot('state', 'succeeded')
    .whereRaw("payload::jsonb ->> 'targetKey' = ?", [context.targetKey ?? 'git'])
    .first('id')
  return Boolean(row)
}

async function assertGitWorktreeSettled(command: GitNativeCommand): Promise<void> {
  const status = await command.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.stdout.length !== 0) {
    throw new Error('Git working copy contains pending mutations; commit or recover them before synchronization or purge')
  }
}

function gitAssetImportReview(
  entry: StorageGitContentEntry, user: WikiUser, locationKey: string, maxBytes: number,
  previous?: StorageGitContentEntry, reviewedReplacement = false
): StorageAssetImportReview {
  let preparedTransaction: Knex.Transaction | undefined
  const turn = currentGitMutationTurn()
  const expected = previous ?? entry
  return {
    ...(previous === undefined ? {} : { previousPath: previous.owner?.path ?? previous.sourcePath }),
    async prepare(transaction) {
      await requireSystemAuthority(transaction, { user }, true)
      const auth = wiki.auth as unknown as {
        loadPageRuleAuthority(user: WikiUser, transaction: Knex.Transaction): Promise<PageRuleAuthority>
        checkPageAccess(user: WikiUser, permissions: readonly string[], context: { path: string }, authority: PageRuleAuthority): boolean
      }
      const authority = await auth.loadPageRuleAuthority(user, transaction)
      for (const assetPath of new Set([entry.sourcePath, expected.owner?.path ?? expected.sourcePath])) {
        if (!auth.checkPageAccess(user, ['manage:system', 'write:assets'], { path: assetPath }, authority)) throw new Error('Native Git asset import authority is unavailable')
      }
      await guardStorageImportReview(transaction)
      await turn.assertHeld(transaction)
      preparedTransaction = transaction
    },
    async check(transaction) {
      if (preparedTransaction !== transaction) throw new Error('Native Git asset import authority was not prepared in this transaction')
      if (previous !== undefined && (entry.owner !== null || !previous.sourceAvailable || previous.owner === null ||
          (previous.owner.sourceSha256 ?? previous.owner.sha256) !== previous.sourceSha256 ||
          await transaction('assets').where({ hash: assetHelper.generateHash(entry.sourcePath) }).first('id'))) {
        throw new Error('Git asset rename source proof or destination ownership changed')
      }
      const asset = await transaction('assets').where({ hash: assetHelper.generateHash(expected.owner?.path ?? expected.sourcePath) }).first('*')
      if (expected.owner === null) {
        if (asset !== undefined) throw new Error('Git asset destination acquired an unrelated native owner after review')
      } else {
        if (asset?.id !== expected.owner.id) throw new Error('Reviewed Git asset import owner changed')
        const data = await transaction('assetData').where({ id: asset.id }).whereRaw('length(data) <= ?', [maxBytes]).first('data')
        if (!data || !(data.data instanceof Uint8Array)) throw new Error('Reviewed Git asset import bytes are unavailable')
        const sha256 = createHash('sha256').update(data.data).digest('hex')
        if (sha256 !== expected.owner.sha256 || gitContentDigest({ asset, sha256 }) !== expected.owner.revision ||
            !expected.owner.sourceOwned && !reviewedReplacement) throw new Error('Reviewed Git asset import owner/revision/hash changed')
        const metadata: unknown = typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata
        const hasClaim = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) && Object.hasOwn(metadata, 'storage_import')
        const proof = storageAssetImportOwner(asset.metadata)
        if (hasClaim && (proof === undefined || proof.sourceKey !== expected.sourceKey || proof.sourcePath !== expected.sourcePath || proof.assetId !== asset.id)) {
          throw new Error('Another or unverified native source owns this asset. Retain it and reconcile ownership through native asset administration before importing.')
        }
        if (!reviewedReplacement || previous !== undefined) {
          if (proof?.sourceKey !== expected.sourceKey || proof.sourcePath !== expected.sourcePath || proof.assetId !== asset.id ||
              proof.assetSha256 !== sha256 || proof.sourceSha256 !== (expected.owner.sourceSha256 ?? expected.owner.sha256)) {
            throw new Error('Current native Git source ownership is unavailable; preserve and review the canonical asset')
          }
        }
      }
      await turn.assertHeld(transaction)
      return { sourceKey: entry.sourceKey, sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256,
        locationKey, mapped: false }
    },
    async beforeCommit(transaction) {
      if (preparedTransaction !== transaction) throw new Error('Native Git asset import authority was not prepared in this transaction')
      await requireSystemAuthority(transaction, { user }, true)
      await guardStorageImportReview(transaction)
      await turn.assertHeld(transaction)
    }
  }
}

/** A visibility choice is never itself deletion authority: recheck native proof under locks. */
async function reconcileGitContent(
  admission: StorageImportAdmission,
  entry: StorageGitContentEntry,
  choice: StorageGitContentChoice,
  user: WikiUser,
  locationKey: string
): Promise<void> {
  const owner = entry.owner
  if ((choice.action !== 'remove' && choice.action !== 'remap') || owner === null || !owner.sourceOwned) {
    throw new Error(`Git content has no reviewed native source owner: ${entry.sourcePath}`)
  }
  const previous = gitPreviousContent(admission).find(source => source.path === entry.sourcePath)
  if (previous !== undefined) {
    if (createHash('sha256').update(previous.bytes).digest('hex') !== entry.sourceSha256) throw new Error('Pinned old Git content changed')
  } else {
    const admitted = admission.filesByPath.get(entry.sourcePath)
    if (admitted?.kind !== 'file') throw new Error(`Actual old Git content is unavailable: ${entry.sourcePath}`)
    const source = await admission.root.openFile(entry.sourcePath, admitted.identity)
    try {
      if (await source.sha256Bounded(admission.budget.maxBytes) !== entry.sourceSha256) throw new Error('Reviewed Git content changed after preflight')
    } finally { await source.close() }
  }
  await guardStorageImportReview()
  const turn = currentGitMutationTurn()
  if (owner.kind === 'page') {
    const page = await wiki.models.pages.getPageFromDb({ path: owner.path, locale: owner.locale, visibility: 'public', ownerId: null })
    const [association] = await loadStoragePageImportOwners(wiki.models.knex, { pageIds: [owner.id], limit: 1 })
    if (page?.id !== owner.id || String(page.sourceRevision) !== owner.revision ||
        association === undefined || !storagePageImportOwnerMatches(association, page) ||
        association.sourceKey !== entry.sourceKey || association.sourcePath !== entry.sourcePath ||
        association.locationKey !== locationKey ||
        association.sourceSha256 !== entry.sourceSha256) throw new Error('Reviewed Git page ownership changed')
    if (choice.action === 'remove') {
      await wiki.models.pages.deletePage({ user, id: owner.id, path: owner.path, locale: owner.locale,
        expectedSourceRevision: owner.revision, skipStorage: true, canonicalTransactionHook: gitPageDeleteHook(association, user) })
    } else if (choice.action === 'remap') {
      const destinationPath = choice.destinationPath!
      assertNativeStoragePageIdentity({ path: destinationPath, locale: owner.locale }, entry.sourcePath)
      if (destinationPath === owner.path) return
      const canonicalTransactionHook: CanonicalTransactionHook = async (transaction, committed) => {
        await guardStorageImportReview(transaction)
        const [persisted] = await loadStoragePageImportOwners(transaction, { pageIds: [owner.id], limit: 1 })
        if (!sameGitPageAcceptance(persisted, association)) throw new Error('Reviewed Git page association changed before remap')
        await recordStoragePageImportOwner(transaction, {
          owner: { sourceKey: association.sourceKey, sourcePath: association.sourcePath, sourceSha256: association.sourceSha256,
            locationKey: association.locationKey, mapped: true },
          pageId: committed.id, sourceRevision: committed.sourceRevision, outboxId: committed.outboxId
        })
        await turn.assertHeld(transaction)
      }
      await wiki.models.pages.movePage({ user, id: owner.id, path: owner.path, locale: owner.locale, destinationPath,
        destinationLocale: owner.locale, expectedSourceRevision: association.nativeRevision, okfProducer: 'import:git', skipStorage: true,
        canonicalTransactionHook })
    }
    return
  }
  await withAssetLocationLocks(['assets'], async (assertHeld, connection) => {
    const transaction = await wiki.models.knex.transaction(connection === undefined ? undefined : { connection })
    let committed = false
    try {
      await assertHeld?.()
      await requireSystemAuthority(transaction, { user }, true)
      const auth = wiki.auth as unknown as {
        loadPageRuleAuthority(user: WikiUser, transaction: Knex.Transaction): Promise<PageRuleAuthority>
        checkPageAccess(user: WikiUser, permissions: readonly string[], context: { path: string }, authority: PageRuleAuthority): boolean
      }
      const authority = await auth.loadPageRuleAuthority(user, transaction)
      if (!auth.checkPageAccess(user, ['manage:system', 'manage:assets'], { path: owner.path }, authority)) throw new Error('Native Git asset mutation authority is unavailable')
      const destination = choice.action === 'remap' ? choice.destinationPath! : undefined
      if (destination !== undefined) {
        assertStorageAssetDestinationAllowed(destination)
        if (!auth.checkPageAccess(user, ['manage:system', 'write:assets'], { path: destination }, authority)) throw new Error('Native Git asset destination authority is unavailable')
      }
      await guardStorageImportReview(transaction)
      await turn.assertHeld(transaction)
      if (destination !== undefined) await assertNoPublicStoragePageAtPath(transaction, destination)
      const paths = destination === undefined ? [owner.path] : [owner.path, destination].sort()
      for (const assetPath of paths) await lockAssetLocation(transaction, assetPath)
      const asset = await transaction('assets').where({ id: owner.id }).forUpdate().first('*')
      const data = await transaction('assetData').where({ id: owner.id }).whereRaw('length(data) <= ?', [admission.budget.maxBytes]).forUpdate().first('data')
      if (!asset || !data || !(data.data instanceof Uint8Array)) throw new Error('Reviewed Git asset owner is unavailable')
      const sha256 = createHash('sha256').update(data.data).digest('hex')
      if (asset.hash !== assetHelper.generateHash(owner.path) || (owner.sourceSha256 ?? entry.sourceSha256) !== entry.sourceSha256 ||
          sha256 !== owner.sha256 || gitContentDigest({ asset, sha256 }) !== owner.revision) throw new Error('Reviewed Git asset ownership or bytes changed')
      await assertAssetLocationAssetSettled(transaction, owner.id)
      await assertAssetLocationReservations(transaction, paths)
      const nativeProof = storageAssetImportOwner(asset.metadata)
      if (nativeProof?.sourceKey !== entry.sourceKey || nativeProof.sourcePath !== entry.sourcePath ||
          nativeProof.sourceSha256 !== entry.sourceSha256 || nativeProof.assetId !== owner.id || nativeProof.assetSha256 !== sha256) {
        throw new Error('Current native Git source ownership is unavailable; preserve and review the canonical asset')
      }
      if (destination !== undefined) {
        if (await transaction('assets').where({ hash: assetHelper.generateHash(destination) }).first('id')) throw new Error('Git asset remap destination is occupied')
        const folderId = await commonDisk.resolveAssetFolder(destination, transaction)
        const metadata: unknown = typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Native asset metadata is unavailable for reviewed remap')
        await queryGitAssets(transaction).patch({
          filename: path.posix.basename(destination), folderId, hash: assetHelper.generateHash(destination),
          metadata: { ...metadata, storage_import: { ...nativeProof, mapped: destination !== entry.sourcePath } }
        }).findById(owner.id)
      } else {
        await transaction('assetData').where({ id: owner.id }).delete()
        await queryGitAssets(transaction).delete().where({ id: owner.id })
      }
      await turn.assertHeld(transaction)
      await transaction.commit()
      committed = true
      await assertHeld?.()
      const nativeAssets = wiki.models.assets as unknown as { deleteAssetCaches(hashes: readonly string[]): Promise<void> }
      await nativeAssets.deleteAssetCaches(destination === undefined
        ? [String(asset.hash)]
        : [String(asset.hash), assetHelper.generateHash(destination)])
    } finally {
      if (!committed) await transaction.rollback()
    }
  }, wiki.models.knex)
}

const plugin: GitStoragePlugin = {
  git: null,
  root: null,
  repoPath: path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'repo'),
  async activated() {},
  async deactivated() {
    const root = this.root
    this.root = null
    this.git = null
    if (root) await root.close()
  },
  /**
   * INIT
   */
  async init() {
    wiki.logger.info('(STORAGE/GIT) Initializing...')
    const previousRoot = this.root
    this.root = null
    this.git = null
    this.quarantined = false
    if (previousRoot) await previousRoot.close()
    this.repoPath = path.resolve(wiki.ROOTPATH, this.config.localRepoPath)
    try {
      assertBranch(this.config.branch)
      const repositoryIssue = storageGitRepositoryIssue(this.config.repoUrl, this.config.authType)
      if (repositoryIssue) throw new Error(repositoryIssue)
      await mkdir(this.repoPath, { recursive: true, mode: 0o700 })
      this.root = await openStorageRoot(this.repoPath)
      this.git = true

      const command = nativeGit(this, currentGitMutationTurn().deadlineAt)
      this.initializing = true

      // Initialize repo (if needed)
      wiki.logger.info('(STORAGE/GIT) Checking repository state...')
      let isRepo = false
      try {
        isRepo =
          (await runNativeText(command, ['rev-parse', '--is-inside-work-tree'])) === 'true' &&
          path.resolve(await runNativeText(command, ['rev-parse', '--show-toplevel'])) === this.repoPath
      } catch (error) {
        if (!(error instanceof BoundedProcessError && error.kind === 'exit')) throw error
      }
      if (!isRepo) {
        wiki.logger.info('(STORAGE/GIT) Initializing local repository...')
        await command.run(['init'])
      }
      this.initializing = false

      // Disable quotePath, color output
      // Link https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath
      await command.run(['config', '--local', 'core.quotepath', 'false'])
      await command.run(['config', '--local', 'color.ui', 'false'])

      // Set default author
      await command.run(['config', '--local', 'user.email', this.config.defaultEmail])
      await command.run(['config', '--local', 'user.name', this.config.defaultName])

      // Purge existing remotes
      wiki.logger.info('(STORAGE/GIT) Listing existing remotes...')
      const remotes = (await runNativeText(command, ['remote'])).split('\n').filter(Boolean)
      if (remotes.length > 0) {
        wiki.logger.info('(STORAGE/GIT) Purging existing remotes...')
        for (const remote of remotes) await command.run(['remote', 'remove', remote])
      }

      // Add remote
      wiki.logger.info('(STORAGE/GIT) Setting SSL Verification config...')
      await command.run(['config', '--local', '--bool', 'http.sslVerify', _.toString(this.config.verifySSL)])
      switch (this.config.authType) {
        case 'ssh': {
          wiki.logger.info('(STORAGE/GIT) Setting SSH Command config...')
          const dataPath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath)
          const identityPath =
            this.config.sshPrivateKeyMode === 'contents'
              ? await writeGitStorageConnectionFile(dataPath, 'git-ssh.pem', this.config.sshPrivateKeyContent)
              : this.config.sshPrivateKeyPath
          const knownHostsPath =
            typeof this.config.sshKnownHosts === 'string' && this.config.sshKnownHosts.trim()
              ? await writeGitStorageConnectionFile(dataPath, 'git-known-hosts', this.config.sshKnownHosts)
              : undefined
          await command.run(['config', '--local', 'core.sshCommand', gitStorageSshCommand(identityPath, knownHostsPath)])
          wiki.logger.info('(STORAGE/GIT) Adding origin remote via SSH...')
          await command.run(['remote', 'add', 'origin', this.config.repoUrl.trim()])
          break
        }
        default: {
          wiki.logger.info('(STORAGE/GIT) Adding origin remote via HTTP/S...')
          const originUrl = gitStorageHttpRemote(this.config.repoUrl, this.config.basicUsername ?? '', this.config.basicPassword ?? '')
          await command.run(['remote', 'add', 'origin', originUrl])
          break
        }
      }
      if (await hasPendingCanonicalMutations(this)) {
        // Replay admitted canonical effects before importing an older remote or touching a dirty crash worktree.
        await recoverInterruptedGitOperation(nativeRepository(command), wiki.logger)
        const head = await resolveCommit(command, 'HEAD', true)
        const branch = this.config.branch
        assertBranch(branch)
        if (head === null) await command.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
        else {
          if ((await runNativeText(command, ['symbolic-ref', '--short', 'HEAD'])) !== branch) {
            throw new Error('Pending canonical storage mutations belong to a different checked-out branch')
          }
          await admitGitTree(command, head, { maxAssetBytes: wiki.config.uploads.maxFileSize })
        }
        await collectStorageEntries(this.root)
        wiki.logger.info('(STORAGE/GIT) Retaining the working copy for pending canonical mutation replay before synchronization.')
        return
      }

      // sync performs the one configured-branch fetch and pinned reconciliation.
      await synchronizeGit.call(this)
      wiki.logger.info('(STORAGE/GIT) Initialization completed.')
    } catch (error: unknown) {
      this.initializing = false
      if (shouldQuarantineGitFailure(error)) await quarantineGitContext(this)
      else {
        const root = this.root
        this.root = null
        this.git = null
        if (root) await root.close()
      }
      throw error
    }
  },
  /**
   * SYNC
   */
  async sync() {
    const root = requireRoot(this)
    requireGit(this)
    const branch = this.config.branch
    assertBranch(branch)
    const deadlineAt = currentGitMutationTurn().deadlineAt
    const command = nativeGit(this, deadlineAt)
    const repository = nativeRepository(command)
    try {
      if (await hasPendingCanonicalMutations(this)) throw new GitStorageBusyError()
      const recovered = await recoverInterruptedGitOperation(repository, wiki.logger)
      await assertGitWorktreeSettled(command)
      await observeGitStorage(this, deadlineAt)

      // Resolve and admit the current branch before any checkout or reconciliation.
      const currentCommit = await resolveCommit(command, branch, true)
      if (currentCommit !== null) {
        await admitGitTree(command, currentCommit, { maxAssetBytes: wiki.config.uploads.maxFileSize })
      }
      const importRef = `refs/wiki/pending-import/${branch}`
      let importBase = await resolveCommit(command, importRef, true)
      const recoveringImport = importBase !== null
      if (importBase === null && currentCommit !== null && _.includes(['sync', 'pull'], this.mode)) {
        importBase = currentCommit
        await command.run(['update-ref', importRef, currentCommit])
      }
      if (importBase !== null) await admitGitTree(command, importBase, { maxAssetBytes: wiki.config.uploads.maxFileSize })

      // This is the sole network fetch in a synchronization. Every later command
      // uses the returned object ID, never the mutable remote-tracking ref.
      wiki.logger.info(`(STORAGE/GIT) Fetching branch ${branch} from origin...`)
      const fetchedCommit = await fetchConfiguredBranch(command, branch)
      await admitGitTree(command, fetchedCommit, { maxAssetBytes: wiki.config.uploads.maxFileSize })

      wiki.logger.info(`(STORAGE/GIT) Checking out branch ${branch}...`)
      if (currentCommit === null) await command.run(['checkout', '-B', branch, fetchedCommit])
      else await command.run(['checkout', branch])

      let reattached = false
      let conflicted: string[] = []
      if (currentCommit !== null && !(await sharesHistoryWith(repository, fetchedCommit))) {
        if (recoveringImport) throw new Error('Pending Git imports must be recovered before reattaching unrelated history')
        await reattachUnrelatedHistory(repository, fetchedCommit, wiki.logger)
        reattached = true
        wiki.logger.warn(`(STORAGE/GIT) Reattached local history to origin/${branch}; existing wiki content remains authoritative.`)
      } else if (currentCommit !== null && _.includes(['sync', 'pull'], this.mode)) {
        wiki.logger.info(`(STORAGE/GIT) Performing pinned pull rebase from origin on branch ${branch}...`)
        conflicted = await pullRemoteAuthoritative(repository, fetchedCommit, wiki.logger)
      }

      const finalCommit = await resolveCommit(command, 'HEAD')
      if (finalCommit === null) throw new Error(`Unable to determine the final commit for branch ${branch}`)
      await admitGitTree(command, finalCommit, { maxAssetBytes: wiki.config.uploads.maxFileSize })

      let plan: GitStorageImportPlan | undefined
      if (_.includes(['sync', 'pull'], this.mode) && importBase !== null && !reattached && importBase !== finalCommit) {
        let admission: StorageImportAdmission
        try {
          admission = await collectGitContentEntries(root, wiki.config.uploads.maxFileSize)
        } catch (error: unknown) {
          throw new BoundedProcessError('parser', `Git worktree admission failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        const changes = await streamGitNameStatus(command, importBase, finalCommit)
        plan = await buildGitImportPlan(root, admission, changes, command, importBase)
        await inspectGitPreviousContent(admission, this.config, command)
      }

      if (_.includes(['sync', 'push'], this.mode)) {
        wiki.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${branch}...`)
        // Respect explicitly configured signing; server support alone does not
        // establish that the application has a signing identity.
        await command.run(['push', 'origin', branch], { captureStdout: false })
      }

      if (recovered) wiki.logger.warn(`(STORAGE/GIT) Recovered an unfinished ${recovered} before synchronization.`)
      if (conflicted.length > 0) {
        wiki.logger.warn(`(STORAGE/GIT) ${conflicted.length} conflicting path(s) used the remote version; prior page revisions remain in page history.`)
      }
      if (plan !== undefined) {
        const rootUser = await wiki.models.users.getRootUser()
        const results = await this.processFiles(plan, rootUser)
        if (results.every(result => result.ok)) {
          await command.run(['update-ref', '-d', importRef])
        }
        return results
      }
      if (_.includes(['sync', 'pull'], this.mode)) {
        await command.run(['update-ref', '-d', importRef])
      }
      return []
    } catch (error: unknown) {
      if (shouldQuarantineGitFailure(error)) await quarantineGitContext(this)
      throw error
    }
  },
  /**
   * Process Files
   *
   * @param {Array<String>} files Array of files to process
   */
  async processFiles(plan: GitStorageImportPlan, user: WikiUser) {
    const root = requireRoot(this)
    if (plan.admission.root !== root) throw new Error('Git import admission belongs to a different storage root')
    const admission = plan.admission
    const files = [...plan.files]
    const previousGitSources = new Map(gitPreviousContent(admission).map(source => [source.path, source]))
    let importHead: string | undefined
    const plannedOld = new Set(files.filter(item => !item.importAll && (item.status === 'R' || item.status === 'D')).map(item => item.oldPath))
    const indexes = new Map(files.map((item, index) => [item.relPath, index]))
    for (const previous of previousGitSources.values()) {
      if (previous.retained || plannedOld.has(previous.path)) continue
      let item: GitStorageFile
      if (previous.destinationPath !== undefined) {
        const index = indexes.get(previous.destinationPath)
        if (index === undefined) throw new Error(`Pending Git rename destination is unavailable: ${previous.destinationPath}`)
        item = { ...files[index]!, oldPath: previous.path, status: 'R', importAll: false }
        files[index] = item
      } else {
        if (admission.filesByPath.has(previous.path)) continue
        item = { file: { stats: { size: previous.bytes.byteLength } }, oldPath: previous.path, relPath: previous.path,
          binary: !pageHelper.getContentType(previous.path), status: 'D', importAll: false, insertions: 0, deletions: 1, before: 0, after: 0 }
        files.push(item)
      }
      previousPageSources.set(item, previous.bytes)
      plannedOld.add(previous.path)
    }
    const seen = new Set<string>()
    for (const item of files) {
      const status = item.status ?? (item.relPath !== item.oldPath ? 'R' : item.deletions > 0 && item.insertions === 0 ? 'D' : 'M')
      assertGitPath(item.oldPath)
      assertGitPath(item.relPath)
      const key = `${status}\0${item.oldPath}\0${item.relPath}`
      if (seen.has(key)) throw new BoundedProcessError('parser', `Git import plan contains a duplicate change: ${item.relPath}`)
      seen.add(key)
      const entry = admission.filesByPath.get(item.relPath)
      if (!item.importAll && status !== 'D' && (entry === undefined || entry.kind !== 'file')) {
        throw new BoundedProcessError('parser', `Git import plan has no admitted destination: ${item.relPath}`)
      }
    }
    const previousSources: StorageImportPreviousSource[] = []
    for (const item of files) {
      const status = item.status ?? (item.relPath !== item.oldPath ? 'R' : item.deletions > 0 && item.insertions === 0 ? 'D' : 'M')
      if (item.importAll || (status !== 'D' && status !== 'R')) continue
      const oldType = pageHelper.getContentType(item.oldPath)
      const newType = pageHelper.getContentType(item.relPath)
      if (status === 'R' && Boolean(oldType) !== Boolean(newType)) throw new Error(`Git rename changes page/asset ownership class: ${item.oldPath} -> ${item.relPath}`)
      if (!oldType) continue
      const rawDocument = previousPageSources.get(item)
      if (rawDocument === undefined) throw new Error(`Previous Git page source is unavailable: ${item.oldPath}`)
      previousSources.push({
        sourcePath: item.oldPath, contentType: oldType, rawDocument,
        ...(status === 'R' ? { destinationSourcePath: item.relPath } : {})
      })
    }
    const identities = await prepareStorageImportIdentities(admission, this.config ?? {}, 'GIT', previousSources)
    const sourceHashes = new Map(identities.preview.entries.map(entry => [entry.sourcePath, entry.sourceSha256]))

    const results: GitStorageImportResult[] = []
    const choices = identities.gitChoices ?? new Map<string, StorageGitContentChoice>()
    const contentEntries = identities.gitContent ?? new Map<string, StorageGitContentEntry>()
    const handled = new Set<string>()
    const importLocationKey = storageImportLocationKey('GIT', this.config ?? {})
    for (const entry of contentEntries.values()) {
      const action = gitContentAction(entry, choices)
      if ((action === 'retain' || action === 'remap') && entry.sourceRevision && entry.sourceAvailable) {
        try {
          await guardStorageImportReview()
          await mutationGit(this).run(['update-ref', gitRetainedContentRef(entry.sourceKey, entry.sourcePath), entry.sourceRevision])
        } catch (error) {
          handled.add(entry.sourcePath)
          results.push({ kind: entry.kind, relPath: entry.sourcePath, ok: false, outcome: 'conflict',
            error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (action === 'conflict') {
        handled.add(entry.sourcePath)
        results.push({ kind: entry.kind, relPath: entry.sourcePath, ok: false, outcome: 'conflict',
          error: 'Excluded Git content has a canonical record. Preview Utilities → Content import and explicitly retain, remap, or remove its exact source association.' })
      } else if (action === 'remove' || action === 'remap') {
        handled.add(entry.sourcePath)
        try {
          await reconcileGitContent(admission, entry, choices.get(entry.sourcePath)!, user, importLocationKey)
          results.push({ kind: entry.kind, relPath: entry.sourcePath, ok: true })
        } catch (error) {
          results.push({ kind: entry.kind, relPath: entry.sourcePath, ok: false, outcome: 'conflict',
            error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    const effective: GitStorageFile[] = []
    for (const item of files) {
      const status = item.status ?? (item.relPath !== item.oldPath ? 'R' : item.deletions > 0 && item.insertions === 0 ? 'D' : 'M')
      const oldEntry = contentEntries.get(item.oldPath)
      const newEntry = contentEntries.get(item.relPath)
      const oldVisible = !gitDotContentPath(item.oldPath) || oldEntry !== undefined && gitContentAction(oldEntry, choices) === 'include'
      const newVisible = !gitDotContentPath(item.relPath) || newEntry !== undefined && gitContentAction(newEntry, choices) === 'include'
      if (handled.has(item.oldPath) || handled.has(item.relPath)) {
        if (status === 'R' && !oldVisible && newVisible && !handled.has(item.relPath) &&
            (newEntry === undefined || gitContentAction(newEntry, choices) === 'include') &&
            choices.get(item.oldPath)?.action === 'remove' && results.find(result => result.relPath === item.oldPath)?.ok === true) {
          effective.push({ ...item, oldPath: item.relPath, status: 'A' })
        }
        continue
      }
      if (status === 'R' && oldVisible && !newVisible) {
        const action = oldEntry === undefined ? undefined : gitContentAction(oldEntry, choices)
        if (action !== 'retain') results.push({ kind: item.binary ? 'asset' : 'page', relPath: item.oldPath, ok: false,
          outcome: 'conflict', error: 'Visible-to-excluded Git rename requires reviewed source-owned removal or explicit retention; canonical content was preserved.' })
        else results.push({ kind: item.binary ? 'asset' : 'page', relPath: item.oldPath, ok: true })
        continue
      }
      if (newEntry !== undefined && gitContentAction(newEntry, choices) === 'retain') {
        results.push({ kind: item.binary ? 'asset' : 'page', relPath: item.relPath, ok: true })
        continue
      }
      if (status === 'R' && oldEntry !== undefined && gitContentAction(oldEntry, choices) === 'retain') {
        if (newVisible) effective.push({ ...item, oldPath: item.relPath, status: 'A', insertions: 1, deletions: 0 })
        continue
      }
      if (status === 'R' && !oldVisible && newVisible) {
        effective.push({ ...item, oldPath: item.relPath, status: 'A', insertions: 1, deletions: 0 })
        continue
      }
      if (newEntry?.kind === 'asset' && newEntry.owner !== null &&
          (newEntry.owner.path !== item.relPath || !newEntry.owner.sourceOwned && choices.get(item.relPath)?.action !== 'include')) {
        results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict',
          error: 'Review and retain the exact native asset source association before importing changed or remapped content.' })
        continue
      }
      if (!newVisible) {
        results.push({ kind: item.binary ? 'asset' : 'page', relPath: item.relPath, ok: true })
        continue
      }
      effective.push(item)
    }
    for (const item of effective) {
      const status = item.status ?? (item.relPath !== item.oldPath ? 'R' : item.deletions > 0 && item.insertions === 0 ? 'D' : 'M')
      const entry = admission.filesByPath.get(item.relPath)
      const expectedStats = entry !== undefined && entry.kind === 'file' ? entry.identity : undefined
      if (!item.importAll && status !== 'D' && expectedStats === undefined) {
        throw new BoundedProcessError('parser', `Git import plan has no admitted destination: ${item.relPath}`)
      }
      let source: StorageFileHandle | undefined
      let committedPageMove: { pageId: number; sourceRevision: string; outboxId: string } | undefined
      try {
        const contentType = pageHelper.getContentType(item.relPath)
        let fileExists = false
        try {
          source = await root.openFile(item.relPath, expectedStats)
          fileExists = true
        } catch (error: unknown) {
          if (!isImportSourceMissing(error)) throw error
        }
        if (!item.binary && contentType) {
          if (fileExists && !item.importAll && status === 'R') {
            const previous = identities.previous.get(item.oldPath)
            const destination = identities.pages.get(item.relPath)
            if (previous == null || destination === undefined) throw new Error('Git rename has no admitted source ownership')
            const contentPath = previous.identity
            const contentDestinationPath = destination.identity
            const owned = await wiki.models.pages.getPageFromDb({
              path: contentPath.path, locale: contentPath.locale, visibility: 'public', ownerId: null
            })
            const [association] = await loadStoragePageImportOwners(wiki.models.knex, {
              pageIds: previous.existingPageId === null ? [] : [previous.existingPageId], limit: 1
            })
            if (owned?.id !== previous.existingPageId || String(owned.sourceRevision) !== previous.expectedSourceRevision ||
                association === undefined || !storagePageImportOwnerMatches(association, owned) ||
                association.sourceKey !== previous.sourceKey || association.sourceKey !== destination.sourceKey ||
                association.locationKey !== previous.locationKey || association.locationKey !== destination.locationKey ||
                association.locationKey !== importLocationKey) {
              throw new Error(`Git rename owner changed after preflight: ${item.oldPath}. Preserve this page and preview its current native revision.`)
            }
            if (source === undefined || await source.sha256Bounded(OKF_MAX_DOCUMENT_BYTES) !== destination.sourceSha256) {
              throw new Error(`Git rename source changed after preflight: ${item.relPath}`)
            }
            await guardStorageImportReview()
            const oldGit = previousGitSources.get(item.oldPath)
            const command = mutationGit(this)
            if (oldGit === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oldGit.revision) ||
                await resolveCommit(command, oldGit.revision) !== oldGit.revision ||
                createHash('sha256').update(oldGit.bytes).digest('hex') !== previous.sourceSha256) {
              throw new Error('The exact old Git commit and raw page source are unavailable for native move proof')
            }
            importHead ??= (await resolveCommit(command, 'HEAD')) ?? undefined
            if (importHead === undefined) throw new Error('The exact new Git commit is unavailable for native page move proof')
            const oldBlob = await command.run(['show', `${oldGit.revision}:${item.oldPath}`], { maxStdoutBytes: OKF_MAX_DOCUMENT_BYTES })
            const newBlob = await command.run(['show', `${importHead}:${item.relPath}`], { maxStdoutBytes: OKF_MAX_DOCUMENT_BYTES })
            if (createHash('sha256').update(oldBlob.stdout).digest('hex') !== previous.sourceSha256 ||
                createHash('sha256').update(newBlob.stdout).digest('hex') !== destination.sourceSha256) {
              throw new Error('Pinned Git rename paths or raw source hashes changed')
            }
            const scope = {
              fromGitRevision: oldGit.revision, toGitRevision: importHead,
              oldSourcePath: item.oldPath, newSourcePath: item.relPath,
              oldSourceSha256: previous.sourceSha256, newSourceSha256: destination.sourceSha256
            }
            const recorded = association.moveBinding
            const replay = recorded !== null && Object.entries(scope).every(([key, value]) => Reflect.get(recorded, key) === value)
            let acceptedMoveBinding: StoragePageImportMoveBinding | undefined
            let completedReplay = false
            if (replay && recorded !== null) {
              if (association.nativePath !== contentDestinationPath.path || association.nativeLocaleCode !== contentDestinationPath.locale ||
                  association.mapped !== destination.mapped || BigInt(recorded.moveNativeRevision) <= BigInt(recorded.previousNativeRevision)) {
                throw new Error('Recorded native Git move identities changed; preserve the page and review its current owner')
              }
              if (recorded.phase === 'moved') {
                if (association.nativeRevision !== recorded.moveNativeRevision || association.operationId !== recorded.moveOperationId ||
                    association.sourcePath !== item.oldPath || association.sourceSha256 !== previous.sourceSha256) {
                  throw new Error('Pending native Git move no longer has its exact accepted source revision')
                }
                acceptedMoveBinding = recorded
                committedPageMove = { pageId: owned.id, sourceRevision: recorded.moveNativeRevision, outboxId: recorded.moveOperationId }
              } else {
                if (association.sourcePath !== item.relPath || association.sourceSha256 !== destination.sourceSha256 ||
                    BigInt(association.nativeRevision) <= BigInt(recorded.moveNativeRevision) || association.operationId === recorded.moveOperationId) {
                  throw new Error('Completed native Git move no longer has its exact accepted result')
                }
                completedReplay = true
              }
            } else {
              if (recorded?.phase === 'moved' || association.sourcePath !== item.oldPath || association.sourceSha256 !== previous.sourceSha256) {
                throw new Error('Git rename has no exact accepted old-source association; preserve and review the native page')
              }
              const sameDestination = contentPath.path === contentDestinationPath.path && contentPath.locale === contentDestinationPath.locale
              if (sameDestination) {
                if (destination.reviewedReplacement !== true) {
                  throw new Error('A Git filename rename at the same native location requires a fresh explicit destination review; no-op cannot adopt the new source.')
                }
              } else {
                const canonicalTransactionHook: CanonicalTransactionHook = async (transaction, committed) => {
                  await guardStorageImportReview(transaction)
                  const [persisted] = await loadStoragePageImportOwners(transaction, { pageIds: [owned.id], limit: 1 })
                  if (committed.id !== owned.id || BigInt(committed.sourceRevision) <= BigInt(association.nativeRevision) ||
                      !sameGitPageAcceptance(persisted, association)) {
                    throw new Error('Native Git move accepted source changed inside its canonical transaction')
                  }
                  const binding: StoragePageImportMoveBinding = {
                    ...scope, phase: 'moved', previousNativeRevision: association.nativeRevision,
                    previousNativePath: association.nativePath, previousNativeLocaleCode: association.nativeLocaleCode,
                    moveOperationId: committed.outboxId, moveNativeRevision: committed.sourceRevision
                  }
                  await assertGitPageMoveEffect(transaction, binding, committed.id, contentDestinationPath, owned.content)
                  const accepted = await recordStoragePageImportOwner(transaction, {
                    owner: { sourceKey: association.sourceKey, sourcePath: association.sourcePath, sourceSha256: association.sourceSha256,
                      locationKey: association.locationKey, mapped: destination.mapped },
                    pageId: committed.id, sourceRevision: committed.sourceRevision, outboxId: committed.outboxId, moveBinding: binding
                  })
                  acceptedMoveBinding = accepted.moveBinding ?? undefined
                  await currentGitMutationTurn().assertHeld(transaction)
                }
                await wiki.models.pages.movePage({
                  user, id: owned.id, path: contentPath.path, destinationPath: contentDestinationPath.path,
                  locale: contentPath.locale, destinationLocale: contentDestinationPath.locale,
                  okfProducer: 'import:git', expectedSourceRevision: association.nativeRevision, skipStorage: true,
                  canonicalTransactionHook
                })
                if (acceptedMoveBinding === undefined) throw new Error('Native Git move did not expose its actual accepted result')
                committedPageMove = { pageId: owned.id, sourceRevision: acceptedMoveBinding.moveNativeRevision, outboxId: acceptedMoveBinding.moveOperationId }
              }
            }
            const pageResult = await commonDisk.processPage({
              user, relPath: item.relPath, root, contentType, moduleName: 'GIT', source, ingestion: this.config ?? {},
              noOpOnly: completedReplay,
              ...(acceptedMoveBinding === undefined ? {} : { acceptedMoveBinding }),
              identity: { ...destination, existingPageId: owned.id,
                expectedSourceRevision: acceptedMoveBinding?.moveNativeRevision ?? association.nativeRevision }
            })
            results.push({ kind: 'page', ...pageResult })
            continue
          }
          if (!fileExists && !item.importAll && status === 'D') {
            wiki.logger.info(`(STORAGE/GIT) Page marked as deleted: ${item.relPath}`)
            const previous = identities.previous.get(item.oldPath)
            if (previous === undefined) throw new Error(`Git delete has no admitted source ownership: ${item.oldPath}`)
            if (previous === null) {
              results.push({ kind: 'page', relPath: item.relPath, ok: true })
              continue
            }
            const contentPath = previous.identity
            const owned = await wiki.models.pages.getPageFromDb({
              path: contentPath.path, locale: contentPath.locale, visibility: 'public', ownerId: null
            })
            if (owned?.id !== previous.existingPageId || String(owned.sourceRevision) !== previous.expectedSourceRevision) {
              throw new Error(`Git delete owner changed after preflight: ${item.oldPath}`)
            }
            const [association] = await loadStoragePageImportOwners(wiki.models.knex, {
              pageIds: previous.existingPageId === null ? [] : [previous.existingPageId], limit: 1
            })
            if (association === undefined || !storagePageImportOwnerMatches(association, owned) ||
                association.sourceKey !== previous.sourceKey || association.sourcePath !== item.oldPath ||
                association.sourceSha256 !== previous.sourceSha256 || association.locationKey !== previous.locationKey ||
                association.locationKey !== importLocationKey) {
              throw new Error(`Git delete has no exact accepted native source revision: ${item.oldPath}`)
            }
            await guardStorageImportReview()
            await wiki.models.pages.deletePage({
              user,
              id: previous.existingPageId,
              expectedSourceRevision: previous.expectedSourceRevision,
              path: contentPath.path,
              locale: contentPath.locale,
              skipStorage: true,
              canonicalTransactionHook: gitPageDeleteHook(association, user)
            })
            results.push({ kind: 'page', relPath: item.relPath, ok: true })
            continue
          }
          if (!source) throw new Error(`Import source does not exist: ${item.relPath}`)
          const identity = identities.pages.get(item.relPath)
          const pageResult = await commonDisk.processPage({
            user,
            relPath: item.relPath,
            root,
            contentType,
            moduleName: 'GIT',
            source,
            ingestion: this.config ?? {},
            ...(identity === undefined ? {} : { identity })
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          if (!item.importAll && status === 'D') {
            const old = contentEntries.get(item.oldPath)
            if (old?.owner?.kind !== 'asset' || !old.owner.sourceOwned) throw new Error('Git asset deletion requires its exact native source owner; preserve and review the canonical record')
            await reconcileGitContent(admission, old, { sourcePath: old.sourcePath, sourceSha256: old.sourceSha256,
              sourceRevision: old.sourceRevision, sourceAvailable: old.sourceAvailable, owner: old.owner, action: 'remove' }, user, importLocationKey)
            results.push({ kind: 'asset', relPath: item.relPath, ok: true })
            continue
          }
          const nativeEntry = contentEntries.get(item.relPath)
          if (nativeEntry === undefined) throw new Error('Git asset import has no complete source ownership inventory')
          const previousAsset = !item.importAll && status === 'R' ? contentEntries.get(item.oldPath) : undefined
          if (!item.importAll && status === 'R' && previousAsset?.owner?.kind !== 'asset') {
            throw new Error('Git asset rename requires its exact old native source owner; preserve and review the canonical record')
          }
          if (!source) throw new Error(`Import source does not exist: ${item.relPath}`)
          const assetSource = source
          const expectedSha256 = sourceHashes.get(item.relPath)
          await commonDisk.processAsset({
            user,
            relPath: item.relPath,
            root,
            file: { relPath: item.relPath, stats: expectedStats ?? { size: 0 } },
            moduleName: 'GIT',
            ...(expectedSha256 == null ? {} : { expectedSha256 }),
            importReview: gitAssetImportReview(nativeEntry, user, importLocationKey, admission.budget.maxBytes,
              previousAsset, choices.get(item.relPath)?.action === 'include'),
            source: assetSource
          })
          results.push({ kind: 'asset', relPath: item.relPath, ok: true })
        }
      } catch (error: unknown) {
        const failure = error instanceof Error ? error.message : String(error)
        const message = committedPageMove
          ? `Native page move already committed (page ${committedPageMove.pageId}, revision ${committedPageMove.sourceRevision}, outbox ${committedPageMove.outboxId}); remaining page import failed: ${failure}`
          : failure
        wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
        wiki.logger.warn(message)
        results.push({
          kind: !item.binary && pageHelper.getContentType(item.relPath) ? 'page' : 'asset',
          relPath: item.relPath,
          ok: false,
          ...(contentEntries.has(item.relPath) ? { outcome: 'conflict' as const } : {}),
          error: message
        })
      } finally {
        if (source) await source.close()
      }
    }
    return results
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(page) {
    const root = requireRoot(this)
    const command = mutationGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing new file ${logIdentity}...`)
    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    await root.writeAtomic(fileName, serializePage(page))

    const gitFilePath = `./${fileName}`
    if (!(await isGitIgnored(command, gitFilePath))) {
      await command.run(['add', '--', gitFilePath])
      await commitGitPaths(
        command,
        `docs: create ${page.contentType === 'markdown' ? fileName : page.path}`,
        [fileName],
        `${page.authorName} <${page.authorEmail}>`
      )
    }
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page, onWritten) {
    const changeReason = PageChangeReasonSchema.parse(page.changeReason)
    const root = requireRoot(this)
    const command = mutationGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing updated file ${logIdentity}...`)
    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    const content = serializePage(page)
    await root.writeAtomic(fileName, content)

    const gitFilePath = `./${fileName}`
    if (!(await isGitIgnored(command, gitFilePath))) {
      await command.run(['add', '--', gitFilePath])
      await commitGitPaths(
        command,
        changeReason ?? `docs: update ${page.contentType === 'markdown' ? fileName : page.path}`,
        [fileName],
        `${page.authorName} <${page.authorEmail}>`
      )
    } else if (onWritten) {
      throw new Error(`Git publication of ${fileName} was skipped because the untracked path is ignored; review the ignore rule and retry without forcing or discarding local work`)
    }
    if (onWritten) {
      await onWritten({
        sourceKey: storageImportSourceKey(root.sourceIdentity, 'GIT', this.config),
        locationKey: storageImportLocationKey('GIT', this.config),
        sourcePath: fileName,
        sourceSha256: createHash('sha256').update(content, 'utf8').digest('hex')
      })
    }
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    const root = requireRoot(this)
    const command = mutationGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing removed file ${logIdentity}...`)

    const gitFilePath = `./${fileName}`
    if (!(await isGitIgnored(command, gitFilePath))) {
      await collectStorageEntries(root)
      await currentGitMutationTurn().assertHeld()
      await root.removeFile(fileName)
      if (await isGitTracked(command, gitFilePath)) await command.run(['add', '-u', '--', gitFilePath])
      await commitGitPaths(
        command,
        `docs: delete ${page.contentType === 'markdown' ? fileName : page.path}`,
        [fileName],
        `${page.authorName} <${page.authorEmail}>`
      )
    }
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    const root = requireRoot(this)
    const command = mutationGit(this)
    const sourceFileName = gitPagePath(page, this.config.alwaysNamespace)
    const destinationFileName = gitPagePath(
      {
        path: page.destinationPath,
        localeCode: page.destinationLocaleCode,
        contentType: page.contentType
      },
      this.config.alwaysNamespace
    )
    const sourceLogIdentity = page.contentType === 'markdown' ? sourceFileName : `[${page.localeCode}] ${page.path}`
    const destinationLogIdentity = page.contentType === 'markdown' ? destinationFileName : `[${page.destinationLocaleCode}] ${page.destinationPath}`
    wiki.logger.info(`(STORAGE/GIT) Committing file move from ${sourceLogIdentity} to ${destinationLogIdentity}...`)

    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    const destinationDirectory = path.posix.dirname(destinationFileName)
    if (destinationDirectory !== '.') await root.ensureDirectory(destinationDirectory)
    await root.move(sourceFileName, destinationFileName)

    await command.run(['add', '-A', '--', ...((await isGitTracked(command, sourceFileName)) ? [sourceFileName] : []), destinationFileName])
    const commitSource = page.contentType === 'markdown' ? sourceFileName : page.path
    const commitDestination = page.contentType === 'markdown' ? destinationFileName : page.destinationPath
    await commitGitPaths(
      command,
      `docs: rename ${commitSource} to ${commitDestination}`,
      [sourceFileName, destinationFileName],
      `${page.moveAuthorName} <${page.moveAuthorEmail}>`
    )
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded(asset) {
    assertStorageAssetDestinationAllowed(asset.path)
    const root = requireRoot(this)
    const command = mutationGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing new file ${asset.path}...`)
    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    await root.writeAtomic(asset.path, asset.data)

    await command.run(['add', '--', `./${asset.path}`])
    await commitGitPaths(command, `docs: upload ${asset.path}`, [asset.path], `${asset.authorName} <${asset.authorEmail}>`)
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to upload
   */
  async assetDeleted(asset) {
    // A legacy asset row must never authorize deletion of Git's own metadata.
    if (isStorageGitMetadataPath(asset.path)) return
    const root = requireRoot(this)
    const command = mutationGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing removed file ${asset.path}...`)

    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    await root.removeFile(asset.path)
    if (await isGitTracked(command, asset.path)) await command.run(['add', '-u', '--', `./${asset.path}`])
    await commitGitPaths(command, `docs: delete ${asset.path}`, [asset.path], `${asset.authorName} <${asset.authorEmail}>`)
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to upload
   */
  async assetRenamed(asset) {
    assertGitPath(asset.path)
    assertStorageAssetDestinationAllowed(asset.destinationPath)
    const root = requireRoot(this)
    const command = mutationGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing file move from ${asset.path} to ${asset.destinationPath}...`)

    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    const destinationDirectory = path.posix.dirname(asset.destinationPath)
    if (destinationDirectory !== '.') await root.ensureDirectory(destinationDirectory)
    await root.move(asset.path, asset.destinationPath)
    await command.run(['add', '-A', '--', ...((await isGitTracked(command, asset.path)) ? [asset.path] : []), asset.destinationPath])
    await commitGitPaths(
      command,
      `docs: rename ${asset.path} to ${asset.destinationPath}`,
      [asset.path, asset.destinationPath],
      `${asset.moveAuthorName} <${asset.moveAuthorEmail}>`
    )
  },
  async assetRelocated(asset: StorageAssetRelocation) {
    assertStorageAssetDestinationAllowed(asset.destinationPath)
    const root = requireRoot(this)
    await collectStorageEntries(root)
    const command = mutationGit(this)
    const digest = createHash('sha256').update(asset.data).digest('hex')
    if (digest !== asset.contentSha256) throw new Error('Canonical asset bytes failed relocation validation')
    await currentGitMutationTurn().assertHeld()

    const destinationDirectory = path.posix.dirname(asset.destinationPath)
    if (destinationDirectory !== '.') await root.ensureDirectory(destinationDirectory)
    if (!(await destinationHasCanonicalBytes(root, asset.destinationPath, asset.data, asset.contentSha256))) {
      await root.writeAtomicIfAbsent(asset.destinationPath, asset.data)
      if (!(await destinationHasCanonicalBytes(root, asset.destinationPath, asset.data, asset.contentSha256))) {
        throw new Error('Storage destination was not retained after relocation write')
      }
    }

    let source: StorageFileHandle | undefined
    if (asset.sourcePath !== asset.destinationPath && !isStorageGitMetadataPath(asset.sourcePath)) {
      try {
        source = await root.openFile(asset.sourcePath, asset.sourceIdentity)
      } catch (error: unknown) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    if (source !== undefined) {
      try {
        const sourceBytes = await source.readBounded(asset.data.byteLength + 1)
        if (sourceBytes.byteLength !== asset.data.byteLength || createHash('sha256').update(sourceBytes).digest('hex') !== asset.contentSha256) {
          throw new Error('Former storage location changed before relocation cleanup')
        }
        await currentGitMutationTurn().assertHeld()
        await root.removeFile(asset.sourcePath, source.identity)
      } finally {
        await source.close()
      }
    }
    const sourceTracked = asset.sourcePath !== asset.destinationPath && !isStorageGitMetadataPath(asset.sourcePath) && (await isGitTracked(command, asset.sourcePath))
    const changedPaths = sourceTracked ? [asset.sourcePath, asset.destinationPath] : [asset.destinationPath]
    await command.run([
      'add',
      '-A',
      '--',
      ...(sourceTracked ? [asset.sourcePath] : []),
      asset.destinationPath
    ])
    await commitGitPaths(command, `docs: relocate ${asset.sourcePath} to ${asset.destinationPath}`, changedPaths, `${asset.authorName} <${asset.authorEmail}>`)
  },
  async getLocalLocation(asset: StorageAssetIdentity): Promise<StorageLocalLocation | void> {
    if (isStorageInternalPath(asset.path) || isStorageReservedPath(asset.path)) return
    const root = requireRoot(this)
    return {
      open: async () => root.openFile(asset.path)
    }
  },
  /**
   * HANDLERS
   */
  async importAll() {
    const root = requireRoot(this)
    wiki.logger.info('(STORAGE/GIT) Importing all content from local Git repo to the DB...')
    const admission = await collectGitContentEntries(root, wiki.config.uploads.maxFileSize)
    await inspectGitPreviousContent(admission, this.config, mutationGit(this))
    const files: GitStorageFile[] = admission.files.map(item => ({
      file: { stats: item.file.stats }, oldPath: item.file.relPath, relPath: item.file.relPath,
      binary: !item.contentType, status: 'A', insertions: 1, deletions: 0, before: 0, after: 1, importAll: true
    }))
    const results = await this.processFiles({ admission, files }, await wiki.models.users.getRootUser())
    if (results.every(result => result.ok)) {
      await guardStorageImportReview()
      await mutationGit(this).run(['update-ref', '-d', `refs/wiki/pending-import/${this.config.branch}`])
    }
    wiki.logger.info('(STORAGE/GIT) Import completed.')
    return results
  },
  async syncUntracked() {
    const root = requireRoot(this)
    const command = mutationGit(this)
    await assertGitWorktreeSettled(command)
    wiki.logger.info('(STORAGE/GIT) Adding all untracked content...')
    await collectStorageEntries(root)

    // Refuse legacy invalid destinations before staging any unrelated pages.
    const assetFolders = await wiki.models.assetFolders.getAllPaths()
    const destinations = wiki.models.knex.column('filename', 'folderId').select().from('assets').stream()
    for await (const asset of destinations) {
      if (
        typeof asset !== 'object' || asset === null ||
        !('filename' in asset) || typeof asset.filename !== 'string' ||
        !('folderId' in asset) || (asset.folderId !== null && typeof asset.folderId !== 'number')
      ) throw new TypeError('Git asset export inventory yielded an invalid destination')
      const folderPath = asset.folderId === null ? undefined : assetFolders[asset.folderId]
      assertStorageAssetDestinationAllowed(folderPath ? `${folderPath}/${asset.filename}` : asset.filename)
    }

    // Consume streams in the admitted async context. Driver event callbacks do
    // not necessarily inherit the PostgreSQL mutation turn's AsyncLocalStorage.
    const pages = wiki.models.knex
      .column(
        'id', 'path', 'localeCode', 'title', 'description', 'contentType',
        'content', 'sourceRevision', 'authorId', 'extra', 'isPublished',
        'updatedAt', 'createdAt', 'editorKey'
      )
      .select()
      .from('pages')
      .where({ visibility: 'public' })
      .stream()
    for await (const page of pages) {
      if (!isPageExportRow(page)) throw new TypeError('Git page export stream yielded an invalid page')
      const pageObject = await wiki.models.pages.query().findOne({ id: page.id })
      if (!pageObject) throw new Error(`Page ${page.id} was not found during Git export`)
      const relatedTags = await pageObject.$relatedQuery('tags')
      page.tags = relatedTags.flatMap(tag => (typeof tag.tag === 'string' ? [{ tag: tag.tag }] : []))
      const fileName = gitPagePath(page, this.config.alwaysNamespace)
      wiki.logger.info(`(STORAGE/GIT) Adding page ${fileName}...`)
      await currentGitMutationTurn().assertHeld()
      await root.writeAtomic(fileName, serializePage(page))
      await command.run(['add', '--', `./${fileName}`])
    }

    const assets = wiki.models.knex.column('filename', 'folderId', 'data').select().from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream()
    for await (const asset of assets) {
      if (!isAssetExportRow(asset)) throw new TypeError('Git asset export stream yielded an invalid asset')
      const folderPath = asset.folderId === null ? undefined : assetFolders[asset.folderId]
      const filename = folderPath ? `${folderPath}/${asset.filename}` : asset.filename
      assertStorageAssetDestinationAllowed(filename)
      wiki.logger.info(`(STORAGE/GIT) Adding asset ${filename}...`)
      await currentGitMutationTurn().assertHeld()
      await root.writeAtomic(filename, asset.data)
      await command.run(['add', '--', `./${filename}`])
    }

    await commitGitPaths(command, 'docs: add all untracked content', [])
    wiki.logger.info('(STORAGE/GIT) All content is now tracked.')
  },
  async purge() {
    const root = this.root !== null && this.root !== undefined && !this.root.closed ? this.root : await openStorageRoot(this.repoPath)
    this.root = root
    const command = nativeGit(this, currentGitMutationTurn().deadlineAt)
    await assertGitWorktreeSettled(command)
    if (await resolveCommit(command, `refs/wiki/pending-import/${this.config.branch}`, true)) {
      throw new Error('Pending Git imports must be recovered before purging the working copy')
    }
    const remoteCommit = await resolveCommit(command, `refs/remotes/origin/${this.config.branch}`)
    if (remoteCommit === null || (await runNativeText(command, ['rev-list', '--max-count=1', `${remoteCommit}..HEAD`])).length > 0) {
      throw new Error('Git working copy contains unpublished commits; pending mutations must be synchronized before purge')
    }
    await currentGitMutationTurn().assertHeld()
    wiki.logger.info('(STORAGE/GIT) Purging local repository...')
    await root.purgeContents()
    await root.close()
    this.root = null
    this.git = null
    this.quarantined = false
    wiki.logger.info('(STORAGE/GIT) Local repository is now empty. Reinitializing...')
    await initializeGit.call(this)
  }
}

// Only these awaited internal transitions share an already-admitted turn.
// Every public invocation acquires its own session and cannot inherit admission.
const initializeGit = plugin.init
const updateGitPage = plugin.updated!
const uploadGitAsset = plugin.assetUploaded!
const removeGitPath = plugin.assetDeleted!

plugin.withMutationTurn = async function (work, signal) {
  return withGitMutationLock(
    wiki.models.knex,
    this.targetKey ?? 'git',
    async turn => {
      try {
        await turn.assertHeld()
        await work({
          writePage: (page, onWritten) => updateGitPage.call(this, page, onWritten),
          writeAsset: asset => uploadGitAsset.call(this, asset),
          removePath: asset => removeGitPath.call(this, asset)
        })
      } catch (error) {
        if (shouldQuarantineGitFailure(error)) await quarantineGitContext(this)
        throw error
      }
    },
    signal
  )
}
const synchronizeGit = plugin.sync!

plugin.init = serializeGitMutation(plugin.init)
plugin.sync = serializeGitMutation(plugin.sync!)
plugin.created = serializeGitMutation(plugin.created!)
plugin.updated = serializeGitMutation(plugin.updated!)
plugin.deleted = serializeGitMutation(plugin.deleted!)
plugin.renamed = serializeGitMutation(plugin.renamed!)
plugin.assetUploaded = serializeGitMutation(plugin.assetUploaded!)
plugin.assetDeleted = serializeGitMutation(plugin.assetDeleted!)
plugin.assetRenamed = serializeGitMutation(plugin.assetRenamed!)
plugin.assetRelocated = serializeGitMutation(plugin.assetRelocated!)
plugin.importAll = serializeGitMutation(plugin.importAll!)
plugin.syncUntracked = serializeGitMutation(plugin.syncUntracked)
plugin.purge = serializeGitMutation(plugin.purge)

export default plugin

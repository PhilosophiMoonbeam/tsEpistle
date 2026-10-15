import type {
  QueryBuilder,
  UnknownRecord,
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
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

import pageHelper from '../../../helpers/page.ts'
import assetHelper from '../../../helpers/asset.ts'
import commonDisk, { assertStorageImportIdentities, collectStorageEntries, isImportSourceMissing, validateStoragePaths } from '../disk/common.ts'
import type { StorageImportAdmission } from '../disk/common.ts'
import type { StorageImportResult } from '../types.ts'
import { classifyStoragePageImport, encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
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
import { OKF_MAX_DOCUMENT_BYTES, parseOkfFilePath } from '../../../okf/format.ts'
import { gitStorageSshCommand, gitStorageHttpRemote, writeGitStorageConnectionFile } from './connection.ts'
import { openStorageRoot, type StorageFileIdentityExpectation, type StorageFileHandle, type StorageRootHandle } from '../local-filesystem.ts'
import type { StorageLocalLocation } from '../../types.ts'
import { currentGitMutationTurn, GitStorageBusyError, withGitMutationLock } from './mutation-lock.ts'
import type { StorageMutationDispatch } from '../../../jobs/storage-mutations.ts'
import { storagePagePath } from '../../../helpers/storage-page-path.ts'
import { assertNoPublicStoragePageAtPath } from '../../../helpers/storage-path-admission.ts'

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
  updated(this: GitStorageContext, page: Parameters<StorageMutationDispatch['writePage']>[0]): Promise<void>
  assetUploaded(this: GitStorageContext, asset: Omit<Parameters<StorageMutationDispatch['writeAsset']>[0], 'authorId'>): Promise<void>
  assetDeleted(this: GitStorageContext, asset: Omit<Parameters<StorageMutationDispatch['removePath']>[0], 'authorId'>): Promise<void>
}

interface CacheableWikiAsset extends WikiAsset {
  deleteAssetCache(): Promise<void>
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

function changedPagePath(filePath: string): { locale: string; path: string } {
  const canonicalIdentity = parseOkfFilePath(filePath)
  return canonicalIdentity === null ? pageHelper.getPagePath(filePath) : { locale: canonicalIdentity.locale, path: canonicalIdentity.pagePath }
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
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('\0') ||
    Array.from(branch).some(character => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
  ) {
    throw new Error('Invalid branch! Make sure it exists on the remote first.')
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

function hasAssetCache(asset: WikiAsset): asset is CacheableWikiAsset {
  return 'deleteAssetCache' in asset && typeof asset.deleteAssetCache === 'function'
}

function requireAssetCache(asset: WikiAsset): CacheableWikiAsset {
  if (!hasAssetCache(asset)) {
    throw new Error('Asset model does not implement deleteAssetCache')
  }
  return asset
}

type GitAssetTransaction = Knex.Transaction | undefined

async function withGitAssetTransaction<T>(work: (transaction: GitAssetTransaction) => Promise<T>): Promise<T> {
  const knex = wiki.models.knex as unknown as
    | {
        transaction?: (callback: (transaction: Knex.Transaction) => Promise<T>) => Promise<T>
      }
    | undefined
  if (typeof knex?.transaction === 'function') return knex.transaction(transaction => work(transaction))
  return work(undefined)
}

type GitAssetQuery = QueryBuilder<WikiAsset>

function queryGitAssets(transaction: GitAssetTransaction): GitAssetQuery {
  if (transaction === undefined) return (wiki.models.assets.query as unknown as () => GitAssetQuery)()
  return (wiki.models.assets.query as unknown as (transaction: Knex.Transaction) => GitAssetQuery)(transaction)
}

async function findGitAssetForMutation(transaction: GitAssetTransaction, hash: string): Promise<WikiAsset | undefined> {
  if (transaction === undefined) return queryGitAssets(transaction).findOne({ hash })
  const row = await transaction('assets').where({ hash }).forUpdate().first('id')
  if (!row) return undefined
  return queryGitAssets(transaction).findOne({ id: row.id })
}

const previousPageSources = new WeakMap<GitStorageFile, Buffer>()

function importedGitPageIdentity(
  context: GitStorageContext,
  relativePath: string,
  contentType: string,
  rawDocument?: Buffer
): { locale: string; path: string } {
  if (rawDocument === undefined) {
    if (context.config?.mapReadmeToHome === true && /^readme$/iu.test(pageHelper.getPagePath(relativePath).path)) {
      throw new Error('The previous README source must be classified before changing its imported page')
    }
    return changedPagePath(relativePath)
  }
  const original = pageHelper.getPagePath(relativePath)
  const imported = classifyStoragePageImport(
    {
      rawDocument,
      contentType,
      locale: original.locale,
      pagePath: original.path,
      importer: 'import:git'
    },
    relativePath,
    context.config ?? {}
  )
  if (imported.document.format === 'okf_invalid') throw new Error('Invalid OKF source cannot rename or delete a page')
  if (imported.document.format === 'okf_valid' && parseOkfFilePath(relativePath) === null) {
    throw new Error('OKF page path is not canonical')
  }
  return imported.identity
}

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
    const binary = pageHelper.getContentType(change.path) === undefined
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
    if (!binary && (isDelete || isRename)) {
      const previous = await command.run(['show', `${previousCommit}:${change.oldPath}`], { maxStdoutBytes: OKF_MAX_DOCUMENT_BYTES })
      previousPageSources.set(planned, previous.stdout)
    }
    files.push(planned)
  }
  await validateStoragePaths(root, paths, admission)
  return { admission, files }
}

function serializeGitMutation<Args extends unknown[], Result>(
  method: (this: GitStorageContext, ...args: Args) => Promise<Result>
): (this: GitStorageContext, ...args: Args) => Promise<Result> {
  return async function (...args) {
    return withGitMutationLock(wiki.models.knex as unknown as Knex, this.targetKey ?? 'git', async turn => {
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
  const db = wiki.models.knex as unknown as Knex
  const row = await db('durableJobs')
    .where(identity => identity.where({ type: 'storage-mutation', version: 1 }).orWhere({ type: 'asset-relocation', version: 1 }))
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
          await command.run(['remote', 'add', 'origin', this.config.repoUrl])
          break
        }
        default: {
          wiki.logger.info('(STORAGE/GIT) Adding origin remote via HTTP/S...')
          const originUrl = gitStorageHttpRemote(this.config.repoUrl, this.config.basicUsername, this.config.basicPassword)
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
          admission = await collectStorageEntries(root, { maxAssetBytes: wiki.config.uploads.maxFileSize })
        } catch (error: unknown) {
          throw new BoundedProcessError('parser', `Git worktree admission failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        const changes = await streamGitNameStatus(command, importBase, finalCommit)
        plan = await buildGitImportPlan(root, admission, changes, command, importBase)
      }

      if (_.includes(['sync', 'push'], this.mode)) {
        wiki.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${branch}...`)
        const pushOptions = ['push', '--signed=if-asked']
        // Never force-push over unseen remote history.
        pushOptions.push('origin', branch)
        await command.run(pushOptions, { captureStdout: false })
      }

      if (recovered) wiki.logger.warn(`(STORAGE/GIT) Recovered an unfinished ${recovered} before synchronization.`)
      if (conflicted.length > 0) {
        wiki.logger.warn(`(STORAGE/GIT) ${conflicted.length} conflicting path(s) used the remote version; prior page revisions remain in page history.`)
      }
      if (plan !== undefined) {
        const rootUser = await wiki.models.users.getRootUser()
        const results = await this.processFiles(plan, rootUser)
        if (results.every(result => result.ok)) await command.run(['update-ref', '-d', importRef])
        return results
      }
      if (_.includes(['sync', 'pull'], this.mode)) await command.run(['update-ref', '-d', importRef])
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
    const files = plan.files
    const admission = plan.admission
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
    await assertStorageImportIdentities(admission, this.config ?? {}, 'GIT')

    const results: GitStorageImportResult[] = []
    for (const item of files) {
      const status = item.status ?? (item.relPath !== item.oldPath ? 'R' : item.deletions > 0 && item.insertions === 0 ? 'D' : 'M')
      const entry = admission.filesByPath.get(item.relPath)
      const expectedStats = entry !== undefined && entry.kind === 'file' ? entry.identity : undefined
      if (!item.importAll && status !== 'D' && expectedStats === undefined) {
        throw new BoundedProcessError('parser', `Git import plan has no admitted destination: ${item.relPath}`)
      }
      let source: StorageFileHandle | undefined
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
            wiki.logger.info(`(STORAGE/GIT) Page marked as renamed: from ${item.oldPath} to ${item.relPath}`)
            const contentPath = importedGitPageIdentity(
              this,
              item.oldPath,
              pageHelper.getContentType(item.oldPath) || contentType,
              previousPageSources.get(item)
            )
            if (source === undefined) throw new Error('Git page source is unavailable')
            const contentDestinationPath = importedGitPageIdentity(this, item.relPath, contentType, await source.readBounded(OKF_MAX_DOCUMENT_BYTES))
            if (contentPath.path === contentDestinationPath.path && contentPath.locale === contentDestinationPath.locale) {
              const pageResult = await commonDisk.processPage({
                user,
                relPath: item.relPath,
                root,
                contentType,
                moduleName: 'GIT',
                source,
                ingestion: this.config ?? {}
              })
              results.push({ kind: 'page', ...pageResult })
              continue
            }
            await wiki.models.pages.movePage({
              user,
              path: contentPath.path,
              destinationPath: contentDestinationPath.path,
              locale: contentPath.locale,
              destinationLocale: contentDestinationPath.locale,
              okfProducer: 'import:git',
              skipStorage: true
            })
            results.push({ kind: 'page', relPath: item.relPath, ok: true })
            continue
          }
          if (!fileExists && !item.importAll && status === 'D') {
            wiki.logger.info(`(STORAGE/GIT) Page marked as deleted: ${item.relPath}`)
            const contentPath = importedGitPageIdentity(this, item.relPath, contentType, previousPageSources.get(item))
            await wiki.models.pages.deletePage({
              user,
              path: contentPath.path,
              locale: contentPath.locale,
              skipStorage: true
            })
            results.push({ kind: 'page', relPath: item.relPath, ok: true })
            continue
          }
          if (!source) throw new Error(`Import source does not exist: ${item.relPath}`)
          const pageResult = await commonDisk.processPage({
            user,
            relPath: item.relPath,
            root,
            contentType,
            moduleName: 'GIT',
            source,
            ingestion: this.config ?? {}
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          if (fileExists && !item.importAll && status === 'R') {
            await withAssetLocationLocks(
              ['assets'],
              async assertHeld => {
                await assertHeld?.()
                wiki.logger.info(`(STORAGE/GIT) Asset marked as renamed: from ${item.oldPath} to ${item.relPath}`)
                const sourceHash = assetHelper.generateHash(item.oldPath)
                const destinationHash = assetHelper.generateHash(item.relPath)
                const assetToRename = await withGitAssetTransaction(async transaction => {
                  const asset = await findGitAssetForMutation(transaction, sourceHash)
                  if (!asset) return undefined
                  if (transaction) {
                    await assertNoPublicStoragePageAtPath(transaction, item.relPath)
                    for (const assetPath of [item.oldPath, item.relPath].sort()) await lockAssetLocation(transaction, assetPath)
                  }
                  await assertAssetLocationAssetSettled(transaction as Knex.Transaction, asset.id)
                  await assertAssetLocationReservations(transaction as Knex.Transaction, [item.oldPath, item.relPath])
                  const folderId = await commonDisk.resolveAssetFolder(item.relPath)
                  const writableAssets = queryGitAssets(transaction)
                  await writableAssets
                    .patch({
                      filename: path.posix.basename(item.relPath.replace(/\\/g, '/')),
                      folderId,
                      hash: destinationHash
                    })
                    .findById(asset.id)
                  return asset
                })
                if (assetToRename) {
                  await assertHeld?.()
                  await requireAssetCache(assetToRename).deleteAssetCache()
                  await assertHeld?.()
                  results.push({ kind: 'asset', relPath: item.relPath, ok: true })
                } else {
                  wiki.logger.info(`(STORAGE/GIT) Asset was not found in the DB, nothing to rename: ${item.relPath}`)
                  results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict', error: 'Asset was not found in the database' })
                }
              },
              wiki.models.knex as unknown as Knex
            )
            continue
          }
          if (!fileExists && !item.importAll && status === 'D') {
            await withAssetLocationLocks(
              ['assets'],
              async assertHeld => {
                await assertHeld?.()
                wiki.logger.info(`(STORAGE/GIT) Asset marked as deleted: ${item.relPath}`)
                const fileHash = assetHelper.generateHash(item.relPath)
                const assetToDelete = await withGitAssetTransaction(async transaction => {
                  const asset = await findGitAssetForMutation(transaction, fileHash)
                  if (!asset) return undefined
                  if (transaction) await lockAssetLocation(transaction, item.relPath)
                  await assertAssetLocationAssetSettled(transaction as Knex.Transaction, asset.id)
                  await assertAssetLocationReservations(transaction as Knex.Transaction, [item.relPath])
                  const assetData = (transaction === undefined
                    ? wiki.models.knex('assetData')
                    : transaction('assetData')) as unknown as QueryBuilder<UnknownRecord>
                  await assetData.where('id', asset.id).delete()
                  const writableAssets = queryGitAssets(transaction)
                  await writableAssets.delete().where('id', asset.id)
                  return asset
                })
                if (assetToDelete) {
                  await assertHeld?.()
                  await requireAssetCache(assetToDelete).deleteAssetCache()
                  await assertHeld?.()
                  results.push({ kind: 'asset', relPath: item.relPath, ok: true })
                } else {
                  wiki.logger.info(`(STORAGE/GIT) Asset was not found in the DB, nothing to delete: ${item.relPath}`)
                  results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict', error: 'Asset was not found in the database' })
                }
              },
              wiki.models.knex as unknown as Knex
            )
            continue
          }
          if (!source) throw new Error(`Import source does not exist: ${item.relPath}`)
          const assetSource = source
          await commonDisk.processAsset({
            user,
            relPath: item.relPath,
            root,
            file: { relPath: item.relPath, stats: expectedStats ?? { size: 0 } },
            moduleName: 'GIT',
            source: assetSource
          })
          results.push({ kind: 'asset', relPath: item.relPath, ok: true })
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
        wiki.logger.warn(message)
        results.push({
          kind: !item.binary && pageHelper.getContentType(item.relPath) ? 'page' : 'asset',
          relPath: item.relPath,
          ok: false,
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
  async updated(page) {
    const root = requireRoot(this)
    const command = mutationGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing updated file ${logIdentity}...`)
    await collectStorageEntries(root)
    await currentGitMutationTurn().assertHeld()
    await root.writeAtomic(fileName, serializePage(page))

    const gitFilePath = `./${fileName}`
    if (!(await isGitIgnored(command, gitFilePath))) {
      await command.run(['add', '--', gitFilePath])
      await commitGitPaths(
        command,
        `docs: update ${page.contentType === 'markdown' ? fileName : page.path}`,
        [fileName],
        `${page.authorName} <${page.authorEmail}>`
      )
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
    if (asset.sourcePath !== asset.destinationPath) {
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
    const changedPaths = asset.sourcePath === asset.destinationPath ? [asset.destinationPath] : [asset.sourcePath, asset.destinationPath]
    await command.run([
      'add',
      '-A',
      '--',
      ...(asset.sourcePath !== asset.destinationPath && (await isGitTracked(command, asset.sourcePath)) ? [asset.sourcePath] : []),
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
    const admission = await collectStorageEntries(root, { maxAssetBytes: wiki.config.uploads.maxFileSize })
    const results = await commonDisk.importFromDisk({
      root,
      moduleName: 'GIT',
      maxAssetBytes: wiki.config.uploads.maxFileSize,
      admission,
      ingestion: this.config
    })
    wiki.logger.info('(STORAGE/GIT) Import completed.')
    return results
  },
  async syncUntracked() {
    const root = requireRoot(this)
    const command = mutationGit(this)
    await assertGitWorktreeSettled(command)
    wiki.logger.info('(STORAGE/GIT) Adding all untracked content...')
    await collectStorageEntries(root)

    await pipeline(
      wiki.models.knex
        .column(
          'id',
          'path',
          'localeCode',
          'title',
          'description',
          'contentType',
          'content',
          'sourceRevision',
          'authorId',
          'extra',
          'isPublished',
          'updatedAt',
          'createdAt',
          'editorKey'
        )
        .select()
        .from('pages')
        .where({ visibility: 'public' })
        .stream(),
      new Transform({
        objectMode: true,
        transform: async (page: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
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
        transform: async (asset: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isAssetExportRow(asset)) throw new TypeError('Git asset export stream yielded an invalid asset')
            const folderPath = asset.folderId === null ? undefined : assetFolders[asset.folderId]
            const filename = folderPath ? `${folderPath}/${asset.filename}` : asset.filename
            wiki.logger.info(`(STORAGE/GIT) Adding asset ${filename}...`)
            await currentGitMutationTurn().assertHeld()
            await root.writeAtomic(filename, asset.data)
            await command.run(['add', '--', `./${filename}`])
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

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
    wiki.models.knex as unknown as Knex,
    this.targetKey ?? 'git',
    async turn => {
      try {
        await turn.assertHeld()
        await work({
          writePage: page => updateGitPage.call(this, page),
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

import type { StorageAssetIdentity, StorageConfig, StorageContext, StoragePlugin, StoragePluginActionResult, WikiAsset, WikiUser } from '../../types.ts'
import { wiki } from '../../types.ts'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { simpleGit, type SimpleGit } from 'simple-git'
import _ from 'lodash'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

import pageHelper from '../../../helpers/page.ts'
import assetHelper from '../../../helpers/asset.ts'
import commonDisk, {
  collectStorageEntries,
  isImportSourceMissing,
  validateStoragePaths
} from '../disk/common.ts'
import type { StorageImportAdmission } from '../disk/common.ts'
import type { StorageImportResult } from '../types.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
import { pullRemoteAuthoritative, reattachUnrelatedHistory, recoverInterruptedGitOperation, sharesHistoryWith, type GitRepositoryCommand } from './repository.ts'
import {
  admitGitTree,
  assertGitPath,
  streamGitNameStatus,
  type GitChangeStatus,
  type GitNameStatusChange,
  type GitNativeCommand
} from './admission.ts'
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
import { okfFilePath, parseOkfFilePath } from '../../../okf/format.ts'
import { gitStorageSshCommand, gitStorageHttpRemote, writeGitStorageConnectionFile } from './connection.ts'
import {
  openStorageRoot,
  type StorageFileIdentityExpectation,
  type StorageFileHandle,
  type StorageRootHandle
} from '../local-filesystem.ts'
import type { StorageLocalLocation } from '../../types.ts'

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
  git: SimpleGit | null
  repoPath: string
  root: StorageRootHandle | null
  quarantined?: boolean
  init(): Promise<void>
  sync(options?: { manual: boolean }): Promise<StoragePluginActionResult>
  processFiles(plan: GitStorageImportPlan, user: WikiUser): Promise<GitStorageImportResult[]>
}

interface GitStoragePlugin extends StoragePlugin<StorageConfig, GitStorageContext> {
  git: SimpleGit | null
  repoPath: string
  root: StorageRootHandle | null
  quarantined?: boolean
  processFiles(this: GitStorageContext, plan: GitStorageImportPlan, user: WikiUser): Promise<GitStorageImportResult[]>
  syncUntracked(this: GitStorageContext): Promise<void>
  purge(this: GitStorageContext): Promise<void>
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
  if (page.contentType === 'markdown') return okfFilePath(page.localeCode, page.path)
  const fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
  return alwaysNamespace || (wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode)
    ? `${page.localeCode}/${fileName}`
    : fileName
}

function changedPagePath(filePath: string): { locale: string; path: string } {
  const canonicalIdentity = parseOkfFilePath(filePath)
  return canonicalIdentity === null
    ? pageHelper.getPagePath(filePath)
    : { locale: canonicalIdentity.locale, path: canonicalIdentity.pagePath }
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
function requireRoot (context: GitStorageContext): StorageRootHandle {
  if (context.quarantined || context.root === null || context.root === undefined || context.root.closed) throw new Error('Git storage is not initialized')
  return context.root
}

function requireGit (context: GitStorageContext): SimpleGit {
  if (context.quarantined || context.git === null || context.git === undefined) throw new Error('Git storage is not initialized')
  return context.git
}

function gitExecutable (context: GitStorageContext): string {
  const configured = context.config.gitBinaryPath
  return typeof configured === 'string' && configured.trim().length > 0 ? configured : 'git'
}

function assertBranch (branch: string): void {
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

async function observeGitStorage (context: GitStorageContext, deadlineAt: number): Promise<void> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new BoundedProcessError('deadline', 'Git synchronization exceeded its deadline')
  await observeDirectoryTree(path.join(context.repoPath, '.git'), {
    maxEntries: GIT_NATIVE_METADATA_ENTRY_LIMIT,
    maxBytes: GIT_NATIVE_METADATA_LIMIT_BYTES,
    deadlineAt
  })
  await observeDirectoryTree(context.repoPath, {
    maxEntries: GIT_NATIVE_WORKTREE_ENTRY_LIMIT,
    maxBytes: GIT_NATIVE_WORKTREE_LIMIT_BYTES,
    deadlineAt,
    shouldSkip: isStorageGitMetadataPath
  })
}

function nativeGit (context: GitStorageContext, deadlineAt: number): GitNativeCommand {
  return {
    async run (args, options = {}) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw new BoundedProcessError('deadline', 'Git synchronization exceeded its deadline')
      const result = await runBoundedProcess({
        command: gitExecutable(context),
        args,
        cwd: context.repoPath,
        env: { GIT_TERMINAL_PROMPT: '0' },
        deadlineMs: remaining,
        maxStdoutBytes: options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES,
        maxStderrBytes: GIT_NATIVE_STDERR_LIMIT_BYTES,
        captureStdout: options.captureStdout ?? true,
        ...(options.onStdoutChunk === undefined ? {} : { onStdoutChunk: options.onStdoutChunk }),
        monitor: async () => {
          await observeGitStorage(context, deadlineAt)
          if (options.monitor) await options.monitor()
        },
        monitorIntervalMs: GIT_NATIVE_MONITOR_INTERVAL_MS
      })
      return result
    }
  }
}

function nativeRepository (command: GitNativeCommand): GitRepositoryCommand {
  return {
    async run (args) {
      const result = await command.run(args, { captureStdout: true, maxStdoutBytes: 8 * 1024 })
      return result.stdout.toString('utf8')
    }
  }
}

async function runNativeText (command: GitNativeCommand, args: readonly string[]): Promise<string> {
  const result = await command.run(args, { captureStdout: true, maxStdoutBytes: 8 * 1024 })
  return result.stdout.toString('utf8').trim()
}

async function resolveCommit (command: GitNativeCommand, revision: string, optional = false): Promise<string | null> {
  try {
    const value = await runNativeText(command, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new BoundedProcessError('parser', 'Git returned an invalid commit identifier')
    return value
  } catch (error: unknown) {
    if (optional && error instanceof BoundedProcessError && error.kind === 'exit') return null
    throw error
  }
}

async function fetchConfiguredBranch (command: GitNativeCommand, branch: string): Promise<string> {
  assertBranch(branch)
  await command.run([
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-auto-maintenance',
    '--no-progress',
    'origin',
    branch
  ], { captureStdout: false })
  const remoteRef = `refs/remotes/origin/${branch}`
  const fetched = await resolveCommit(command, remoteRef)
  if (fetched === null) throw new Error('Invalid branch! Make sure it exists on the remote first.')
  return fetched
}

async function quarantineGitContext (context: GitStorageContext): Promise<void> {
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

function shouldQuarantineGitFailure (error: unknown): boolean {
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
async function buildGitImportPlan (
  root: StorageRootHandle,
  admission: StorageImportAdmission,
  changes: readonly GitNameStatusChange[]
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
    files.push({
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
    })
  }
  await validateStoragePaths(root, paths, admission)
  return { admission, files }
}
 


const plugin: GitStoragePlugin = {
  git: null,
  root: null,
  repoPath: path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'repo'),
  async activated () {},
  async deactivated () {
    const root = this.root
    this.root = null
    this.git = null
    if (root) await root.close()
  },
  /**
   * INIT
   */
  async init () {
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
      this.git = simpleGit(this.repoPath, { maxConcurrentProcesses: 1 })

      // Set custom binary path
      if (!_.isEmpty(this.config.gitBinaryPath)) {
        this.git.customBinary(this.config.gitBinaryPath)
      }

      // Initialize repo (if needed)
      wiki.logger.info('(STORAGE/GIT) Checking repository state...')
      const isRepo = await this.git.checkIsRepo()
      if (!isRepo) {
        wiki.logger.info('(STORAGE/GIT) Initializing local repository...')
        await this.git.init()
      }

      // Disable quotePath, color output
      // Link https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath
      await this.git.raw(['config', '--local', 'core.quotepath', 'false'])
      await this.git.raw(['config', '--local', 'color.ui', 'false'])

      // Set default author
      await this.git.raw(['config', '--local', 'user.email', this.config.defaultEmail])
      await this.git.raw(['config', '--local', 'user.name', this.config.defaultName])

      // Purge existing remotes
      wiki.logger.info('(STORAGE/GIT) Listing existing remotes...')
      const remotes = await this.git.getRemotes()
      if (remotes.length > 0) {
        wiki.logger.info('(STORAGE/GIT) Purging existing remotes...')
        for (const remote of remotes) await this.git.removeRemote(remote.name)
      }

      // Add remote
      wiki.logger.info('(STORAGE/GIT) Setting SSL Verification config...')
      await this.git.raw(['config', '--local', '--bool', 'http.sslVerify', _.toString(this.config.verifySSL)])
      switch (this.config.authType) {
        case 'ssh': {
          wiki.logger.info('(STORAGE/GIT) Setting SSH Command config...')
          const dataPath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath)
          const identityPath = this.config.sshPrivateKeyMode === 'contents'
            ? await writeGitStorageConnectionFile(dataPath, 'git-ssh.pem', this.config.sshPrivateKeyContent)
            : this.config.sshPrivateKeyPath
          const knownHostsPath = typeof this.config.sshKnownHosts === 'string' && this.config.sshKnownHosts.trim()
            ? await writeGitStorageConnectionFile(dataPath, 'git-known-hosts', this.config.sshKnownHosts)
            : undefined
          await this.git.addConfig('core.sshCommand', gitStorageSshCommand(identityPath, knownHostsPath))
          wiki.logger.info('(STORAGE/GIT) Adding origin remote via SSH...')
          await this.git.addRemote('origin', this.config.repoUrl)
          break
        }
        default: {
          wiki.logger.info('(STORAGE/GIT) Adding origin remote via HTTP/S...')
          const originUrl = gitStorageHttpRemote(this.config.repoUrl, this.config.basicUsername, this.config.basicPassword)
          await this.git.addRemote('origin', originUrl)
          break
        }
      }

      // sync performs the one configured-branch fetch and pinned reconciliation.
      await this.sync()
      wiki.logger.info('(STORAGE/GIT) Initialization completed.')
    } catch (error: unknown) {
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
  async sync () {
    const root = requireRoot(this)
    requireGit(this)
    const branch = this.config.branch
    assertBranch(branch)
    const deadlineAt = Date.now() + GIT_NATIVE_DEADLINE_MS
    const command = nativeGit(this, deadlineAt)
    const repository = nativeRepository(command)
    try {
      const recovered = await recoverInterruptedGitOperation(repository, wiki.logger)
      await observeGitStorage(this, deadlineAt)

      // Resolve and admit the current branch before any checkout or reconciliation.
      const currentCommit = await resolveCommit(command, branch, true)
      if (currentCommit !== null) {
        await admitGitTree(command, currentCommit, { maxAssetBytes: wiki.config.uploads.maxFileSize })
      }

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
      if (_.includes(['sync', 'pull'], this.mode) && currentCommit !== null && !reattached && currentCommit !== finalCommit) {
        let admission: StorageImportAdmission
        try {
          admission = await collectStorageEntries(root, { maxAssetBytes: wiki.config.uploads.maxFileSize })
        } catch (error: unknown) {
          throw new BoundedProcessError('parser', `Git worktree admission failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        const changes = await streamGitNameStatus(command, currentCommit, finalCommit)
        plan = await buildGitImportPlan(root, admission, changes)
      }

      if (_.includes(['sync', 'push'], this.mode)) {
        wiki.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${branch}...`)
        const pushOptions = ['push', '--signed=if-asked']
        if (this.mode === 'push') pushOptions.push('--force')
        pushOptions.push('origin', branch)
        await command.run(pushOptions, { captureStdout: false })
      }

      if (recovered) wiki.logger.warn(`(STORAGE/GIT) Recovered an unfinished ${recovered} before synchronization.`)
      if (conflicted.length > 0) {
        wiki.logger.warn(`(STORAGE/GIT) ${conflicted.length} conflicting path(s) used the remote version; prior page revisions remain in page history.`)
      }
      if (plan !== undefined) {
        const rootUser = await wiki.models.users.getRootUser()
        return await this.processFiles(plan, rootUser)
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
  async processFiles (plan: GitStorageImportPlan, user: WikiUser) {
    const root = requireRoot(this)
    if (plan.admission.root !== root) throw new Error('Git import admission belongs to a different storage root')
    const files = plan.files
    const admission = plan.admission
    const seen = new Set<string>()
    for (const item of files) {
      const status = item.status ?? (
        item.relPath !== item.oldPath
          ? 'R'
          : item.deletions > 0 && item.insertions === 0
            ? 'D'
            : 'M'
      )
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

    const results: GitStorageImportResult[] = []
    for (const item of files) {
      const status = item.status ?? (
        item.relPath !== item.oldPath
          ? 'R'
          : item.deletions > 0 && item.insertions === 0
            ? 'D'
            : 'M'
      )
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
            const contentPath = changedPagePath(item.oldPath)
            const contentDestinationPath = changedPagePath(item.relPath)
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
            const contentPath = changedPagePath(item.relPath)
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
            source
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          if (fileExists && !item.importAll && status === 'R') {
            wiki.logger.info(`(STORAGE/GIT) Asset marked as renamed: from ${item.oldPath} to ${item.relPath}`)
            const sourceHash = assetHelper.generateHash(item.oldPath)
            const destinationHash = assetHelper.generateHash(item.relPath)
            const assetToRename = await wiki.models.assets.query().findOne({ hash: sourceHash })
            if (assetToRename) {
              const folderId = await commonDisk.resolveAssetFolder(item.relPath)
              await wiki.models.assets.query().patch({
                filename: path.posix.basename(item.relPath.replace(/\\/g, '/')),
                folderId,
                hash: destinationHash
              }).findById(assetToRename.id)
              await requireAssetCache(assetToRename).deleteAssetCache()
              results.push({ kind: 'asset', relPath: item.relPath, ok: true })
            } else {
              wiki.logger.info(`(STORAGE/GIT) Asset was not found in the DB, nothing to rename: ${item.relPath}`)
              results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict', error: 'Asset was not found in the database' })
            }
            continue
          }
          if (!fileExists && !item.importAll && status === 'D') {
            wiki.logger.info(`(STORAGE/GIT) Asset marked as deleted: ${item.relPath}`)
            const fileHash = assetHelper.generateHash(item.relPath)
            const assetToDelete = await wiki.models.assets.query().findOne({ hash: fileHash })
            if (assetToDelete) {
              await wiki.models.knex('assetData').where('id', assetToDelete.id).delete()
              await wiki.models.assets.query().delete().where('id', assetToDelete.id)
              await requireAssetCache(assetToDelete).deleteAssetCache()
              results.push({ kind: 'asset', relPath: item.relPath, ok: true })
            } else {
              wiki.logger.info(`(STORAGE/GIT) Asset was not found in the DB, nothing to delete: ${item.relPath}`)
              results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict', error: 'Asset was not found in the database' })
            }
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
  async created (page) {
    const root = requireRoot(this)
    const git = requireGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing new file ${logIdentity}...`)
    await collectStorageEntries(root)
    await root.writeAtomic(fileName, serializePage(page))

    const gitFilePath = `./${fileName}`
    if ((await git.checkIgnore(gitFilePath)).length === 0) {
      await git.add(gitFilePath)
      await git.commit(`docs: create ${page.contentType === 'markdown' ? fileName : page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated (page) {
    const root = requireRoot(this)
    const git = requireGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing updated file ${logIdentity}...`)
    await collectStorageEntries(root)
    await root.writeAtomic(fileName, serializePage(page))

    const gitFilePath = `./${fileName}`
    if ((await git.checkIgnore(gitFilePath)).length === 0) {
      await git.add(gitFilePath)
      await git.commit(`docs: update ${page.contentType === 'markdown' ? fileName : page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted (page) {
    const root = requireRoot(this)
    const git = requireGit(this)
    const fileName = gitPagePath(page, this.config.alwaysNamespace)
    const logIdentity = page.contentType === 'markdown' ? fileName : `[${page.localeCode}] ${page.path}`
    wiki.logger.info(`(STORAGE/GIT) Committing removed file ${logIdentity}...`)

    const gitFilePath = `./${fileName}`
    if ((await git.checkIgnore(gitFilePath)).length === 0) {
      await collectStorageEntries(root)
      await root.removeFile(fileName)
      await git.raw(['add', '-u', '--', gitFilePath])
      await git.commit(`docs: delete ${page.contentType === 'markdown' ? fileName : page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed (page) {
    const root = requireRoot(this)
    const git = requireGit(this)
    const sourceFileName = gitPagePath(page, this.config.alwaysNamespace)
    const destinationFileName = gitPagePath({
      path: page.destinationPath,
      localeCode: page.destinationLocaleCode,
      contentType: page.contentType
    }, this.config.alwaysNamespace)
    const sourceLogIdentity = page.contentType === 'markdown' ? sourceFileName : `[${page.localeCode}] ${page.path}`
    const destinationLogIdentity = page.contentType === 'markdown' ? destinationFileName : `[${page.destinationLocaleCode}] ${page.destinationPath}`
    wiki.logger.info(`(STORAGE/GIT) Committing file move from ${sourceLogIdentity} to ${destinationLogIdentity}...`)

    await collectStorageEntries(root)
    const destinationDirectory = path.posix.dirname(destinationFileName)
    if (destinationDirectory !== '.') await root.ensureDirectory(destinationDirectory)
    await root.move(sourceFileName, destinationFileName)

    await git.raw(['add', '-A', '--', sourceFileName, destinationFileName])
    const commitSource = page.contentType === 'markdown' ? sourceFileName : page.path
    const commitDestination = page.contentType === 'markdown' ? destinationFileName : page.destinationPath
    await git.commit(`docs: rename ${commitSource} to ${commitDestination}`, [sourceFileName, destinationFileName], {
      '--author': `"${page.moveAuthorName} <${page.moveAuthorEmail}>"`
    })
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded (asset) {
    const root = requireRoot(this)
    const git = requireGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing new file ${asset.path}...`)
    await collectStorageEntries(root)
    await root.writeAtomic(asset.path, asset.data)

    await git.add(`./${asset.path}`)
    await git.commit(`docs: upload ${asset.path}`, asset.path, {
      '--author': `"${asset.authorName} <${asset.authorEmail}>"`
    })
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to upload
   */
  async assetDeleted (asset) {
    const root = requireRoot(this)
    const git = requireGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing removed file ${asset.path}...`)

    await collectStorageEntries(root)
    await root.removeFile(asset.path)
    await git.raw(['add', '-u', '--', `./${asset.path}`])
    await git.commit(`docs: delete ${asset.path}`, asset.path, {
      '--author': `"${asset.authorName} <${asset.authorEmail}>"`
    })
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to upload
   */
  async assetRenamed (asset) {
    const root = requireRoot(this)
    const git = requireGit(this)
    wiki.logger.info(`(STORAGE/GIT) Committing file move from ${asset.path} to ${asset.destinationPath}...`)

    await collectStorageEntries(root)
    const destinationDirectory = path.posix.dirname(asset.destinationPath)
    if (destinationDirectory !== '.') await root.ensureDirectory(destinationDirectory)
    await root.move(asset.path, asset.destinationPath)
    await git.raw(['add', '-A', '--', asset.path, asset.destinationPath])
    await git.commit(`docs: rename ${asset.path} to ${asset.destinationPath}`, [asset.path, asset.destinationPath], {
      '--author': `"${asset.moveAuthorName} <${asset.moveAuthorEmail}>"`
    })
  },
  async getLocalLocation (asset: StorageAssetIdentity): Promise<StorageLocalLocation | void> {
    if (isStorageInternalPath(asset.path) || isStorageReservedPath(asset.path)) return
    const root = requireRoot(this)
    return {
      open: async () => root.openFile(asset.path)
    }
  },
  /**
   * HANDLERS
   */
  async importAll () {
    const root = requireRoot(this)
    wiki.logger.info('(STORAGE/GIT) Importing all content from local Git repo to the DB...')
    const admission = await collectStorageEntries(root, { maxAssetBytes: wiki.config.uploads.maxFileSize })
    const results = await commonDisk.importFromDisk({
      root,
      moduleName: 'GIT',
      maxAssetBytes: wiki.config.uploads.maxFileSize,
      admission
    })
    wiki.logger.info('(STORAGE/GIT) Import completed.')
    return results
  },
  async syncUntracked () {
    const root = requireRoot(this)
    const git = requireGit(this)
    wiki.logger.info('(STORAGE/GIT) Adding all untracked content...')
    await collectStorageEntries(root)

    await pipeline(
      wiki.models.knex
        .column(
          'id', 'path', 'localeCode', 'title', 'description', 'contentType', 'content',
          'sourceRevision', 'authorId', 'extra', 'isPublished', 'updatedAt', 'createdAt', 'editorKey'
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
            await root.writeAtomic(fileName, serializePage(page))
            await git.add(`./${fileName}`)
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
            await root.writeAtomic(filename, asset.data)
            await git.add(`./${filename}`)
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

    await git.commit('docs: add all untracked content')
    wiki.logger.info('(STORAGE/GIT) All content is now tracked.')
  },
  async purge () {
    const root = this.root !== null && this.root !== undefined && !this.root.closed
      ? this.root
      : await openStorageRoot(this.repoPath)
    this.root = root
    wiki.logger.info('(STORAGE/GIT) Purging local repository...')
    await root.purgeContents()
    await root.close()
    this.root = null
    this.git = null
    this.quarantined = false
    wiki.logger.info('(STORAGE/GIT) Local repository is now empty. Reinitializing...')
    await this.init()
  }
}

export default plugin

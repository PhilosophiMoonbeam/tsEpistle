import type { StorageConfig, StorageContext, StoragePlugin, StoragePluginActionResult, WikiAsset, WikiUser } from '../../types.ts'
import { wiki } from '../../types.ts'
import path from 'node:path'
import { simpleGit, type SimpleGit, type DiffResultBinaryFile, type DiffResultTextFile } from 'simple-git'
import fs from 'fs-extra'
import _ from 'lodash'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import klaw, { type Item as KlawItem } from 'klaw'
import os from 'node:os'

import pageHelper from '../../../helpers/page.ts'
import assetHelper from '../../../helpers/asset.ts'
import commonDisk from '../disk/common.ts'
import type { StorageImportResult } from '../types.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
import { pullRemoteAuthoritative, reattachUnrelatedHistory, recoverInterruptedGitOperation, sharesHistoryWith } from './repository.ts'
interface GitStorageFile {
  file: { path: string; stats: { size: number } }
  oldPath: string
  relPath: string
  binary: boolean
  insertions: number
  deletions: number
  before: number
  after: number
  importAll: boolean
}
interface GitStorageImportResult extends StorageImportResult {
  outcome?: 'conflict'
}

interface GitStorageContext extends StorageContext<StorageConfig> {
  git: SimpleGit
  repoPath: string
  init(): Promise<void>
  sync(options?: { manual: boolean }): Promise<StoragePluginActionResult>
  processFiles(files: GitStorageFile[], user: WikiUser): Promise<GitStorageImportResult[]>
}

interface GitStoragePlugin extends StoragePlugin<StorageConfig, GitStorageContext> {
  git: SimpleGit | null
  repoPath: string
  processFiles(this: GitStorageContext, files: GitStorageFile[], user: WikiUser): Promise<GitStorageImportResult[]>
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

interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

function isKlawItem(value: unknown): value is KlawItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'stats' in value &&
    typeof value.stats === 'object' &&
    value.stats !== null &&
    'size' in value.stats &&
    typeof value.stats.size === 'number'
  )
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

function hasAssetCache(asset: WikiAsset): asset is CacheableWikiAsset {
  return 'deleteAssetCache' in asset && typeof asset.deleteAssetCache === 'function'
}

function requireAssetCache(asset: WikiAsset): CacheableWikiAsset {
  if (!hasAssetCache(asset)) {
    throw new Error('Asset model does not implement deleteAssetCache')
  }
  return asset
}

const plugin: GitStoragePlugin = {
  git: null,
  repoPath: path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'repo'),
  async activated() {
    // not used
  },
  async deactivated() {
    // not used
  },
  /**
   * INIT
   */
  async init() {
    wiki.logger.info('(STORAGE/GIT) Initializing...')
    this.repoPath = path.resolve(wiki.ROOTPATH, this.config.localRepoPath)
    await fs.ensureDir(this.repoPath)
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

    await recoverInterruptedGitOperation(this.git, wiki.logger)

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
      for (const remote of remotes) {
        await this.git.removeRemote(remote.name)
      }
    }

    // Add remote
    wiki.logger.info('(STORAGE/GIT) Setting SSL Verification config...')
    await this.git.raw(['config', '--local', '--bool', 'http.sslVerify', _.toString(this.config.verifySSL)])
    switch (this.config.authType) {
      case 'ssh':
        wiki.logger.info('(STORAGE/GIT) Setting SSH Command config...')
        if (this.config.sshPrivateKeyMode === 'contents') {
          try {
            this.config.sshPrivateKeyPath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'secure/git-ssh.pem')
            await fs.outputFile(this.config.sshPrivateKeyPath, this.config.sshPrivateKeyContent + os.EOL, {
              encoding: 'utf8',
              mode: 0o600
            })
          } catch (err: unknown) {
            wiki.logger.error(err instanceof Error ? err.message : String(err))
            throw err
          }
        }
        await this.git.addConfig('core.sshCommand', `ssh -i "${this.config.sshPrivateKeyPath}" -o StrictHostKeyChecking=no`)
        wiki.logger.info('(STORAGE/GIT) Adding origin remote via SSH...')
        await this.git.addRemote('origin', this.config.repoUrl)
        break
      default: {
        wiki.logger.info('(STORAGE/GIT) Adding origin remote via HTTP/S...')
        const originUrl = _.startsWith(this.config.repoUrl, 'http')
          ? this.config.repoUrl.replace('://', `://${encodeURI(this.config.basicUsername)}:${encodeURI(this.config.basicPassword)}@`)
          : `https://${encodeURI(this.config.basicUsername)}:${encodeURI(this.config.basicPassword)}@${this.config.repoUrl}`
        await this.git.addRemote('origin', originUrl)
        break
      }
    }

    // Fetch updates for remote
    wiki.logger.info('(STORAGE/GIT) Fetch updates from remote...')
    await this.git.raw(['remote', 'update', 'origin'])

    // Checkout branch
    const branches = await this.git.branch()
    if (!_.includes(branches.all, this.config.branch) && !_.includes(branches.all, `remotes/origin/${this.config.branch}`)) {
      throw new Error('Invalid branch! Make sure it exists on the remote first.')
    }
    wiki.logger.info(`(STORAGE/GIT) Checking out branch ${this.config.branch}...`)
    await this.git.checkout(this.config.branch)

    // Perform initial sync
    await this.sync()

    wiki.logger.info('(STORAGE/GIT) Initialization completed.')
  },
  /**
   * SYNC
   */
  async sync() {
    const recovered = await recoverInterruptedGitOperation(this.git, wiki.logger)
    const results: GitStorageImportResult[] = []
    await this.git.raw(['remote', 'update', 'origin'])
    await this.git.checkout(this.config.branch)

    const remoteBranch = `origin/${this.config.branch}`
    const branches = await this.git.branch(['-a'])
    const hasRemoteBranch = branches.all.includes(`remotes/${remoteBranch}`)
    const currentCommitLog = (await this.git.log(['-n', '1', this.config.branch, '--'])).latest
    let reattached = false
    let conflicted: string[] = []

    if (hasRemoteBranch && currentCommitLog && !(await sharesHistoryWith(this.git, remoteBranch))) {
      await reattachUnrelatedHistory(this.git, this.config.branch, wiki.logger)
      reattached = true
      wiki.logger.warn(`(STORAGE/GIT) Reattached local history to ${remoteBranch}; existing wiki content remains authoritative.`)
    } else if (hasRemoteBranch && _.includes(['sync', 'pull'], this.mode)) {
      wiki.logger.info(`(STORAGE/GIT) Performing pull rebase from origin on branch ${this.config.branch}...`)
      conflicted = await pullRemoteAuthoritative(this.git, this.config.branch, wiki.logger)
    }

    if (_.includes(['sync', 'push'], this.mode)) {
      wiki.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${this.config.branch}...`)
      const pushOpts = ['--signed=if-asked']
      if (this.mode === 'push') pushOpts.push('--force')
      await this.git.push('origin', this.config.branch, pushOpts)
    }

    if (recovered) {
      wiki.logger.warn(`(STORAGE/GIT) Recovered an unfinished ${recovered} before synchronization.`)
    }
    if (conflicted.length > 0) {
      wiki.logger.warn(`(STORAGE/GIT) ${conflicted.length} conflicting path(s) used the remote version; prior page revisions remain in page history.`)
    }

    // Reattachment repairs only the disposable working copy. Import Everything remains the explicit
    // operation for content which exists remotely but not in the wiki database.
    if (_.includes(['sync', 'pull'], this.mode) && hasRemoteBranch && !reattached) {
      const latestCommitLog = (await this.git.log(['-n', '1', this.config.branch, '--'])).latest
      if (!currentCommitLog || !latestCommitLog) {
        throw new Error(`Unable to determine commits for branch ${this.config.branch}`)
      }

      const diff = await this.git.diffSummary(['-M', currentCommitLog.hash, latestCommitLog.hash])
      if (diff.files.length > 0) {
        const rootUser = await wiki.models.users.getRootUser()
        const filesToProcess: GitStorageFile[] = []
        const filePattern = /(.*?)(?:{(.*?))? => (?:(.*?)})?(.*)/
        for (const fileChange of diff.files) {
          const match = fileChange.file.match(filePattern)
          let oldPath = fileChange.file
          let newPath = fileChange.file
          if (match && !match[2] && !match[3]) {
            oldPath = match[1] ?? fileChange.file
            newPath = match[4] ?? fileChange.file
          } else if (match) {
            oldPath = `${match[1] ?? ''}${match[2] ?? ''}${match[4] ?? ''}`.replace('//', '/')
            newPath = `${match[1] ?? ''}${match[3] ?? ''}${match[4] ?? ''}`.replace('//', '/')
          }
          const filePath = path.join(this.repoPath, newPath)
          let fileStats: { size: number } = { size: 0 }
          try {
            fileStats = await fs.stat(filePath)
          } catch (err: unknown) {
            if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
              wiki.logger.warn(`(STORAGE/GIT) Failed to access file ${fileChange.file}! Skipping...`)
              continue
            }
          }

          const textChange = fileChange as DiffResultTextFile | DiffResultBinaryFile
          filesToProcess.push({
            file: {
              path: filePath,
              stats: fileStats
            },
            oldPath,
            relPath: newPath,
            binary: textChange.binary,
            insertions: textChange.binary ? 0 : textChange.insertions,
            deletions: textChange.binary ? 0 : textChange.deletions,
            before: textChange.binary ? textChange.before : 0,
            after: textChange.binary ? textChange.after : 0,
            importAll: false
          })
        }
        results.push(...await this.processFiles(filesToProcess, rootUser))
      }
    }
    return results
  },
  /**
   * Process Files
   *
   * @param {Array<String>} files Array of files to process
   */
  async processFiles(files: GitStorageFile[], user: WikiUser) {
    const results: GitStorageImportResult[] = []
    for (const item of files) {
      try {
        const contentType = pageHelper.getContentType(item.relPath)
        const fileExists = await fs.pathExists(item.file.path)
        if (!item.binary && contentType) {
          // -> Page

          if (fileExists && !item.importAll && item.relPath !== item.oldPath) {
            // Page was renamed by git, so rename in DB
            wiki.logger.info(`(STORAGE/GIT) Page marked as renamed: from ${item.oldPath} to ${item.relPath}`)

            const contentPath = pageHelper.getPagePath(item.oldPath)
            const contentDestinationPath = pageHelper.getPagePath(item.relPath)
            await wiki.models.pages.movePage({
              user: user,
              path: contentPath.path,
              destinationPath: contentDestinationPath.path,
              locale: contentPath.locale,
              destinationLocale: contentDestinationPath.locale,
              skipStorage: true
            })
            results.push({ kind: 'page', relPath: item.relPath, ok: true })
            continue
          } else if (!fileExists && !item.importAll && item.deletions > 0 && item.insertions === 0) {
            // Page was deleted by git, can safely mark as deleted in DB
            wiki.logger.info(`(STORAGE/GIT) Page marked as deleted: ${item.relPath}`)

            const contentPath = pageHelper.getPagePath(item.relPath)
            await wiki.models.pages.deletePage({
              user: user,
              path: contentPath.path,
              locale: contentPath.locale,
              skipStorage: true
            })
            results.push({ kind: 'page', relPath: item.relPath, ok: true })
            continue
          }

          const pageResult = await commonDisk.processPage({
            user,
            relPath: item.relPath,
            fullPath: this.repoPath,
            contentType: contentType,
            moduleName: 'GIT'
          })
          results.push({ kind: 'page', ...pageResult })
          if (!pageResult.ok) {
            wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
            wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
          }
        } else {
          // -> Asset

          if (fileExists && !item.importAll && (item.before === item.after || (item.deletions === 0 && item.insertions === 0))) {
            // Asset was renamed by git, so rename in DB
            wiki.logger.info(`(STORAGE/GIT) Asset marked as renamed: from ${item.oldPath} to ${item.relPath}`)

            const sourceHash = assetHelper.generateHash(item.oldPath)
            const destinationHash = assetHelper.generateHash(item.relPath)
            const assetToRename = await wiki.models.assets.query().findOne({ hash: sourceHash })
            if (assetToRename) {
              const folderId = await commonDisk.resolveAssetFolder(item.relPath)
              await wiki.models.assets
                .query()
                .patch({
                  filename: path.posix.basename(item.relPath.replace(/\\/g, '/')),
                  folderId,
                  hash: destinationHash
                })
                .findById(assetToRename.id)
              await requireAssetCache(assetToRename).deleteAssetCache()
              results.push({ kind: 'asset', relPath: item.relPath, ok: true })
            } else {
              wiki.logger.info(`(STORAGE/GIT) Asset was not found in the DB, nothing to rename: ${item.relPath}`)
              results.push({ kind: 'asset', relPath: item.relPath, ok: false, outcome: 'conflict', error: 'Asset was not found in the database' })
            }
            continue
          } else if (!fileExists && !item.importAll && ((item.before > 0 && item.after === 0) || (item.deletions > 0 && item.insertions === 0))) {
            // Asset was deleted by git, can safely mark as deleted in DB
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

          await commonDisk.processAsset({
            user,
            relPath: item.relPath,
            file: item.file,
            moduleName: 'GIT'
          })
          results.push({ kind: 'asset', relPath: item.relPath, ok: true })
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        wiki.logger.warn(`(STORAGE/GIT) Failed to process ${item.relPath}`)
        wiki.logger.warn(message)
        results.push({
          kind: !item.binary && pageHelper.getContentType(item.relPath) ? 'page' : 'asset',
          relPath: item.relPath,
          ok: false,
          error: message
        })
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
    wiki.logger.info(`(STORAGE/GIT) Committing new file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (this.config.alwaysNamespace || (wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode)) {
      fileName = `${page.localeCode}/${fileName}`
    }
    const filePath = path.join(this.repoPath, fileName)
    await fs.outputFile(filePath, serializePage(page), 'utf8')

    const gitFilePath = `./${fileName}`
    if ((await this.git.checkIgnore(gitFilePath)).length === 0) {
      await this.git.add(gitFilePath)
      await this.git.commit(`docs: create ${page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    wiki.logger.info(`(STORAGE/GIT) Committing updated file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (this.config.alwaysNamespace || (wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode)) {
      fileName = `${page.localeCode}/${fileName}`
    }
    const filePath = path.join(this.repoPath, fileName)
    await fs.outputFile(filePath, serializePage(page), 'utf8')

    const gitFilePath = `./${fileName}`
    if ((await this.git.checkIgnore(gitFilePath)).length === 0) {
      await this.git.add(gitFilePath)
      await this.git.commit(`docs: update ${page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    wiki.logger.info(`(STORAGE/GIT) Committing removed file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (this.config.alwaysNamespace || (wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode)) {
      fileName = `${page.localeCode}/${fileName}`
    }

    const gitFilePath = `./${fileName}`
    if ((await this.git.checkIgnore(gitFilePath)).length === 0) {
      await this.git.rm(gitFilePath)
      await this.git.commit(`docs: delete ${page.path}`, fileName, {
        '--author': `"${page.authorName} <${page.authorEmail}>"`
      })
    }
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    wiki.logger.info(`(STORAGE/GIT) Committing file move from [${page.localeCode}] ${page.path} to [${page.destinationLocaleCode}] ${page.destinationPath}...`)
    let sourceFileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    let destinationFileName = `${page.destinationPath}.${pageHelper.getFileExtension(page.contentType)}`

    if (this.config.alwaysNamespace || wiki.config.lang.namespacing) {
      if (this.config.alwaysNamespace || wiki.config.lang.code !== page.localeCode) {
        sourceFileName = `${page.localeCode}/${sourceFileName}`
      }
      if (this.config.alwaysNamespace || wiki.config.lang.code !== page.destinationLocaleCode) {
        destinationFileName = `${page.destinationLocaleCode}/${destinationFileName}`
      }
    }

    const sourceFilePath = path.join(this.repoPath, sourceFileName)
    const destinationFilePath = path.join(this.repoPath, destinationFileName)
    await fs.move(sourceFilePath, destinationFilePath)

    await this.git.rm(`./${sourceFileName}`)
    await this.git.add(`./${destinationFileName}`)
    await this.git.commit(`docs: rename ${page.path} to ${page.destinationPath}`, [sourceFilePath, destinationFilePath], {
      '--author': `"${page.moveAuthorName} <${page.moveAuthorEmail}>"`
    })
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded(asset) {
    wiki.logger.info(`(STORAGE/GIT) Committing new file ${asset.path}...`)
    const filePath = path.join(this.repoPath, asset.path)
    await fs.outputFile(filePath, asset.data, 'utf8')

    await this.git.add(`./${asset.path}`)
    await this.git.commit(`docs: upload ${asset.path}`, asset.path, {
      '--author': `"${asset.authorName} <${asset.authorEmail}>"`
    })
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to upload
   */
  async assetDeleted(asset) {
    wiki.logger.info(`(STORAGE/GIT) Committing removed file ${asset.path}...`)

    await this.git.rm(`./${asset.path}`)
    await this.git.commit(`docs: delete ${asset.path}`, asset.path, {
      '--author': `"${asset.authorName} <${asset.authorEmail}>"`
    })
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to upload
   */
  async assetRenamed(asset) {
    wiki.logger.info(`(STORAGE/GIT) Committing file move from ${asset.path} to ${asset.destinationPath}...`)

    await this.git.mv(`./${asset.path}`, `./${asset.destinationPath}`)
    await this.git.commit(`docs: rename ${asset.path} to ${asset.destinationPath}`, [asset.path, asset.destinationPath], {
      '--author': `"${asset.moveAuthorName} <${asset.moveAuthorEmail}>"`
    })
  },
  async getLocalLocation(asset: WikiAsset) {
    return path.join(this.repoPath, asset.path)
  },
  /**
   * HANDLERS
   */
  async importAll() {
    wiki.logger.info(`(STORAGE/GIT) Importing all content from local Git repo to the DB...`)

    const rootUser = await wiki.models.users.getRootUser()
    const results: StorageImportResult[] = []

    await pipeline(
      klaw(this.repoPath, {
        filter: f => {
          return !_.includes(f, '.git')
        }
      }),
      new Transform({
        objectMode: true,
        transform: async (file: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isKlawItem(file)) {
              throw new TypeError('Git import stream yielded an invalid file')
            }
            const relPath = file.path.slice(this.repoPath.length + 1)
            if (file.stats.size < 1) {
              // Skip directories and zero-byte files
              callback()
              return
            }
            if (relPath.length > 3) {
              wiki.logger.info(`(STORAGE/GIT) Processing ${relPath}...`)
              results.push(...await this.processFiles(
                [{
                  relPath,
                  oldPath: relPath,
                  file,
                  binary: false,
                  deletions: 0,
                  insertions: 0,
                  before: 0,
                  after: 0,
                  importAll: true
                }],
                rootUser
              ))
            }
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

    commonDisk.clearFolderCache()

    wiki.logger.info('(STORAGE/GIT) Import completed.')
    return results
  },
  async syncUntracked() {
    wiki.logger.info(`(STORAGE/GIT) Adding all untracked content...`)

    // -> Pages
    await pipeline(
      wiki.models.knex
        .column(
          'id', 'path', 'localeCode', 'title', 'description', 'contentType', 'content',
          'sourceRevision', 'authorId', 'extra', 'isPublished', 'updatedAt', 'createdAt', 'editorKey'
        )
        .select()
        .from('pages')
        .where({
          visibility: 'public'
        })
        .stream(),
      new Transform({
        objectMode: true,
        transform: async (page: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isPageExportRow(page)) {
              throw new TypeError('Git page export stream yielded an invalid page')
            }
            const pageObject = await wiki.models.pages.query().findOne({ id: page.id })
            if (!pageObject) {
              throw new Error(`Page ${page.id} was not found during Git export`)
            }
            const relatedTags = await pageObject.$relatedQuery('tags')
            page.tags = relatedTags.flatMap(tag => (typeof tag.tag === 'string' ? [{ tag: tag.tag }] : []))

            let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
            if (this.config.alwaysNamespace || (wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode)) {
              fileName = `${page.localeCode}/${fileName}`
            }
            wiki.logger.info(`(STORAGE/GIT) Adding page ${fileName}...`)
            const filePath = path.join(this.repoPath, fileName)
            await fs.outputFile(filePath, serializePage(page), 'utf8')
            await this.git.add(`./${fileName}`)
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

    // -> Assets
    const assetFolders = await wiki.models.assetFolders.getAllPaths()

    await pipeline(
      wiki.models.knex.column('filename', 'folderId', 'data').select().from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
      new Transform({
        objectMode: true,
        transform: async (asset: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isAssetExportRow(asset)) {
              throw new TypeError('Git asset export stream yielded an invalid asset')
            }
            const folderPath = asset.folderId === null ? undefined : assetFolders[asset.folderId]
            const filename = folderPath ? `${folderPath}/${asset.filename}` : asset.filename
            wiki.logger.info(`(STORAGE/GIT) Adding asset ${filename}...`)
            await fs.outputFile(path.join(this.repoPath, filename), asset.data)
            await this.git.add(`./${filename}`)
            callback()
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    )

    await this.git.commit(`docs: add all untracked content`)
    wiki.logger.info('(STORAGE/GIT) All content is now tracked.')
  },
  async purge() {
    wiki.logger.info(`(STORAGE/GIT) Purging local repository...`)
    await fs.emptyDir(this.repoPath)
    wiki.logger.info('(STORAGE/GIT) Local repository is now empty. Reinitializing...')
    await this.init()
  }
}

export default plugin

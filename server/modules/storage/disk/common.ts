import type { WikiUser } from '../../types.ts'
import { wiki } from '../../types.ts'
import fs from 'fs-extra'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import klaw from 'klaw'
import mimeTypesModule from 'mime-types'
import _ from 'lodash'

import pageHelper from '../../../helpers/page.ts'
import { classifyStoragePageDocument } from '../page-document.ts'
import type { StorageImportResult, StoragePageProcessResult } from '../types.ts'
const mime = mimeTypesModule.lookup

interface ImportSource {
  fullPath: string
  moduleName: string
}

interface ImportPageSource extends ImportSource {
  contentType: string
  relPath: string
  user: WikiUser
}

interface ImportFile {
  path: string
  stats: { size: number }
}
interface ImportAssetSource {
  file: ImportFile
  moduleName: string
  relPath: string
  user: WikiUser
}

function isImportFile(value: unknown): value is ImportFile {
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


function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

const plugin = {
  assetFolders: null as Record<number, string> | null,
  async importFromDisk({ fullPath, moduleName }: ImportSource): Promise<StorageImportResult[]> {
    const rootUser = await wiki.models.users.getRootUser()
    const results: StorageImportResult[] = []

    await pipeline(
      klaw(fullPath, {
        filter: f => {
          return !_.includes(f, '.git')
        }
      }),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          if (!isImportFile(value)) {
            callback(new TypeError('Invalid file received from disk'))
            return
          }
          const relPath = value.path.slice(fullPath.length + 1)
          if (value.stats.size < 1 || !relPath || relPath.length <= 3) {
            callback()
            return
          }

          wiki.logger.info(`(STORAGE/${moduleName}) Processing ${relPath}...`)
          const contentType = pageHelper.getContentType(relPath)
          if (contentType) {
            try {
              const pageResult = await this.processPage({
                user: rootUser,
                relPath,
                fullPath,
                contentType,
                moduleName
              })
              results.push({ kind: 'page', ...pageResult })
              if (!pageResult.ok) {
                wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process page ${relPath}`)
                wiki.logger.warn(pageResult.error ?? 'Page document was rejected')
              }
            } catch (err: unknown) {
              const error = toError(err)
              results.push({ kind: 'page', relPath, ok: false, error: error.message })
              wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process page ${relPath}`)
              wiki.logger.warn(error.message)
            }
          } else {
            try {
              await this.processAsset({
                user: rootUser,
                relPath,
                file: value,
                moduleName
              })
              results.push({ kind: 'asset', relPath, ok: true })
            } catch (err: unknown) {
              const error = toError(err)
              results.push({ kind: 'asset', relPath, ok: false, error: error.message })
              wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process asset ${relPath}`)
              wiki.logger.warn(error.message)
            }
          }
          callback()
        }
      })
    )
    this.clearFolderCache()
    return results
  },

  async processPage({ user, fullPath, relPath, contentType, moduleName }: ImportPageSource): Promise<StoragePageProcessResult> {
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    const contentPath = pageHelper.getPagePath(normalizedRelPath)
    const itemContents = await fs.readFile(path.join(fullPath, relPath))
    const document = classifyStoragePageDocument({
      rawDocument: itemContents,
      contentType,
      locale: contentPath.locale,
      pagePath: contentPath.path,
      importer: `import:${moduleName.toLowerCase()}`
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
    const currentPage = await wiki.models.pages.getPageFromDb({
      path: contentPath.path,
      locale: contentPath.locale
    })
    const currentPublishedState = currentPage && 'isPublished' in currentPage && typeof currentPage.isPublished === 'boolean' ? currentPage.isPublished : true
    if (currentPage) {
      // Already in the DB, can mark as modified
      wiki.logger.info(`(STORAGE/${moduleName}) Page marked as modified: ${normalizedRelPath}`)
      const page = await wiki.models.pages.updatePage({
        id: currentPage.id,
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
        skipStorage: true
      })
      return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
    }
    // Not in the DB, can mark as new
    wiki.logger.info(`(STORAGE/${moduleName}) Page marked as new: ${normalizedRelPath}`)
    const editors = wiki.models.editors
    const getDefaultEditor: (contentType: string) => Promise<string> = editors.getDefaultEditor
    const pageEditor = await getDefaultEditor.call(editors, contentType)
    const page = await wiki.models.pages.createPage({
      path: contentPath.path,
      locale: contentPath.locale,
      title: document.title ?? contentPath.path.split('/').at(-1) ?? contentPath.path,
      description: document.description ?? '',
      tags: document.tags,
      isPublished: document.isPublished ?? true,
      visibility: 'public',
      content: document.body,
      user,
      editor: pageEditor,
      okfMetadata: document.okfMetadata ?? undefined,
      skipStorage: true
    })
    return { relPath: normalizedRelPath, format: document.format, sha256: document.sha256, ok: true, document, page }
  },


  async resolveAssetFolder(relPath: string): Promise<number | null> {
    if (!this.assetFolders) {
      this.assetFolders = await wiki.models.assetFolders.getAllPaths()
    }
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
          const newFolderId = _.toInteger(newFolder.id)
          if (newFolderId < 1) {
            throw new TypeError('Invalid asset folder id')
          }
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

  async processAsset({ user, relPath, file, moduleName }: ImportAssetSource) {
    wiki.logger.info(`(STORAGE/${moduleName}) Asset marked for import: ${relPath}`)

    const filePathInfo = path.parse(file.path)
    const folderId = await this.resolveAssetFolder(relPath)

    await wiki.models.assets.upload({
      mode: 'import',
      originalname: filePathInfo.base,
      ext: filePathInfo.ext,
      mimetype: mime(filePathInfo.base) || 'application/octet-stream',
      size: file.stats.size,
      folderId,
      path: file.path,
      assetPath: relPath,
      user,
      skipStorage: true
    })
  },

  clearFolderCache() {
    this.assetFolders = null
  }
}

export default plugin

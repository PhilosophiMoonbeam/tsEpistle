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


interface PageMetadata {
  content: string | Record<string, unknown>
  description?: string
  isPublished?: boolean
  tags?: string
  title?: string
}

function isImportFile (value: unknown): value is ImportFile {
  return typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'stats' in value &&
    typeof value.stats === 'object' &&
    value.stats !== null &&
    'size' in value.stats &&
    typeof value.stats.size === 'number'
}

function isPageMetadata (value: unknown): value is PageMetadata {
  return typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    (typeof value.content === 'string' ||
      (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    (!('description' in value) || typeof value.description === 'string') &&
    (!('isPublished' in value) || typeof value.isPublished === 'boolean') &&
    (!('tags' in value) || typeof value.tags === 'string') &&
    (!('title' in value) || typeof value.title === 'string')
}

function getPageMetadata (value: unknown): PageMetadata {
  if (!isPageMetadata(value)) {
    throw new TypeError('Invalid page metadata')
  }
  return value
}

function toError (value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}


const plugin = {
  assetFolders: null as Record<number, string> | null,
  async importFromDisk ({ fullPath, moduleName }: ImportSource) {
    const rootUser = await wiki.models.users.getRootUser()

    await pipeline(
      klaw(fullPath, {
        filter: (f) => {
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
          if (value.stats.size < 1) {
            // Skip directories and zero-byte files
            callback()
            return
          }
          if (!relPath || relPath.length <= 3) {
            callback()
            return
          }

          wiki.logger.info(`(STORAGE/${moduleName}) Processing ${relPath}...`)
          const contentType = pageHelper.getContentType(relPath)
          if (contentType) {
            // -> Page
            try {
              await this.processPage({
                user: rootUser,
                relPath,
                fullPath,
                contentType,
                moduleName
              })
            } catch (err: unknown) {
              wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process page ${relPath}`)
              wiki.logger.warn(toError(err).message)
            }
          } else {
            // -> Asset
            try {
              await this.processAsset({
                user: rootUser,
                relPath,
                file: value,
                moduleName
              })
            } catch (err: unknown) {
              wiki.logger.warn(`(STORAGE/${moduleName}) Failed to process asset ${relPath}`)
              wiki.logger.warn(toError(err).message)
            }
          }
          callback()
        }
      })
    )
    this.clearFolderCache()
  },

  async processPage ({ user, fullPath, relPath, contentType, moduleName }: ImportPageSource) {
    const normalizedRelPath = relPath.replace(/\\/g, '/')
    const contentPath = pageHelper.getPagePath(normalizedRelPath)
    const itemContents = await fs.readFile(path.join(fullPath, relPath), 'utf8')
    const pageData = getPageMetadata(wiki.models.pages.parseMetadata(itemContents, contentType))
    const currentPage = await wiki.models.pages.getPageFromDb({
      path: contentPath.path,
      locale: contentPath.locale
    })
    const newTags = pageData.tags?.split(', ')
    const currentPublishedState = currentPage &&
      'isPublished' in currentPage &&
      typeof currentPage.isPublished === 'boolean'
      ? currentPage.isPublished
      : true
    if (currentPage) {
      // Already in the DB, can mark as modified
      wiki.logger.info(`(STORAGE/${moduleName}) Page marked as modified: ${normalizedRelPath}`)
      await wiki.models.pages.updatePage({
        id: currentPage.id,
        title: pageData.title ?? currentPage.title,
        description: pageData.description ?? currentPage.description ?? '',
        tags: newTags ?? currentPage.tags.flatMap(tag => typeof tag.tag === 'string' ? [tag.tag] : []),
        isPublished: pageData.isPublished ?? currentPublishedState,
        isPrivate: false,
        content: pageData.content,
        user: user,
        skipStorage: true
      })
    } else {
      // Not in the DB, can mark as new
      wiki.logger.info(`(STORAGE/${moduleName}) Page marked as new: ${normalizedRelPath}`)
      const editors = wiki.models.editors
      const getDefaultEditor: (contentType: string) => Promise<string> = editors.getDefaultEditor
      const pageEditor = await getDefaultEditor.call(editors, contentType)
      await wiki.models.pages.createPage({
        path: contentPath.path,
        locale: contentPath.locale,
        title: pageData.title ?? contentPath.path.split('/').at(-1) ?? contentPath.path,
        description: pageData.description ?? '',
        tags: newTags ?? [],
        isPublished: pageData.isPublished ?? true,
        isPrivate: false,
        content: pageData.content,
        user,
        editor: pageEditor,
        skipStorage: true
      })
    }
  },

  async processAsset ({ user, relPath, file, moduleName }: ImportAssetSource) {
    wiki.logger.info(`(STORAGE/${moduleName}) Asset marked for import: ${relPath}`)

    // -> Get all folder paths
    if (!this.assetFolders) {
      this.assetFolders = await wiki.models.assetFolders.getAllPaths()
    }
    const assetFolders = this.assetFolders

    // -> Find existing folder
    const filePathInfo = path.parse(file.path)
    const folderPath = path.dirname(relPath).replace(/\\/g, '/')
    let folderId: number | null = _.toInteger(_.findKey(assetFolders, fld => fld === folderPath)) || null

    // -> Create missing folder structure
    if (!folderId && folderPath !== '.') {
      const folderParts = folderPath.split('/')
      const currentFolderPath: string[] = []
      let currentFolderParentId: number | null = null
      for (const folderPart of folderParts) {
        currentFolderPath.push(folderPart)
        const currentPath = currentFolderPath.join('/')
        const existingFolderId = _.findKey(assetFolders, fld => fld === currentPath)
        if (!existingFolderId) {
          const newFolderObj = await wiki.models.assetFolders.query().insert({
            slug: folderPart,
            name: folderPart,
            parentId: currentFolderParentId
          })
          const newFolderId = _.toInteger(newFolderObj.id)
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

    // -> Import asset
    await wiki.models.assets.upload({
      mode: 'import',
      originalname: filePathInfo.base,
      ext: filePathInfo.ext,
      mimetype: mime(filePathInfo.base) || 'application/octet-stream',
      size: file.stats.size,
      folderId: folderId,
      path: file.path,
      assetPath: relPath,
      user: user,
      skipStorage: true
    })
  },

  clearFolderCache () {
    this.assetFolders = null
  }
}

export default plugin

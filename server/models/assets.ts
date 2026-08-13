import { Model } from 'objection'
import type { ModelOptions, QueryContext } from 'objection'
import type { Response } from 'express'
import type { Knex } from 'knex'
import moment from 'moment'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import assetHelper from '../helpers/asset.ts'
import User from './users.ts'
import AssetFolder from './assetFolders.ts'

interface AssetUser {
  id: number
  name: string
  email: string
}

interface UploadOptions {
  originalname: string
  assetPath: string
  mimetype: string
  size: number
  folderId: number | null
  path: string
  mode: string
  user: AssetUser
  skipStorage?: boolean
}

interface StorageLocation {
  path?: string
}

interface AssetDataRow {
  data: Buffer
}

export default class Asset extends Model {
  declare id: number
  declare filename: string
  declare hash: string
  declare ext: string
  declare kind: string
  declare mime: string
  declare fileSize: number
  declare metadata: Record<string, unknown>
  declare authorId: number
  declare folderId: number | null
  declare createdAt: string
  declare updatedAt: string

  static override get tableName () { return 'assets' }

  static override get jsonSchema () {
    return {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filename: { type: 'string' },
        hash: { type: 'string' },
        ext: { type: 'string' },
        kind: { type: 'string' },
        mime: { type: 'string' },
        fileSize: { type: 'integer' },
        metadata: { type: 'object' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' }
      }
    }
  }

  static override get relationMappings () {
    return {
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: { from: 'assets.authorId', to: 'users.id' }
      },
      folder: {
        relation: Model.BelongsToOneRelation,
        modelClass: AssetFolder,
        join: { from: 'assets.folderId', to: 'assetFolders.id' }
      }
    }
  }

  override async $beforeUpdate (opt: ModelOptions, context: QueryContext): Promise<void> {
    await super.$beforeUpdate(opt, context)
    this.updatedAt = moment.utc().toISOString()
  }

  override async $beforeInsert (context: QueryContext): Promise<void> {
    await super.$beforeInsert(context)
    this.createdAt = moment.utc().toISOString()
    this.updatedAt = moment.utc().toISOString()
  }

  async getAssetPath (): Promise<string> {
    const hierarchy = this.folderId ? await wiki.models.assetFolders.getHierarchy(this.folderId) : []
    return this.folderId ? `${hierarchy.map(folder => folder.slug).join('/')}/${this.filename}` : this.filename
  }

  async deleteAssetCache (): Promise<void> {
    await fs.remove(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${this.hash}.dat`))
  }

  static async upload (opts: UploadOptions): Promise<void> {
    const fileInfo = path.parse(opts.originalname)
    const fileHash = assetHelper.generateHash(opts.assetPath)
    let asset = await wiki.models.assets.query().where({ hash: fileHash, folderId: opts.folderId }).first()
    const assetRow: Partial<Asset> = {
      filename: opts.originalname,
      hash: fileHash,
      ext: fileInfo.ext,
      kind: _.startsWith(opts.mimetype, 'image/') ? 'image' : 'binary',
      mime: opts.mimetype,
      fileSize: opts.size,
      folderId: opts.folderId
    }

    if (wiki.config.uploads.scanSVG && (opts.mimetype.toLowerCase().startsWith('image/svg') || fileInfo.ext.toLowerCase() === '.svg')) {
      const svgSanitizeJob = await wiki.scheduler.registerJob({ name: 'sanitize-svg', immediate: true, worker: true }, opts.path)
      await svgSanitizeJob.finished
    }

    try {
      const fileBuffer = await fs.readFile(opts.path)
      if (asset) {
        if (opts.mode === 'upload') {
          assetRow.authorId = opts.user.id
        }
        await wiki.models.assets.query().patch(assetRow).findById(asset.id)
        await wiki.models.knex('assetData').where({ id: asset.id }).update({ data: fileBuffer })
      } else {
        assetRow.authorId = opts.user.id
        asset = await wiki.models.assets.query().insert(assetRow)
        await wiki.models.knex('assetData').insert({ id: asset.id, data: fileBuffer })
      }

      const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${fileHash}.dat`)
      if (opts.mode === 'upload') {
        await fs.move(opts.path, cachePath, { overwrite: true })
      } else {
        await fs.copy(opts.path, cachePath, { overwrite: true })
      }

      if (!opts.skipStorage) {
        await wiki.models.storage.assetEvent({
          event: 'uploaded',
          asset: {
            ...asset,
            path: await asset.getAssetPath(),
            data: fileBuffer,
            authorId: opts.user.id,
            authorName: opts.user.name,
            authorEmail: opts.user.email
          }
        })
      }
    } catch (err) {
      wiki.logger.warn(err)
    }
  }

  static async getAsset (assetPath: string, res: Response): Promise<void> {
    try {
      const fileInfo = assetHelper.getPathInfo(assetPath)
      const fileHash = assetHelper.generateHash(assetPath)
      const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${fileHash}.dat`)
      if (wiki.config.uploads.forceDownload && !['.png', '.apng', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(fileInfo.ext)) {
        res.set('Content-disposition', `attachment; filename=${encodeURIComponent(fileInfo.base)}`)
      }
      if (await wiki.models.assets.getAssetFromCache(assetPath, cachePath, res)) return
      if (await wiki.models.assets.getAssetFromStorage(assetPath, res)) return
      await wiki.models.assets.getAssetFromDb(fileHash, cachePath, res)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err.code === 'ECONNABORTED' || err.code === 'EPIPE')) return
      wiki.logger.error(err)
      res.sendStatus(500)
    }
  }

  static async getAssetFromCache (assetPath: string, cachePath: string, res: Response): Promise<boolean> {
    try {
      await fs.access(cachePath, fs.constants.R_OK)
    } catch {
      return false
    }
    res.type(path.extname(assetPath))
    await new Promise<void>((resolve, reject) => {
      res.sendFile(cachePath, { dotfiles: 'deny' }, error => {
        if (error) reject(error)
        else resolve()
      })
    })
    return true
  }

  static async getAssetFromStorage (assetPath: string, res: Response): Promise<boolean> {
    const localLocations = await wiki.models.storage.getLocalLocations({ asset: { path: assetPath } })
    for (const location of _.filter(localLocations, location => Boolean(location.path))) {
      if (location.path && await wiki.models.assets.getAssetFromCache(assetPath, location.path, res)) return true
    }
    return false
  }

  static async getAssetFromDb (fileHash: string, cachePath: string, res: Response): Promise<void> {
    const asset = await wiki.models.assets.query().where('hash', fileHash).first()
    if (!asset) {
      res.sendStatus(404)
      return
    }
    const assetData = await wiki.models.knex<AssetDataRow>('assetData').where('id', asset.id).first()
    if (!assetData) {
      res.sendStatus(404)
      return
    }
    res.type(asset.ext)
    res.send(assetData.data)
    await fs.outputFile(cachePath, assetData.data)
  }

  static async flushTempUploads (): Promise<void> {
    await fs.emptyDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads'))
  }
}

const wiki = WIKI as unknown as {
  ROOTPATH: string
  config: { dataPath: string, uploads: { scanSVG: boolean, forceDownload: boolean } }
  logger: { warn: (error: unknown) => void, error: (error: unknown) => void }
  scheduler: { registerJob: (definition: { name: string, immediate: boolean, worker: boolean }, path: string) => Promise<{ finished: Promise<unknown> }> }
  models: {
    assets: typeof Asset
    assetFolders: typeof AssetFolder
    knex: Knex
    storage: {
      assetEvent: (event: { event: string, asset: Record<string, unknown> }) => Promise<void>
      getLocalLocations: (event: { asset: { path: string } }) => Promise<StorageLocation[]>
    }
  }
}

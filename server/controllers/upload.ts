import express from 'express'
import _ from 'lodash'
import multer from 'multer'
import path from 'node:path'
import sanitize from 'sanitize-filename'
import { unlink } from 'node:fs/promises'

interface UploadFolder {
  slug: string
}

export interface UploadWiki {
  ROOTPATH: string
  auth: {
    checkAccess(user: Express.User | undefined, permissions: string[], context?: unknown): boolean
  }
  config: {
    dataPath: string
    uploads: { maxFileSize: number; maxFiles: number }
  }
  models: {
    assetFolders: { getHierarchy(folderId: number): Promise<UploadFolder[]> }
    assets: { upload(input: Record<string, unknown>): Promise<unknown> }
  }
}

const cleanupUploadedFiles = async (req: express.Request): Promise<void> => {
  const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat()
  const paths = new Set(
    files
      .concat(req.file ?? [])
      .map(file => file.path)
      .filter(Boolean)
  )

  await Promise.all(
    [...paths].map(async filePath => {
      try {
        await unlink(filePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
    })
  )
}
export default function createUploadController(wiki: UploadWiki): express.Router {
  const router = express.Router()

  /**
   * Upload files
   */
  const persistUpload = multer({
    dest: path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads'),
    limits: {
      fileSize: wiki.config.uploads.maxFileSize,
      files: wiki.config.uploads.maxFiles
    },
    defParamCharset: 'utf8'
  }).array('mediaUpload')

  router.post(
    '/u',
    (req, res, next) => {
      if (!wiki.auth.checkAccess(req.user, ['write:assets', 'manage:system'])) {
        return res.status(403).json({
          succeeded: false,
          message: 'You are not authorized to upload files.'
        })
      }

      persistUpload(req, res, err => {
        if (!err) {
          return next()
        }

        cleanupUploadedFiles(req).then(() => next(err), next)
      })
    },
    async (req, res) => {
      const rejectUpload = async (status: number, message: string) => {
        await cleanupUploadedFiles(req)
        return res.status(status).json({
          succeeded: false,
          message
        })
      }

      try {
        if (!Array.isArray(req.files) || req.files.length < 1) {
          return await rejectUpload(400, 'Missing upload payload.')
        } else if (req.files.length > 1) {
          return await rejectUpload(400, 'You cannot upload multiple files within the same request.')
        }
        const fileMeta = req.files[0]
        if (!fileMeta) {
          return await rejectUpload(500, 'Missing upload file metadata.')
        }

        // Get folder Id
        let folderId: number | null
        try {
          const folderRaw: unknown = _.get(req, 'body.mediaUpload', false)
          if (typeof folderRaw === 'string') {
            const folderMetadata: unknown = JSON.parse(folderRaw)
            const candidate = typeof folderMetadata === 'object' && folderMetadata !== null && 'folderId' in folderMetadata ? folderMetadata.folderId : null
            if (candidate !== null && (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)) {
              throw new Error('Invalid folder id')
            }
            folderId = candidate === 0 ? null : candidate
          } else {
            throw new Error('Missing File Metadata')
          }
        } catch {
          return await rejectUpload(400, 'Missing upload folder metadata.')
        }

        // Build folder hierarchy
        let hierarchy: UploadFolder[] = []
        if (folderId) {
          try {
            hierarchy = await wiki.models.assetFolders.getHierarchy(folderId)
          } catch {
            return await rejectUpload(400, 'Failed to fetch folder hierarchy.')
          }
        }

        // Sanitize filename
        fileMeta.originalname = sanitize(fileMeta.originalname.toLowerCase().replace(/[\s,;#]+/g, '_'))

        // Check if user can upload at path
        const assetPath = folderId ? hierarchy.map(h => h.slug).join('/') + `/${fileMeta.originalname}` : fileMeta.originalname
        if (!wiki.auth.checkAccess(req.user, ['write:assets', 'manage:system'], { path: assetPath })) {
          return await rejectUpload(403, 'You are not authorized to upload files to this folder.')
        }

        // Process upload file
        await wiki.models.assets.upload({
          ...fileMeta,
          mode: 'upload',
          folderId: folderId,
          assetPath,
          user: req.user
        })
        res.send('ok')
      } catch (err) {
        await cleanupUploadedFiles(req)
        throw err
      }
    }
  )

  router.get('/u', async (req, res) => {
    res.json({
      ok: true
    })
  })

  return router
}

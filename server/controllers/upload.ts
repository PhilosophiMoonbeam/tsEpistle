import express from 'express'
import { getWikiAuth } from './_types.ts'
import _ from 'lodash'
import multer from 'multer'
import path from 'node:path'
import sanitize from 'sanitize-filename'

const router = express.Router()

/* global WIKI */
interface UploadFolder {
  slug: string
}

interface UploadWiki {
  ROOTPATH: string
  config: {
    dataPath: string
    uploads: { maxFileSize: number; maxFiles: number }
  }
  models: {
    assetFolders: { getHierarchy(folderId: number): Promise<UploadFolder[]> }
    assets: { upload(input: Record<string, unknown>): Promise<unknown> }
  }
}

const wiki = WIKI as unknown as UploadWiki


/**
 * Upload files
 */
router.post('/u', (req, res, next) => {
  multer({
    dest: path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads'),
    limits: {
      fileSize: wiki.config.uploads.maxFileSize,
      files: wiki.config.uploads.maxFiles
    },
    defParamCharset: 'utf8'
  }).array('mediaUpload')(req, res, next)
}, async (req, res) => {
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : []
  if (!permissions.some(permission => ['write:assets', 'manage:system'].includes(permission))) {
    return res.status(403).json({
      succeeded: false,
      message: 'You are not authorized to upload files.'
    })
  } else if (!Array.isArray(req.files) || req.files.length < 1) {
    return res.status(400).json({
      succeeded: false,
      message: 'Missing upload payload.'
    })
  } else if (req.files.length > 1) {
    return res.status(400).json({
      succeeded: false,
      message: 'You cannot upload multiple files within the same request.'
    })
  }
  const fileMeta = req.files[0]
  if (!fileMeta) {
    return res.status(500).json({
      succeeded: false,
      message: 'Missing upload file metadata.'
    })
  }

  // Get folder Id
  let folderId: number | null
  try {
    const folderRaw: unknown = _.get(req, 'body.mediaUpload', false)
    if (typeof folderRaw === 'string') {
      const folderMetadata: unknown = JSON.parse(folderRaw)
      const candidate = typeof folderMetadata === 'object' && folderMetadata !== null && 'folderId' in folderMetadata
        ? folderMetadata.folderId
        : null
      if (candidate !== null && (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)) {
        throw new Error('Invalid folder id')
      }
      folderId = candidate === 0 ? null : candidate
    } else {
      throw new Error('Missing File Metadata')
    }
  } catch {
    return res.status(400).json({
      succeeded: false,
      message: 'Missing upload folder metadata.'
    })
  }

  // Build folder hierarchy
  let hierarchy: UploadFolder[] = []
  if (folderId) {
    try {
      hierarchy = await wiki.models.assetFolders.getHierarchy(folderId)
    } catch {
      return res.status(400).json({
        succeeded: false,
        message: 'Failed to fetch folder hierarchy.'
      })
    }
  }

  // Sanitize filename
  fileMeta.originalname = sanitize(fileMeta.originalname.toLowerCase().replace(/[\s,;#]+/g, '_'))

  // Check if user can upload at path
  const assetPath = (folderId) ? hierarchy.map(h => h.slug).join('/') + `/${fileMeta.originalname}` : fileMeta.originalname
  if (!getWikiAuth().checkAccess(req.user, ['write:assets'], { path: assetPath })) {
    return res.status(403).json({
      succeeded: false,
      message: 'You are not authorized to upload files to this folder.'
    })
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
})

router.get('/u', async (req, res) => {
  res.json({
    ok: true
  })
})

export default router

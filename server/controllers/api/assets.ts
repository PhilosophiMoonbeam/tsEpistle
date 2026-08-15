import express from 'express'
import { objectValue, type Request, type Response, getWikiAuth } from '../_types.ts'
import assetOperations from '../../operations/assets.ts'

const router = express.Router()

interface AssetRequester extends Record<string, unknown> {
  id: number
  name: string
  email: string
}

const isAssetRequester = (user: Express.User | undefined): user is Express.User & AssetRequester =>
  user !== undefined &&
  typeof user.id === 'number' &&
  Number.isInteger(user.id) &&
  typeof user.name === 'string' &&
  typeof user.email === 'string'


const requireAccess = (
  req: Request,
  res: Response,
  permissions: string[]
): req is Request & { user: Express.User & AssetRequester } => {
  if (!getWikiAuth().checkAccess(req.user, permissions) || !isAssetRequester(req.user)) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

const positiveInteger = (value: unknown, res: Response, name: string): number | null => {
  if (!/^[1-9]\d*$/.test(String(value))) {
    res.status(400).json({ error: `${name} must be a positive integer` })
    return null
  }
  return Number(value)
}

const nonNegativeInteger = (value: unknown, res: Response, name: string): number | null => {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: `${name} must be a non-negative integer` })
    return null
  }
  return Number(value)
}

router.get('/', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'read:assets'])) return
  const folderId = nonNegativeInteger(req.query.folderId || 0, res, 'folderId')
  if (folderId === null) return
  const kindValue = req.query.kind || 'ALL'
  if (typeof kindValue !== 'string' || !['ALL', 'IMAGE', 'BINARY'].includes(kindValue)) {
    return res.status(400).json({ error: 'kind must be ALL, IMAGE, or BINARY' })
  }
  try {
    res.json(await assetOperations.list({ requester: req.user, folderId, kind: kindValue }))
  } catch (err) {
    next(err)
  }
})

router.get('/folders', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'read:assets'])) return
  const parentFolderId = nonNegativeInteger(req.query.parentFolderId || 0, res, 'parentFolderId')
  if (parentFolderId === null) return
  try {
    res.json(await assetOperations.listFolders({ requester: req.user, parentFolderId }))
  } catch (err) {
    next(err)
  }
})

router.post('/folders', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'write:assets'])) return
  const parentFolderId = nonNegativeInteger(objectValue(req.body, 'parentFolderId'), res, 'parentFolderId')
  if (parentFolderId === null) return
  const slug = objectValue(req.body, 'slug')
  if (typeof slug !== 'string' || slug.length < 1) return res.status(400).json({ error: 'slug must be a non-empty string' })
  try {
    await assetOperations.createFolder({ parentFolderId, slug })
    res.status(201).json({ message: 'Asset folder created successfully.' })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  const filename = objectValue(req.body, 'filename')
  if (typeof filename !== 'string' || filename.length < 1) return res.status(400).json({ error: 'filename must be a non-empty string' })
  try {
    await assetOperations.rename({ requester: req.user, id, filename })
    res.json({ message: 'Asset renamed successfully.' })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  try {
    await assetOperations.remove({ requester: req.user, id })
    res.json({ message: 'Asset deleted successfully.' })
  } catch (err) {
    next(err)
  }
})

export default router

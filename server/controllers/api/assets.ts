import express from 'express'
import { objectValue, type Request, type Response, getWikiAuth } from '../_types.ts'
import assetOperations from '../../operations/assets.ts'

const router = express.Router()
const imageResizeRequestFields: Readonly<Record<string, true>> = {
  destination: true,
  width: true,
  height: true,
  aspectPolicy: true,
  format: true,
  quality: true,
  animationPolicy: true
}
const imageResizeDestinationFields: Readonly<Record<string, true>> = { filename: true, folderId: true }
const imageResizeFormatFields: Readonly<Record<string, true>> = { png: true, jpeg: true, webp: true, gif: true }

const imageResizeInteger = (value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return null
  return value
}

interface AssetRequester extends Record<string, unknown> {
  id: number
  name: string
  email: string
}

const isAssetRequester = (user: unknown): user is AssetRequester =>
  user !== undefined &&
  user !== null &&
  typeof user === 'object' &&
  typeof Reflect.get(user, 'id') === 'number' &&
  Number.isInteger(Reflect.get(user, 'id')) &&
  typeof Reflect.get(user, 'name') === 'string' &&
  typeof Reflect.get(user, 'email') === 'string'

const requireAccess = (req: Request, res: Response, permissions: string[]): req is Request & { user: AssetRequester } => {
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
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    res.status(400).json({ error: `${name} must be a positive integer` })
    return null
  }
  return parsed
}

router.get('/:id/branding', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  const request = req as unknown as { user?: AssetRequester; sessionID?: string }
  if (!isAssetRequester(request.user)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  try {
    res.json(await assetOperations.getBranding({ requester: request.user, id, sessionId: request.sessionID ?? '', deriveIfMissing: true }))
  } catch (err) {
    next(err)
  }
})

router.post('/:id/resize', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  if (!requireAccess(req, res, ['read:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  const body = req.body
  const destination = objectValue(body, 'destination')
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    destination === null ||
    typeof destination !== 'object' ||
    Array.isArray(destination)
  ) {
    return res.status(400).json({ error: 'A valid image resize request is required.' })
  }
  if (
    Object.keys(body).some(key => !Object.hasOwn(imageResizeRequestFields, key)) ||
    Object.keys(destination).some(key => !Object.hasOwn(imageResizeDestinationFields, key))
  ) {
    return res.status(400).json({ error: 'The image resize request contains unsupported fields.' })
  }
  const filename = objectValue(destination, 'filename')
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255) {
    return res.status(400).json({ error: 'destination.filename must be a filename of 1 to 255 characters.' })
  }
  const rawFolderId = objectValue(destination, 'folderId')
  let folderId: number | null
  if (rawFolderId === null) folderId = null
  else {
    folderId = imageResizeInteger(rawFolderId, 'destination.folderId', 0)
    if (folderId === null) return res.status(400).json({ error: 'destination.folderId must be a non-negative integer or null.' })
  }
  const width = imageResizeInteger(objectValue(body, 'width'), 'width', 1)
  if (width === null) return res.status(400).json({ error: 'width must be a positive integer.' })
  const height = imageResizeInteger(objectValue(body, 'height'), 'height', 1)
  if (height === null) return res.status(400).json({ error: 'height must be a positive integer.' })
  const aspectPolicy = objectValue(body, 'aspectPolicy')
  if (aspectPolicy !== 'preserve' && aspectPolicy !== 'stretch') {
    return res.status(400).json({ error: 'aspectPolicy must be preserve or stretch.' })
  }
  const format = objectValue(body, 'format')
  if (typeof format !== 'string' || !Object.hasOwn(imageResizeFormatFields, format)) {
    return res.status(400).json({ error: 'format must be png, jpeg, webp, or gif.' })
  }
  const quality = imageResizeInteger(objectValue(body, 'quality'), 'quality', 1, 100)
  if (quality === null) return res.status(400).json({ error: 'quality must be an integer from 1 to 100.' })
  const animationPolicy = objectValue(body, 'animationPolicy')
  if (animationPolicy !== 'preserve' && animationPolicy !== 'first-frame') {
    return res.status(400).json({ error: 'animationPolicy must be preserve or first-frame.' })
  }
  try {
    const receipt = await assetOperations.resizeImage({
      requester: req.user,
      id,
      destination: { filename, folderId },
      width,
      height,
      aspectPolicy,
      format: format as 'png' | 'jpeg' | 'webp' | 'gif',
      quality,
      animationPolicy
    })
    res.status(201).json(receipt)
  } catch (err) {
    next(mapRelocationError(err))
  }
})

const nonNegativeInteger = (value: unknown, res: Response, name: string): number | null => {
  if (!/^\d+$/.test(String(value))) {
    res.status(400).json({ error: `${name} must be a non-negative integer` })
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    res.status(400).json({ error: `${name} must be a non-negative integer` })
    return null
  }
  return parsed
}
const mapRelocationError = (value: unknown): unknown => {
  const name = typeof value === 'object' && value !== null ? Reflect.get(value, 'name') : undefined
  if (typeof name !== 'string') return value
  let status: number | undefined
  let message: string | undefined
  switch (name) {
    case 'AssetInvalid':
      status = 404
      message = 'This asset does not exist or is invalid.'
      break
    case 'AssetRenameInvalid':
      status = 400
      message = 'The new asset filename is invalid.'
      break
    case 'AssetRenameInvalidExt':
      status = 400
      message = 'The file extension cannot be changed on an existing asset.'
      break
    case 'AssetRenameCollision':
      status = 409
      message = 'Asset relocation cannot use the requested location.'
      break
    case 'AssetRenameForbidden':
    case 'AssetRenameTargetForbidden':
      status = 403
      message = 'You are not authorized to relocate this asset.'
      break
    default:
      return value
  }
  const mapped = new Error(message)
  mapped.name = name
  const code = objectValue(value, 'code')
  const numericCode = typeof code === 'number' ? code : undefined
  Object.assign(mapped, { status, ...(numericCode === undefined ? {} : { code: numericCode }) })
  return mapped
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
    await assetOperations.createFolder({ requester: req.user, parentFolderId, slug })
    res.status(201).json({ message: 'Asset folder created successfully.' })
  } catch (err) {
    next(err)
  }
})

router.get('/relocations/:id', async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  try {
    res.json(await assetOperations.relocationStatus({ requester: req.user, id: req.params.id }))
  } catch (err) {
    next(mapRelocationError(err))
  }
})

router.patch('/:id', async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  if (!requireAccess(req, res, ['manage:system', 'manage:assets'])) return
  const id = positiveInteger(req.params.id, res, 'id')
  if (id === null) return
  const hasFilename = req.body !== null && typeof req.body === 'object' && Object.hasOwn(req.body, 'filename')
  const hasFolderId = req.body !== null && typeof req.body === 'object' && Object.hasOwn(req.body, 'folderId')
  if (!hasFilename && !hasFolderId) return res.status(400).json({ error: 'filename or folderId is required' })
  const filenameValue = hasFilename ? objectValue(req.body, 'filename') : undefined
  if (hasFilename && (typeof filenameValue !== 'string' || filenameValue.length < 1)) {
    return res.status(400).json({ error: 'filename must be a non-empty string' })
  }
  let folderId: number | null | undefined
  if (hasFolderId) {
    const rawFolderId = objectValue(req.body, 'folderId')
    if (rawFolderId === null) folderId = 0
    else {
      folderId = nonNegativeInteger(rawFolderId, res, 'folderId')
      if (folderId === null) return
    }
  }
  const relocationInput: {
    requester: AssetRequester
    id: number
    filename?: string
    folderId?: number | null
  } = { requester: req.user, id }
  if (typeof filenameValue === 'string') relocationInput.filename = filenameValue
  if (folderId !== undefined) relocationInput.folderId = folderId
  try {
    const receipt = await assetOperations.relocate(relocationInput)
    res.status(202).json({ message: 'Asset relocation accepted.', ...receipt })
  } catch (err) {
    next(mapRelocationError(err))
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
    next(mapRelocationError(err))
  }
})

export default router

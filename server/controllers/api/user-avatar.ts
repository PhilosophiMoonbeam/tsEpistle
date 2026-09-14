import express from 'express'
import multer from 'multer'
import { type NextFunction, type Request, type Response } from '../_types.ts'
import userOperations from '../../operations/users.ts'
import { USER_AVATAR_SOURCE_BYTE_LIMIT, UserAvatarProcessingError } from '../../helpers/user-avatar-processing.ts'

const router = express.Router()

const invalidImageResponse = (res: Response, message = 'Exactly one non-empty avatar image is required.'): void => {
  res.status(400).json({ error: message, code: 'INVALID_IMAGE' })
}

const hasSelfServiceIdentity = (req: Request): boolean => {
  const id = req.user?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id === 2) return false
  if (req.user?.ownershipUserId === null) return false
  return req.user?.ownershipUserId === undefined || req.user.ownershipUserId === id
}

const requireSelfServiceIdentity = (req: Request, res: Response, next: NextFunction): void => {
  if (!hasSelfServiceIdentity(req)) {
    res.status(401).json({ error: 'Authentication is required.' })
    return
  }
  next()
}

const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Multer emits LIMIT_FILE_SIZE only once the file exceeds this value, so the exact
    // source-byte ceiling remains accepted while the first byte above it is rejected.
    fileSize: USER_AVATAR_SOURCE_BYTE_LIMIT,
    files: 1,
    fields: 0,
    fieldNameSize: 64,
    fieldSize: 1,
    headerPairs: 32,
    // Busboy counts the closing boundary when enforcing the part limit.
    parts: 2
  }
}).single('image')

const sendKnownError = (error: unknown, res: Response): boolean => {
  if (error instanceof UserAvatarProcessingError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return true
  }
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Avatar image exceeds 1,048,576 bytes.', code: 'IMAGE_TOO_LARGE' })
    } else {
      invalidImageResponse(res, 'Exactly one avatar image file is required.')
    }
    return true
  }
  return false
}

const acceptMultipartImage = (req: Request, res: Response, next: NextFunction): void => {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    invalidImageResponse(res, 'Avatar upload must use multipart/form-data.')
    return
  }

  parseImage(req, res, error => {
    if (error) {
      if (sendKnownError(error, res)) return
      invalidImageResponse(res, 'Avatar multipart body is malformed.')
      return
    }
    if (!req.file || !Buffer.isBuffer(req.file.buffer) || req.file.buffer.byteLength === 0) {
      invalidImageResponse(res, 'Exactly one non-empty avatar image file is required.')
      return
    }
    next()
  })
}

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

router.post('/', requireSelfServiceIdentity, acceptMultipartImage, async (req, res, next) => {
  try {
    const result = await userOperations.updateAvatar({ requester: req.user, data: req.file!.buffer, response: res })
    res.json({ message: 'Profile avatar updated successfully.', pictureUrl: result.pictureUrl })
  } catch (error) {
    if (!sendKnownError(error, res)) next(error)
  }
})

router.delete('/', requireSelfServiceIdentity, async (req, res, next) => {
  try {
    const result = await userOperations.clearAvatar({ requester: req.user, response: res })
    res.json({ message: 'Profile avatar removed successfully.', pictureUrl: result.pictureUrl })
  } catch (error) {
    if (!sendKnownError(error, res)) next(error)
  }
})

export const userAvatarPreBodyRouter = router
export default router

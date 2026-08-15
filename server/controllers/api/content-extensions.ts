import express from 'express'

import {
  listContentExtensions,
  setContentExtensionEnabled
} from '../../content-extensions/operations.ts'
import { getWikiAuth } from '../_types.ts'

const router = express.Router()

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listContentExtensions())
  } catch (error) {
    next(error)
  }
})

router.patch('/:key', async (req, res, next) => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return
  }
  if (
    typeof req.body !== 'object' ||
    req.body === null ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length !== 1 ||
    typeof req.body.isEnabled !== 'boolean'
  ) {
    res.status(400).json({ error: 'Request body must contain only an isEnabled boolean.' })
    return
  }

  try {
    const updatedBy = typeof req.user?.id === 'number' ? req.user.id : null
    res.json(await setContentExtensionEnabled(req.params.key, req.body.isEnabled, updatedBy))
  } catch (error) {
    next(error)
  }
})

export default router

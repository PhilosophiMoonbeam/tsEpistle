import { parseContentExtensionEnvelope } from '../../../shared/content-extensions.ts'

import express from 'express'

import {
  listContentExtensions,
  setContentExtensionEnabled
} from '../../content-extensions/operations.ts'
import pageOperations from '../../operations/pages.ts'
import { getWikiAuth } from '../_types.ts'

const router = express.Router()

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listContentExtensions())
  } catch (error) {
    next(error)
  }
})

const queryString = (value: unknown, fallback?: string): string | undefined => {
  if (typeof value === 'string') return value
  return fallback
}

const queryInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback
  return Number(value)
}

router.get('/index', async (req, res, next) => {
  try {
    const status = await listContentExtensions()
    const indexStatus = status.extensions.find(extension => extension.key === 'index')
    if (!indexStatus?.isEnabled || !indexStatus.compatible) {
      res.status(404).json({ error: 'Page index extension is unavailable.' })
      return
    }
    const envelope = parseContentExtensionEnvelope({
      key: 'index',
      version: 1,
      props: {
        path: queryString(req.query.path, ''),
        locale: queryString(req.query.locale),
        depth: queryInteger(req.query.depth, 0),
        order: queryString(req.query.order, 'path'),
        limit: queryInteger(req.query.limit, 50)
      }
    })
    if (envelope.key !== 'index') throw new TypeError('Page index query parsed as another extension type.')
    const items = await pageOperations.listIndex({
      ...(req.user === undefined ? {} : { requester: req.user }),
      path: envelope.props.path,
      locale: envelope.props.locale,
      depth: envelope.props.depth ?? 0,
      order: envelope.props.order ?? 'path',
      limit: envelope.props.limit ?? 50
    })
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Vary', 'Cookie')
    res.json({ items })
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

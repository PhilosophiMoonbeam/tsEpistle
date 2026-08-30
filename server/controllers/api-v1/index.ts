import express from 'express'
import type { ErrorRequestHandler, RequestHandler } from 'express'
import { errorStatus, getTransportRuntime } from '../_types.ts'

import pagesRouter from './pages.ts'
import { openApiDocument } from './openapi.ts'

interface ApiV1Runtime {
  logger: { error(value: unknown): void }
}

const router = express.Router()

router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument)
})

const requireApiKey: RequestHandler = (req, res, next) => {
  if (req.authContext?.kind !== 'apiKey') {
    return res.status(401).json({ error: 'API key authentication required' })
  }
  return next()
}

router.use(requireApiKey)
router.use('/pages', pagesRouter)

router.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  void _req
  void _next
  const candidateStatus = errorStatus(err)
  const status = candidateStatus !== undefined && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500
  if (status >= 500) getTransportRuntime<ApiV1Runtime>().logger.error(err)
  const errorMessage = err instanceof Error ? err.message : String(err)
  const message = status >= 500 ? 'Internal Server Error' : errorMessage || 'Request Failed'
  res.status(status).json({ error: message })
}

router.use(errorHandler)

export default router

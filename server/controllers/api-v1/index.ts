import express from 'express'

import pagesRouter from './pages.ts'
import { openApiDocument } from './openapi.ts'

const router = express.Router()

router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument)
})
router.use('/pages', pagesRouter)

export default router

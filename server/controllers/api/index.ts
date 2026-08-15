import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { errorStatus } from '../_types.ts'
import analyticsRouter from './analytics.ts'
import assetsRouter from './assets.ts'
import authRouter from './auth.ts'
import commentsRouter from './comments.ts'
import contributeRouter from './contribute.ts'
import contentExtensionsRouter from './content-extensions.ts'
import groupsRouter from './groups.ts'
import localesRouter from './locales.ts'
import loggingRouter from './logging.ts'
import mailRouter from './mail.ts'
import navigationRouter from './navigation.ts'
import pagesRouter from './pages.ts'
import renderingRouter from './rendering.ts'
import searchRouter from './search.ts'
import siteRouter from './site.ts'
import storageRouter from './storage.ts'
import systemRouter from './system.ts'
import themingRouter from './theming.ts'
import usersRouter from './users.ts'
import webhooksRouter from './webhooks.ts'

const router = express.Router()

router.use('/assets', assetsRouter)
router.use('/system', systemRouter)
router.use('/analytics', analyticsRouter)
router.use('/search', searchRouter)
router.use('/theming', themingRouter)
router.use('/logging', loggingRouter)
router.use('/navigation', navigationRouter)
router.use('/mail', mailRouter)
router.use('/storage', storageRouter)
router.use('/site', siteRouter)
router.use('/rendering', renderingRouter)
router.use('/comments', commentsRouter)
router.use('/contribute', contributeRouter)
router.use('/content-extensions', contentExtensionsRouter)
router.use('/locales', localesRouter)
router.use('/groups', groupsRouter)
router.use('/users', usersRouter)
router.use('/pages', pagesRouter)
router.use('/auth', authRouter)
router.use('/webhooks', webhooksRouter)

router.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  void _req
  void _next
  const status = errorStatus(err) ?? 500
  if (status >= 500) (WIKI.logger as { error(value: unknown): void }).error(err)
  const errorMessage = err instanceof Error ? err.message : String(err)
  const message = status >= 500 ? 'Internal Server Error' : (errorMessage || 'Request Failed')
  res.status(status).json({ error: message })
}

router.use(errorHandler)

export default router

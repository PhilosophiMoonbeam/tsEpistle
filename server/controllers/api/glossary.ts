import express from 'express'
import type { Request, Response } from '../_types.ts'
import { glossaryOperations } from '../../operations/glossary.ts'
import errors from '../../operations/errors.ts'

const router = express.Router()
const context = (req: Request) => ({ requester: req.user, sessionId: req.sessionID ?? '' })
const id = (value: unknown): number => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN)
const fail = (res: Response, error: unknown): void => {
  // Only the application's own failures are public. Database/driver messages can contain private values.
  if (error instanceof errors.ApplicationError && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ error: error.message, code: error.name })
    return
  }
  res.status(500).json({ error: 'Glossary request failed.', code: 'GLOSSARY_REQUEST_FAILED' })
}
router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})
router.get('/access', async (req, res) => {
  try {
    res.json(await glossaryOperations().access(context(req), req.query.locale))
  } catch (error) {
    fail(res, error)
  }
})
router.get('/', async (req, res) => {
  try {
    res.json(await glossaryOperations().list(context(req), req.query))
  } catch (error) {
    fail(res, error)
  }
})
router.get('/lookup', async (req, res) => {
  try {
    res.json(await glossaryOperations().lookup(context(req), req.query.locale, req.query.name))
  } catch (error) {
    fail(res, error)
  }
})
router.get('/autolink', async (req, res) => {
  try {
    res.json(await glossaryOperations().autolink(context(req), req.query))
  } catch (error) {
    fail(res, error)
  }
})
router.get('/terms/:id', async (req, res) => {
  try {
    res.json(await glossaryOperations().get(context(req), id(req.params.id)))
  } catch (error) {
    fail(res, error)
  }
})
router.post('/terms', async (req, res) => {
  try {
    res.status(201).json(await glossaryOperations().create(context(req), req.body))
  } catch (error) {
    fail(res, error)
  }
})
router.put('/terms/:id', async (req, res) => {
  try {
    res.json(await glossaryOperations().update(context(req), id(req.params.id), req.body))
  } catch (error) {
    fail(res, error)
  }
})
router.delete('/terms/:id', async (req, res) => {
  try {
    res.json(await glossaryOperations().remove(context(req), id(req.params.id), req.body?.expectedRevision))
  } catch (error) {
    fail(res, error)
  }
})

export default router

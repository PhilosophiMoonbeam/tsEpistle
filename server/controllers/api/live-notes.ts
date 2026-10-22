import express from 'express'
import { agentCsrfMatches } from '../../agents/csrf.ts'
import { requestOriginMatches } from '../../agents/origins.ts'
import { liveNotes } from '../../operations/live-notes.ts'
import errors from '../../operations/errors.ts'
import { liveNoteExactKeys, isLiveNoteRevision } from '../../../shared/live-notes.ts'
import { getTransportRuntime, type Request, type Response, type NextFunction } from '../_types.ts'

interface LiveNoteBrowserRuntime {
  config: { host: string }
  logger?: { warn(error: unknown): void }
}
const router = express.Router()
const { ApplicationError } = errors
export const liveNotePrivacyHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.set('Cache-Control', 'private, no-store')
  res.vary('Cookie')
  next()
}
router.use(liveNotePrivacyHeaders)
router.use((req, res, next) => {
  const context = req.authContext
  const browser = context?.kind === 'guest' ? req.user?.id === 2 : context?.kind === 'user' && req.user?.id === context.userId
  if (!browser) return res.status(401).json({ error: 'A current browser session is required.', code: 'AUTH_REQUIRED' })
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const host = getTransportRuntime<LiveNoteBrowserRuntime>().config.host
    if (
      !host ||
      !req.session ||
      req.get('sec-fetch-site') !== 'same-origin' ||
      !requestOriginMatches(req.get('origin'), host) ||
      !agentCsrfMatches(req, req.get('x-wiki-csrf'))
    )
      return res.status(403).json({ error: 'A same-origin request with a current CSRF token is required.', code: 'NOTE_ORIGIN_REQUIRED' })
  }
  return next()
})
const respond =
  (operation: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(status).json(await operation(req))
    } catch (error) {
      if (error instanceof ApplicationError) res.status(error.status).json({ error: error.message, code: error.name })
      else {
        getTransportRuntime<LiveNoteBrowserRuntime>().logger?.warn(error)
        res.status(500).json({ error: 'The live note request failed.', code: 'NOTE_REQUEST_FAILED' })
      }
    }
  }
const targetRevision = (req: Request): number => {
  const value = String(req.params.revision)
  const revision = /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : NaN
  if (!isLiveNoteRevision(revision)) throw new ApplicationError('Live note revision is invalid.', { code: 'INVALID_INPUT' })
  return revision
}
router.get(
  '/',
  respond(req => liveNotes.list(req.user, req.query))
)
router.post(
  '/',
  respond(req => liveNotes.create(req.user, req.body), 201)
)
router.get(
  '/:key',
  respond(req => liveNotes.read(req.user, String(req.params.key)))
)
router.patch(
  '/:key',
  respond(req => liveNotes.updateAccess(req.user, String(req.params.key), req.body))
)
router.delete(
  '/:key',
  respond(req => liveNotes.remove(req.user, String(req.params.key), req.body))
)
router.get(
  '/:key/revisions',
  respond(req => liveNotes.history(req.user, String(req.params.key), req.query))
)
router.get(
  '/:key/revisions/:revision',
  respond(req => liveNotes.revision(req.user, String(req.params.key), targetRevision(req)))
)
router.post(
  '/:key/revisions/:revision/restore',
  respond(req => liveNotes.restore(req.user, String(req.params.key), targetRevision(req), req.body))
)
router.post(
  '/:key/session',
  respond(req => {
    if (!liveNoteExactKeys(req.body, [])) throw new ApplicationError('Live note session input is invalid.', { code: 'INVALID_INPUT' })
    return liveNotes.session(req.user, String(req.params.key))
  })
)
router.post(
  '/:key/updates',
  respond(req => liveNotes.applyUpdate(req.user, String(req.params.key), req.body))
)
export default router

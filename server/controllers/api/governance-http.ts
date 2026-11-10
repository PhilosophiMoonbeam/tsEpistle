import type { ErrorRequestHandler, RequestHandler } from 'express'
import { z } from 'zod'
import { agentCsrfMatches } from '../../agents/csrf.ts'
import { requestOriginMatches } from '../../agents/origins.ts'
import { isApiPrincipal } from '../../helpers/api-principal.ts'
import errors from '../../operations/errors.ts'
import { getTransportRuntime, type Request, type Response } from '../_types.ts'

export const governancePrivacyHeaders: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  res.vary('Cookie')
  next()
}

const governanceSourcePath = /^\/_api\/(?:page-feedback|page-lifecycle|hedgedoc-import|governed-notifications)(?:\/|\?|$)|^\/_api\/pages\/[1-9][0-9]*\/(?:review-routing|edit-lock)(?:\/|\?|$)|^\/_api\/pages\/?(?:\?|$)|^\/_api\/pages\/[1-9][0-9]*\/move(?:\/review)?\/?(?:\?|$)/u
export const governancePreBodyPrivacy: RequestHandler = (req, res, next) => {
  if (governanceSourcePath.test(req.originalUrl)) governancePrivacyHeaders(req, res, next)
  else next()
}
/** body-parser errors carry original source bytes; never reflect or log those bytes. */
export const governanceBodyParserError: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (!governanceSourcePath.test(req.originalUrl) || typeof error !== 'object' || error === null) { next(error); return }
  const type = Reflect.get(error, 'type')
  if (type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON request body.', code: 'INVALID_INPUT' }); return }
  if (type === 'entity.too.large') { res.status(413).json({ error: 'Request body exceeds the allowed size.', code: 'INPUT_TOO_LARGE' }); return }
  next(error)
}

/** Browser identity is an admission boundary, never a replacement for operation authority. */
export const requireGovernanceBrowser = (req: Request, res: Response, allowGuestReads = false): boolean => {
  const context = req.authContext
  const read = req.method === 'GET' || req.method === 'HEAD'
  const browser = context?.kind === 'user' && req.user?.id === context.userId && req.user.id !== 2 ||
    allowGuestReads && read && context?.kind === 'guest' && req.user?.id === 2
  if (!browser || isApiPrincipal(req.user) || !req.session || !req.sessionID) {
    res.status(401).json({ error: 'A current browser session is required.', code: 'AUTH_REQUIRED' })
    return false
  }
  const owner = req.get('x-wiki-governance-owner')
  if (owner !== undefined && (context?.kind === 'guest' ? owner !== 'anonymous' : !Number.isSafeInteger(req.user?.authVersion) || owner !== `${req.user?.id}:${req.user?.authVersion}`)) {
    res.status(409).json({ error: 'The current account changed. Reload before continuing.', code: 'GOVERNANCE_OWNER_CHANGED' })
    return false
  }
  if (!read) {
    const host = getTransportRuntime<{ config: { host: string } }>().config.host
    if (!host || req.get('sec-fetch-site') !== 'same-origin' || !requestOriginMatches(req.get('origin'), host) || !agentCsrfMatches(req, req.get('x-wiki-csrf'))) {
      res.status(403).json({ error: 'A same-origin request with a current CSRF token is required.', code: 'ORIGIN_REQUIRED' })
      return false
    }
  }
  return true
}
export const governanceBrowserBoundary = (allowGuestReads = false): RequestHandler => (req, res, next) => {
  if (requireGovernanceBrowser(req, res, allowGuestReads)) next()
}

export const governanceInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new errors.ApplicationError('Invalid request input.', { code: 'INVALID_INPUT', status: 400 })
  return parsed.data
}
export const governanceUuid = (value: unknown): string => governanceInput(z.uuid(), value)
export const governanceEmpty = (value: unknown): Record<string, never> => governanceInput(z.strictObject({}), value)

export const governanceResponse = (operation: (req: Request) => Promise<unknown>, status = 200): RequestHandler => async (req, res, next) => {
  try {
    res.status(status).json(await operation(req))
  } catch (error) {
    if (error instanceof errors.ApplicationError && error.status < 500) {
      const retry = Reflect.get(error, 'retryAfterMilliseconds')
      if (error.status === 429 && typeof retry === 'number' && Number.isFinite(retry) && retry > 0) res.set('Retry-After', String(Math.ceil(retry / 1000)))
      res.status(error.status).json({ error: error.message, code: error.name, ...(error.status === 429 && typeof retry === 'number' ? { retryAfterMilliseconds: retry } : {}) })
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request input.', code: 'INVALID_INPUT' })
    } else next(error)
  }
}

export const governanceContext = (req: Request) => ({ requester: req.user, sessionId: req.sessionID, ...(req.ip === undefined ? {} : { ip: req.ip }) })

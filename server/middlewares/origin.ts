import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { apiAccessContract, isApiKeyTransportPath, isExternalRestPath, isInternalRestPath } from '../../shared/api-access.ts'
import { requestOriginMatches } from '../agents/origins.ts'
import { hasFederatedCallbackCorrelation, isFederatedCallbackPath } from '../helpers/federated-login.ts'

const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true }

const isProviderCallback = (req: Request): boolean => isFederatedCallbackPath(req.path)
const isCorrelatedProviderCallback = (req: Request): boolean => isProviderCallback(req) && hasFederatedCallbackCorrelation(req)
const isPageUnlock = (path: string): boolean => path === '/_unlock' || path.startsWith('/_unlock/')

const apiKeyPrincipal = (req: Request): boolean => {
  const context = (req as Request & { authContext?: { kind?: unknown } }).authContext
  return context?.kind === 'apiKey' && (isApiKeyTransportPath(req.path) || req.path === apiAccessContract.mcpPath)
}
const requiresExactOrigin = (req: Request): boolean => {
  if (isCorrelatedProviderCallback(req)) return false
  if (isProviderCallback(req)) return true
  if (SAFE_METHODS[req.method] === true) return false
  if (req.path === '/logout') return true
  if (req.path === apiAccessContract.graphqlPath) return true
  return isInternalRestPath(req.path) || isExternalRestPath(req.path) || req.path === '/u' || isPageUnlock(req.path)
}

export const createOriginMiddleware = (expectedOrigin: () => string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!requiresExactOrigin(req) || apiKeyPrincipal(req) || requestOriginMatches(req.get('origin'), expectedOrigin())) {
      next()
      return
    }
    res.status(403).json({ error: 'A same-origin request is required.' })
  }
}

export default createOriginMiddleware

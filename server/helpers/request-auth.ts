import type { Request } from 'express'
import type { RequestAuthContext } from '../../shared/agents/contracts.ts'

export class RequestAuthenticationError extends Error {
  readonly status = 401
  readonly code = 'AUTHENTICATION_REQUIRED'
}

export const getRequestAuthContext = (req: Request): RequestAuthContext<Express.User> => {
  if (!req.authContext) throw new RequestAuthenticationError('A validated request authentication context is required')
  return req.authContext
}

export const getAuthenticatedUserContext = (req: Request): Extract<RequestAuthContext<Express.User>, { kind: 'user' }> => {
  const context = getRequestAuthContext(req)
  if (context.kind !== 'user') throw new RequestAuthenticationError('An authenticated user session is required')
  return context
}

export const getApiKeyContext = (req: Request): Extract<RequestAuthContext<Express.User>, { kind: 'apiKey' }> => {
  const context = getRequestAuthContext(req)
  if (context.kind !== 'apiKey') throw new RequestAuthenticationError('A validated API key is required')
  return context
}

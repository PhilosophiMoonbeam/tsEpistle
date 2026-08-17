import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

interface LaunchSessionState {
  agentLaunchCsrfToken?: string
}

export const agentLaunchCsrfToken = (req: Request): string => {
  const session = req.session as typeof req.session & LaunchSessionState
  if (!session.agentLaunchCsrfToken) session.agentLaunchCsrfToken = randomBytes(32).toString('base64url')
  return session.agentLaunchCsrfToken
}

export const agentLaunchCsrfMatches = (req: Request, received: unknown): boolean => {
  if (typeof received !== 'string') return false
  const expected = Buffer.from(agentLaunchCsrfToken(req))
  const candidate = Buffer.from(received)
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

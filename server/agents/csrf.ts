import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

interface AgentSessionState {
  agentCsrfToken?: string
}

export const agentCsrfToken = (req: Request): string => {
  const session = req.session as typeof req.session & AgentSessionState
  if (!session.agentCsrfToken) session.agentCsrfToken = randomBytes(32).toString('base64url')
  return session.agentCsrfToken
}

export const agentCsrfMatches = (req: Request, received: unknown): boolean => {
  if (typeof received !== 'string') return false
  const expected = Buffer.from(agentCsrfToken(req))
  const candidate = Buffer.from(received)
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

import express, { type RequestHandler } from 'express'
import type { Knex } from 'knex'
import { z } from 'zod'
import { issueAgentLaunchHandoff } from '../../agents/repository.ts'
import { agentLaunchCsrfMatches } from '../../agents/launch-csrf.ts'
import { getTransportRuntime } from '../_types.ts'

interface AgentLaunchRuntime {
  readonly config: {
    readonly host: string
    readonly agents: {
      readonly enabled: boolean
      readonly publicOrigin: string
      readonly launchTokenTtlSeconds: number
    }
  }
  readonly models: { readonly knex: Knex }
}

const PageHintSchema = z.strictObject({
  id: z.coerce.number().int().positive(),
  locale: z.string().min(1).max(16),
  path: z.string().min(1).max(1_024),
  observedUpdatedAt: z.iso.datetime()
})
const LaunchSchema = z.strictObject({
  csrfToken: z.string().optional(),
  page: PageHintSchema.nullable().optional(),
  pageId: z.coerce.number().int().positive().optional(),
  pageLocale: z.string().min(1).max(16).optional(),
  pagePath: z.string().min(1).max(1_024).optional(),
  pageUpdatedAt: z.iso.datetime().optional()
}).transform(input => {
  if (input.page) return { csrfToken: input.csrfToken, page: input.page }
  const flat = [input.pageId, input.pageLocale, input.pagePath, input.pageUpdatedAt]
  if (flat.every(value => value === undefined)) return { csrfToken: input.csrfToken, page: null }
  return { csrfToken: input.csrfToken, page: PageHintSchema.parse({ id: input.pageId, locale: input.pageLocale, path: input.pagePath, observedUpdatedAt: input.pageUpdatedAt }) }
})

export const createAgentLaunchRouter = (getRuntime: () => AgentLaunchRuntime): express.Router => {
  const router = express.Router()

  router.post('/launch', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res, next) => {
    try {
      const wiki = getRuntime()
      if (!wiki.config.agents.enabled || !wiki.config.agents.publicOrigin) return res.sendStatus(404)
      if (!req.authContext || req.authContext.kind !== 'user') return res.sendStatus(401)
      if (!req.user?.permissions?.some(permission => permission === 'use:agents' || permission === 'manage:system')) return res.sendStatus(403)
      const requestOrigin = req.get('origin')
      if (!requestOrigin || new URL(requestOrigin).origin !== new URL(wiki.config.host).origin || req.get('sec-fetch-site') !== 'same-origin') return res.sendStatus(403)
      const input = LaunchSchema.parse(req.body)
      if (!agentLaunchCsrfMatches(req, input.csrfToken)) return res.sendStatus(403)
      const page = input.page
      if (page) {
        const pageOperations = (await import('../../operations/pages.ts')).default
        const authorized = await pageOperations.get({ id: page.id, requester: req.user })
        const authorizedLocale = String(Reflect.get(authorized, 'locale'))
        const authorizedPath = String(Reflect.get(authorized, 'path'))
        const authorizedUpdatedAtValue = Reflect.get(authorized, 'updatedAt')
        const authorizedUpdatedAt = authorizedUpdatedAtValue instanceof Date ? authorizedUpdatedAtValue.toISOString() : String(authorizedUpdatedAtValue)
        if (authorizedLocale !== page.locale || authorizedPath !== page.path || authorizedUpdatedAt !== page.observedUpdatedAt) return res.sendStatus(409)
      }
      const handoff = await issueAgentLaunchHandoff(wiki.models.knex, {
        ownerId: req.authContext.userId,
        pageId: page?.id ?? null,
        locale: page?.locale ?? null,
        path: page?.path ?? null,
        observedUpdatedAt: page?.observedUpdatedAt ?? null,
        ttlSeconds: wiki.config.agents.launchTokenTtlSeconds
      })
      const url = `${wiki.config.agents.publicOrigin}/?handoff=${encodeURIComponent(handoff.token)}`
      if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, url)
      return res.status(201).json({ url, expiresAt: handoff.expiresAt })
    } catch (error) {
      return next(error)
    }
  })

  return router
}

let defaultRouter: express.Router | undefined
const agentLaunchHandler: RequestHandler = (req, res, next) => {
  defaultRouter ??= createAgentLaunchRouter(() => getTransportRuntime<AgentLaunchRuntime>())
  return defaultRouter(req, res, next)
}

export default agentLaunchHandler

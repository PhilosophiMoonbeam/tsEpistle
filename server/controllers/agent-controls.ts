import express, { type Request, type Response, type NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { DecisionProviderWriteSchema } from '../../shared/agents/decision-providers.ts'
import {
  CreateAdminExternalMcpServerSchema,
  ExternalMcpServerInputSchema,
  ExternalMcpGroupPolicyInputSchema,
  ExternalMcpGrantsInputSchema
} from '../../shared/agents/external-mcp.ts'
import type { DecisionProviderRegistry } from '../agents/decision-providers.ts'
import type { ExternalMcpService } from '../agents/external-mcp.ts'
import { AgentRepositoryError } from '../agents/repository.ts'
import type { AgentRoutingPolicyRegistry } from '../agents/routing.ts'
import { RoutingPolicyInputSchema, RoutingModelPolicyInputSchema } from '../../shared/agents/routing.ts'

export interface AgentControlServices {
  readonly decisionProviders?: DecisionProviderRegistry
  readonly externalMcp?: ExternalMcpService
  readonly routingPolicies?: AgentRoutingPolicyRegistry
}
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const InitialRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const RevisionBodySchema = z.strictObject({ expectedRevision: RevisionSchema })
const actor = (req: Request) => {
  if (!req.user || req.authContext?.kind !== 'user' || req.user.id !== req.authContext.userId)
    throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Authenticated user is required', 401)
  const version: unknown = Reflect.get(req.user, 'authVersion')
  if (version !== undefined && !z.number().int().nonnegative().safeParse(version).success)
    throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Current account session is required', 401)
  return { id: req.authContext.userId, ...(typeof version === 'number' ? { authVersion: version } : {}) }
}
const id = (req: Request) => z.uuid().parse(req.params.id)
const required = <T>(service: T | undefined): T => {
  if (!service) throw new AgentRepositoryError('AGENT_CONTROLS_UNAVAILABLE', 'Agent controls require an enabled provider runtime', 409)
  return service
}
/** Mounted only after the host's session, use:agents, same-origin and CSRF boundary. */
export default function createAgentControls(services: AgentControlServices): express.Router {
  const router = express.Router()
  router.use('/admin', (req, res, next) => (req.user?.permissions?.includes('manage:system') ? next() : res.sendStatus(403)))
  const route =
    (handler: (req: Request, res: Response, signal: AbortSignal) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (req.aborted || res.destroyed) abort()
      req.once('aborted', abort)
      res.once('close', abort)
      handler(req, res, controller.signal)
        .catch(next)
        .finally(() => {
          req.off('aborted', abort)
          res.off('close', abort)
        })
    }
  router.get(
    '/admin/decision-providers',
    route(async (req, res) => res.json({ providers: await required(services.decisionProviders).list(actor(req)) }))
  )
  router.post(
    '/admin/decision-providers',
    route(async (req, res) =>
      res.status(201).json({ provider: await required(services.decisionProviders).create(DecisionProviderWriteSchema.parse(req.body), actor(req)) })
    )
  )
  router.put(
    '/admin/decision-providers/:id',
    route(async (req, res) => {
      const { expectedRevision, ...input } = DecisionProviderWriteSchema.extend({ expectedRevision: RevisionSchema }).parse(req.body)
      return res.json({ provider: await required(services.decisionProviders).update(id(req), input, expectedRevision, actor(req)) })
    })
  )
  router.delete(
    '/admin/decision-providers/:id',
    route(async (req, res) => {
      await required(services.decisionProviders).remove(id(req), RevisionBodySchema.parse(req.body).expectedRevision, actor(req))
      return res.json({ deleted: true })
    })
  )
  router.post(
    '/admin/decision-providers/:id/enabled',
    route(async (req, res) => {
      const input = RevisionBodySchema.extend({ enabled: z.boolean() }).parse(req.body)
      return res.json({ provider: await required(services.decisionProviders).setEnabled(id(req), input.enabled, input.expectedRevision, actor(req)) })
    })
  )
  router.post(
    '/admin/decision-providers/:id/default',
    route(async (req, res) =>
      res.json({ provider: await required(services.decisionProviders).setDefault(id(req), RevisionBodySchema.parse(req.body).expectedRevision, actor(req)) })
    )
  )
  router.post(
    '/admin/decision-providers/:id/check',
    route(async (req, res, signal) =>
      res.json({
        check: await required(services.decisionProviders).check(id(req), RevisionBodySchema.parse(req.body).expectedRevision, actor(req), { signal })
      })
    )
  )
  router.get(
    '/admin/external-mcp/group-policies',
    route(async (req, res) => res.json({ policies: await required(services.externalMcp).groupPolicies(actor(req)) }))
  )
  router.put(
    '/admin/external-mcp/group-policies/:groupId',
    route(async (req, res) => {
      const { expectedRevision, ...input } = ExternalMcpGroupPolicyInputSchema.extend({ expectedRevision: InitialRevisionSchema }).parse(req.body)
      const groupId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(req.params.groupId)
      return res.json({ policy: await required(services.externalMcp).setGroupPolicy(actor(req), groupId, input, expectedRevision) })
    })
  )
  router.get(
    '/admin/external-mcp',
    route(async (req, res) => res.json({ servers: await required(services.externalMcp).listAdmin(actor(req)) }))
  )
  router.post(
    '/admin/external-mcp',
    route(async (req, res) =>
      res.status(201).json({ server: await required(services.externalMcp).createAdmin(actor(req), CreateAdminExternalMcpServerSchema.parse(req.body)) })
    )
  )
  router.put(
    '/admin/external-mcp/:id/grants',
    route(async (req, res) => {
      const { expectedRevision, ...input } = ExternalMcpGrantsInputSchema.extend({ expectedRevision: RevisionSchema }).parse(req.body)
      return res.json({ server: await required(services.externalMcp).setAdminGrants(actor(req), id(req), expectedRevision, input) })
    })
  )
  for (const scope of ['admin', 'personal'] as const) {
    const path = scope === 'admin' ? '/admin/external-mcp/:id' : '/personal-mcp/:id'
    router.put(
      path,
      route(async (req, res) => {
        const { expectedRevision, ...input } = ExternalMcpServerInputSchema.extend({ expectedRevision: RevisionSchema }).parse(req.body)
        const service = required(services.externalMcp)
        const server =
          scope === 'admin'
            ? await service.updateAdmin(actor(req), id(req), expectedRevision, input)
            : await service.updatePersonal(actor(req), id(req), expectedRevision, input)
        return res.json({ server })
      })
    )
    router.delete(
      path,
      route(async (req, res) => {
        const revision = RevisionBodySchema.parse(req.body).expectedRevision
        const service = required(services.externalMcp)
        if (scope === 'admin') await service.deleteAdmin(actor(req), id(req), revision)
        else await service.deletePersonal(actor(req), id(req), revision)
        return res.json({ deleted: true })
      })
    )
  }
  router.get(
    '/personal-mcp',
    route(async (req, res) => res.json({ servers: await required(services.externalMcp).listPersonal(actor(req)) }))
  )
  router.post(
    '/personal-mcp',
    route(async (req, res) =>
      res.status(201).json({ server: await required(services.externalMcp).createPersonal(actor(req), ExternalMcpServerInputSchema.parse(req.body)) })
    )
  )
  router.get(
    '/external-mcp',
    route(async (req, res) => res.json({ servers: await required(services.externalMcp).listForUser(actor(req)) }))
  )
  router.post(
    '/external-mcp/:id/discover',
    route(async (req, res, signal) => {
      z.strictObject({}).parse(req.body ?? {})
      return res.json({ discovery: await required(services.externalMcp).discoverForUser(actor(req), id(req), { signal }) })
    })
  )
  router.get(
    '/admin/routing',
    route(async (req, res) => res.json(await required(services.routingPolicies).getAdmin(actor(req))))
  )
  router.put(
    '/admin/routing',
    route(async (req, res) => {
      const { expectedRevision, ...input } = RoutingPolicyInputSchema.extend({ expectedRevision: RevisionSchema }).parse(req.body)
      return res.json({ policy: await required(services.routingPolicies).updateAdmin(input, expectedRevision, actor(req)) })
    })
  )
  router.put(
    '/admin/routing/models/:id',
    route(async (req, res) => {
      const { expectedRevision, ...input } = RoutingModelPolicyInputSchema.safeExtend({ expectedRevision: InitialRevisionSchema }).parse(req.body)
      return res.json({ model: await required(services.routingPolicies).setModelPolicy(id(req), input, expectedRevision, actor(req)) })
    })
  )
  router.delete(
    '/admin/routing/models/:id',
    route(async (req, res) => {
      await required(services.routingPolicies).removeModelPolicy(id(req), RevisionBodySchema.parse(req.body).expectedRevision, actor(req))
      return res.json({ deleted: true })
    })
  )
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error)
    if (error instanceof ZodError) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Agent control request is invalid' })
    if (error instanceof AgentRepositoryError)
      return res.status(error.status).json({ error: error.code, message: error.status >= 500 ? 'Agent control request failed' : error.message })
    return res.status(500).json({ error: 'AGENT_CONTROL_FAILED', message: 'Agent control request failed' })
  })
  return router
}

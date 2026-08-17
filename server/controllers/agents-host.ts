import { createHash, createHmac } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { z, ZodError } from 'zod'

import { SkillValidationError } from '../agents/skills/parser.ts'
import { agentCsrfMatches } from '../agents/csrf.ts'
import { requestOriginMatches } from '../agents/origins.ts'
import { SkillRegistry } from '../agents/skills/registry.ts'
import { SkillRuntime, type SkillPrincipal } from '../agents/skills/runtime.ts'
import { requestAgentRunCancellation } from '../agents/coordinator.ts'
import { ACTION_CATALOG } from '../agents/actions/catalog.ts'
import { decideProposal } from '../agents/proposals/execution.ts'
import { BrowserTargetRegistry } from '../agents/browser/registry.ts'
import { getMcpProposalForApproval, type ProposalRecord } from '../agents/proposals/repository.ts'
import { requestAgentSessionDeletion } from '../agents/maintenance.ts'
import type { AgentOperationalLimits } from '../agents/config.ts'
import {
  CreateAgentProviderProfileSchema,
  UpdateAgentProviderProfileSchema,
  type AgentProviderRegistry
} from '../agents/providers/registry.ts'
import type { AgentProviderConformanceRunner } from '../agents/providers/conformance.ts'
import type { AgentProductRuntime } from '../agents/runtime.ts'
import { projectAgentRun, projectAgentThread } from '../agents/projection.ts'
import {
  AgentRepositoryError,
  createAgentSession,
  listOwnedAgentSessions,
  updateAgentSession
} from '../agents/repository.ts'
import { streamOwnedAgentEvents } from '../agents/sse.ts'


interface AgentHostWiki {
  readonly auth: {
    authenticate(req: Request, res: Response, next: NextFunction): void
  }
  readonly config: {
    readonly host?: string
    readonly sessionSecret: string
    readonly agents: {
      readonly enabled: boolean
      readonly provider: { readonly enabled: boolean; readonly globalConcurrency?: number; readonly perUserConcurrency?: number; readonly pollingMilliseconds?: number }
      readonly retention: { readonly temporarySessionHours: number; readonly mcpContentDays?: number; readonly auditDays?: number; readonly maintenanceBatchSize?: number }
      readonly skills: { readonly enabled: boolean; readonly namespace: string }
      readonly browser?: { readonly enabled: boolean }
      readonly mcp?: { readonly enabled: boolean }
      readonly proposals: { readonly enabled: boolean }
      readonly writes: {
        readonly enabled: boolean
        readonly create: { readonly enabled: boolean }
        readonly patch: { readonly enabled: boolean }
        readonly move: { readonly enabled: boolean }
        readonly restore: { readonly enabled: boolean }
        readonly delete: { readonly enabled: boolean }
      }
    }
  }
  readonly models: {
    readonly knex: Knex
  }
  readonly agentRuntime?: Pick<AgentProductRuntime, 'submit'>
  readonly providerRegistry?: Pick<AgentProviderRegistry, 'create' | 'getAdmin' | 'issueResolutionToken' | 'listAll' | 'listVisible' | 'remove' | 'setDefault' | 'setEnabled' | 'setGrants' | 'setSessionProfile' | 'update'>
  readonly providerConformance?: Pick<AgentProviderConformanceRunner, 'latest' | 'list' | 'run'>
  readonly agentLimits?: AgentOperationalLimits
}


const routeParameter = (req: Request, name: string): string | null => {
  const value = req.params[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const hasAgentPermission = (user: Express.User | undefined): boolean =>
  user?.permissions?.some(permission => permission === 'use:agents' || permission === 'manage:system') === true

const GroupIdsSchema = z.array(z.number().int().positive()).max(256)

const requestSkillPrincipal = (req: Request): SkillPrincipal => {
  if (!req.authContext || req.authContext.kind !== 'user') throw new SkillValidationError('Authenticated user is required')
  const groups = req.user ? Reflect.get(req.user, 'groups') : []
  const parsedGroups = GroupIdsSchema.safeParse(groups ?? [])
  if (!parsedGroups.success) throw new SkillValidationError('Authenticated user groups are invalid')
  return { userId: req.authContext.userId, groupIds: parsedGroups.data }
}
const requestUser = (req: Request): Express.User => {
  if (!req.user || !req.authContext || req.authContext.kind !== 'user' || req.user.id !== req.authContext.userId) {
    throw new SkillValidationError('Authenticated user is required')
  }
  return req.user
}


const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }

const providerAdminUnavailable = (): AgentRepositoryError =>
  new AgentRepositoryError('AGENT_PROVIDER_ADMIN_DISABLED', 'Provider administration is unavailable. Enable agents.provider.enabled, configure the provider runtime keys, and restart Wiki.', 409)

const CreateSessionSchema = z.strictObject({
  retention: z.enum(['temporary', 'saved']),
  executionMode: z.enum(['agent', 'generation-only']),
  providerProfileId: z.uuid().nullable()
})
const UpdateSessionSchema = z.strictObject({
  expectedSessionVersion: z.number().int().positive(),
  title: z.string().max(255).optional(),
  retention: z.enum(['temporary', 'saved']).optional()
}).refine(value => value.title !== undefined || value.retention !== undefined)
const SubmitMessageSchema = z.strictObject({
  clientRequestId: z.uuid(),
  expectedSessionVersion: z.number().int().positive(),
  profileResolutionToken: z.string().min(1).max(4_096),
  content: z.string().min(1).max(32_000),
  currentPage: z.strictObject({
    id: z.number().int().positive(),
    locale: z.string().min(1).max(16),
    path: z.string().min(1).max(1_024),
    observedUpdatedAt: z.iso.datetime()
  }).optional()
})
const UUIDSchema = z.uuid()
const DecisionSchema = z.strictObject({ decision: z.enum(['approved', 'denied']), decisionNote: z.string().max(4_000).optional(), confirmationPath: z.string().max(1_024).optional() })

const proposalActionEnabled = (config: AgentHostWiki['config']['agents'], actionName: keyof typeof ACTION_CATALOG): boolean => {
  if (!config.proposals.enabled || !config.writes.enabled) return false
  if (actionName === 'pages.prepareCreate') return config.writes.create.enabled
  if (actionName === 'pages.preparePatch') return config.writes.patch.enabled
  if (actionName === 'pages.prepareMove') return config.writes.move.enabled
  if (actionName === 'pages.prepareRestore') return config.writes.restore.enabled
  if (actionName === 'pages.prepareDelete') return config.writes.delete.enabled
  return false
}

const proposalInput = (proposal: ProposalRecord): Record<string, unknown> => {
  let value: unknown
  try {
    value = JSON.parse(proposal.input ?? 'null')
  } catch {
    throw new AgentRepositoryError('PROPOSAL_LEDGER_CORRUPT', 'Proposal input is invalid', 500)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRepositoryError('PROPOSAL_LEDGER_CORRUPT', 'Proposal input is invalid', 500)
  }
  return value as Record<string, unknown>
}

const authorizeProposalTarget = async (req: Request, proposal: ProposalRecord): Promise<void> => {
  if (proposal.pageId === null) return
  if (!req.user) throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Authenticated user is required', 401)
  const pageOperations = (await import('../operations/pages.ts')).default
  await pageOperations.get({ id: proposal.pageId, requester: req.user })
}


export default function createAgentsHostController(wiki: AgentHostWiki): express.Router {
  const router = express.Router()
  const skillRegistry = new SkillRegistry(wiki.models.knex, wiki.config.agents.skills.namespace)
  const skillRuntime = new SkillRuntime(wiki.models.knex)
  const browserTargets = new BrowserTargetRegistry(wiki.models.knex)
  const apiPrefix = '/_api/agents'


  const sseConnections = new Map<number, number>()
  const fallbackProfileResolutionToken = (session: { readonly id: string, readonly version: number, readonly providerProfileId: string | null, readonly executionMode: string }): string =>
    createHmac('sha256', wiki.config.sessionSecret)
      .update(JSON.stringify([session.id, session.version, session.providerProfileId, session.executionMode]))
      .digest('base64url')
  const projectSession = async (ownerId: number, sessionId: string) => {
    const issued = wiki.providerRegistry ? await wiki.providerRegistry.issueResolutionToken(ownerId, sessionId) : null
    return projectAgentThread(wiki.models.knex, ownerId, sessionId, { profileResolutionToken: session => issued ?? fallbackProfileResolutionToken(session) })
  }

  router.use(apiPrefix, wiki.auth.authenticate.bind(wiki.auth), (req, res, next) => {
    if (!req.authContext || req.authContext.kind !== 'user') return res.sendStatus(401)
    if (!hasAgentPermission(req.user)) return res.sendStatus(403)
    return next()
  })
  router.use(apiPrefix, express.json({ limit: '1mb', strict: true }))
  router.use(apiPrefix, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next()
    const expectedOrigin = wiki.config.host ?? `${req.protocol}://${req.get('host') ?? ''}`
    if (!requestOriginMatches(req.get('origin'), expectedOrigin) || req.get('sec-fetch-site') !== 'same-origin' || !agentCsrfMatches(req, req.get('x-wiki-csrf'))) return res.sendStatus(403)
    return next()
  })

  router.post(`${apiPrefix}/sessions`, asyncRoute(async (req, res) => {
    const input = CreateSessionSchema.parse(req.body)
    const ownerId = requestSkillPrincipal(req).userId
    const session = await createAgentSession(wiki.models.knex, {
      ownerId,
      retention: input.retention,
      providerProfileId: input.providerProfileId,
      executionMode: input.executionMode,
      expiresAt: input.retention === 'temporary' ? new Date(Date.now() + (wiki.agentLimits?.retention.temporarySessionHours ?? 24) * 3_600_000) : null
    })
    return res.status(201).json({ ...(await projectSession(ownerId, session.id)), launchPage: null })
  }))
  router.get(`${apiPrefix}/sessions`, asyncRoute(async (req, res) => {
    const ownerId = requestSkillPrincipal(req).userId
    const before = typeof req.query.before === 'string' ? z.iso.datetime().parse(req.query.before) : undefined
    const limit = typeof req.query.limit === 'string' ? z.coerce.number().int().min(1).max(100).parse(req.query.limit) : 50
    const sessions = await listOwnedAgentSessions(wiki.models.knex, ownerId, limit, before ? new Date(before) : undefined)
    return res.json({ sessions })
  }))
  router.post(`${apiPrefix}/sessions/:sessionId/messages`, asyncRoute(async (req, res) => {
    if (!wiki.config.agents.provider.enabled || !wiki.agentRuntime) return res.sendStatus(404)
    const sessionId = UUIDSchema.parse(routeParameter(req, 'sessionId'))
    const input = SubmitMessageSchema.parse(req.body)
    const admitted = await wiki.agentRuntime.submit({
      ownerId: requestSkillPrincipal(req).userId,
      sessionId,
      clientRequestId: input.clientRequestId,
      expectedSessionVersion: input.expectedSessionVersion,
      profileResolutionToken: input.profileResolutionToken,
      content: input.content,
      ...(input.currentPage === undefined ? {} : { currentPage: input.currentPage })
    })
    return res.status(202).json({ run: projectAgentRun(admitted.run), replayed: admitted.replayed })
  }))
  router.get(`${apiPrefix}/mcp-proposals/:proposalId`, asyncRoute(async (req, res) => {
    const proposalId = UUIDSchema.parse(routeParameter(req, 'proposalId'))
    const persisted = await getMcpProposalForApproval(wiki.models.knex, proposalId)
    await authorizeProposalTarget(req, persisted.proposal)
    const definition = ACTION_CATALOG[persisted.proposal.actionName]
    const permissions = req.user?.permissions ?? []
    if (!definition.descriptor.requiredPermissions.every(permission => permissions.includes(permission))) {
      throw new AgentRepositoryError('ACTION_PERMISSION_DENIED', 'Proposal approval permission is required', 403)
    }
    const input = proposalInput(persisted.proposal)
    return res.json({
      proposal: {
        id: persisted.proposal.id,
        actionName: persisted.proposal.actionName,
        risk: persisted.proposal.risk,
        status: persisted.proposal.status,
        summary: persisted.proposal.summary,
        pageId: persisted.proposal.pageId ?? null,
        path: typeof input.path === 'string'
          ? input.path
          : typeof input.destinationPath === 'string'
            ? input.destinationPath
            : typeof input.confirmationPath === 'string' ? input.confirmationPath : null,
        baseSourceRevision: persisted.proposal.baseSourceRevision === undefined ? null : String(persisted.proposal.baseSourceRevision),
        inputHash: persisted.proposal.inputHash,
        patchHash: persisted.proposal.patchSha256 ?? null,
        diffHash: persisted.proposal.diffSha256 ?? null,
        diff: persisted.proposal.contentPurgedAt === null ? persisted.proposal.diff ?? null : null,
        confirmationPath: persisted.proposal.risk === 'destructive-write' && typeof input.confirmationPath === 'string' ? input.confirmationPath : null,
        approval: {
          id: persisted.approval.id,
          status: persisted.approval.status,
          requestedAt: new Date(persisted.approval.requestedAt).toISOString(),
          expiresAt: new Date(persisted.approval.expiresAt).toISOString(),
          decidedAt: persisted.approval.decidedAt === null ? null : new Date(persisted.approval.decidedAt).toISOString()
        }
      }
    })
  }))
  router.post(`${apiPrefix}/proposals/:proposalId/approvals/:approvalId/decision`, asyncRoute(async (req, res) => {
    const proposalId = UUIDSchema.parse(routeParameter(req, 'proposalId'))
    const approvalId = UUIDSchema.parse(routeParameter(req, 'approvalId'))
    const input = DecisionSchema.parse(req.body)
    const userId = requestSkillPrincipal(req).userId
    const result = await decideProposal(wiki.models.knex, {
      proposalId,
      approvalId,
      userId,
      decision: input.decision,
      ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
      authorize: async ({ proposal }) => {
        await authorizeProposalTarget(req, proposal)
        const definition = ACTION_CATALOG[proposal.actionName]
        if (proposal.risk === 'destructive-write' && input.decision === 'approved') {
          const inputValue = proposalInput(proposal)
          const requiredPath = inputValue.confirmationPath
          if (typeof requiredPath !== 'string' || input.confirmationPath !== requiredPath) throw new AgentRepositoryError('DESTRUCTIVE_CONFIRMATION_REQUIRED', 'Exact page path confirmation is required', 409)
        }
        if (!proposalActionEnabled(wiki.config.agents, proposal.actionName)) throw new AgentRepositoryError('ACTION_DISABLED', 'Proposal action is disabled', 403)
        const permissions = req.user?.permissions ?? []
        if (!definition.descriptor.requiredPermissions.every(permission => permissions.includes(permission))) {
          throw new AgentRepositoryError('ACTION_PERMISSION_DENIED', 'Proposal approval permission was revoked', 403)
        }
      }
    })
    return res.json({ proposalId: result.proposal.id, approvalId: result.approval.id, status: result.approval.status, decidedAt: result.approval.decidedAt })
  }))
  router.get(`${apiPrefix}/profiles`, asyncRoute(async (req, res) => {
    if (!wiki.config.agents.provider.enabled || !wiki.providerRegistry) return res.json({ profiles: [] })
    return res.json({ profiles: await wiki.providerRegistry.listVisible(requestSkillPrincipal(req).userId) })
  }))
  router.put(`${apiPrefix}/sessions/:sessionId/profile`, asyncRoute(async (req, res) => {
    if (!wiki.config.agents.provider.enabled || !wiki.providerRegistry) return res.sendStatus(404)
    const sessionId = UUIDSchema.parse(routeParameter(req, 'sessionId'))
    const input = z.strictObject({ expectedSessionVersion: z.number().int().positive(), profileId: z.uuid().nullable(), executionMode: z.enum(['agent', 'generation-only']) }).parse(req.body)
    const ownerId = requestSkillPrincipal(req).userId
    await wiki.providerRegistry.setSessionProfile({ ownerId, sessionId, ...input })
    return res.json(await projectSession(ownerId, sessionId))
  }))
  router.get(`${apiPrefix}/sessions/:sessionId`, asyncRoute(async (req, res) => {
    const sessionId = UUIDSchema.parse(routeParameter(req, 'sessionId'))
    return res.json(await projectSession(requestSkillPrincipal(req).userId, sessionId))
  }))
  router.patch(`${apiPrefix}/sessions/:sessionId`, asyncRoute(async (req, res) => {
    const sessionId = UUIDSchema.parse(routeParameter(req, 'sessionId'))
    const input = UpdateSessionSchema.parse(req.body)
    const ownerId = requestSkillPrincipal(req).userId
    await updateAgentSession(wiki.models.knex, {
      ownerId,
      sessionId,
      expectedVersion: input.expectedSessionVersion,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.retention === undefined
        ? {}
        : {
            retention: input.retention,
            expiresAt: input.retention === 'temporary' ? new Date(Date.now() + (wiki.agentLimits?.retention.temporarySessionHours ?? 24) * 3_600_000) : null
          })
    })
    return res.json(await projectSession(ownerId, sessionId))
  }))
  router.delete(`${apiPrefix}/sessions/:sessionId`, asyncRoute(async (req, res) => {
    const sessionId = UUIDSchema.parse(routeParameter(req, 'sessionId'))
    await requestAgentSessionDeletion(wiki.models.knex, requestSkillPrincipal(req).userId, sessionId)
    return res.sendStatus(204)
  }))
  router.get(`${apiPrefix}/runs/:runId`, asyncRoute(async (req, res) => {
    const runId = UUIDSchema.parse(routeParameter(req, 'runId'))
    const ownerId = requestSkillPrincipal(req).userId
    const run = await wiki.models.knex('agentRuns').where({ id: runId, ownerId }).first('id', 'sessionId', 'status', 'attempts', 'eventSequence', 'queuedAt', 'startedAt', 'completedAt', 'errorCode', 'errorMessage')
    if (!run) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
    return res.json({ run })
  }))
  router.get(`${apiPrefix}/artifacts/:artifactId/content`, asyncRoute(async (req, res) => {
    const artifactId = UUIDSchema.parse(routeParameter(req, 'artifactId'))
    const ownerId = requestSkillPrincipal(req).userId
    const artifact = await wiki.models.knex('agentArtifacts').where({ id: artifactId, ownerId, kind: 'browser-screenshot', mimeType: 'image/png' }).first('payload', 'byteLength', 'sha256', 'expiresAt') as { payload: Buffer | null; byteLength: number; sha256: string; expiresAt: Date | string | null } | undefined
    if (!artifact || artifact.payload === null || (artifact.expiresAt !== null && new Date(artifact.expiresAt).getTime() <= Date.now())) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent artifact was not found', 404)
    if (artifact.payload.byteLength !== artifact.byteLength) throw new AgentRepositoryError('AGENT_ARTIFACT_CORRUPT', 'Agent artifact size is invalid', 500)
    const actualSha256 = createHash('sha256').update(artifact.payload).digest('hex')
    if (actualSha256 !== artifact.sha256) throw new AgentRepositoryError('AGENT_ARTIFACT_CORRUPT', 'Agent artifact hash is invalid', 500)
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${artifactId}.png"`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'X-Wiki-Content-Sha256': artifact.sha256
    })
    return res.send(artifact.payload)
  }))
  router.get(`${apiPrefix}/runs/:runId/events`, asyncRoute(async (req, res) => {
    const runId = UUIDSchema.parse(routeParameter(req, 'runId'))
    await streamOwnedAgentEvents(wiki.models.knex, req, res, requestSkillPrincipal(req).userId, runId, sseConnections, { maximumConnectionsPerUser: wiki.agentLimits?.sse.maximumConnectionsPerUser ?? 3 })
  }))
  router.post(`${apiPrefix}/runs/:runId/cancel`, asyncRoute(async (req, res) => {
    const runId = UUIDSchema.parse(routeParameter(req, 'runId'))
    return res.json({ run: await requestAgentRunCancellation(wiki.models.knex, requestSkillPrincipal(req).userId, runId) })
  }))


  router.use(['/_api/agents/skills', '/_api/agents/sessions/:sessionId/skills'], (req, res, next) => {
    if (!wiki.config.agents.skills.enabled) return res.sendStatus(404)
    if (!hasAgentPermission(req.user)) return res.sendStatus(403)
    return next()
  })
  router.get('/_api/agents/skills', asyncRoute(async (req, res) => {
    return res.json({ skills: await skillRuntime.listVisible(requestSkillPrincipal(req)) })
  }))
  router.get('/_api/agents/sessions/:sessionId/skills', asyncRoute(async (req, res) => {
    const sessionId = routeParameter(req, 'sessionId')
    if (!sessionId) return res.sendStatus(400)
    return res.json({ skills: await skillRuntime.listSessionSkills(sessionId, requestSkillPrincipal(req)) })
  }))
  router.put('/_api/agents/sessions/:sessionId/skills', asyncRoute(async (req, res) => {
    const sessionId = routeParameter(req, 'sessionId')
    if (!sessionId) return res.sendStatus(400)
    const input = z.strictObject({ expectedSessionVersion: z.number().int().positive(), skillVersionIds: z.array(z.uuid()).max(8), transportRequestId: z.uuid() }).parse(req.body)
    const version = await skillRuntime.setSessionSkills({ sessionId, expectedVersion: input.expectedSessionVersion, skillVersionIds: input.skillVersionIds, transportRequestId: input.transportRequestId, principal: requestSkillPrincipal(req) })
    return res.json({ version })
  }))
  router.get('/_api/agents/sessions/:sessionId/skills/:skillName/:versionId/resource', asyncRoute(async (req, res) => {
    const sessionId = routeParameter(req, 'sessionId')
    const skillName = routeParameter(req, 'skillName')
    const versionId = routeParameter(req, 'versionId')
    const path = typeof req.query.path === 'string' ? req.query.path : null
    const transportRequestId = typeof req.query.requestId === 'string' ? req.query.requestId : null
    if (!sessionId || !skillName || !versionId || !path || !transportRequestId) return res.sendStatus(400)
    const resource = await skillRuntime.readSessionResource({
      sessionId,
      skillName,
      versionId,
      path,
      transportRequestId,
      principal: requestSkillPrincipal(req)
    })
    res.set({
      'Content-Type': resource.mediaType,
      'X-Wiki-Content-Sha256': resource.contentHash,
      'X-Wiki-Source-Id': resource.sourceId,
      'X-Wiki-Source-Revision': resource.sourceRevision
    })
    return res.send(resource.bytes)
  }))
  router.use(['/_api/agents/skills', '/_api/agents/sessions/:sessionId/skills'], (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: 'INVALID_REQUEST', details: error.issues })
    if (error instanceof SkillValidationError) return res.status(409).json({ error: error.code, message: error.message })
    return next(error)
  })

  router.use(['/_api/agents/admin/runtime', '/_api/agents/admin/skills', '/_api/agents/admin/profiles', '/_api/agents/admin/browser-targets'], (req, res, next) => {
    if (!req.authContext || req.authContext.kind !== 'user') return res.sendStatus(401)
    if (!req.user?.permissions?.includes('manage:system')) return res.sendStatus(403)
    return next()
  })
  router.get('/_api/agents/admin/runtime', (_req, res) => {
    const config = wiki.config.agents
    return res.json({
      runtime: {
        enabled: config.enabled,
        providerEnabled: config.provider.enabled,
        skillsEnabled: config.skills.enabled,
        browserEnabled: config.browser?.enabled ?? false,
        proposalsEnabled: config.proposals.enabled,
        writes: {
          enabled: config.writes.enabled,
          create: config.writes.create.enabled,
          patch: config.writes.patch.enabled,
          move: config.writes.move.enabled,
          restore: config.writes.restore.enabled,
          delete: config.writes.delete.enabled
        },
        mcpEnabled: config.mcp?.enabled ?? false,
        quotas: {
          globalConcurrency: wiki.agentLimits?.provider.globalConcurrency ?? 4,
          perUserConcurrency: wiki.agentLimits?.provider.perUserConcurrency ?? 1,
          pollingMilliseconds: wiki.agentLimits?.provider.pollingMilliseconds ?? 1_000,
          maximumSseConnectionsPerUser: wiki.agentLimits?.sse.maximumConnectionsPerUser ?? 3
        },
        retention: {
          temporarySessionHours: wiki.agentLimits?.retention.temporarySessionHours ?? 24,
          mcpContentDays: wiki.agentLimits?.retention.mcpContentDays ?? 7,
          auditDays: wiki.agentLimits?.retention.auditDays ?? 90,
          maintenanceBatchSize: wiki.agentLimits?.retention.maintenanceBatchSize ?? 100
        }
      }
    })
  })
  router.get('/_api/agents/admin/browser-targets', asyncRoute(async (_req, res) => {
    return res.json({ targets: await browserTargets.list() })
  }))
  router.post('/_api/agents/admin/browser-targets', asyncRoute(async (req, res) => {
    const input = z.strictObject({ canonicalUrl: z.string().min(1).max(4_096), enabled: z.boolean().default(false) }).parse(req.body)
    return res.status(201).json({ target: await browserTargets.create({ ...input, actorId: req.authContext?.kind === 'user' ? req.authContext.userId : 0 }) })
  }))
  router.put('/_api/agents/admin/browser-targets/:targetId', asyncRoute(async (req, res) => {
    const targetId = UUIDSchema.parse(routeParameter(req, 'targetId'))
    const input = z.strictObject({ enabled: z.boolean() }).parse(req.body)
    return res.json({ target: await browserTargets.setEnabled({ id: targetId, enabled: input.enabled, actorId: req.authContext?.kind === 'user' ? req.authContext.userId : 0 }) })
  }))
  router.get('/_api/agents/admin/skills', asyncRoute(async (_req, res) => {
    res.json({ skills: await skillRegistry.list() })
  }))
  router.post('/_api/agents/admin/skills', asyncRoute(async (req, res) => {
    const skillId = await skillRegistry.create({ ...req.body, actorId: req.authContext?.kind === 'user' ? req.authContext.userId : 0 })
    res.status(201).json({ skillId })
  }))
  router.get('/_api/agents/admin/skills/:skillId/preview', asyncRoute(async (req, res) => {
    const skillId = routeParameter(req, 'skillId')
    if (!skillId) return res.sendStatus(400)
    return res.json(await skillRegistry.preview(skillId, requestUser(req)))
  }))
  router.post('/_api/agents/admin/skills/:skillId/policy', asyncRoute(async (req, res) => {
    const skillId = routeParameter(req, 'skillId')
    if (!skillId) return res.sendStatus(400)
    await skillRegistry.updatePolicy({ ...req.body, skillId, actorId: req.authContext?.kind === 'user' ? req.authContext.userId : 0 })
    return res.sendStatus(204)
  }))
  router.post('/_api/agents/admin/skills/:skillId/approve', asyncRoute(async (req, res) => {
    const skillId = routeParameter(req, 'skillId')
    if (!skillId) return res.sendStatus(400)
    const requester = requestUser(req)
    const versionId = await skillRegistry.approve({ ...req.body, skillId, actorId: requester.id, requester })
    return res.json({ versionId })
  }))
  router.post('/_api/agents/admin/skills/:skillId/reject', asyncRoute(async (req, res) => {
    const skillId = routeParameter(req, 'skillId')
    if (!skillId) return res.sendStatus(400)
    const requester = requestUser(req)
    const versionId = await skillRegistry.reject({ ...req.body, skillId, actorId: requester.id, requester })
    return res.json({ versionId })
  }))
  router.post('/_api/agents/admin/skills/:skillId/enabled', asyncRoute(async (req, res) => {
    const skillId = routeParameter(req, 'skillId')
    if (!skillId) return res.sendStatus(400)
    const enabled = z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled
    await skillRegistry.setEnabled(skillId, req.authContext?.kind === 'user' ? req.authContext.userId : 0, enabled)
    return res.sendStatus(204)
  }))
  router.get('/_api/agents/admin/profiles', asyncRoute(async (_req, res) => {
    if (!wiki.providerRegistry) return res.json({ profiles: [] })
    const profiles = await wiki.providerRegistry.listAll()
    return res.json({
      profiles: await Promise.all(profiles.map(async profile => ({
        ...profile,
        connectionCheck: wiki.providerConformance ? await wiki.providerConformance.latest(profile.id) : null
      })))
    })
  }))
  router.get('/_api/agents/admin/profiles/:profileId', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry) throw providerAdminUnavailable()
    return res.json({ profile: await wiki.providerRegistry.getAdmin(UUIDSchema.parse(routeParameter(req, 'profileId'))) })
  }))
  router.post('/_api/agents/admin/profiles', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry || !wiki.providerConformance) throw providerAdminUnavailable()
    const actorId = requestSkillPrincipal(req).userId
    const { groupIds, ...profileInput } = CreateAgentProviderProfileSchema.parse(req.body)
    const created = await wiki.providerRegistry.create({ ...profileInput, ...(groupIds === undefined ? {} : { groupIds }), actorId })
    const connectionCheck = await wiki.providerConformance.run(created.id, actorId)
    if (connectionCheck.status === 'passed') await wiki.providerRegistry.setEnabled(created.id, true, actorId)
    return res.status(201).json({ profile: await wiki.providerRegistry.getAdmin(created.id), connectionCheck })
  }))
  router.put('/_api/agents/admin/profiles/:profileId', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry || !wiki.providerConformance) throw providerAdminUnavailable()
    const profileId = UUIDSchema.parse(routeParameter(req, 'profileId'))
    const actorId = requestSkillPrincipal(req).userId
    const current = await wiki.providerRegistry.getAdmin(profileId)
    const profile = await wiki.providerRegistry.update(profileId, { ...UpdateAgentProviderProfileSchema.parse(req.body), actorId })
    const connectionCheck = await wiki.providerConformance.run(profile.id, actorId)
    if (connectionCheck.status === 'passed' && (current.status === 'enabled' || !current.conformed)) await wiki.providerRegistry.setEnabled(profile.id, true, actorId)
    return res.json({ profile: await wiki.providerRegistry.getAdmin(profile.id), connectionCheck })
  }))
  router.delete('/_api/agents/admin/profiles/:profileId', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry) throw providerAdminUnavailable()
    await wiki.providerRegistry.remove(UUIDSchema.parse(routeParameter(req, 'profileId')), requestSkillPrincipal(req).userId)
    return res.sendStatus(204)
  }))
  router.post('/_api/agents/admin/profiles/:profileId/connection-check', asyncRoute(async (req, res) => {
    if (!wiki.providerConformance || !wiki.providerRegistry) throw providerAdminUnavailable()
    const profileId = UUIDSchema.parse(routeParameter(req, 'profileId'))
    const actorId = requestSkillPrincipal(req).userId
    const input = z.strictObject({ enableOnSuccess: z.boolean().default(false) }).parse(req.body)
    const connectionCheck = await wiki.providerConformance.run(profileId, actorId)
    if (connectionCheck.status === 'passed' && input.enableOnSuccess) await wiki.providerRegistry.setEnabled(profileId, true, actorId)
    return res.json({ profile: await wiki.providerRegistry.getAdmin(profileId), connectionCheck })
  }))
  router.get('/_api/agents/admin/profiles/:profileId/connection-checks', asyncRoute(async (req, res) => {
    if (!wiki.providerConformance) throw providerAdminUnavailable()
    return res.json({ connectionChecks: await wiki.providerConformance.list(UUIDSchema.parse(routeParameter(req, 'profileId'))) })
  }))
  router.post('/_api/agents/admin/profiles/:profileId/enabled', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry) throw providerAdminUnavailable()
    const enabled = z.strictObject({ enabled: z.boolean() }).parse(req.body).enabled
    await wiki.providerRegistry.setEnabled(UUIDSchema.parse(routeParameter(req, 'profileId')), enabled, requestSkillPrincipal(req).userId)
    return res.sendStatus(204)
  }))
  router.post('/_api/agents/admin/profiles/:profileId/default', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry) throw providerAdminUnavailable()
    await wiki.providerRegistry.setDefault(UUIDSchema.parse(routeParameter(req, 'profileId')), requestSkillPrincipal(req).userId)
    return res.sendStatus(204)
  }))
  router.put('/_api/agents/admin/profiles/:profileId/grants', asyncRoute(async (req, res) => {
    if (!wiki.providerRegistry) throw providerAdminUnavailable()
    const input = z.strictObject({ exposureMode: z.enum(['all_agent_users', 'groups']), groupIds: z.array(z.number().int().positive()).max(1_000) }).parse(req.body)
    await wiki.providerRegistry.setGrants(UUIDSchema.parse(routeParameter(req, 'profileId')), input.exposureMode, input.groupIds, requestSkillPrincipal(req).userId)
    return res.sendStatus(204)
  }))
  router.use('/_api/agents/admin/skills', (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: 'INVALID_REQUEST', details: error.issues })
    if (error instanceof SkillValidationError) return res.status(409).json({ error: error.code, message: error.message })
    return next(error)
  })
  router.use(apiPrefix, (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error)
    if (error instanceof ZodError) return res.status(400).json({ error: 'INVALID_REQUEST', details: error.issues })
    if (error instanceof AgentRepositoryError) return res.status(error.status).json({ error: error.code, message: error.status >= 500 ? 'Agent request failed' : error.message })
    return next(error)
  })

  return router
}

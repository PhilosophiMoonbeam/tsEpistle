import { randomUUID } from 'node:crypto'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  McpServer,
  ResourceTemplate,
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  type AuthInfo,
  type ServerContext
} from '@modelcontextprotocol/server'
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'

import { MCP_ACTION_ALIASES, type AgentActionName, type AgentFeatureFlags } from '../../shared/agents/contracts.ts'
import { ACTION_CATALOG, actionDefinition } from './actions/catalog.ts'
import { ActionKernel, ActionKernelError, toMcpAction, type ActionAdmissionSnapshot, type ActionAuthority } from './actions/kernel.ts'
import { registerPageReadActions, type PageReadActionDependencies } from './actions/page-reads.ts'
import { registerPageProposalActions, type PageProposalActionDependencies } from './actions/page-proposals.ts'
import { registerSkillReadActions } from './actions/skill-reads.ts'
import { getMcpProposal } from './proposals/repository.ts'
import { canonicalMcpResource } from './origins.ts'
import { SkillRuntime } from './skills/runtime.ts'
import { validateSkillVirtualPath } from './skills/virtual-path.ts'

const UUIDSchema = z.uuid()
const IdentitySchema = z.strictObject({ apiKeyId: z.number().int().positive(), groupId: z.number().int().positive() })
const ApprovalResponseSchema = z.object({ acknowledge: z.boolean() })
const StateSchema = z.strictObject({
  proposalId: z.uuid(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  requesterApiKeyId: z.number().int().positive(),
  expiresAt: z.string().datetime()
})

type McpApprovalState = z.infer<typeof StateSchema>

export interface WikiMcpConfiguration {
  readonly enabled: boolean
  readonly wikiPublicOrigin: string
  readonly agentsEnabled: boolean
  readonly skillsEnabled: boolean
  readonly proposalsEnabled: boolean
  readonly writesEnabled: boolean
  readonly writeCreateEnabled: boolean
  readonly writePatchEnabled: boolean
  readonly writeMoveEnabled: boolean
  readonly writeRestoreEnabled: boolean
  readonly writeDeleteEnabled: boolean
  readonly requestStateKeys: readonly Uint8Array[]
  readonly snapshotSigningSecret: Uint8Array
}

export interface WikiMcpDependencies {
  readonly knex: Knex
  readonly operations: PageReadActionDependencies['operations'] & PageProposalActionDependencies['operations']
  readonly authenticate: RequestHandler
  readonly resolvePrincipal: (apiKeyId: number, groupId: number) => Promise<Express.User>
  readonly config: WikiMcpConfiguration
  readonly resolveUser: (userId: number) => Promise<Express.User>
  readonly logger?: { warn(value: unknown): void }
}

const normalizedMcpUrl = (config: WikiMcpConfiguration): URL => canonicalMcpResource(config.wikiPublicOrigin)

const featureFlags = (config: WikiMcpConfiguration): AgentFeatureFlags => ({
  'agents.enabled': config.agentsEnabled,
  'agents.provider.enabled': false,
  'agents.skills.enabled': config.skillsEnabled,
  'agents.browser.enabled': false,
  'agents.proposals.enabled': config.proposalsEnabled,
  'agents.writes.enabled': config.writesEnabled,
  'agents.writes.create.enabled': config.writeCreateEnabled,
  'agents.writes.patch.enabled': config.writePatchEnabled,
  'agents.writes.move.enabled': config.writeMoveEnabled,
  'agents.writes.restore.enabled': config.writeRestoreEnabled,
  'agents.writes.delete.enabled': config.writeDeleteEnabled,
  'agents.mcp.enabled': config.enabled
})

const identityFrom = (authInfo: AuthInfo | undefined): z.infer<typeof IdentitySchema> => {
  const result = IdentitySchema.safeParse(authInfo?.extra)
  if (!result.success) throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'Validated MCP API-key identity is missing', 401)
  return result.data
}

const permissionsFor = (principal: Express.User): readonly string[] => {
  const permissions = principal.permissions
  return [...new Set(Array.isArray(permissions) ? permissions.filter((value): value is string => typeof value === 'string') : [])].sort()
}

const groupIdsFor = (principal: Express.User, fallback: number): readonly number[] => {
  const groups = Reflect.get(principal, 'groups')
  const values = Array.isArray(groups) ? groups : [fallback]
  return [...new Set(values.flatMap(value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? [value] : []
    if (typeof value === 'object' && value !== null) {
      const id = Reflect.get(value, 'id')
      return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? [id] : []
    }
    return []
  }))].sort((left, right) => left - right)
}

const textResult = (value: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown> } => {
  const structuredContent = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value }
  const encoded = JSON.stringify(structuredContent)
  return {
    content: [{ type: 'text', text: encoded.length <= 64_000 ? encoded : `${encoded.slice(0, 63_980)}…[truncated]` }],
    structuredContent
  }
}

const errorResult = (error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } => {
  const code = error instanceof ActionKernelError ? error.code : 'MCP_ACTION_FAILED'
  const message = error instanceof Error ? error.message : 'MCP action failed'
  return { content: [{ type: 'text', text: JSON.stringify({ code, error: message }) }], isError: true }
}

const requestIdInput = (name: AgentActionName, input: unknown): { requestId: string; actionInput: unknown } => {
  const definition = actionDefinition(name)
  if (definition.descriptor.risk !== 'proposal' && definition.descriptor.risk !== 'destructive-write') {
    return { requestId: randomUUID(), actionInput: input }
  }
  const value = z.record(z.string(), z.unknown()).parse(input)
  const requestId = UUIDSchema.parse(value.requestId)
  const actionInput = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'requestId'))
  return { requestId, actionInput }
}

const toolInputSchema = (name: AgentActionName): z.ZodType => {
  const definition = actionDefinition(name)
  if (definition.descriptor.risk !== 'proposal' && definition.descriptor.risk !== 'destructive-write') return definition.input
  return (definition.input as z.ZodObject<z.ZodRawShape>).extend({ requestId: z.uuid() })
}

const decodeTemplateValue = (value: unknown): string => {
  if (typeof value !== 'string') throw new ActionKernelError('INVALID_SKILL_PATH', 'Skill resource URI is invalid', 400)
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ActionKernelError('INVALID_SKILL_PATH', 'Skill resource URI contains invalid escaping', 400)
  }
}

export const createWikiMcpController = (dependencies: WikiMcpDependencies): express.Router => {
  if (!dependencies.config.enabled) throw new Error('Cannot create the MCP controller while MCP is disabled')
  if (dependencies.config.requestStateKeys.length === 0) throw new Error('At least one MCP request-state key is required')
  for (const key of dependencies.config.requestStateKeys) if (key.byteLength < 32) throw new Error('MCP request-state keys must contain at least 32 bytes')
  const resourceUrl = normalizedMcpUrl(dependencies.config)
  const hostnames = [resourceUrl.hostname]
  const skillRuntime = new SkillRuntime(dependencies.knex)
  const kernel = new ActionKernel()
  const resolveRequester = async (authority: ActionAuthority): Promise<Express.User> => {
    if (authority.requester.kind !== 'apiKey') throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'MCP page actions require an API key', 401)
    return dependencies.resolvePrincipal(authority.requester.apiKeyId, authority.requester.groupId)
  }
  registerPageReadActions(kernel, { operations: dependencies.operations, resolveRequester, snapshotSigningSecret: dependencies.config.snapshotSigningSecret })
  registerPageProposalActions(kernel, { knex: dependencies.knex, operations: dependencies.operations, resolveRequester, resolveApprover: dependencies.resolveUser, snapshotSigningSecret: dependencies.config.snapshotSigningSecret })
  registerSkillReadActions(kernel, skillRuntime)

  const codecs = dependencies.config.requestStateKeys.map(key => createRequestStateCodec<McpApprovalState>({
    key,
    ttlSeconds: 600,
    bind: context => `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ''}`
  }))
  const verifyState = async (state: string, context: ServerContext): Promise<McpApprovalState> => {
    let failure: unknown
    for (const codec of codecs) {
      try {
        return StateSchema.parse(await codec.verify(state, context))
      } catch (error: unknown) {
        failure = error
      }
    }
    throw failure instanceof Error ? failure : new Error('mac')
  }

  const admissionFor = async (authInfo: AuthInfo | undefined): Promise<{ auth: NonNullable<Express.Request['authContext']>; snapshot: ActionAdmissionSnapshot }> => {
    const identity = identityFrom(authInfo)
    const principal = await dependencies.resolvePrincipal(identity.apiKeyId, identity.groupId)
    const permissions = permissionsFor(principal)
    if (!permissions.some(permission => permission === 'use:mcp' || permission === 'manage:system')) {
      throw new ActionKernelError('MCP_PERMISSION_REQUIRED', 'API key group lacks use:mcp', 403)
    }
    return {
      auth: { kind: 'apiKey', apiKeyId: identity.apiKeyId, groupId: identity.groupId, ownershipUserId: null, principal },
      snapshot: {
        transport: 'mcp',
        executionMode: 'agent',
        supportsTools: true,
        permissions,
        groupIds: groupIdsFor(principal, identity.groupId),
        featureFlags: featureFlags(dependencies.config)
      }
    }
  }

  const handler = createMcpHandler(async requestContext => {
    const initial = await admissionFor(requestContext.authInfo)
    const offered = kernel.offer(initial.auth, initial.snapshot, randomUUID())
    const offeredNames = new Set(offered.map(action => action.definition.descriptor.name))
    const server = new McpServer({ name: 'tsFranki', version: '1.0.0' }, {
      requestState: { verify: verifyState },
      cacheHints: {
        'tools/list': { ttlMs: 0, cacheScope: 'private' },
        'resources/list': { ttlMs: 0, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 0, cacheScope: 'private' },
        'resources/read': { ttlMs: 0, cacheScope: 'private' }
      }
    })

    for (const [actionNameValue] of Object.entries(MCP_ACTION_ALIASES)) {
      const actionName = actionNameValue as AgentActionName
      if (!offeredNames.has(actionName)) continue
      if (requestContext.era === 'legacy' && actionName === 'pages.applyProposal') continue
      const descriptor = toMcpAction(ACTION_CATALOG[actionName])
      server.registerTool(descriptor.name, {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: toolInputSchema(actionName),
        annotations: descriptor.annotations
      }, async (input: unknown, context: ServerContext) => {
        try {
          const identity = identityFrom(context.http?.authInfo)
          if (actionName === 'pages.applyProposal') {
            const applyInput = ACTION_CATALOG['pages.applyProposal'].input.parse(input)
            const persisted = await getMcpProposal(dependencies.knex, identity.apiKeyId, applyInput.proposalId)
            if (persisted.approval.id !== applyInput.approvalId) throw new ActionKernelError('APPROVAL_MISMATCH', 'Approval does not belong to the proposal', 409)
            const state = context.mcpReq.requestState<McpApprovalState>()
            if (state) {
              if (state.proposalId !== persisted.proposal.id || state.inputHash !== persisted.proposal.inputHash || state.requesterApiKeyId !== identity.apiKeyId || state.expiresAt !== new Date(persisted.proposal.expiresAt).toISOString()) {
                throw new ActionKernelError('INVALID_REQUEST_STATE', 'Approval request state no longer matches the proposal', 409)
              }
              const response = acceptedContent(context.mcpReq.inputResponses, 'approval', ApprovalResponseSchema)
              if (response?.acknowledge === false) return textResult({ proposalId: persisted.proposal.id, status: 'declined', applied: false })
            }
            if (persisted.proposal.status === 'denied' || persisted.approval.status === 'denied') return textResult({ proposalId: persisted.proposal.id, status: 'denied', applied: false })
            if (persisted.proposal.status === 'expired' || persisted.approval.status === 'expired') return textResult({ proposalId: persisted.proposal.id, status: 'expired', applied: false })
            if (persisted.proposal.status !== 'approved' || persisted.approval.status !== 'approved') {
              const requestState = await codecs[0]!.mint({
                proposalId: persisted.proposal.id,
                inputHash: persisted.proposal.inputHash,
                requesterApiKeyId: identity.apiKeyId,
                expiresAt: new Date(persisted.proposal.expiresAt).toISOString()
              }, context)
              const approvalUrl = new URL('/', dependencies.config.wikiPublicOrigin)
              approvalUrl.searchParams.set('agentApproval', persisted.proposal.id)
              return inputRequired({
                requestState,
                inputRequests: {
                  approval: inputRequired.elicit({
                    message: `Approve this immutable Wiki proposal at ${approvalUrl.href}, then acknowledge to retry.`,
                    requestedSchema: ApprovalResponseSchema
                  })
                }
              })
            }
          }

          const { requestId, actionInput } = requestIdInput(actionName, input)
          const current = await admissionFor(context.http?.authInfo)
          const authority = kernel.offer(current.auth, current.snapshot, requestId)
            .find(action => action.definition.descriptor.name === actionName)?.authority
          if (!authority) throw new ActionKernelError('ACTION_NOT_OFFERED', 'Action is not currently permitted', 403)
          const output = await kernel.execute({
            authority,
            actionCallId: String(context.mcpReq.id).slice(0, 128) || randomUUID(),
            input: actionInput,
            signal: context.mcpReq.signal,
            refreshAdmission: async () => (await admissionFor(context.http?.authInfo)).snapshot
          })
          return textResult(output)
        } catch (error: unknown) {
          return errorResult(error)
        }
      })
    }
    if (offeredNames.has('pages.getOkf')) {
      server.registerResource('okf-pages', new ResourceTemplate('wiki://pages/{locale}/{+path}', {
        list: undefined
      }), {
        title: 'Wiki pages as OKF concepts',
        description: 'Visible Markdown pages rendered as portable Open Knowledge Format v0.2 documents',
        mimeType: 'text/markdown'
      }, async (uri, variables, context) => {
        const locale = decodeTemplateValue(variables.locale)
        const path = decodeTemplateValue(variables.path)
        const input = ACTION_CATALOG['pages.getOkf'].input.parse({ locale, path })
        const current = await admissionFor(context.http?.authInfo)
        const requestId = randomUUID()
        const authority = kernel.offer(current.auth, current.snapshot, requestId)
          .find(action => action.definition.descriptor.name === 'pages.getOkf')?.authority
        if (!authority) throw new ActionKernelError('ACTION_NOT_OFFERED', 'OKF page resources are not currently permitted', 403)
        const rawOutput = await kernel.execute({
          authority,
          actionCallId: String(context.mcpReq.id).slice(0, 128) || randomUUID(),
          input,
          signal: context.mcpReq.signal,
          refreshAdmission: async () => (await admissionFor(context.http?.authInfo)).snapshot
        })
        const output = ACTION_CATALOG['pages.getOkf'].output.parse(rawOutput)
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/markdown',
            text: output.markdown,
            _meta: {
              okfVersion: output.version,
              conceptId: output.conceptId,
              sourceRevision: output.sourceRevision,
              contentHash: output.sha256,
              trustTier: output.trust.trustTier,
              verification: output.trust.verification,
              stale: output.trust.stale
            }
          }]
        }
      })
    }


    if (offeredNames.has('skills.list')) {
      server.registerResource('approved-skills', new ResourceTemplate('wiki://skills/{name}/{version}/{+path}', {
        list: async context => {
          const identity = identityFrom(context.http?.authInfo)
          const current = await admissionFor(context.http?.authInfo)
          const skills = await skillRuntime.listVisibleForApiKey({
            principal: { apiKeyId: identity.apiKeyId, groupIds: current.snapshot.groupIds },
            transportRequestId: randomUUID()
          })
          return {
            resources: skills.map(skill => ({
              name: `${skill.name} SKILL.md`,
              uri: `wiki://skills/${encodeURIComponent(skill.name)}/${skill.versionId}/SKILL.md`,
              mimeType: 'text/markdown',
              description: skill.description
            }))
          }
        }
      }), { title: 'Approved Wiki skills', description: 'Immutable approved skill resources' }, async (uri, variables, context) => {
        const identity = identityFrom(context.http?.authInfo)
        const current = await admissionFor(context.http?.authInfo)
        const name = decodeTemplateValue(variables.name)
        const versionId = UUIDSchema.parse(decodeTemplateValue(variables.version))
        const path = validateSkillVirtualPath(decodeTemplateValue(variables.path))
        const resource = await skillRuntime.readVisibleResourceForApiKey({
          skillName: name,
          versionId,
          path,
          principal: { apiKeyId: identity.apiKeyId, groupIds: current.snapshot.groupIds },
          transportRequestId: randomUUID(),
          ...(context.sessionId ? { externalSessionId: context.sessionId } : {})
        })
        const base = { uri: uri.href, mimeType: resource.mediaType, _meta: { contentHash: resource.contentHash, sourceId: resource.sourceId, sourceRevision: resource.sourceRevision } }
        return {
          contents: resource.mediaType.startsWith('text/') || resource.mediaType === 'application/json'
            ? [{ ...base, text: resource.bytes.toString('utf8') }]
            : [{ ...base, blob: resource.bytes.toString('base64') }]
        }
      })
    }
    return server
  }, {
    responseMode: 'auto',
    legacy: 'stateless',
    keepAliveMs: 15_000,
    maxSubscriptions: 0,
    onerror: error => dependencies.logger?.warn(error)
  })
  const nodeHandler = toNodeHandler(handler, { onerror: error => dependencies.logger?.warn(error) })

  const router = express.Router()
  router.use('/mcp', hostHeaderValidation(hostnames) as unknown as RequestHandler, originValidation(hostnames) as unknown as RequestHandler)
  router.use('/mcp', express.json({ limit: '128kb', strict: true, type: 'application/json' }))
  router.use('/mcp', dependencies.authenticate)
  router.all('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    if (!dependencies.config.enabled) return res.sendStatus(404)
    if (!req.authContext || req.authContext.kind !== 'apiKey' || !req.apiKeyAuth) return res.sendStatus(401)
    if (!req.user?.permissions?.some(permission => permission === 'use:mcp' || permission === 'manage:system')) return res.sendStatus(403)
    const token = req.apiKeyAuth.bearerToken
    if (!token) return res.sendStatus(401)
    if (req.apiKeyAuth.mcpResourceVersion !== 1 || req.apiKeyAuth.mcpResource === null) return res.status(401).json({ error: 'API key must be regenerated with an MCP resource claim' })
    let claimed: URL
    try {
      claimed = new URL(req.apiKeyAuth.mcpResource)
      claimed.hash = ''
    } catch {
      return res.status(401).json({ error: 'API key MCP resource claim is invalid' })
    }
    if (claimed.href !== resourceUrl.href) return res.status(403).json({ error: 'API key is bound to a different MCP resource' })
    const authInfo: AuthInfo = {
      token,
      clientId: `wiki-api-key:${req.authContext.apiKeyId}`,
      scopes: [...permissionsFor(req.user)],
      ...(req.apiKeyAuth.expiresAt === null ? {} : { expiresAt: req.apiKeyAuth.expiresAt }),
      resource: resourceUrl,
      extra: { apiKeyId: req.authContext.apiKeyId, groupId: req.authContext.groupId }
    }
    Reflect.set(req, 'auth', authInfo)
    try {
      await nodeHandler(req, res, req.body)
    } catch (error: unknown) {
      next(error)
    }
  })
  return router
}

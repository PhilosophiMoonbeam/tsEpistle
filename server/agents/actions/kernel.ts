import { createHash, timingSafeEqual } from 'node:crypto'
import { z, ZodError } from 'zod'

import {
  AGENT_FEATURE_FLAG_KEYS,
  MCP_ACTION_ALIASES,
  type AgentActionName,
  type AgentFeatureFlags,
  type AgentTransport,
  type RequestAuthContext
} from '../../../shared/agents/contracts.ts'
import { ACTION_CATALOG, actionDefinition, type ActionDefinition } from './catalog.ts'

export interface ActionAdmissionSnapshot {
  readonly transport: AgentTransport
  readonly executionMode: 'agent' | 'generation-only'
  readonly supportsTools: boolean
  readonly permissions: readonly string[]
  readonly groupIds: readonly number[]
  readonly featureFlags: AgentFeatureFlags
  readonly allowedActions?: readonly AgentActionName[]
}

export type ActionRequester =
  | { readonly kind: 'user'; readonly userId: number }
  | { readonly kind: 'apiKey'; readonly apiKeyId: number; readonly groupId: number }

export interface ActionAuthority {
  readonly version: 1
  readonly actionName: AgentActionName
  readonly requestId: string
  readonly transport: AgentTransport
  readonly requester: ActionRequester
  readonly groupIds: readonly number[]
  readonly permissions: readonly string[]
  readonly featureFlags: AgentFeatureFlags
  readonly allowedActions: readonly AgentActionName[] | null
  readonly authoritySha256: string
}

export interface OfferedAction {
  readonly definition: ActionDefinition
  readonly authority: ActionAuthority
}

export interface ActionHandlerContext {
  readonly authority: ActionAuthority
  readonly actionCallId: string
  readonly signal: AbortSignal
  readonly reauthorize: () => Promise<void>
  readonly fenceSideEffect: () => Promise<void>
  readonly executeAction: (actionName: AgentActionName, input: unknown) => Promise<unknown>
}

export interface ActionHandler {
  (input: unknown, context: ActionHandlerContext): Promise<unknown>
}

export interface ActionExecutionRequest {
  readonly authority: ActionAuthority
  readonly actionCallId: string
  readonly input: unknown
  readonly signal: AbortSignal
  readonly refreshAdmission: (authority: ActionAuthority, input: unknown) => Promise<ActionAdmissionSnapshot>
  readonly fenceSideEffect?: () => Promise<void>
}

export interface AxActionDescriptor {
  readonly name: AgentActionName
  readonly description: string
  readonly inputSchema: z.ZodType
}

export interface McpActionDescriptor {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
}

const AuthoritySchema = z.strictObject({
  version: z.literal(1),
  actionName: z.enum(Object.keys(ACTION_CATALOG) as [AgentActionName, ...AgentActionName[]]),
  requestId: z.uuid(),
  transport: z.enum(['agent', 'mcp']),
  requester: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user'), userId: z.number().int().positive() }),
    z.strictObject({ kind: z.literal('apiKey'), apiKeyId: z.number().int().positive(), groupId: z.number().int().positive() })
  ]),
  groupIds: z.array(z.number().int().positive()),
  permissions: z.array(z.string()),
  featureFlags: z.record(z.string(), z.boolean()),
  allowedActions: z.array(z.enum(Object.keys(ACTION_CATALOG) as [AgentActionName, ...AgentActionName[]])).nullable(),
  authoritySha256: z.string().regex(/^[a-f0-9]{64}$/)
})

export class ActionKernelError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const uniqueSorted = <T extends string | number>(values: readonly T[]): readonly T[] => [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

const authorityPayload = (authority: Omit<ActionAuthority, 'authoritySha256'>): string => JSON.stringify({
  version: authority.version,
  actionName: authority.actionName,
  requestId: authority.requestId,
  transport: authority.transport,
  requester: authority.requester,
  groupIds: authority.groupIds,
  permissions: authority.permissions,
  featureFlags: authority.featureFlags,
  allowedActions: authority.allowedActions
})

const authorityHash = (authority: Omit<ActionAuthority, 'authoritySha256'>): string => createHash('sha256').update(authorityPayload(authority)).digest('hex')

const requesterFromAuth = (auth: RequestAuthContext): ActionRequester => {
  if (auth.kind === 'guest') throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'Agent actions require authentication', 401)
  if (auth.kind === 'user') return { kind: 'user', userId: auth.userId }
  return { kind: 'apiKey', apiKeyId: auth.apiKeyId, groupId: auth.groupId }
}

const authFromAuthority = (authority: ActionAuthority): RequestAuthContext =>
  authority.requester.kind === 'user'
    ? { kind: 'user', userId: authority.requester.userId, ownershipUserId: authority.requester.userId, principal: null }
    : { kind: 'apiKey', apiKeyId: authority.requester.apiKeyId, groupId: authority.requester.groupId, ownershipUserId: null, principal: null }

const hasAdmissionPermission = (snapshot: ActionAdmissionSnapshot, permission: string): boolean =>
  snapshot.permissions.includes(permission) ||
  (snapshot.transport === 'agent' && permission !== 'use:agent-browser' && snapshot.permissions.includes('manage:system'))

const assertAdmission = (definition: ActionDefinition, snapshot: ActionAdmissionSnapshot): void => {
  const descriptor = definition.descriptor
  if (!descriptor.exposure[snapshot.transport]) throw new ActionKernelError('ACTION_NOT_EXPOSED', 'Action is not exposed on this transport', 404)
  if (snapshot.executionMode !== 'agent' || !snapshot.supportsTools) throw new ActionKernelError('TOOLS_UNAVAILABLE', 'The selected execution profile cannot use actions', 409)
  const basePermission = snapshot.transport === 'agent' ? 'use:agents' : 'use:mcp'
  if (!hasAdmissionPermission(snapshot, basePermission)) throw new ActionKernelError('ACTION_FORBIDDEN', `Missing ${basePermission}`, 403)
  for (const permission of descriptor.requiredPermissions) {
    if (!hasAdmissionPermission(snapshot, permission)) throw new ActionKernelError('ACTION_FORBIDDEN', `Missing ${permission}`, 403)
  }
  if (descriptor.name === 'pages.applyProposal' && !hasAdmissionPermission(snapshot, 'write:pages') && !hasAdmissionPermission(snapshot, 'delete:pages')) {
    throw new ActionKernelError('ACTION_FORBIDDEN', 'Missing page mutation permission', 403)
  }
  if (snapshot.transport === 'agent' && !snapshot.featureFlags['agents.provider.enabled']) {
    throw new ActionKernelError('ACTION_DISABLED', 'Agent providers are disabled', 404)
  }
  for (const flag of definition.requiredFlags) {
    if (!snapshot.featureFlags[flag]) throw new ActionKernelError('ACTION_DISABLED', `Feature ${flag} is disabled`, 404)
  }
  if (snapshot.transport === 'mcp' && !snapshot.featureFlags['agents.mcp.enabled']) {
    throw new ActionKernelError('ACTION_DISABLED', 'MCP actions are disabled', 404)
  }
  if (snapshot.allowedActions && !snapshot.allowedActions.includes(descriptor.name)) {
    throw new ActionKernelError('ACTION_NOT_ALLOWED', 'Selected skills or profile policy do not allow this action', 403)
  }
}

export const createActionAuthority = (
  actionName: AgentActionName,
  requestId: string,
  auth: RequestAuthContext,
  snapshot: ActionAdmissionSnapshot
): ActionAuthority => {
  z.uuid().parse(requestId)
  const payload: Omit<ActionAuthority, 'authoritySha256'> = {
    version: 1,
    actionName,
    requestId,
    transport: snapshot.transport,
    requester: requesterFromAuth(auth),
    groupIds: uniqueSorted(snapshot.groupIds),
    permissions: uniqueSorted(snapshot.permissions),
    featureFlags: Object.fromEntries(Object.entries(snapshot.featureFlags).sort(([left], [right]) => left.localeCompare(right))) as AgentFeatureFlags,
    allowedActions: snapshot.allowedActions ? uniqueSorted(snapshot.allowedActions) : null
  }
  return Object.freeze({ ...payload, authoritySha256: authorityHash(payload) })
}

export const verifyActionAuthority = (value: unknown): ActionAuthority => {
  const parsed = AuthoritySchema.safeParse(value)
  if (!parsed.success) throw new ActionKernelError('INVALID_AUTHORITY', 'Action authority has an invalid shape', 400)
  for (const flag of AGENT_FEATURE_FLAG_KEYS) {
    if (typeof parsed.data.featureFlags[flag] !== 'boolean') throw new ActionKernelError('INVALID_AUTHORITY', 'Action authority feature flags are incomplete', 400)
  }
  const authority = parsed.data as unknown as ActionAuthority
  const { authoritySha256, ...payload } = authority
  const expected = Buffer.from(authorityHash(payload), 'hex')
  const received = Buffer.from(authoritySha256, 'hex')
  if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
    throw new ActionKernelError('INVALID_AUTHORITY', 'Action authority hash does not match', 400)
  }
  return authority
}

const jsonSchemaFor = (schema: z.ZodType): Record<string, unknown> => {
  const converted = z.toJSONSchema(schema)
  return converted as Record<string, unknown>
}

export const toAxAction = (definition: ActionDefinition): AxActionDescriptor => ({
  name: definition.descriptor.name,
  description: definition.descriptor.description,
  inputSchema: definition.input
})

export const toMcpAction = (definition: ActionDefinition): McpActionDescriptor => {
  const actionName = definition.descriptor.name
  const alias = MCP_ACTION_ALIASES[actionName as keyof typeof MCP_ACTION_ALIASES]
  if (!alias) throw new ActionKernelError('ACTION_NOT_EXPOSED', 'Action has no MCP alias', 404)
  return {
    name: alias,
    title: definition.descriptor.title,
    description: definition.descriptor.description,
    inputSchema: jsonSchemaFor(definition.input),
    annotations: {
      readOnlyHint: !definition.descriptor.annotations.sideEffects,
      destructiveHint: definition.descriptor.risk === 'destructive-write',
      idempotentHint: definition.descriptor.annotations.idempotent,
      openWorldHint: definition.descriptor.annotations.openWorld
    }
  }
}

export class ActionKernel {
  private readonly handlers = new Map<AgentActionName, ActionHandler>()

  register(name: AgentActionName, handler: ActionHandler): void {
    if (this.handlers.has(name)) throw new ActionKernelError('DUPLICATE_ACTION_HANDLER', `Handler for ${name} is already registered`, 500)
    this.handlers.set(name, handler)
  }

  offer(auth: RequestAuthContext, snapshot: ActionAdmissionSnapshot, requestId: string): readonly OfferedAction[] {
    const offered: OfferedAction[] = []
    const registered = this.handlers
    for (const definition of Object.values(ACTION_CATALOG)) {
      if (!registered.has(definition.descriptor.name)) continue
      try {
        assertAdmission(definition, snapshot)
        offered.push({ definition, authority: createActionAuthority(definition.descriptor.name, requestId, auth, snapshot) })
      } catch (error: unknown) {
        if (!(error instanceof ActionKernelError)) throw error
      }
    }
    return offered
  }

  async execute(request: ActionExecutionRequest): Promise<unknown> {
    const authority = verifyActionAuthority(request.authority)
    const definition = actionDefinition(authority.actionName)
    let input: unknown
    try {
      input = definition.input.parse(request.input)
    } catch (error: unknown) {
      if (error instanceof ZodError) throw new ActionKernelError('INVALID_ACTION_INPUT', 'Action input does not match its schema', 400)
      throw error
    }
    if (request.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled before execution', 409)

    const liveAdmission = await request.refreshAdmission(authority, input)
    if (liveAdmission.transport !== authority.transport) throw new ActionKernelError('INVALID_AUTHORITY', 'Action transport changed after admission', 400)
    assertAdmission(definition, liveAdmission)
    const handler = this.handlers.get(authority.actionName)
    if (!handler) throw new ActionKernelError('ACTION_HANDLER_MISSING', `Action ${authority.actionName} has no registered handler`, 501)
    const reauthorize = async (): Promise<void> => {
      if (request.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled before side-effect dispatch', 409)
      const currentAdmission = await request.refreshAdmission(authority, input)
      if (currentAdmission.transport !== authority.transport) throw new ActionKernelError('INVALID_AUTHORITY', 'Action transport changed after admission', 400)
      assertAdmission(definition, currentAdmission)
      if (request.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled before side-effect dispatch', 409)
    }
    const fenceSideEffect = async (): Promise<void> => {
      await reauthorize()
      await request.fenceSideEffect?.()
      if (request.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled before side-effect dispatch', 409)
    }
    const executeAction = async (actionName: AgentActionName, nestedInput: unknown): Promise<unknown> => {
      const currentAdmission = await request.refreshAdmission(authority, input)
      if (currentAdmission.transport !== authority.transport) throw new ActionKernelError('INVALID_AUTHORITY', 'Action transport changed after admission', 400)
      const nestedAuthority = createActionAuthority(actionName, authority.requestId, authFromAuthority(authority), currentAdmission)
      return this.execute({ ...request, authority: nestedAuthority, input: nestedInput })
    }
    const output = await handler(input, { authority, actionCallId: z.string().min(1).max(128).parse(request.actionCallId), signal: request.signal, reauthorize, fenceSideEffect, executeAction })
    if (request.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled during execution', 409)
    try {
      return definition.output.parse(output)
    } catch (error: unknown) {
      if (error instanceof ZodError) throw new ActionKernelError('INVALID_ACTION_OUTPUT', `Action ${authority.actionName} returned an invalid result`, 500)
      throw error
    }
  }
}

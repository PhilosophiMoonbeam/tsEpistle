import { z } from 'zod'
import { requestJson } from './agents-api.ts'
import {
  RoutingAdminViewSchema,
  RoutingPolicyInputSchema,
  RoutingPolicyViewSchema,
  RoutingModelPolicyInputSchema,
  RoutingModelPolicyViewSchema,
  type RoutingPolicyInput,
  type RoutingModelPolicyInput
} from '../../shared/agents/routing.ts'
import {
  DecisionProviderConfigSchema,
  DecisionProviderWriteSchema,
  DecisionUsageSchema,
  type DecisionProviderView,
  type DecisionProviderWrite,
  type DecisionProviderCheck
} from '../../shared/agents/decision-providers.ts'
import {
  ExternalMcpServerInputSchema,
  CreateAdminExternalMcpServerSchema,
  type ExternalMcpServerView,
  type ExternalMcpServerInput,
  type CreateAdminExternalMcpServerInput,
  type ExternalMcpGroupPolicyView
} from '../../shared/agents/external-mcp.ts'
export type {
  DecisionProviderView,
  DecisionProviderWrite,
  DecisionProviderCheck,
  ExternalMcpServerView,
  ExternalMcpServerInput,
  CreateAdminExternalMcpServerInput,
  ExternalMcpGroupPolicyView
}
const Provider: z.ZodType<DecisionProviderView> = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  revision: z.number().int().positive(),
  config: DecisionProviderConfigSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  secretConfigured: z.boolean(),
  credentialSource: z.enum(['managed', 'environment', 'none']),
  checkedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
const Server: z.ZodType<ExternalMcpServerView> = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  endpointUrl: z.string(),
  destinationHost: z.string(),
  namespace: z.string(),
  scope: z.enum(['admin', 'personal']),
  ownerId: z.number().nullable(),
  status: z.enum(['enabled', 'disabled']),
  revision: z.number().int().positive(),
  authMode: z.enum(['none', 'bearer']),
  secretConfigured: z.boolean(),
  groupIds: z.array(z.number().int().positive()),
  trust: z.literal('untrusted'),
  createdAt: z.string(),
  updatedAt: z.string()
})
const Policy: z.ZodType<ExternalMcpGroupPolicyView> = z.object({
  groupId: z.number().int().positive(),
  allowPersonalEndpoints: z.boolean(),
  revision: z.number().int().nonnegative()
})
const deleted = z.object({ deleted: z.literal(true) })
const body = (method: string, input: unknown): RequestInit => ({ method, body: JSON.stringify(input) })
const root = '/_api/agents'
const key = (id: string) => encodeURIComponent(z.string().uuid().parse(id))
const revision = (value: number) => z.number().int().nonnegative().parse(value)
export const listDecisionProviders = async (f: typeof fetch, c: string, signal?: AbortSignal) =>
  (await requestJson(f, c, `${root}/admin/decision-providers`, z.object({ providers: z.array(Provider) }), { signal })).providers
export const createDecisionProvider = async (f: typeof fetch, c: string, input: DecisionProviderWrite) =>
  (await requestJson(f, c, `${root}/admin/decision-providers`, z.object({ provider: Provider }), body('POST', DecisionProviderWriteSchema.parse(input))))
    .provider
export const updateDecisionProvider = async (f: typeof fetch, c: string, id: string, input: DecisionProviderWrite & { expectedRevision: number }) => {
  const { expectedRevision, ...write } = input
  return (
    await requestJson(
      f,
      c,
      `${root}/admin/decision-providers/${key(id)}`,
      z.object({ provider: Provider }),
      body('PUT', { ...DecisionProviderWriteSchema.parse(write), expectedRevision: revision(expectedRevision) })
    )
  ).provider
}
export const deleteDecisionProvider = async (f: typeof fetch, c: string, id: string, expectedRevision: number): Promise<void> => {
  await requestJson(f, c, `${root}/admin/decision-providers/${key(id)}`, deleted, body('DELETE', { expectedRevision: revision(expectedRevision) }))
}
export const enableDecisionProvider = async (f: typeof fetch, c: string, id: string, expectedRevision: number, enabled: boolean) =>
  (
    await requestJson(
      f,
      c,
      `${root}/admin/decision-providers/${key(id)}/enabled`,
      z.object({ provider: Provider }),
      body('POST', { expectedRevision: revision(expectedRevision), enabled })
    )
  ).provider
export const defaultDecisionProvider = async (f: typeof fetch, c: string, id: string, expectedRevision: number) =>
  (
    await requestJson(
      f,
      c,
      `${root}/admin/decision-providers/${key(id)}/default`,
      z.object({ provider: Provider }),
      body('POST', { expectedRevision: revision(expectedRevision) })
    )
  ).provider
const Check: z.ZodType<DecisionProviderCheck> = z.object({
  availableModels: z.array(z.string()),
  configuredModelAvailable: z.boolean(),
  model: z.string(),
  latencyMs: z.number(),
  usage: DecisionUsageSchema,
  estimatedCostMicros: z.number().nullable(),
  estimatedCost: z
    .object({ currency: z.literal('USD'), amount: z.number(), pricingRevision: z.string(), source: z.string(), verifiedAt: z.string() })
    .nullable()
})
export const checkDecisionProvider = async (f: typeof fetch, c: string, id: string, expectedRevision: number) =>
  (
    await requestJson(
      f,
      c,
      `${root}/admin/decision-providers/${key(id)}/check`,
      z.object({ check: Check }),
      body('POST', { expectedRevision: revision(expectedRevision) })
    )
  ).check
const listServers = async (f: typeof fetch, c: string, path: string, signal?: AbortSignal) =>
  (await requestJson(f, c, root + path, z.object({ servers: z.array(Server) }), { signal })).servers
export const listAdminExternalMcp = (f: typeof fetch, c: string, signal?: AbortSignal) => listServers(f, c, '/admin/external-mcp', signal)
export const listPersonalExternalMcp = (f: typeof fetch, c: string, signal?: AbortSignal) => listServers(f, c, '/personal-mcp', signal)
export const listAvailableExternalMcp = (f: typeof fetch, c: string, signal?: AbortSignal) => listServers(f, c, '/external-mcp', signal)
export const createAdminExternalMcp = async (f: typeof fetch, c: string, input: CreateAdminExternalMcpServerInput) =>
  (await requestJson(f, c, `${root}/admin/external-mcp`, z.object({ server: Server }), body('POST', CreateAdminExternalMcpServerSchema.parse(input)))).server
export const createPersonalExternalMcp = async (f: typeof fetch, c: string, input: ExternalMcpServerInput) =>
  (await requestJson(f, c, `${root}/personal-mcp`, z.object({ server: Server }), body('POST', ExternalMcpServerInputSchema.parse(input)))).server
const updateServer = async (f: typeof fetch, c: string, path: string, id: string, input: ExternalMcpServerInput & { expectedRevision: number }) => {
  const { expectedRevision, ...write } = input
  return (
    await requestJson(
      f,
      c,
      `${root}${path}/${key(id)}`,
      z.object({ server: Server }),
      body('PUT', { ...ExternalMcpServerInputSchema.parse(write), expectedRevision: revision(expectedRevision) })
    )
  ).server
}
export const updateAdminExternalMcp = (f: typeof fetch, c: string, id: string, input: ExternalMcpServerInput & { expectedRevision: number }) =>
  updateServer(f, c, '/admin/external-mcp', id, input)
export const updatePersonalExternalMcp = (f: typeof fetch, c: string, id: string, input: ExternalMcpServerInput & { expectedRevision: number }) =>
  updateServer(f, c, '/personal-mcp', id, input)
const removeServer = async (f: typeof fetch, c: string, path: string, id: string, expectedRevision: number): Promise<void> => {
  await requestJson(f, c, `${root}${path}/${key(id)}`, deleted, body('DELETE', { expectedRevision: revision(expectedRevision) }))
}
export const deleteAdminExternalMcp = (f: typeof fetch, c: string, id: string, expectedRevision: number) =>
  removeServer(f, c, '/admin/external-mcp', id, expectedRevision)
export const deletePersonalExternalMcp = (f: typeof fetch, c: string, id: string, expectedRevision: number) =>
  removeServer(f, c, '/personal-mcp', id, expectedRevision)
export const setExternalMcpGrants = async (f: typeof fetch, c: string, id: string, expectedRevision: number, groupIds: number[]) =>
  (
    await requestJson(
      f,
      c,
      `${root}/admin/external-mcp/${key(id)}/grants`,
      z.object({ server: Server }),
      body('PUT', { expectedRevision: revision(expectedRevision), groupIds: z.array(z.number().int().positive()).parse(groupIds) })
    )
  ).server
export const listExternalMcpGroupPolicies = async (f: typeof fetch, c: string, signal?: AbortSignal) =>
  (await requestJson(f, c, `${root}/admin/external-mcp/group-policies`, z.object({ policies: z.array(Policy) }), { signal })).policies
export const setExternalMcpGroupPolicy = async (f: typeof fetch, c: string, groupId: number, expectedRevision: number, allowPersonalEndpoints: boolean) =>
  (
    await requestJson(
      f,
      c,
      `${root}/admin/external-mcp/group-policies/${z.number().int().positive().parse(groupId)}`,
      z.object({ policy: Policy }),
      body('PUT', { expectedRevision: revision(expectedRevision), allowPersonalEndpoints })
    )
  ).policy
const Discovery = z.object({
  attribution: z.object({
    serverId: z.string(),
    namespace: z.string(),
    displayName: z.string(),
    destinationHost: z.string(),
    trust: z.literal('untrusted'),
    authority: z.literal('external')
  }),
  catalog: z
    .object({
      namespace: z.string(),
      revision: z.number(),
      tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()),
      prompts: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()),
      resources: z.array(z.object({ uri: z.string(), name: z.string(), description: z.string().optional() }).passthrough()),
      resourceTemplates: z.array(z.object({ uriTemplate: z.string(), name: z.string() }).passthrough())
    })
    .passthrough()
})
export type ExternalMcpDiscovery = z.infer<typeof Discovery>
export const discoverExternalMcp = async (f: typeof fetch, c: string, id: string, signal?: AbortSignal): Promise<ExternalMcpDiscovery> =>
  (await requestJson(f, c, `${root}/external-mcp/${key(id)}/discover`, z.object({ discovery: Discovery }), { method: 'POST', signal })).discovery
export type { RoutingPolicyInput, RoutingModelPolicyInput, RoutingPolicyView, RoutingModelPolicyView, RoutingAdminView } from '../../shared/agents/routing.ts'
export const getAgentRouting = (f: typeof fetch, c: string, signal?: AbortSignal) =>
  requestJson(f, c, `${root}/admin/routing`, RoutingAdminViewSchema, { signal })
export const updateAgentRouting = async (f: typeof fetch, c: string, input: RoutingPolicyInput & { expectedRevision: number }) => {
  const { expectedRevision, ...write } = input
  return (
    await requestJson(
      f,
      c,
      `${root}/admin/routing`,
      z.object({ policy: RoutingPolicyViewSchema }),
      body('PUT', { ...RoutingPolicyInputSchema.parse(write), expectedRevision: revision(expectedRevision) })
    )
  ).policy
}
export const setAgentRoutingModel = async (f: typeof fetch, c: string, profileId: string, input: RoutingModelPolicyInput & { expectedRevision: number }) => {
  const { expectedRevision, ...write } = input
  return (
    await requestJson(
      f,
      c,
      `${root}/admin/routing/models/${key(profileId)}`,
      z.object({ model: RoutingModelPolicyViewSchema }),
      body('PUT', { ...RoutingModelPolicyInputSchema.parse(write), expectedRevision: revision(expectedRevision) })
    )
  ).model
}
export const deleteAgentRoutingModel = async (f: typeof fetch, c: string, profileId: string, expectedRevision: number): Promise<void> => {
  await requestJson(f, c, `${root}/admin/routing/models/${key(profileId)}`, deleted, body('DELETE', { expectedRevision: revision(expectedRevision) }))
}

import type { Knex } from 'knex'
import { AGENT_ACTION_BY_TOOL_NAME, type AgentActionName, type AgentToolName } from '../../../shared/agents/contracts.ts'
import pageOperations from '../../operations/pages.ts'
import { ACTION_CATALOG } from '../actions/catalog.ts'
import { ActionKernel, type ActionAdmissionSnapshot, type ActionAuthority } from '../actions/kernel.ts'
import { registerPageReadActions } from '../actions/page-reads.ts'
import { registerMemoryAction } from '../actions/memory.ts'
import { registerPageProposalActions } from '../actions/page-proposals.ts'
import { registerSkillReadActions } from '../actions/skill-reads.ts'
import type { AgentEngineRequest } from '../runtime.ts'
import { AgentRepositoryError } from '../repository.ts'
import { agentFeatureFlags, KernelActionSessionProvider } from './action-sessions.ts'
import { AgentProviderCapabilitiesSchema } from './registry.ts'
import { BrowserActionService } from '../browser/actions.ts'
import { SkillRuntime } from '../skills/runtime.ts'
import { AgentMemoryRepository } from '../memory.ts'
import type { BrowserWorkerClient } from '../browser/client.ts'
import { PageKnowledgeRepository } from '../../knowledge/lifecycle.ts'

interface GroupLike { id?: number; permissions?: unknown }
interface UserLike extends Express.User {
  isActive?: boolean
  groups?: GroupLike[]
  getGlobalPermissions?: () => Promise<unknown> | unknown
}
interface UserQuery {
  findById(id: number): {
    withGraphFetched(relation: string): {
      modifyGraph(relation: string, callback: (builder: { select(...columns: string[]): unknown }) => void): Promise<UserLike | undefined>
    }
  }
}
interface WikiUserRuntime { models: { users: { query(): UserQuery } } }

export interface WikiActionSessionConfig {
  readonly enabled: boolean
  readonly providerEnabled: boolean
  readonly skillsEnabled: boolean
  readonly browserEnabled: boolean
  readonly proposalsEnabled: boolean
  readonly writesEnabled: boolean
  readonly writeCreateEnabled: boolean
  readonly writePatchEnabled: boolean
  readonly writeMoveEnabled: boolean
  readonly writeRestoreEnabled: boolean
  readonly writeDeleteEnabled: boolean
  readonly snapshotSigningSecret: Uint8Array
}

const loadUser = async (ownerId: number): Promise<UserLike> => {
  const wiki = WIKI as unknown as WikiUserRuntime
  const user = await wiki.models.users.query().findById(ownerId).withGraphFetched('groups').modifyGraph('groups', builder => { builder.select('groups.id', 'permissions') })
  if (!user || user.isActive === false) throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Agent user is unavailable', 401)
  return user
}
export const loadWikiAgentUser = (userId: number): Promise<Express.User> => loadUser(userId)

const permissionsFor = async (user: UserLike): Promise<readonly string[]> => {
  const direct = await user.getGlobalPermissions?.()
  const permissions = Array.isArray(direct)
    ? direct
    : (user.groups ?? []).flatMap(group => Array.isArray(group.permissions) ? group.permissions : [])
  return [...new Set(permissions.filter((permission): permission is string => typeof permission === 'string'))].sort()
}

const groupIdsFor = (user: UserLike): readonly number[] => [...new Set((user.groups ?? []).map(group => group.id).filter((id): id is number => Number.isSafeInteger(id) && id! > 0))].sort((left, right) => left - right)

const allowedActionsFor = async (knex: Knex, runId: string): Promise<readonly AgentActionName[] | undefined> => {
  const rows = await knex('agentRunSkills').join('agentSkillVersions', 'agentSkillVersions.id', 'agentRunSkills.skillVersionId').where('agentRunSkills.runId', runId).select('agentSkillVersions.frontmatter') as { frontmatter: string }[]
  if (rows.length === 0) return undefined
  const allowed = new Set<AgentActionName>(['skills.list', 'skills.read', 'memory.manage'])
  for (const row of rows) {
    let value: unknown
    try { value = JSON.parse(row.frontmatter) } catch { throw new AgentRepositoryError('SKILL_VERSION_CORRUPT', 'Loaded skill metadata is invalid', 500) }
    const tools = typeof value === 'object' && value !== null ? Reflect.get(value, 'allowed-tools') : undefined
    if (!Array.isArray(tools) || tools.length === 0) return undefined
    for (const tool of tools) {
      if (typeof tool !== 'string') continue
      const actionName = AGENT_ACTION_BY_TOOL_NAME[tool as AgentToolName]
      if (actionName) allowed.add(actionName)
      else if (tool in ACTION_CATALOG) allowed.add(tool as AgentActionName)
    }
  }
  return [...allowed].sort()
}

export const createWikiActionSessionProvider = (knex: Knex, config: WikiActionSessionConfig, browserClient?: BrowserWorkerClient): KernelActionSessionProvider => {
  const kernel = new ActionKernel()
  const requester = async (authority: ActionAuthority): Promise<Express.User> => {
    if (authority.requester.kind !== 'user') throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Agent page actions require a user principal', 401)
    return loadUser(authority.requester.userId)
  }
  registerPageReadActions(kernel, { operations: pageOperations, resolveRequester: requester, snapshotSigningSecret: config.snapshotSigningSecret, knowledge: new PageKnowledgeRepository(knex) })
  registerPageProposalActions(kernel, { knex, operations: pageOperations, resolveRequester: requester, resolveApprover: loadWikiAgentUser, snapshotSigningSecret: config.snapshotSigningSecret })
  registerSkillReadActions(kernel, new SkillRuntime(knex))
  registerMemoryAction(kernel, new AgentMemoryRepository(knex))
  if (config.browserEnabled && browserClient) new BrowserActionService(knex, browserClient).register(kernel)
  const resolveAdmission = async (request: AgentEngineRequest): Promise<ActionAdmissionSnapshot> => {
    const user = await loadUser(request.run.ownerId)
    const version = await knex('agentProviderProfileVersions').where({ id: request.run.providerProfileVersionId, conformed: true }).first('capabilities') as { capabilities: string } | undefined
    if (!version) throw new AgentRepositoryError('PROFILE_VERSION_UNAVAILABLE', 'Provider profile version is unavailable', 409)
    let supportsTools: boolean
    try {
      const capabilities = AgentProviderCapabilitiesSchema.parse(JSON.parse(version.capabilities) as unknown)
      supportsTools = capabilities.toolCalling === 'native' || capabilities.toolCalling === 'prompt'
    } catch { throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Stored provider capabilities are invalid', 500) }
    const allowedActions = await allowedActionsFor(knex, request.run.id)
    return {
      transport: 'agent',
      executionMode: request.run.executionMode === 'agent' ? 'agent' : 'generation-only',
      supportsTools,
      permissions: await permissionsFor(user),
      groupIds: groupIdsFor(user),
      featureFlags: agentFeatureFlags({
        'agents.enabled': config.enabled,
        'agents.provider.enabled': config.providerEnabled,
        'agents.skills.enabled': config.skillsEnabled,
        'agents.browser.enabled': config.browserEnabled,
        'agents.proposals.enabled': config.proposalsEnabled,
        'agents.writes.enabled': config.writesEnabled,
        'agents.writes.create.enabled': config.writeCreateEnabled,
        'agents.writes.patch.enabled': config.writePatchEnabled,
        'agents.writes.move.enabled': config.writeMoveEnabled,
        'agents.writes.restore.enabled': config.writeRestoreEnabled,
        'agents.writes.delete.enabled': config.writeDeleteEnabled,
        'agents.mcp.enabled': false
      }),
      ...(allowedActions === undefined ? {} : { allowedActions })
    }
  }
  return new KernelActionSessionProvider({ knex, kernel, resolveAdmission, refreshAdmission: resolveAdmission, timeoutMilliseconds: 16 * 60_000 })
}
